/**
 * Effort against revenue per client, worker part (Q1b-14). The join and the
 * alerts are in `client-cost-model.ts`.
 *
 * Revenue is what Billing's `invoice.paid` event reported, kept per client in
 * `client_revenue` (the Cockpit already hears that event). Projects are tied to
 * clients by the CRM's client-to-project links (kit `registerClientProjectWatch`
 * keeps a copy), else by a project named after the client.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientProjectIds, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { crmClients, type CrmClientRow } from "./clients.js";
import { clientEffortChecks, clientEfforts, EFFORT, type ClientEffort, type ClientRef, type Payment } from "./client-cost-model.js";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { readProjectRuns } from "./measure.js";
import { clockMs } from "./run-record.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.client_revenue`;

/** Stores one paid invoice (idempotent by the event key). True when it was new. */
export async function recordPayment(ctx: PluginContext, companyId: string, row: { key: string; clientRef: string | null; number: string | null; totalMinor: number; currency: string; paidAt: string }): Promise<boolean> {
  const result = await ctx.db.execute(
    `INSERT INTO ${T} (company_id, key, client_ref, invoice_number, total_minor, currency, paid_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (company_id, key) DO NOTHING`,
    [companyId, row.key.slice(0, 200), row.clientRef, row.number?.slice(0, 60) ?? null, Math.round(row.totalMinor), row.currency.toUpperCase().slice(0, 3), row.paidAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function readPayments(ctx: PluginContext, companyId: string, since: string): Promise<Payment[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT client_ref, total_minor, currency FROM ${T} WHERE company_id = $1 AND paid_at >= $2 LIMIT 5000`, [companyId, since]);
  return rows.map((r) => ({ clientRef: r.client_ref == null ? null : String(r.client_ref), totalMinor: Number(r.total_minor) || 0, currency: String(r.currency ?? "ZAR") }));
}

export interface EffortSettings {
  usdRate: number;
  alertRatio: number;
}

/** The exchange rate and alert ratio from the Cockpit settings (blank: the defaults). */
export async function effortSettings(ctx: PluginContext, companyId: string): Promise<EffortSettings> {
  try {
    const config = await readConfig(ctx, companyId);
    const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
    return { usdRate: positive(config.usdRate, EFFORT.defaultUsdRate), alertRatio: positive(config.effortAlertRatio, EFFORT.alertRatio) };
  } catch {
    return { usdRate: EFFORT.defaultUsdRate, alertRatio: EFFORT.alertRatio };
  }
}

/** How many clients' project links are read at once. */
const LINK_READ_BATCH = 100;
/** How long one report may spend reading links (PAR-13702: 281 CRM companies at 25 a time took over 10 s for PAR). */
const LINK_BUDGET_MS = 5_000;
/** A client's links are kept this long between reports: they change when the CRM links a project, which is rare. */
const LINK_TTL_MS = 60 * 60_000;

const linkCaches = new WeakMap<object, Map<string, { ids: string[]; at: number }>>();

/**
 * Each CRM company's linked project ids. Reads run in batches, remember what they read, and stop when the time budget is used:
 * the report then throws and the next load carries on from the cache, so a cold load stays short and the part still finishes
 * (never a half answer: a client with no links read would look unlinked and raise a false alert).
 */
async function readLinks(env: Env, companyId: string, companies: CrmClientRow[]): Promise<Map<string, string[]>> {
  let byCompany = linkCaches.get(env);
  if (!byCompany) linkCaches.set(env, (byCompany = new Map()));
  const now = env.now().getTime();
  const out = new Map<string, string[]>();
  const todo: CrmClientRow[] = [];
  for (const row of companies) {
    const hit = byCompany.get(`${companyId}|${row.id}`);
    if (hit && now - hit.at < LINK_TTL_MS) out.set(row.id, hit.ids);
    else todo.push(row);
  }
  const started = clockMs();
  for (let i = 0; i < todo.length; i += LINK_READ_BATCH) {
    if (i > 0 && clockMs() - started > LINK_BUDGET_MS) throw new Error(`client links: ${todo.length - i} of ${companies.length} not read yet, continuing on the next load`);
    const batch = todo.slice(i, i + LINK_READ_BATCH);
    const links = await Promise.all(batch.map((row) => clientProjectIds(env.ctx, companyId, { kind: "company", id: row.id })));
    batch.forEach((row, index) => {
      out.set(row.id, links[index]!);
      byCompany!.set(`${companyId}|${row.id}`, { ids: links[index]!, at: now });
    });
  }
  return out;
}

/** Each customer's notional AI spend over the last 30 days against what they paid. */
export async function clientEffortReport(env: Env, companyId: string): Promise<{ rows: ClientEffort[]; settings: EffortSettings }> {
  const settings = await effortSettings(env.ctx, companyId);
  const since = new Date(env.now().getTime() - EFFORT.days * 86_400_000).toISOString();
  const [projects, crm, payments] = await Promise.all([readProjectRuns(env.ctx, companyId, since, 60), crmClients(env.ctx, companyId, 500), readPayments(env.ctx, companyId, since)]);
  const companies = crm.filter((c) => c.kind === "company");
  const links = await readLinks(env, companyId, companies);
  const clients: ClientRef[] = companies.map((row) => ({ clientRef: `company:${row.id}`, name: row.name, lifecycle: row.lifecycle, linkedProjectIds: links.get(row.id) ?? [] }));
  return { rows: clientEfforts({ projects, clients, payments, usdRate: settings.usdRate }), settings };
}

/** The alerts for the Cockpit's health snapshot. Unreadable data is no alert (and no false all-clear: the caller logs). */
export async function clientEffortHealth(env: Env, companyId: string): Promise<HealthCheck[]> {
  try {
    const { rows, settings } = await clientEffortReport(env, companyId);
    return clientEffortChecks(rows, settings);
  } catch (error) {
    env.ctx.logger.info("Cockpit client effort failed", { companyId, error: message(error) });
    return [];
  }
}
