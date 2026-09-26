/**
 * Header helpers: address lists, Message-ID lists and RFC 2047 decoding.
 * Pure functions, no I/O.
 */
import type { MailAddress } from "@partnersinbiz/pib-plugin-kit";

const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value) && !/[\r\n]/.test(value);
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/** Decodes RFC 2047 encoded words (B and Q, UTF-8 / Latin-1). Plain text passes through. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
    try {
      let bytes: Buffer;
      if (encoding.toUpperCase() === "B") {
        bytes = Buffer.from(text, "base64");
      } else {
        const q = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Buffer.from(q, "latin1");
      }
      const cs = charset.toLowerCase().split("*")[0]!;
      if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii") return bytes.toString("utf8");
      if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252") return bytes.toString("latin1");
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** Splits on commas outside quotes, angle brackets and comments. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (quoted) {
      current += char;
      if (char === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    if ((char === "," || char === ";") && depthAngle === 0 && depthParen === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseAddress(value: string): MailAddress | null {
  const text = value.trim();
  if (!text) return null;
  const angle = /<([^<>]+)>\s*$/.exec(text);
  if (angle) {
    const email = angle[1]!.trim();
    let name = text.slice(0, angle.index).trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    name = decodeEncodedWords(name).trim();
    return isValidEmail(email) ? { email: normaliseEmail(email), name: name || null } : null;
  }
  const bare = text.replace(/\([^)]*\)/g, "").trim();
  return isValidEmail(bare) ? { email: normaliseEmail(bare), name: null } : null;
}

export function parseAddressList(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  for (const part of splitAddressList(value)) {
    const address = parseAddress(part);
    if (address) out.push(address);
  }
  return out;
}

/** Accepts `"Name <a@b>"`, `a@b`, `{email, name}`; returns null when invalid. */
export function toMailAddress(value: unknown): MailAddress | null {
  if (typeof value === "string") return parseAddress(value);
  if (value && typeof value === "object" && typeof (value as MailAddress).email === "string") {
    const email = (value as MailAddress).email.trim();
    if (!isValidEmail(email)) return null;
    const name = typeof (value as MailAddress).name === "string" ? String((value as MailAddress).name).replace(/[\r\n]/g, " ").trim() : "";
    return { email: normaliseEmail(email), name: name || null };
  }
  return null;
}

/** `<id@host>` tokens from Message-ID / In-Reply-To / References values. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)];
}

export interface GmailHeader {
  name: string;
  value: string;
}

/** Lower-cased header name → first value. */
export function headerMap(headers: GmailHeader[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    const key = String(header?.name ?? "").toLowerCase();
    if (key && !map.has(key)) map.set(key, String(header.value ?? ""));
  }
  return map;
}

/** Automated or list mail (no person on the other end). */
export function isBulkMail(headers: Map<string, string>, from: MailAddress | null): boolean {
  if (headers.has("list-unsubscribe") || headers.has("list-id")) return true;
  const precedence = (headers.get("precedence") ?? "").toLowerCase();
  if (["bulk", "list", "junk"].includes(precedence)) return true;
  const auto = (headers.get("auto-submitted") ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  const local = from?.email.split("@")[0] ?? "";
  return /^(no-?reply|do-?not-?reply|mailer-daemon|notifications?|bounce[s]?)\b/.test(local);
}

/** A delivery failure notice (bounce / DSN). */
export function isBounceMail(headers: Map<string, string>, from: MailAddress | null): boolean {
  if (headers.has("x-failed-recipients")) return true;
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (/^multipart\/report/.test(type) && /report-type="?delivery-status/.test(type)) return true;
  const local = (from?.email.split("@")[0] ?? "").toLowerCase();
  return local === "mailer-daemon" || local === "postmaster";
}
