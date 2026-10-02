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

// Correct answers ship lightly obfuscated so they aren't readable at a
// glance in config.js. Mirrors decodeKey() in templates/player/quiz.js.
function encodeKey(indexes, salt) {
  const s = indexes.join(',');
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) ^ salt.charCodeAt(i % salt.length) ^ ((i * 31) & 255);
  }
  return out.toString('base64');
}

const PLAYER_FILES = ['scorm-api.js', 'viewers.js', 'quiz.js', 'player.js', 'player.css'];

/**
 * Builds the unpacked SCORM package in `stageDir`.
 * course: normalised course (src/course.js)
 * assets: { [itemId]: { kind: 'pdf'|'video', file, poster? } } for file items
 */
async function stagePackage(stageDir, course, assets, { id }) {
  const { version } = course;
  if (!VERSIONS[version]) throw new Error(`Unknown SCORM version: ${version}`);

  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(stageDir, 'player'), { recursive: true });
  await fsp.mkdir(path.join(stageDir, 'content'), { recursive: true });

  // Schema definition files at the package root (required by the ADL
  // conformance rules and checked by several LMS importers).
  await copyDir(path.join(SCHEMA_DIR, VERSIONS[version].schemaDir), stageDir);

  for (const f of PLAYER_FILES) {
    await fsp.copyFile(path.join(TEMPLATE_DIR, f), path.join(stageDir, 'player', f));
  }

  let hasPdf = false;
  const items = [];
  for (let i = 0; i < course.items.length; i++) {
    const it = course.items[i];
    const n = String(i + 1).padStart(2, '0');
    if (it.type === 'quiz') {
      items.push({
        id: it.id,
        kind: 'quiz',
        title: it.title,
        required: it.required,
        parent: it.attachedTo || null,
        quiz: {
          ...it.quiz,
          questions: it.quiz.questions.map((q, qi) => ({
            type: q.type, text: q.text, options: q.options, feedback: q.feedback,
            k: encodeKey(q.correct, `${it.id}:${qi}`),
          })),
        },
      });
      continue;
    }
    const asset = assets[it.id];
    if (!asset) throw new Error(`Missing file for "${it.title}".`);
    const entry = { id: it.id, kind: asset.kind, title: it.title, required: it.required, threshold: it.threshold };
    if (asset.kind === 'pdf') {
      hasPdf = true;
      entry.src = `content/${n}-document.pdf`;
      await linkOrCopy(asset.file, path.join(stageDir, entry.src));
    } else {
      entry.src = `content/${n}-video.mp4`;
      entry.restrictSeek = it.restrictSeek;
      await linkOrCopy(asset.file, path.join(stageDir, entry.src));
      if (asset.poster) {
        entry.poster = `content/${n}-poster.jpg`;
        await fsp.copyFile(asset.poster, path.join(stageDir, entry.poster));
      }
    }
    items.push(entry);
  }
  if (hasPdf) await copyDir(PDFJS_DIR, path.join(stageDir, 'player', 'pdfjs'));

  const config = {
    title: course.title,
    version: version === '1.2' ? '1.2' : '2004',
    navigation: course.navigation,
    passOnComplete: course.passOnComplete,
    reportScore: course.reportScore,
    recordInteractions: course.recordInteractions,
    items,
  };
  await fsp.writeFile(
    path.join(stageDir, 'player', 'config.js'),
    `window.SCORM_CONFIG = ${JSON.stringify(config, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};\n`,
  );

  const template = await fsp.readFile(path.join(TEMPLATE_DIR, 'index.html'), 'utf8');
  const html = template
    .replace(/\{\{TITLE\}\}/g, htmlEscape(course.title))
    .replace('{{PDFJS}}', hasPdf ? '<script src="player/pdfjs/pdf.min.js"></script>' : '');
  await fsp.writeFile(path.join(stageDir, 'index.html'), html);

  // Manifest lists every file except itself and the schema files.
  const files = (await listFiles(stageDir)).filter((f) => !/\.(xsd|dtd)$/.test(f));
  const xml = buildManifest(version, { id, title: course.title, files, launch: 'index.html' });
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
