/**
 * Chart series for the Campaigns overview (pure, no Node imports, so the UI
 * can use the same helpers). Days and weeks are UTC.
 */

export interface VariantCounts { sent: number; replies: number }

export interface CampaignEventTotals {
  sent: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  opens: number;
  clicks: number;
  variants: { a: VariantCounts; b: VariantCounts };
}

export interface SendWeek {
  /** First day of the 7-day window, `YYYY-MM-DD`. */
  start: string;
  sent: number;
  replies: number;
  bounces: number;
}

export interface CampaignSeries {
  /** Sends, replies and bounces per 7-day window, last 12 windows, oldest first. */
  weeks: SendWeek[];
  /** All-time event counts per campaign id. */
  byCampaign: Record<string, CampaignEventTotals>;
}

export interface EventCountRow { campaign_id: string; event_type: string; variant?: string | null; count: string | number }
export interface EventDayRow { campaign_id: string; event_type: string; day: string; count: string | number }

const FIELD: Record<string, keyof Omit<CampaignEventTotals, "variants">> = {
  sent: "sent",
  reply: "replies",
  bounce: "bounces",
  unsubscribe: "unsubscribes",
  open: "opens",
  click: "clicks",
};

export function emptyTotals(): CampaignEventTotals {
  return { sent: 0, replies: 0, bounces: 0, unsubscribes: 0, opens: 0, clicks: 0, variants: { a: { sent: 0, replies: 0 }, b: { sent: 0, replies: 0 } } };
}

/** Event counts per campaign, with sends and replies split by A/B variant (a missing variant is A). */
export function eventTotals(rows: EventCountRow[], campaignIds?: Set<string>): Record<string, CampaignEventTotals> {
  const out: Record<string, CampaignEventTotals> = {};
  for (const row of rows) {
    if (campaignIds && !campaignIds.has(row.campaign_id)) continue;
    const field = FIELD[row.event_type];
    if (!field) continue;
    const count = Number(row.count ?? 0) || 0;
    const totals = (out[row.campaign_id] ??= emptyTotals());
    totals[field] += count;
    if (row.event_type === "sent" || row.event_type === "reply") {
      const variant = row.variant === "b" ? totals.variants.b : totals.variants.a;
      if (row.event_type === "sent") variant.sent += count;
      else variant.replies += count;
    }
  }
  return out;
}

/** The start (`YYYY-MM-DD`) of each of the last `weeks` 7-day windows, oldest first; the last one ends today. */
export function weekStarts(now: Date, weeks = 12): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: weeks }, (_, i) => new Date(today - ((weeks - 1 - i) * 7 + 6) * 86_400_000).toISOString().slice(0, 10));
}

/** Sends, replies and bounces per 7-day window from per-day counts. */
export function weeklySends(rows: EventDayRow[], now: Date, weeks = 12, campaignIds?: Set<string>): SendWeek[] {
  const starts = weekStarts(now, weeks);
  const out = starts.map((start) => ({ start, sent: 0, replies: 0, bounces: 0 }));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const row of rows) {
    if (campaignIds && !campaignIds.has(row.campaign_id)) continue;
    const t = Date.parse(`${String(row.day).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(t) || t > today) continue;
    const back = Math.floor((today - t) / (7 * 86_400_000));
    const week = out[weeks - 1 - back];
    if (!week) continue;
    const count = Number(row.count ?? 0) || 0;
    if (row.event_type === "sent") week.sent += count;
    else if (row.event_type === "reply") week.replies += count;
    else if (row.event_type === "bounce") week.bounces += count;
  }
  return out;
}

/** Replies ÷ sends, or null before anything was sent. */
export function replyRate(counts: { sent: number; replies: number }): number | null {
  return counts.sent > 0 ? counts.replies / counts.sent : null;
}
