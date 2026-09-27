/**
 * `get-attachment`: one attachment of a stored message, fetched from Gmail on
 * demand (never during sync).
 *
 * - The file goes to the private R2 bucket under
 *   `<prefix>/<companyId>/attachments/<yyyy-mm>/<uuid>-<name>` and the agent
 *   gets a presigned link that expires in 15 minutes.
 * - Text files a bookkeeper imports (CSV, OFX, QFX, QIF, TXT, MT940) up to
 *   200 KB also come back as text, so a bank statement can be imported
 *   without the link (and without R2).
 */
import { randomUUID } from "node:crypto";
import { presignUrl } from "@partnersinbiz/pib-plugin-kit";
import type { PrivateR2, LoadedConfig } from "../config.js";
import { MailboxError } from "../domain.js";
import { getAttachmentData, getMessageParts, GmailApiError } from "./api.js";
import type { Env } from "./env.js";
import { collectAttachments } from "./sync.js";
import { withGmail } from "./tokens.js";
import type { AccountRow, AttachmentMeta, MessageRow } from "./types.js";

export const LINK_SECONDS = 15 * 60;
export const TEXT_MAX_BYTES = 200 * 1024;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["csv", "tsv", "ofx", "qfx", "qif", "txt", "sta", "mt940", "940"]);
const TEXT_MIMES = new Set(["text/csv", "text/plain", "text/tab-separated-values", "application/csv", "application/x-ofx", "application/ofx", "application/vnd.intu.qfx", "application/x-qif", "application/qif"]);

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : "";
}

/** CSV, OFX, QFX, QIF, TXT and MT940 statements come back as text too. */
export function isTextAttachment(filename: string, mime: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(filename)) || TEXT_MIMES.has(mime.toLowerCase().split(";")[0]!.trim());
}

/** UTF-8, else Windows-1252 (many South African bank exports). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function slug(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** `<prefix>/<companyId>/attachments/<yyyy-mm>/<uuid>[-name][.ext]`: unguessable, one folder per company. */
export function attachmentKey(r2: Pick<PrivateR2, "prefix">, companyId: string, filename: string, now = new Date()): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) throw new MailboxError("Unsafe company id");
  const ext = extensionOf(filename);
  const base = slug(filename);
  return `${r2.prefix}/${companyId}/attachments/${now.toISOString().slice(0, 7)}/${randomUUID()}${base ? `-${base}` : ""}${ext ? `.${ext}` : ""}`;
}

function r2Url(r2: PrivateR2, method: "GET" | "PUT", key: string, expiresSec: number, query?: Record<string, string>, now?: Date): string {
  return presignUrl({
    method,
    host: `${r2.accountId}.r2.cloudflarestorage.com`,
    path: `/${r2.bucket}/${key}`,
    region: "auto",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    expiresSec,
    now,
    query,
  });
}

/** Upload with the Mailbox's fetch (native in production) and return a 15-minute download link. */
export async function storeAttachment(env: Env, r2: PrivateR2, companyId: string, meta: { filename: string; mime: string }, bytes: Uint8Array): Promise<{ key: string; link: string; expiresAt: string }> {
  const key = attachmentKey(r2, companyId, meta.filename, new Date(env.now()));
  const res = await env.fetch(r2Url(r2, "PUT", key, 300), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: { "Content-Type": meta.mime || "application/octet-stream" },
  });
  if (!res.ok) throw new MailboxError(`Could not store the attachment (R2 said HTTP ${res.status})`);
  const disposition = `attachment; filename="${meta.filename.replace(/["\\\r\n]/g, "_")}"`;
  return {
    key,
    link: r2Url(r2, "GET", key, LINK_SECONDS, { "response-content-disposition": disposition }),
    expiresAt: new Date(env.now() + LINK_SECONDS * 1000).toISOString(),
  };
}

/**
 * The attachment's bytes from Gmail. A stale attachment id (Gmail issues new
 * ones) is looked up again by file name and size.
 */
export async function downloadAttachment(env: Env, loaded: LoadedConfig, account: AccountRow, row: MessageRow, meta: AttachmentMeta): Promise<Uint8Array> {
  const gmailId = row.gmail_message_id;
  if (!gmailId) throw new MailboxError("This message is not in Gmail, so it has no attachments to fetch");
  const fetchOnce = (attachmentId: string) => withGmail(env, loaded, account, (token) => getAttachmentData(env.fetch, token, gmailId, attachmentId));
  try {
    return await fetchOnce(meta.attachmentId);
  } catch (error) {
    if (!(error instanceof GmailApiError) || (error.status !== 404 && error.status !== 400)) throw error;
    const parts = collectAttachments(await withGmail(env, loaded, account, (token) => getMessageParts(env.fetch, token, gmailId)));
    const fresh = parts.find((part) => part.filename === meta.filename && (!meta.bytes || part.bytes === meta.bytes)) ?? parts.find((part) => part.filename === meta.filename);
    if (!fresh) throw new MailboxError(`${meta.filename} is no longer on that message in Gmail`);
    return fetchOnce(fresh.attachmentId);
  }
}
