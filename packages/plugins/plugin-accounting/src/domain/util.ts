/** Errors a person can act on. `code` lets callers tell rejections apart. */
export type AccountingErrorCode =
  | "invalid"
  | "unbalanced"
  | "unknown_role"
  | "unknown_account"
  | "inactive_account"
  | "closed_period"
  | "vat_locked"
  | "fx_rate_required"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "not_configured";

export class AccountingError extends Error {
  constructor(message: string, readonly code: AccountingErrorCode = "invalid") {
    super(message);
    this.name = "AccountingError";
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function requireDate(value: unknown, field: string): string {
  if (!isIsoDate(value)) throw new AccountingError(`${field} must be a date written YYYY-MM-DD`);
  return value;
}

export function requireMonth(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new AccountingError(`${field} must be a month written YYYY-MM`);
  return value;
}

export function requireMinor(value: unknown, field: string, options: { allowNegative?: boolean; allowZero?: boolean } = {}): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new AccountingError(`${field} must be a whole number of cents`);
  if (!options.allowNegative && n < 0) throw new AccountingError(`${field} cannot be negative`);
  if (options.allowZero === false && n === 0) throw new AccountingError(`${field} cannot be zero`);
  return n;
}

/** Month key `YYYY-MM` of a date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function firstDayOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function addMonths(month: string, count: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + count;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Months from `a` to `b` inclusive, in order. */
export function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let m = a;
  let guard = 0;
  while (m <= b && guard < 1200) {
    out.push(m);
    m = addMonths(m, 1);
    guard += 1;
  }
  return out;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Lower-case letters and digits only, for reference matching. */
export function alnum(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function toMinor(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Deterministic JSON: sorted keys, no undefined or null members. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(compact(value));
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || item === null) continue;
      out[key] = compact(item);
    }
    return out;
  }
  return value;
}

export function formatRand(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Plain decimal for CSV exports (no thousands separator). */
export function decimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
