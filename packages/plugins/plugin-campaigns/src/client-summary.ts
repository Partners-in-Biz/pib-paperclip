import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { table } from "./db.js";

export interface ClientSummaryRow {
  kind: "company" | "contact";
  id: string;
  name: string;
  running: number;
  waiting: number;
}

interface Row {
  client_kind: string | null;
  client_ref: string;
  client_name: string | null;
  running: string;
  waiting: string;
}

/** Counts of running (active) and waiting-for-approval campaigns per client, for the own page's summary line. Clients with neither are left out. */
export async function ownClientCounts(ctx: PluginContext, companyId: string): Promise<ClientSummaryRow[]> {
  const rows = await ctx.db.query<Row>(
    `SELECT c.client_kind, c.client_ref, max(c.client_name) AS client_name,
            count(*) FILTER (WHERE c.status = 'active')::text AS running,
            count(*) FILTER (WHERE c.status = 'draft' AND i.id IS NOT NULL AND i.status NOT IN ('done', 'cancelled'))::text AS waiting
       FROM ${table(ctx, "campaigns")} c
       LEFT JOIN public.issues i ON i.id::text = c.approval_issue_id
      WHERE c.company_id = $1 AND c.client_ref IS NOT NULL
      GROUP BY c.client_kind, c.client_ref
     HAVING count(*) FILTER (WHERE c.status = 'active') > 0
         OR count(*) FILTER (WHERE c.status = 'draft' AND i.id IS NOT NULL AND i.status NOT IN ('done', 'cancelled')) > 0
      ORDER BY max(c.client_name) NULLS LAST, c.client_ref
      LIMIT 50`,
    [companyId],
  );
  return rows.map((row) => {
    const kind = row.client_kind === "contact" ? "contact" : "company";
    return { kind, id: row.client_ref, name: row.client_name ?? row.client_ref, running: Number(row.running) || 0, waiting: Number(row.waiting) || 0 };
  });
}

/** `/campaigns?client=<kind>:<id>` */
export function clientWorkspacePath(row: Pick<ClientSummaryRow, "kind" | "id">): string {
  return `/campaigns?client=${formatClientParam(row)}`;
}
