/**
 * Operations shared by UI actions and agent tools. Every function takes the
 * viewer (company + actor) resolved by the host; ids from params are always
 * re-checked against the viewer's company.
 *
 * Scope: every account, post, media asset, feed and inbox item is either own
 * work (no client) or one CRM client's. Lists take the scope from `client`
 * (or `clientKind` + `clientRef`); leaving it out means own work. A post only
 * ever targets accounts and media of its own scope.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, reviewerAgentId, withClientParam } from "@partnersinbiz/pib-plugin-kit";
import { AccountUnavailable, moveAccountScope, publicAccount, refreshAccountToken } from "./accounts.js";
import { agentSummary } from "./agent.js";
import { approvalView, approvePostByDelegate, changeNotesFor, requestChangesByPerson, handBackFromDelegate, approvePostByPerson, returnPostByDelegate, completeApproval, tryAutoApprove, recordClientApprovalByPerson, recordReviewerVerdict, recordSignoff, routeWaitingPost, signoffState, supersedePendingLinks } from "./approval-flow.js";
import { getPolicy, policyOut, savePolicy, scopeKeyOf } from "./approval-policy.js";
import { assertDelegateNotEditing, clearDelegate, delegateBlockers, delegateCandidates, delegateFacts, delegateView, getDelegateStrict, setDelegate, type DelegateScope } from "./approval-delegate.js";
import { listClientApprovals, requestClientApproval } from "./client-approval.js";
import { CONNECT_EFFECT_KEY, issueOfRun, recordConnectRequest } from "./connect-requests.js";
import {
  formatClientParam,
  inScope,
  listClients,
  resolveScope,
  rowScope,
  sameClient,
  scopeColumns,
  scopeFromParams,
  scopeInput,
  scopeLabel,
  scopeOfRow,
  scopeOut,
  sessionScope,
  type ClientScope,
  type CrmClient,
  type ResolvedScope,
} from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { handoffPayload } from "./done-checks.js";
import {
  accountMetrics,
  attachDestinationLink,
  deleteDestination,
  deletePost,
  destinationsForPost,
  destinationsForScope,
  deleteDisabledAccount,
  publishedDestinationCount,
  disableManualAccount,
  disconnectAccount,
  isManual,
  accountMeta,
  getAccount,
  getAccountsByIds,
  getInboxItem,
  getPost,
  getRssFeed,
  insertDestination,
  insertInboxItem,
  insertMetrics,
  insertPost,
  insertRssFeed,
  insertTemplate,
  saveDestinationOutcome,
  iso,
  listAccounts,
  listInboxItems,
  listMediaAssets,
  listPendingPickers,
  listPosts,
  listRssFeeds,
  listTemplates,
  listPersonalAccounts,
  listPersonalPosts,
  listPersonalTemplates,
  listPersonalMediaAssets,
  listPersonalRssFeeds,
  listPersonalInboxItems,
  destinationsForPersonal,
  metricsForCompany,
  metricsForPost,
  postMedia,
  postOverrides,
  scopeSummary,
  setInboxItemStatus,
  setPostStatus,
  setRssFeedActive,
  table,
  updateAccountSettings,
  updatePostContent,
  type AccountRow,
  type DestinationRow,
  type MetricsRow,
  type PostRow,
  resetFailedDestinations,
  saveInboxReply,
  setPostOutcome,
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
import { experimentOptions, growthEnv, missingHookTag, planExperimentTag, writeExperimentTag } from "./growth/service.js";
import { replyToInboxItem } from "./inbox.js";
import { assetOut, foreignMedia, mediaFromAssetIds } from "./media.js";
import { providerFor } from "./oauth/registry.js";
import {
  ALL_PLATFORMS,
  composeIntent,
  CONNECT_MODE,
  isSocialPlatform,
  OVERRIDE_FIELDS,
  PLAN_ROUTINE_KEY,
  PLATFORM_LABELS,
  type PlatformOverride,
  type PostStatus,
  type SocialPlatform,
} from "./platforms.js";
import { spaceOf } from "./space.js";
import { closeManualPostIssue } from "./issues.js";
import { buildPublishRequest, retryPost } from "./publish.js";
import { requestCreative } from "./creative.js";
import { closePostReview, routePostReview } from "./review.js";
import { mediaCompliance } from "./media-compliance.js";
import { reviewStats } from "./review-outcomes.js";
import { requireCanActOnPost } from "./ownership.js";
import { routineReport } from "./routine-state.js";
import { validatePostRow } from "./validate.js";
import { PLAN_ROUTINE_TITLE } from "./skills.js";
import { askAgentForDraft, jevKeySet, triageOut } from "./triage.js";
import { emptyStats, scopeStats } from "./stats.js";
import { assertClientFiling, overrideTexts } from "./client-filing.js";
import { parseTweetUrl, targetFromParams } from "./post-target.js";

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

/** A draft's proposed publish time: undefined = not given, null = clear it. */
export function proposedTime(params: Record<string, unknown>): string | null | undefined {
  const value = params.scheduledAt;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new SocialError("scheduledAt must be an ISO date-time, e.g. 2026-10-05T07:30:00+02:00");
  return isoTime(value, "scheduledAt");
}

/**
 * Post params with the old `scope` name folded in. `scope` used to be the
 * org/personal choice (now `visibility`); agents also sent the client in it
 * ("company:<id>", "contact:<id>", "own"), so a client value becomes `client`.
 */
export function postParams(params: Record<string, unknown>): Record<string, unknown> {
  const legacy = params.scope;
  if (typeof legacy !== "string" || !legacy.trim()) return params;
  const value = legacy.trim();
  if (value === "org" || value === "personal") return params.visibility === undefined ? { ...params, visibility: value } : params;
  if (params.client !== undefined || params.clientRef !== undefined) return params;
  return { ...params, client: value };
}

function postVisibility(params: Record<string, unknown>): AccountScope {
  if (spaceOf(params) === "me") return "personal";
  const value = optionalString(params, "visibility") ?? "org";
  if (value !== "org" && value !== "personal") throw new SocialError("visibility must be org or personal");
  return value;
}

/** Validate and normalise the platform-keyed overrides object and reserved tags key. */
export function normalizeOverrides(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new SocialError("overrides must be an object keyed by platform");
  const out: Record<string, unknown> = {};
  for (const [platform, raw] of Object.entries(value as Record<string, unknown>)) {
    // Handle reserved tags key
    if (platform === "tags") {
      if (Array.isArray(raw)) {
        const tags = raw.map((t) => String(t || "").toLowerCase().trim()).filter((t) => t && t.length > 0);
        if (tags.length > 0) out.tags = Array.from(new Set(tags)).slice(0, 10); // dedupe, max 10
      }
      continue;
    }
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
  // Personal: visible to owner, or to agents who created it
  if (viewer.isAgent) return post.created_by_agent_id === viewer.agentId;
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

/**
 * What a person needs to post this destination by hand: the text as that platform gets it and the platform's own
 * composer. Present while the destination is not published and its account still exists.
 */
function handPostOut(d: DestinationRow, account: AccountRow | undefined, post: PostRow | undefined) {
  if (!post || !account || d.status === "published" || d.status === "publishing" || !isSocialPlatform(account.platform)) return null;
  // Only where a person can act on it: a manual account, or a destination whose automatic publish failed.
  if (!isManual(account) && d.status !== "failed") return null;
  const request = buildPublishRequest(post, account.platform);
  const meta = accountMeta(account);
  const text = request.text;
  const intent = composeIntent(account.platform, {
    text,
    title: request.title ?? null,
    link: request.link ?? null,
    subreddit: request.subreddit ?? (typeof meta.defaultSubreddit === "string" ? meta.defaultSubreddit : null),
    imageUrl: request.media.find((m) => m.kind === "image")?.url ?? null,
    instanceUrl: typeof meta.instanceUrl === "string" ? meta.instanceUrl : null,
  });
  return {
    /** The caption to copy: the text, then the link when the platform shows links. */
    text: request.link && !text.includes(request.link) ? `${text}\n\n${request.link}` : text,
    title: request.title ?? null,
    firstComment: request.firstComment ?? null,
    url: intent.url,
    prefilled: intent.prefilled,
    mediaByHand: intent.mediaByHand,
  };
}

function destinationOut(d: DestinationRow, account: AccountRow | undefined, post?: PostRow) {
  return {
    id: d.id,
    accountId: d.account_id,
    platform: account?.platform ?? null,
    accountName: account?.display_name ?? "Removed account",
    accountStatus: account?.status ?? null,
    /** The account has no publishing link: a person posts this destination by hand. */
    manual: account ? isManual(account) : false,
    handPost: handPostOut(d, account, post),
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

/** A reply / quote target for display: the link, the tweet id and the author handle. */
export function targetOut(url: string | null | undefined): { url: string; id: string; handle: string | null } | null {
  const ref = url ? parseTweetUrl(url) : null;
  return ref ? { url: ref.url, id: ref.id, handle: ref.handle } : null;
}

export function postOut(row: PostRow, destinations: DestinationRow[] = [], accounts: Map<string, AccountRow> = new Map()) {
  const tags = ((row.overrides as Record<string, unknown>)?.tags as string[] | undefined) ?? [];
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    scheduledAt: iso(row.scheduled_at),
    publishedAt: iso(row.published_at),
    ...scopeOut(row),
    firstComment: row.first_comment,
    replyTo: targetOut(row.reply_to_url),
    quote: targetOut(row.quote_url),
    note: row.note ?? null,
    media: postMedia(row),
    overrides: postOverrides(row),
    tags: tags.length > 0 ? tags : undefined,
    source: row.source ?? "manual",
    /** The SEO page this draft repurposes (its hand-off key), when it was drafted for one. */
    handoffKey: row.source === "repurpose" ? row.source_ref : null,
    experimentId: row.experiment_id ?? null,
    experimentArm: row.experiment_arm ?? null,
    /** The Social agent task that picks a time for this approved post, if one was opened. */
    scheduleIssueId: row.schedule_issue_id ?? null,
    error: row.error,
    failureIssueId: row.failure_issue_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    destinations: destinations.map((d) => destinationOut(d, accounts.get(d.account_id), row)),
  };
}

// ── posts ───────────────────────────────────────────────────────────────────

/** A post and its destination account must share a scope (own work, or the same client). */
export function assertAccountScope(post: Pick<PostRow, "client_kind" | "client_ref" | "client_name">, account: AccountRow): void {
  if (inScope(account, scopeOfRow(post))) return;
  throw new SocialError(
    `${account.display_name} belongs to ${scopeLabel(account)}; this post is for ${scopeLabel(post)}. A post can only use accounts of its own client (or own work).`,
  );
}

async function loadAccounts(ctx: PluginContext, viewer: Viewer, accountIds: string[]): Promise<AccountRow[]> {
  const accounts: AccountRow[] = [];
  for (const accountId of accountIds) accounts.push(await requireAccount(ctx, viewer, accountId));
  return accounts;
}

async function attachAccounts(ctx: PluginContext, viewer: Viewer, post: PostRow, accounts: AccountRow[]): Promise<void> {
  // Check every account first so a bad one attaches none.
  for (const account of accounts) {
    assertAccountScope(post, account);
    assertDestination({ postScope: post.scope, accountScope: account.scope, accountOwnerUserId: account.owner_user_id, actorUserId: viewer.userId });
  }
  for (const account of accounts) await insertDestination(ctx, { companyId: viewer.companyId, postId: post.id, accountId: account.id });
}

/**
 * The repurpose hand-off a draft is for (`handoffKey` on create-post): the
 * SEO page's key and scope. Unknown keys are refused, so a draft is never
 * linked to a page that was not handed to Social.
 */
export async function requireHandoff(ctx: PluginContext, companyId: string, key: string): Promise<{ key: string; scope: ClientScope; title: string }> {
  const rows = await ctx.db.query<{ key: string; payload: unknown }>(
    `SELECT key, payload FROM ${table(ctx, "handoffs")} WHERE company_id = $1 AND key = $2 AND kind = 'repurpose' LIMIT 1`,
    [companyId, key],
  );
  if (!rows[0]) throw new SocialError(`Unknown hand-off key ${key}. Use the key from the "Repurpose for social" issue (e.g. seo:content:<id>).`);
  const payload = handoffPayload(rows[0].payload);
  const scope: ClientScope = payload.clientRef ? { kind: payload.clientKind === "contact" ? "contact" : "company", id: payload.clientRef } : null;
  return { key: rows[0].key, scope, title: payload.title ?? payload.url ?? key };
}

export async function createPostRecord(ctx: PluginContext, viewer: Viewer, input: Record<string, unknown>) {
  const params = postParams(input);
  const body = requiredString(params, "body");
  const scope = postVisibility(params);
  if (scope === "personal" && viewer.isAgent) throw new SocialError("Agents cannot create personal posts. Use create-personal-draft to draft in a user's My Social queue.");
  if (scope === "personal" && !viewer.userId) throw new SocialError("A personal post needs its owner");
  const scheduledAt = proposedTime(params) ?? null;
  // A draft for a repurposed SEO page is linked to it and stays in the page's scope (the repurpose done-check counts it).
  const handoffKey = optionalString(params, "handoffKey");
  const handoff = handoffKey ? await requireHandoff(ctx, viewer.companyId, handoffKey) : null;
  // Omitting the client means own work (or the page's scope for a hand-off draft).
  const target = await scopeFromParams(ctx, viewer.companyId, params, handoff?.scope ?? null);
  if (handoff && !sameClient(target.scope, handoff.scope)) {
    throw new SocialError(
      `The page "${handoff.title}" belongs to ${handoff.scope ? formatClientParam(handoff.scope) : "own work"}; its drafts stay in that scope. ${handoff.scope ? `Pass client: "${formatClientParam(handoff.scope)}"` : "Leave the client out"} (or leave it out with handoffKey).`,
    );
  }
  if (viewer.isAgent) {
    await assertClientFiling(ctx, viewer.companyId, {
      texts: [body, optionalString(params, "firstComment"), optionalString(params, "note"), ...overrideTexts(params.overrides)],
      scope: target.scope,
      onPurpose: params.namesClientOnPurpose,
    });
  }
  const media = (await mediaFromAssetIds(ctx, viewer.companyId, params.mediaAssetIds, target.scope)) ?? [];
  // Merge tags into overrides if provided
  const baseOverrides = (params.overrides as Record<string, unknown>) ?? {};
  const overridesWithTags = params.tags && Array.isArray(params.tags) ? { ...baseOverrides, tags: params.tags } : baseOverrides;
  const overrides = normalizeOverrides(overridesWithTags) ?? {};
  const accounts = await loadAccounts(ctx, viewer, stringList(params, "accountIds") ?? []);
  const targetFields = targetFromParams(params);
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
    reply_to_url: targetFields.replyToUrl ?? null,
    quote_url: targetFields.quoteUrl ?? null,
    note: targetFields.note ?? null,
    scheduled_at: scheduledAt,
    ...scopeColumns(target),
    source: handoff ? "repurpose" : viewer.isAgent ? "agent" : "manual",
    source_ref: handoff?.key ?? null,
    created_by_agent_id: viewer.agentId,
  };
  for (const account of accounts) assertAccountScope(row, account);
  // Growth Lab tag: checked before anything is written.
  const growth = growthEnv(ctx);
  const tag = await planExperimentTag(growth, viewer.companyId, { id: row.id, ...scopeColumns(target) }, { experimentId: params.experimentId, arm: params.arm });
  await insertPost(ctx, row);
  const post = (await getPost(ctx, viewer.companyId, row.id))!;
  await attachAccounts(ctx, viewer, post, accounts);
  await writeExperimentTag(growth, viewer.companyId, row.id, tag);
  return getPostDetail(ctx, viewer, row.id);
}

/** Reply / quote / note changes of an update. Setting one of reply and quote clears the other, so a post never keeps both. */
export function changedTarget(params: Record<string, unknown>) {
  const fields = targetFromParams(params);
  if (fields.replyToUrl && fields.quoteUrl === undefined) fields.quoteUrl = null;
  if (fields.quoteUrl && fields.replyToUrl === undefined) fields.replyToUrl = null;
  return fields;
}

/** The delegate scope a post sits in: `personal` for a person's own post (never delegatable). */
function postDelegateScope(post: PostRow): DelegateScope {
  return post.scope === "personal" ? "personal" : rowScope(post).scope;
}

export async function updatePostRecord(ctx: PluginContext, viewer: Viewer, input: Record<string, unknown>) {
  const params = postParams(input);
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  // Agents can only update personal drafts they created themselves while status is draft
  if (viewer.isAgent && post.scope === "personal") {
    if (post.created_by_agent_id !== viewer.agentId || post.status !== "draft") {
      throw new SocialError("Agents can only edit drafts in a personal queue that they created, while in draft status");
    }
  }
  assertEditable(post.status);
  const current = rowScope(post);
  const requested = scopeInput(params);
  const target: ResolvedScope = requested === undefined || sameClient(requested, current.scope) ? current : await resolveScope(ctx, viewer.companyId, requested);
  const moving = !sameClient(target.scope, current.scope);
  // Q10: the delegate of the post's scope, or of the scope it moves to, does not change another's post.
  await assertDelegateNotEditing(ctx, viewer, post, [postDelegateScope(post), ...(moving ? [target.scope] : [])]);
  const body = params.body === undefined ? undefined : requiredString(params, "body");
  if (viewer.isAgent && (body !== undefined || moving || params.overrides !== undefined || params.firstComment !== undefined)) {
    await assertClientFiling(ctx, viewer.companyId, {
      texts: [body ?? post.body, optionalString(params, "firstComment") ?? post.first_comment, ...overrideTexts(params.overrides ?? post.overrides)],
      scope: target.scope,
      personal: post.scope === "personal",
      onPurpose: params.namesClientOnPurpose,
    });
  }
  const media = await mediaFromAssetIds(ctx, viewer.companyId, params.mediaAssetIds, target.scope);
  const accountIds = stringList(params, "accountIds");
  const accounts = accountIds ? await loadAccounts(ctx, viewer, accountIds) : [];
  const nextScope = { ...post, ...scopeColumns(target) };
  for (const account of accounts) assertAccountScope(nextScope, account);
  if (moving) {
    // A post changes client only when nothing it already uses belongs to the old one.
    const kept = (await destinationsForPost(ctx, post.id)).filter((d) => !accountIds || accountIds.includes(d.account_id) || d.status === "published");
    for (const account of await getAccountsByIds(ctx, viewer.companyId, kept.map((d) => d.account_id))) {
      if (!inScope(account, target.scope)) {
        throw new SocialError(`Remove ${account.display_name} (${scopeLabel(account)}) from this post before moving it to ${scopeLabel(target)}.`);
      }
    }
    if (!media) {
      const foreign = await foreignMedia(ctx, viewer.companyId, postMedia(post), target.scope);
      if (foreign.length) throw new SocialError(`Replace the media from ${scopeLabel(foreign[0]!)} before moving this post to ${scopeLabel(target)}.`);
    }
  }
  // Growth Lab tag: a post that changes client leaves its old experiment.
  const growth = growthEnv(ctx);
  const tagInput = moving && params.experimentId === undefined && post.experiment_id ? { experimentId: null } : { experimentId: params.experimentId, arm: params.arm };
  const tag = await planExperimentTag(growth, viewer.companyId, nextScope, tagInput);
  // Merge tags into overrides if provided
  const baseOverrides = (params.overrides as Record<string, unknown>) ?? {};
  const overridesWithTags = params.tags && Array.isArray(params.tags) ? { ...baseOverrides, tags: params.tags } : baseOverrides;
  await updatePostContent(ctx, viewer.companyId, post.id, {
    body,
    media,
    overrides: normalizeOverrides(overridesWithTags),
    firstComment: params.firstComment === undefined ? undefined : optionalString(params, "firstComment") ?? null,
    scope: moving ? scopeColumns(target) : undefined,
    scheduledAt: proposedTime(params),
    ...changedTarget(params),
  });
  // Any edit voids the client's open links: they were made for the old version.
  await supersedePendingLinks(ctx, viewer.companyId, post.id);
  if (moving) {
    for (const d of await destinationsForPost(ctx, post.id)) {
      if (accountIds && !accountIds.includes(d.account_id)) await deleteDestination(ctx, viewer.companyId, post.id, d.account_id);
    }
  }
  if (accounts.length) await attachAccounts(ctx, viewer, (await getPost(ctx, viewer.companyId, post.id))!, accounts);
  await writeExperimentTag(growth, viewer.companyId, post.id, tag);
  return getPostDetail(ctx, viewer, post.id);
}

export async function getPostDetail(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  const destinations = await destinationsForPost(ctx, post.id);
  const accounts = new Map((await listAccounts(ctx, viewer.companyId)).map((a) => [a.id, a]));
  return postOut(post, destinations, accounts);
}

/** The scope a read names (own work when left out). Unknown clients are refused. */
export async function readScope(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<ResolvedScope> {
  return scopeFromParams(ctx, viewer.companyId, params);
}

async function accountsFor(ctx: PluginContext, companyId: string, inScopeAccounts: AccountRow[], destinations: DestinationRow[]): Promise<Map<string, AccountRow>> {
  const map = new Map(inScopeAccounts.map((a) => [a.id, a]));
  // Posts from before strict scopes may still point at another scope's account.
  const missing = Array.from(new Set(destinations.map((d) => d.account_id).filter((id) => !map.has(id))));
  for (const a of await getAccountsByIds(ctx, companyId, missing)) map.set(a.id, a);
  return map;
}

function groupByPost(destinations: DestinationRow[]): Map<string, DestinationRow[]> {
  const byPost = new Map<string, DestinationRow[]>();
  for (const d of destinations) byPost.set(d.post_id, [...(byPost.get(d.post_id) ?? []), d]);
  return byPost;
}

export async function listPostsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  const rows = await listPosts(ctx, viewer.companyId, {
    status: optionalString(params, "status"),
    scope,
    limit: positiveInt(params.limit, "limit", 50),
  });
  const visible = rows.filter((row) => postVisible(viewer, row));
  const destinations = await destinationsForScope(ctx, viewer.companyId, scope);
  const accounts = await accountsFor(ctx, viewer.companyId, await listAccounts(ctx, viewer.companyId, scope), destinations);
  const byPost = groupByPost(destinations);
  return visible.map((row) => postOut(row, byPost.get(row.id) ?? [], accounts));
}

export async function validatePostRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  return validatePostRow(ctx, viewer.companyId, post);
}

export async function attachDestination(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  if (viewer.isAgent && post.scope === "personal" && post.created_by_agent_id !== viewer.agentId) {
    throw new SocialError("Agents can only attach destinations to personal drafts they created");
  }
  await assertDelegateNotEditing(ctx, viewer, post, [postDelegateScope(post)]);
  if (post.status === "published" || post.status === "publishing") throw new SocialError(`A ${post.status} post cannot take new destinations`);
  const accounts = await loadAccounts(ctx, viewer, [requiredString(params, "accountId")]);
  // When viewer is agent and post is personal, account must be personal and owned by post owner
  if (viewer.isAgent && post.scope === "personal") {
    for (const account of accounts) {
      if (account.scope !== "personal" || account.owner_user_id !== post.owner_user_id) {
        throw new SocialError("Agents can only attach personal accounts owned by the post's owner");
      }
    }
  }
  await attachAccounts(ctx, viewer, post, accounts);
  // The accounts are part of what a sign-off and a client link cover: the client saw the post going to other accounts.
  await supersedePendingLinks(ctx, viewer.companyId, post.id);
  return getPostDetail(ctx, viewer, post.id);
}

export async function detachDestination(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  if (viewer.isAgent && post.scope === "personal" && post.created_by_agent_id !== viewer.agentId) {
    throw new SocialError("Agents can only detach destinations from personal drafts they created");
  }
  await assertDelegateNotEditing(ctx, viewer, post, [postDelegateScope(post)]);
  const accountId = requiredString(params, "accountId");
  const before = await destinationsForPost(ctx, post.id);
  const target = before.find((d) => d.account_id === accountId);
  const removed = await deleteDestination(ctx, viewer.companyId, post.id, accountId);
  if (!removed) throw new SocialError("Only pending or failed destinations can be removed");
  // It waited to be posted by hand and was the last one on its task: the task has nothing left to ask.
  if (target?.status === "awaiting_manual" && target.issue_id && !before.some((d) => d.id !== target.id && d.status === "awaiting_manual" && d.issue_id === target.issue_id)) {
    await closeManualPostIssue(ctx, viewer.companyId, target.issue_id, "The account was removed from this post. Closing this issue.");
  }
  await supersedePendingLinks(ctx, viewer.companyId, post.id);
  return getPostDetail(ctx, viewer, post.id);
}

export async function transitionPost(ctx: PluginContext, viewer: Viewer, postId: string, to: PostStatus) {
  const post = await requirePost(ctx, viewer, postId);
  // Agents cannot act on personal posts they didn't create
  if (viewer.isAgent && post.scope === "personal" && post.created_by_agent_id !== viewer.agentId) {
    throw new SocialError("Agents can only edit drafts in a personal queue that they created");
  }
  // My Social has no review stage: the owner approves their own draft directly (nobody else can).
  if (post.scope === "personal" && !viewer.isAgent && to === "approved") {
    requireCanActOnPost(viewer, post, "approve");
    if (post.status !== "draft" && post.status !== "review") throw new SocialError(`A ${post.status.replace("_", " ")} post cannot be approved`);
    if (!(await setPostStatus(ctx, viewer.companyId, post.id, [post.status], "approved"))) {
      throw new SocialError("The post changed while you were editing it. Reload and try again.");
    }
    return getPostDetail(ctx, viewer, post.id);
  }
  if (viewer.isAgent) assertAgentTransition(post.status, to);
  else assertTransition(post.status, to);
  if (to === "approved") requireUser(viewer, "approve a post");
  if (to === "review" && viewer.isAgent) {
    const untagged = await missingHookTag(growthEnv(ctx), viewer.companyId, post).catch(() => null);
    if (untagged) throw new SocialError(untagged);
  }
  if (to === "approved" && post.status === "review") {
    // Approval needs every sign-off the scope's policy asks for (a team member's click is one of them); the post is
    // approved, scheduled at its proposed time, and its review issue closed once they are all in (approval-flow.ts).
    const progress = await approvePostByPerson(ctx, viewer, post);
    return { ...(await getPostDetail(ctx, viewer, post.id)), ...(progress.approval ? { approval: progress.approval } : {}), signoff: { completed: progress.completed, pending: progress.pending, message: progress.message } };
  }
  // Unscheduling clears the time. Every other move keeps it: a draft's time is its proposed time.
  // A failed post's time has passed, so it is cleared too: approval must not publish it at once on a stale time.
  const clearSchedule = (post.status === "scheduled" && to === "approved") || post.status === "failed" ? null : undefined;
  if (!(await setPostStatus(ctx, viewer.companyId, post.id, [post.status], to, clearSchedule))) {
    throw new SocialError("The post changed while you were editing it. Reload and try again.");
  }
  // A failed post starts over: its old error goes, and its failed destinations can publish again after approval.
  if (post.status === "failed" && to === "draft") {
    await resetFailedDestinations(ctx, viewer.companyId, post.id);
    await setPostOutcome(ctx, post.id, { status: "draft", error: null, publishedAt: false });
  }
  // Company Cockpit: the Reviewer checks posts first when one is set (best effort, never blocks the move).
  if (to === "review") {
    await routePostReview(ctx, viewer, post);
    // No Reviewer asked for: a low-risk post with a clean owner streak needs no click (autonomy ladder).
    const inReview = await getPost(ctx, viewer.companyId, post.id);
    const auto = inReview ? await tryAutoApprove(ctx, viewer, inReview) : null;
    return { ...(await getPostDetail(ctx, viewer, post.id)), ...(auto ? { signoff: { completed: true, pending: [], message: auto.message } } : {}) };
  }
  // Back to draft: a link the client holds would only let them answer for a post that is no longer waiting.
  if (to === "draft" && post.status === "review") await supersedePendingLinks(ctx, viewer.companyId, post.id);
  // A person sending a post back from review is a verdict too: the owner asked for changes (autonomy input).
  if (to === "draft" && post.status === "review" && !viewer.isAgent && viewer.userId) {
    const state = await signoffState(ctx, viewer.companyId, post).catch(() => null);
    if (state) await recordSignoff(ctx, viewer.companyId, post, state.hash, "owner", "changes", "ui", { userId: viewer.userId });
  }
  await closePostReview(ctx, viewer, post, to);
  return getPostDetail(ctx, viewer, post.id);
}

/**
 * Takes a scheduled post back to draft so it can be edited (update-post): body, media and accounts stay, the time is
 * cleared. A reason is required; who and why are logged and appended to the post's internal note.
 */
export async function unschedulePostRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const reason = requiredString(params, "reason").trim();
  if (!reason) throw new SocialError("A reason is required to unschedule a post.");
  // Same scope rules as update-post.
  if (viewer.isAgent && post.scope === "personal" && post.created_by_agent_id !== viewer.agentId) {
    throw new SocialError("Agents can only unschedule personal posts that they created");
  }
  if (post.status !== "scheduled") {
    throw new SocialError(`Only a scheduled post can be unscheduled; this one is ${post.status.replace("_", " ")}.`);
  }
  await assertDelegateNotEditing(ctx, viewer, post, [postDelegateScope(post)]);
  if (!(await setPostStatus(ctx, viewer.companyId, post.id, ["scheduled"], "draft", null))) {
    throw new SocialError("The post changed while you were unscheduling it (it may be publishing now). Reload and try again.");
  }
  const who = viewer.isAgent ? `agent ${viewer.agentId ?? "unknown"}${viewer.runId ? ` (run ${viewer.runId})` : ""}` : `user ${viewer.userId ?? "unknown"}`;
  const line = `Unscheduled by ${who}: ${reason}`;
  const note = [post.note, line].filter(Boolean).join("\n");
  await updatePostContent(ctx, viewer.companyId, post.id, { note: note.length > 500 ? note.slice(note.length - 500) : note });
  ctx.logger.info("Social post unscheduled", { companyId: viewer.companyId, postId: post.id, by: who, reason });
  await supersedePendingLinks(ctx, viewer.companyId, post.id);
  return getPostDetail(ctx, viewer, post.id);
}

export async function schedulePost(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  if (viewer.isAgent && post.scope === "personal") {
    throw new SocialError("Agents can only create personal drafts. The queue owner must schedule.");
  }
  requireCanActOnPost(viewer, post, "schedule");
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
  if (viewer.isAgent && post.scope === "personal" && post.created_by_agent_id !== viewer.agentId) {
    throw new SocialError("Agents can only retry personal posts they created");
  }
  const result = await retryPost(ctx, viewer.companyId, post);
  return { ...result, message: `${result.reset} destination(s) will be retried within 5 minutes.`, post: await getPostDetail(ctx, viewer, post.id) };
}

const X_STATUS_LINK = /^https:\/\/(www\.)?(x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/;

/** The tweet id of `url` when it is a status link of this X account; null for any other link or account. */
export function xStatusIdFor(account: Pick<AccountRow, "platform" | "handle"> | undefined, url: string | null): string | null {
  if (!account || account.platform !== "x" || !url) return null;
  const handle = account.handle?.replace(/^@/, "").toLowerCase();
  const match = X_STATUS_LINK.exec(url);
  if (!match || !handle || handle === "i") return null;
  return match[3]!.toLowerCase() === handle ? match[4]! : null;
}

/**
 * A person posted this themselves (an X reply the API cannot send): record it as published so it leaves the queue.
 * `url` is the link to what they posted, if they have it. On an already published post, `url` attaches the link
 * to hand-marked destinations that have none, so their metrics can be collected.
 */
export async function markPostPostedRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "mark a post as posted");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const url = optionalString(params, "url")?.trim() || null;
  const attach = post.status === "published" && url !== null;
  if (!attach && (post.status === "published" || post.status === "publishing" || post.status === "draft" || post.status === "review")) {
    throw new SocialError(`A ${post.status} post cannot be marked as posted. Approve it first.`);
  }
  if (url && !/^https?:\/\//i.test(url)) throw new SocialError("The link must start with https://");
  const destinations = await destinationsForPost(ctx, post.id);
  if (destinations.length === 0) throw new SocialError("This post has no destinations to mark as posted");
  const accounts = new Map((await getAccountsByIds(ctx, viewer.companyId, [...new Set(destinations.map((d) => d.account_id))])).map((a) => [a.id, a]));
  if (attach) {
    let changed = 0;
    for (const d of destinations) {
      const manual = d.result && typeof d.result === "object" && (d.result as Record<string, unknown>).manual === true;
      if (d.status !== "published" || !manual || d.external_id !== null) continue;
      const externalId = xStatusIdFor(accounts.get(d.account_id), url);
      if (externalId) changed += await attachDestinationLink(ctx, d.id, externalId, url!);
    }
    if (changed === 0) throw new SocialError("No hand-marked destination on this post accepts this link");
    return getPostDetail(ctx, viewer, post.id);
  }
  for (const d of destinations) {
    if (d.status === "published") continue;
    await saveDestinationOutcome(ctx, d.id, {
      status: "published",
      nextAttemptAt: null,
      externalId: xStatusIdFor(accounts.get(d.account_id), url),
      externalUrl: url,
      lastError: null,
      result: { ok: true, manual: true, at: new Date().toISOString(), by: viewer.userId ?? null },
    });
  }
  await setPostOutcome(ctx, post.id, { status: "published", error: null, publishedAt: true });
  return getPostDetail(ctx, viewer, post.id);
}

export async function deletePostRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  requireUser(viewer, "delete a post");
  const post = await requirePost(ctx, viewer, postId);
  // Part of it is already out (posted by hand before its time): deleting would lose the record of what was published.
  if ((await destinationsForPost(ctx, post.id)).some((d) => d.status === "published")) {
    throw new SocialError("Part of this post is already published, so it cannot be deleted. Remove the accounts that are not posted yet instead.");
  }
  if (!(await deletePost(ctx, viewer.companyId, post.id))) throw new SocialError("Only draft, review, approved or failed posts can be deleted");
  return { deleted: post.id };
}

// ── approvals: policy, client link, Reviewer verdict, sign-offs ─────────────

export async function getApprovalPolicyRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  const [policy, delegate] = await Promise.all([getPolicy(ctx, viewer.companyId, scope), delegateView(ctx, viewer.companyId, scope)]);
  return policyOut(policy, delegate);
}

/** A person sets who approves posts in a scope. An agent cannot: the policy delegates authority. */
export async function setApprovalPolicyRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "set who approves posts");
  const target = await readScope(ctx, viewer, params);
  if (params.requireReviewer === true && !(await reviewerAgentId(ctx, viewer.companyId))) {
    throw new SocialError("There is no running Reviewer to require. Set one in Setup → Team (and switch on \"review outward-facing work\"), or leave the Reviewer's pass off.");
  }
  // A delegated approver locks the Reviewer and the team member on and the client off. Read strictly: an unreadable store refuses.
  const delegated = (await getDelegateStrict(ctx, viewer.companyId, target.scope)) !== null;
  const saved = await savePolicy(ctx, viewer.companyId, { scope: target.scope, clientName: target.client?.name ?? null }, params, userId, delegated);
  // A looser policy can leave posts in review with every sign-off already in: approve those now.
  const { approved, routed, failed } = await reevaluateReviewPosts(ctx, viewer, target.scope);
  return { ...policyOut(saved, await delegateView(ctx, viewer.companyId, target.scope)), approved, routed, failed };
}

/**
 * A person names (or clears, `agentId: null`) the agent whose yes will count as the team member's approval in one scope,
 * after the Reviewer's pass (PAR-9561). An agent cannot, not even with a responsible user on its run. Setting it turns the
 * Reviewer's pass on; clearing it leaves the policy as it is.
 */
export async function setApprovalDelegateRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "name a delegated approver");
  const target = await readScope(ctx, viewer, params);
  const scope: DelegateScope = spaceOf(params) === "me" ? "personal" : target.scope;
  if (!("agentId" in params)) throw new SocialError("agentId is required (null clears the delegated approver)");
  const agentId = params.agentId;
  if (agentId === null) {
    if (scope === "personal") throw new SocialError("A personal post cannot have a delegated approver.");
    // Read strictly first: the review issues the cleared agent holds go back to the person (T7b, findings 13).
    const cleared = (await getDelegateStrict(ctx, viewer.companyId, scope))?.agentId;
    await clearDelegate(ctx, viewer.companyId, scope, userId);
    ctx.logger.info("Social delegated approver cleared by a person", { companyId: viewer.companyId, scope: scopeKeyOf(scope), by: userId });
    const recheck = cleared ? await reevaluateReviewPosts(ctx, viewer, target.scope, cleared) : { approved: 0, routed: 0, handedBack: 0, failed: 0 };
    return { ...(await getApprovalPolicyRecord(ctx, viewer, params)), ...recheck };
  }
  if (typeof agentId !== "string" || !agentId.trim()) throw new SocialError("agentId must be an agent id, or null to clear");
  const blockers = delegateBlockers(await delegateFacts(ctx, viewer.companyId, scope, agentId.trim()));
  if (blockers.length > 0) throw new SocialError(blockers.join(" "));
  if (scope === "personal") throw new SocialError("A personal post cannot have a delegated approver.");
  if (!(await reviewerAgentId(ctx, viewer.companyId))) {
    throw new SocialError("There is no running Reviewer to require. Set one in Setup → Team (and switch on \"review outward-facing work\"), or leave the Reviewer's pass off.");
  }
  // The delegate approves only after the Reviewer's pass: turn it on first, so a failed save leaves no delegate behind.
  // Nothing is re-routed on set: a post created before the delegate was named stays with the person (check 9, Quinn 2.4).
  await savePolicy(ctx, viewer.companyId, { scope, clientName: target.client?.name ?? null }, { requireReviewer: true }, userId);
  await setDelegate(ctx, viewer.companyId, scope, agentId.trim(), userId);
  ctx.logger.info("Social delegated approver set by a person", { companyId: viewer.companyId, scope: scopeKeyOf(scope), agentId: agentId.trim(), by: userId });
  return getApprovalPolicyRecord(ctx, viewer, params);
}

/** What the re-check of a scope's posts in review did. `failed` counts posts that threw (and 1 when the list itself could not be read). */
export interface RecheckResult { approved: number; routed: number; handedBack: number; failed: number }

/** Posts in review the re-check reads in one go (Quinn 2.4: 50 left the rest of a busy scope unchecked). */
const RECHECK_LIMIT = 1000;

/**
 * Posts in review in a scope whose sign-offs are all in under the current policy are approved. A post that still waits on an agent's
 * step with no open review issue to say so (the policy began to ask for the client after the post went to review) gets its issue.
 * With `clearedDelegate`, a review issue that agent holds for a passed post waiting on the owner goes back to the person (T7b).
 * One post that throws is logged at warn and counted in `failed`; the others are still checked.
 */
async function reevaluateReviewPosts(ctx: PluginContext, viewer: Viewer, scope: ClientScope, clearedDelegate?: string): Promise<RecheckResult> {
  const result: RecheckResult = { approved: 0, routed: 0, handedBack: 0, failed: 0 };
  let posts: PostRow[];
  try {
    posts = (await listPosts(ctx, viewer.companyId, { status: "review", scope, limit: RECHECK_LIMIT })).filter((p) => postVisible(viewer, p));
  } catch (error) {
    ctx.logger.warn("Social policy re-check could not list posts in review", { companyId: viewer.companyId, error: error instanceof Error ? error.message : String(error) });
    return { ...result, failed: 1 };
  }
  for (const post of posts) {
    try {
      const state = await signoffState(ctx, viewer.companyId, post);
      if (state.missing.length > 0) {
        if (clearedDelegate && (await handBackFromDelegate(ctx, viewer, post, state, clearedDelegate))) result.handedBack += 1;
        else if (await routeWaitingPost(ctx, viewer, post)) result.routed += 1;
        continue;
      }
      await completeApproval(ctx, viewer, post, "A person (the policy changed)");
      result.approved += 1;
    } catch (error) {
      result.failed += 1;
      ctx.logger.warn("Social policy re-check failed for a post", { companyId: viewer.companyId, postId: post.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Where a post's approval stands: the policy, each sign-off for the current version, what is missing, and the client's links (never the links themselves). */
export async function approvalStatusRecord(ctx: PluginContext, viewer: Viewer, postId: string) {
  const post = await requirePost(ctx, viewer, postId);
  return { postId: post.id, status: post.status, ...(await approvalView(ctx, viewer.companyId, post)), clientLinks: await listClientApprovals(ctx, viewer.companyId, post) };
}

/** `request-client-approval`: the client's link for a post in review, plus the email text. */
export async function requestClientApprovalRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const draft = optionalString(params, "draft");
  if (draft !== undefined && draft !== "me" && draft !== "account-manager") throw new SocialError('draft must be "me" or "account-manager"');
  return requestClientApproval(ctx, viewer.companyId, post, await loadSocialConfig(ctx, viewer.companyId), {
    createdBy: viewer.agentId ?? viewer.userId,
    recipientEmail: optionalString(params, "recipientEmail") ?? null,
    draft: draft as "me" | "account-manager" | undefined,
    byAgent: viewer.isAgent,
  });
}

/** `record-review-verdict`: only the company's Reviewer agent. */
export async function recordReviewVerdictRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  if (!viewer.isAgent || !viewer.agentId) throw new SocialError("Only the Reviewer agent records a review verdict. People approve or send the post back on the Social page.");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const verdict = requiredString(params, "verdict");
  if (verdict !== "pass" && verdict !== "changes") throw new SocialError('verdict must be "pass" or "changes"');
  const toneScore = params.toneScore != null ? Number(params.toneScore) : null;
  if (toneScore != null && (!Number.isInteger(toneScore) || toneScore < 0 || toneScore > 20)) {
    throw new SocialError("toneScore must be a whole number from 0 to 20");
  }
  return recordReviewerVerdict(ctx, viewer.companyId, post, { agentId: viewer.agentId, verdict, notes: optionalString(params, "notes") ?? null, toneScore, toneReason: optionalString(params, "toneReason") ?? null });
}

/** `approve-post-as-delegate`: only the agent a person named as the scope's delegated approver (checks in `approvePostByDelegate`). */
export async function approvePostAsDelegateRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  if (!viewer.isAgent || !viewer.agentId) throw new SocialError("Only the delegated approver agent uses this tool. People approve on the Social page.");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const progress = await approvePostByDelegate(ctx, viewer, post);
  return { ...(await getPostDetail(ctx, viewer, post.id)), ...(progress.approval ? { approval: progress.approval } : {}), signoff: { completed: progress.completed, pending: progress.pending, message: progress.message } };
}

/** `return-post-as-delegate`: the delegated approver sends a post in review back to draft with notes (checks in `returnPostByDelegate`). */
export async function returnPostAsDelegateRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  if (!viewer.isAgent || !viewer.agentId) throw new SocialError("Only the delegated approver agent uses this tool. People approve on the Social page.");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const result = await returnPostByDelegate(ctx, viewer, post, optionalString(params, "notes"));
  return { ...(await getPostDetail(ctx, viewer, post.id)), ...result };
}

/** Page action `social.request-changes`: a person's note on a post goes to the Social agent and the post ends as a draft (`requestChangesByPerson`). */
export async function requestChangesRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "send changes to the agent");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const result = await requestChangesByPerson(ctx, viewer, post, optionalString(params, "notes"), { remember: params.remember === true });
  return { ...(await getPostDetail(ctx, viewer, post.id)), changes: result };
}

/** Page action `social.change-notes`: the change requests a post has had, newest first. */
export async function changeNotesRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  return { postId: post.id, notes: await changeNotesFor(ctx, viewer.companyId, post.id) };
}

/** `request-creative`: the hand-off issue for a post's image or video. */
export async function requestCreativeRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const durationS = params.durationS != null ? Number(params.durationS) : null;
  return requestCreative(ctx, viewer.companyId, post, { brief: optionalString(params, "brief"), format: optionalString(params, "format"), durationS });
}

/** A person records that the client approved outside the approval page. */
export async function recordClientApprovalRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "record the client's approval");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  if (post.status !== "review") throw new SocialError("Only a post in review can take the client's approval.");
  const progress = await recordClientApprovalByPerson(ctx, viewer, post, requiredString(params, "note"), optionalString(params, "by") ?? null);
  return { ...(await getPostDetail(ctx, viewer, post.id)), ...(progress.approval ? { approval: progress.approval } : {}), signoff: { completed: progress.completed, pending: progress.pending, message: progress.message } };
}

/** `review-outcomes`: first-pass rates and approval streaks per post type, as inputs for a later autonomy policy. */
export async function reviewOutcomesRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  return reviewStats(ctx, viewer.companyId, scope, Math.min(Math.max(positiveInt(params.days, "days", 90), 7), 365));
}

/** `media-compliance`: media and alt-text counts of published posts, and posts live with no Reviewer verdict. */
export async function mediaComplianceRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  return mediaCompliance(ctx, viewer.companyId, scope, Math.min(Math.max(positiveInt(params.days, "days", 28), 1), 365));
}

// ── accounts ────────────────────────────────────────────────────────────────

export async function listAccountsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  const platform = optionalString(params, "platform");
  return (await listAccounts(ctx, viewer.companyId, scope))
    .filter((a) => accountVisible(viewer, a))
    .filter((a) => !platform || a.platform === platform)
    .map(publicAccount);
}

export async function updateAccountRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "change account settings");
  const account = await requireAccount(ctx, viewer, requiredString(params, "accountId"));
  // "Belongs to": moving an account is refused while other-scope posts still target it.
  const requested = scopeInput(params);
  if (account.scope === "personal" && requested !== undefined && requested !== null) throw new SocialError("A personal account stays in My Social; it cannot be moved to a client");
  const target = requested === undefined || requested === null && account.scope === "personal" || sameClient(requested, scopeOfRow(account)) ? null : await resolveScope(ctx, viewer.companyId, requested);
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
    if (!account.token_enc && !isManual(account)) throw new SocialError("This account has no token; reconnect it instead");
    status = "connected";
  }
  const move = target ? await moveAccountScope(ctx, viewer.companyId, account, target) : null;
  await updateAccountSettings(ctx, viewer.companyId, account.id, {
    meta: Object.keys(meta).length ? meta : undefined,
    status,
  });
  const out = publicAccount((await getAccount(ctx, viewer.companyId, account.id))!);
  if (!move?.moved || !target) return out;
  const feeds = move.feedsDetached ? ` It was removed from ${move.feedsDetached} RSS feed${move.feedsDetached === 1 ? "" : "s"} of ${scopeLabel(account)}.` : "";
  return { ...out, moved: true, message: `${account.display_name} now belongs to ${scopeLabel(target)}.${feeds}` };
}

export async function disconnectAccountRecord(ctx: PluginContext, viewer: Viewer, accountId: string) {
  const userId = requireUser(viewer, "disconnect an account");
  const account = await requireAccount(ctx, viewer, accountId);
  if (isManual(account)) await disableManualAccount(ctx, viewer.companyId, account.id, `Switched off by a person (${userId})`);
  else await disconnectAccount(ctx, viewer.companyId, account.id, `Disconnected by a person (${userId})`);
  return { accountId: account.id, status: "disabled" };
}

export async function deleteAccountRecord(ctx: PluginContext, viewer: Viewer, accountId: string) {
  requireUser(viewer, "delete an account");
  const account = await requireAccount(ctx, viewer, accountId);
  if (account.status !== "disabled") throw new SocialError(`Disconnect ${account.display_name} first, then delete it`);
  const published = await publishedDestinationCount(ctx, viewer.companyId, account.id);
  if (published > 0) {
    throw new SocialError(
      `${account.display_name} has ${published} published post${published === 1 ? "" : "s"}. Deleting it would erase what was published there and its metrics, so it stays disconnected.`,
    );
  }
  const removed = await deleteDisabledAccount(ctx, viewer.companyId, account.id);
  if (!removed) throw new SocialError(`${account.display_name} was not deleted: it is no longer disconnected`);
  return { accountId: account.id, deleted: true };
}

export async function refreshAccountRecord(ctx: PluginContext, viewer: Viewer, accountId: string) {
  const account = await requireAccount(ctx, viewer, accountId);
  if (!isSocialPlatform(account.platform)) throw new SocialError("Unsupported platform");
  if (isManual(account)) return { accountId: account.id, refreshed: false, reason: "A manual account has no token: a person posts for it by hand" };
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

/**
 * How an account gets connected: a person signs in (a one-time grant), so the
 * agent asks once with the Cockpit's ask-owner tool and this deep link.
 */
export function connectInstructions(platformInput: string, redirectUri: string | null, accountsPath = "/social?tab=accounts") {
  if (!isSocialPlatform(platformInput)) throw new SocialError(`Unknown platform ${platformInput}`);
  const label = PLATFORM_LABELS[platformInput];
  const mode = CONNECT_MODE[platformInput];
  const steps =
    mode === "credentials"
      ? [`Open ${accountsPath}.`, `Click Connect ${label} and enter the handle and an app password (Bluesky: Settings → App passwords).`]
      : mode === "instance"
        ? [`Open ${accountsPath}.`, `Enter the Mastodon instance URL and click Connect ${label}.`]
        : [`Open ${accountsPath}.`, `Click Connect ${label} and sign in with the account that manages the page.`, "When asked, choose which pages, boards or channels to add."];
  return {
    platform: platformInput,
    label,
    link: accountsPath,
    steps,
    instructions: `A person connects ${label} (signing in is a one-time grant). Ask once with ${ASK_OWNER_TOOL}: say why you need it, give this link and these steps. You can post to it once list-connected-accounts shows it connected. Where ${label} has not approved our app yet, the person can add it as a manual account on the same page ("Add a manual account"): you draft, review and schedule as usual, and a person posts it by hand at the time.`,
    redirectUri,
  };
}

/**
 * `connect-account`: the steps and deep link for the scope's Accounts tab. When an agent asks, the wish is
 * recorded against the issue it is working on: connecting the account then comments on that issue, hands it
 * back to the agent and wakes it (connect-requests.ts), so the agent does not have to poll.
 */
export async function connectAccountRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, redirectUri: string | null) {
  const target = await readScope(ctx, viewer, params);
  const platform = requiredString(params, "platform");
  const instructions = connectInstructions(platform, redirectUri, withClientParam("/social?tab=accounts", target.scope));
  if (!viewer.isAgent) return instructions;
  // An issue named by identifier (PIB-23) is stored by id, so asking twice by either name is one request.
  const named = optionalString(params, "issueId");
  const issueId = named ? String((await ctx.issues.get(named, viewer.companyId).catch(() => null))?.id ?? named) : await issueOfRun(ctx, viewer.companyId, viewer.agentId, viewer.runId);
  const request = await recordConnectRequest(ctx, viewer.companyId, {
    platform,
    scope: target.scope,
    clientName: target.client?.name ?? null,
    agentId: viewer.agentId,
    runId: viewer.runId,
    issueId,
  });
  const clientValue = target.scope ? formatClientParam(target.scope) : "own";
  return {
    ...instructions,
    ...(request.id
      ? {
          noted: `Recorded against issue ${request.issueId}: when the account is connected the plugin comments there, hands the issue back to you and wakes you. Do not poll.`,
          effect: { key: CONNECT_EFFECT_KEY, params: { platform, client: clientValue } },
          effectNote: "If ask-owner has an `effect` parameter, pass this effect on your ask: when the owner answers, the plugin checks the account really is connected and tells you. Without it the plugin still wakes you when the account is connected.",
        }
      : { noted: "Pass the issue you are working on as issueId and the plugin will wake you when the account is connected." }),
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
  const owner = spaceOf(params) === "me" ? requireUser(viewer, "save a personal template") : null;
  await insertTemplate(ctx, { id: template.id, company_id: template.companyId, name: template.name, body: template.body, platform: template.platform, scope: owner ? "personal" : "org", owner_user_id: owner });
  return template;
}

export async function listTemplatesRecord(ctx: PluginContext, viewer: Viewer) {
  return (await listTemplates(ctx, viewer.companyId)).map((t) => ({ id: t.id, name: t.name, body: t.body, platform: t.platform }));
}

export async function listMediaRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  return (await listMediaAssets(ctx, viewer.companyId, scope)).map(assetOut);
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
    ...scopeOut(feed),
  };
}

export async function createRssFeedRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const draft = createRssFeed({ companyId: viewer.companyId, url: requiredString(params, "url") });
  const accountIds = Array.from(new Set([...(stringList(params, "accountIds") ?? []), ...(optionalString(params, "accountId") ? [optionalString(params, "accountId")!] : [])]));
  const owner = spaceOf(params) === "me" ? requireUser(viewer, "add a personal feed") : null;
  const target = await scopeFromParams(ctx, viewer.companyId, owner ? { ...params, client: null } : params);
  const columns = scopeColumns(target);
  for (const id of accountIds) {
    const account = await requireAccount(ctx, viewer, id);
    if (owner ? account.scope !== "personal" : account.scope !== "org") {
      throw new SocialError(owner ? "A personal feed can only draft to your own accounts" : "RSS drafts can only target organisation accounts");
    }
    assertAccountScope(columns, account);
  }
  await insertRssFeed(ctx, {
    id: draft.id,
    company_id: viewer.companyId,
    url: draft.url,
    account_id: accountIds[0] ?? null,
    account_ids: accountIds,
    ...columns,
    created_by_user_id: viewer.userId,
    scope: owner ? "personal" : "org",
    owner_user_id: owner,
  });
  return {
    id: draft.id,
    url: draft.url,
    accountIds,
    isActive: true,
    ...scopeOut(columns),
    message: "The feed is checked every 15 minutes; new items become draft posts.",
  };
}

export async function listRssFeedsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown> = {}) {
  const { scope } = await readScope(ctx, viewer, params);
  return (await listRssFeeds(ctx, viewer.companyId, scope)).map(feedOut);
}

export async function setRssActiveRecord(ctx: PluginContext, viewer: Viewer, feedId: string, active: boolean) {
  const feed = await getRssFeed(ctx, viewer.companyId, feedId);
  if (feed && feed.scope === "personal" && feed.owner_user_id !== viewer.userId) throw new SocialError("RSS feed was not found");
  if (!feed || !(await setRssFeedActive(ctx, viewer.companyId, feed.id, active))) throw new SocialError("RSS feed was not found");
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
    externalId: row.external_id,
    postId: row.post_id,
    replyDraft: row.reply_draft,
    replyBody: row.reply_body,
    repliedAt: iso(row.replied_at),
    receivedAt: iso(row.received_at) ?? iso(row.created_at),
    ...scopeOut(row),
    canReply: Boolean(row.external_id && row.platform && isSocialPlatform(row.platform) && providerFor(row.platform).reply),
    triage: triageOut(row.triage, row.triaged_at),
  };
}

export async function listInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const { scope } = await readScope(ctx, viewer, params);
  return (await listInboxItems(ctx, viewer.companyId, positiveInt(params.limit, "limit", 50), optionalString(params, "status"), scope)).map(inboxOut);
}

export async function recordInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const accountId = optionalString(params, "accountId");
  const account = accountId ? await requireAccount(ctx, viewer, accountId) : null;
  // An item on an account belongs to the account's scope; otherwise to the one named (own work by default).
  const requested = scopeInput(params);
  if (account && requested !== undefined && !inScope(account, requested)) {
    throw new SocialError(`${account.display_name} belongs to ${scopeLabel(account)}; record the item without a client or with that client.`);
  }
  const target = account ? rowScope(account) : await resolveScope(ctx, viewer.companyId, requested ?? null);
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
    ...scopeColumns(target),
  });
  return { ...item, ...scopeOut(scopeColumns(target)) };
}

function inboxVisible(viewer: Viewer, item: { scope: "org" | "personal"; owner_user_id: string | null }): boolean {
  return item.scope === "org" || item.owner_user_id === viewer.userId;
}

export async function markInboxReadRecord(ctx: PluginContext, viewer: Viewer, itemId: string) {
  const existing = await getInboxItem(ctx, viewer.companyId, itemId);
  if (existing && !inboxVisible(viewer, existing)) throw new SocialError("Inbox item was not found");
  if (!(await setInboxItemStatus(ctx, viewer.companyId, itemId, "read"))) throw new SocialError("Inbox item was not found");
  return { itemId, status: "read" };
}

/** A person posted the reply on the platform themselves (X): record what they posted. */
export async function markInboxRepliedRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "mark a reply as posted");
  const item = await getInboxItem(ctx, viewer.companyId, requiredString(params, "itemId"));
  if (!item || !inboxVisible(viewer, item)) throw new SocialError("Inbox item was not found");
  const body = optionalString(params, "body")?.trim() || null;
  await saveInboxReply(ctx, viewer.companyId, item.id, { status: "replied", replyDraft: null, replyBody: body ?? item.reply_draft ?? null, replied: true });
  return { itemId: item.id, status: "replied" };
}

/** A person asks the Social agent to draft a reply to this item. */
export async function requestInboxDraftRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  requireUser(viewer, "ask for a draft reply");
  const item = await getInboxItem(ctx, viewer.companyId, requiredString(params, "itemId"));
  if (!item || !inboxVisible(viewer, item)) throw new SocialError("Inbox item was not found");
  const account = item.account_id ? await getAccount(ctx, viewer.companyId, item.account_id) : null;
  if (!account) throw new SocialError("This item's account is no longer connected, so no agent can pick it up");
  const config = await loadSocialConfig(ctx, viewer.companyId);
  const issueId = await askAgentForDraft(ctx, config, account, item);
  if (!issueId) throw new SocialError("The agent could not be asked just now. Try again in a minute.");
  return { itemId: item.id, issueId };
}

export async function replyInboxRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const item = await getInboxItem(ctx, viewer.companyId, requiredString(params, "itemId"));
  if (!item || !inboxVisible(viewer, item)) throw new SocialError("Inbox item was not found");
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
    const dests = await destinationsForPost(ctx, post.id);
    const accounts = new Map<string, AccountRow | null>();
    for (const id of new Set(dests.map((d) => d.account_id))) accounts.set(id, await getAccount(ctx, viewer.companyId, id));
    const unmeasuredReason = (d: DestinationRow): string | null => {
      const account = accounts.get(d.account_id);
      if (!d.external_id) return "no external id (marked posted by hand without a link)";
      if (!account || account.status === "disabled" || !account.token_enc) return "account disabled or disconnected";
      if (!isSocialPlatform(account.platform) || !providerFor(account.platform).metrics) return "platform has no metrics";
      return null;
    };
    return {
      postId: post.id,
      ...aggregateMetrics(latest.map(metricNumbers)),
      destinations: dests.map((d) => {
        const result = d.result && typeof d.result === "object" && !Array.isArray(d.result) ? (d.result as Record<string, unknown>) : {};
        const reason = unmeasuredReason(d);
        return { destinationId: d.id, accountId: d.account_id, status: d.status, metricWindows: d.metric_windows ?? [], metricsError: result.metricsError ?? null, measurable: reason === null, unmeasuredReason: reason };
      }),
      snapshots: rows.map((r) => ({ window: r.metric_window, platform: r.platform, destinationId: r.destination_id, recordedAt: iso(r.recorded_at), ...metricNumbers(r), impressions: r.impressions == null ? null : Number(r.impressions), reach: r.reach == null ? null : Number(r.reach), saves: r.saves == null ? null : Number(r.saves), clicks: r.clicks == null ? null : Number(r.clicks) })),
    };
  }
  const target = await readScope(ctx, viewer, params);
  const rows = await metricsForCompany(ctx, viewer.companyId, target.scope);
  const latest = latestPerDestination(rows);
  const byPlatform: Record<string, ReturnType<typeof aggregateMetrics>> = {};
  for (const platform of ALL_PLATFORMS) {
    const list = latest.filter((r) => r.platform === platform);
    if (list.length) byPlatform[platform] = aggregateMetrics(list.map(metricNumbers));
  }
  return { postId: null, ...scopeOut(scopeColumns(target)), ...aggregateMetrics(latest.map(metricNumbers)), destinations: latest.length, byPlatform };
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

export async function accountAnalyticsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown> = {}) {
  const { scope } = await readScope(ctx, viewer, params);
  const accounts = new Map((await listAccounts(ctx, viewer.companyId, scope)).map((a) => [a.id, a]));
  const metrics = (await accountMetrics(ctx, viewer.companyId)).filter((row) => accounts.has(row.accountId));
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

function clientOut(client: CrmClient) {
  return { kind: client.kind, id: client.id, name: client.name, domain: client.domain, email: client.email, lifecycle: client.lifecycle, client: formatClientParam(client) };
}

/** Clients for "Belongs to" pickers: CRM companies, then contacts. */
export async function listClientsRecord(ctx: PluginContext, viewer: Viewer) {
  return (await listClients(ctx, viewer.companyId)).map(clientOut);
}

/**
 * Everything the Social page shows for one scope: `client` names it
 * ("company:<id>" / "contact:<id>"); without it the page is own work.
 */
export async function loadSnapshot(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown> = {}) {
  // `space: "me"` is the signed-in user's own socials: the same page and tabs, filled from their personal rows only.
  const space = spaceOf(params);
  const me = space === "me" ? requireUser(viewer, "open My Social") : null;
  const target = await scopeFromParams(ctx, viewer.companyId, me ? { ...params, client: null } : params);
  const scope: ClientScope = target.scope;
  const [config, accounts, posts, destinations, templates, media, feeds, inbox, agent, pickers, experiments, stats, policy] = await Promise.all([
    loadSocialConfig(ctx, viewer.companyId),
    me ? listPersonalAccounts(ctx, viewer.companyId, me) : listAccounts(ctx, viewer.companyId, scope),
    me ? listPersonalPosts(ctx, viewer.companyId, me, { limit: 300 }) : listPosts(ctx, viewer.companyId, { limit: 300, scope }),
    me ? destinationsForPersonal(ctx, viewer.companyId, me) : destinationsForScope(ctx, viewer.companyId, scope),
    me ? listPersonalTemplates(ctx, viewer.companyId, me) : listTemplates(ctx, viewer.companyId),
    me ? listPersonalMediaAssets(ctx, viewer.companyId, me) : listMediaAssets(ctx, viewer.companyId, scope),
    me ? listPersonalRssFeeds(ctx, viewer.companyId, me) : listRssFeeds(ctx, viewer.companyId, scope),
    me ? listPersonalInboxItems(ctx, viewer.companyId, me, 100) : listInboxItems(ctx, viewer.companyId, 100, undefined, scope),
    // Hire status (open task, candidates) is only shown on the own page.
    agentSummary(ctx, viewer.companyId, { hire: !scope }),
    listPendingPickers(ctx, viewer.companyId, viewer.userId),
    // Growth Lab experiments a post in this scope can be tagged with.
    me ? Promise.resolve([]) : experimentOptions(growthEnv(ctx), viewer.companyId, scope).catch(() => []),
    // Chart series (published per day, destination statuses, weekly lift).
    me ? Promise.resolve(emptyStats()) : scopeStats(ctx, viewer.companyId, scope),
    // Who approves posts in this scope (the page shows it and a person can change it).
    getPolicy(ctx, viewer.companyId, scope),
  ]);
  const accountMap = await accountsFor(ctx, viewer.companyId, accounts, destinations);
  const byPost = groupByPost(destinations);
  // The scope's delegated approver; the agents a person may pick (never shown to an agent).
  const [delegate, candidates] = me
    ? [null, []]
    : await Promise.all([delegateView(ctx, viewer.companyId, scope), viewer.isAgent || !viewer.userId ? Promise.resolve([]) : delegateCandidates(ctx, viewer.companyId, scope)]);
  // Own page: the weekly routine, so the page (a board user) can read its trigger and switch it on.
  const routine = scope || me ? null : await weeklyRoutine(ctx, viewer.companyId);
  let redirectUri: string | null = null;
  try {
    redirectUri = config.redirectUri();
  } catch {
    redirectUri = null;
  }
  // Check if linkedinPages app is configured
  let linkedinPagesConfigured = false;
  try {
    await config.linkedinPages();
    linkedinPagesConfigured = true;
  } catch {
    linkedinPagesConfigured = false;
  }
  return {
    space,
    scope: scope ? formatClientParam(scope) : null,
    client: target.client ? clientOut(target.client) : null,
    config: {
      saved: config.saved,
      publicBaseUrl: config.publicBaseUrl,
      publicBaseUrlError: config.publicBaseUrlError,
      redirectUri,
      encryptionKey: config.encryptionKeyConfigured,
      r2: config.r2Configured,
      timezone: config.timezone,
      allowAgentReplies: config.allowAgentReplies,
      blueskyDefaultPds: config.blueskyDefaultPds,
      mastodonDefaultInstance: config.mastodonDefaultInstance,
      linkedinPagesConfigured,
      jev: jevKeySet(config.raw),
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
    experiments,
    stats,
    approvalPolicy: policyOut(policy, delegate),
    delegateCandidates: candidates,
    agent,
    pendingPickers: pickers
      .filter((p) => (jsonObject(p.extra).accountScope === "personal") === Boolean(me))
      .filter((p) => sameClient(sessionScope(jsonObject(p.extra)).scope, scope))
      .map((p) => ({ pickerId: p.picker_id, platform: p.platform })),
    routine,
    viewer: { userId: viewer.userId },
  };
}

/** The weekly plan routine (id, status, title) and the page's last trigger report; null when it does not exist yet. */
async function weeklyRoutine(ctx: PluginContext, companyId: string) {
  try {
    const managed = await ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId);
    const r = managed.routine;
    if (!r) return null;
    const report = await routineReport(ctx, companyId, PLAN_ROUTINE_KEY, r.id);
    return { id: r.id, key: PLAN_ROUTINE_KEY, title: PLAN_ROUTINE_TITLE, status: String(r.status), triggersOn: report ? report.triggersOn : null };
  } catch (error) {
    ctx.logger.info("Social routine lookup skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ── client summary (CRM client workspace) ───────────────────────────────────

export interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the CRM client workspace shows on its Social tile. */
export async function clientSummaryRecord(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ClientSummary> {
  const row = await scopeSummary(ctx, companyId, scope);
  const connected = Number(row.connected ?? 0);
  const reconnect = Number(row.needs_reconnect ?? 0);
  const scheduled = Number(row.scheduled_week ?? 0);
  const failed = Number(row.failed ?? 0);
  const last = iso(row.last_published);
  const parts = [plural(connected, "account"), `${scheduled} scheduled`];
  if (failed) parts.push(`${failed} failed`);
  if (reconnect) parts.push(`${reconnect} to reconnect`);
  return {
    headline: connected === 0 && scheduled === 0 && !last ? "No social accounts yet" : parts.join(" · "),
    stats: [
      { label: "Connected accounts", value: connected, tone: connected > 0 ? "ok" : undefined },
      { label: "Needs reconnect", value: reconnect, tone: reconnect > 0 ? "warn" : undefined },
      { label: "Scheduled (next 7 days)", value: scheduled },
      { label: "Failed posts (30 days)", value: failed, tone: failed > 0 ? "bad" : undefined },
      { label: "Last published", value: last ? last.slice(0, 10) : "Never" },
    ],
  };
}
