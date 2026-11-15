/**
 * Render work folders (PAR-8276 A6): `<localRoot>/renders/r-<renderId>-XXXXXX`, private to the worker user.
 * A disk check runs before a folder is made, the folder is removed in `finally`, and the hourly `sweep-local-files`
 * job removes folders a dead worker left behind (never one a live process still names in its command line).
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StudioError } from "../errors.js";
import { MAX_ASSET_BYTES, localRoot, objectUrl, type PrivateBucket } from "../storage.js";

export const RENDERS_DIR = "renders";
export const MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;
export const INPUT_FREE_FACTOR = 4;
/** A render runs at most 20 min plus upload; a folder this old with no live process is left over. */
export const RENDER_DIR_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const DIR_PREFIX = "r-";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,8}$/;

export function rendersRoot(): string {
  return join(localRoot(), RENDERS_DIR);
}

type StatfsFn = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/**
 * Throws `disk_low` unless the disk has >= `minFreeBytes` (default 8 GB) free and >= 4x the input bytes. A multi-pass
 * render passes a higher floor (render-pipeline.ts `multiPassMinFreeBytes`).
 */
export async function assertDiskSpace(dir: string, inputBytes: number, statfsImpl: StatfsFn = statfs, minFreeBytes: number = MIN_FREE_BYTES): Promise<number> {
  const s = await statfsImpl(dir);
  const free = Number(s.bavail) * Number(s.bsize);
  const need = Math.max(minFreeBytes, INPUT_FREE_FACTOR * Math.max(0, inputBytes));
  if (free < need) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new StudioError(`Not enough disk space to render: ${gb(free)} GB free, ${gb(need)} GB needed`, "disk_low");
  }
  return free;
}

/** Runs `fn` in a fresh render folder and always removes the folder afterwards. */
export async function withRenderWorkdir<T>(renderId: string, inputBytes: number, fn: (dir: string) => Promise<T>, statfsImpl?: StatfsFn): Promise<T> {
  if (!SAFE_ID.test(renderId)) throw new StudioError("Unsafe render id in a work folder", "unsafe_key");
  const root = rendersRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDiskSpace(root, inputBytes, statfsImpl);
  const dir = await mkdtemp(join(root, `${DIR_PREFIX}${renderId}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Streams a signed GET into the work folder. Same pattern as `getObject` (storage.ts: native fetch, 5-minute signal),
 * new here: written to disk instead of memory, a target folder, and a byte cap (Content-Length and counted bytes).
 */
export async function downloadToWorkdir(url: string, dir: string, name: string, maxBytes = MAX_ASSET_BYTES, fetchImpl: typeof fetch = fetch): Promise<{ path: string; bytes: number }> {
  if (!SAFE_NAME.test(name)) throw new StudioError("Unsafe file name in a work folder", "unsafe_key");
  const path = join(dir, name);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`Storage read failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw new StudioError(`Input is larger than ${maxBytes} bytes`, "too_large");
  }
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > maxBytes ? new StudioError(`Input is larger than ${maxBytes} bytes`, "too_large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), cap, createWriteStream(path, { mode: 0o600, flags: "wx" }));
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  return { path, bytes };
}

/** `downloadToWorkdir` for a Studio object key; `objectUrl` refuses a key outside this company's Studio folder. */
export async function downloadObjectToWorkdir(cfg: PrivateBucket, companyId: string, key: string, dir: string, name: string): Promise<{ path: string; bytes: number }> {
  return downloadToWorkdir(objectUrl(cfg, companyId, "GET", key, 300), dir, name);
}

/** Command lines of running processes (Linux `/proc`), NUL separators turned into spaces. */
async function liveCmdlines(procRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const cmd = await readFile(join(procRoot, name, "cmdline"), "utf8").catch(() => "");
    if (cmd) out.push(cmd.replaceAll("\0", " "));
  }
  return out;
}

/** Removes `r-*` folders older than `maxAgeMs` that no live process names. Returns how many were removed. */
export async function sweepRenderWorkdirs(maxAgeMs = RENDER_DIR_MAX_AGE_MS, now = Date.now(), procRoot = "/proc"): Promise<number> {
  const root = rendersRoot();
  const names = (await readdir(root).catch(() => [] as string[])).filter((n) => n.startsWith(DIR_PREFIX));
  if (!names.length) return 0;
  const cmdlines = await liveCmdlines(procRoot);
  let removed = 0;
  for (const name of names) {
    const dir = join(root, name);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue;
    if (cmdlines.some((c) => c.includes(dir))) continue;
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
