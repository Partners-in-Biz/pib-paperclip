import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  configSaved,
  hireTaskDraft,
  linkAgent,
  listCompanyAgents,
  listCrmClients,
  pluginUiBase,
  registerCrmProjection,
  registerHireWatch,
  rememberPluginUiBase,
  startHire,
  toolFail,
  toolOk,
  unlinkAgent,
} from "@partnersinbiz/pib-plugin-kit";
import { gscRedirectUri, validateSeoConfig } from "./config.js";
import { DAILY_JOB_KEY, SKILL_CANONICAL_KEY, WEEKLY_JOB_KEY } from "./constants.js";
import * as db from "./db.js";
import { dispatch, HANDLERS, toolSummary } from "./dispatch.js";
import { scopeParamValue, scopeRedirect, sprintScope } from "./engine/scope.js";
import { NAMESPACE } from "./namespace.js";
import {
  defaultHireAssignee,
  ensureProject,
  linkPendingHire,
  resolveAgent,
  resyncAgent,
  seoHireStatus,
  seoHireView,
  seoOnLinked,
  type WireResult,
} from "./service/agent.js";
import { asParams, assignableUser, companyInfo, createEnv, errorMessage, reqStr, SeoError, str, type Actor, type Env } from "./service/common.js";
import { gscConnectStart, gscDisconnect, gscOauthComplete } from "./service/gsc.js";
import { runDailyForSprint, runDailyJob, runWeeklyForSprint, runWeeklyJob } from "./service/jobs.js";
import { SEO_ROLE } from "./service/hire.js";
import { detectSignals } from "./service/optimize.js";
import { findClient, scopeParam } from "./service/scope.js";
import { integrationView, sprintView, upgradeLegacySprint } from "./service/sprints.js";
import { clientSummaryRoute } from "./service/summary.js";
import { onIssueUpdated } from "./service/tasks.js";
import { needsYouView, onNeedsYouIssueUpdated } from "./service/needs-you.js";
import { setupChecklist } from "./service/setup.js";
import { siteProjectOptions } from "./service/site.js";
import { loadServiceAccount } from "./service/google-access.js";
import { SEO_TOOLS } from "./tools.js";

let env: Env | null = null;

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    const e = createEnv(ctx);
    env = e;
    for (const tool of SEO_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(e, tool.name, params, run));
    }
    registerActions(e);
    ctx.jobs.register(DAILY_JOB_KEY, async (job) => {
      const result = await runDailyJob(e, { force: job.trigger === "manual" });
      ctx.logger.info("SEO daily job finished", { ...result, trigger: job.trigger });
    });
    ctx.jobs.register(WEEKLY_JOB_KEY, async (job) => {
      const result = await runWeeklyJob(e, { force: job.trigger === "manual" });
      ctx.logger.info("SEO weekly job finished", { ...result, trigger: job.trigger });
    });
    ctx.events.on("issue.updated", async (event) => {
      if (!event.entityId || !event.companyId) return;
      try {
        if (await onNeedsYouIssueUpdated(e, event.companyId, event.entityId)) return;
        await onIssueUpdated(e, event.companyId, event.entityId);
      } catch (error) {
        ctx.logger.info("SEO issue sync failed", { issueId: event.entityId, error: errorMessage(error) });
      }
    });
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await e.skills.ensure(event.companyId).catch(() => []);
    });
    // Links the agent hired through the hire task as soon as it appears.
    registerHireWatch(ctx, [{ role: SEO_ROLE, onLinked: seoOnLinked(e) }]);
    // Clients are CRM companies or CRM contacts (sole traders).
    registerCrmProjection(ctx, NAMESPACE, { companies: true, contacts: true });
    ctx.logger.info("SEO plugin ready");
  },

  async onHealth() {
    if (!env) return { status: "degraded", message: "SEO worker is starting" };
    try {
      const companies = await db.listSprintCompanies(env.ctx.db);
      const missing: string[] = [];
      for (const companyId of companies.slice(0, 5)) {
        if (!(await configSaved(env.ctx, companyId))) missing.push(companyId);
      }
      if (missing.length > 0) {
        return { status: "degraded", message: "SEO settings are not saved for a company with sprints; scheduled work is skipped there.", details: { companiesMissingSettings: missing } };
      }
      return { status: "ok", message: "SEO plugin ready", details: { companiesWithSprints: companies.length } };
    } catch (error) {
      return { status: "degraded", message: `SEO health check failed: ${errorMessage(error)}` };
    }
  },

  async onValidateConfig(config) {
    return validateSeoConfig(config);
  },

  async onConfigChanged() {
    // Config is read per call with an explicit company, so nothing to reload.
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!env) return { status: 503, body: { error: "SEO plugin is not ready" } };
    try {
      if (input.routeKey === "oauth-complete") return await gscOauthComplete(env, input);
      if (input.routeKey === "client-summary") return await clientSummaryRoute(env, input);
      if (input.routeKey === "oauth-start") {
        const actor: Actor = input.actor.actorType === "user" ? { kind: "user", userId: input.actor.userId ?? input.actor.actorId } : { kind: "system" };
        const sprintId = Array.isArray(input.query.sprintId) ? input.query.sprintId[0] : input.query.sprintId;
        const returnTo = Array.isArray(input.query.returnTo) ? input.query.returnTo[0] : input.query.returnTo;
        const body = await gscConnectStart(env, input.companyId, actor, { sprintId, returnTo });
        return { status: 200, body };
      }
      return { status: 404, body: { error: "Unknown route" } };
    } catch (error) {
      return { status: error instanceof SeoError ? 400 : 500, body: { error: errorMessage(error) } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function toolActor(ctx: PluginContext, run: ToolRunContext): Promise<Actor> {
  let responsibleUserId: string | null = null;
  if (run.runId && run.agentId) {
    try {
      const rows = await ctx.db.query<{ responsible_user_id: string | null }>(
        `SELECT responsible_user_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1`,
        [run.runId, run.companyId, run.agentId],
      );
      responsibleUserId = rows[0]?.responsible_user_id ?? null;
    } catch {
      responsibleUserId = null;
    }
  }
  return { kind: "agent", agentId: run.agentId, runId: run.runId ?? null, responsibleUserId };
}

async function runTool(e: Env, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    await e.skills.ensure(run.companyId).catch(() => []);
    const data = await dispatch(e, run.companyId, await toolActor(e.ctx, run), name, params);
    // MCP clients need structuredContent to be an object: never return null, arrays or bare values.
    return toolOk(toolSummary(name, data), data);
  } catch (error) {
    if (!(error instanceof SeoError)) e.ctx.logger.error("SEO tool failed", { tool: name, error: errorMessage(error) });
    return toolFail(errorMessage(error));
  }
}

function actionCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new SeoError("Open the SEO page inside a company");
  return context.companyId;
}

function actionActor(context: PluginPerformActionContext): Actor {
  if (context.actor.type === "user") return { kind: "user", userId: context.actor.userId };
  if (context.actor.type === "agent" && context.actor.agentId) {
    return { kind: "agent", agentId: context.actor.agentId, runId: context.actor.runId, responsibleUserId: null };
  }
  return { kind: "system" };
}

function requireUser(actor: Actor): Extract<Actor, { kind: "user" }> {
  if (actor.kind !== "user") throw new SeoError("This action is for board users");
  return actor;
}

function registerActions(e: Env) {
  const { ctx } = e;
  const action = (key: string, fn: (companyId: string, actor: Actor, params: Record<string, unknown>) => Promise<unknown>) =>
    ctx.actions.register(key, async (params, context) => {
      const companyId = actionCompany(context);
      await e.skills.ensure(companyId).catch(() => []);
      return fn(companyId, actionActor(context), asParams(params));
    });

  action("seo.load", async (companyId, actor, params) => {
    const uiBase = (await rememberPluginUiBase(ctx, params.uiBase)) ?? (await pluginUiBase(ctx));
    // The page is either Partners in Biz's own sites (no client) or one client's workspace.
    const scope = scopeParam(params) ?? null;
    const info = await companyInfo(e, companyId);
    // Backstop for missed agent events: link a pending hire that now has its agent.
    await linkPendingHire(e, companyId);
    const userId = actor.kind === "user" ? actor.userId : null;
    const [sprints, counts, client, agent, hire] = await Promise.all([
      db.listSprints(ctx.db, companyId, { scope }),
      db.sprintCounts(ctx.db, companyId),
      scope ? findClient(e, companyId, scope) : Promise.resolve(null),
      resolveAgent(e, companyId),
      // The agent banner lives on the own page only.
      scope
        ? Promise.resolve(null)
        : seoHireView(e, companyId, userId).catch((error: unknown) => {
            ctx.logger.info("SEO hire status failed", { companyId, error: errorMessage(error) });
            return null;
          }),
    ]);
    const secretSet = async (path: string) => {
      try {
        return Boolean(await info.loaded.secrets.get(path));
      } catch {
        return false;
      }
    };
    const base = info.loaded.config.publicBaseUrl;
    const serviceAccount = await loadServiceAccount(info);
    const setup = scope ? [] : await setupChecklist(e, info, null).catch(() => []);
    return {
      today: info.today,
      timezone: info.timezone,
      userId,
      settings: {
        saved: info.loaded.config.saved,
        publicBaseUrl: base,
        redirectUri: base && uiBase ? gscRedirectUri(base, uiBase) : null,
        googleClientId: Boolean(info.loaded.config.googleClientId),
        googleClientSecret: await secretSet("google.clientSecret"),
        encryptionKey: await secretSet("encryptionKey"),
        pagespeedApiKey: await secretSet("pagespeedApiKey"),
        bingApiKey: await secretSet("bingApiKey"),
        serviceAccountEmail: serviceAccount.key?.clientEmail ?? null,
        serviceAccountError: serviceAccount.error,
        defaultAutopilotMode: info.loaded.config.defaultAutopilotMode,
        dailyHourLocal: info.loaded.config.dailyHourLocal,
      },
      agent,
      hire,
      setup,
      skillKey: SKILL_CANONICAL_KEY,
      scope: scopeParamValue(scope),
      client: scope
        ? {
            kind: scope.kind,
            id: scope.id,
            name: client?.name ?? sprints.find((s) => s.clientName)?.clientName ?? "Unknown client",
            domain: client?.domain ?? null,
            email: client?.email ?? null,
            known: Boolean(client),
          }
        : null,
      clientError: scope && !client
        ? "This client is not in the SEO plugin's CRM list (deleted, or the CRM has not synced it yet). Run CRM resync, then reload. New sprints need the CRM record."
        : null,
      sprints: sprints.map((s) => sprintView(s, info.today, counts[s.id])),
    };
  });

  // Every CRM client, for moving an own sprint (with a legacy free-text client name) to its CRM record.
  action("seo.clients", async (companyId, actor) => {
    requireUser(actor);
    const clients = await listCrmClients(ctx, NAMESPACE, companyId);
    return { clients: clients.map((c) => ({ client: `${c.kind}:${c.id}`, kind: c.kind, id: c.id, name: c.name, detail: c.domain ?? c.email })) };
  });

  action("seo.sprint", async (companyId, _actor, params) => {
    const sprintId = reqStr(params, "sprintId");
    const info = await companyInfo(e, companyId);
    const sprint = await db.getSprint(ctx.db, companyId, sprintId);
    if (!sprint) throw new SeoError("Sprint not found");
    // Opened from the wrong workspace: tell the page which scope the sprint lives in.
    const requested = scopeParam(params);
    const redirect = requested === undefined ? null : scopeRedirect(requested, sprintScope(sprint));
    if (redirect) return { redirect: { ...redirect, clientName: sprint.clientName } };
    const [tasks, keywords, backlinks, content, snapshots, findings, optimizations, integrations, health, counts] = await Promise.all([
      db.listTasks(ctx.db, companyId, sprintId),
      db.listKeywords(ctx.db, companyId, sprintId, { includeRetired: true }),
      db.listBacklinks(ctx.db, companyId, sprintId),
      db.listContent(ctx.db, companyId, sprintId),
      db.listSnapshots(ctx.db, companyId, sprintId),
      db.listFindings(ctx.db, companyId, sprintId, { status: "open", limit: 200 }),
      db.listOptimizations(ctx.db, companyId, sprintId),
      db.listIntegrations(ctx.db, companyId, sprintId),
      db.latestPageHealth(ctx.db, sprintId),
      db.sprintCounts(ctx.db, companyId),
    ]);
    const history = await db.sprintHistory(ctx.db, sprintId, "2000-01-01");
    const [needsYou, setup, projects] = await Promise.all([
      needsYouView(e, info, sprint).catch(() => null),
      setupChecklist(e, info, sprint).catch(() => []),
      siteProjectOptions(e, companyId, sprint.siteUrl).catch(() => []),
    ]);
    const byKeyword: Record<string, Array<{ on: string | null; position: number | null; source: string }>> = {};
    for (const row of history) (byKeyword[row.keywordId] ??= []).push({ on: row.recordedOn, position: row.position, source: row.source });
    return {
      sprint: sprintView(sprint, info.today, counts[sprintId]),
      prefix: info.prefix,
      scoreboard: sprint.scoreboard,
      today: sprint.today,
      tasks,
      keywords: keywords.map((k) => ({ ...k, history: (byKeyword[k.id] ?? []).slice(-60) })),
      backlinks,
      content,
      snapshots,
      findings,
      optimizations,
      integrations: integrations.map(integrationView),
      pageHealth: health,
      needsYou,
      setup,
      projects,
    };
  });

  action("seo.call", async (companyId, actor, params) => {
    const tool = reqStr(params, "tool");
    if (!HANDLERS[tool]) throw new SeoError(`Unknown tool ${tool}`);
    return dispatch(e, companyId, requireUser(actor), tool, params.params ?? {});
  });

  action("seo.create-sprint", async (companyId, actor, params) => {
    const user = requireUser(actor);
    const owner = params.owner === "none" ? "none" : undefined;
    return dispatch(e, companyId, user, "create-sprint", { ...params, owner: undefined, ...(owner ? { ownerUserId: owner } : {}) });
  });

  action("seo.gsc-start", async (companyId, actor, params) => gscConnectStart(e, companyId, requireUser(actor), params));
  action("seo.gsc-disconnect", async (companyId, actor, params) => gscDisconnect(e, companyId, requireUser(actor), params));

  action("seo.integration", async (companyId, actor, params) => {
    requireUser(actor);
    const sprintId = reqStr(params, "sprintId");
    const provider = reqStr(params, "provider");
    if (provider !== "pagespeed" && provider !== "bing") throw new SeoError("provider must be pagespeed or bing");
    const integration = await db.getIntegration(ctx.db, companyId, sprintId, provider);
    if (!integration) throw new SeoError("Integration not found for this sprint");
    const enabled = params.enabled === true;
    const siteUrl = typeof params.propertyUrl === "string" && params.propertyUrl.trim() ? params.propertyUrl.trim() : null;
    await db.updateIntegration(ctx.db, companyId, integration.id, {
      status: enabled ? "enabled" : "disabled",
      ...(provider === "bing" && siteUrl ? { property_url: siteUrl } : {}),
      last_error: null,
    });
    return { provider, enabled };
  });

  // Hiring the SEO agent through a normal Paperclip task (see service/hire.ts).
  action("seo.hire-options", async (companyId, actor) => {
    requireUser(actor);
    const [agents, status] = await Promise.all([listCompanyAgents(ctx, companyId), seoHireStatus(e, companyId)]);
    return { draft: hireTaskDraft(SEO_ROLE), agents, defaultAssigneeAgentId: defaultHireAssignee(agents), status };
  });

  action("seo.start-hire", async (companyId, actor, params) => {
    const user = requireUser(actor);
    const assigneeAgentId = str(params, "assigneeAgentId") ?? null;
    if (assigneeAgentId && !(await ctx.agents.get(assigneeAgentId, companyId))) throw new SeoError("That assignee is not an agent in this company");
    const assigneeUserId = assigneeAgentId ? null : assignableUser(str(params, "assigneeUserId"));
    const hire = await startHire(ctx, companyId, SEO_ROLE, {
      title: str(params, "title", { max: 250 }),
      description: str(params, "description", { max: 50_000 }),
      assigneeAgentId,
      assigneeUserId,
      actorUserId: assignableUser(user.userId),
    });
    return { hire };
  });

  action("seo.link-agent", async (companyId, actor, params) => {
    const user = requireUser(actor);
    const agentId = reqStr(params, "agentId");
    const wired: { result: WireResult | null } = { result: null };
    let linked: Awaited<ReturnType<typeof linkAgent>>;
    try {
      linked = await linkAgent(ctx, companyId, SEO_ROLE, agentId, {
        by: "manual",
        userId: user.userId,
        onLinked: seoOnLinked(e, (result) => {
          wired.result = result;
        }),
      });
    } catch (error) {
      throw new SeoError(errorMessage(error));
    }
    return { agent: linked.agent, steps: linked.steps, instructions: wired.result?.instructions ?? [] };
  });

  action("seo.unlink-agent", async (companyId, actor) => {
    requireUser(actor);
    await unlinkAgent(ctx, companyId, SEO_ROLE);
    return { status: await seoHireStatus(e, companyId) };
  });

  // "Re-sync": wires the linked agent again. It never creates an agent.
  action("seo.activate-agent", async (companyId, actor) => resyncAgent(e, companyId, requireUser(actor)));
  action("seo.sync-skills", async (companyId, actor) => {
    requireUser(actor);
    return { results: await e.skills.force(companyId) };
  });
  action("seo.upgrade-legacy", async (companyId, actor, params) => upgradeLegacySprint(e, companyId, requireUser(actor), params));

  action("seo.run-daily", async (companyId, actor, params) => {
    requireUser(actor);
    const sprint = await db.getSprint(ctx.db, companyId, reqStr(params, "sprintId"));
    if (!sprint) throw new SeoError("Sprint not found");
    if (!sprint.seededAt) throw new SeoError("Start the 90-day plan on this sprint first");
    const info = await companyInfo(e, companyId);
    return runDailyForSprint(e, info, sprint, { agent: await resolveAgent(e, companyId), projectId: await ensureProject(e, companyId) });
  });

  action("seo.run-weekly", async (companyId, actor, params) => {
    requireUser(actor);
    const sprint = await db.getSprint(ctx.db, companyId, reqStr(params, "sprintId"));
    if (!sprint) throw new SeoError("Sprint not found");
    const info = await companyInfo(e, companyId);
    return params.propose === false ? detectSignals(e, info, sprint, { propose: false }) : runWeeklyForSprint(e, info, sprint);
  });
}
