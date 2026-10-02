'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { tools, detectType, officeToPdf, prepareVideo, DATA_DIR } = require('./src/converters');
const { stagePackage, zipDir } = require('./src/packager');
const { VERSIONS } = require('./src/manifest');
const { normalizeCourse, CourseError, LIMITS } = require('./src/course');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const JOB_TTL_MS = Number(process.env.JOB_TTL_HOURS || 6) * 3600 * 1000;
const MAX_CONCURRENT = 2;

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.mp4', '.m4v', '.pdf', '.pptx', '.docx']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobs = new Map();
const queue = [];
let running = 0;

function publicJob(job) {
  const c = job.course;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: Math.round(job.progress * 100),
    error: job.error || null,
    warnings: job.warnings,
    title: c.title,
    version: c.version,
    versionLabel: VERSIONS[c.version].label,
    items: c.items.map((it) => ({ id: it.id, type: it.type, title: it.title })),
    size: job.zipBytes || null,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/download` : null,
    previewUrl: job.status === 'done' ? `/preview/${job.id}` : null,
  };
}

function setStage(job, stage, progress) {
  job.stage = stage;
  if (progress != null) job.progress = progress;
}

function slug(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'scorm-package';
}

async function removeUploads(job) {
  for (const u of Object.values(job.uploads)) await fsp.rm(u.path, { force: true }).catch(() => {});
}

async function processJob(job) {
  const dir = path.join(JOBS_DIR, job.id);
  const work = path.join(dir, 'work');
  const stageDir = path.join(dir, 'package');
  await fsp.mkdir(work, { recursive: true });
  job.status = 'processing';

  // Spread 0..0.7 of the progress bar over file items, weighted by size.
  const fileItems = job.course.items.filter((it) => it.type === 'file');
  const totalBytes = fileItems.reduce((n, it) => n + job.uploads[it.id].size, 0) || 1;
  let doneBytes = 0;
  const assets = {};

  for (let i = 0; i < fileItems.length; i++) {
    const it = fileItems[i];
    const up = job.uploads[it.id];
    const base = 0.7 * (doneBytes / totalBytes);
    const span = 0.7 * (up.size / totalBytes);
    const label = (s) => (fileItems.length > 1 ? `${s} (${i + 1} of ${fileItems.length}: ${it.title})` : s);
    const itemDir = path.join(work, it.id);
    await fsp.mkdir(itemDir, { recursive: true });

    if (up.kind === 'docx' || up.kind === 'pptx') {
      setStage(job, label('Converting document to PDF'), base);
      // LibreOffice names its output after the input, so give it a clean name.
      const input = path.join(itemDir, `source.${up.kind}`);
      await fsp.rename(up.path, input);
      up.path = input;
      assets[it.id] = { kind: 'pdf', file: await officeToPdf(input, itemDir) };
    } else if (up.kind === 'pdf') {
      setStage(job, label('Preparing document'), base);
      assets[it.id] = { kind: 'pdf', file: up.path };
    } else {
      const out = path.join(itemDir, 'video.mp4');
      const poster = path.join(itemDir, 'poster.jpg');
      setStage(job, label('Analysing video'), base);
      const info = await prepareVideo(up.path, out, poster, {
        onProgress: (p, l) => setStage(job, label(l), base + p * span),
      });
      if (info.warning) job.warnings.push(`${it.title}: ${info.warning}`);
      if (info.transcoded) job.warnings.push(`${it.title}: re-encoded to H.264/AAC so it plays in every browser.`);
      assets[it.id] = { kind: 'video', file: out, poster: info.poster ? poster : null };
    }
    doneBytes += up.size;
  }

  setStage(job, 'Building SCORM package', 0.72);
  await stagePackage(stageDir, job.course, assets, { id: `SCORMCONV_${job.id.replace(/-/g, '')}` });

  setStage(job, 'Compressing package', 0.75);
  const zipPath = path.join(dir, 'package.zip');
  const { bytes } = await zipDir(stageDir, zipPath, (p) => setStage(job, 'Compressing package', 0.75 + p * 0.24));

  // Free the sources; the staged folder is kept for the preview.
  await fsp.rm(work, { recursive: true, force: true });
  await removeUploads(job);

  job.zipPath = zipPath;
  job.zipBytes = bytes;
  job.fileName = `${slug(job.course.title)}_${job.course.version === '1.2' ? 'SCORM12' : 'SCORM2004'}.zip`;
  job.status = 'done';
  setStage(job, 'Ready', 1);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    processJob(job)
      .catch((err) => {
        console.error(`[job ${job.id}]`, err.stderr || err);
        job.status = 'error';
        job.error = err.message || 'Conversion failed';
        removeUploads(job);
      })
      .finally(() => { running--; job.finishedAt = Date.now(); pump(); });
  }
}

async function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
      await fsp.rm(path.join(JOBS_DIR, id), { recursive: true, force: true }).catch(() => {});
    }
  }
  // Orphans from a previous run (jobs live in memory only).
  for (const name of await fsp.readdir(JOBS_DIR).catch(() => [])) {
    if (!jobs.has(name)) await fsp.rm(path.join(JOBS_DIR, name), { recursive: true, force: true }).catch(() => {});
  }
  for (const name of await fsp.readdir(UPLOAD_DIR).catch(() => [])) {
    const p = path.join(UPLOAD_DIR, name);
    const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > JOB_TTL_MS) await fsp.rm(p, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: LIMITS.items, fields: 10, fieldSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new HttpError(400, `"${file.originalname}" is not supported. Use MP4, PDF, PPTX or DOCX files.`));
    cb(null, true);
  },
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/capabilities', (_req, res) => {
  res.json({
    maxBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxItems: LIMITS.items,
    office: !!tools.soffice,
    ffmpeg: !!tools.ffmpeg,
    versions: Object.entries(VERSIONS).map(([id, v]) => ({ id, label: v.label })),
  });
});

// multipart/form-data:
//   course: JSON (see src/course.js)
//   file_<itemId>: one file per file item
app.post('/api/courses', (req, res) => {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_TOTAL_BYTES + 16 * 1024 * 1024) {
    return res.status(413).json({ error: 'The files add up to more than 2 GB. Split the course or compress the videos.' });
  }

  upload.any()(req, res, async (err) => {
    const files = req.files || [];
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') throw new HttpError(413, 'Each file must be 500 MB or smaller.');
        if (err.code === 'LIMIT_FILE_COUNT') throw new HttpError(413, `A course can have at most ${LIMITS.items} files.`);
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err.message || 'Upload failed');
      }

      let raw;
      try { raw = JSON.parse((req.body && req.body.course) || ''); } catch { throw new HttpError(400, 'Missing or invalid course data.'); }
      const course = normalizeCourse(raw);

      const byField = new Map(files.map((f) => [f.fieldname, f]));
      const uploads = {};
      for (const it of course.items) {
        if (it.type !== 'file') continue;
        const f = byField.get(`file_${it.id}`);
        if (!f) throw new HttpError(400, `No file was uploaded for "${it.title}".`);
        const kind = await detectType(f.path, f.originalname);
        if (!kind) throw new HttpError(400, `"${f.originalname}" does not look like a valid MP4, PDF, PPTX or DOCX file.`);
        if ((kind === 'docx' || kind === 'pptx') && !tools.soffice) {
          throw new HttpError(422, 'DOCX/PPTX conversion needs LibreOffice, which is not installed on this server.');
        }
        uploads[it.id] = { path: f.path, originalName: f.originalname, size: f.size, kind };
      }
      // Drop any stray files that don't belong to an item.
      const used = new Set(Object.values(uploads).map((u) => u.path));
      for (const f of files) if (!used.has(f.path)) fsp.rm(f.path, { force: true }).catch(() => {});

      const job = {
        id: crypto.randomUUID(),
        course,
        uploads,
        status: 'queued',
        stage: 'Waiting in queue',
        progress: 0,
        warnings: [],
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      res.status(202).json(publicJob(job));
    } catch (e) {
      for (const f of files) fsp.rm(f.path, { force: true }).catch(() => {});
      const status = e instanceof CourseError ? 400 : e.status || 500;
      if (status === 500) console.error(e);
      res.status(status).json({ error: e.message || 'Server error' });
    }
  });
});

function getJob(req, res) {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job not found or expired.' }); return null; }
  return job;
}

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req, res);
  if (job) res.json(publicJob(job));
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  if (job.status !== 'done') return res.status(409).json({ error: 'Package is not ready yet.' });
  res.download(job.zipPath, job.fileName);
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  if (job.status === 'processing' || job.status === 'queued') return res.status(409).json({ error: 'Job is still running.' });
  jobs.delete(job.id);
  await fsp.rm(path.join(JOBS_DIR, job.id), { recursive: true, force: true }).catch(() => {});
  res.status(204).end();
});

// Preview: the unpacked package, served as an LMS would serve it, inside a
// harness page that provides a SCORM API and shows every call.
app.get('/preview/:id', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  if (job.status !== 'done') return res.status(409).send('Package is not ready yet.');
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.use('/pkg/:id', (req, res, next) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).end();
  express.static(path.join(JOBS_DIR, job.id, 'package'), { index: false })(req, res, next);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

cleanup().catch(() => {});
setInterval(() => cleanup().catch(() => {}), 30 * 60 * 1000).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`SCORM Converter running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  LibreOffice: ${tools.soffice || 'NOT FOUND (DOCX/PPTX disabled)'}`);
  console.log(`  ffmpeg:      ${tools.ffmpeg || 'NOT FOUND (videos copied as-is)'}`);
});
// Large uploads over slow links can take a long time.
server.requestTimeout = 2 * 60 * 60 * 1000;
server.headersTimeout = 65 * 1000;
