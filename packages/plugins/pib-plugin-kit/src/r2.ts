/**
 * S3 SigV4 presigning (used for Cloudflare R2) without the AWS SDK.
 *
 * Browsers upload straight to the bucket with a presigned PUT; the worker can
 * reuse the same URL with native fetch for server-side imports. Media is then
 * read back from the bucket's public domain, which Instagram, TikTok and
 * Pinterest fetch from.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

export interface PresignInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  host: string;
  /** Absolute path, already starting with "/". Each segment is URI-encoded here. */
  path: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSec: number;
  now?: Date;
  /** Extra query params to sign (e.g. response-content-type). */
  query?: Record<string, string>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += ch;
    else {
      for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp: iso, date: iso.slice(0, 8) };
}

export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Returns a presigned URL (query-string auth, UNSIGNED-PAYLOAD, signs `host` only). */
export function presignUrl(input: PresignInput): string {
  const service = input.service ?? "s3";
  const { date, stamp } = amzDate(input.now ?? new Date());
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const params: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(params[key]!)}`)
    .join("&");
  const canonicalPath = uriEncode(input.path, false);
  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    `host:${input.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, date, input.region, service))
    .update(stringToSign, "utf8")
    .digest("hex");
  return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base, e.g. https://media.partnersinbiz.online (no trailing slash). */
  publicBaseUrl: string;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

export const R2_ALLOWED_MIME = Object.keys(MIME_EXT);

export function objectKeyFor(input: { prefix: string; companyId: string; mime: string; fileName?: string }): string {
  const ext = MIME_EXT[input.mime];
  if (!ext) throw new Error(`Unsupported media type ${input.mime}`);
  const base = (input.fileName ?? "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const month = new Date().toISOString().slice(0, 7);
  return `${input.prefix}/${input.companyId}/${month}/${randomUUID()}${base ? `-${base}` : ""}.${ext}`;
}

export function r2Upload(cfg: R2Config, key: string, expiresSec = 900, now?: Date): { uploadUrl: string; publicUrl: string } {
  const uploadUrl = presignUrl({
    method: "PUT",
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: "auto",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSec,
    now,
  });
  return { uploadUrl, publicUrl: `${cfg.publicBaseUrl.replace(/\/$/, "")}/${key}` };
}

/** Server-side upload with native fetch (ctx.http.fetch stringifies binary bodies). */
export async function r2PutObject(cfg: R2Config, key: string, body: Uint8Array<ArrayBuffer> | Blob, contentType: string): Promise<string> {
  const { uploadUrl, publicUrl } = r2Upload(cfg, key, 300);
  const res = await fetch(uploadUrl, { method: "PUT", body, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error(`R2 upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return publicUrl;
}
