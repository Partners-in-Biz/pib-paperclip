/**
 * Publishing engine (`publish-due` job, every 5 minutes).
 *
 * 1. Give back claims a crashed run left behind; fail scheduled posts with
 *    nothing left to try.
 * 2. For each due post (company id taken from the row): move scheduled →
 *    publishing, atomically claim its due destinations (attempts + 1).
 * 3. Resolve the account token (refresh when it lapses within 5 minutes),
 *    publish with the post's media and per-platform override, store the
 *    external id/url.
 * 4. Failures retry after 1m, 5m, 15m, 60m; the 5th failure is final.
 *    Published destinations are never published again.
 * 5. Roll the post up to published / partially_published / failed and open
 *    one issue on the first final failure.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  AccountUnavailable,
  envFor,
  markNeedsReconnect,
  refreshAccountToken,
  toProviderAccount,
} from "./accounts.js";
import { inScope, scopeLabel, scopeOfRow } from "./clients.js";
import { loadSocialConfig, type SocialConfig } from "./config.js";
import {
  claimDestinations,
  destinationsForPost,
  duePostRefs,
  getAccount,
  getPost,
  iso,
  postMedia,
  postOverrides,
  releaseStaleClaims,
  resetFailedDestinations,
  saveDestinationOutcome,
  scheduledPostsWithoutWork,
  setDestinationIssue,
  setPostFailureIssue,
  setPostOutcome,
  setPostStatus,
  type AccountRow,
  type DestinationRow,
  type PostRow,
} from "./db.js";
import { needsRefreshBeforePublish, nextDestinationState, rollupPostStatus, SocialError } from "./domain.js";
import { openPublishFailureIssue } from "./issues.js";
import { graphemeLength } from "./oauth/providers/bluesky.js";
import { xWeightedLength } from "./oauth/providers/x.js";
import { ProviderHttpError } from "./oauth/http.js";
import { providerFor } from "./oauth/registry.js";
import type { PublishOutcome, PublishRequest } from "./oauth/types.js";
import { isSocialPlatform, PLATFORM_LABELS, PLATFORM_LIMITS, type SocialPlatform } from "./platforms.js";

/** The request a destination publishes: the post plus that platform's override. */
export function buildPublishRequest(post: Pick<PostRow, "body" | "media" | "overrides" | "first_comment">, platform: SocialPlatform): PublishRequest {
  const override = postOverrides(post)[platform] ?? {};
  const pick = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    text: pick(override.text) ?? post.body.trim(),
    title: pick(override.title),
    link: pick(override.link),
    privacy: pick(override.privacy),
    subreddit: pick(override.subreddit),
    boardId: pick(override.boardId),
    firstComment: pick(post.first_comment),
    media: postMedia(post),
  };
}

/** Problems that would make a destination fail for sure. Checked before scheduling. */
export function validateDestination(platform: SocialPlatform, request: PublishRequest, accountMeta: Record<string, unknown> = {}): string[] {
  const label = PLATFORM_LABELS[platform];
  const limits = PLATFORM_LIMITS[platform];
  const problems: string[] = [];
  const imgs = request.media.filter((m) => m.kind === "image").length;
  const vids = request.media.filter((m) => m.kind === "video").length;
  if (limits.needsMedia === "any" && request.media.length === 0) problems.push(`${label} needs an image or a video`);
  if (limits.needsMedia === "image" && imgs === 0) problems.push(`${label} needs an image`);
  if (limits.needsMedia === "video" && vids !== 1) problems.push(`${label} needs exactly one video`);
  if (!limits.video && vids > 0) problems.push(`${label} posts from here do not support video`);
  if (request.media.length > limits.maxMedia) problems.push(`${label} takes at most ${limits.maxMedia} media items`);
  const length = platform === "x" ? xWeightedLength(request.link && !request.text.includes(request.link) ? `${request.text}\n\n${request.link}` : request.text)
    : platform === "bluesky" ? graphemeLength(request.text)
    : Array.from(request.text).length;
  const maxText = platform === "x" && accountMeta.longPosts ? 25_000 : limits.maxText;
  if (length > maxText) problems.push(`${label} text is ${length} characters; the limit is ${maxText}. Add a ${label} override.`);
  if (platform === "reddit" && !request.subreddit && !accountMeta.defaultSubreddit) problems.push("Reddit needs a subreddit (post override or account default)");
  if (platform === "pinterest" && !request.boardId && !accountMeta.boardId) problems.push("Pinterest needs a board");
  if (platform === "reddit" && !(request.title ?? request.text.split("\n")[0] ?? "").trim()) problems.push("Reddit needs a title");
  if (!request.text && request.media.length === 0 && !request.link) problems.push(`${label} needs text or media`);
  return problems;
}

function publishable(account: AccountRow): string | null {
  if (!account.token_enc || account.status === "disabled") return `${account.display_name} is disconnected`;
  return null;
}

async function publishDestination(
  ctx: PluginContext,
  config: SocialConfig,
  post: PostRow,
  destination: DestinationRow,
): Promise<{ outcome: PublishOutcome; account: AccountRow | null }> {
  const companyId = post.company_id;
  const account = await getAccount(ctx, companyId, destination.account_id);
  if (!account) return { outcome: { ok: false, retryable: false, error: "The destination account was removed" }, account: null };
  const blocked = publishable(account);
  if (blocked) return { outcome: { ok: false, retryable: false, error: blocked }, account };
  // Never publish one client's post to another client's (or own) account, e.g. after the account moved.
  if (!inScope(account, scopeOfRow(post))) {
    return {
      outcome: { ok: false, retryable: false, error: `${account.display_name} belongs to ${scopeLabel(account)}, not ${scopeLabel(post)}; not published` },
      account,
    };
  }
  if (!isSocialPlatform(account.platform)) return { outcome: { ok: false, retryable: false, error: `Unsupported platform ${account.platform}` }, account };
  const platform = account.platform;
  const provider = providerFor(platform);
  try {
    const keyring = await config.keyring();
    let current = toProviderAccount(account, keyring);
    if (provider.refresh && provider.refreshKind !== "none" && needsRefreshBeforePublish(iso(account.token_expires_at))) {
      try {
        current = (await refreshAccountToken(ctx, config, account)).account;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if ((error instanceof ProviderHttpError && !error.retryable) || error instanceof AccountUnavailable) {
          await markNeedsReconnect(ctx, companyId, account, `Token refresh failed: ${message}`);
        }
        return { outcome: { ok: false, retryable: true, error: `Token refresh failed: ${message}` }, account };
      }
    }
    const env = await envFor(config, platform, current.meta, { idempotencyKey: destination.id });
    const request = buildPublishRequest(post, platform);
    const outcome = await provider.publish(env, current, request);
    if (!outcome.ok && outcome.tokenInvalid) {
      await markNeedsReconnect(ctx, companyId, account, outcome.error ?? "The platform rejected the token");
    }
    return { outcome, account };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AccountUnavailable) {
      if (error.needsReconnect) await markNeedsReconnect(ctx, companyId, account, message);
      return { outcome: { ok: false, retryable: false, error: message }, account };
    }
    // Configuration problems (missing secret, key...) can be fixed within the retry window.
    return { outcome: { ok: false, retryable: !(error instanceof SocialError), error: message }, account };
  }
}

async function settlePost(ctx: PluginContext, companyId: string, postId: string, accounts: Map<string, AccountRow | null>): Promise<void> {
  const post = await getPost(ctx, companyId, postId);
  if (!post) return;
  const destinations = await destinationsForPost(ctx, postId);
  const status = rollupPostStatus(destinations.map((d) => d.status));
  const failed = destinations.filter((d) => d.status === "failed");
  const published = destinations.filter((d) => d.status === "published").length;
  if (status !== "publishing") {
    await setPostOutcome(ctx, postId, {
      status,
      error: destinations.length === 0
        ? "No destination accounts were attached"
        : failed.length ? `${failed.length} of ${destinations.length} destinations failed` : null,
      publishedAt: published > 0,
    });
  }
  const unreported = failed.filter((d) => !d.issue_id);
  if (unreported.length === 0) return;
  for (const d of unreported) {
    if (!accounts.has(d.account_id)) accounts.set(d.account_id, await getAccount(ctx, companyId, d.account_id));
  }
  const rows = unreported.map((destination) => ({ destination, account: accounts.get(destination.account_id) ?? null }));
  if (post.failure_issue_id) {
    const lines = rows.map(({ destination, account }) => `- ${account ? `${account.platform} · ${account.display_name}` : destination.account_id}: ${destination.last_error ?? "failed"}`);
    try {
      await ctx.issues.createComment(post.failure_issue_id, `Publishing failed again:\n\n${lines.join("\n")}`, companyId);
    } catch (error) {
      ctx.logger.info("Could not comment on the failure issue", { postId, error: error instanceof Error ? error.message : String(error) });
    }
    await setDestinationIssue(ctx, postId, post.failure_issue_id);
    return;
  }
  const issueId = await openPublishFailureIssue(ctx, { companyId, post, failed: rows, published });
  if (issueId) {
    await setPostFailureIssue(ctx, postId, issueId);
    await setDestinationIssue(ctx, postId, issueId);
  }
}

/** Publish every due destination of one post. */
export async function publishPost(ctx: PluginContext, config: SocialConfig, postId: string): Promise<{ attempted: number; published: number }> {
  const companyId = config.companyId;
  const post = await getPost(ctx, companyId, postId);
  if (!post) return { attempted: 0, published: 0 };
  if (post.status === "scheduled") {
    if (!(await setPostStatus(ctx, companyId, postId, ["scheduled"], "publishing"))) return { attempted: 0, published: 0 };
  } else if (post.status !== "publishing") {
    return { attempted: 0, published: 0 };
  }
  const claimToken = randomUUID();
  const claimed = await claimDestinations(ctx, postId, claimToken);
  const accounts = new Map<string, AccountRow | null>();
  let published = 0;
  for (const destination of claimed) {
    const { outcome, account } = await publishDestination(ctx, config, post, destination);
    accounts.set(destination.account_id, account);
    const next = nextDestinationState(destination.attempts, { ok: outcome.ok, retryable: outcome.retryable });
    if (outcome.ok) published += 1;
    await saveDestinationOutcome(ctx, destination.id, {
      status: next.status,
      nextAttemptAt: next.nextAttemptAt ? next.nextAttemptAt.toISOString() : null,
      externalId: outcome.externalId ?? null,
      externalUrl: outcome.url ?? null,
      lastError: outcome.ok ? null : (outcome.error ?? "Publish failed").slice(0, 2000),
      result: {
        ok: outcome.ok,
        attempt: destination.attempts,
        at: new Date().toISOString(),
        ...(outcome.detail ?? {}),
        ...(outcome.ok ? {} : { error: outcome.error, retryable: outcome.retryable !== false }),
      },
    });
  }
  await settlePost(ctx, companyId, postId, accounts);
  return { attempted: claimed.length, published };
}

export interface PublishRunSummary {
  companies: number;
  posts: number;
  attempted: number;
  published: number;
  skipped: string[];
}

export async function publishDueJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>): Promise<PublishRunSummary> {
  const summary: PublishRunSummary = { companies: 0, posts: 0, attempted: 0, published: 0, skipped: [] };
  await releaseStaleClaims(ctx);
  for (const stuck of await scheduledPostsWithoutWork(ctx)) {
    await settlePost(ctx, stuck.company_id, stuck.id, new Map());
  }
  const due = await duePostRefs(ctx);
  const byCompany = new Map<string, string[]>();
  for (const row of due) byCompany.set(row.company_id, [...(byCompany.get(row.company_id) ?? []), row.id]);
  for (const [companyId, postIds] of byCompany) {
    summary.companies += 1;
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) {
      // Without a saved config row the host denies company-scoped calls; leave the posts due.
      summary.skipped.push(`${companyId}: Social settings not saved`);
      ctx.logger.info("Social publish skipped: settings not saved for company", { companyId });
      continue;
    }
    for (const postId of postIds) {
      try {
        const result = await publishPost(ctx, config, postId);
        summary.posts += 1;
        summary.attempted += result.attempted;
        summary.published += result.published;
      } catch (error) {
        ctx.logger.error("Social publish failed for post", { companyId, postId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return summary;
}

/** Manual retry: failed destinations go back to pending; published ones stay untouched. */
export async function retryPost(ctx: PluginContext, companyId: string, post: PostRow): Promise<{ reset: number; status: string }> {
  if (post.status !== "failed" && post.status !== "partially_published" && post.status !== "publishing") {
    throw new SocialError(`Only failed or partially published posts can be retried (this one is ${post.status.replace("_", " ")})`);
  }
  const reset = await resetFailedDestinations(ctx, companyId, post.id);
  if (reset === 0) throw new SocialError("There are no failed destinations to retry");
  if (post.status !== "publishing") await setPostStatus(ctx, companyId, post.id, ["failed", "partially_published"], "publishing");
  return { reset, status: "publishing" };
}
