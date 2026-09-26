/** Helpers for the Accounting Overview charts (pure, no React). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09` → `Sep` (axis) and `Sep 2026` (tooltip). */
export function monthLabel(month: string): { label: string; title: string } {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? month;
  return { label: name, title: `${name} ${y}` };
}

/** Change against the previous value as text ("+R 1 200 vs last month"), or null. */
export function changeText(current: number, previous: number | undefined, format: (minor: number) => string, suffix = "vs last month"): string | null {
  if (previous === undefined || !Number.isFinite(previous) || current === previous) return null;
  const diff = current - previous;
  return `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))} ${suffix}`;
}

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface VatCountdown {
  /** Days until the return is due (negative when late). */
  daysLeft: number;
  /** Share of the time from period start to due date that has passed (0–1). */
  elapsed: number;
  tone: "ok" | "warn" | "bad" | "info";
  text: string;
}

/** How close the VAT201 is to its due date: blue while the period runs, amber in the last 14 days, red when late. */
export function vatCountdown(period: { start: string; end: string; dueDate: string }, today: string): VatCountdown {
  const total = Math.max(1, days(period.start, period.dueDate));
  const daysLeft = days(today, period.dueDate);
  const elapsed = Math.min(1, Math.max(0, days(period.start, today) / total));
  const open = today <= period.end;
  const tone = daysLeft < 0 ? "bad" : open ? "info" : daysLeft <= 14 ? "warn" : "ok";
  const text = daysLeft < 0 ? `${-daysLeft} day${daysLeft === -1 ? "" : "s"} late` : daysLeft === 0 ? "Due today" : `Due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  return { daysLeft, elapsed, tone, text };
}
