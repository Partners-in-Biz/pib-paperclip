/**
 * The numbers the Cockpit's goals read from this module (audit Q10-3): a goal's metric key `kpi:partnersinbiz.crm:<key>` compares one of
 * these to its target, so "leads from organic search", "visits to our own site" or "documents signed" can be goals with a number behind them.
 *
 * A KPI exists only when the thing it counts is set up (an own lead form, an own site key, any document, any paid invoice), so a company
 * that has none of them sees none: a number that cannot be read is absent, never zero. Money is in minor units with a formatted value, as
 * the Cockpit expects.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, type CockpitKpi } from "@partnersinbiz/pib-plugin-kit";
import { attributionFor } from "./attribution.js";
import { listDocs } from "./esign-store.js";
import { activeLeadSources } from "./lead-capture.js";
import { eventsSummaryFor } from "./site-events.js";
import { lastDays } from "./site-events-form.js";
import { listEventKeys } from "./site-events-store.js";
import { revenueBetween } from "./attribution-store.js";

const DAY_MS = 86_400_000;
const HREF = "/crm";

export async function growthKpis(ctx: PluginContext, companyId: string, defaultCurrency: string, now = new Date()): Promise<CockpitKpi[]> {
  const out: CockpitKpi[] = [];
  const to = new Date(now.getTime() + 1_000).toISOString();
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();

  // Our own lead forms and what came through them, by channel.
  if ((await activeLeadSources(ctx, companyId).catch(() => [])).some((source) => !source.clientKind)) {
    const report = await attributionFor(ctx, companyId, null, { from, to }, "the last 30 days");
    const organic = report.rows.find((row) => row.channel === "organic_search");
    out.push({ key: "leads_30d", label: "Website leads (30 days)", value: String(report.totals.first.leads), raw: report.totals.first.leads, tone: "neutral", href: HREF, group: "marketing" });
    out.push({ key: "organic_leads_30d", label: "Leads from organic search (30 days)", value: String(organic?.first.leads ?? 0), raw: organic?.first.leads ?? 0, tone: "neutral", href: HREF, group: "marketing" });
    const revenue = report.totals.first.revenue[defaultCurrency] ?? 0;
    const attributed = revenue - (report.rows.find((row) => row.channel === "unattributed")?.first.revenue[defaultCurrency] ?? 0);
    out.push({ key: "attributed_revenue_30d", label: "Paid revenue traced to a source (30 days)", value: formatMoneyMinor(attributed, defaultCurrency), raw: attributed, tone: "neutral", hint: `${formatMoneyMinor(revenue, defaultCurrency)} paid in all`, href: HREF, group: "marketing" });
  }

  // Our own website's visits and what visitors did.
  const own = await listEventKeys(ctx, companyId, "own").catch(() => []);
  if (own.some((key) => key.status === "active")) {
    const { summary } = await eventsSummaryFor(ctx, companyId, "own", lastDays(now, 30));
    out.push({ key: "site_visits_30d", label: "Visits to our website (30 days)", value: summary.entrances.toLocaleString("en-US"), raw: summary.entrances, tone: "neutral", href: HREF, group: "marketing" });
    out.push({ key: "site_conversions_30d", label: "Actions on our website (30 days)", value: summary.conversions.total.toLocaleString("en-US"), raw: summary.conversions.total, tone: "neutral", href: HREF, group: "marketing" });
  }

  // Documents clients sign.
  const docs = await listDocs(ctx, companyId, null, 500).catch(() => []);
  if (docs.length > 0) {
    const signed = docs.filter((doc) => doc.status === "signed" && doc.signedAt && Date.parse(doc.signedAt) >= now.getTime() - 30 * DAY_MS).length;
    const waiting = docs.filter((doc) => doc.status === "sent" || doc.status === "viewed").length;
    out.push({ key: "docs_signed_30d", label: "Documents signed by clients (30 days)", value: String(signed), raw: signed, tone: "neutral", href: HREF, group: "pipeline" });
    out.push({ key: "docs_waiting_signature", label: "Documents waiting for a signature", value: String(waiting), raw: waiting, tone: waiting > 0 ? "warn" : "ok", href: HREF, group: "pipeline" });
  }
  return out;
}

/** Whether Billing has told the CRM about any payment: the attributed-revenue number is only meaningful from then on. */
export async function hasRevenue(ctx: PluginContext, companyId: string): Promise<boolean> {
  return (await revenueBetween(ctx, companyId, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z").catch(() => [])).length > 0;
}
