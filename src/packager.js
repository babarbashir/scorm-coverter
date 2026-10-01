'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { VERSIONS, buildManifest } = require('./manifest');
const { writeZip } = require('./zip');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'player');
const SCHEMA_DIR = path.join(ROOT, 'vendor', 'schemas');
const PDFJS_DIR = path.join(ROOT, 'vendor', 'pdfjs');

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

// Hard-link large media into the staging folder when possible instead of
// copying 500 MB around.
async function linkOrCopy(src, dest) {
  try { await fsp.link(src, dest); } catch { await fsp.copyFile(src, dest); }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Builds the unpacked SCORM package in `stageDir`.
 * content: { kind: 'pdf'|'video', file: absolute path, poster?: absolute path, duration? }
 * options: { title, version, completion: { mode: 'launch'|'progress', threshold }, passOnComplete, reportScore, restrictSeek }
 */
async function stagePackage(stageDir, content, options) {
  const { version } = options;
  if (!VERSIONS[version]) throw new Error(`Unknown SCORM version: ${version}`);

  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(stageDir, 'player'), { recursive: true });
  await fsp.mkdir(path.join(stageDir, 'content'), { recursive: true });

  // Schema definition files at the package root (required by the ADL
  // conformance rules and checked by several LMS importers).
  await copyDir(path.join(SCHEMA_DIR, VERSIONS[version].schemaDir), stageDir);

  for (const f of ['scorm-api.js', 'player.js', 'player.css']) {
    await fsp.copyFile(path.join(TEMPLATE_DIR, f), path.join(stageDir, 'player', f));
  }

  let src;
  if (content.kind === 'pdf') {
    src = 'content/document.pdf';
    await linkOrCopy(content.file, path.join(stageDir, src));
    await copyDir(PDFJS_DIR, path.join(stageDir, 'player', 'pdfjs'));
  } else {
    src = 'content/video.mp4';
    await linkOrCopy(content.file, path.join(stageDir, src));
    if (content.poster) await fsp.copyFile(content.poster, path.join(stageDir, 'content', 'poster.jpg'));
  }

  const config = {
    title: options.title,
    type: content.kind,
    src,
    poster: content.kind === 'video' && content.poster ? 'content/poster.jpg' : null,
    version: version === '1.2' ? '1.2' : '2004',
    completion: {
      mode: options.completion.mode === 'launch' ? 'launch' : 'progress',
      threshold: Math.max(1, Math.min(100, Number(options.completion.threshold) || 100)),
    },
    passOnComplete: !!options.passOnComplete,
    reportScore: !!options.reportScore,
    restrictSeek: !!options.restrictSeek,
  };
  await fsp.writeFile(
    path.join(stageDir, 'player', 'config.js'),
    `window.SCORM_CONFIG = ${JSON.stringify(config, null, 2).replace(/</g, '\\u003c')};\n`,
  );

  const template = await fsp.readFile(path.join(TEMPLATE_DIR, 'index.html'), 'utf8');
  const html = template
    .replace(/\{\{TITLE\}\}/g, htmlEscape(options.title))
    .replace(/\{\{TYPE\}\}/g, content.kind)
    .replace('{{PDFJS}}', content.kind === 'pdf' ? '<script src="player/pdfjs/pdf.min.js"></script>' : '');
  await fsp.writeFile(path.join(stageDir, 'index.html'), html);

  // Manifest lists every file except itself and the schema files.
  const files = (await listFiles(stageDir)).filter((f) => !/\.(xsd|dtd)$/.test(f));
  const xml = buildManifest(version, { id: options.id, title: options.title, files, launch: 'index.html' });
  await fsp.writeFile(path.join(stageDir, 'imsmanifest.xml'), xml);

  return { files: await listFiles(stageDir) };
}

// Zips the staged folder with imsmanifest.xml at the archive root. See
// src/zip.js for why a custom writer is used.
async function zipDir(stageDir, outFile, onProgress) {
  const files = await listFiles(stageDir);
  // Put the manifest first; some importers only peek at the first entries.
  const ordered = ['imsmanifest.xml', ...files.filter((f) => f !== 'imsmanifest.xml')];
  return writeZip(outFile, ordered.map((f) => ({ name: f, file: path.join(stageDir, f) })), onProgress);
}

module.exports = { stagePackage, zipDir, listFiles };
