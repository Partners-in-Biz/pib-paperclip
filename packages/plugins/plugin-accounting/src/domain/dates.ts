/**
 * Dates for people, in the same style as the UI kit's formatDate and
 * formatMonth (`28 Sep 2026`, `Sep 2026`), without React, so the worker (issue
 * text, setup steps) and the page share them. Tools keep returning
 * YYYY-MM-DD for agents; these are only for text a person reads.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parts(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `2026-09-28` (or an ISO timestamp, read as its UTC date) → `28 Sep 2026`; "" when it is not a date. */
export function dayLabel(value: string | null | undefined): string {
  const p = parts(value);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : "";
}

/** `2026-09` or `2026-09-01` → `Sep 2026`; "" when it is not a month. */
export function monthYearLabel(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return "";
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${match[1]}` : "";
}

/**
 * A period as people say it. Whole months: `Sep 2026`, `Sep–Oct 2026`,
 * `Dec 2025–Jan 2026`. Anything else: `1 Sep 2026 to 15 Oct 2026`.
 */
export function periodLabel(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  if (!a || !b) return [dayLabel(start) || start, dayLabel(end) || end].join(" to ");
  const wholeMonths = a.d === 1 && b.d === lastDay(b.y, b.m);
  if (!wholeMonths) return `${dayLabel(start)} to ${dayLabel(end)}`;
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${MONTHS[a.m - 1]}–${MONTHS[b.m - 1]} ${b.y}`;
  return `${MONTHS[a.m - 1]} ${a.y}–${MONTHS[b.m - 1]} ${b.y}`;
}

/**
 * Server sentences that carry ISO dates or months (`The period 2026-01 is
 * closed`, `locked 2026-07-01 to 2026-08-31`) written for people:
 * `Jan 2026`, `1 Jul 2026`.
 */
export function readableDates(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, (whole, _y, _m, _d, offset: number, all: string) => {
      // Leave ids and codes alone (a date inside a longer token).
      if (/[\w-]/.test(all[offset - 1] ?? "")) return whole;
      return dayLabel(whole) || whole;
    })
    .replace(/\b(\d{4})-(0[1-9]|1[0-2])\b(?!-\d)/g, (whole, _y, _m, offset: number, all: string) => {
      if (/[\w-]/.test(all[offset - 1] ?? "")) return whole;
      return monthYearLabel(whole) || whole;
    });
}
