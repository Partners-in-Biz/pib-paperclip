/**
 * RFC 5322 / MIME message builder for Gmail `users.messages.send`.
 *
 * Layout: multipart/mixed (only with attachments) → multipart/alternative
 * (text + html) → parts. Bodies and attachments are base64 with 76-column
 * lines; non-ASCII headers use RFC 2047 encoded words and non-ASCII file
 * names RFC 2231 parameters. CRLF throughout; header values never carry CR/LF.
 */
import { createHash, randomBytes } from "node:crypto";
import type { MailAddress } from "@partnersinbiz/pib-plugin-kit";

const CRLF = "\r\n";

export interface MimeAttachment {
  filename: string;
  mime: string;
  content: Uint8Array;
}

export interface MimeInput {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  attachments?: MimeAttachment[];
  /** `<id@host>`. */
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  /** Test hook for stable boundaries. */
  boundary?: (depth: number) => string;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** RFC 2047 B-encoded words, each ≤ 75 characters, never splitting a character. */
export function encodedWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (chunkBytes + bytes > 45 && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += bytes;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words;
}

/** Header text: as-is when printable ASCII, else encoded words folded onto continuation lines. */
export function encodeHeaderText(value: string): string {
  const text = singleLine(value);
  if (isAscii(text)) return text;
  return encodedWords(text).join(`${CRLF} `);
}

function quoteName(name: string): string {
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return name;
  return `"${name.replace(/(["\\])/g, "\\$1")}"`;
}

export function formatAddress(address: MailAddress): string {
  const email = singleLine(address.email);
  const name = address.name ? singleLine(address.name) : "";
  if (!name) return email;
  return `${isAscii(name) ? quoteName(name) : encodedWords(name).join(" ")} <${email}>`;
}

function addressHeader(name: string, list: MailAddress[]): string {
  return `${name}: ${list.map(formatAddress).join(`,${CRLF} `)}`;
}

/** Base64 wrapped at 76 columns. */
export function base64Lines(content: Uint8Array | string): string {
  const b64 = (typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)).toString("base64");
  return b64.replace(/.{1,76}/g, (line) => `${line}${CRLF}`).replace(/\r\n$/, "");
}

export function base64Url(value: string | Uint8Array): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Plain-text fallback for an HTML body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : "application/octet-stream";
}

function safeFilename(value: string): string {
  const name = singleLine(value).replace(/[\\/"]/g, "_").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
  return name || "attachment";
}

function rfc2231(value: string): string {
  return `UTF-8''${encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function attachmentPart(attachment: MimeAttachment): string {
  const filename = safeFilename(attachment.filename);
  const mime = safeMime(attachment.mime);
  const ascii = isAscii(filename);
  const nameParam = ascii ? `name="${filename}"` : `name="${encodedWords(filename).join(" ")}"`;
  const dispositionParam = ascii ? `filename="${filename}"` : `filename*=${rfc2231(filename)}`;
  return [
    `Content-Type: ${mime}; ${nameParam}`,
    `Content-Disposition: attachment; ${dispositionParam}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(attachment.content),
  ].join(CRLF);
}

function textPart(subtype: "plain" | "html", body: string): string {
  return [`Content-Type: text/${subtype}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join(CRLF);
}

function multipart(subtype: "mixed" | "alternative", boundary: string, parts: string[]): string {
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}${CRLF}${part}`),
    `--${boundary}--`,
  ].join(CRLF);
}

function defaultBoundary(): string {
  return `=_pib_${randomBytes(12).toString("hex")}`;
}

/** Deterministic Message-ID for a send request, so a retried send can be recognised. */
export function messageIdFor(key: string, fromEmail: string): string {
  const host = (fromEmail.split("@")[1] ?? "mailbox.local").replace(/[^A-Za-z0-9.-]/g, "") || "mailbox.local";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `<pib.${hash}@${host}>`;
}

export function buildMime(input: MimeInput): string {
  if (input.to.length === 0 && (input.cc ?? []).length === 0 && (input.bcc ?? []).length === 0) {
    throw new Error("A message needs at least one recipient");
  }
  const boundary = input.boundary ?? defaultBoundary;
  const headers: string[] = [
    addressHeader("From", [input.from]),
  ];
  if (input.to.length > 0) headers.push(addressHeader("To", input.to));
  if (input.cc?.length) headers.push(addressHeader("Cc", input.cc));
  if (input.bcc?.length) headers.push(addressHeader("Bcc", input.bcc));
  if (input.replyTo) headers.push(addressHeader("Reply-To", [input.replyTo]));
  headers.push(`Subject: ${encodeHeaderText(input.subject ?? "")}`);
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000")}`);
  if (input.messageId) headers.push(`Message-ID: ${singleLine(input.messageId)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${singleLine(input.inReplyTo)}`);
  const refs = (input.references ?? []).map(singleLine).filter(Boolean);
  if (refs.length > 0) headers.push(`References: ${refs.join(`${CRLF} `)}`);
  headers.push("MIME-Version: 1.0");

  const html = input.html?.trim() ? input.html : null;
  const text = input.text?.trim() ? input.text : html ? htmlToText(html) : "";
  const bodyParts: string[] = [];
  bodyParts.push(textPart("plain", text));
  if (html) bodyParts.push(textPart("html", html));
  const body = bodyParts.length === 1 ? bodyParts[0]! : multipart("alternative", boundary(1), bodyParts);

  const attachments = input.attachments ?? [];
  const root = attachments.length > 0 ? multipart("mixed", boundary(0), [body, ...attachments.map(attachmentPart)]) : body;
  return `${headers.join(CRLF)}${CRLF}${root}${CRLF}`;
}
