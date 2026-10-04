/** Calendar days as `YYYY-MM-DD` text. No timezone maths beyond `todayIn`: ad platforms already report days in the account's own timezone. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value) && Number(value.slice(5)) >= 1 && Number(value.slice(5)) <= 12;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** The calendar day in an IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The ISO week of a day, `2026-W40`, for alerts that should repeat at most weekly. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** ISO text from a driver value (a Date, or Postgres text); null when unreadable. */
export function isoTime(value: unknown): string | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** `YYYY-MM-DD` from a driver value (a `date` column arrives as an ISO string or Date). */
export function dayOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" && DAY_RE.test(value.slice(0, 10))) return value.slice(0, 10);
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
