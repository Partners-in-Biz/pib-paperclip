/**
 * Our own marketing numbers, emitted as an event for the Cockpit (and its growth_metrics subscriber) to consume: website conversion from
 * the own site's daily counts and revenue by source from our own attribution. Own scope only: the event carries no client, and no client's
 * rows are read. A number that cannot be read is left out, never sent as zero. GA4 is SEO's table: SEO emits its own metrics.
 * `client.signal` stays inbound-only and is not touched.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { attributionFor } from "./attribution.js";
import { PLUGIN_ID } from "./namespace.js";
import { knownCompanies } from "./setup-status.js";
import { eventsSummaryFor } from "./site-events.js";
import { lastDays } from "./site-events-form.js";
import { listEventKeys } from "./site-events-store.js";

export const OWN_METRICS_EVENT = "own.metrics.updated";
const DAY_MS = 86_400_000;
const PERIOD = "30d";

export interface OwnMetric {
  /** Stable key, e.g. `site_conversion_rate` or `revenue.organic_search.ZAR`. */
  key: string;
  label: string;
  value: number;
  /** `percent`, `count`, or the ISO currency code of a money value (major units). */
  unit: string;
  period: string;
}

export interface OwnMetricsEvent {
  scope: "own";
  metrics: OwnMetric[];
  updatedAt: string;
}

const isMetric = (metric: OwnMetric): boolean =>
  Boolean(metric.key) && Boolean(metric.label) && Boolean(metric.unit) && Number.isFinite(metric.value);

/** The own-scope metrics of one company (empty when nothing is set up). */
export async function ownMetrics(ctx: PluginContext, companyId: string, now = new Date()): Promise<OwnMetric[]> {
  const out: OwnMetric[] = [];
  const own = await listEventKeys(ctx, companyId, "own").catch(() => []);
  if (own.some((key) => key.status === "active")) {
    const { summary } = await eventsSummaryFor(ctx, companyId, "own", lastDays(now, 30));
    out.push({ key: "site_conversions", label: "Actions on our website", value: summary.conversions.total, unit: "count", period: PERIOD });
    if (summary.entrances > 0) {
      out.push({ key: "site_conversion_rate", label: "Website conversion rate", value: Math.round((summary.conversions.total / summary.entrances) * 10_000) / 100, unit: "percent", period: PERIOD });
    }
  }
  const range = { from: new Date(now.getTime() - 30 * DAY_MS).toISOString(), to: new Date(now.getTime() + 1_000).toISOString() };
  const report = await attributionFor(ctx, companyId, null, range, "the last 30 days");
  for (const row of report.rows) {
    for (const [currency, minor] of Object.entries(row.last.revenue)) {
      out.push({ key: `revenue.${row.channel}.${currency}`, label: `Revenue from ${row.label}`, value: minor / 100, unit: currency, period: PERIOD });
    }
  }
  return out.filter(isMetric);
}

/** Emits the company's own metrics when it has any. Never throws: a failure is logged without values. */
export async function emitOwnMetrics(ctx: PluginContext, companyId: string, now = new Date()): Promise<boolean> {
  try {
    const metrics = await ownMetrics(ctx, companyId, now);
    if (metrics.length === 0) return false;
    const payload: OwnMetricsEvent = { scope: "own", metrics, updatedAt: now.toISOString() };
    await ctx.events.emit(OWN_METRICS_EVENT, companyId, payload);
    return true;
  } catch (error) {
    ctx.logger.warn("CRM own metrics emit failed", { companyId, error: error instanceof Error ? error.constructor.name : "Unknown" });
    return false;
  }
}

/** Daily: emit for every company with the CRM on and saved settings. */
export async function emitAllOwnMetrics(ctx: PluginContext): Promise<number> {
  let emitted = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      if (await emitOwnMetrics(ctx, companyId)) emitted += 1;
    } catch (error) {
      ctx.logger.info("CRM own metrics skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return emitted;
}
