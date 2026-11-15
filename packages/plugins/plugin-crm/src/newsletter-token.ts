/**
 * Newsletter confirmation token (PAR-10817 plan, "Target design > CRM plugin > Token"; PAR-10851).
 *
 * `base64url(payload).base64url(hmac)`, HMAC-SHA256 keyed with the source's `confirm_secret`, a per-source secret only the
 * plugin holds. A token minted with the source's `signing_secret` (the value the site holds) does not verify, so a leak from
 * the site cannot confirm an address. Pure: no I/O, the clock is a parameter.
 *
 * The payload is a fixed binary layout so the whole link `confirm_url#t=<token>` stays under 800 characters even at the
 * longest fields:
 *
 *   version (1 byte) | source id (16 bytes, the UUID) | issued-at (4 bytes, seconds, big-endian)
 *   | wording hash (8 bytes: the first 16 hex characters of SHA-256 of the source's `consent_text`)
 *   | email length (1 byte) | email (UTF-8, lower-cased) | path length (1 byte) | page path (UTF-8)
 *
 * The limits (254 for the email, 200 for the path) count UTF-8 bytes. For the usual ASCII address and path that is the same
 * as characters; for a non-ASCII one it is stricter, which is what keeps the link bound.
 *
 * The wording itself is not in the token. Confirm stores the source's current `consent_text` and the token is refused when its
 * hash no longer matches, so the consent record always holds the wording the person saw. Changing `consent_text` voids open links.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CONFIRM_TOKEN_VERSION = 1;
/** A link is valid this long after it was issued (PiB, PAR-10830). */
export const CONFIRM_TOKEN_TTL_MS = 7 * 86_400_000;
/** An issued-at this far ahead of the verifier's clock is still accepted (clock skew between workers). */
export const CONFIRM_TOKEN_SKEW_MS = 60_000;
export const MAX_EMAIL_BYTES = 254;
export const MAX_PATH_BYTES = 200;
/** The longest `confirm_url` that keeps `confirm_url#t=<token>` under {@link MAX_CONFIRM_LINK_LENGTH} at the longest fields. */
export const MAX_CONFIRM_URL_LENGTH = 100;
/** The whole link is shorter than this. */
export const MAX_CONFIRM_LINK_LENGTH = 800;
/** A `confirm_secret` shorter than this is refused, so a blank or placeholder key never signs. */
export const MIN_CONFIRM_SECRET_LENGTH = 32;

const FIXED_BYTES = 1 + 16 + 4 + 8 + 1 + 1;
const HASH_BYTES = 8;
const MAC_BYTES = 32;
const MAX_PAYLOAD_BYTES = FIXED_BYTES + MAX_EMAIL_BYTES + MAX_PATH_BYTES;
/** Longest well-formed token: payload and MAC in unpadded base64url, one dot. */
export const MAX_CONFIRM_TOKEN_LENGTH = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 1 + Math.ceil((MAC_BYTES * 4) / 3);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// Control characters never belong in an address or a path, and would end up in the consent record.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** The source fields the token depends on. `confirmSecret` is the `confirm_secret` column, never `signing_secret`. */
export type ConfirmTokenSource = { id: string; confirmSecret: string; consentText: string };

export type ConfirmTokenClaims = { version: number; sourceId: string; email: string; issuedAt: number; pagePath: string; wordingHash: string };

export type ConfirmTokenFailure = "malformed" | "oversize" | "bad_signature" | "unknown_version" | "wrong_source" | "expired" | "wording_changed";

export type ConfirmTokenCheck = { ok: true; claims: ConfirmTokenClaims } | { ok: false; reason: ConfirmTokenFailure };

/** First 16 hex characters of SHA-256 of the consent wording. */
export function wordingHash(consentText: string): string {
  return createHash("sha256").update(consentText, "utf8").digest("hex").slice(0, HASH_BYTES * 2);
}

function mac(secret: string, payload: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function requireSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < MIN_CONFIRM_SECRET_LENGTH) throw new Error("The source has no usable confirm secret.");
}

function uuidBytes(id: string): Buffer {
  if (!UUID_RE.test(id)) throw new Error("The source id is not a UUID.");
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function uuidText(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Decodes canonical unpadded base64url only; anything else (padding, stray characters, a non-canonical last digit) is null. */
function decodeB64url(text: string): Buffer | null {
  if (!B64URL_RE.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/**
 * Mints the token for one signup. `issuedAt` is milliseconds since 1970 (stored to the second). Throws on an empty or
 * oversize email or path, a control character, a source id that is not a UUID, or a missing secret.
 */
export function mintConfirmToken(source: ConfirmTokenSource, input: { email: string; pagePath: string; issuedAt: number }): string {
  requireSecret(source.confirmSecret);
  const id = uuidBytes(source.id);
  const email = input.email.trim().toLowerCase();
  const emailBytes = Buffer.from(email, "utf8");
  const pathBytes = Buffer.from(input.pagePath, "utf8");
  if (!email || CONTROL_RE.test(email)) throw new Error("The email is empty or holds a control character.");
  if (CONTROL_RE.test(input.pagePath)) throw new Error("The page path holds a control character.");
  if (emailBytes.length > MAX_EMAIL_BYTES) throw new Error(`The email is longer than ${MAX_EMAIL_BYTES} bytes.`);
  if (pathBytes.length > MAX_PATH_BYTES) throw new Error(`The page path is longer than ${MAX_PATH_BYTES} bytes.`);
  const seconds = Math.floor(input.issuedAt / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0xffffffff) throw new Error("The issued-at time is out of range.");

  const head = Buffer.alloc(1 + 16 + 4);
  head.writeUInt8(CONFIRM_TOKEN_VERSION, 0);
  id.copy(head, 1);
  head.writeUInt32BE(seconds, 17);
  const payload = Buffer.concat([
    head,
    Buffer.from(wordingHash(source.consentText), "hex"),
    Buffer.from([emailBytes.length]),
    emailBytes,
    Buffer.from([pathBytes.length]),
    pathBytes,
  ]);
  return `${payload.toString("base64url")}.${mac(source.confirmSecret, payload).toString("base64url")}`;
}

function parsePayload(payload: Buffer): { claims: ConfirmTokenClaims } | { reason: "malformed" | "oversize" } {
  if (payload.length < FIXED_BYTES) return { reason: "malformed" };
  let at = 1 + 16 + 4 + HASH_BYTES;
  const emailLength = payload.readUInt8(at);
  at += 1;
  if (emailLength > MAX_EMAIL_BYTES) return { reason: "oversize" };
  if (at + emailLength + 1 > payload.length) return { reason: "malformed" };
  const emailBytes = payload.subarray(at, at + emailLength);
  at += emailLength;
  const pathLength = payload.readUInt8(at);
  at += 1;
  if (pathLength > MAX_PATH_BYTES) return { reason: "oversize" };
  if (at + pathLength !== payload.length) return { reason: "malformed" };
  const pathBytes = payload.subarray(at);
  const email = emailBytes.toString("utf8");
  const pagePath = pathBytes.toString("utf8");
  // Round-trip check refuses invalid UTF-8; an address must be non-empty and already lower-cased.
  if (Buffer.from(email, "utf8").compare(emailBytes) !== 0 || Buffer.from(pagePath, "utf8").compare(pathBytes) !== 0) return { reason: "malformed" };
  if (!email || email !== email.toLowerCase() || CONTROL_RE.test(email) || CONTROL_RE.test(pagePath)) return { reason: "malformed" };
  return {
    claims: {
      version: payload.readUInt8(0),
      sourceId: uuidText(payload.subarray(1, 17)),
      issuedAt: payload.readUInt32BE(17) * 1000,
      wordingHash: payload.subarray(21, 21 + HASH_BYTES).toString("hex"),
      email,
      pagePath,
    },
  };
}

/**
 * Checks a token against the source it claims to be for, at time `now` (milliseconds). The signature is checked first and in
 * constant time; no field is trusted before it passes.
 */
export function verifyConfirmToken(source: ConfirmTokenSource, token: unknown, now: number): ConfirmTokenCheck {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
  if (token.length > MAX_CONFIRM_TOKEN_LENGTH) return { ok: false, reason: "oversize" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const payload = decodeB64url(parts[0]!);
  const given = decodeB64url(parts[1]!);
  if (!payload || !given || given.length !== MAC_BYTES) return { ok: false, reason: "malformed" };
  if (typeof source.confirmSecret !== "string" || source.confirmSecret.length < MIN_CONFIRM_SECRET_LENGTH) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(mac(source.confirmSecret, payload), given)) return { ok: false, reason: "bad_signature" };

  if (payload.length === 0 || payload.readUInt8(0) !== CONFIRM_TOKEN_VERSION) return { ok: false, reason: "unknown_version" };
  const parsed = parsePayload(payload);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  const { claims } = parsed;
  if (!UUID_RE.test(source.id) || claims.sourceId !== source.id.toLowerCase()) return { ok: false, reason: "wrong_source" };
  if (now - claims.issuedAt > CONFIRM_TOKEN_TTL_MS || claims.issuedAt - now > CONFIRM_TOKEN_SKEW_MS) return { ok: false, reason: "expired" };
  const expected = Buffer.from(wordingHash(source.consentText), "hex");
  if (!timingSafeEqual(expected, Buffer.from(claims.wordingHash, "hex"))) return { ok: false, reason: "wording_changed" };
  return { ok: true, claims };
}

/** `confirm_url#t=<token>`. Throws when the link would reach {@link MAX_CONFIRM_LINK_LENGTH} characters. */
export function confirmLink(confirmUrl: string, token: string): string {
  const link = `${confirmUrl}#t=${token}`;
  if (link.length >= MAX_CONFIRM_LINK_LENGTH) throw new Error(`The confirmation link would be ${link.length} characters; the most is ${MAX_CONFIRM_LINK_LENGTH - 1}.`);
  return link;
}
