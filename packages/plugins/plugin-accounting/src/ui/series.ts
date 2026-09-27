/** Helpers for the Accounting page's charts and text (pure, no React). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A month number as its name: 2 → `February` (the financial year-end is stored as 1–12). "" when out of range. */
export function monthName(n: number | null | undefined): string {
  const i = Number(n);
  return Number.isInteger(i) && i >= 1 && i <= 12 ? MONTH_NAMES[i - 1]! : "";
}

/** The SARS VAT category in words, e.g. B → `Every two months, ending Feb, Apr, Jun, Aug, Oct and Dec`. */
export function vatCategoryText(category: string, yearEndMonth = 2): string {
  switch (category) {
    case "A":
      return "Every two months, ending Jan, Mar, May, Jul, Sep and Nov";
    case "B":
      return "Every two months, ending Feb, Apr, Jun, Aug, Oct and Dec";
    case "C":
      return "Every month";
    case "D":
      return "Every six months, ending Feb and Aug";
    case "E":
      return `Once a year, ending with the financial year in ${monthName(yearEndMonth) || "February"}`;
    default:
      return "Not registered for VAT";
  }
}

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

/** A VAT period as the VAT tab lists it (from `accounting.vat`). */
export interface VatPeriodLike {
  end: string;
  current: boolean;
  dueDate?: string;
  status: string;
}

/**
 * A VAT period's state for the owner: approved, waiting for approval, draft,
 * still running, to prepare, or late (not prepared after its due date).
 * `key` is also the tone key for `statusTone`.
 */
export function vatPeriodState(p: VatPeriodLike, today: string): { key: "locked" | "pending_approval" | "draft" | "running" | "not_prepared" | "late"; label: string } {
  if (p.status === "locked") return { key: "locked", label: "Approved" };
  if (p.status === "pending_approval") return { key: "pending_approval", label: "Waiting for approval" };
  if (p.status === "draft") return { key: "draft", label: p.current || today <= p.end ? "Draft (period still running)" : "Draft" };
  if (p.current || today <= p.end) return { key: "running", label: "Period still running" };
  if (p.dueDate && today > p.dueDate) return { key: "late", label: "Late: not prepared" };
  return { key: "not_prepared", label: "To prepare" };
}
