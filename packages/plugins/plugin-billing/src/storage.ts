/**
 * Financial documents on a private Cloudflare R2 bucket.
 *
 * Nothing here is public: keys hold a random UUID (unguessable), reads are
 * presigned GETs that expire, and uploads from the browser are presigned
 * PUTs. The Mailbox gets 7-day links so its retries still work.
 */
import { randomUUID } from "node:crypto";
import { presignUrl, r2PutObject } from "@partnersinbiz/pib-plugin-kit";
import type { PrivateR2 } from "./config.js";
import { BillingError } from "./domain.js";

export const MAIL_LINK_SECONDS = 7 * 24 * 3600;
export const VIEW_LINK_SECONDS = 15 * 60;
export const UPLOAD_LINK_SECONDS = 15 * 60;
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const UPLOAD_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type StoredKind = "invoice" | "quote" | "credit_note" | "statement" | "receipt" | "pop" | "bill";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** `<prefix>/<companyId>/<kind>/<yyyy-mm>/<uuid>[-name].<ext>` */
export function documentKey(r2: Pick<PrivateR2, "prefix">, companyId: string, kind: StoredKind, fileName: string, ext: string, now = new Date()): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) throw new BillingError("Unsafe company id");
  const base = slug(fileName.replace(/\.[^.]+$/, ""));
  return `${r2.prefix}/${companyId}/${kind}/${now.toISOString().slice(0, 7)}/${randomUUID()}${base ? `-${base}` : ""}.${ext}`;
}

/** A key this plugin issued for the company (browser uploads come back with one). */
export function assertOwnKey(r2: Pick<PrivateR2, "prefix">, companyId: string, key: string, kind?: StoredKind): void {
  const root = `${r2.prefix}/${companyId}/${kind ? `${kind}/` : ""}`;
  if (!key.startsWith(root) || key.includes("..") || /[^A-Za-z0-9/_.-]/.test(key)) throw new BillingError("That file does not belong to this company");
}

function host(r2: PrivateR2): string {
  return `${r2.accountId}.r2.cloudflarestorage.com`;
}

export function presignGet(r2: PrivateR2, key: string, expiresSec: number, downloadName?: string, now?: Date): string {
  const query: Record<string, string> = {};
  if (downloadName) query["response-content-disposition"] = `inline; filename="${downloadName.replace(/["\\\r\n]/g, "")}"`;
  return presignUrl({
    method: "GET",
    host: host(r2),
    path: `/${r2.bucket}/${key}`,
    region: "auto",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    expiresSec: Math.min(expiresSec, MAIL_LINK_SECONDS),
    now,
    query,
  });
}

export function presignPut(r2: PrivateR2, key: string, now?: Date): string {
  return presignUrl({
    method: "PUT",
    host: host(r2),
    path: `/${r2.bucket}/${key}`,
    region: "auto",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    expiresSec: UPLOAD_LINK_SECONDS,
    now,
  });
}

export async function putObject(r2: PrivateR2, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await r2PutObject(r2, key, bytes as Uint8Array<ArrayBuffer>, contentType);
}

/** Read an object back (receipt extraction). Native fetch: R2 is a provider API. */
export async function getObject(r2: PrivateR2, key: string, maxBytes = UPLOAD_MAX_BYTES): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(presignGet(r2, key, 300));
  if (!res.ok) throw new BillingError(`Could not read the file from storage (HTTP ${res.status})`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new BillingError("The file is too large");
  return { bytes: buffer, mime: res.headers.get("content-type") ?? "application/octet-stream" };
}

export function assertUploadable(mime: string, bytes: number): string {
  const ext = UPLOAD_MIME[mime];
  if (!ext) throw new BillingError("Upload a PDF, JPEG, PNG, WebP or GIF file");
  if (!Number.isFinite(bytes) || bytes <= 0) throw new BillingError("File size is required");
  if (bytes > UPLOAD_MAX_BYTES) throw new BillingError("Files are limited to 20 MB");
  return ext;
}
