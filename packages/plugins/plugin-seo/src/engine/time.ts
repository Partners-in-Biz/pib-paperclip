/**
 * Calendar math in the company's timezone (default Africa/Johannesburg).
 * Dates are plain `YYYY-MM-DD` strings; arithmetic happens on UTC midnights so
 * DST never shifts a day.
 */

export const DEFAULT_TIMEZONE = "Africa/Johannesburg";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parts(now: Date, tz: string): Record<string, string> {
  const zone = validTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)) {
    out[part.type] = part.value;
  }
  return out;
}

/** Local calendar date (`YYYY-MM-DD`) of `now` in `tz`. */
export function localDate(now: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local hour (0–23) of `now` in `tz`. */
export function localHour(now: Date, tz: string = DEFAULT_TIMEZONE): number {
  const hour = Number(parts(now, tz).hour);
  return hour === 24 ? 0 : hour;
}

function toUtcMs(date: string): number {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Normalise a DB date/timestamp value to `YYYY-MM-DD` (or null). */
export function asDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  if (DATE_RE.test(text.slice(0, 10))) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Local date of a timestamp in `tz`. */
export function localDateOf(value: unknown, tz: string = DEFAULT_TIMEZONE): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return asDate(value);
  return localDate(date, tz);
}
