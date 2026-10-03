/**
 * The public lead form: keys, signatures, validation and the abuse checks,
 * all pure (no database, no host call), so every rule is tested on its own.
 * `lead-capture.ts` runs them in order and does the storing.
 *
 * A form submission is untrusted from the first byte: the endpoint is public
 * (`POST /api/plugins/partnersinbiz.crm/webhooks/lead`), so every field is
 * length-capped, control characters are removed, and nothing is believed
 * until it has passed the checks below.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The manifest's webhook endpoint key. */
export const LEAD_ENDPOINT_KEY = "lead";

/** active: takes leads. paused: stops for now. revoked: off for good (only a person does it). */
export const SOURCE_STATUSES = ["active", "paused", "revoked"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Largest request body the endpoint reads. A real form is a few hundred bytes. */
export const MAX_BODY_BYTES = 16_384;
/** A person cannot fill in a form in under this long: faster is a script. */
export const MIN_FILL_MS = 1_500;
/** An older key keeps working this long after a rotation, so the snippet can be swapped without losing leads. */
export const KEY_GRACE_DAYS = 7;
/** A signed request older (or newer) than this is refused. */
export const SIGNATURE_SKEW_MS = 5 * 60_000;

export const LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  company: 160,
  message: 2_000,
  url: 500,
  consentText: 500,
  extraKeys: 10,
  extraKey: 40,
  extraValue: 300,
  utmValue: 120,
} as const;

/** The most links a message may carry before it is treated as spam. */
export const MAX_LINKS = 3;

// ---------------------------------------------------------------------------
// Keys and signatures
// ---------------------------------------------------------------------------

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomText(length: number, alphabet: string): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** The public key of a lead form: `pibl_` and 24 characters. It is in the page source by design, so it is not a secret. */
export function generateLeadKey(): string {
  return `pibl_${randomText(24, KEY_ALPHABET)}`;
}

/** The secret a server-to-server caller signs requests with (`pibs_` and 40 characters). Shown once. */
export function generateSigningSecret(): string {
  return `pibs_${randomText(40, `${KEY_ALPHABET}0123456789`)}`;
}

export function isLeadKey(value: unknown): value is string {
  return typeof value === "string" && /^pibl_[a-z2-7]{24}$/.test(value);
}

/** A short, safe label for a secret (never the secret itself). */
export function keyId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** `sha256=<hex>` over `<timestamp>.<raw body>`, the value of `X-PiB-Signature`. */
export function signLeadRequest(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/** Checks a signed request: a current timestamp and the HMAC of the exact bytes. Constant-time compare. */
export function verifyLeadSignature(input: { secret: string; timestamp: string | undefined; signature: string | undefined; rawBody: string; now: number }): SignatureCheck {
  const stamp = Number(input.timestamp);
  if (!input.timestamp || !Number.isFinite(stamp)) return { ok: false, reason: "X-PiB-Timestamp is missing or not a number (milliseconds since 1970)." };
  if (Math.abs(input.now - stamp) > SIGNATURE_SKEW_MS) return { ok: false, reason: "X-PiB-Timestamp is too far from the server time." };
  const expected = Buffer.from(signLeadRequest(input.secret, input.timestamp, input.rawBody));
  const given = Buffer.from(input.signature ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "The signature does not match." };
  return { ok: true };
}

/** A header value, whatever its case and whether the host sent a string or a list. */
export function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * The visitor's address as the proxy saw it. Caddy sets `X-Real-IP` to the
 * real remote host and replaces any value the caller sent, so that is the one
 * to trust; `X-Forwarded-For` is the fallback (its first entry).
 */
export function clientIp(headers: Record<string, string | string[]> | undefined): string | null {
  const real = headerValue(headers, "x-real-ip")?.trim();
  const forwarded = headerValue(headers, "x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (real || forwarded || "").replace(/^::ffff:/i, "");
  return ip && /^[0-9a-f:.]{3,45}$/i.test(ip) ? ip.toLowerCase() : null;
}

/** A keyed hash of the address (the key is a per-installation secret): it can be compared and counted, not read back. */
export function hashIp(salt: string, ip: string): string {
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Plain text: control characters and runs of blanks removed, capped. Newlines survive only when asked. */
export function cleanText(value: unknown, max: number, keepNewlines = false): string {
  if (typeof value !== "string") return "";
  // Every kind of line break becomes one plain "\n" first: a lone CR, NEL or the Unicode separators must not survive into an issue
  // as a line a markdown reader would start (a visitor could otherwise fake a "Your part" block).
  const unified = value.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n");
  const stripped = unified.replace(keepNewlines ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, " ");
  const text = keepNewlines ? stripped.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : stripped.replace(/\s+/g, " ");
  return text.trim().slice(0, max);
}

/** Collapses every line break (CR, LF, NEL, the Unicode separators) to a space: a visitor's message goes into a one-line quote in an issue. */
export function oneLine(value: string): string {
  return value.replace(/[\r\n\u0085\u2028\u2029]+/g, " ");
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= LIMITS.email && EMAIL_RE.test(value) && !value.includes("..") && !/^[.]|[.]@/.test(value);
}

export function emailDomain(email: string): string {
  return email.includes("@") ? (email.split("@").pop() ?? "").trim().toLowerCase() : "";
}

/**
 * The same email always gives the same key, whatever the case or spacing. With `salt` (the installation's private key) it is a
 * keyed hash: nobody can test a guessed address against it. Without it, a plain hash (tests and the erasure lookup only).
 */
export function emailHash(email: string, salt?: string): string {
  const address = email.trim().toLowerCase();
  return (salt ? createHmac("sha256", salt).update(`email:${address}`) : createHash("sha256").update(address)).digest("hex").slice(0, 16);
}

/**
 * Throwaway-mailbox providers. A short built-in list of the common ones; the
 * company can add more in the CRM settings (`leads.blockedEmailDomains`).
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com", "mailinator.net", "mailinator2.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamailblock.com", "grr.la", "sharklasers.com", "spam4.me", "pokemail.net", "10minutemail.com", "10minutemail.net",
  "10minutemail.org", "20minutemail.com", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "tempmail.dev", "tempmailo.com",
  "tempail.com", "tempr.email", "tempinbox.com", "throwawaymail.com", "throwaway.email", "trashmail.com", "trashmail.net", "trashmail.org",
  "trashmail.de", "trash-mail.com", "trashmail.io", "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.org", "nospam.ze.tc",
  "getnada.com", "nada.email", "dispostable.com", "fakeinbox.com", "fakemail.net", "fakemailgenerator.com", "maildrop.cc", "mailnesia.com",
  "mailcatch.com", "mailtemp.net", "mailsac.com", "mohmal.com", "moakt.com", "emailondeck.com", "mintemail.com", "mytemp.email",
  "spamgourmet.com", "spambox.us", "spamex.com", "spamfree24.org", "burnermail.io", "burner.email", "anonbox.net", "anonymbox.com",
  "discard.email", "discardmail.com", "discardmail.de", "dropmail.me", "emltmp.com", "etranquil.com", "filzmail.com", "getairmail.com",
  "gishpuppy.com", "harakirimail.com", "incognitomail.com", "inboxbear.com", "instantemailaddress.com", "jourrapide.com", "kasmail.com",
  "kurzepost.de", "luxusmail.org", "mail-temporaire.fr", "mailexpire.com", "mailforspam.com", "mailin8r.com", "mailmoat.com", "mailnull.com",
  "mailzilla.com", "meltmail.com", "mt2015.com", "mvrht.com", "nowmymail.com", "objectmail.com", "owlpic.com", "proxymail.eu", "put2.net",
  "rcpt.at", "recode.me", "safetymail.info", "selfdestructingmail.com", "sendspamhere.com", "smapfree24.com", "snakemail.com", "sogetthis.com",
  "soodonims.com", "supermailer.jp", "teleworm.us", "tempmailaddress.com", "thankyou2010.com", "trbvm.com", "twinmail.de", "uroid.com",
  "veryrealemail.com", "wegwerfmail.de", "wegwerfmail.net", "wh4f.org", "yepmail.ru", "yuurok.com", "zehnminutenmail.de", "zippymail.info",
  "tmail.ws", "tmpmail.org", "tmpmail.net", "gmailnator.com", "mail.tm", "inboxkitten.com", "tempm.com", "1secmail.com", "1secmail.net", "1secmail.org",
  "linshiyouxiang.net", "armyspy.com", "cuvox.de", "dayrep.com", "einrot.com", "fleckens.hu", "gustr.com", "rhyta.com", "superrito.com",
]);

/** These names are never real addresses (RFC 2606): a real form never needs them, so only a canary source accepts them. */
const RESERVED_TLDS = [".invalid", ".example", ".localhost"];

export function isDisposableEmail(email: string, extraDomains: readonly string[] = []): boolean {
  const domain = emailDomain(email);
  if (!domain) return true;
  const blocked = (host: string) => DISPOSABLE_EMAIL_DOMAINS.has(host) || extraDomains.includes(host);
  // The address's own domain, or any parent of it (`x.mailinator.com`).
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) if (blocked(parts.slice(i).join("."))) return true;
  return false;
}

/** True for addresses on a reserved name. The canary client uses `.invalid` on purpose, so it can never reach a real mailbox. */
export function isReservedEmail(email: string): boolean {
  const domain = emailDomain(email);
  return RESERVED_TLDS.some((tld) => domain.endsWith(tld));
}

/** The extra-domain list from the settings: commas, spaces or new lines, lower-cased and bare. */
export function parseBlockedDomains(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.toLowerCase().split(/[\s,;]+/).map((part) => part.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim()).filter((part) => part.includes(".")))];
}

/** Too many links is what spam looks like. */
export function looksLikeSpam(text: string): boolean {
  return (text.match(/https?:\/\/|www\./gi) ?? []).length > MAX_LINKS;
}

// ---------------------------------------------------------------------------
// The submission
// ---------------------------------------------------------------------------

export interface Attribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  gclid: string | null;
  fbclid: string | null;
  /** The page the form was on. */
  pageUrl: string | null;
  /** The page the visitor came from before that (the landing page's referrer). */
  referrer: string | null;
  /** The first page of the visit, when the visit started elsewhere on the site. */
  landingUrl: string | null;
}

export interface Submission {
  name: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  message: string;
  /** Other fields the form asked (a service, a budget). A few, short, as text. */
  extra: Record<string, string>;
  /** The visitor ticked the marketing consent box. */
  consent: boolean;
  /** What the box said, as the visitor saw it. */
  consentText: string | null;
  attribution: Attribution;
  /** Milliseconds between the form showing and the send (browser forms only). */
  fillMs: number | null;
  honeypot: string;
  turnstileToken: string | null;
  /** Server callers may pass the visitor's own address and browser; only believed on a signed request. */
  visitorIp: string | null;
}

function link(value: unknown): string | null {
  const text = cleanText(value, LIMITS.url);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString().slice(0, LIMITS.url);
  } catch {
    return null;
  }
}

function utm(value: unknown): string | null {
  const text = cleanText(value, LIMITS.utmValue);
  return text || null;
}

/** UTM values arrive as `utm: { source, medium, ... }`, or flat as `utm_source`. Both are accepted. */
export function parseAttribution(body: Record<string, unknown>): Attribution {
  const nested = body.utm && typeof body.utm === "object" && !Array.isArray(body.utm) ? (body.utm as Record<string, unknown>) : {};
  const pick = (name: string) => utm(nested[name] ?? nested[`utm_${name}`] ?? body[`utm_${name}`]);
  return {
    utmSource: pick("source"),
    utmMedium: pick("medium"),
    utmCampaign: pick("campaign"),
    utmTerm: pick("term"),
    utmContent: pick("content"),
    gclid: utm(nested.gclid ?? body.gclid),
    fbclid: utm(nested.fbclid ?? body.fbclid),
    pageUrl: link(body.pageUrl ?? body.page_url),
    referrer: link(body.referrer),
    landingUrl: link(body.landingUrl ?? body.landing_url),
  };
}

function parseExtra(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= LIMITS.extraKeys) break;
    const key = cleanText(rawKey, LIMITS.extraKey).toLowerCase().replace(/[^a-z0-9_ -]/g, "").trim();
    const text = typeof rawValue === "number" || typeof rawValue === "boolean" ? String(rawValue) : cleanText(rawValue, LIMITS.extraValue);
    if (key && text) out[key] = text;
  }
  return out;
}

export type SubmissionCheck = { ok: true; submission: Submission } | { ok: false; reason: "invalid" | "blocked_email"; message: string };

/**
 * Reads and checks the fields. Refuses a missing or malformed email and a
 * throwaway or reserved address with a plain message the form shows.
 */
export function parseSubmission(body: Record<string, unknown>, options: { extraBlockedDomains?: readonly string[]; allowReserved?: boolean } = {}): SubmissionCheck {
  const email = cleanText(body.email, LIMITS.email + 20).toLowerCase();
  if (!email) return { ok: false, reason: "invalid", message: "Please enter your email address." };
  if (!isValidEmail(email)) return { ok: false, reason: "invalid", message: "That email address does not look right." };
  if (isDisposableEmail(email, options.extraBlockedDomains) || (!options.allowReserved && isReservedEmail(email))) {
    return { ok: false, reason: "blocked_email", message: "Please use a permanent email address, not a temporary one." };
  }
  const message = cleanText(body.message, LIMITS.message, true);
  const consent = body.consent === true || body.consent === "true" || body.consent === "on";
  const fill = typeof body.t === "number" && Number.isFinite(body.t) ? body.t : null;
  return {
    ok: true,
    submission: {
      name: cleanText(body.name, LIMITS.name) || null,
      email,
      phone: cleanText(body.phone, LIMITS.phone).replace(/[^0-9+()\-\s.]/g, "").replace(/\s+/g, " ").trim() || null,
      company: cleanText(body.company, LIMITS.company) || null,
      message,
      extra: parseExtra(body.fields ?? body.extra),
      consent,
      consentText: cleanText(body.consentText, LIMITS.consentText) || null,
      attribution: parseAttribution(body),
      fillMs: fill,
      honeypot: cleanText(body.hp_website, 200),
      turnstileToken: cleanText(body.turnstileToken, 4_000) || null,
      visitorIp: cleanText(body.visitorIp, 45) || null,
    },
  };
}

/** `form:<source id>:<keyed email hash>:<yyyymmdd>`: the same person sending the same form twice in a day is one lead. */
export function leadCaptureKey(sourceId: string, email: string, now: Date, salt?: string): string {
  return `form:${sourceId}:${emailHash(email, salt)}:${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
}
