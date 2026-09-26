/**
 * Operations shared by UI actions and agent tools. Every function takes the
 * viewer (company + actor) resolved by the host; ids from params are always
 * re-checked against the viewer's company.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AccountUnavailable, publicAccount, refreshAccountToken } from "./accounts.js";
import { agentSummary } from "./agent.js";
import { listClients, resolveClient } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import {
  accountMeta,
  accountMetrics,
  deleteDestination,
  deletePost,
  destinationsForCompany,
  destinationsForPost,
  disconnectAccount,
  getAccount,
  getInboxItem,
  getPost,
  insertDestination,
  insertInboxItem,
  insertMetrics,
  insertPost,
  insertRssFeed,
  insertTemplate,
  iso,
  listAccounts,
  listInboxItems,
  listMediaAssets,
  listPendingPickers,
  listPosts,
  listRssFeeds,
  listTemplates,
  metricsForCompany,
  metricsForPost,
  postMedia,
  postOverrides,
  setInboxItemStatus,
  setPostStatus,
  setRssFeedActive,
  updateAccountSettings,
  updatePostContent,
  type AccountRow,
  type DestinationRow,
  type MetricsRow,
  type PostRow,
} from "./db.js";
import {
  aggregateMetrics,
  assertAgentTransition,
  assertDestination,
  assertEditable,
  assertMetric,
  assertTransition,
  createInboxItem,
  createRssFeed,
  createTemplate,
  normalizeSubreddit,
  SocialError,
  type AccountScope,
} from "./domain.js";
import { replyToInboxItem } from "./inbox.js";
import { assetOut, mediaFromAssetIds } from "./media.js";
import { providerFor } from "./oauth/registry.js";
import {
  ALL_PLATFORMS,
  CONNECT_MODE,
  isSocialPlatform,
  OVERRIDE_FIELDS,
  PLATFORM_LABELS,
  type PlatformOverride,
  type PostStatus,
  type SocialPlatform,
} from "./platforms.js";
import { buildPublishRequest, retryPost, validateDestination } from "./publish.js";

export interface Viewer {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  isAgent: boolean;
}

// ── params ──────────────────────────────────────────────────────────────────

export function objectParams(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new SocialError("Parameters must be an object");
  return value as Record<string, unknown>;
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new SocialError(`${key} is required`);
  return value.trim();
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new SocialError(`${key} must be a string`);
  return value.trim();
}

function stringList(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new SocialError(`${key} must be a list of ids`);
  return Array.from(new Set((value as string[]).map((v) => v.trim()).filter(Boolean)));
}

function positiveInt(value: unknown, key: string, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SocialError(`${key} must be a positive integer`);
  return n;
}

function isoTime(value: string, key: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new SocialError(`${key} must be an ISO date-time, e.g. 2026-10-05T07:30:00+02:00`);
  return new Date(time).toISOString();
}

/** Validate and normalise the platform-keyed overrides object. */
export function normalizeOverrides(value: unknown): Partial<Record<SocialPlatform, PlatformOverride>> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new SocialError("overrides must be an object keyed by platform");
  const out: Partial<Record<SocialPlatform, PlatformOverride>> = {};
  for (const [platform, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isSocialPlatform(platform)) throw new SocialError(`Unknown platform in overrides: ${platform}`);
    if (raw == null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new SocialError(`overrides.${platform} must be an object`);
    const entry: PlatformOverride = {};
    for (const [field, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null || v === "") continue;
      if (!(OVERRIDE_FIELDS[platform] as string[]).includes(field)) {
        throw new SocialError(`${PLATFORM_LABELS[platform]} does not take an override for "${field}" (allowed: ${OVERRIDE_FIELDS[platform].join(", ")})`);
      }
      if (typeof v !== "string") throw new SocialError(`overrides.${platform}.${field} must be text`);
      const trimmed = v.trim();
      if (!trimmed) continue;
      if (field === "link" && !/^https?:\/\//i.test(trimmed)) throw new SocialError(`overrides.${platform}.link must start with http(s)://`);
      if (field === "subreddit") {
        const sr = normalizeSubreddit(trimmed);
        if (!sr) throw new SocialError("overrides.reddit.subreddit must be a subreddit name like smallbusiness");
        entry.subreddit = sr;
        continue;
      }
      (entry as Record<string, string>)[field] = trimmed;
    }
    if (Object.keys(entry).length) out[platform] = entry;
  }
  return out;
}

// ── visibility ──────────────────────────────────────────────────────────────

export function accountVisible(viewer: Viewer, account: AccountRow): boolean {
  if (account.company_id !== viewer.companyId) return false;
  if (account.scope === "org") return true;
  return account.owner_user_id === viewer.userId;
}

export function postVisible(viewer: Viewer, post: PostRow): boolean {
  if (post.company_id !== viewer.companyId) return false;
  if (post.scope === "org") return true;
  return post.owner_user_id === viewer.userId;
}

export async function requirePost(ctx: PluginContext, viewer: Viewer, id: string): Promise<PostRow> {
  const post = await getPost(ctx, viewer.companyId, id);
  if (!post || !postVisible(viewer, post)) throw new SocialError("Post is not visible");
  return post;
}

export async function requireAccount(ctx: PluginContext, viewer: Viewer, id: string): Promise<AccountRow> {
  const account = await getAccount(ctx, viewer.companyId, id);
  if (!account || !accountVisible(viewer, account)) throw new SocialError("Account is not visible");
  return account;
}

export function requireUser(viewer: Viewer, what: string): string {
  if (viewer.isAgent || !viewer.userId) throw new SocialError(`A person must ${what}`);
  return viewer.userId;
}

// ── output shapes ───────────────────────────────────────────────────────────

function destinationOut(d: DestinationRow, account: AccountRow | undefined) {
  return {
    id: d.id,
    accountId: d.account_id,
    platform: account?.platform ?? null,
    accountName: account?.display_name ?? "Removed account",
    accountStatus: account?.status ?? null,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: iso(d.next_attempt_at),
    externalId: d.external_id,
    externalUrl: d.external_url,
    lastError: d.last_error,
    publishedAt: iso(d.published_at),
    issueId: d.issue_id,
  };
}

export function postOut(row: PostRow, destinations: DestinationRow[] = [], accounts: Map<string, AccountRow> = new Map()) {
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    scheduledAt: iso(row.scheduled_at),
    publishedAt: iso(row.published_at),
    clientRef: row.client_ref,
    clientName: row.client_name,
    firstComment: row.first_comment,
    media: postMedia(row),
    overrides: postOverrides(row),
    source: row.source ?? "manual",
    error: row.error,
    failureIssueId: row.failure_issue_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    destinations: destinations.map((d) => destinationOut(d, accounts.get(d.account_id))),
  };
}

// ── posts ───────────────────────────────────────────────────────────────────

async function attachAccounts(ctx: PluginContext, viewer: Viewer, post: PostRow, accountIds: string[]): Promise<void> {
  for (const accountId of accountIds) {
    const account = await requireAccount(ctx, viewer, accountId);
    assertDestination({ postScope: post.scope, accountScope: account.scope, accountOwnerUserId: account.owner_user_id, actorUserId: viewer.userId });
    await insertDestination(ctx, { companyId: viewer.companyId, postId: post.id, accountId: account.id });
  }
}

export async function createPostRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const body = requiredString(params, "body");
  const scopeInput = optionalString(params, "scope") ?? "org";
  if (scopeInput !== "org" && scopeInput !== "personal") throw new SocialError("scope must be org or personal");
  const scope = scopeInput as AccountScope;
  if (scope === "personal" && !viewer.userId) throw new SocialError("A personal post needs its owner");
  const client = await resolveClient(ctx, viewer.companyId, params.clientRef);
  const media = (await mediaFromAssetIds(ctx, viewer.companyId, params.mediaAssetIds)) ?? [];
  const overrides = normalizeOverrides(params.overrides) ?? {};
  const row = {
    id: randomUUID(),
    company_id: viewer.companyId,
    body,
    status: "draft" as PostStatus,
    scope,
    owner_user_id: viewer.userId,
    media,
    overrides,
    first_comment: optionalString(params, "firstComment") ?? null,
    client_ref: client?.clientRef ?? null,
    client_name: client?.clientName ?? null,
    source: viewer.isAgent ? "agent" : "manual",
    source_ref: null,
    created_by_agent_id: viewer.agentId,
  };
  await insertPost(ctx, row);
  const post = (await getPost(ctx, viewer.companyId, row.id))!;
  const accountIds = stringList(params, "accountIds") ?? [];
  await attachAccounts(ctx, viewer, post, accountIds);
  return getPostDetail(ctx, viewer, row.id);
}

export async function updatePostRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  assertEditable(post.status);
  const client = await resolveClient(ctx, viewer.companyId, params.clientRef);
  const body = params.body === undefined ? undefined : requiredString(params, "body");
  await updatePostContent(ctx, viewer.companyId, post.id, {
    body,
    media: await mediaFromAssetIds(ctx, viewer.companyId, params.mediaAssetIds),
    overrides: normalizeOverrides(params.overrides),
    firstComment: params.firstComment === undefined ? undefined : optionalString(params, "firstComment") ?? null,
    clientRef: client?.clientRef,
    clientName: client ? client.clientName : undefined,
  });
  const accountIds = stringList(params, "accountIds");
  if (accountIds) await attachAccounts(ctx, viewer, post, accountIds);
  return getPostDetail(ctx, viewer, post.id);
}

export async function getPostDetail(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  const destinations = await destinationsForPost(ctx, post.id);
  const accounts = new Map((await listAccounts(ctx, viewer.companyId)).map((a) => [a.id, a]));
  return postOut(post, destinations, accounts);
}

export async function listPostsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const rows = await listPosts(ctx, viewer.companyId, {
    status: optionalString(params, "status"),
    clientRef: optionalString(params, "clientRef"),
    limit: positiveInt(params.limit, "limit", 50),
  });
  const visible = rows.filter((row) => postVisible(viewer, row));
  const destinations = await destinationsForCompany(ctx, viewer.companyId);
  const accounts = new Map((await listAccounts(ctx, viewer.companyId)).map((a) => [a.id, a]));
  const byPost = new Map<string, DestinationRow[]>();
  for (const d of destinations) byPost.set(d.post_id, [...(byPost.get(d.post_id) ?? []), d]);
  return visible.map((row) => postOut(row, byPost.get(row.id) ?? [], accounts));
}

export async function validatePostRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  const destinations = await destinationsForPost(ctx, post.id);
  const results = [];
  const problems: string[] = [];
  if (destinations.length === 0) problems.push("Attach at least one destination account");
  for (const d of destinations) {
    const account = await getAccount(ctx, viewer.companyId, d.account_id);
    if (!account || !isSocialPlatform(account.platform)) continue;
    if (d.status === "published") {
      results.push({ accountId: account.id, platform: account.platform, accountName: account.display_name, problems: [] as string[], published: true });
      continue;
    }
    const list = validateDestination(account.platform, buildPublishRequest(post, account.platform), accountMeta(account));
    if (!account.token_enc || account.status === "disabled") list.push(`${account.display_name} is disconnected`);
    else if (account.status === "needs_reconnect") list.push(`${account.display_name} needs to be reconnected`);
    results.push({ accountId: account.id, platform: account.platform, accountName: account.display_name, problems: list, published: false });
    problems.push(...list.map((p) => `${PLATFORM_LABELS[account.platform as SocialPlatform]} (${account.display_name}): ${p}`));
  }
  return { postId: post.id, ok: problems.length === 0, problems, destinations: results };
}

export async function attachDestination(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  if (post.status === "published" || post.status === "publishing") throw new SocialError(`A ${post.status} post cannot take new destinations`);
  await attachAccounts(ctx, viewer, post, [requiredString(params, "accountId")]);
  return getPostDetail(ctx, viewer, post.id);
}

export async function detachDestination(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const removed = await deleteDestination(ctx, viewer.companyId, post.id, requiredString(params, "accountId"));
  if (!removed) throw new SocialError("Only pending or failed destinations can be removed");
  return getPostDetail(ctx, viewer, post.id);
}

export async function transitionPost(ctx: PluginContext, viewer: Viewer, postId: string, to: PostStatus) {
  const post = await requirePost(ctx, viewer, postId);
  if (viewer.isAgent) assertAgentTransition(post.status, to);
  else assertTransition(post.status, to);
  if (to === "approved") requireUser(viewer, "approve a post");
  const clearSchedule = to === "draft" || to === "approved" ? null : undefined;
  if (!(await setPostStatus(ctx, viewer.companyId, post.id, [post.status], to, clearSchedule))) {
    throw new SocialError("The post changed while you were editing it. Reload and try again.");
  }
  return getPostDetail(ctx, viewer, post.id);
}

export async function schedulePost(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  assertTransition(post.status, "scheduled");
  const scheduledAt = isoTime(requiredString(params, "scheduledAt"), "scheduledAt");
  const check = await validatePostRecord(ctx, viewer, post.id);
  if (!check.ok) throw new SocialError(`Fix these before scheduling: ${check.problems.join("; ")}`);
  if (!(await setPostStatus(ctx, viewer.companyId, post.id, ["approved"], "scheduled", scheduledAt))) {
    throw new SocialError("Only an approved post can be scheduled");
  }
  return getPostDetail(ctx, viewer, post.id);
}

export async function bulkSchedule(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const postIds = stringList(params, "postIds");
  if (!postIds || postIds.length === 0) throw new SocialError("postIds must be a non-empty list");
  const scheduledAt = requiredString(params, "scheduledAt");
  const results = [];
  for (const postId of postIds) {
    try {
      await schedulePost(ctx, viewer, { postId, scheduledAt });
      results.push({ postId, ok: true });
    } catch (error) {
      results.push({ postId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { scheduled: results.filter((r) => r.ok).length, scheduledAt: isoTime(scheduledAt, "scheduledAt"), results };
}

export async function retryPostRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  const result = await retryPost(ctx, viewer.companyId, post);
  return { ...result, message: `${result.reset} destination(s) will be retried within 5 minutes.`, post: await getPostDetail(ctx, viewer, post.id) };
}

export async function deletePostRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  requireUser(viewer, "delete a post");
  const post = await requirePost(ctx, viewer, postId);
  if (!(await deletePost(ctx, viewer.companyId, post.id))) throw new SocialError("Only draft, review or approved posts can be deleted");
  return { deleted: post.id };
}

// ── accounts ────────────────────────────────────────────────────────────────

export async function listAccountsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const clientRef = optionalString(params, "clientRef");
  const platform = optionalString(params, "platform");
  return (await listAccounts(ctx, viewer.companyId))
    .filter((a) => accountVisible(viewer, a))
    .filter((a) => !clientRef || a.client_ref === clientRef)
    .filter((a) => !platform || a.platform === platform)
    .map(publicAccount);
}

export async function updateAccountRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "change account settings");
  const account = await requireAccount(ctx, viewer, requiredString(params, "accountId"));
  const client = await resolveClient(ctx, viewer.companyId, params.clientRef);
  const meta: Record<string, unknown> = {};
  if (params.defaultSubreddit !== undefined) {
    if (account.platform !== "reddit") throw new SocialError("Only Reddit accounts have a default subreddit");
    const sr = params.defaultSubreddit ? normalizeSubreddit(String(params.defaultSubreddit)) : null;
    if (params.defaultSubreddit && !sr) throw new SocialError("Enter a subreddit name like smallbusiness");
    meta.defaultSubreddit = sr;
  }
  if (params.boardId !== undefined) {
    if (account.platform !== "pinterest") throw new SocialError("Only Pinterest accounts have a board");
    meta.boardId = optionalString(params, "boardId") ?? null;
  }
  let status: string | undefined;
  if (params.enabled === false) status = "disabled";
  if (params.enabled === true) {
    if (!account.token_enc) throw new SocialError("This account has no token; reconnect it instead");
    status = "connected";
  }
  await updateAccountSettings(ctx, viewer.companyId, account.id, {
    clientRef: client?.clientRef,
    clientName: client ? client.clientName : undefined,
    meta: Object.keys(meta).length ? meta : undefined,
    status,
  });
  return publicAccount((await getAccount(ctx, viewer.companyId, account.id))!);
}

export async function disconnectAccountRecord(ctx: PluginContext, viewer: Viewer, accountId: string) {
  const userId = requireUser(viewer, "disconnect an account");
  const account = await requireAccount(ctx, viewer, accountId);
  await disconnectAccount(ctx, viewer.companyId, account.id, `Disconnected by a person (${userId})`);
  return { accountId: account.id, status: "disabled" };
}

export async function refreshAccountRecord(ctx: PluginContext, viewer: Viewer, accountId: string) {
  const account = await requireAccount(ctx, viewer, accountId);
  if (!isSocialPlatform(account.platform)) throw new SocialError("Unsupported platform");
  const provider = providerFor(account.platform);
  if (!provider.refresh || provider.refreshKind === "none") {
    return { accountId: account.id, refreshed: false, reason: `${PLATFORM_LABELS[account.platform]} tokens do not expire or cannot be refreshed` };
  }
  const config = await loadSocialConfig(ctx, viewer.companyId);
  try {
    const { row } = await refreshAccountToken(ctx, config, account);
    return { accountId: account.id, refreshed: true, expiresAt: iso(row.token_expires_at) };
  } catch (error) {
    if (error instanceof AccountUnavailable) throw new SocialError(error.message);
    throw error;
  }
}

export function connectInstructions(platformInput: string, redirectUri: string | null) {
  if (!isSocialPlatform(platformInput)) throw new SocialError(`Unknown platform ${platformInput}`);
  const label = PLATFORM_LABELS[platformInput];
  const mode = CONNECT_MODE[platformInput];
  return {
    platform: platformInput,
    label,
    instructions:
      mode === "credentials"
        ? `Ask a person to open Social → Accounts, click Connect ${label} and enter the handle and an app password (Settings → App passwords on Bluesky).`
        : mode === "instance"
          ? `Ask a person to open Social → Accounts, enter the Mastodon instance URL and click Connect ${label}.`
          : `Ask a person to open Social → Accounts and click Connect ${label}. They sign in with ${label} and, when asked, choose which pages/boards/channels to add.`,
    redirectUri,
  };
}

// ── templates, feeds, inbox, analytics ──────────────────────────────────────

export async function createTemplateRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const template = createTemplate({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    body: requiredString(params, "body"),
    platform: optionalString(params, "platform"),
  });
  await insertTemplate(ctx, { id: template.id, company_id: template.companyId, name: template.name, body: template.body, platform: template.platform });
  return template;
}

export async function listTemplatesRecord(ctx: PluginContext, viewer: Viewer) {
  return (await listTemplates(ctx, viewer.companyId)).map((t) => ({ id: t.id, name: t.name, body: t.body, platform: t.platform }));
}

export async function listMediaRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const clientRef = optionalString(params, "clientRef");
  return (await listMediaAssets(ctx, viewer.companyId)).filter((m) => !clientRef || m.client_ref === clientRef || !m.client_ref).map(assetOut);
}

function feedOut(feed: Awaited<ReturnType<typeof listRssFeeds>>[number]) {
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    accountIds: Array.from(new Set([...(feed.account_ids ?? []), ...(feed.account_id ? [feed.account_id] : [])])),
    isActive: feed.is_active,
    lastCheckedAt: iso(feed.last_checked_at),
    lastError: feed.last_error,
    lastItemAt: iso(feed.last_item_at),
    clientRef: feed.client_ref,
    clientName: feed.client_name,
  };
}

export async function createRssFeedRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const draft = createRssFeed({ companyId: viewer.companyId, url: requiredString(params, "url") });
  const accountIds = Array.from(new Set([...(stringList(params, "accountIds") ?? []), ...(optionalString(params, "accountId") ? [optionalString(params, "accountId")!] : [])]));
  for (const id of accountIds) {
    const account = await requireAccount(ctx, viewer, id);
    if (account.scope !== "org") throw new SocialError("RSS drafts can only target organisation accounts");
  }
  const client = await resolveClient(ctx, viewer.companyId, params.clientRef);
  await insertRssFeed(ctx, {
    id: draft.id,
    company_id: viewer.companyId,
    url: draft.url,
    account_id: accountIds[0] ?? null,
    account_ids: accountIds,
    client_ref: client?.clientRef ?? null,
    client_name: client?.clientName ?? null,
    created_by_user_id: viewer.userId,
  });
  return { id: draft.id, url: draft.url, accountIds, isActive: true, message: "The feed is checked every 15 minutes; new items become draft posts." };
}

export async function listRssFeedsRecord(ctx: PluginContext, viewer: Viewer) {
  return (await listRssFeeds(ctx, viewer.companyId)).map(feedOut);
}

export async function setRssActiveRecord(ctx: PluginContext, viewer: Viewer, feedId: string, active: boolean) {
  if (!(await setRssFeedActive(ctx, viewer.companyId, feedId, active))) throw new SocialError("RSS feed was not found");
  return { feedId, isActive: active };
}

function inboxOut(row: Awaited<ReturnType<typeof listInboxItems>>[number]) {
  return {
    id: row.id,
    accountId: row.account_id,
    platform: row.platform,
    kind: row.kind,
    author: row.author,
    body: row.body,
    status: row.status,
    permalink: row.permalink,
    postId: row.post_id,
    replyDraft: row.reply_draft,
    replyBody: row.reply_body,
    repliedAt: iso(row.replied_at),
    receivedAt: iso(row.received_at) ?? iso(row.created_at),
    canReply: Boolean(row.external_id && row.platform && isSocialPlatform(row.platform) && providerFor(row.platform).reply),
  };
}

export async function listInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  return (await listInboxItems(ctx, viewer.companyId, positiveInt(params.limit, "limit", 50), optionalString(params, "status"))).map(inboxOut);
}

export async function recordInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const accountId = optionalString(params, "accountId");
  const account = accountId ? await requireAccount(ctx, viewer, accountId) : null;
  const item = createInboxItem({
    companyId: viewer.companyId,
    kind: requiredString(params, "kind"),
    body: requiredString(params, "body"),
    accountId: account?.id ?? null,
    author: optionalString(params, "author"),
  });
  await insertInboxItem(ctx, {
    id: item.id,
    company_id: item.companyId,
    account_id: item.accountId,
    platform: account?.platform ?? null,
    kind: item.kind,
    author: item.author,
    body: item.body,
    status: item.status,
  });
  return item;
}

export async function markInboxReadRecord(ctx: PluginContext, viewer: Viewer, itemId: string) {
  if (!(await setInboxItemStatus(ctx, viewer.companyId, itemId, "read"))) throw new SocialError("Inbox item was not found");
  return { itemId, status: "read" };
}

export async function replyInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const item = await getInboxItem(ctx, viewer.companyId, requiredString(params, "itemId"));
  if (!item) throw new SocialError("Inbox item was not found");
  const result = await replyToInboxItem(ctx, {
    companyId: viewer.companyId,
    item,
    body: requiredString(params, "body"),
    byAgent: viewer.isAgent,
    agentId: viewer.agentId,
    userId: viewer.userId,
  });
  const message =
    result.mode === "sent" ? "Reply published."
      : result.mode === "suggested" ? "Reply saved as a suggestion. A person sends it from the Social inbox."
        : "This platform has no reply API here; a draft post was created for review.";
  return { ...result, message };
}

function metricNumbers(row: MetricsRow) {
  return { views: Number(row.views ?? 0), likes: Number(row.likes ?? 0), comments: Number(row.comments ?? 0), shares: Number(row.shares ?? 0) };
}

/** Latest snapshot per destination (or per manual row). */
function latestPerDestination(rows: MetricsRow[]): MetricsRow[] {
  const latest = new Map<string, MetricsRow>();
  for (const row of rows) {
    const key = row.destination_id ?? row.id;
    const current = latest.get(key);
    if (!current || String(iso(row.recorded_at)) >= String(iso(current.recorded_at))) latest.set(key, row);
  }
  return [...latest.values()];
}

export async function postAnalyticsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const postId = optionalString(params, "postId");
  if (postId) {
    const post = await requirePost(ctx, viewer, postId);
    const rows = await metricsForPost(ctx, viewer.companyId, post.id);
    const latest = latestPerDestination(rows);
    return {
      postId: post.id,
      ...aggregateMetrics(latest.map(metricNumbers)),
      snapshots: rows.map((r) => ({ window: r.metric_window, platform: r.platform, destinationId: r.destination_id, recordedAt: iso(r.recorded_at), ...metricNumbers(r), impressions: r.impressions == null ? null : Number(r.impressions), reach: r.reach == null ? null : Number(r.reach), saves: r.saves == null ? null : Number(r.saves), clicks: r.clicks == null ? null : Number(r.clicks) })),
    };
  }
  const rows = await metricsForCompany(ctx, viewer.companyId);
  const latest = latestPerDestination(rows);
  const byPlatform: Record<string, ReturnType<typeof aggregateMetrics>> = {};
  for (const platform of ALL_PLATFORMS) {
    const list = latest.filter((r) => r.platform === platform);
    if (list.length) byPlatform[platform] = aggregateMetrics(list.map(metricNumbers));
  }
  return { postId: null, ...aggregateMetrics(latest.map(metricNumbers)), destinations: latest.length, byPlatform };
}

export async function recordMetricsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const values = {
    views: params.views == null ? 0 : assertMetric(params.views, "views"),
    likes: params.likes == null ? 0 : assertMetric(params.likes, "likes"),
    comments: params.comments == null ? 0 : assertMetric(params.comments, "comments"),
    shares: params.shares == null ? 0 : assertMetric(params.shares, "shares"),
  };
  await insertMetrics(ctx, { companyId: viewer.companyId, postId: post.id, ...values, raw: { manual: true } });
  return { postId: post.id, ...values };
}

export async function accountAnalyticsRecord(ctx: PluginContext, viewer: Viewer) {
  const metrics = await accountMetrics(ctx, viewer.companyId);
  const accounts = new Map((await listAccounts(ctx, viewer.companyId)).map((a) => [a.id, a]));
  return metrics.map((row) => ({
    accountId: row.accountId,
    displayName: accounts.get(row.accountId)?.display_name ?? "Unknown",
    platform: accounts.get(row.accountId)?.platform ?? null,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
  }));
}

// ── page snapshot ───────────────────────────────────────────────────────────

export async function loadSnapshot(ctx: PluginContext, viewer: Viewer) {
  const config = await loadSocialConfig(ctx, viewer.companyId);
  const [accounts, posts, destinations, templates, media, feeds, inbox, clients, agent, pickers] = await Promise.all([
    listAccounts(ctx, viewer.companyId),
    listPosts(ctx, viewer.companyId, { limit: 300 }),
    destinationsForCompany(ctx, viewer.companyId),
    listTemplates(ctx, viewer.companyId),
    listMediaAssets(ctx, viewer.companyId),
    listRssFeeds(ctx, viewer.companyId),
    listInboxItems(ctx, viewer.companyId, 100),
    listClients(ctx, viewer.companyId),
    agentSummary(ctx, viewer.companyId),
    listPendingPickers(ctx, viewer.companyId, viewer.userId),
  ]);
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const byPost = new Map<string, DestinationRow[]>();
  for (const d of destinations) byPost.set(d.post_id, [...(byPost.get(d.post_id) ?? []), d]);
  let redirectUri: string | null = null;
  try {
    redirectUri = config.redirectUri();
  } catch {
    redirectUri = null;
  }
  return {
    config: {
      saved: config.saved,
      publicBaseUrl: config.publicBaseUrl,
      publicBaseUrlError: config.publicBaseUrlError,
      redirectUri,
      encryptionKey: config.encryptionKeyConfigured,
      r2: config.r2Configured,
      timezone: config.timezone,
      linkedinOrgPages: config.linkedinOrgPages,
      allowAgentReplies: config.allowAgentReplies,
      blueskyDefaultPds: config.blueskyDefaultPds,
      mastodonDefaultInstance: config.mastodonDefaultInstance,
    },
    platforms: ALL_PLATFORMS.map((platform) => {
      const status = config.platform(platform);
      return { platform, label: PLATFORM_LABELS[platform], mode: CONNECT_MODE[platform], configured: status.configured, missing: status.missing };
    }),
    accounts: accounts.filter((a) => accountVisible(viewer, a)).map(publicAccount),
    posts: posts.filter((p) => postVisible(viewer, p)).map((p) => postOut(p, byPost.get(p.id) ?? [], accountMap)),
    templates: templates.map((t) => ({ id: t.id, name: t.name, body: t.body, platform: t.platform })),
    media: media.map(assetOut),
    feeds: feeds.map(feedOut),
    inbox: inbox.map(inboxOut),
    clients: clients.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
    agent,
    pendingPickers: pickers.map((p) => ({ pickerId: p.picker_id, platform: p.platform })),
    viewer: { userId: viewer.userId },
  };
}
