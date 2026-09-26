import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  acceptGrant,
  assertRecordType,
  linkStatus,
  orderCompanies,
  PartnerError,
  proposeGrant,
  type LinkStatus,
} from "./domain.js";
import { PARTNER_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { createSkillSyncer } from "@partnersinbiz/pib-plugin-kit";

let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

interface LinkRow {
  id: string;
  company_a_id: string;
  company_b_id: string;
  accepted_a: boolean;
  accepted_b: boolean;
  status: LinkStatus;
}

interface GrantRow {
  id: string;
  link_id: string;
  record_type: string;
  record_id: string;
  source_company_id: string;
  grantee_company_id: string;
  status: "proposed" | "active" | "revoked";
}

const plugin = definePlugin({
  async setup(ctx) {
    skillSync = createSkillSyncer(ctx, SKILLS);
    for (const tool of PARTNER_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run);
      });
    }
    ctx.actions.register("partners.load", (_params, context) => {
      const companyId = requiredCompany(context);
      void skillSync?.ensure(companyId);
      return load(ctx, companyId);
    });
    ctx.actions.register("partners.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));
    ctx.actions.register("partners.propose-link", (params, context) => proposeLink(ctx, requiredCompany(context), params));
    ctx.actions.register("partners.accept-link", (params, context) => acceptLink(ctx, requiredCompany(context), params));
    ctx.actions.register("partners.propose-grant", (params, context) => proposeNamedGrant(ctx, requiredCompany(context), params));
    ctx.actions.register("partners.accept-grant", (params, context) => acceptNamedGrant(ctx, context, params));
    ctx.actions.register("partners.revoke-grant", (params, context) => revokeGrant(ctx, requiredCompany(context), params));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
  },
  async onHealth() {
    return { status: "ok", message: "Partners plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    if (name === "propose-link") return { content: "Link proposed", data: await proposeLink(ctx, run.companyId, body) };
    if (name === "propose-grant") return { content: "Grant proposed", data: await proposeNamedGrant(ctx, run.companyId, body) };
    if (name === "revoke-grant") return { content: "Grant revoked", data: await revokeGrant(ctx, run.companyId, body) };
    return { error: "Unknown partners tool" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Partners tool failed" };
  }
}

async function load(ctx: PluginContext, companyId: string) {
  const links = await ctx.db.query<LinkRow>(
    `SELECT id, company_a_id, company_b_id, accepted_a, accepted_b, status
       FROM ${table(ctx, "links")}
      WHERE company_a_id = $1 OR company_b_id = $1
      ORDER BY created_at DESC`,
    [companyId],
  );
  const grants = await ctx.db.query<GrantRow>(
    `SELECT id, link_id, record_type, record_id, source_company_id, grantee_company_id, status
       FROM ${table(ctx, "grants")}
      WHERE source_company_id = $1 OR grantee_company_id = $1
      ORDER BY created_at DESC`,
    [companyId],
  );
  return { links, grants };
}

async function proposeLink(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const [companyA, companyB] = orderCompanies(companyId, requiredString(params, "otherCompanyId"));
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "links")} (id, company_a_id, company_b_id, accepted_a, accepted_b, status)
     VALUES ($1, $2, $3, false, false, 'pending')
     ON CONFLICT (company_a_id, company_b_id) DO NOTHING`,
    [id, companyA, companyB],
  );
  return requireLinkPair(ctx, companyA, companyB);
}

async function acceptLink(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const link = await requireLink(ctx, requiredString(params, "linkId"));
  if (link.company_a_id === companyId) link.accepted_a = true;
  else if (link.company_b_id === companyId) link.accepted_b = true;
  else throw new PartnerError("This workspace is not on that link");
  link.status = linkStatus(link.accepted_a, link.accepted_b);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "links")}
        SET accepted_a = $2, accepted_b = $3, status = $4
      WHERE id = $1`,
    [link.id, link.accepted_a, link.accepted_b, link.status],
  );
  return link;
}

async function proposeNamedGrant(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const link = await requireLink(ctx, requiredString(params, "linkId"));
  if (link.company_a_id !== companyId && link.company_b_id !== companyId) {
    throw new PartnerError("This workspace is not on that link");
  }
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
  const granteeCompanyId = requiredString(params, "granteeCompanyId");
  const other = link.company_a_id === companyId ? link.company_b_id : link.company_a_id;
  if (granteeCompanyId !== other) throw new PartnerError("The grantee must be the other company on the link");
  const proposed = proposeGrant({ linkStatus: link.status, recordId, recordType });
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "grants")}
      (id, link_id, record_type, record_id, source_company_id, grantee_company_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposed')
     ON CONFLICT (record_type, record_id, grantee_company_id) DO NOTHING`,
    [id, link.id, recordType, recordId, companyId, granteeCompanyId],
  );
  return { ...proposed, linkId: link.id, granteeCompanyId };
}

async function acceptNamedGrant(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  if (context.actor.type !== "user") throw new PartnerError("A person accepts a grant");
  const companyId = requiredCompany(context);
  const grant = await requireGrant(ctx, requiredString(params, "grantId"));
  const link = await requireLink(ctx, grant.link_id);
  const accepted = acceptGrant({
    linkStatus: link.status,
    sourceCompanyId: grant.source_company_id,
    actorCompanyId: companyId,
    recordId: grant.record_id,
    recordType: assertRecordType(grant.record_type),
  });
  await ctx.db.execute(
    `UPDATE ${table(ctx, "grants")} SET status = 'active' WHERE id = $1`,
    [grant.id],
  );
  return {
    ...accepted,
    grantId: grant.id,
    granteeCompanyId: grant.grantee_company_id,
    share: grant.record_type === "invoice"
      ? { plugin: "billing" as const, invoiceId: grant.record_id, granteeCompanyId: grant.grantee_company_id }
      : { plugin: "crm" as const, recordType: grant.record_type, recordId: grant.record_id, granteeCompanyId: grant.grantee_company_id },
  };
}

async function revokeGrant(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const grant = await requireGrant(ctx, requiredString(params, "grantId"));
  if (grant.source_company_id !== companyId) throw new PartnerError("Only the company that owns the record can revoke the grant");
  if (grant.status === "revoked") throw new PartnerError("This grant is already revoked");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "grants")} SET status = 'revoked' WHERE id = $1`,
    [grant.id],
  );
  // CRM and Billing listen for this and remove the share they wrote on accept.
  let propagated = true;
  try {
    await ctx.events.emit("grant.revoked", companyId, {
      grantId: grant.id,
      recordType: grant.record_type,
      recordId: grant.record_id,
      sourceCompanyId: grant.source_company_id,
      granteeCompanyId: grant.grantee_company_id,
    });
  } catch (error) {
    propagated = false;
    ctx.logger.error("Partner grant revoke broadcast failed", { grantId: grant.id, error: error instanceof Error ? error.message : String(error) });
  }
  return { grantId: grant.id, recordType: grant.record_type, recordId: grant.record_id, status: "revoked", propagated };
}

async function requireLink(ctx: PluginContext, id: string): Promise<LinkRow> {
  const rows = await ctx.db.query<LinkRow>(
    `SELECT id, company_a_id, company_b_id, accepted_a, accepted_b, status
       FROM ${table(ctx, "links")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  const link = rows[0];
  if (!link) throw new PartnerError("Link was not found");
  return link;
}

async function requireLinkPair(ctx: PluginContext, companyA: string, companyB: string): Promise<LinkRow> {
  const rows = await ctx.db.query<LinkRow>(
    `SELECT id, company_a_id, company_b_id, accepted_a, accepted_b, status
       FROM ${table(ctx, "links")} WHERE company_a_id = $1 AND company_b_id = $2 LIMIT 1`,
    [companyA, companyB],
  );
  const link = rows[0];
  if (!link) throw new PartnerError("Link was not found");
  return link;
}

async function requireGrant(ctx: PluginContext, id: string): Promise<GrantRow> {
  const rows = await ctx.db.query<GrantRow>(
    `SELECT id, link_id, record_type, record_id, source_company_id, grantee_company_id, status
       FROM ${table(ctx, "grants")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  const grant = rows[0];
  if (!grant) throw new PartnerError("Grant was not found");
  return grant;
}

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new PartnerError("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new PartnerError("Company is required");
  return context.companyId;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PartnerError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new PartnerError(`${key} is required`);
  return value.trim();
}

