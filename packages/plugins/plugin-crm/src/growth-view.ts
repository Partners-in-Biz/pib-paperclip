/**
 * What the client page's Agreements and Growth card reads (one call, built by the worker): whether e-sign is on and the client's
 * documents, the client's site counters with their last 30 days, and where its enquiries came from over 90 days. No signing link,
 * no write key, no address of a visitor and no snippet is in it: the snippet comes only from the create-event-key action.
 * Every part is read on its own and falls back to empty, so a slow or broken part never hides the others.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { attributionFor, attributionOut } from "./attribution.js";
import type { ClientKey } from "./care-store.js";
import { clientAgreementsView } from "./esign-dispatch.js";
import { eventsSummaryFor, rangeOf } from "./site-events.js";
import { eventKeyWarnings } from "./site-events-health.js";
import { listEventKeys } from "./site-events-store.js";
import { lastDays } from "./site-events-form.js";

export const GROWTH_VIEW_DAYS = 90;

export interface GrowthChannelView {
  channel: string;
  label: string;
  firstLeads: number;
  lastLeads: number;
  qualified: number;
  won: number;
  revenue: string;
  cost: string;
}

export interface SiteKeyView {
  id: string;
  label: string;
  site: string | null;
  status: "active" | "paused" | "revoked";
  consentMode: "anonymous" | "required";
  counted: number;
  lastEventAt: string | null;
  warnings: string[];
}

export interface GrowthView {
  days: number;
  channels: GrowthChannelView[];
  totals: { firstLeads: number; revenue: string };
  unattributedLeads: number;
  siteKeys: SiteKeyView[];
  /** Last 30 days of the client's own site counters; null when it has no key. */
  site: { visits: number; pageviews: number; conversions: number } | null;
}

export async function clientGrowthView(ctx: PluginContext, companyId: string, client: ClientKey, now = new Date()): Promise<GrowthView | null> {
  const range = lastDays(now, GROWTH_VIEW_DAYS);
  const bounds = { from: new Date(Date.parse(`${range.from}T00:00:00Z`) - 2 * 3_600_000).toISOString(), to: new Date(Date.parse(`${range.to}T00:00:00Z`) - 2 * 3_600_000).toISOString() };
  const [report, keys] = await Promise.all([
    attributionFor(ctx, companyId, client, bounds, `the last ${GROWTH_VIEW_DAYS} days`).catch(() => null),
    listEventKeys(ctx, companyId, client).catch(() => []),
  ]);
  const out = report ? attributionOut(report) : null;
  const channels: GrowthChannelView[] = (out?.channels ?? [])
    .filter((row) => row.firstTouch.leads > 0 || row.lastTouch.leads > 0)
    .map((row) => ({
      channel: row.channel,
      label: row.label,
      firstLeads: row.firstTouch.leads,
      lastLeads: row.lastTouch.leads,
      qualified: row.lastTouch.qualified,
      won: row.lastTouch.won,
      revenue: row.lastTouch.revenue,
      cost: row.cost,
    }));
  let site: GrowthView["site"] = null;
  if (keys.length > 0) {
    const thirty = rangeOf({ days: 30 }, now);
    const counted = await eventsSummaryFor(ctx, companyId, client, thirty).catch(() => null);
    if (counted) site = { visits: counted.summary.entrances, pageviews: counted.summary.pageviews, conversions: counted.summary.conversions.total };
  }
  return {
    days: GROWTH_VIEW_DAYS,
    channels,
    totals: { firstLeads: out?.totals.firstTouch.leads ?? 0, revenue: out?.totals.lastTouch.revenue ?? "none" },
    unattributedLeads: channels.find((row) => row.channel === "unattributed")?.firstLeads ?? 0,
    siteKeys: keys
      .filter((key) => key.status !== "revoked")
      .map((key) => ({ id: key.id, label: key.label, site: key.siteUrl, status: key.status, consentMode: key.consentMode, counted: key.acceptedCount, lastEventAt: key.lastEventAt, warnings: eventKeyWarnings(key, now) })),
    site,
  };
}

/** Both parts of the card, for the client workspace. */
export async function clientAgreementsAndGrowth(ctx: PluginContext, companyId: string, client: ClientKey) {
  const [agreements, growth] = await Promise.all([
    clientAgreementsView(ctx, companyId, client).catch(() => null),
    clientGrowthView(ctx, companyId, client).catch(() => null),
  ]);
  return { agreements, growth };
}
