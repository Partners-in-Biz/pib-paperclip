/**
 * One summary per client for the Studio page: asset counts by status, this month's credits against the client's
 * cap, and the newest approved assets (ids only; the page asks the person-only "asset-urls" action for links).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, listCrmClients } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { currentPeriod, effectiveCap, listCaps, usageByClient } from "./ledger.js";

export interface ClientSummary {
  scopeKey: string;
  name: string;
  counts: { draft: number; approved: number; rejected: number };
  used: number;
  monthlyCap: number | null;
  capSource: "client" | "company" | "default" | "none";
  recentApproved: Array<{ id: string; name: string; kind: string }>;
}

export async function clientSummaries(ctx: PluginContext, companyId: string) {
  const period = currentPeriod();
  // A fixed number of queries, however many CRM clients there are (it was one usage query per client: slow first load).
  const [clients, caps, used, countRows, recentRows] = await Promise.all([
    listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => []),
    listCaps(ctx, companyId),
    usageByClient(ctx, companyId, period),
    ctx.db.query<{ client_kind: string; client_ref: string; status: string; n: unknown }>(
      `SELECT client_kind, client_ref, status, COUNT(*) AS n FROM ${table(ctx, "assets")} WHERE company_id = $1 AND client_ref IS NOT NULL GROUP BY client_kind, client_ref, status`,
      [companyId],
    ),
    ctx.db.query<{ id: string; name: string; kind: string; client_kind: string; client_ref: string }>(
      `SELECT id, name, kind, client_kind, client_ref FROM (
         SELECT id, name, kind, client_kind, client_ref, row_number() OVER (PARTITION BY client_kind, client_ref ORDER BY created_at DESC) AS rn
         FROM ${table(ctx, "assets")} WHERE company_id = $1 AND client_ref IS NOT NULL AND status = 'approved'
       ) t WHERE rn <= 3 ORDER BY client_kind, client_ref, rn`,
      [companyId],
    ),
  ]);
  const summaries: ClientSummary[] = clients.map((c) => {
      const scope = { kind: c.kind, id: c.id };
      const cap = effectiveCap(caps, scope);
      const counts = { draft: 0, approved: 0, rejected: 0 };
      for (const r of countRows) {
        if (r.client_kind === c.kind && r.client_ref === c.id && r.status in counts) counts[r.status as keyof typeof counts] += Number(r.n);
      }
      return {
        scopeKey: formatClientParam(scope),
        name: c.name,
        counts,
        used: used.get(`${c.kind}:${c.id}`) ?? 0,
        monthlyCap: cap.monthlyCredits,
        capSource: cap.source,
        recentApproved: recentRows.filter((r) => r.client_kind === c.kind && r.client_ref === c.id).map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
      };
    });
  return { period, clients: summaries };
}
