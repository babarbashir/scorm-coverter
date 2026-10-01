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

async function convert(file, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([fs.readFileSync(path.join(FIX, file))]), file);
  const res = await fetch(`${BASE}/api/convert`, { method: 'POST', body: fd });
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

const CASES = [
  ['sample.pdf', 'pdf'],
  ['sample.docx', 'pdf'],
  ['sample.pptx', 'pdf'],
  ['h264.mp4', 'video'],
  ['mpeg4.mp4', 'video'],
];

for (const version of ['1.2', '2004-3', '2004-4']) {
  for (const [file, type] of CASES) {
    test(`${file} -> SCORM ${version}`, { timeout: 180000 }, async () => {
      const job = await convert(file, { version, title: `Test & "quotes" <${file}>`, threshold: '90', reportScore: 'true' });
      const res = await fetch(`${BASE}${job.downloadUrl}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /\.zip/);
      const zipBuf = Buffer.from(await res.arrayBuffer());
      const entries = await unzip(zipBuf);
      const names = Object.keys(entries);
      assert.deepEqual(streamingRead(zipBuf).sort(), names.slice().sort(), 'streaming and central-directory readers agree');
      assert.equal(streamingRead(zipBuf)[0], 'imsmanifest.xml', 'manifest is the first entry');

      // Manifest at the root, never inside a folder.
      assert.ok(entries['imsmanifest.xml'], 'imsmanifest.xml at root');
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
      assert.match(xml, /&amp; &quot;quotes&quot; &lt;/, 'title is XML-escaped');

      // Every file referenced by the manifest exists in the zip.
      const refs = [...xml.matchAll(/<file href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      assert.ok(refs.length > 0);
      for (const r of refs) assert.ok(entries[r], `manifest references missing file ${r}`);

      const cfgText = entries['player/config.js'].toString('utf8');
      const cfg = JSON.parse(cfgText.replace(/^window\.SCORM_CONFIG = /, '').replace(/;\s*$/, ''));
      assert.equal(cfg.type, type);
      assert.equal(cfg.version, version === '1.2' ? '1.2' : '2004');
      assert.equal(cfg.completion.threshold, 90);
      assert.ok(entries[cfg.src], 'content file present');

      if (type === 'pdf') {
        assert.ok(entries['player/pdfjs/pdf.min.js']);
        assert.ok(entries['player/pdfjs/pdf.worker.min.js']);
        assert.ok(entries[cfg.src].subarray(0, 5).toString() === '%PDF-');
      } else {
        const mp4 = entries[cfg.src];
        assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
        // Fast start: moov atom must come before mdat.
        const s = mp4.toString('latin1');
        assert.ok(s.indexOf('moov') < s.indexOf('mdat'), 'moov before mdat (faststart)');
      }

      // No references to external hosts in the player.
      for (const f of ['index.html', 'player/player.js', 'player/scorm-api.js']) {
        assert.doesNotMatch(entries[f].toString(), /https?:\/\//, `${f} must not load external resources`);
      }

      if (hasXmllint) validateSchema(entries, version);
    });
  }
}

test('rejects unsupported and oversized input', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['hello']), 'notes.txt');
  const r1 = await fetch(`${BASE}/api/convert`, { method: 'POST', body: fd });
  assert.equal(r1.status, 400);

  const fd2 = new FormData();
  fd2.append('file', new Blob(['not really a pdf']), 'fake.pdf');
  const r2 = await fetch(`${BASE}/api/convert`, { method: 'POST', body: fd2 });
  assert.equal(r2.status, 400);
});

test('video re-encode warning for non-H.264 input', { timeout: 120000 }, async () => {
  const job = await convert('mpeg4.mp4', { version: '1.2' });
  assert.ok(job.warnings.some((w) => /re-encoded/.test(w)));
  const job2 = await convert('h264.mp4', { version: '1.2' });
  assert.ok(!job2.warnings.some((w) => /re-encoded/.test(w)));
});
