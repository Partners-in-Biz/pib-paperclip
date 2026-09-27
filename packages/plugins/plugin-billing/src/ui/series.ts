/**
 * Chart series and status tones for the Billing pages (pure, no React), so
 * they can be unit tested. Money stays in minor units until it is shown.
 */
import type { FuturePayment, Invoice, Snapshot } from "./types.js";

/** The page's money formatter (`formatMoney` from the UI kit); passed in so this file stays pure. */
export type MoneyText = (minor: number, currency: string) => string;
/** The page's date formatter (`formatShortDate`). */
export type DayText = (value: string | null) => string;

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/**
 * How a person sees an invoice or quote: an issued one by its number, a
 * draft as "Draft · Northwind · R 1,500.00" (its number means nothing until
 * it is sent, and older drafts carry codes like INV-9F0D9A85).
 */
export function documentLabel(doc: { status: string; number: string; customerName?: string | null; customerRef: string; totalMinor: number; currency: string }, money: MoneyText): string {
  if (doc.status !== "draft") return doc.number;
  return `Draft · ${doc.customerName ?? doc.customerRef} · ${money(doc.totalMinor, doc.currency)}`;
}

/** "1 payment dated in the future (28 Sep): it counts from that day. Check the date." */
export function futurePaymentsText(list: FuturePayment[], day: DayText): string | null {
  const count = list.reduce((sum, p) => sum + (p.count || 1), 0);
  if (!count) return null;
  const first = list.map((p) => p.paidAt).filter((d): d is string => Boolean(d)).sort()[0];
  return `${count} payment${count === 1 ? "" : "s"} dated in the future${first ? ` (${day(first)})` : ""}: ${count === 1 ? "it counts" : "they count"} in no total until then. Check the date.`;
}

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
    if (invoice.paidAt && invoice.status === "paid" && !(invoice.futurePaidMinor ?? 0)) out.push({ id: `paid:${invoice.id}`, at: invoice.paidAt, title: `${invoice.number} paid`, detail: who(invoice), tone: "ok", kind: "paid", invoiceId: invoice.id });
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

// ── Waiting on a person, drafts to send ────────────────────────────────────

export interface WaitingEntry {
  key: string;
  /** send: an email to approve; money: a payment, credit or bill; check: a proof of payment or bank match. */
  kind: "send" | "money" | "check";
  title: string;
  issueId: string | null;
  invoiceId?: string;
  quoteId?: string;
}

/**
 * What waits on a person, from the page snapshot: send approvals (invoices,
 * quotes, reminders), money decisions (payments, credit notes, bills) and
 * checks (proofs of payment, bank matches). Money first, then checks, then sends.
 */
export function waitingOnPerson(snapshot: Snapshot, money: MoneyText): WaitingEntry[] {
  const out: WaitingEntry[] = [];
  const who = (name: string | null | undefined, ref: string) => name ?? ref;
  for (const invoice of snapshot.invoices) {
    if (!invoice.pendingAction || !invoice.approvalIssueId || invoice.shared) continue;
    // A draft has no number worth showing yet: name the client and the amount.
    out.push(invoice.pendingAction === "pay"
      ? { key: `approval:${invoice.approvalIssueId}`, kind: "money", title: `Confirm payment of ${invoice.number} (${who(invoice.customerName, invoice.customerRef)})`, issueId: invoice.approvalIssueId, invoiceId: invoice.id }
      : { key: `approval:${invoice.approvalIssueId}`, kind: "send", title: `Approve sending invoice to ${who(invoice.customerName, invoice.customerRef)} (${money(invoice.totalMinor, invoice.currency)})`, issueId: invoice.approvalIssueId, invoiceId: invoice.id });
  }
  for (const quote of snapshot.quotes ?? []) {
    if (quote.pendingAction !== "send" || !quote.approvalIssueId) continue;
    out.push({ key: `approval:${quote.approvalIssueId}`, kind: "send", title: `Approve sending quote to ${who(quote.customerName, quote.customerRef)} (${money(quote.totalMinor, quote.currency)})`, issueId: quote.approvalIssueId, quoteId: quote.id });
  }
  for (const bill of snapshot.bills ?? []) {
    if (bill.pendingAction !== "approve" || !bill.approvalIssueId) continue;
    out.push({ key: `approval:${bill.approvalIssueId}`, kind: "money", title: `Approve the bill from ${bill.supplierName}`, issueId: bill.approvalIssueId });
  }
  for (const pop of snapshot.pops ?? []) {
    if (pop.status !== "pending") continue;
    out.push({ key: `pop:${pop.id}`, kind: "check", title: pop.invoiceNumber ? `Check the payment for ${pop.invoiceNumber}` : "Match a proof of payment to an invoice", issueId: pop.issueId, ...(pop.invoiceId ? { invoiceId: pop.invoiceId } : {}) });
  }
  for (const decision of snapshot.decisions ?? []) {
    if (decision.kind === "pop") continue; // listed from the proofs of payment above
    const kind: WaitingEntry["kind"] = decision.kind === "reminder" ? "send" : decision.kind === "bank_match" ? "check" : "money";
    out.push({ key: `decision:${decision.issueId}`, kind, title: decision.kind === "reminder" ? `Approve: ${decision.title.charAt(0).toLowerCase()}${decision.title.slice(1)}` : decision.title, issueId: decision.issueId, ...(decision.invoiceId ? { invoiceId: decision.invoiceId } : {}) });
  }
  const order = { money: 0, check: 1, send: 2 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

export interface DraftEntry {
  kind: "invoice" | "quote";
  id: string;
  number: string;
  who: string;
  totalMinor: number;
  currency: string;
  createdAt: string | null;
  /** Older than a day: on the Account Manager's "Drafts to send" issue. */
  stale: boolean;
  note: string | null;
}

/** Drafts nobody asked to send yet (and accepted quotes not invoiced), oldest first. */
export function draftsToSend(snapshot: Snapshot, now = Date.now()): DraftEntry[] {
  const templates = new Set((snapshot.recurring ?? []).filter((r) => r.isActive).map((r) => r.templateInvoiceId));
  const stale = (at: string | null | undefined) => Boolean(at) && now - Date.parse(at!) > 86_400_000;
  const out: DraftEntry[] = [];
  for (const invoice of snapshot.invoices) {
    if (invoice.status !== "draft" || invoice.pendingAction || invoice.deliveryStatus === "queued" || invoice.shared || templates.has(invoice.id)) continue;
    const note = invoice.subscriptionId ? "Retainer" : invoice.recurringId ? "Recurring" : invoice.quoteId ? "From a quote" : invoice.totalMinor <= 0 ? "No lines yet" : invoice.approvalIssueId ? "Send was turned down" : null;
    out.push({ kind: "invoice", id: invoice.id, number: invoice.number, who: invoice.customerName ?? invoice.customerRef, totalMinor: invoice.totalMinor, currency: invoice.currency, createdAt: invoice.createdAt ?? null, stale: stale(invoice.createdAt), note });
  }
  for (const quote of snapshot.quotes ?? []) {
    const accepted = quote.status === "accepted" && !quote.convertedInvoiceId;
    if (!accepted && (quote.status !== "draft" || quote.pendingAction || quote.deliveryStatus === "queued")) continue;
    out.push({ kind: "quote", id: quote.id, number: quote.number, who: quote.customerName ?? quote.customerRef, totalMinor: quote.totalMinor, currency: quote.currency, createdAt: quote.createdAt ?? null, stale: stale(accepted ? quote.acceptedAt ?? quote.createdAt : quote.createdAt), note: accepted ? "Accepted: convert to an invoice" : quote.totalMinor <= 0 ? "No lines yet" : null });
  }
  return out.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "") || a.number.localeCompare(b.number));
}
