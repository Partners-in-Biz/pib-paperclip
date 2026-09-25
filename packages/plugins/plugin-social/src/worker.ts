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
  claimScheduled,
  destinationsFor,
  duePosts,
  getAccount,
  getPost,
  insertAccount,
  insertDestination,
  insertInboxItem,
  insertMediaAsset,
  insertMetrics,
  insertRssFeed,
  insertPost,
  insertTemplate,
  listAccounts,
  listInboxItems,
  listMediaAssets,
  listPosts,
  listRssFeeds,
  listTemplates,
  metricsForCompany,
  metricsForPost,
  setInboxItemStatus,
  setRssFeedActive,
  publicAccount,
  publicPost,
  saveDestination,
  setPostStatus,
  type AccountRow,
  type PostRow,
} from "./db.js";
import {
  assertAgentTransition,
  assertDestination,
  assertMetric,
  assertTransition,
  aggregateMetrics,
  createInboxItem,
  createMediaAsset,
  createRssFeed,
  createTemplate,
  publishResult,
  SocialError,
  type AccountScope,
  type PostStatus,
} from "./domain.js";
import { SOCIAL_TOOLS } from "./tools.js";

const LOCAL_BOARD_USER_ID = "local-board";

const plugin = definePlugin({
  async setup(ctx) {
    for (const tool of SOCIAL_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    ctx.actions.register("social.load", (_params, context) => load(ctx, context));
    ctx.actions.register("social.create-account", (params, context) => createAccount(ctx, actionViewer(ctx, context), params));
    ctx.actions.register("social.create-post", (params, context) => createPostRecord(ctx, actionViewer(ctx, context), params));
    ctx.actions.register("social.attach", (params, context) => attach(ctx, actionViewer(ctx, context), params));
    ctx.actions.register("social.review", async (params, context) => transition(ctx, await actionViewer(ctx, context), requiredString(params, "postId"), "review", "human"));
    ctx.actions.register("social.approve", (params, context) => approve(ctx, context, params));
    ctx.actions.register("social.schedule", (params, context) => schedule(ctx, actionViewer(ctx, context), params));
    ctx.actions.register("social.create-template", (params, context) => createTemplateAction(ctx, actionViewer(ctx, context), params));
    ctx.actions.register("social.list-templates", (_params, context) => listTemplatesAction(ctx, actionViewer(ctx, context)));
    ctx.jobs.register("publish-due", () => publishDue(ctx));
    ctx.events.on("company.created", async (event) => {
      if (!event.companyId) return;
      try {
        await ctx.skills.managed.reconcile("social-publish", event.companyId);
      } catch (error) {
        ctx.logger.info("Social skill reconcile skipped", { error: error instanceof Error ? error.message : String(error) });
      }
    });
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      for (const company of companies) {
        await ctx.skills.managed.reconcile("social-publish", company.id);
      }
    } catch (error) {
      ctx.logger.info("Social skill reconcile deferred", { error: error instanceof Error ? error.message : String(error) });
    }
  },
  async onHealth() {
    return { status: "ok", message: "Social plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const viewer = await viewerFor(ctx, { companyId: run.companyId, userId: null, agentId: run.agentId, runId: run.runId });
    const body = objectParams(params);
    const data = await dispatch(ctx, viewer, name, body, "agent");
    return { content: name, data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Social tool failed" };
  }
}

async function dispatch(ctx: PluginContext, viewer: Viewer, name: string, body: Record<string, unknown>, source: "agent" | "human") {
  if (name === "create-account") return createAccount(ctx, Promise.resolve(viewer), body);
  if (name === "create-post") return createPostRecord(ctx, Promise.resolve(viewer), body);
  if (name === "attach-destination") return attach(ctx, Promise.resolve(viewer), body);
  if (name === "request-review") return transition(ctx, viewer, requiredString(body, "postId"), "review", source);
  if (name === "schedule-post") return schedule(ctx, Promise.resolve(viewer), body);
  if (name === "create-template") return createTemplateAction(ctx, Promise.resolve(viewer), body);
  if (name === "list-templates") return listTemplatesAction(ctx, Promise.resolve(viewer));
  if (name === "record-post-metrics") return recordMetrics(ctx, Promise.resolve(viewer), body);
  if (name === "post-analytics") return analytics(ctx, Promise.resolve(viewer), body);
  if (name === "create-media-asset") return createMediaAssetAction(ctx, Promise.resolve(viewer), body);
  if (name === "list-media-assets") return listMediaAssetsAction(ctx, Promise.resolve(viewer));
  if (name === "create-rss-feed") return createRssFeedAction(ctx, Promise.resolve(viewer), body);
  if (name === "list-rss-feeds") return listRssFeedsAction(ctx, Promise.resolve(viewer));
  if (name === "pause-rss-feed") return setRssActive(ctx, Promise.resolve(viewer), body, false);
  if (name === "resume-rss-feed") return setRssActive(ctx, Promise.resolve(viewer), body, true);
  if (name === "record-inbox-item") return recordInboxItem(ctx, Promise.resolve(viewer), body);
  if (name === "list-inbox") return listInbox(ctx, Promise.resolve(viewer), body);
  if (name === "mark-inbox-read") return markInboxRead(ctx, Promise.resolve(viewer), body);
  if (name === "bulk-schedule") return bulkSchedule(ctx, Promise.resolve(viewer), body);
  throw new SocialError(`Unknown social tool ${name}`);
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const [accounts, posts] = await Promise.all([listAccounts(ctx, viewer.companyId), listPosts(ctx, viewer.companyId)]);
  const templates = await listTemplates(ctx, viewer.companyId);
  const media = await listMediaAssets(ctx, viewer.companyId);
  return {
    accounts: accounts.filter((account) => accountVisible(viewer, account)).map(publicAccount),
    posts: posts.filter((post) => postVisible(viewer, post)).map(publicPost),
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      body: template.body,
      platform: template.platform,
    })),
    media: media.map((asset) => ({ id: asset.id, name: asset.name, url: asset.url, kind: asset.kind })),
  };
}

async function createTemplateAction(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const template = createTemplate({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    body: requiredString(params, "body"),
    platform: optionalString(params, "platform"),
  });
  await insertTemplate(ctx, {
    id: template.id,
    company_id: template.companyId,
    name: template.name,
    body: template.body,
    platform: template.platform,
  });
  return template;
}

async function listTemplatesAction(ctx: PluginContext, viewerPromise: Promise<Viewer>) {
  const viewer = await viewerPromise;
  const templates = await listTemplates(ctx, viewer.companyId);
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    body: template.body,
    platform: template.platform,
  }));
}

async function recordMetrics(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const views = params.views == null ? 0 : assertMetric(params.views, "views");
  const likes = params.likes == null ? 0 : assertMetric(params.likes, "likes");
  const comments = params.comments == null ? 0 : assertMetric(params.comments, "comments");
  const shares = params.shares == null ? 0 : assertMetric(params.shares, "shares");
  await insertMetrics(ctx, { companyId: viewer.companyId, postId: post.id, views, likes, comments, shares });
  return { postId: post.id, views, likes, comments, shares };
}

async function analytics(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const postId = optionalString(params, "postId");
  const rows = postId
    ? await metricsForPost(ctx, postId)
    : await metricsForCompany(ctx, viewer.companyId);
  const totals = aggregateMetrics(rows.map((row) => ({
    views: Number(row.views ?? 0),
    likes: Number(row.likes ?? 0),
    comments: Number(row.comments ?? 0),
    shares: Number(row.shares ?? 0),
  })));
  return { postId: postId ?? null, ...totals, snapshots: rows.length };
}

async function createMediaAssetAction(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const asset = createMediaAsset({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    url: requiredString(params, "url"),
    kind: optionalString(params, "kind"),
  });
  await insertMediaAsset(ctx, {
    id: asset.id,
    company_id: asset.companyId,
    name: asset.name,
    url: asset.url,
    kind: asset.kind,
  });
  return asset;
}

async function listMediaAssetsAction(ctx: PluginContext, viewerPromise: Promise<Viewer>) {
  const viewer = await viewerPromise;
  const assets = await listMediaAssets(ctx, viewer.companyId);
  return assets.map((asset) => ({ id: asset.id, name: asset.name, url: asset.url, kind: asset.kind }));
}

async function createRssFeedAction(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const feed = createRssFeed({
    companyId: viewer.companyId,
    url: requiredString(params, "url"),
    accountId: optionalString(params, "accountId"),
  });
  await insertRssFeed(ctx, {
    id: feed.id,
    company_id: feed.companyId,
    url: feed.url,
    account_id: feed.accountId,
    is_active: feed.isActive,
    last_checked_at: null,
  });
  return feed;
}

async function listRssFeedsAction(ctx: PluginContext, viewerPromise: Promise<Viewer>) {
  const viewer = await viewerPromise;
  const feeds = await listRssFeeds(ctx, viewer.companyId);
  return feeds.map((feed) => ({
    id: feed.id,
    url: feed.url,
    accountId: feed.account_id,
    isActive: feed.is_active,
    lastCheckedAt: feed.last_checked_at == null ? null : String(feed.last_checked_at),
  }));
}

async function setRssActive(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>, active: boolean) {
  const viewer = await viewerPromise;
  const id = requiredString(params, "feedId");
  const changed = await setRssFeedActive(ctx, viewer.companyId, id, active);
  if (!changed) throw new SocialError("RSS feed was not found");
  return { feedId: id, isActive: active };
}

async function recordInboxItem(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const item = createInboxItem({
    companyId: viewer.companyId,
    kind: requiredString(params, "kind"),
    body: requiredString(params, "body"),
    accountId: optionalString(params, "accountId"),
    author: optionalString(params, "author"),
  });
  await insertInboxItem(ctx, {
    id: item.id,
    company_id: item.companyId,
    account_id: item.accountId,
    kind: item.kind,
    author: item.author,
    body: item.body,
    status: item.status,
    created_at: null,
  });
  return item;
}

async function listInbox(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const limit = params.limit == null ? 50 : integer(params.limit, "limit");
  const rows = await listInboxItems(ctx, viewer.companyId, limit);
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    author: row.author,
    body: row.body,
    status: row.status,
    createdAt: row.created_at == null ? null : String(row.created_at),
  }));
}

async function markInboxRead(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const id = requiredString(params, "itemId");
  const changed = await setInboxItemStatus(ctx, viewer.companyId, id, "read");
  if (!changed) throw new SocialError("Inbox item was not found");
  return { itemId: id, status: "read" };
}

async function bulkSchedule(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const postIds = params.postIds;
  if (!Array.isArray(postIds) || postIds.length === 0) throw new SocialError("postIds must be a non-empty list");
  const scheduledAt = requiredString(params, "scheduledAt");
  if (Number.isNaN(Date.parse(scheduledAt))) throw new SocialError("scheduledAt must be a time");
  let scheduled = 0;
  for (const rawId of postIds) {
    if (typeof rawId !== "string") continue;
    const post = await requirePost(ctx, viewer, rawId);
    assertTransition(post.status, "scheduled");
    await setPostStatus(ctx, post.id, "scheduled", scheduledAt);
    scheduled += 1;
  }
  return { scheduled, scheduledAt };
}

async function createAccount(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const scope = scopeOf(requiredString(params, "scope"));
  if (scope === "personal" && !viewer.userId) throw new SocialError("A personal account needs its owner");
  const row: AccountRow = {
    id: randomUUID(),
    company_id: viewer.companyId,
    platform: requiredString(params, "platform"),
    scope,
    owner_user_id: scope === "personal" ? viewer.userId : null,
    status: "connected",
    secret_ref: optionalString(params, "secretRef") ?? null,
    display_name: requiredString(params, "displayName"),
  };
  await insertAccount(ctx, row);
  return publicAccount(row);
}

async function createPostRecord(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const scope = params.scope == null ? "org" : scopeOf(requiredString(params, "scope"));
  if (scope === "personal" && !viewer.userId) throw new SocialError("A personal post needs its owner");
  const row: PostRow = {
    id: randomUUID(),
    company_id: viewer.companyId,
    body: requiredString(params, "body"),
    status: "draft",
    scheduled_at: null,
    scope,
    owner_user_id: scope === "personal" ? viewer.userId : viewer.userId,
  };
  await insertPost(ctx, row);
  return publicPost(row);
}

async function attach(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const account = await requireAccount(ctx, viewer, requiredString(params, "accountId"));
  assertDestination({
    postScope: post.scope,
    accountScope: account.scope,
    accountOwnerUserId: account.owner_user_id,
    actorUserId: viewer.userId,
  });
  const id = await insertDestination(ctx, { companyId: viewer.companyId, postId: post.id, accountId: account.id });
  return { id, postId: post.id, accountId: account.id };
}

async function approve(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  if (context.actor.type !== "user") throw new SocialError("A person approves a post");
  const viewer = await actionViewer(ctx, context);
  return transition(ctx, viewer, requiredString(params, "postId"), "approved", "human");
}

async function schedule(ctx: PluginContext, viewerPromise: Promise<Viewer>, params: Record<string, unknown>) {
  const viewer = await viewerPromise;
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  assertTransition(post.status, "scheduled");
  const scheduledAt = requiredString(params, "scheduledAt");
  if (Number.isNaN(Date.parse(scheduledAt))) throw new SocialError("scheduledAt must be a time");
  await setPostStatus(ctx, post.id, "scheduled", scheduledAt);
  return { id: post.id, status: "scheduled", scheduledAt };
}

async function transition(ctx: PluginContext, viewer: Viewer, postId: string, to: PostStatus, source: "agent" | "human") {
  const post = await requirePost(ctx, viewer, postId);
  if (source === "agent") assertAgentTransition(post.status, to);
  else assertTransition(post.status, to);
  await setPostStatus(ctx, post.id, to, post.scheduled_at == null ? null : String(post.scheduled_at));
  return { id: post.id, status: to };
}

async function publishDue(ctx: PluginContext) {
  const posts = await duePosts(ctx);
  for (const post of posts) {
    const claimed = await claimScheduled(ctx, post.id);
    if (claimed === 0) continue;
    const destinations = await destinationsFor(ctx, post.id);
    if (destinations.length === 0) {
      await setPostStatus(ctx, post.id, "failed", post.scheduled_at == null ? null : String(post.scheduled_at));
      continue;
    }
    let failed = false;
    for (const destination of destinations) {
      const account = await getAccount(ctx, destination.account_id);
      const outcome = publishResult(account?.secret_ref ?? null);
      if (outcome.status === "failed") failed = true;
      await saveDestination(ctx, destination.id, outcome.status, outcome.result);
    }
    await setPostStatus(ctx, post.id, failed ? "failed" : "published", post.scheduled_at == null ? null : String(post.scheduled_at));
  }
}

interface Viewer {
  companyId: string;
  userId: string | null;
  agentId: string | null;
}

async function viewerFor(ctx: PluginContext, input: { companyId: string; userId: string | null; agentId: string | null; runId?: string | null }): Promise<Viewer> {
  let userId = input.userId;
  if (!userId && input.runId && input.agentId) {
    const rows = await ctx.db.query<{ responsible_user_id: string | null }>(
      `SELECT responsible_user_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1`,
      [input.runId, input.companyId, input.agentId],
    );
    userId = rows[0]?.responsible_user_id ?? null;
  }
  return { companyId: input.companyId, userId, agentId: input.agentId };
}

async function actionViewer(ctx: PluginContext, context: PluginPerformActionContext): Promise<Viewer> {
  if (!context.companyId) throw new SocialError("Company is required");
  const userId = context.actor.userId === LOCAL_BOARD_USER_ID ? context.actor.userId : context.actor.userId;
  return viewerFor(ctx, { companyId: context.companyId, userId, agentId: context.actor.agentId, runId: context.actor.runId });
}

function accountVisible(viewer: Viewer, account: AccountRow): boolean {
  if (account.company_id !== viewer.companyId) return false;
  if (account.scope === "org") return true;
  return account.owner_user_id === viewer.userId;
}

function postVisible(viewer: Viewer, post: PostRow): boolean {
  if (post.company_id !== viewer.companyId) return false;
  if (post.scope === "org") return true;
  return post.owner_user_id === viewer.userId;
}

async function requirePost(ctx: PluginContext, viewer: Viewer, id: string): Promise<PostRow> {
  const post = await getPost(ctx, id);
  if (!post || !postVisible(viewer, post)) throw new SocialError("Post is not visible");
  return post;
}

async function requireAccount(ctx: PluginContext, viewer: Viewer, id: string): Promise<AccountRow> {
  const account = await getAccount(ctx, id);
  if (!account || !accountVisible(viewer, account)) throw new SocialError("Account is not visible");
  return account;
}

function scopeOf(value: string): AccountScope {
  if (value !== "org" && value !== "personal") throw new SocialError("Scope must be org or personal");
  return value;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new SocialError(`${key} is required`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new SocialError(`${key} must be a string`);
  return value.trim();
}

function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 1) throw new SocialError(`${key} must be a positive integer`);
  return amount;
}
