'use strict';

// End-to-end: start the server, convert every fixture into every SCORM
// version, download the zip and check the package structure. Manifests are
// validated against the bundled ADL schemas with xmllint when it's available.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const yauzl = require('yauzl');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scormconv-test-'));
let server;
let hasXmllint = false;
try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); hasXmllint = true; } catch { /* skip schema check */ }

before(async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/capabilities`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  if (server) server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const SAMPLE_QUIZ = {
  passMark: 75,
  maxAttempts: 2,
  questions: [
    { type: 'single', text: 'Pick B', options: ['A', 'B', 'C'], correct: [1], feedback: 'B is right' },
    { type: 'multiple', text: 'Pick A and C', options: ['A', 'B', 'C', 'D'], correct: [0, 2] },
    { type: 'truefalse', text: 'Sky is blue', options: ['True', 'False'], correct: [0] },
  ],
};

// Posts a course. `files` is a list of fixture names (one file item each),
// `extra` adds quiz items and course options.
async function submitCourse(files, { quizzes = [], ...opts } = {}) {
  const fd = new FormData();
  const items = files.map((f, i) => ({ id: `f${i}`, type: 'file', title: `File ${i}: ${f}`, threshold: 90 }));
  quizzes.forEach((q, i) => items.push({ id: `q${i}`, type: 'quiz', title: `Quiz ${i}`, quiz: q }));
  fd.append('course', JSON.stringify({ title: 'Course', version: '1.2', ...opts, items }));
  files.forEach((f, i) => fd.append(`file_f${i}`, new Blob([fs.readFileSync(path.join(FIX, f))]), f));
  return fetch(`${BASE}/api/courses`, { method: 'POST', body: fd });
}

async function convert(files, opts) {
  const res = await submitCourse(Array.isArray(files) ? files : [files], opts);
  const body = await res.json();
  assert.equal(res.status, 202, body.error);
  for (let i = 0; i < 600; i++) {
    const job = await (await fetch(`${BASE}/api/jobs/${body.id}`)).json();
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout');
}

function unzip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = {};
      zip.on('entry', (e) => {
        if (/\/$/.test(e.fileName)) return zip.readEntry();
        zip.openReadStream(e, (err2, s) => {
          if (err2) return reject(err2);
          const chunks = [];
          s.on('data', (c) => chunks.push(c));
          s.on('end', () => { entries[e.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

// Reads the archive front to back using only local file headers, the way
// Java's ZipInputStream does (SAP SuccessFactors/Plateau and other Java LMSs).
// It rejects the layouts those readers reject, including STORED entries with
// data descriptors, and checks each entry's CRC and sizes.
function streamingRead(buf) {
  const zlib = require('zlib');
  let p = 0;
  const names = [];
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const flags = buf.readUInt16LE(p + 6);
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const csize = buf.readUInt32LE(p + 18);
    const usize = buf.readUInt32LE(p + 22);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nlen);
    assert.equal(flags & 0x08, 0, `${name}: uses a data descriptor (Java: "only DEFLATED entries can have EXT descriptor")`);
    assert.ok(method === 0 || method === 8, `${name}: unsupported method ${method}`);
    const start = p + 30 + nlen + xlen;
    const data = buf.subarray(start, start + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(raw.length, usize, `${name}: size mismatch`);
    assert.equal(zlib.crc32 ? zlib.crc32(raw) : crc, crc, `${name}: CRC mismatch`);
    names.push(name);
    p = start + csize;
  }
  assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory follows the last entry');
  return names;
}

const WRAPPERS = {
  '1.2': [['http://www.imsproject.org/xsd/imscp_rootv1p1p2', 'imscp_rootv1p1p2.xsd'], ['http://www.adlnet.org/xsd/adlcp_rootv1p2', 'adlcp_rootv1p2.xsd']],
  '2004': [['http://www.imsglobal.org/xsd/imscp_v1p1', 'imscp_v1p1.xsd'], ['http://www.adlnet.org/xsd/adlcp_v1p3', 'adlcp_v1p3.xsd'], ['http://www.adlnet.org/xsd/adlseq_v1p3', 'adlseq_v1p3.xsd'], ['http://www.adlnet.org/xsd/adlnav_v1p3', 'adlnav_v1p3.xsd'], ['http://www.imsglobal.org/xsd/imsss', 'imsss_v1p0.xsd']],
};

function validateSchema(entries, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scormval-'));
  try {
    for (const [name, buf] of Object.entries(entries)) {
      if (/\.(xsd|dtd|xml)$/.test(name)) fs.writeFileSync(path.join(dir, name), buf);
    }
    const imports = WRAPPERS[version === '1.2' ? '1.2' : '2004']
      .map(([ns, loc]) => `<xs:import namespace="${ns}" schemaLocation="${loc}"/>`).join('\n');
    fs.writeFileSync(path.join(dir, '_all.xsd'), `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">${imports}</xs:schema>`);
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', '_all.xsd', 'imsmanifest.xml'], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`Schema validation failed:\n${e.stderr || e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FILE_CASES = [
  ['sample.pdf', 'pdf'],
  ['sample.docx', 'pdf'],
  ['sample.pptx', 'pdf'],
  ['h264.mp4', 'video'],
  ['mpeg4.mp4', 'video'],
];

function readConfig(entries) {
  const text = entries['player/config.js'].toString('utf8');
  return JSON.parse(text.replace(/^window\.SCORM_CONFIG = /, '').replace(/;\s*$/, ''));
}

// Downloads a finished job and runs every structural check on it.
async function checkPackage(job, version) {
  const res = await fetch(`${BASE}${job.downloadUrl}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.zip/);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const entries = await unzip(zipBuf);
  const names = Object.keys(entries);
  assert.deepEqual(streamingRead(zipBuf).sort(), names.slice().sort(), 'streaming and central-directory readers agree');
  assert.equal(streamingRead(zipBuf)[0], 'imsmanifest.xml', 'manifest is the first entry');
  assert.ok(entries['index.html'], 'index.html at root');
  assert.ok(!names.some((n) => n.includes('\\')), 'zip paths use forward slashes');

  const xml = entries['imsmanifest.xml'].toString('utf8');
  if (version === '1.2') {
    assert.match(xml, /<schemaversion>1\.2<\/schemaversion>/);
    assert.match(xml, /adlcp:scormtype="sco"/);
    for (const x of ['imscp_rootv1p1p2.xsd', 'adlcp_rootv1p2.xsd', 'imsmd_rootv1p2p1.xsd', 'ims_xml.xsd']) assert.ok(entries[x], x);
  } else {
    assert.match(xml, new RegExp(`<schemaversion>2004 ${version.endsWith('3') ? '3rd' : '4th'} Edition</schemaversion>`));
    assert.match(xml, /adlcp:scormType="sco"/);
    for (const x of ['imscp_v1p1.xsd', 'adlcp_v1p3.xsd', 'adlseq_v1p3.xsd', 'adlnav_v1p3.xsd', 'imsss_v1p0.xsd']) assert.ok(entries[x], x);
  }

  const refs = [...xml.matchAll(/<file href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  for (const r of refs) assert.ok(entries[r], `manifest references missing file ${r}`);
  for (const n of names) if (!/\.(xsd|dtd)$/.test(n) && n !== 'imsmanifest.xml') assert.ok(refs.includes(n), `${n} not listed in manifest`);

  // Every player script is referenced by index.html and present.
  const html = entries['index.html'].toString();
  for (const m of html.matchAll(/src="([^"]+)"/g)) assert.ok(entries[m[1]], `index.html references missing ${m[1]}`);
  for (const f of names.filter((n) => /^player\/[^/]+\.js$/.test(n) || n === 'index.html')) {
    assert.doesNotMatch(entries[f].toString(), /https?:\/\//, `${f} must not load external resources`);
  }

  const cfg = readConfig(entries);
  assert.equal(cfg.version, version === '1.2' ? '1.2' : '2004');
  for (const it of cfg.items) {
    if (it.kind === 'pdf') {
      assert.equal(entries[it.src].subarray(0, 5).toString(), '%PDF-');
      assert.ok(entries['player/pdfjs/pdf.min.js'] && entries['player/pdfjs/pdf.worker.min.js']);
    } else if (it.kind === 'video') {
      const s = entries[it.src].toString('latin1');
      assert.equal(s.slice(4, 8), 'ftyp');
      assert.ok(s.indexOf('moov') < s.indexOf('mdat'), 'moov before mdat (faststart)');
    }
  }
  if (hasXmllint) validateSchema(entries, version);
  return { entries, cfg, xml };
}

for (const version of ['1.2', '2004-3', '2004-4']) {
  for (const [file, kind] of FILE_CASES) {
    test(`${file} -> SCORM ${version}`, { timeout: 180000 }, async () => {
      const job = await convert(file, { version, title: `Test & "quotes" <${file}>`, reportScore: true });
      const { cfg, xml } = await checkPackage(job, version);
      assert.match(xml, /&amp; &quot;quotes&quot; &lt;/, 'title is XML-escaped');
      assert.equal(cfg.items.length, 1);
      assert.equal(cfg.items[0].kind, kind);
      assert.equal(cfg.items[0].threshold, 90);
      assert.equal(cfg.reportScore, true);
    });
  }

  test(`multi-asset course with quiz -> SCORM ${version}`, { timeout: 240000 }, async () => {
    const job = await convert(['h264.mp4', 'sample.pdf', 'sample.pptx', 'mpeg4.mp4'], {
      version, navigation: 'sequential', quizzes: [SAMPLE_QUIZ],
    });
    const { entries, cfg } = await checkPackage(job, version);
    assert.deepEqual(cfg.items.map((i) => i.kind), ['video', 'pdf', 'pdf', 'video', 'quiz']);
    assert.equal(cfg.navigation, 'sequential');
    assert.equal(new Set(cfg.items.filter((i) => i.src).map((i) => i.src)).size, 4, 'each asset has its own file');
    const quiz = cfg.items[4].quiz;
    assert.equal(quiz.passMark, 75);
    assert.equal(quiz.maxAttempts, 2);
    assert.equal(quiz.questions.length, 3);
    for (const q of quiz.questions) {
      assert.equal(q.correct, undefined, 'correct answers are not shipped in plain text');
      assert.ok(q.k);
    }
    // Keys decode back to the right answers (mirror of quiz.js decodeKey).
    const decode = (k, salt) => [...Buffer.from(k, 'base64')].map((b, i) => String.fromCharCode(b ^ salt.charCodeAt(i % salt.length) ^ ((i * 31) & 255))).join('');
    assert.deepEqual(quiz.questions.map((q, i) => decode(q.k, `q0:${i}`)), ['1', '0,2', '0']);
    for (const f of ['player/quiz.js', 'player/viewers.js', 'player/player.js']) assert.ok(entries[f], f);
  });
}

test('quiz-only course', async () => {
  const job = await convert([], { quizzes: [SAMPLE_QUIZ] });
  const { entries, cfg } = await checkPackage(job, '1.2');
  assert.equal(cfg.items.length, 1);
  assert.ok(!entries['player/pdfjs/pdf.min.js'], 'pdf.js only bundled when needed');
  assert.doesNotMatch(entries['index.html'].toString(), /pdfjs/);
});

test('rejects invalid input', async () => {
  const post = async (course, files = []) => {
    const fd = new FormData();
    fd.append('course', JSON.stringify(course));
    for (const [field, name, body] of files) fd.append(field, new Blob([body]), name);
    const r = await fetch(`${BASE}/api/courses`, { method: 'POST', body: fd });
    return { status: r.status, error: (await r.json()).error };
  };
  const file = (id) => ({ id, type: 'file', title: 'x' });
  assert.equal((await post({ items: [file('a')] }, [['file_a', 'notes.txt', 'hi']])).status, 400);
  assert.equal((await post({ items: [file('a')] }, [['file_a', 'fake.pdf', 'not a pdf']])).status, 400);
  assert.equal((await post({ items: [file('a')] })).status, 400, 'missing file');
  assert.equal((await post({ items: [] })).status, 400, 'empty course');
  const badQuiz = (q) => post({ items: [{ id: 'q', type: 'quiz', title: 'Q', quiz: { questions: [q] } }] });
  let r = await badQuiz({ type: 'single', text: 'x', options: ['a', 'b'], correct: [] });
  assert.equal(r.status, 400); assert.match(r.error, /correct answer/);
  r = await badQuiz({ type: 'single', text: 'x', options: ['a', 'b'], correct: [0, 1] });
  assert.equal(r.status, 400); assert.match(r.error, /exactly one/);
  r = await badQuiz({ type: 'single', text: '', options: ['a', 'b'], correct: [0] });
  assert.equal(r.status, 400); assert.match(r.error, /empty/);
  r = await badQuiz({ type: 'multiple', text: 'x', options: ['a'], correct: [0] });
  assert.equal(r.status, 400); assert.match(r.error, /two answer options/);
  const res = await fetch(`${BASE}/api/courses`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
});

test('video re-encode warning for non-H.264 input', { timeout: 120000 }, async () => {
  const job = await convert('mpeg4.mp4');
  assert.ok(job.warnings.some((w) => /re-encoded/.test(w)));
  const job2 = await convert('h264.mp4');
  assert.ok(!job2.warnings.some((w) => /re-encoded/.test(w)));
});

test('quizzes attached to individual videos', { timeout: 120000 }, async () => {
  // v0 + its quiz, v1 with no quiz, v2 + its quiz, then a final standalone quiz.
  const quiz = (id, attachedTo) => ({ id, type: 'quiz', title: `Quiz ${id}`, attachedTo, quiz: SAMPLE_QUIZ });
  const items = [
    { id: 'v0', type: 'file', title: 'Video 0' }, quiz('q0', 'v0'),
    { id: 'v1', type: 'file', title: 'Video 1' },
    { id: 'v2', type: 'file', title: 'Video 2' }, quiz('q2', 'v2'),
    quiz('final', 'v0'), // not directly after v0: link must be dropped
  ];
  const fd = new FormData();
  fd.append('course', JSON.stringify({ title: 'Per-video quizzes', version: '2004-4', navigation: 'sequential', items }));
  for (const id of ['v0', 'v1', 'v2']) fd.append(`file_${id}`, new Blob([fs.readFileSync(path.join(FIX, 'h264.mp4'))]), 'v.mp4');
  const res = await fetch(`${BASE}/api/courses`, { method: 'POST', body: fd });
  const body = await res.json();
  assert.equal(res.status, 202, body.error);
  let job;
  for (let i = 0; i < 400; i++) {
    job = await (await fetch(`${BASE}/api/jobs/${body.id}`)).json();
    if (job.status === 'done' || job.status === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(job.status, 'done', job.error);
  const { cfg } = await checkPackage(job, '2004-4');
  assert.deepEqual(cfg.items.map((i) => [i.id, i.kind, i.parent || null]), [
    ['v0', 'video', null], ['q0', 'quiz', 'v0'],
    ['v1', 'video', null],
    ['v2', 'video', null], ['q2', 'quiz', 'v2'],
    ['final', 'quiz', null],
  ]);
});
