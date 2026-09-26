/**
 * Chart series for the CRM overview (pure, no Node imports, so the UI can use
 * the same helpers). Months and weeks are UTC.
 */
import { leadBand, type LeadScore } from "./lead-levels.js";

export interface RecordDates {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WonMonth {
  /** `YYYY-MM`. */
  month: string;
  count: number;
  /** Won amount per currency, in minor units. */
  amountMinor: Record<string, number>;
}

export interface CrmSeries {
  /** Deals in a won stage per month, last 12 months, oldest first (dated by their last update). */
  wonByMonth: WonMonth[];
  /** Contacts added per week, last 8 weeks, oldest first. */
  newContactsByWeek: number[];
  /** Deals added per week, last 8 weeks, oldest first. */
  newDealsByWeek: number[];
}

/** The last `count` UTC months as `YYYY-MM`, oldest first, ending with this month. */
export function lastMonths(now: Date, count: number): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * Won deals per month. A deal has no "won at" column, so the month is the
 * deal's last update, which is when it was moved into the won stage unless it
 * was edited afterwards.
 */
export function wonPerMonth(
  deals: Array<{ id: string; stageId: string; amountMinor: number; currency: string }>,
  wonStageIds: Set<string>,
  dates: RecordDates[],
  now: Date,
  months = 12,
): WonMonth[] {
  const keys = lastMonths(now, months);
  const out = new Map(keys.map((month) => [month, { month, count: 0, amountMinor: {} as Record<string, number> }]));
  const updated = new Map(dates.map((row) => [row.id, row.updatedAt ?? row.createdAt]));
  for (const deal of deals) {
    if (!wonStageIds.has(deal.stageId)) continue;
    const at = updated.get(deal.id);
    const t = at ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(t)) continue;
    const bucket = out.get(new Date(t).toISOString().slice(0, 7));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.amountMinor[deal.currency] = (bucket.amountMinor[deal.currency] ?? 0) + Math.max(0, Math.round(deal.amountMinor));
  }
  return [...out.values()];
}

/** Records created per 7-day window, oldest first; the last window ends now. */
export function perWeek(createdAt: Array<string | null>, now: Date, weeks = 8): number[] {
  const end = now.getTime();
  const out = Array.from({ length: weeks }, () => 0);
  for (const at of createdAt) {
    const t = at ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(t) || t > end) continue;
    const back = Math.floor((end - t) / (7 * 86_400_000));
    if (back < weeks) out[weeks - 1 - back]! += 1;
  }
  return out;
}

export function crmSeries(input: {
  deals: Array<{ id: string; stageId: string; amountMinor: number; currency: string }>;
  stages: Array<{ id: string; kind: string }>;
  dealDates: RecordDates[];
  contactDates: RecordDates[];
  visibleContactIds: Set<string>;
  now: Date;
}): CrmSeries {
  const won = new Set(input.stages.filter((stage) => stage.kind === "won").map((stage) => stage.id));
  const dealIds = new Set(input.deals.map((deal) => deal.id));
  return {
    wonByMonth: wonPerMonth(input.deals, won, input.dealDates, input.now),
    newContactsByWeek: perWeek(input.contactDates.filter((row) => input.visibleContactIds.has(row.id)).map((row) => row.createdAt), input.now),
    newDealsByWeek: perWeek(input.dealDates.filter((row) => dealIds.has(row.id)).map((row) => row.createdAt), input.now),
  };
}

export interface LeadBands {
  hot: number;
  warm: number;
  cold: number;
  unscored: number;
}

/** Contacts per lead band; contacts without a Jev score count as unscored. */
export function leadBands(contacts: Array<{ leadScore?: LeadScore | null }>): LeadBands {
  const out: LeadBands = { hot: 0, warm: 0, cold: 0, unscored: 0 };
  for (const contact of contacts) {
    if (!contact.leadScore) out.unscored += 1;
    else out[leadBand(contact.leadScore)] += 1;
  }
  return out;
}

/** Difference of the last `span` values against the `span` before them. */
export function recentDelta(values: number[], span: number): number {
  const recent = values.slice(-span).reduce((sum, v) => sum + v, 0);
  const before = values.slice(-2 * span, -span).reduce((sum, v) => sum + v, 0);
  return recent - before;
}
