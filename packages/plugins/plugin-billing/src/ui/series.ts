/**
 * Chart series and status tones for the Billing pages (pure, no React), so
 * they can be unit tested. Money stays in minor units until it is shown.
 */
import type { Invoice, Snapshot } from "./types.js";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/**
 * One status → tone mapping for every Billing list:
 * green done / paid / active, amber pending / checking, red failed / overdue,
 * blue draft / sent / scheduled, grey cancelled / void.
 */
const STATUS_TONE: Record<string, Tone> = {
  paid: "ok",
  accepted: "ok",
  converted: "ok",
  confirmed: "ok",
  recorded: "ok",
  active: "ok",
  posted: "ok",
  applied: "ok",
  issued: "ok",
  approved: "info",
  draft: "info",
  sent: "info",
  viewed: "info",
  queued: "info",
  running: "info",
  pending: "warn",
  payment_pending_verification: "warn",
  partially_paid: "warn",
  due: "warn",
  review: "warn",
  overdue: "bad",
  failed: "bad",
  rejected: "bad",
  declined: "bad",
  written_off: "bad",
  cancelled: "neutral",
  void: "neutral",
  expired: "neutral",
  paused: "neutral",
  archived: "neutral",
};

export function statusTone(status: string | null | undefined): Tone {
  return STATUS_TONE[String(status ?? "")] ?? "neutral";
}

export const OPEN_STATUSES = new Set(["sent", "viewed", "overdue", "partially_paid", "payment_pending_verification"]);

export function isOverdue(invoice: Invoice, now = Date.now()): boolean {
  if (!OPEN_STATUSES.has(invoice.status) || (invoice.outstandingMinor ?? 0) <= 0) return false;
  return invoice.status === "overdue" || (Boolean(invoice.dueAt) && Date.parse(invoice.dueAt!) < now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last `count` months as `YYYY-MM`, oldest first, ending with the month of `now` (UTC). */
export function lastMonths(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1)).toISOString().slice(0, 7));
}

/** `2026-09` → `Sep` (axis) and `Sep 2026` (tooltip). */
export function monthLabel(month: string): { label: string; title: string } {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? month;
  return { label: name, title: `${name} ${y}` };
}

/** "+12% vs last month" style change, or null when there is nothing to compare. */
export function percentDelta(current: number, previous: number, suffix = "vs last month"): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}% ${suffix}`;
}

export interface StatusCount {
  status: string;
  count: number;
  tone: Tone;
}

/** Invoices per status, most first. */
export function invoiceStatusCounts(invoices: Invoice[]): StatusCount[] {
  const counts = new Map<string, number>();
  for (const invoice of invoices) counts.set(invoice.status, (counts.get(invoice.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => ({ status, count, tone: statusTone(status) })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export const AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
export type AgeBuckets = Record<AgeBucket, { count: number; amountMinor: number }>;

/** Tone per ageing bucket: 0-30 green, 31-60 amber, 61-90 and 90+ red (61-90 drawn a shade lighter). */
export const AGE_TONE: Record<AgeBucket, Tone> = { "0-30": "ok", "31-60": "warn", "61-90": "bad", "90+": "bad" };

/** What is still owed, per ageing bucket, for invoices in one currency (the client workspace has no report). */
export function invoiceAgeing(invoices: Invoice[], currency: string, now = Date.now()): AgeBuckets {
  const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, amountMinor: 0 }])) as AgeBuckets;
  for (const invoice of invoices) {
    const owed = invoice.outstandingMinor ?? 0;
    if (!OPEN_STATUSES.has(invoice.status) || owed <= 0 || invoice.currency !== currency) continue;
    const due = invoice.dueAt ? Date.parse(invoice.dueAt) : Number.NaN;
    const days = Number.isFinite(due) ? Math.floor((now - due) / 86_400_000) : 0;
    const bucket: AgeBucket = days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
    out[bucket].count += 1;
    out[bucket].amountMinor += owed;
  }
  return out;
}

/** Invoiced (by send month) and paid (by paid month) per month for one currency, from the page snapshot. */
export function invoiceMonths(invoices: Invoice[], months: string[], currency: string): Array<{ month: string; invoicedMinor: number; paidMinor: number }> {
  const rows = new Map(months.map((month) => [month, { month, invoicedMinor: 0, paidMinor: 0 }]));
  for (const invoice of invoices) {
    if (invoice.currency !== currency || invoice.status === "draft" || invoice.status === "cancelled") continue;
    const sent = invoice.sentAt ? rows.get(invoice.sentAt.slice(0, 7)) : undefined;
    if (sent) sent.invoicedMinor += invoice.totalMinor;
    const paid = invoice.paidAt ? rows.get(invoice.paidAt.slice(0, 7)) : undefined;
    if (paid) paid.paidMinor += invoice.paidMinor ?? invoice.totalMinor;
  }
  return [...rows.values()];
}

export interface ActivityEntry {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: Tone;
  kind: "sent" | "paid" | "pop" | "failed" | "bill" | "expense";
  invoiceId?: string;
}

/** Latest money events from the snapshot, newest first. */
export function billingActivity(snapshot: Snapshot, limit = 8): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const who = (invoice: Invoice) => invoice.customerName ?? invoice.customerRef;
  for (const invoice of snapshot.invoices) {
    if (invoice.paidAt && invoice.status === "paid") out.push({ id: `paid:${invoice.id}`, at: invoice.paidAt, title: `${invoice.number} paid`, detail: who(invoice), tone: "ok", kind: "paid", invoiceId: invoice.id });
    if (invoice.sentAt) {
      const failed = invoice.deliveryStatus === "failed";
      out.push({ id: `sent:${invoice.id}`, at: invoice.sentAt, title: failed ? `${invoice.number} email failed` : `${invoice.number} sent`, detail: who(invoice), tone: failed ? "bad" : "info", kind: failed ? "failed" : "sent", invoiceId: invoice.id });
    }
  }
  for (const pop of snapshot.pops ?? []) {
    if (!pop.receivedAt) continue;
    out.push({
      id: `pop:${pop.id}`,
      at: pop.receivedAt,
      title: pop.status === "pending" ? `Proof of payment to check${pop.invoiceNumber ? ` for ${pop.invoiceNumber}` : ""}` : `Proof of payment ${pop.status}${pop.invoiceNumber ? ` for ${pop.invoiceNumber}` : ""}`,
      detail: pop.fromName ?? pop.fromEmail ?? (pop.source === "email" ? "Email" : "Upload"),
      tone: pop.status === "pending" ? "warn" : statusTone(pop.status),
      kind: "pop",
      ...(pop.invoiceId ? { invoiceId: pop.invoiceId } : {}),
    });
  }
  return out.filter((e) => Number.isFinite(Date.parse(e.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
