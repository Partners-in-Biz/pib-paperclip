/**
 * Svix webhook signatures, the scheme Resend signs its webhooks with.
 *
 * A delivery carries three headers: `svix-id` (the same on every retry of one
 * delivery), `svix-timestamp` (seconds; set again on each attempt) and
 * `svix-signature` (space separated `v1,<base64>` entries). The signature is the
 * base64 HMAC-SHA256 of `<id>.<timestamp>.<raw body>` keyed with the endpoint's
 * signing secret, which is shown as `whsec_<base64>` (the key is the decoded part
 * after the prefix). Only `v1` is believed, the timestamp must be within five
 * minutes (a captured delivery cannot be replayed later), and the comparison is
 * constant time. The body must be the exact bytes that were signed: the host hands
 * the plugin the raw body for this reason.
 *
 * The webhook address is public and the host lets a plugin resolve 30 secrets a
 * minute per company, so `checkSvixShape` refuses what is plainly not a signed
 * delivery BEFORE any secret is asked for. Passing it proves nothing:
 * `verifySvix` still has to match the HMAC.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SVIX_TOLERANCE_SECONDS = 300;

export interface SvixHeaders {
  id: string;
  timestamp: number;
  /** The base64 part of each `v1,` entry. */
  signatures: string[];
}

export type SvixRejection = "missing" | "malformed" | "stale" | "bad_signature" | "no_secret";

export type SvixShape = { ok: true; headers: SvixHeaders } | { ok: false; code: Exclude<SvixRejection, "bad_signature" | "no_secret">; message: string };

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | null {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  }
  return null;
}

/** HMAC-SHA256 signatures are 32 bytes: 44 characters of base64 with one padding character. */
const SIGNATURE_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * What can be told about a delivery's headers without the secret: all three are there, the id is sane, the timestamp is
 * a whole number of seconds within the tolerance, and at least one `v1` signature has the shape of an HMAC-SHA256.
 */
export function checkSvixShape(headers: Record<string, string | string[] | undefined> | undefined, nowMs: number, toleranceSeconds = SVIX_TOLERANCE_SECONDS): SvixShape {
  const id = headerValue(headers, "svix-id");
  const rawTimestamp = headerValue(headers, "svix-timestamp");
  const rawSignature = headerValue(headers, "svix-signature");
  if (!id || !rawTimestamp || !rawSignature) return { ok: false, code: "missing", message: "The Svix headers (svix-id, svix-timestamp, svix-signature) are not all there" };
  if (id.length > 200 || !/^[\w.:-]+$/.test(id) || !/^\d{9,12}$/.test(rawTimestamp)) return { ok: false, code: "malformed", message: "The Svix id or timestamp is not valid" };
  const timestamp = Number(rawTimestamp);
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return { ok: false, code: "stale", message: "The Svix timestamp is too old or too far in the future" };
  const signatures: string[] = [];
  for (const part of rawSignature.slice(0, 2000).split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    // Only v1: a downgrade to another scheme must not pass.
    if (part.slice(0, comma) !== "v1") continue;
    const value = part.slice(comma + 1);
    if (SIGNATURE_RE.test(value)) signatures.push(value);
  }
  if (signatures.length === 0) return { ok: false, code: "malformed", message: "The Svix signature has no usable v1 entry" };
  return { ok: true, headers: { id, timestamp, signatures } };
}

/** The HMAC key from a `whsec_` secret (the prefix is optional; what is left is base64). Null when it is not usable. */
export function svixKey(secret: string): Buffer | null {
  const text = secret.trim().replace(/^whsec_/, "");
  if (!text || !/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  const key = Buffer.from(text, "base64");
  return key.length >= 16 ? key : null;
}

/** `v1,<base64>` for a delivery, as Svix would sign it (tests and the mock journey). */
export function signSvix(secret: string, id: string, timestampSeconds: number, rawBody: string): string {
  const key = svixKey(secret);
  if (!key) throw new Error("The Svix signing secret is not usable");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestampSeconds}.${rawBody}`).digest("base64")}`;
}

export type SvixResult = { ok: true; id: string; timestamp: number } | { ok: false; code: SvixRejection; message: string };

/** Verifies one delivery against one signing secret. Never throws. */
export function verifySvix(input: { secret: string; rawBody: string; headers: Record<string, string | string[] | undefined> | undefined; nowMs: number }): SvixResult {
  const shape = checkSvixShape(input.headers, input.nowMs);
  if (!shape.ok) return shape;
  const key = svixKey(input.secret);
  if (!key) return { ok: false, code: "no_secret", message: "The Resend webhook signing secret is not usable (it should start with whsec_)" };
  const expected = createHmac("sha256", key).update(`${shape.headers.id}.${shape.headers.timestamp}.${input.rawBody}`).digest();
  for (const signature of shape.headers.signatures) {
    const given = Buffer.from(signature, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id: shape.headers.id, timestamp: shape.headers.timestamp };
  }
  return { ok: false, code: "bad_signature", message: "The Svix signature does not match" };
}
