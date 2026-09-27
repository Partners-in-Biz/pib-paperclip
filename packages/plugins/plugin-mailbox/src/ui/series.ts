/**
 * Status tones and chart series for the Mailbox page (pure, no React).
 * Days are UTC, like the worker's `daily` counts.
 */
import type { ChartSeries, ColumnDatum, Segment, ToneName } from "@partnersinbiz/pib-plugin-ui";
import type { DailySeries } from "../daily.js";

export const CATEGORY_NAMES: Record<string, string> = {
  lead: "Lead",
  client: "Client",
  reply: "Reply",
  proof_of_payment: "Proof of payment",
  invoice_or_bill: "Invoice or bill",
  bank_statement: "Bank statement",
  support: "Support",
  newsletter: "Newsletter",
  notification: "Notification",
  spam: "Spam",
  personal: "Personal",
  other: "Other",
  untriaged: "Not triaged",
};

/** Triage chip tone per category: money and leads green, work to do amber, the rest grey or blue. */
export const CATEGORY_TONE: Record<string, ToneName> = {
  lead: "ok",
  proof_of_payment: "ok",
  client: "info",
  reply: "info",
  bank_statement: "info",
  invoice_or_bill: "warn",
  support: "warn",
  newsletter: "neutral",
  notification: "neutral",
  spam: "neutral",
  personal: "neutral",
  other: "neutral",
};

/** Series colour index per category (stable across charts); grey ones use the neutral tone. */
const CATEGORY_COLOR: Record<string, number | "neutral"> = {
  lead: 5,
  client: 0,
  reply: 7,
  proof_of_payment: 2,
  invoice_or_bill: 6,
  bank_statement: 7,
  support: 3,
  newsletter: 4,
  notification: 1,
  personal: 6,
  spam: "neutral",
  other: "neutral",
  untriaged: "neutral",
};

export function categoryColor(category: string): number | "neutral" {
  return CATEGORY_COLOR[category] ?? "neutral";
}

export function categoryTone(category: string | null | undefined): ToneName {
  return (category && CATEGORY_TONE[category]) || "neutral";
}

/** Gmail account → tone: connected green, needs reconnect red, the rest grey. */
export function accountTone(status: string, syncError?: string | null): ToneName {
  if (status === "needs_reconnect") return "bad";
  if (status === "connected") return syncError ? "warn" : "ok";
  return "neutral";
}

/** Send request → tone: sent green, failed red, waiting amber, sending blue. */
export function sendTone(status: string): ToneName {
  return status === "sent" ? "ok" : status === "failed" ? "bad" : status === "retrying" ? "warn" : status === "sending" ? "info" : "neutral";
}

/** Draft status → tone. */
export function draftTone(status: string): ToneName {
  return status === "sent" ? "ok" : status === "failed" ? "bad" : status === "draft" ? "info" : "neutral";
}

/** An account counts as syncing (pulse) when its last sync was within the sync interval. */
export function isSyncing(lastSyncAt: string | null | undefined, now: Date, withinMs = 3 * 60_000): boolean {
  if (!lastSyncAt) return false;
  const t = Date.parse(lastSyncAt);
  return Number.isFinite(t) && now.getTime() - t <= withinMs;
}

// ── Days ────────────────────────────────────────────────────────────────────

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function lastDays(now: Date, days: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Chart labels in the PiB date style ("14 Sep", like the UI kit's `formatShortDate`), never US month/day. */
export function dayLabels(date: string): { label: string; title: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return { label: `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`, title: `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}` };
}

export interface CategorySeries extends ChartSeries {
  colorIndex: number | "neutral";
}

/**
 * Inbound mail per day, stacked by category. The `maxSeries - 1` busiest
 * categories get their own colour; the rest are "Other".
 */
export function receivedColumns(daily: DailySeries | null | undefined, now: Date, days = 14, maxSeries = 6): { data: ColumnDatum[]; series: CategorySeries[]; total: number; totals: number[] } {
  const window = lastDays(now, days);
  const inWindow = new Set(window);
  const byCategory = new Map<string, number>();
  for (const r of daily?.received ?? []) if (inWindow.has(r.date)) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.count);
  const ranked = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const own = ranked.length > maxSeries ? ranked.slice(0, maxSeries - 1) : ranked;
  const keyOf = (c: string) => (own.includes(c) ? c : "rest");
  const perDay = new Map(window.map((d) => [d, {} as Record<string, number>]));
  for (const r of daily?.received ?? []) {
    const day = perDay.get(r.date);
    if (!day) continue;
    const k = keyOf(r.category);
    day[k] = (day[k] ?? 0) + r.count;
  }
  const keys = ranked.length > own.length ? [...own, "rest"] : own;
  const series: CategorySeries[] = keys.map((k) => ({ key: k, label: k === "rest" ? "Other" : CATEGORY_NAMES[k] ?? k, colorIndex: k === "rest" ? "neutral" : categoryColor(k) }));
  const data = window.map((date) => ({ ...dayLabels(date), values: Object.fromEntries(keys.map((k) => [k, perDay.get(date)![k] ?? 0])) }));
  const totals = window.map((d) => Object.values(perDay.get(d)!).reduce((a, b) => a + b, 0));
  return { data, series, total: totals.reduce((a, b) => a + b, 0), totals };
}

export const SEND_SERIES: ChartSeries[] = [
  { key: "sent", label: "Sent", tone: "ok" },
  { key: "retrying", label: "Waiting to retry", tone: "warn" },
  { key: "failed", label: "Failed", tone: "bad" },
  { key: "sending", label: "Sending", tone: "info" },
];

/** Send requests per day by status. */
export function sendColumns(daily: DailySeries | null | undefined, now: Date, days = 14): { data: ColumnDatum[]; sent: number; failed: number; totals: number[]; sentPerDay: number[] } {
  const window = lastDays(now, days);
  const perDay = new Map(window.map((d) => [d, { sent: 0, retrying: 0, failed: 0, sending: 0 } as Record<string, number>]));
  for (const r of daily?.sends ?? []) {
    const day = perDay.get(r.date);
    if (day && r.status in day) day[r.status]! += r.count;
  }
  const data = window.map((date) => ({ ...dayLabels(date), values: perDay.get(date)! }));
  const sent = window.reduce((n, d) => n + perDay.get(d)!.sent!, 0);
  const failed = window.reduce((n, d) => n + perDay.get(d)!.failed! + perDay.get(d)!.retrying!, 0);
  return {
    data,
    sent,
    failed,
    totals: window.map((d) => Object.values(perDay.get(d)!).reduce((a, b) => a + b, 0)),
    sentPerDay: window.map((d) => perDay.get(d)!.sent!),
  };
}

/** Mail by category for a donut, busiest first; zero categories left out. */
export function categorySegments(counts: Record<string, number> | null | undefined, maxSegments = 7): Segment[] {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const head = entries.length > maxSegments ? entries.slice(0, maxSegments - 1) : entries;
  const rest = entries.slice(head.length).reduce((n, [, v]) => n + v, 0);
  const segs: Segment[] = head.map(([key, value]) => ({ key, label: CATEGORY_NAMES[key] ?? key, value }));
  if (rest) segs.push({ key: "rest", label: "Other", value: rest, tone: "neutral" });
  return segs;
}
