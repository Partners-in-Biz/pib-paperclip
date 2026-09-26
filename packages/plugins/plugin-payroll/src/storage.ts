/**
 * Private document storage on Cloudflare R2. Payslips, bank files and
 * statutory exports are written with a presigned PUT (native fetch) and read
 * back only through short-lived presigned GET links. Nothing here has a
 * public URL.
 */
import { presignUrl, r2PutObject } from "@partnersinbiz/pib-plugin-kit";
import type { PrivateR2Config } from "./config.js";

/** Longest SigV4 presign allowed (7 days): used for Mailbox attachments so retries still work. */
export const MAIL_LINK_SECONDS = 7 * 24 * 3600;
/** Board downloads. */
export const DOWNLOAD_LINK_SECONDS = 15 * 60;

export function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "file";
}

/** `<prefix>/<companyId>/<area>/<yyyy-mm>/<id>-<file>` */
export function documentKey(cfg: PrivateR2Config, companyId: string, area: "payslips" | "bank-files" | "exports", id: string, fileName: string, month: string): string {
  return `${cfg.prefix}/${companyId}/${area}/${month}/${id}-${safeFileName(fileName)}`;
}

export async function putPrivate(cfg: PrivateR2Config, key: string, body: Uint8Array, contentType: string): Promise<void> {
  const bytes = new Uint8Array(body.byteLength);
  bytes.set(body);
  await r2PutObject({ ...cfg, publicBaseUrl: "" }, key, bytes, contentType);
}

export function presignGet(cfg: PrivateR2Config, key: string, expiresSec: number, downloadName?: string, now?: Date): string {
  return presignUrl({
    method: "GET",
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: "auto",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSec,
    now,
    query: downloadName ? { "response-content-disposition": `attachment; filename="${safeFileName(downloadName)}"` } : undefined,
  });
}
