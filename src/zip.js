'use strict';

// Minimal ZIP writer tuned for LMS importers.
//
// Every entry's CRC-32 and sizes are written in its local file header, and
// no entry uses a data descriptor (general purpose bit 3). Streaming readers
// such as Java's ZipInputStream (used by SAP SuccessFactors/Plateau and other
// Java-based LMSs) reject STORED entries with data descriptors ("only DEFLATED
// entries can have EXT descriptor"), and some older parsers mishandle
// descriptors entirely, so this layout is the most widely readable one.
//
// Small files are deflated in memory. Large or already-compressed files
// (video, PDF, images) are stored: their CRC is computed in a first pass, then
// the data is streamed into the archive, so memory use stays flat for 500 MB
// inputs.

const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');

// zlib.crc32 is native in Node 20.15+/22.2+; fall back to a table version.
const crc32 = typeof zlib.crc32 === 'function'
  ? (buf, prev) => zlib.crc32(buf, prev)
  : (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return (buf, prev = 0) => {
      let c = (prev ^ 0xffffffff) >>> 0;
      for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
  })();

const MAX_32 = 0xffffffff;
const STORE_EXT = /\.(mp4|m4v|mp3|jpe?g|png|gif|webp|pdf|zip|woff2?)$/i;
const DEFLATE_MAX_BYTES = 32 * 1024 * 1024;

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

async function crcOfFile(file, onBytes) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    crc = crc32(chunk, crc);
    if (onBytes) onBytes(chunk.length);
  }
  return crc >>> 0;
}

function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    stream.once('error', onError);
    if (stream.write(buf)) { stream.off('error', onError); resolve(); } else {
      stream.once('drain', () => { stream.off('error', onError); resolve(); });
    }
  });
}

/**
 * entries: [{ name: 'path/in/zip', file: '/abs/path' }]
 * onProgress(0..1)
 */
async function writeZip(outFile, entries, onProgress) {
  const now = dosDateTime(new Date());
  const sizes = [];
  let totalWork = 0;
  for (const e of entries) {
    const { size } = await fsp.stat(e.file);
    if (size > MAX_32) throw new Error(`${e.name} is larger than 4 GB, which this packager does not support.`);
    sizes.push(size);
    // Stored files are read twice (CRC pass + copy pass).
    totalWork += STORE_EXT.test(e.name) || size > DEFLATE_MAX_BYTES ? size * 2 : size;
  }
  let done = 0;
  const tick = (n) => { done += n; if (onProgress && totalWork) onProgress(Math.min(1, done / totalWork)); };

  const out = fs.createWriteStream(outFile);
  const closed = new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject); });
  const central = [];
  let offset = 0;

  try {
    for (let i = 0; i < entries.length; i++) {
      const { name, file } = entries[i];
      const size = sizes[i];
      const nameBuf = Buffer.from(name, 'utf8');
      const utf8 = /[^\x20-\x7e]/.test(name);

      let method = 0;
      let crc;
      let data = null;
      let compSize = size;

      if (STORE_EXT.test(name) || size > DEFLATE_MAX_BYTES) {
        crc = await crcOfFile(file, tick);
      } else {
        const raw = await fsp.readFile(file);
        crc = crc32(raw, 0) >>> 0;
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length) { method = 8; data = deflated; compSize = deflated.length; } else { data = raw; }
      }
      if (offset > MAX_32) throw new Error('Package is larger than 4 GB, which this packager does not support.');

      const flags = utf8 ? 0x0800 : 0;
      const version = method === 8 ? 20 : 10;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(version, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(now.time, 10);
      local.writeUInt16LE(now.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compSize, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      await writeAll(out, local);
      await writeAll(out, nameBuf);
      if (data) {
        await writeAll(out, data);
        tick(size);
      } else {
        let written = 0;
        for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
          await writeAll(out, chunk);
          written += chunk.length;
          tick(chunk.length);
        }
        if (written !== size) throw new Error(`${name} changed while it was being packaged.`);
      }

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4); // version made by: MS-DOS / 2.0, the most neutral choice
      cd.writeUInt16LE(version, 6);
      cd.writeUInt16LE(flags, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(now.time, 12);
      cd.writeUInt16LE(now.date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compSize, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30); // extra length
      cd.writeUInt16LE(0, 32); // comment length
      cd.writeUInt16LE(0, 34); // disk number
      cd.writeUInt16LE(0, 36); // internal attrs
      cd.writeUInt32LE(0, 38); // external attrs
      cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);

      offset += 30 + nameBuf.length + compSize;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const b of central) { await writeAll(out, b); cdSize += b.length; }
    if (cdStart + cdSize > MAX_32 || entries.length > 0xffff) throw new Error('Package too large for a standard ZIP file.');

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await writeAll(out, eocd);
    out.end();
    await closed;
    return { bytes: cdStart + cdSize + 22 };
  } catch (err) {
    out.destroy();
    await fsp.rm(outFile, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeZip };
