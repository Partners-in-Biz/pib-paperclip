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
  COCKPIT_ROUTE,
  configSaved,
  hireTaskDraft,
  linkAgent,
  listCompanyAgents,
  listCrmClients,
  pluginUiBase,
  registerCrmProjection,
  registerCrmSiteProjection,
  registerHireWatch,
  registerModuleWatch,
  registerRoleWatch,
  SETUP_STATUS_ROUTE,
  rememberPluginUiBase,
  startHire,
  toolFail,
  toolOk,
  trackJob,
  unlinkAgent,
} from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot } from "./cockpit.js";
import { gscRedirectUri, validateSeoConfig } from "./config.js";
import { DAILY_JOB_KEY, PREVIEW_JOB_KEY, SKILL_CANONICAL_KEY, WEEKLY_JOB_KEY } from "./constants.js";
import * as db from "./db.js";
import { dispatch, HANDLERS, toolSummary, UI_ONLY_HANDLERS } from "./dispatch.js";
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
import { deliverPreviewAnswers, handStuckPreviewsToSenior, nudgeStalledReviews, previewRows } from "./service/preview.js";
import { DRAFT_RESULT_EVENT, draftApprovalRequests, onDraftResult, repairDraftLinks } from "./service/client-signoff.js";
import { syncSignoff } from "./service/signoff.js";
import { loadFacts } from "./service/facts.js";
import { onBuildIssueUpdated } from "./service/build.js";
import { ga4Summary, ga4View } from "./service/analytics.js";
import { groupViews, onChunkIssueUpdated, openIdleGroups } from "./service/chunks.js";
import { geoSummary } from "./service/geo.js";
import { companySwitchViews, sprintSwitchViews } from "./service/switches.js";
import { switchesOf } from "./engine/switches.js";
import { runDailyForSprint, runDailyJob, runWeeklyForSprint, runWeeklyJob } from "./service/jobs.js";
import { SEO_MATCH_ROLE, SEO_ROLE } from "./service/hire.js";
import { detectSignals } from "./service/optimize.js";
import { findClient, scopeParam } from "./service/scope.js";
import { advanceReleasedWeeks, integrationView, sprintView, upgradeLegacySprint } from "./service/sprints.js";
import { displayTitle, sprintOverviews, withRunFailures } from "./service/overview.js";
import { isRunning } from "./engine/sprint.js";
import { clientSummaryRoute } from "./service/summary.js";
import { onIssueUpdated, advanceQueuedWeeks } from "./service/tasks.js";
import { guardTaskThreads } from "./service/thread.js";
import { checkAgentClose } from "./service/done-checks.js";
import { needsYouView, onNeedsYouIssueUpdated, parkTasksWaitingOnYou } from "./service/needs-you.js";
import { playbookSummary } from "./service/playbook.js";
import { setupChecklist } from "./service/setup.js";
import { MODULE_OFF_MESSAGE, seoOn, seoSetupStatus } from "./service/setup-status.js";
import { routineViews, saveRoutineReport } from "./service/routines.js";
import { siteLinkView, siteProjectOptions, wordPressSiteOptions } from "./service/site.js";
import { sprintWordPressSite } from "./service/wordpress.js";
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
      // Recorded for the Cockpit's job health (kit jobHealth).
      const result = await trackJob(ctx, DAILY_JOB_KEY, () => runDailyJob(e, { force: job.trigger === "manual" }));
      ctx.logger.info("SEO daily job finished", { ...result, trigger: job.trigger });
    });
    ctx.jobs.register(PREVIEW_JOB_KEY, async () => {
      await syncSignoff(e).catch((error) => ctx.logger.info("SEO sign-off sync failed", { error: errorMessage(error) }));
      await parkTasksWaitingOnYou(e).catch((error) => ctx.logger.info("SEO park waiting tasks failed", { error: errorMessage(error) }));
      await advanceQueuedWeeks(e).catch((error) => ctx.logger.info("SEO queued week advance failed", { error: errorMessage(error) }));
      // "Run through week N": the next week starts when nothing of an earlier week is waiting for the agent.
      await advanceReleasedWeeks(e).catch((error) => ctx.logger.info("SEO run-through week failed", { error: errorMessage(error) }));
      // A page group the host refused to create, or whose close was missed: the next group opens within minutes, not at the next hourly run.
      await db.listSprintCompanies(ctx.db).then(async (companies) => {
        for (const companyId of companies) await openIdleGroups(e, companyId).catch(() => 0);
      }).catch((error) => ctx.logger.info("SEO idle page groups not advanced", { error: errorMessage(error) }));
      await nudgeStalledReviews(e).catch((error) => ctx.logger.info("SEO stalled reviews not nudged", { error: errorMessage(error) }));
      await handStuckPreviewsToSenior(e).catch((error) => ctx.logger.info("SEO stuck previews not handed over", { error: errorMessage(error) }));
      const sent = await deliverPreviewAnswers(e);
      if (sent > 0) ctx.logger.info("SEO preview answers delivered", { sent });
      // Sprints on automatic client sign-off: one approval email draft per batch of passed previews.
      const drafted = await draftApprovalRequests(e).catch((error) => {
        ctx.logger.info("SEO approval drafts failed", { error: errorMessage(error) });
        return 0;
      });
      if (drafted > 0) ctx.logger.info("SEO approval email drafts requested", { drafted });
      await repairDraftLinks(e).catch((error) => ctx.logger.info("SEO draft links not repaired", { error: errorMessage(error) }));
      // Review rounds are what grew two task threads past the limit: check them here, not only hourly.
      const moved = await db.listSprintCompanies(ctx.db).then((companies) => guardTaskThreads(e, companies)).catch((error) => {
        ctx.logger.info("SEO thread guard failed", { error: errorMessage(error) });
        return { checked: 0, rolled: 0 };
      });
      if (moved.rolled > 0) ctx.logger.info("SEO task threads moved to continuation issues", { ...moved });
    });
    ctx.jobs.register(WEEKLY_JOB_KEY, async (job) => {
      const result = await trackJob(ctx, WEEKLY_JOB_KEY, () => runWeeklyJob(e, { force: job.trigger === "manual" }));
      ctx.logger.info("SEO weekly job finished", { ...result, trigger: job.trigger });
    });
    // The Mailbox's answer to an approval email draft request: the Gmail link goes on the sprint's Needs you.
    ctx.events.on(DRAFT_RESULT_EVENT, async (event) => {
      try {
        await onDraftResult(e, event);
      } catch (error) {
        ctx.logger.info("SEO draft result not recorded", { error: errorMessage(error) });
      }
    });
    // One subscription for every issue event (a second one, e.g. kit registerDoneChecks, would deliver each event twice).
    ctx.events.on("issue.updated", async (event) => {
      if (!event.entityId || !event.companyId) return;
      try {
        if (await onNeedsYouIssueUpdated(e, event.companyId, event.entityId)) return;
        if (await onBuildIssueUpdated(e, event.companyId, event.entityId)) return;
        // A page group of a site-wide task: sync it, open the next group, wake the task when the last one closes.
        if (await onChunkIssueUpdated(e, event.companyId, event.entityId)) return;
        // An agent's close of a task issue is checked first: reopened when the sprint data does not show the work,
        // so an early close never marks the task done, tells Social or opens a merge task.
        if (await checkAgentClose(ctx, event)) return;
        await onIssueUpdated(e, event.companyId, event.entityId);
      } catch (error) {
        ctx.logger.info("SEO issue sync failed", { issueId: event.entityId, error: errorMessage(error) });
      }
    });
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await e.skills.ensure(event.companyId).catch(() => []);
    });
    // Links the agent hired through the hire task as soon as it appears.
    // Matching leaves out the operating manual every PiB agent carries (see SEO_MATCH_ROLE).
    registerHireWatch(ctx, [{ role: SEO_MATCH_ROLE, onLinked: seoOnLinked(e) }]);
    // Module switches from the Setup plugin: jobs and agent tools skip companies that switched SEO off.
    registerModuleWatch(ctx);
    // Cockpit roles: sign-offs and out-of-scope PRs go to the Reviewer first when one is set.
    registerRoleWatch(ctx);
    // Clients are CRM companies or CRM contacts (sole traders).
    registerCrmProjection(ctx, NAMESPACE, { companies: true, contacts: true });
    // Client websites (platform, SEO plugin, Connector status) for the wordpress site mode; never the Connector key.
    registerCrmSiteProjection(ctx, NAMESPACE);
    // Tell the CRM which sites need the client's sign-off right away (the 5-minute job repeats it).
    void syncSignoff(e).catch(() => undefined);
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
      if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) {
        if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
        return { status: 200, body: await seoSetupStatus(env, input.companyId) };
      }
      if (input.routeKey === COCKPIT_ROUTE.routeKey) {
        if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
        return { status: 200, body: await cockpitSnapshot(env.ctx, input.companyId) };
      }
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
    // Switched off in Setup: agents (and the SEO routines) get a clear refusal.
    if (!(await seoOn(e, run.companyId))) return toolFail(MODULE_OFF_MESSAGE);
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
    const [sprints, client, agent, hire] = await Promise.all([
      // The SEO home lists every sprint (our own first, then each client's); a client's workspace only that client's.
      db.listSprints(ctx.db, companyId, scope ? { scope } : {}),
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
    // Due, overdue, stuck and waiting: one definition (engine/due.ts) for this page, the tools and the Cockpit.
    const overviews = await sprintOverviews(ctx.db, companyId, sprints, info.today, agent);
    const setup = scope ? [] : await setupChecklist(e, info, null).catch(() => []);
    // Own page: the routines, so the page (a board user) can read their schedules and switch them on.
    const routines = scope ? [] : await routineViews(e, companyId).catch(() => []);
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
      routines,
      skillKey: SKILL_CANONICAL_KEY,
      scope: scopeParamValue(scope),
      // What new sprints of this company start with (the extras, all off unless a person turned one on).
      newSprintExtras: (await companySwitchViews(e, companyId).catch(() => null))?.views ?? [],
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
      sprints: sprints.map((s) => sprintView(s, info.today, overviews.get(s.id))),
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
    const [tasks, keywords, backlinks, content, snapshots, findings, optimizations, integrations, health, agent] = await Promise.all([
      db.listTasks(ctx.db, companyId, sprintId),
      db.listKeywords(ctx.db, companyId, sprintId, { includeRetired: true }),
      db.listBacklinks(ctx.db, companyId, sprintId),
      db.listContent(ctx.db, companyId, sprintId),
      db.listSnapshots(ctx.db, companyId, sprintId),
      db.listFindings(ctx.db, companyId, sprintId, { status: "open", limit: 200 }),
      db.listOptimizations(ctx.db, companyId, sprintId),
      db.listIntegrations(ctx.db, companyId, sprintId),
      db.latestPageHealth(ctx.db, sprintId),
      resolveAgent(e, companyId),
    ]);
    const previews = await previewRows(e, companyId, sprintId).catch(() => []);
    const clientFacts = await loadFacts(e, companyId, sprintId).catch(() => ({ status: "none", facts: [], updatedAt: null }));
    const [history, traffic] = await Promise.all([
      db.sprintHistory(ctx.db, sprintId, "2000-01-01"),
      // Chart series: Search Console clicks and impressions of tracked keywords per day.
      db.sprintTraffic(ctx.db, companyId, sprintId).catch(() => []),
    ]);
    // The extras a person switched on show their numbers; the others show nothing but the switch (extras below).
    const on = switchesOf(sprint);
    const [geo, analytics, groups, extras] = await Promise.all([
      on.geo ? geoSummary(e, sprint).catch(() => null) : Promise.resolve(null),
      on.ga4 ? ga4Summary(e, sprint, { weeks: 13 }).catch(() => null) : Promise.resolve(null),
      groupViews(e, companyId, sprintId).catch(() => new Map()),
      sprintSwitchViews(e, sprint),
    ]);
    const [needsYou, setup, projects, wordpressSites, wpSite, playbook, overviews, timed] = await Promise.all([
      needsYouView(e, info, sprint).catch(() => null),
      setupChecklist(e, info, sprint).catch(() => []),
      siteProjectOptions(e, companyId, sprint.siteUrl).catch(() => []),
      wordPressSiteOptions(e, sprint).catch(() => []),
      sprintWordPressSite(e, sprint),
      playbookSummary(e, sprint).catch(() => null),
      sprintOverviews(ctx.db, companyId, [sprint], info.today, agent),
      // Tasks whose runs stop at the workspace check show as stuck, with the fix (engine/due.ts).
      withRunFailures(ctx.db, companyId, tasks),
    ]);
    const byKeyword: Record<string, Array<{ on: string | null; position: number | null; source: string }>> = {};
    for (const row of history) (byKeyword[row.keywordId] ??= []).push({ on: row.recordedOn, position: row.position, source: row.source });
    return {
      sprint: { ...sprintView(sprint, info.today, overviews.get(sprintId)), site: siteLinkView(sprint, wpSite) },
      prefix: info.prefix,
      scoreboard: sprint.scoreboard,
      today: sprint.today,
      // Template tasks read in their plan's current (plain) words.
      tasks: timed.map((task) => ({ ...task, runsFailing: isRunning(sprint.status) && task.runsFailing, title: displayTitle(task, sprint.templateId) })),
      keywords: keywords.map((k) => ({ ...k, history: (byKeyword[k.id] ?? []).slice(-60) })),
      backlinks,
      content,
      // An extra that is off shows none of its numbers, even from a time it was on.
      snapshots: snapshots.map((snap) => ({ ...snap, geo: on.geo ? snap.geo : {}, analytics: on.ga4 ? snap.analytics : {} })),
      findings,
      optimizations,
      integrations: integrations.filter((i) => i.provider !== "ga4" || on.ga4).map(integrationView),
      // AI-search readiness and sampled AI answers; the GA4 weekly numbers; the page groups of split tasks.
      geo,
      ...(on.ga4 ? { analytics: { ...ga4View(integrations.find((i) => i.provider === "ga4") ?? null), summary: analytics ? { weeks: analytics.weeks, last4: analytics.last4, change: analytics.change, organicShare: analytics.organicShare, attribution: analytics.attribution, keyEvents: analytics.keyEvents, aiReferrals: analytics.aiReferrals } : null } } : {}),
      pageGroups: [...groups.values()],
      // The three extras with their plain words, state and who changed them last (turned on or off from the Integrations tab).
      extras,
      pageHealth: health,
      traffic,
      previews,
      clientFacts,
      needsYou,
      setup,
      projects,
      wordpressSites,
      playbook,
    };
  });

  action("seo.call", async (companyId, actor, params) => {
    const tool = reqStr(params, "tool");
    if (!HANDLERS[tool] && !UI_ONLY_HANDLERS[tool]) throw new SeoError(`Unknown tool ${tool}`);
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

  // The page (a board user) read a routine's schedule triggers from the host; the worker cannot.
  action("seo.routine-report", async (companyId, actor, params) => {
    requireUser(actor);
    return saveRoutineReport(e, companyId, params);
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
