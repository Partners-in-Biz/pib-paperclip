/**
 * Channels a campaign step goes out on, and the rules that are the same for
 * every provider (pure: no host, no network).
 *
 * - `email` goes through the Mailbox (Gmail). `sms` and `whatsapp` go through a
 *   messaging provider (see `messaging.ts`).
 * - Phone numbers are stored as E.164 (`+27821234567`). A South African number
 *   written 082 123 4567 is converted; a landline is never texted.
 * - SMS length: GSM-7 text fits 160 characters in one message and 153 per part
 *   when it is split; any other character (a smart quote, an emoji) switches
 *   the whole message to UCS-2: 70 and 67. More parts cost more.
 * - Opt-out words. Twilio blocks its own STOP words (21610) but we also keep our
 *   own list: a person who texts "stop" is never texted again by a campaign, even
 *   when the provider does not block it.
 * - Send windows. South African direct marketing rules (CPA regulation 4) allow
 *   Mon to Fri 08:00-20:00 and Saturday 09:00-13:00, never on a Sunday or public
 *   holiday. Those are the defaults for SMS and WhatsApp; settings can change
 *   them, and public holidays are listed as blackout dates.
 */

export const CHANNELS = ["email", "sms", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];
export type MessagingChannel = "sms" | "whatsapp";

export const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export function isMessagingChannel(value: unknown): value is MessagingChannel {
  return value === "sms" || value === "whatsapp";
}

/** Empty means email (the only channel before 0.6). A value that is not a channel is an error. */
export function parseChannel(value: unknown): Channel {
  if (value == null || value === "") return "email";
  if (!isChannel(value)) throw new Error("channel must be email, sms or whatsapp");
  return value;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The E.164 form of a phone number, or null when it cannot be one. A number
 * with a leading 0 belongs to `defaultCountry` (default South Africa); `00` is
 * the international prefix. A bare nine-digit South African mobile (821234567)
 * is accepted.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry = "+27"): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().replace(/^whatsapp:/i, "");
  // 082 123 4567 (0) is a writing habit, not a digit.
  value = value.replace(/\(0\)/g, "");
  const plus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  let out: string;
  if (plus) out = `+${digits}`;
  else if (digits.startsWith("00")) out = `+${digits.slice(2)}`;
  else if (digits.startsWith("0")) out = `${defaultCountry.startsWith("+") ? defaultCountry : `+${defaultCountry}`}${digits.slice(1)}`;
  else if (defaultCountry === "+27" && /^[6-8]\d{8}$/.test(digits)) out = `+27${digits}`;
  else out = `+${digits}`;
  if (!E164.test(out)) return null;
  // South African numbers have exactly nine digits after +27.
  if (out.startsWith("+27") && !/^\+27[1-9]\d{8}$/.test(out)) return null;
  return out;
}

/** True for a number a text can reach. A South African number that starts 1-5 after +27 is a landline. */
export function isMobile(e164: string): boolean {
  if (e164.startsWith("+27")) return /^\+27[6-8]\d{8}$/.test(e164);
  return E164.test(e164);
}

/** The first number in the list that can be texted, as E.164. */
export function campaignPhone(phones: Array<string | null | undefined> | null | undefined, defaultCountry = "+27"): string | null {
  for (const raw of phones ?? []) {
    const phone = normalizePhone(raw, defaultCountry);
    if (phone && isMobile(phone)) return phone;
  }
  return null;
}

/** `+27 82 *** 4567`: enough to recognise, not enough to misuse (logs, issue titles). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `+${digits.slice(0, 2)}${"*".repeat(Math.max(3, digits.length - 6))}${digits.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// SMS length
// ---------------------------------------------------------------------------

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""),
);
/** Characters the GSM table reaches through an escape: they cost two. */
const GSM_EXTENDED = new Set("\f^{}\\[~]|€".split(""));

export interface SmsLength {
  encoding: "gsm7" | "ucs2";
  /** Characters counted the way the carrier does (an extended GSM character is 2). */
  units: number;
  segments: number;
  /** Units one segment holds at this length. */
  perSegment: number;
  /** Characters that forced UCS-2, when it did. */
  nonGsm: string[];
}

/** The length of an SMS in the unit and segments the carrier bills. An empty text is zero segments. */
export function smsLength(text: string): SmsLength {
  const nonGsm: string[] = [];
  let septets = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENDED.has(ch)) septets += 2;
    else if (!nonGsm.includes(ch)) nonGsm.push(ch);
  }
  if (nonGsm.length === 0) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: "gsm7", units: septets, segments, perSegment: segments > 1 ? 153 : 160, nonGsm };
  }
  // UCS-2 counts UTF-16 code units (an emoji is two).
  const units = text.length;
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: "ucs2", units, segments, perSegment: segments > 1 ? 67 : 70, nonGsm };
}

/** Twilio refuses a body over 1,600 characters (error 21617). */
export const SMS_MAX_CHARS = 1600;
/** WhatsApp template bodies are limited to 1,024 characters; a session message to 4,096. */
export const WHATSAPP_TEMPLATE_MAX = 1024;
export const WHATSAPP_SESSION_MAX = 4096;
/** More parts than this is a cost surprise worth a person's eye. */
export const SMS_SEGMENT_WARN = 3;

const OPT_OUT_LINE = "Reply STOP to opt out.";

/** The words our inbound handler reads as an opt-out. */
const OPT_OUT_KEYWORD = String.raw`(?:stop\s?all|stop|unsubscribe|opt[\s-]?out)`;
/** "Reply STOP", "Text 'stop'", "Send us STOP", "reply with the word STOP": an instruction to send the word. */
const SEND_KEYWORD = new RegExp(
  String.raw`\b(?:reply|respond|text|txt|sms|send|type|whatsapp)\b(?:\s+(?:us|me|back|with|the\s+word|the\s+keyword|word))*\s+["'\u201c\u2018(\[]?${OPT_OUT_KEYWORD}\b(?!\s+\w+ing\b)`,
  "i",
);
/** "STOP to opt out", "STOP to unsubscribe". */
const KEYWORD_TO_LEAVE = /\bstop(?:\s?all)?\s+to\s+(?:opt|unsub|end|cancel|quit|leave|stop|be\s+removed|remove)\b/i;

/**
 * True when the text already tells the reader how to opt out: an instruction to
 * send the word, not the word anywhere. "Stop paying too much for electricity"
 * and "next to the bus stop" are marketing copy, not an opt-out, and get the line.
 * When in doubt this says no: a doubled line costs 22 characters, a missing one is
 * a POPIA and CPA breach.
 */
export function hasOptOutInstruction(text: string): boolean {
  return SEND_KEYWORD.test(text) || KEYWORD_TO_LEAVE.test(text);
}

/** The text a recipient gets: the step text and, when it does not say so itself, how to opt out. */
export function withOptOutLine(text: string): string {
  const body = text.trim();
  if (hasOptOutInstruction(body)) return body;
  return body ? `${body} ${OPT_OUT_LINE}` : OPT_OUT_LINE;
}

// ---------------------------------------------------------------------------
// Opt-out and opt-in words
// ---------------------------------------------------------------------------

export type InboundIntent = "stop" | "start" | "help" | "other";

function normalizeWords(body: string): string {
  return body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_EXACT = new Set(["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "opt-out", "revoke", "unsub"]);
const START_EXACT = new Set(["start", "unstop", "subscribe"]);
const HELP_EXACT = new Set(["help", "info"]);
/**
 * A sentence that clearly asks to stop. Wrongly stopping someone costs a
 * message; wrongly texting someone who asked us to stop costs a complaint, so
 * these lean towards stopping. Single words that also mean something else
 * ("cancel", "end", "quit") only count on their own.
 */
const STOP_PHRASES: RegExp[] = [
  /^(stop|unsubscribe|opt ?-?out)\b/,
  /\b(please )?(stop|quit) (sending|texting|messaging|smsing|contacting|calling|emailing)\b/,
  /\b(do not|don't|dont) (text|sms|message|contact|whatsapp|call|email) me\b/,
  /\b(remove|delete|take) (me|my (number|details|name))\b/,
  /\bno more (texts|sms|messages|whatsapps?)\b/,
  /\bleave me alone\b/,
  /\bopt(ed)? me out\b/,
  /\bunsubscribe me\b/,
];

/** What an inbound text means for the opt-out list. Anything else is a reply a person reads. */
export function classifyKeyword(body: string | null | undefined): InboundIntent {
  const text = normalizeWords(body ?? "");
  if (!text) return "other";
  if (STOP_EXACT.has(text)) return "stop";
  if (START_EXACT.has(text)) return "start";
  if (HELP_EXACT.has(text)) return "help";
  if (STOP_PHRASES.some((pattern) => pattern.test(text))) return "stop";
  return "other";
}

// ---------------------------------------------------------------------------
// Send windows
// ---------------------------------------------------------------------------

/** Minutes after local midnight, `[from, to)`; null means that day is closed. */
export type DayWindow = [number, number] | null;

export interface SendWindows {
  /** Index 0 is Sunday. */
  days: DayWindow[];
  /** Local dates (YYYY-MM-DD) with no sending: public holidays. */
  blackout: string[];
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

function minutes(value: string): number | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h >= 0 && h <= 24 && m >= 0 && m < 60 && h * 60 + m <= 1440 ? h * 60 + m : null;
}

function parseRange(value: unknown, fallback: DayWindow): DayWindow {
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === "") return fallback;
  if (text === "off" || text === "closed" || text === "none") return null;
  const [from, to] = text.split(/\s*-\s*/);
  const a = from ? minutes(from) : null;
  const b = to ? minutes(to) : null;
  return a != null && b != null && a < b ? [a, b] : fallback;
}

export const DEFAULT_SEND_WINDOWS: SendWindows = {
  days: [null, [480, 1200], [480, 1200], [480, 1200], [480, 1200], [480, 1200], [540, 780]],
  blackout: [],
};

/**
 * The send windows from the `messaging` settings: `weekdays` ("08:00-20:00"),
 * `saturday` ("09:00-13:00" or "off"), `sunday` ("off"), `blackoutDates` (dates,
 * separated by commas or new lines). A value that does not parse keeps the default.
 */
export function parseSendWindows(messaging: Record<string, unknown> | null | undefined): SendWindows {
  const m = messaging ?? {};
  const weekdays = parseRange(m.weekdays, DEFAULT_SEND_WINDOWS.days[1]!);
  const saturday = parseRange(m.saturday, DEFAULT_SEND_WINDOWS.days[6]!);
  const sunday = parseRange(m.sunday, null);
  const blackout = String(m.blackoutDates ?? "")
    .split(/[\s,;]+/)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  return { days: [sunday, weekdays, weekdays, weekdays, weekdays, weekdays, saturday], blackout };
}

const DEFAULT_TZ = "Africa/Johannesburg";
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      f = formatter(DEFAULT_TZ);
    }
    formatters.set(tz, f);
  }
  return f;
}

/** The local weekday (0 = Sunday), minutes after midnight and date of an instant in a time zone. */
export function localParts(at: Date, tz: string): { weekday: number; minutes: number; date: string } {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(at)) parts[part.type] = part.value;
  return {
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function isInSendWindow(at: Date, tz: string, windows: SendWindows = DEFAULT_SEND_WINDOWS): boolean {
  const local = localParts(at, tz);
  if (windows.blackout.includes(local.date)) return false;
  const day = windows.days[local.weekday];
  return Boolean(day && local.minutes >= day[0] && local.minutes < day[1]);
}

/**
 * The first minute at or after `at` when sending is allowed, or null when the
 * windows never open in the next 8 days (every day closed). Steps by the minute,
 * so a window edge is exact in any time zone.
 */
export function nextSendWindow(at: Date, tz: string, windows: SendWindows = DEFAULT_SEND_WINDOWS): Date | null {
  const start = Math.floor(at.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= 8 * 1440; i += 1) {
    const candidate = new Date(start + i * 60_000);
    if (isInSendWindow(candidate, tz, windows)) return i === 0 ? at : candidate;
  }
  return null;
}

/** "Mon-Fri 08:00-20:00, Sat 09:00-13:00, Sun closed" for the approver and the Setup page. */
export function describeWindows(windows: SendWindows): string {
  const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const groups: Array<{ first: string; last: string; text: string }> = [];
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const w = windows.days[day];
    const text = w ? `${hhmm(w[0])}-${hhmm(w[1])}` : "closed";
    const previous = groups[groups.length - 1];
    if (previous && previous.text === text) previous.last = names[day]!;
    else groups.push({ first: names[day]!, last: names[day]!, text });
  }
  const list = groups.map((g) => `${g.first === g.last ? g.first : `${g.first}-${g.last}`} ${g.text}`).join(", ");
  return `${list}${windows.blackout.length ? `; no sending on ${windows.blackout.join(", ")}` : ""}`;
}
