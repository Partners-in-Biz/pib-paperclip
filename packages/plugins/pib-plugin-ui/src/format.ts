/**
 * Dates and short money, the same on every PiB page (browser-safe, no locale
 * surprises): dates as `28 Sep 2026` (never 9/28 or 2026-09-28 on screen),
 * short money for tiles and chart axes as `R 7.5k`.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

type DateInput = string | number | Date | null | undefined;

/** A date-only string (`YYYY-MM-DD`) stays that calendar day in every time zone. */
function toParts(value: DateInput): { y: number; m: number; d: number; date: Date | null } | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const only = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (only) return { y: Number(only[1]), m: Number(only[2]) - 1, d: Number(only[3]), date: null };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), date };
}

/** `28 Sep 2026`; `–` when empty or invalid. */
export function formatDate(value: DateInput): string {
  const p = toParts(value);
  return p ? `${p.d} ${MONTHS[p.m]} ${p.y}` : "–";
}

/** `28 Sep` (the year only when it is not this year: `28 Sep 2025`). */
export function formatShortDate(value: DateInput, now: Date = new Date()): string {
  const p = toParts(value);
  if (!p) return "–";
  return p.y === now.getFullYear() ? `${p.d} ${MONTHS[p.m]}` : `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

/** `28 Sep 2026, 14:05` in the viewer's time; a date-only value shows just the date. */
export function formatDateTime(value: DateInput): string {
  const p = toParts(value);
  if (!p) return "–";
  if (!p.date) return formatDate(value);
  const hh = String(p.date.getHours()).padStart(2, "0");
  const mm = String(p.date.getMinutes()).padStart(2, "0");
  return `${p.d} ${MONTHS[p.m]} ${p.y}, ${hh}:${mm}`;
}

/** `Sep 2026` for a month (`2026-09`, `2026-09-01` or a date). */
export function formatMonth(value: DateInput): string {
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value.trim())) value = `${value.trim()}-01`;
  const p = toParts(value);
  return p ? `${MONTHS[p.m]} ${p.y}` : "–";
}

const SHORT_SYMBOLS: Record<string, string> = { ZAR: "R ", USD: "$", EUR: "€", GBP: "£" };

function trimmed(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/**
 * Short money for tiles, chart axes and tight spaces: `R 950`, `R 7.5k`,
 * `R 12.3k`, `R 1.2m` (one decimal at most, dot decimal). Use `formatMoney`
 * wherever the exact amount matters.
 */
export function formatMoneyCompact(minor: number, currency = "ZAR"): string {
  if (!Number.isFinite(minor)) return "–";
  const value = Math.abs(minor) / 100;
  const symbol = SHORT_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const text = value >= 1_000_000 ? `${trimmed(value / 1_000_000)}m` : value >= 1000 ? `${trimmed(value / 1000)}k` : String(Math.round(value));
  return `${minor < 0 ? "-" : ""}${symbol}${text}`;
}
