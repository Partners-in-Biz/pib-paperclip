/**
 * The public site events endpoint, the pure part (audit Q10-8, Q1a-14): keys, limits and the checks on what a visitor's browser
 * sends. No database and no host call, so every rule is tested on its own. `site-events.ts` runs them and stores the counts.
 *
 * What is collected, and what is not. A tiny script on a client's site reports a page view, an outbound click or a named
 * conversion (form submitted, call clicked, WhatsApp clicked). The request carries a page path with no query string, the
 * referring host, the campaign tags of the visit and an event name. It carries no name, email, phone, form content or visitor
 * id, and the endpoint ignores any other field. Only a daily count per site, kind, name and channel is stored. The visitor's
 * network address is used for a rate limit as a keyed hash and removed after two days; it is never stored with a count. (The host's
 * own request log, outside this plugin, records each request with the address and browser for a few days: see the README.)
 *
 * Consent: by default (`anonymous`) the script keeps nothing on the visitor's device beyond a per-tab memory of how the visit
 * started. It sends nothing at all when the browser says Do Not Track or Global Privacy Control. Only when the SITE'S own consent
 * banner calls `pibEvents.consent(true)` does it also remember the first and the last campaign touch for 90 days, so a conversion
 * can be credited to the channel that first brought the visitor.
 */
import { createHash, randomBytes } from "node:crypto";
import { hostOf, type Touch } from "./channels.js";
import { cleanText } from "./lead-form.js";

export { EVENTS_ENDPOINT_KEY } from "./endpoints.js";

export const EVENT_KEY_STATUSES = ["active", "paused", "revoked"] as const;
export type EventKeyStatus = (typeof EVENT_KEY_STATUSES)[number];
export const CONSENT_MODES = ["anonymous", "required"] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

export const EVENT_LIMITS = {
  /** A real request is a few hundred bytes. */
  bodyBytes: 4_096,
  eventsPerRequest: 10,
  name: 40,
  path: 120,
  bucket: 40,
  host: 100,
  touchValue: 60,
  /** Distinct names a site may use in a day before the rest count as "other", so a script cannot grow the table. */
  conversionNamesPerDay: 20,
  pathBucketsPerDay: 40,
  outboundHostsPerDay: 30,
} as const;

export const EVENT_RATE = {
  /** Requests a key answers a minute. */
  keyPerMinute: 120,
  /** Requests a visitor may make: a real visit sends a handful. */
  ipPerMinute: 30,
  ipPerHour: 600,
} as const;

/** A key is rotated with this much overlap, so the snippet can be swapped without losing a day of counts. */
export const EVENT_KEY_GRACE_DAYS = 7;
/** Daily counts are kept this long (a bit over a year, for year-on-year); nothing finer is stored at all. */
export const ROLLUP_KEEP_DAYS = 400;

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** The write key of a site: `pibe_` and 24 characters. It is in the page source by design, so it is not a secret. */
export function generateEventKey(): string {
  const bytes = randomBytes(24);
  let out = "pibe_";
  for (let i = 0; i < 24; i += 1) out += KEY_ALPHABET[bytes[i]! % KEY_ALPHABET.length];
  return out;
}

export function isEventKey(value: unknown): value is string {
  return typeof value === "string" && /^pibe_[a-z2-7]{24}$/.test(value);
}

/** A short, safe label for a key. */
export function eventKeyId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export type EventType = "pv" | "out" | "cv";

/** One event, checked and cut to size. */
export interface ParsedEvent {
  type: EventType;
  /** An outbound click's host, or a conversion's name. Empty for a page view. */
  name: string;
  /** The first path segment of the page, lower case (`/services`, `/`). */
  bucket: string;
  /** A new visit started with this page view. */
  entrance: boolean;
  /** How this visit started. */
  visit: Touch | null;
  /** The first and the last campaign touch the visitor allowed the site to remember (absent without consent). */
  first: Touch | null;
  last: Touch | null;
}

/** An event name as a person writes it (`Form Submitted`, `call-clicked`) as one plain word group: `form_submitted`. */
export function eventName(value: unknown): string {
  const text = cleanText(value, EVENT_LIMITS.name * 2)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, EVENT_LIMITS.name)
    .replace(/_+$/g, "");
  return text;
}

/** The first path segment: `/Services/SEO?x=1#top` becomes `/services`. A path that is not one gives null. */
export function pathBucket(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().split(/[?#]/)[0] ?? "";
  if (!raw.startsWith("/") || raw.length > EVENT_LIMITS.path) return null;
  const first = raw.toLowerCase().split("/").filter(Boolean)[0] ?? "";
  const clean = first.replace(/[^a-z0-9._-]/g, "").slice(0, EVENT_LIMITS.bucket - 1);
  return clean ? `/${clean}` : "/";
}

function touch(value: unknown): Touch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (name: string) => {
    const t = cleanText(v[name], EVENT_LIMITS.touchValue);
    return t || null;
  };
  const click = v.k === "g" || v.k === "m" || v.k === "f" ? v.k : null;
  const out: Touch = { source: text("s"), medium: text("m"), campaign: text("c"), referrerHost: hostOf(typeof v.r === "string" ? v.r.slice(0, EVENT_LIMITS.host) : null), click };
  return out.source || out.medium || out.campaign || out.referrerHost || out.click ? out : null;
}

/** A host a visitor left for: only a host, never a path or a query. */
export function outboundHost(value: unknown): string | null {
  return typeof value === "string" ? hostOf(value.slice(0, EVENT_LIMITS.host)) : null;
}

export function parseEvent(raw: unknown): ParsedEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const type = e.t === "pv" || e.t === "out" || e.t === "cv" ? e.t : null;
  if (!type) return null;
  const bucket = pathBucket(e.p) ?? "/";
  const parsed: ParsedEvent = { type, name: "", bucket, entrance: e.e === 1 || e.e === true, visit: touch(e.v), first: touch(e.ft), last: touch(e.lt) };
  if (type === "out") {
    const host = outboundHost(e.n);
    if (!host) return null;
    parsed.name = host;
  } else if (type === "cv") {
    const name = eventName(e.n);
    if (!name) return null;
    parsed.name = name;
  }
  return parsed;
}

export type EventsCheck = { ok: true; key: string; events: ParsedEvent[]; origin: string | null } | { ok: false; message: string };

/** Reads the request body: the key, the events (at most ten; ones that do not check out are dropped) and where the page says it is from. */
export function parseEventsBody(body: Record<string, unknown>): EventsCheck {
  const key = typeof body.k === "string" ? body.k.trim() : "";
  if (!isEventKey(key)) return { ok: false, message: "The site key is missing or not valid." };
  if (!Array.isArray(body.ev) || body.ev.length === 0) return { ok: false, message: "Send at least one event." };
  const events: ParsedEvent[] = [];
  for (const raw of body.ev.slice(0, EVENT_LIMITS.eventsPerRequest)) {
    const parsed = parseEvent(raw);
    if (parsed) events.push(parsed);
  }
  if (events.length === 0) return { ok: false, message: "None of the events could be read." };
  const origin = typeof body.o === "string" ? hostOf(body.o.slice(0, 200)) : null;
  return { ok: true, key, events, origin };
}

/** The day a count belongs to, in South African time (UTC+2 all year), as `YYYY-MM-DD`: months then line up with the monthly report. */
export function dayOf(at: Date | number): string {
  return new Date((typeof at === "number" ? at : at.getTime()) + 2 * 3_600_000).toISOString().slice(0, 10);
}

/** The days a month covers, as `[from, to)` strings. */
export function periodDays(period: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error("period must be YYYY-MM");
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}`;
  return { from: `${period}-01`, to: `${next}-01` };
}

/** The last `days` days, ending today: `[from, to)` where `to` is tomorrow. */
export function lastDays(now: Date, days: number): { from: string; to: string } {
  return { from: dayOf(now.getTime() - (days - 1) * 86_400_000), to: dayOf(now.getTime() + 86_400_000) };
}
