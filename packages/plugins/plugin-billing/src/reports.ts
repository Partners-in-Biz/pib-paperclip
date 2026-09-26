/**
 * Operational reports in the reporting currency (ZAR by default): revenue
 * by month and client, aged debtors and creditors, client value, expense
 * summary and MRR. Foreign documents convert at their own rate (issue or
 * payment) or the latest stored daily rate.
 *
 * Old-system bugs not copied: ageing uses what is still owed (partly paid
 * invoices included, not their full total); revenue and client value use
 * money actually received, not invoice totals.
 */
import { monthlyMinor } from "./money.js";

export type Convert = (amountMinor: number, currency: string, rate?: number | null) => number | null;

export function converterFor(book: string, latest: Record<string, number | null>): Convert {
  return (amountMinor, currency, rate) => {
    if (currency === book) return amountMinor;
    const r = rate ?? latest[currency] ?? null;
    return r == null || !Number.isFinite(r) ? null : Math.round(amountMinor * r);
  };
}

export const AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Days past due → bucket. Not yet due (or no due date) counts as 0-30. */
export function ageBucket(daysPastDue: number): AgeBucket {
  if (daysPastDue <= 30) return "0-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

export interface AgeingItem {
  id: string;
  number: string;
  party: string;
  partyKey: string;
  currency: string;
  outstandingMinor: number;
  dueAt: string | null;
  fxRate?: number | null;
}

export interface AgeingReport {
  currency: string;
  buckets: Record<AgeBucket, { count: number; amountMinor: number }>;
  totalMinor: number;
  count: number;
  unconverted: number;
  parties: Array<{ party: string; partyKey: string; totalMinor: number } & Record<AgeBucket, number>>;
}

function daysPast(dueAt: string | null, now: Date): number {
  const due = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (!Number.isFinite(due)) return 0;
  return Math.floor((now.getTime() - due) / 86_400_000);
}

export function ageing(items: AgeingItem[], now: Date, book: string, convert: Convert): AgeingReport {
  const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, amountMinor: 0 }])) as AgeingReport["buckets"];
  const parties = new Map<string, AgeingReport["parties"][number]>();
  let totalMinor = 0;
  let count = 0;
  let unconverted = 0;
  for (const item of items) {
    if (item.outstandingMinor <= 0) continue;
    const amount = convert(item.outstandingMinor, item.currency, item.fxRate);
    if (amount == null) {
      unconverted += 1;
      continue;
    }
    const bucket = ageBucket(daysPast(item.dueAt, now));
    buckets[bucket].count += 1;
    buckets[bucket].amountMinor += amount;
    totalMinor += amount;
    count += 1;
    const party = parties.get(item.partyKey) ?? { party: item.party, partyKey: item.partyKey, totalMinor: 0, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    party[bucket] += amount;
    party.totalMinor += amount;
    parties.set(item.partyKey, party);
  }
  return { currency: book, buckets, totalMinor, count, unconverted, parties: [...parties.values()].sort((a, b) => b.totalMinor - a.totalMinor) };
}

export interface RevenueInvoice {
  id: string;
  status: string;
  currency: string;
  sentAt: string | null;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  fxRate?: number | null;
  clientKey: string;
  clientName: string;
}

export interface RevenuePayment {
  invoiceId: string;
  currency: string;
  paidAt: string;
  allocatedMinor: number;
  fxRate?: number | null;
  clientKey: string;
  clientName: string;
}

function month(value: string): string {
  return value.slice(0, 7);
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  for (let d = start; d <= end && out.length < 120; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) out.push(d.toISOString().slice(0, 7));
  return out;
}

/** Invoiced (excl. VAT, by send month) and collected (by payment month). Cancelled and draft invoices are left out. */
export function revenueByMonth(input: { invoices: RevenueInvoice[]; payments: RevenuePayment[]; from: string; to: string; book: string; convert: Convert }) {
  const rows = new Map(monthsBetween(input.from, input.to).map((m) => [m, { month: m, invoicedMinor: 0, vatMinor: 0, collectedMinor: 0, invoices: 0 }]));
  let unconverted = 0;
  for (const invoice of input.invoices) {
    if (!invoice.sentAt || invoice.status === "draft" || invoice.status === "cancelled") continue;
    const row = rows.get(month(invoice.sentAt));
    if (!row) continue;
    const net = input.convert(invoice.subtotalMinor, invoice.currency, invoice.fxRate);
    const vat = input.convert(invoice.vatMinor, invoice.currency, invoice.fxRate);
    if (net == null || vat == null) {
      unconverted += 1;
      continue;
    }
    row.invoicedMinor += net;
    row.vatMinor += vat;
    row.invoices += 1;
  }
  for (const payment of input.payments) {
    const row = rows.get(month(payment.paidAt));
    if (!row) continue;
    const amount = input.convert(payment.allocatedMinor, payment.currency, payment.fxRate);
    if (amount == null) {
      unconverted += 1;
      continue;
    }
    row.collectedMinor += amount;
  }
  const months = [...rows.values()];
  return {
    currency: input.book,
    months,
    invoicedMinor: months.reduce((a, m) => a + m.invoicedMinor, 0),
    collectedMinor: months.reduce((a, m) => a + m.collectedMinor, 0),
    unconverted,
  };
}

export interface ClientBalanceInput {
  clientKey: string;
  clientName: string;
  currency: string;
  status: string;
  sentAt: string | null;
  subtotalMinor: number;
  outstandingMinor: number;
  fxRate?: number | null;
}

/** Per client: invoiced (excl. VAT) in the window, collected, outstanding now, last paid, lifetime paid. */
export function revenueByClient(input: { invoices: ClientBalanceInput[]; payments: RevenuePayment[]; from: string; to: string; book: string; convert: Convert }) {
  const map = new Map<string, { clientKey: string; clientName: string; invoicedMinor: number; collectedMinor: number; outstandingMinor: number; lifetimePaidMinor: number; invoices: number; lastPaidAt: string | null }>();
  const row = (key: string, name: string) => {
    const existing = map.get(key) ?? { clientKey: key, clientName: name, invoicedMinor: 0, collectedMinor: 0, outstandingMinor: 0, lifetimePaidMinor: 0, invoices: 0, lastPaidAt: null };
    if (!existing.clientName && name) existing.clientName = name;
    map.set(key, existing);
    return existing;
  };
  const inWindow = (value: string | null) => Boolean(value) && value!.slice(0, 10) >= input.from.slice(0, 10) && value!.slice(0, 10) <= input.to.slice(0, 10);
  for (const invoice of input.invoices) {
    if (invoice.status === "draft" || invoice.status === "cancelled") continue;
    const r = row(invoice.clientKey, invoice.clientName);
    r.invoices += 1;
    const outstanding = input.convert(invoice.outstandingMinor, invoice.currency, invoice.fxRate);
    if (outstanding != null) r.outstandingMinor += outstanding;
    if (inWindow(invoice.sentAt)) {
      const net = input.convert(invoice.subtotalMinor, invoice.currency, invoice.fxRate);
      if (net != null) r.invoicedMinor += net;
    }
  }
  for (const payment of input.payments) {
    const r = row(payment.clientKey, payment.clientName);
    const amount = input.convert(payment.allocatedMinor, payment.currency, payment.fxRate);
    if (amount == null) continue;
    r.lifetimePaidMinor += amount;
    if (inWindow(payment.paidAt)) r.collectedMinor += amount;
    if (!r.lastPaidAt || payment.paidAt > r.lastPaidAt) r.lastPaidAt = payment.paidAt;
  }
  return { currency: input.book, clients: [...map.values()].sort((a, b) => b.lifetimePaidMinor - a.lifetimePaidMinor || b.invoicedMinor - a.invoicedMinor) };
}

export interface ExpenseItem {
  category: string;
  currency: string;
  amountMinor: number;
  vatMinor: number;
  vatClaimable: boolean;
  date: string | null;
  fxRate?: number | null;
  source: "expense" | "bill";
}

export function expenseSummary(input: { items: ExpenseItem[]; from: string; to: string; book: string; convert: Convert }) {
  const map = new Map<string, { category: string; totalMinor: number; vatClaimableMinor: number; count: number; bills: number }>();
  let unconverted = 0;
  for (const item of input.items) {
    const date = (item.date ?? "").slice(0, 10);
    if (!date || date < input.from.slice(0, 10) || date > input.to.slice(0, 10)) continue;
    const amount = input.convert(item.amountMinor, item.currency, item.fxRate);
    const vat = input.convert(item.vatClaimable ? item.vatMinor : 0, item.currency, item.fxRate);
    if (amount == null || vat == null) {
      unconverted += 1;
      continue;
    }
    const row = map.get(item.category) ?? { category: item.category, totalMinor: 0, vatClaimableMinor: 0, count: 0, bills: 0 };
    row.totalMinor += amount;
    row.vatClaimableMinor += vat;
    row.count += 1;
    if (item.source === "bill") row.bills += 1;
    map.set(item.category, row);
  }
  const categories = [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor);
  return {
    currency: input.book,
    categories,
    totalMinor: categories.reduce((a, c) => a + c.totalMinor, 0),
    vatClaimableMinor: categories.reduce((a, c) => a + c.vatClaimableMinor, 0),
    unconverted,
  };
}

export interface RecurringRevenue {
  status: "active" | "paused" | "cancelled";
  priceMinor: number;
  currency: string;
  period: string;
  startedAt: string;
  cancelledAt: string | null;
}

/** MRR/ARR from active retainers (and recurring schedules), plus new, churned and churn rate over 30 days. */
export function mrrMetrics(input: { items: RecurringRevenue[]; now: Date; book: string; convert: Convert }) {
  const windowStart = input.now.getTime() - 30 * 86_400_000;
  let mrrMinor = 0;
  let newMinor = 0;
  let churnedMinor = 0;
  let active = 0;
  let activeAtStart = 0;
  let churned = 0;
  let unconverted = 0;
  for (const item of input.items) {
    const monthly = input.convert(monthlyMinor(item.priceMinor, item.period), item.currency);
    if (monthly == null) {
      unconverted += 1;
      continue;
    }
    const started = Date.parse(item.startedAt);
    const cancelled = item.cancelledAt ? Date.parse(item.cancelledAt) : null;
    if (item.status === "active") {
      mrrMinor += monthly;
      active += 1;
      if (Number.isFinite(started) && started >= windowStart) newMinor += monthly;
    }
    if (cancelled != null && Number.isFinite(cancelled) && cancelled >= windowStart && cancelled <= input.now.getTime()) {
      churnedMinor += monthly;
      churned += 1;
    }
    if (Number.isFinite(started) && started < windowStart && (cancelled == null || cancelled >= windowStart)) activeAtStart += 1;
  }
  return {
    currency: input.book,
    mrrMinor,
    arrMinor: mrrMinor * 12,
    active,
    newMrrMinor: newMinor,
    churnedMrrMinor: churnedMinor,
    churned,
    churnRate: activeAtStart > 0 ? churned / activeAtStart : 0,
    unconverted,
  };
}
