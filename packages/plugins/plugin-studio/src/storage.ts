/**
 * Where Studio files live: `studio/<companyId>/<own|kind-ref>/<assetId>/v<n>.<ext>` in the company's private bucket.
 *
 * The R2 token reaches every prefix in that bucket, including other plugins' billing and payroll files, so the
 * prefix is enforced here. Every signed URL goes through `objectUrl`, which refuses a key outside this company's
 * Studio folder. Signed URLs are for the worker and for people's browsers: never return one to an agent, because the
 * host redacts them (agents get a local file path from `localCopy`).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { presignUrl, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { StudioError } from "./errors.js";

export const STUDIO_PREFIX = "studio";
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

export interface PrivateBucket {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function segment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new StudioError(`Unsafe ${label} in a storage path`, "unsafe_key");
  return value;
}

export function scopeSegment(scope: ClientScope): string {
  return scope ? `${segment(scope.kind, "client kind")}-${segment(scope.id, "client id")}` : "own";
}

export function assetKey(companyId: string, scope: ClientScope, assetId: string, version: number, ext: string): string {
  return `${STUDIO_PREFIX}/${segment(companyId, "company id")}/${scopeSegment(scope)}/${segment(assetId, "asset id")}/v${version}.${segment(ext, "extension")}`;
}

export function assertOwnKey(companyId: string, key: string): void {
  const parts = key.split("/");
  if (parts[0] !== STUDIO_PREFIX || parts[1] !== companyId || parts.length < 5 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new StudioError("That file is outside this company's Studio folder", "forbidden_key");
  }
}

export function objectUrl(cfg: PrivateBucket, companyId: string, method: "GET" | "PUT" | "DELETE", key: string, expiresSec: number): string {
  assertOwnKey(companyId, key);
  return presignUrl({
    method,
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: "auto",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSec,
  });
}

/** Server-side upload. Native fetch: `ctx.http.fetch` stringifies binary bodies. */
export async function putObject(cfg: PrivateBucket, companyId: string, key: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<void> {
  const res = await fetch(objectUrl(cfg, companyId, "PUT", key, 300), { method: "PUT", body: bytes, headers: { "Content-Type": mime }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status}`);
}

export async function getObject(cfg: PrivateBucket, companyId: string, key: string): Promise<Uint8Array> {
  const res = await fetch(objectUrl(cfg, companyId, "GET", key, 300), { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Storage read failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The first `n` bytes of an object, to check its type after a streamed copy (PAR-8125). A ranged GET, and the reader
 * stops after `n` bytes even if the server sends more, so a 200 MB video is never read whole.
 */
export async function getObjectHead(cfg: PrivateBucket, companyId: string, key: string, n = 64): Promise<Uint8Array> {
  const res = await fetch(objectUrl(cfg, companyId, "GET", key, 60), { headers: { Range: `bytes=0-${n - 1}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`Storage read failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, n - got);
    out.set(value.subarray(0, take), got);
    got += take;
  }
  await reader.cancel().catch(() => undefined);
  return out.subarray(0, got);
}

/** Remove an object Studio wrote but won't keep (a streamed import of the wrong type). A missing object is fine. */
export async function deleteObject(cfg: PrivateBucket, companyId: string, key: string): Promise<void> {
  const res = await fetch(objectUrl(cfg, companyId, "DELETE", key, 60), { method: "DELETE", signal: AbortSignal.timeout(30_000) });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed: HTTP ${res.status}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function extFor(mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new StudioError(`Studio stores images and videos, not ${mime}`, "unsupported_type");
  return ext;
}

export function kindFor(mime: string): "image" | "video" {
  return mime.startsWith("video/") ? "video" : "image";
}

/** The file's real type, from its first bytes. A provider's or uploader's stated type is not trusted. */
export function sniffMime(b: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") return ascii(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  return null;
}

/** Agents read files from here. Same user as the worker, private to it, swept after a day. */
export function localRoot(): string {
  return (
    process.env.PIB_STUDIO_WORKDIR ||
    join(process.env.PAPERCLIP_HOME || join(homedir(), ".paperclip"), "instances", process.env.PAPERCLIP_INSTANCE_ID || "default", "data", "studio-files")
  );
}

export async function localCopy(companyId: string, assetId: string, version: number, ext: string, read: () => Promise<Uint8Array>): Promise<string> {
  const dir = join(localRoot(), segment(companyId, "company id"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${segment(assetId, "asset id")}-v${version}.${segment(ext, "extension")}`);
  const present = await stat(file).then((s) => s.size > 0).catch(() => false);
  if (!present) await writeFile(file, await read(), { mode: 0o600 });
  return file;
}

/** Copies given to an agent on an issue (give.ts) live longer than the one-day tool copies: the agent may run later. */
export const GIVEN_DIR = "given";
export const GIVEN_KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh copy per give, under `<root>/<companyId>/given/`, so a later give or a sweep of tool copies never touches it. */
export async function givenCopy(companyId: string, giveId: string, assetId: string, version: number, ext: string, bytes: Uint8Array): Promise<string> {
  const dir = join(localRoot(), segment(companyId, "company id"), GIVEN_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${segment(assetId, "asset id")}-v${version}-${segment(giveId, "give id")}.${segment(ext, "extension")}`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/** Removes the copy of one give (cancelled popup). Every name is checked, and only that give's own file is touched. */
export async function removeGivenCopy(companyId: string, assetId: string, giveId: string): Promise<number> {
  const dir = join(localRoot(), segment(companyId, "company id"), GIVEN_DIR);
  const prefix = `${segment(assetId, "asset id")}-v`;
  const tail = `-${segment(giveId, "give id")}.`;
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix) || !name.includes(tail)) continue;
    await rm(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

async function sweepFiles(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    // Only plain files: the given/ folder is swept on its own clock, and rm without recursive throws on a folder.
    if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function sweepLocalCopies(maxAgeMs = DAY_MS, now = Date.now(), givenMaxAgeMs = GIVEN_KEEP_DAYS * DAY_MS): Promise<number> {
  let removed = 0;
  const root = localRoot();
  const companies = await readdir(root).catch(() => [] as string[]);
  for (const company of companies) {
    const dir = join(root, company);
    removed += await sweepFiles(dir, maxAgeMs, now);
    removed += await sweepFiles(join(dir, GIVEN_DIR), givenMaxAgeMs, now);
  }
  return removed;
}
