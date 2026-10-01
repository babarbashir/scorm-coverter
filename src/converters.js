'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['soffice'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  return null;
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* optional dependency */ }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  return null;
}

const tools = { soffice: findSoffice(), ffmpeg: findFfmpeg() };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, { timeoutMs = 0, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (onStderr) onStderr(s);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${path.basename(cmd)} exited with code ${code}`);
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// LibreOffice can only run one conversion per user profile at a time, so all
// Office conversions go through this single-slot queue.
let officeQueue = Promise.resolve();
function serializeOffice(fn) {
  const next = officeQueue.then(fn, fn);
  officeQueue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// File type detection (by magic bytes, not just extension)
// ---------------------------------------------------------------------------

async function readHead(file, n = 4096) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function detectType(file, originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  const head = await readHead(file);
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return 'mp4';
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // OOXML zip container. The first entries usually name the part folders,
    // but fall back to the extension when they don't appear in the header.
    const s = head.toString('latin1');
    if (s.includes('word/')) return 'docx';
    if (s.includes('ppt/')) return 'pptx';
    if (ext === 'docx' || ext === 'pptx') return ext;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Office -> PDF
// ---------------------------------------------------------------------------

async function officeToPdf(input, outDir, { onProgress } = {}) {
  if (!tools.soffice) {
    throw new Error('LibreOffice is not installed, so DOCX/PPTX files cannot be converted. Install it from libreoffice.org or set SOFFICE_PATH.');
  }
  const profile = path.join(DATA_DIR, 'lo-profile');
  await fsp.mkdir(profile, { recursive: true });
  const profileUrl = 'file://' + (process.platform === 'win32' ? '/' : '') + profile.replace(/\\/g, '/');

  return serializeOffice(async () => {
    if (onProgress) onProgress(0.1, 'Converting with LibreOffice');
    await run(tools.soffice, [
      `-env:UserInstallation=${profileUrl}`,
      '--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      input,
    ], { timeoutMs: 15 * 60 * 1000 });
    const pdf = path.join(outDir, path.basename(input, path.extname(input)) + '.pdf');
    if (!fs.existsSync(pdf)) throw new Error('LibreOffice did not produce a PDF. The file may be corrupt or password-protected.');
    return pdf;
  });
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function parseProbe(stderr) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0;
  const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)([^\n]*)/i.exec(stderr);
  const a = /Stream #[^\n]*Audio:\s*([a-z0-9_]+)/i.exec(stderr);
  return {
    duration,
    videoCodec: v ? v[1].toLowerCase() : null,
    videoDetails: v ? v[2] : '',
    audioCodec: a ? a[1].toLowerCase() : null,
  };
}

async function probe(input) {
  // `ffmpeg -i` with no output exits non-zero but still prints stream info.
  try {
    await run(tools.ffmpeg, ['-hide_banner', '-i', input]);
  } catch (err) {
    if (!err.stderr) throw err;
    return parseProbe(err.stderr);
  }
  return { duration: 0 };
}

// Produces a browser-safe MP4 (H.264 yuv420p + AAC, moov atom at the front so
// playback starts before the whole file downloads from the LMS).
async function prepareVideo(input, outFile, posterFile, { onProgress } = {}) {
  if (!tools.ffmpeg) {
    await fsp.copyFile(input, outFile);
    return { duration: 0, transcoded: false, poster: false, warning: 'ffmpeg not found: video copied as-is without optimisation.' };
  }
  const info = await probe(input);
  if (!info.videoCodec) throw new Error('No video stream found in this MP4 file.');

  const videoOk = info.videoCodec === 'h264' && /yuv420p|yuvj420p/.test(info.videoDetails);
  const audioOk = !info.audioCodec || info.audioCodec === 'aac' || info.audioCodec === 'mp3';

  const args = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1'];
  args.push(...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1']));
  args.push(...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']));
  args.push('-movflags', '+faststart', outFile);

  const label = videoOk && audioOk ? 'Optimising video for streaming' : 'Re-encoding video to H.264/AAC';
  await run(tools.ffmpeg, args, {
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && info.duration && onProgress) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.min(0.99, t / info.duration), label);
      }
    },
  });

  let poster = false;
  try {
    const at = info.duration > 4 ? Math.min(2, info.duration / 10) : 0;
    await run(tools.ffmpeg, ['-hide_banner', '-y', '-ss', String(at), '-i', outFile, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', '-q:v', '4', posterFile], { timeoutMs: 60000 });
    poster = fs.existsSync(posterFile);
  } catch { /* poster is optional */ }

  return { duration: info.duration, transcoded: !(videoOk && audioOk), poster };
}

module.exports = { tools, detectType, officeToPdf, prepareVideo, probe, DATA_DIR };
