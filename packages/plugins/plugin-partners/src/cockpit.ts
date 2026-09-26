/**
 * Partners snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only: a few SELECTs on our own tables.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  emptySnapshot,
  isModuleEnabled,
  jobHealth,
  publishCockpitSnapshot,
  readConfig,
  type ActivityItem,
  type CockpitSnapshot,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { knownCompanies } from "./setup-status.js";

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("Partners cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Partners");

  const counts = await part(
    ctx,
    "counts",
    async () => {
      const rows = await ctx.db.query<{ links: string; grants: string }>(
        `SELECT
           (SELECT count(*) FROM ${table(ctx, "links")} WHERE status = 'active' AND (company_a_id = $1 OR company_b_id = $1))::text AS links,
           (SELECT count(*) FROM ${table(ctx, "grants")} WHERE status = 'active' AND (source_company_id = $1 OR grantee_company_id = $1))::text AS grants`,
        [companyId],
      );
      return { links: Number(rows[0]?.links ?? 0), grants: Number(rows[0]?.grants ?? 0) };
    },
    null as { links: number; grants: number } | null,
  );
  if (counts) {
    snap.kpis.push(
      { key: "partner_links", label: "Active partner links", value: String(counts.links), raw: counts.links, tone: "neutral", href: "/partners", group: "people" },
      { key: "partner_grants", label: "Records shared", value: String(counts.grants), raw: counts.grants, tone: "neutral", href: "/partners", group: "people" },
    );
  }

  snap.health.push(await jobHealth(ctx, "setup-status", "Setup and cockpit report", 60));

  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  return snap;
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const items: WaitingItem[] = [];
  const links = await ctx.db.query<{ id: string; company_a_id: string; company_b_id: string; created_at: string }>(
    `SELECT id, company_a_id, company_b_id, created_at::text AS created_at FROM ${table(ctx, "links")}
      WHERE status = 'pending' AND ((company_a_id = $1 AND accepted_a = false) OR (company_b_id = $1 AND accepted_b = false))
      ORDER BY created_at LIMIT 20`,
    [companyId],
  );
  for (const link of links) {
    const other = link.company_a_id === companyId ? link.company_b_id : link.company_a_id;
    items.push({
      key: `partners:link:${link.id}`,
      title: `Partner link with ${other}`,
      why: "A person accepts partner links for this company.",
      href: "/partners",
      kind: "grant",
      since: link.created_at,
    });
  }
  const grants = await ctx.db.query<{ id: string; record_type: string; record_id: string; grantee_company_id: string; created_at: string }>(
    `SELECT id, record_type, record_id, grantee_company_id, created_at::text AS created_at FROM ${table(ctx, "grants")}
      WHERE status = 'proposed' AND source_company_id = $1 ORDER BY created_at LIMIT 20`,
    [companyId],
  );
  for (const grant of grants) {
    items.push({
      key: `partners:grant:${grant.id}`,
      title: `Share ${grant.record_type} ${grant.record_id} with ${grant.grantee_company_id}`,
      why: "A person accepts each record grant before the partner sees it.",
      href: "/partners",
      kind: "grant",
      since: grant.created_at,
    });
  }
  return items;
}

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const links = await ctx.db.query<{ company_a_id: string; company_b_id: string; status: string; created_at: string }>(
    `SELECT company_a_id, company_b_id, status, created_at::text AS created_at FROM ${table(ctx, "links")}
      WHERE company_a_id = $1 OR company_b_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [companyId],
  );
  const grants = await ctx.db.query<{ record_type: string; record_id: string; grantee_company_id: string; status: string; created_at: string }>(
    `SELECT record_type, record_id, grantee_company_id, status, created_at::text AS created_at FROM ${table(ctx, "grants")}
      WHERE source_company_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [companyId],
  );
  const items: ActivityItem[] = [
    ...links.map((link) => ({
      at: link.created_at,
      text: `Proposed a partner link with ${link.company_a_id === companyId ? link.company_b_id : link.company_a_id}${link.status === "active" ? " (active)" : ""}`,
      href: "/partners",
    })),
    ...grants.map((grant) => ({
      at: grant.created_at,
      text: `${grant.status === "active" ? "Shared" : grant.status === "revoked" ? "Shared then revoked" : "Proposed sharing"} ${grant.record_type} ${grant.record_id} with ${grant.grantee_company_id}`,
      href: "/partners",
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
}

export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Partners cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
