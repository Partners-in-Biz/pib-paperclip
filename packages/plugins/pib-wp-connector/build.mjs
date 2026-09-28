#!/usr/bin/env node
// Builds dist/pib-connector.zip (top folder `pib-connector/`) with a small pure-Node
// zip writer (deflate via node:zlib, CRC-32, central directory). No dependencies, so it
// runs the same on the Mac and on the VPS (which has no `zip` binary).
//
// The output is deterministic: sorted entries and a fixed timestamp, so the same
// source always gives the same sha256.
//
//   node build.mjs                  -> dist/pib-connector.zip
//   import { buildConnectorZip } from './build.mjs'; await buildConnectorZip(outPath)

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(HERE, 'pib-connector');
const TOP = 'pib-connector';
const DEFAULT_OUT = join(HERE, 'dist', 'pib-connector.zip');

// 2026-01-01 00:00:00 in MS-DOS format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // no dotfiles (.DS_Store etc.)
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ full, dir: true });
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      out.push({ full, dir: false });
    }
  }
  return out;
}

/**
 * @param {{ name: string, data: Buffer | null }[]} entries  name uses `/`; data null = directory
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const isDir = data === null;
    const nameBuf = Buffer.from(isDir && !name.endsWith('/') ? name + '/' : name, 'utf8');
    const raw = isDir ? Buffer.alloc(0) : data;
    const crc = isDir ? 0 : crc32(raw);
    let method = 0;
    let body = raw;
    if (!isDir && raw.length > 0) {
      const deflated = deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    const mode = isDir ? 0o40755 : 0o100644;
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * Build the WordPress plugin zip.
 * @param {string} [outPath] defaults to dist/pib-connector.zip next to this file
 * @returns {Promise<{ path: string, sha256: string, bytes: number, files: string[] }>}
 */
export async function buildConnectorZip(outPath = DEFAULT_OUT) {
  const s = await stat(SOURCE_DIR);
  if (!s.isDirectory()) throw new Error(`missing ${SOURCE_DIR}`);

  const found = await walk(SOURCE_DIR);
  const items = found
    .map((f) => ({ ...f, rel: relative(SOURCE_DIR, f.full).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const entries = [{ name: `${TOP}/`, data: null }];
  for (const it of items) {
    entries.push({ name: `${TOP}/${it.rel}${it.dir ? '/' : ''}`, data: it.dir ? null : await readFile(it.full) });
  }

  const zip = writeZip(entries);
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  return { path: target, sha256, bytes: zip.length, files: entries.map((e) => e.name) };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  buildConnectorZip(out)
    .then((r) => {
      console.log(`${r.path}`);
      console.log(`${r.files.length} entries, ${r.bytes} bytes`);
      console.log(`sha256 ${r.sha256}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
