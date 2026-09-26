import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { rememberPluginUiBase, registerCrmProjection } from "@partnersinbiz/pib-plugin-kit";
import { activateAgent } from "./agent.js";
import { listClients } from "./clients.js";
import { createCompanyBootstrap, type CompanyBootstrap } from "./company.js";
import { loadSocialConfig } from "./config.js";
import { deleteExpiredOauthSessions } from "./db.js";
import { SocialError } from "./domain.js";
import { pollInboxJob } from "./inbox.js";
import { importFromUrl, presignUpload, registerAsset } from "./media.js";
import { collectMetricsJob } from "./metrics.js";
import { completeOAuth, confirmPicker, connectBlueskyAccount, OAuthFlowError, pendingOptions, startOAuth } from "./oauth/flow.js";
import { publishDueJob } from "./publish.js";
import { pollRssJob } from "./rss.js";
import {
  accountAnalyticsRecord,
  attachDestination,
  bulkSchedule,
  connectInstructions,
  createPostRecord,
  createRssFeedRecord,
  createTemplateRecord,
  deletePostRecord,
  detachDestination,
  disconnectAccountRecord,
  getPostDetail,
  listAccountsRecord,
  listInboxRecord,
  listMediaRecord,
  listPostsRecord,
  listRssFeedsRecord,
  listTemplatesRecord,
  loadSnapshot,
  markInboxReadRecord,
  objectParams,
  optionalString,
  postAnalyticsRecord,
  recordInboxRecord,
  recordMetricsRecord,
  refreshAccountRecord,
  replyInboxRecord,
  requiredString,
  requireUser,
  retryPostRecord,
  schedulePost,
  setRssActiveRecord,
  transitionPost,
  updateAccountRecord,
  updatePostRecord,
  validatePostRecord,
  type Viewer,
} from "./service.js";
import { SOCIAL_TOOLS } from "./tools.js";
import { refreshTokensJob } from "./tokens.js";

let pluginCtx: PluginContext | null = null;
let bootstrap: CompanyBootstrap | null = null;
const lastRuns: Record<string, { at: string; ok: boolean; summary?: unknown; error?: string }> = {};

// ── viewers ─────────────────────────────────────────────────────────────────

async function responsibleUser(ctx: PluginContext, companyId: string, agentId: string | null, runId: string | null): Promise<string | null> {
  if (!agentId || !runId) return null;
  try {
    const rows = await ctx.db.query<{ responsible_user_id: string | null }>(
      "SELECT responsible_user_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
      [runId, companyId, agentId],
    );
    return rows[0]?.responsible_user_id ?? null;
  } catch {
    return null;
  }
}

async function actionViewer(ctx: PluginContext, context: PluginPerformActionContext): Promise<Viewer> {
  const companyId = context.companyId ?? context.actor.companyId;
  if (!companyId) throw new SocialError("Company is required");
  const isAgent = context.actor.type === "agent";
  const userId = context.actor.type === "user" ? context.actor.userId : await responsibleUser(ctx, companyId, context.actor.agentId, context.actor.runId);
  await bootstrap?.ensure(companyId);
  return { companyId, userId, agentId: context.actor.agentId, runId: context.actor.runId, isAgent };
}

async function toolViewer(ctx: PluginContext, run: ToolRunContext): Promise<Viewer> {
  await bootstrap?.ensure(run.companyId);
  return {
    companyId: run.companyId,
    userId: await responsibleUser(ctx, run.companyId, run.agentId, run.runId),
    agentId: run.agentId,
    runId: run.runId,
    isAgent: true,
  };
}

// ── agent tools ─────────────────────────────────────────────────────────────

async function dispatchTool(ctx: PluginContext, viewer: Viewer, name: string, p: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list-clients":
      return (await listClients(ctx, viewer.companyId)).map((c) => ({ id: c.id, name: c.name, domain: c.domain, lifecycle: c.lifecycle }));
    case "list-connected-accounts":
      return listAccountsRecord(ctx, viewer, p);
    case "connect-account": {
      const config = await loadSocialConfig(ctx, viewer.companyId);
      let redirectUri: string | null = null;
      try {
        redirectUri = config.redirectUri();
      } catch {
        redirectUri = null;
      }
      return connectInstructions(requiredString(p, "platform"), redirectUri);
    }
    case "refresh-account":
      return refreshAccountRecord(ctx, viewer, requiredString(p, "accountId"));
    case "create-post":
      return createPostRecord(ctx, viewer, p);
    case "update-post":
      return updatePostRecord(ctx, viewer, p);
    case "get-post":
      return getPostDetail(ctx, viewer, requiredString(p, "postId"));
    case "list-posts":
      return listPostsRecord(ctx, viewer, p);
    case "validate-post":
      return validatePostRecord(ctx, viewer, requiredString(p, "postId"));
    case "attach-destination":
      return attachDestination(ctx, viewer, p);
    case "detach-destination":
      return detachDestination(ctx, viewer, p);
    case "request-review":
      return transitionPost(ctx, viewer, requiredString(p, "postId"), "review");
    case "schedule-post":
      return schedulePost(ctx, viewer, p);
    case "bulk-schedule":
      return bulkSchedule(ctx, viewer, p);
    case "retry-post":
      return retryPostRecord(ctx, viewer, requiredString(p, "postId"));
    case "create-template":
      return createTemplateRecord(ctx, viewer, p);
    case "list-templates":
      return listTemplatesRecord(ctx, viewer);
    case "list-media-assets":
      return listMediaRecord(ctx, viewer, p);
    case "create-media-asset":
      return registerAsset(ctx, viewer.companyId, p);
    case "import-media-from-url":
      return importFromUrl(ctx, viewer.companyId, p);
    case "create-rss-feed":
      return createRssFeedRecord(ctx, viewer, p);
    case "list-rss-feeds":
      return listRssFeedsRecord(ctx, viewer);
    case "pause-rss-feed":
      return setRssActiveRecord(ctx, viewer, requiredString(p, "feedId"), false);
    case "resume-rss-feed":
      return setRssActiveRecord(ctx, viewer, requiredString(p, "feedId"), true);
    case "record-inbox-item":
      return recordInboxRecord(ctx, viewer, p);
    case "list-inbox":
      return listInboxRecord(ctx, viewer, p);
    case "mark-inbox-read":
      return markInboxReadRecord(ctx, viewer, requiredString(p, "itemId"));
    case "reply-inbox":
      return replyInboxRecord(ctx, viewer, p);
    case "record-post-metrics":
      return recordMetricsRecord(ctx, viewer, p);
    case "post-analytics":
      return postAnalyticsRecord(ctx, viewer, p);
    case "account-analytics":
      return accountAnalyticsRecord(ctx, viewer);
    default:
      throw new SocialError(`Unknown social tool ${name}`);
  }
}

function toolContent(name: string, data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? "null";
  return json.length > 24_000 ? `${json.slice(0, 24_000)}\n… (truncated; narrow the request)` : json;
}

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const viewer = await toolViewer(ctx, run);
    const data = await dispatchTool(ctx, viewer, name, objectParams(params));
    return { content: toolContent(name, data), data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Social tool failed" };
  }
}

// ── UI actions ──────────────────────────────────────────────────────────────

type ActionHandler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) => Promise<unknown>;

const ACTIONS: Record<string, ActionHandler> = {
  "social.load": async (ctx, v, p) => {
    // The page reports /_plugins/<installation uuid>/ui/ so redirect URIs can use it.
    await rememberPluginUiBase(ctx, p.uiBase);
    return loadSnapshot(ctx, v);
  },
  "social.create-post": (ctx, v, p) => createPostRecord(ctx, v, p),
  "social.update-post": (ctx, v, p) => updatePostRecord(ctx, v, p),
  "social.get-post": (ctx, v, p) => getPostDetail(ctx, v, requiredString(p, "postId")),
  "social.validate-post": (ctx, v, p) => validatePostRecord(ctx, v, requiredString(p, "postId")),
  "social.delete-post": (ctx, v, p) => deletePostRecord(ctx, v, requiredString(p, "postId")),
  "social.attach": (ctx, v, p) => attachDestination(ctx, v, p),
  "social.detach": (ctx, v, p) => detachDestination(ctx, v, p),
  "social.review": (ctx, v, p) => transitionPost(ctx, v, requiredString(p, "postId"), "review"),
  "social.back-to-draft": (ctx, v, p) => transitionPost(ctx, v, requiredString(p, "postId"), "draft"),
  "social.approve": (ctx, v, p) => {
    requireUser(v, "approve a post");
    return transitionPost(ctx, v, requiredString(p, "postId"), "approved");
  },
  "social.schedule": (ctx, v, p) => schedulePost(ctx, v, p),
  "social.unschedule": (ctx, v, p) => transitionPost(ctx, v, requiredString(p, "postId"), "approved"),
  "social.retry-post": (ctx, v, p) => retryPostRecord(ctx, v, requiredString(p, "postId")),
  "social.create-template": (ctx, v, p) => createTemplateRecord(ctx, v, p),
  "social.list-templates": (ctx, v) => listTemplatesRecord(ctx, v),
  "social.oauth-start": (ctx, v, p) =>
    startOAuth(ctx, v.companyId, requireUser(v, "connect an account"), {
      platform: requiredString(p, "platform"),
      instanceUrl: optionalString(p, "instanceUrl"),
      defaultSubreddit: optionalString(p, "defaultSubreddit"),
      reconnectAccountId: optionalString(p, "reconnectAccountId"),
      clientRef: optionalString(p, "clientRef"),
    }),
  "social.oauth-pending": (ctx, v, p) => pendingOptions(ctx, v.companyId, requireUser(v, "choose accounts"), requiredString(p, "pickerId")),
  "social.oauth-confirm": (ctx, v, p) => {
    const selections = Array.isArray(p.selections) ? p.selections.filter((s): s is string => typeof s === "string") : [];
    return confirmPicker(ctx, v.companyId, requireUser(v, "choose accounts"), {
      pickerId: requiredString(p, "pickerId"),
      selections,
      clientRef: p.clientRef === undefined ? undefined : optionalString(p, "clientRef") ?? null,
    });
  },
  "social.connect-bluesky": (ctx, v, p) =>
    connectBlueskyAccount(ctx, v.companyId, requireUser(v, "connect an account"), {
      identifier: requiredString(p, "identifier"),
      appPassword: requiredString(p, "appPassword"),
      pdsUrl: optionalString(p, "pdsUrl") ?? null,
      clientRef: optionalString(p, "clientRef") ?? null,
    }),
  "social.disconnect-account": (ctx, v, p) => disconnectAccountRecord(ctx, v, requiredString(p, "accountId")),
  "social.update-account": (ctx, v, p) => updateAccountRecord(ctx, v, p),
  "social.refresh-account": (ctx, v, p) => refreshAccountRecord(ctx, v, requiredString(p, "accountId")),
  "social.media-presign": (ctx, v, p) =>
    presignUpload(ctx, v.companyId, { fileName: requiredString(p, "fileName"), mime: requiredString(p, "mime"), bytes: Number(p.bytes) }),
  "social.create-media-asset": (ctx, v, p) => registerAsset(ctx, v.companyId, p),
  "social.import-media": (ctx, v, p) => importFromUrl(ctx, v.companyId, p),
  "social.create-rss-feed": (ctx, v, p) => createRssFeedRecord(ctx, v, p),
  "social.set-rss-active": (ctx, v, p) => setRssActiveRecord(ctx, v, requiredString(p, "feedId"), p.active === true),
  "social.mark-inbox-read": (ctx, v, p) => markInboxReadRecord(ctx, v, requiredString(p, "itemId")),
  "social.reply-inbox": (ctx, v, p) => replyInboxRecord(ctx, v, p),
  "social.post-analytics": (ctx, v, p) => postAnalyticsRecord(ctx, v, p),
  "social.activate-agent": (ctx, v) => activateAgent(ctx, v.companyId, requireUser(v, "activate the agent")),
  "social.sync-skills": async (ctx, v) => {
    requireUser(v, "sync skills");
    return { results: await bootstrap!.skills.force(v.companyId) };
  },
};

// ── OAuth completion route (called by the static bridge page) ───────────────

async function handleApiRoute(ctx: PluginContext, input: PluginApiRequestInput) {
  if (input.routeKey !== "oauth-complete") return { status: 404, body: { error: "Not found" } };
  try {
    if (input.actor.actorType !== "user") return { status: 403, body: { error: "Only a signed-in person can finish connecting an account." } };
    const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!companyId || companyId !== input.companyId) return { status: 400, body: { error: "companyId is missing or does not match." } };
    if (!state) return { status: 400, body: { error: "state is required" } };
    const rawParams = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawParams)) {
      if (typeof value === "string" && key.length <= 64) params[key] = value.slice(0, 4096);
    }
    await bootstrap?.ensure(companyId);
    const result = await completeOAuth(ctx, { companyId, userId: input.actor.userId ?? input.actor.actorId, state, params });
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    const status = error instanceof OAuthFlowError ? error.status : 400;
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.info("Social OAuth completion failed", { error: message });
    return { status, body: { error: message } };
  }
}

// ── jobs ────────────────────────────────────────────────────────────────────

function registerJob(ctx: PluginContext, key: string, run: () => Promise<unknown>) {
  ctx.jobs.register(key, async () => {
    try {
      const summary = await run();
      lastRuns[key] = { at: new Date().toISOString(), ok: true, summary };
      ctx.logger.info(`Social job ${key} finished`, { summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastRuns[key] = { at: new Date().toISOString(), ok: false, error: message };
      ctx.logger.error(`Social job ${key} failed`, { error: message });
      throw error;
    }
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    bootstrap = createCompanyBootstrap(ctx);
    const ensure = (companyId: string) => bootstrap!.ensure(companyId);

    for (const tool of SOCIAL_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    for (const [key, handler] of Object.entries(ACTIONS)) {
      ctx.actions.register(key, async (params, context) => handler(ctx, await actionViewer(ctx, context), objectParams(params)));
    }

    registerJob(ctx, "publish-due", () => publishDueJob(ctx, ensure));
    registerJob(ctx, "refresh-tokens", async () => {
      const summary = await refreshTokensJob(ctx, ensure);
      await deleteExpiredOauthSessions(ctx).catch(() => undefined);
      return summary;
    });
    registerJob(ctx, "collect-metrics", () => collectMetricsJob(ctx, ensure));
    registerJob(ctx, "poll-inbox", () => pollInboxJob(ctx, ensure));
    registerJob(ctx, "poll-rss", () => pollRssJob(ctx));

    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await ensure(event.companyId);
    });
    registerCrmProjection(ctx, ctx.db.namespace);
  },
  async onHealth() {
    const failing = Object.entries(lastRuns).filter(([, run]) => !run.ok);
    return {
      status: failing.length ? "degraded" : "ok",
      message: failing.length ? `Last run failed: ${failing.map(([key]) => key).join(", ")}` : "Social plugin ready",
      details: { lastRuns },
    };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Social plugin is not ready" } };
    return handleApiRoute(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
