import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { SeoError, sprintTask } from "./domain.js";
import { SEO_TOOLS } from "./tools.js";

const plugin = definePlugin({
  async setup(ctx) {
    for (const tool of SEO_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    ctx.actions.register("seo.load", (_params, context) => load(ctx, requiredCompany(context)));
    ctx.actions.register("seo.create-sprint", (params, context) => createSprint(ctx, requiredCompany(context), params));
    ctx.actions.register("seo.record-rank", (params, context) => recordRank(ctx, requiredCompany(context), params));
    ctx.actions.register("seo.record-audit", (params, context) => recordAudit(ctx, requiredCompany(context), params));
    ctx.actions.register("seo.open-task", (params, context) => openTask(ctx, requiredCompany(context), params));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await safeReconcile(ctx, event.companyId);
    });
    await reconcileAll(ctx);
  },
  async onHealth() {
    return { status: "ok", message: "SEO plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    const data = await dispatch(ctx, run.companyId, name, body);
    return { content: name, data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "SEO tool failed" };
  }
}

async function dispatch(ctx: PluginContext, companyId: string, name: string, body: Record<string, unknown>) {
  if (name === "create-sprint") return createSprint(ctx, companyId, body);
  if (name === "record-rank") return recordRank(ctx, companyId, body);
  if (name === "record-audit") return recordAudit(ctx, companyId, body);
  if (name === "open-task") return openTask(ctx, companyId, body);
  throw new SeoError(`Unknown SEO tool ${name}`);
}

async function load(ctx: PluginContext, companyId: string) {
  const sprints = await ctx.db.query(
    `SELECT id, name, site_url, status FROM ${table(ctx, "sprints")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
  const keywords = await ctx.db.query(
    `SELECT id, sprint_id, phrase, rank FROM ${table(ctx, "keywords")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
  const audits = await ctx.db.query(
    `SELECT id, sprint_id, finding, severity FROM ${table(ctx, "audits")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
  return { sprints, keywords, audits };
}

async function createSprint(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sprints")} (id, company_id, name, site_url) VALUES ($1, $2, $3, $4)`,
    [id, companyId, requiredString(params, "name"), requiredString(params, "siteUrl")],
  );
  return { id };
}

async function recordRank(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const sprint = await requireSprint(ctx, companyId, requiredString(params, "sprintId"));
  const rank = params.rank == null ? null : Number(params.rank);
  if (rank != null && !Number.isInteger(rank)) throw new SeoError("Rank must be an integer");
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "keywords")} (id, company_id, sprint_id, phrase, rank) VALUES ($1, $2, $3, $4, $5)`,
    [id, companyId, sprint.id, requiredString(params, "phrase"), rank],
  );
  return { id, sprintId: sprint.id };
}

async function recordAudit(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const sprint = await requireSprint(ctx, companyId, requiredString(params, "sprintId"));
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "audits")} (id, company_id, sprint_id, finding, severity) VALUES ($1, $2, $3, $4, $5)`,
    [id, companyId, sprint.id, requiredString(params, "finding"), optionalString(params, "severity") ?? "info"],
  );
  return { id, sprintId: sprint.id };
}

async function openTask(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const sprint = await requireSprint(ctx, companyId, requiredString(params, "sprintId"));
  const task = sprintTask({ id: sprint.id, name: sprint.name }, requiredString(params, "title"));
  const issue = await ctx.issues.create({
    companyId,
    title: task.title,
    description: task.description,
    status: "todo",
    originKind: task.originKind,
    originId: task.originId,
  });
  return { issueId: issue.id, sprintId: sprint.id };
}

async function requireSprint(ctx: PluginContext, companyId: string, id: string): Promise<{ id: string; name: string }> {
  const rows = await ctx.db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${table(ctx, "sprints")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  const sprint = rows[0];
  if (!sprint) throw new SeoError("Sprint was not found");
  return sprint;
}

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new SeoError("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new SeoError("Company is required");
  return context.companyId;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeoError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new SeoError(`${key} is required`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new SeoError(`${key} must be a string`);
  return value.trim();
}

async function reconcileAll(ctx: PluginContext) {
  try {
    const companies = await ctx.companies.list({ limit: 100 });
    for (const company of companies) await safeReconcile(ctx, company.id);
  } catch (error) {
    ctx.logger.info("SEO skill reconcile deferred", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function safeReconcile(ctx: PluginContext, companyId: string) {
  try {
    await ctx.skills.managed.reconcile("seo-sprint", companyId);
  } catch (error) {
    ctx.logger.info("SEO skill reconcile skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}
