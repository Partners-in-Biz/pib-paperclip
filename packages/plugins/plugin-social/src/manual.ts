/**
 * Manual accounts: a platform account with no publishing link. The platform has not approved our app yet (TikTok),
 * or a person prefers to post there themselves. Posts to it are drafted, reviewed, approved and scheduled like any
 * other; at the publish time the destination waits (`awaiting_manual`), a task asks a person, and the post page gives
 * them the caption, the media and the platform's own composer. `markDestinationPostedRecord` records that they posted.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeColumns, scopeFromParams, scopeLabel, type ResolvedScope } from "./clients.js";
import { resolveConnectRequests } from "./connect-requests.js";
import {
  type DestinationRow,
  type PostRow,
  destinationsForPost,
  findAccountByExternal,
  getAccountsByIds,
  insertManualAccount,
  isManual,
  saveDestinationOutcome,
  setPostOutcome,
} from "./db.js";
import { rollupPostStatus, SocialError } from "./domain.js";
import { closeManualPostIssue } from "./issues.js";
import { startPlan } from "./plan-trigger.js";
import { isSocialPlatform, manualExternalId, PLATFORM_LABELS } from "./platforms.js";
import { getPostDetail, optionalString, requiredString, requirePost, requireUser, xStatusIdFor, type Viewer } from "./service.js";
import { spaceOf } from "./space.js";

const HANDLE = /^[A-Za-z0-9._-]{1,60}$/;

/** `@name`, `name` or a profile link: the bare handle. */
export function cleanHandle(input: string): string {
  let value = input.trim();
  const link = /^https?:\/\/[^/]+\/(?:@|c\/|channel\/|company\/|in\/|r\/|u\/|user\/)?([^/?#]+)/i.exec(value);
  if (link) value = link[1]!;
  value = value.replace(/^@+/, "");
  if (!HANDLE.test(value)) throw new SocialError("Enter the account's handle, like @partnersinbiz (letters, numbers, dots, dashes and underscores)");
  return value;
}

/** A person adds a manual account to this page's scope (own work, a client, or My Social). */
export async function addManualAccountRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "add a manual account");
  const platform = requiredString(params, "platform");
  if (!isSocialPlatform(platform)) throw new SocialError(`Unknown platform ${platform}`);
  const handle = cleanHandle(requiredString(params, "handle"));
  const personal = spaceOf(params) === "me";
  const target: ResolvedScope = await scopeFromParams(ctx, viewer.companyId, personal ? { ...params, client: null } : params);
  const profileUrl = optionalString(params, "profileUrl") ?? null;
  if (profileUrl && !/^https:\/\//i.test(profileUrl)) throw new SocialError("The profile link must start with https://");
  const externalId = manualExternalId(handle);
  const space = { scope: personal ? ("personal" as const) : ("org" as const), ownerUserId: personal ? userId : null };
  const existing = await findAccountByExternal(ctx, viewer.companyId, platform, externalId, space);
  if (existing) throw new SocialError(`@${handle} is already added on ${PLATFORM_LABELS[platform]} (${scopeLabel(existing)})`);
  const displayName = optionalString(params, "displayName") ?? `@${handle}`;
  const saved = await insertManualAccount(ctx, {
    company_id: viewer.companyId,
    platform,
    display_name: displayName.slice(0, 120),
    external_id: externalId,
    handle: `@${handle}`,
    meta: { kind: "manual", via: "manual", ...(profileUrl ? { profileUrl } : {}) },
    scope: space.scope,
    owner_user_id: space.ownerUserId,
    ...scopeColumns(target),
    created_by_user_id: userId,
  });
  if (!personal) {
    // Same follow-ups as a signed-in account: the scope's first plan, and the agent that asked for this platform is told.
    await startPlan(ctx, viewer.companyId, target);
    await resolveConnectRequests(
      ctx,
      viewer.companyId,
      { platform, accountId: saved.id, displayName, scope: target.scope, reconnectIssueId: null, reconnected: false },
      target.client?.name ?? null,
    );
  }
  return { id: saved.id, platform, displayName, handle: `@${handle}`, manual: true, belongsTo: personal ? "My Social" : scopeLabel(target) };
}

const MARKABLE_POST = new Set(["approved", "scheduled", "publishing", "partially_published", "failed"]);

/**
 * A person posted one destination by hand. `url` is the link to what they posted (optional: not every platform shows
 * one at once). The post rolls up like after a publish run, and the post-by-hand task closes when nothing waits.
 */
export async function markDestinationPostedRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "mark a post as posted");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const destinationId = requiredString(params, "destinationId");
  const url = optionalString(params, "url") || null;
  if (url && !/^https:\/\//i.test(url)) throw new SocialError("The link must start with https://");
  if (!MARKABLE_POST.has(post.status)) throw new SocialError(`A ${post.status} post cannot be marked as posted. Approve it first.`);
  const destinations = await destinationsForPost(ctx, post.id);
  const destination = destinations.find((d) => d.id === destinationId);
  if (!destination) throw new SocialError("That destination is not on this post");
  if (destination.status === "published") throw new SocialError("That destination is already published");
  if (destination.status === "publishing") throw new SocialError("That destination is being published right now. Try again in a minute.");
  const account = (await getAccountsByIds(ctx, viewer.companyId, [destination.account_id]))[0];
  // An account with a publishing link publishes itself; only a failed attempt there is settled by hand.
  if (account && !isManual(account) && destination.status !== "failed") {
    throw new SocialError(`${account.display_name} publishes on its own. Only a failed destination can be marked as posted by hand.`);
  }
  await saveDestinationOutcome(ctx, destination.id, {
    status: "published",
    nextAttemptAt: null,
    externalId: xStatusIdFor(account, url),
    externalUrl: url,
    lastError: null,
    result: { ok: true, manual: true, at: new Date().toISOString(), by: userId },
  });
  return settleAfterHand(ctx, viewer, post, destination);
}

/**
 * A person decides not to post a destination that waits for them: it is recorded as failed ("skipped by a person"),
 * so the post leaves `publishing` and can be edited, retried or deleted. No failure issue is opened: nothing broke.
 */
export async function skipDestinationRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "skip a post");
  const post = await requirePost(ctx, viewer, requiredString(params, "postId"));
  const destinationId = requiredString(params, "destinationId");
  const destination = (await destinationsForPost(ctx, post.id)).find((d) => d.id === destinationId);
  if (!destination) throw new SocialError("That destination is not on this post");
  if (destination.status !== "awaiting_manual") throw new SocialError("Only a destination that waits to be posted by hand can be skipped");
  await saveDestinationOutcome(ctx, destination.id, {
    status: "failed",
    nextAttemptAt: null,
    externalId: null,
    externalUrl: null,
    lastError: "Not posted: skipped by a person",
    result: { ok: false, manual: true, skipped: true, at: new Date().toISOString(), by: userId },
  });
  return settleAfterHand(ctx, viewer, post, destination);
}

/** Roll the post up after a person settled one destination, and close the post-by-hand task when nothing waits. */
async function settleAfterHand(ctx: PluginContext, viewer: Viewer, post: PostRow, destination: DestinationRow) {
  const after = await destinationsForPost(ctx, post.id);
  const status = rollupPostStatus(after.map((d) => d.status));
  const published = after.filter((d) => d.status === "published").length;
  const failed = after.filter((d) => d.status === "failed").length;
  // Before its time (approved, scheduled) the post keeps its status until the last destination is out.
  const early = post.status === "approved" || post.status === "scheduled";
  if (status === "published" || (!early && status !== "publishing")) {
    await setPostOutcome(ctx, post.id, { status, error: failed ? `${failed} of ${after.length} destinations were not published` : null, publishedAt: published > 0 });
  }
  if (destination.issue_id && destination.status === "awaiting_manual" && !after.some((d) => d.status === "awaiting_manual" && d.issue_id === destination.issue_id)) {
    await closeManualPostIssue(ctx, viewer.companyId, destination.issue_id);
  }
  return getPostDetail(ctx, viewer, post.id);
}
