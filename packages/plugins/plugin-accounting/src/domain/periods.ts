/**
 * Financial years, accounting periods (months) and SARS VAT periods.
 *
 * VAT categories (VAT Act s27; SARS "VAT 404 Guide for Vendors", tax periods):
 * - A: two months ending on the last day of Jan, Mar, May, Jul, Sep, Nov.
 * - B: two months ending on the last day of Feb, Apr, Jun, Aug, Oct, Dec.
 * - C: one month.
 * - D: six months ending on the last day of Feb and Aug.
 * - E: twelve months ending on the last day of the financial year.
 */
import { addMonths, AccountingError, firstDayOfMonth, lastDayOfMonth, monthOf } from "./util.js";

export const VAT_CATEGORIES = ["A", "B", "C", "D", "E", "none"] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

export const PERIOD_STATUSES = ["open", "soft_closed", "closed"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export interface DateRange {
  start: string;
  end: string;
}

export function parseVatCategory(value: unknown): VatCategory {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (v === "MONTHLY") return "C";
  if (v === "BI-MONTHLY" || v === "BIMONTHLY") return "B";
  if ((VAT_CATEGORIES as readonly string[]).includes(v)) return v as VatCategory;
  if (v === "NONE" || v === "") return "none";
  throw new AccountingError(`Unknown VAT category ${String(value)}. Use A, B, C, D, E or none.`);
}

export function parseYearEndMonth(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 12) return 2;
  return n;
}

/** The financial year that contains `date` (year-end month 1–12, e.g. 2 = February). */
export function financialYear(date: string, yearEndMonth: number): DateRange {
  const [y, m] = monthOf(date).split("-").map(Number) as [number, number];
  const endYear = m > yearEndMonth ? y + 1 : y;
  const endMonth = `${endYear}-${String(yearEndMonth).padStart(2, "0")}`;
  const startMonth = addMonths(endMonth, -11);
  return { start: firstDayOfMonth(startMonth), end: lastDayOfMonth(endMonth) };
}

/** End months of each VAT period in a calendar year for a category. */
function endMonths(category: VatCategory, yearEndMonth: number): number[] {
  switch (category) {
    case "A":
      return [1, 3, 5, 7, 9, 11];
    case "B":
      return [2, 4, 6, 8, 10, 12];
    case "C":
      return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    case "D":
      return [2, 8];
    case "E":
      return [yearEndMonth];
    default:
      return [];
  }
}

function lengthMonths(category: VatCategory): number {
  return category === "A" || category === "B" ? 2 : category === "C" ? 1 : category === "D" ? 6 : 12;
}

/** The VAT period containing `date`, or null when the business is not VAT-registered. */
export function vatPeriodFor(date: string, category: VatCategory, yearEndMonth = 2): DateRange | null {
  if (category === "none") return null;
  const ends = endMonths(category, yearEndMonth);
  const month = monthOf(date);
  // Walk forward from the date's month to the first month that ends a period.
  for (let i = 0; i < 12; i += 1) {
    const candidate = addMonths(month, i);
    const m = Number(candidate.slice(5, 7));
    if (ends.includes(m)) {
      const start = addMonths(candidate, -(lengthMonths(category) - 1));
      return { start: firstDayOfMonth(start), end: lastDayOfMonth(candidate) };
    }
  }
  return null;
}

/** VAT periods overlapping [from, to], oldest first. */
export function vatPeriodsBetween(from: string, to: string, category: VatCategory, yearEndMonth = 2): DateRange[] {
  const out: DateRange[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < 400) {
    const period = vatPeriodFor(cursor, category, yearEndMonth);
    if (!period) break;
    out.push(period);
    cursor = firstDayOfMonth(addMonths(monthOf(period.end), 1));
    guard += 1;
  }
  return out;
}

/** Previous period of the same length (for "this vs previous" comparisons). */
export function previousRange(range: DateRange): DateRange {
  const months = monthSpan(range);
  const startMonth = addMonths(monthOf(range.start), -months);
  const endMonth = addMonths(monthOf(range.end), -months);
  return { start: firstDayOfMonth(startMonth), end: lastDayOfMonth(endMonth) };
}

export function sameRangeLastYear(range: DateRange): DateRange {
  return {
    start: firstDayOfMonth(addMonths(monthOf(range.start), -12)),
    end: lastDayOfMonth(addMonths(monthOf(range.end), -12)),
  };
}

export function monthSpan(range: DateRange): number {
  const [ys, ms] = monthOf(range.start).split("-").map(Number) as [number, number];
  const [ye, me] = monthOf(range.end).split("-").map(Number) as [number, number];
  return (ye - ys) * 12 + (me - ms) + 1;
}

export function monthRange(month: string): DateRange {
  return { start: firstDayOfMonth(month), end: lastDayOfMonth(month) };
}

// ---------------------------------------------------------------------------
// When the books start
// ---------------------------------------------------------------------------

/** Where the start date comes from: opening balances, the earliest journal, or the day the book was set up. */
export type BooksStartSource = "cutover" | "first_journal" | "set_up";

export interface BooksStart {
  /** The first day these books cover (YYYY-MM-DD). */
  date: string;
  from: BooksStartSource;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The first day these books cover, worked out in one place for the page and
 * the agent tools:
 * - with opening balances, the day after the cut-over date (the opening
 *   journal holds the previous books' closing balances at the end of that
 *   day, so everything up to it was kept in the previous books);
 * - else the date of the earliest journal;
 * - else the day the book was set up (a timestamp is read as its UTC date).
 * Null when none is known (no book yet).
 */
export function booksStart(input: { cutoverDate?: string | null; firstJournalDate?: string | null; seededAt?: string | null }): BooksStart | null {
  const cutover = utcDay(input.cutoverDate);
  if (cutover) return { date: nextDay(cutover), from: "cutover" };
  const first = utcDay(input.firstJournalDate);
  if (first) return { date: first, from: "first_journal" };
  const seeded = utcDay(input.seededAt);
  return seeded ? { date: seeded, from: "set_up" } : null;
}

/**
 * YYYY-MM-DD of a date or a timestamp. A timestamp (`2026-09-28 00:01:12+02`,
 * as Postgres writes timestamptz, or ISO) is read as its UTC day, like
 * `todayIso()`. Null when it is not a date.
 */
function utcDay(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

/**
 * VAT periods these books can file: none that ended before the books start
 * (their VAT201 came from the previous books), except a period that already
 * has a return here (`keep`). Order is kept.
 */
export function vatPeriodsInBooks<T extends DateRange>(periods: T[], start: string | null | undefined, keep: (period: T) => boolean = () => false): T[] {
  if (!start) return periods;
  return periods.filter((p) => p.end >= start || keep(p));
}

/** True when a VAT period ended before the books start. */
export function endsBeforeBooks(period: DateRange, start: string | null | undefined): boolean {
  return Boolean(start) && period.end < String(start);
}
