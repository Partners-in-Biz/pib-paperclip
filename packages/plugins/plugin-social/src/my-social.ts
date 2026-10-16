/**
 * Personal My Social actions: accounts and posts owned by the authenticated user only.
 * Security rules:
 * - Actor must be an authenticated human user, never an agent (except create-draft for agents)
 * - All results filtered to scope='personal' AND owner_user_id = actor.userId
 * - Org posts/accounts never returned
 * - Responses never include token/secret fields
 * - Update/delete only allowed on draft status
 * - Approve only for owner, transitions draft -> approved/scheduled
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { approvePostByPerson } from "./approval-flow.js";
import {
  deleteDestination,
  deletePost,
  disconnectAccount,
  destinationsForPost,
  getAccount,
  getPost,
  insertDestination,
  insertPost,
  listPersonalAccounts,
  listPersonalPosts,
  setPostStatus,
  updatePostContent,
  type AccountRow,
  type PostWrite,
} from "./db.js";
import { SocialError } from "./domain.js";
import {
  optionalString,
  postOut,
  requireUser,
  requiredString,
  type Viewer,
} from "./service.js";
import { publicAccount } from "./accounts.js";
import { loadSocialConfig } from "./config.js";

// ── my-social.accounts: List personal accounts ──────────────────────────────

export async function myAccountsAction(
  ctx: PluginContext,
  viewer: Viewer,
): Promise<unknown> {
  const userId = requireUser(viewer, "list personal accounts");
  const accounts = await listPersonalAccounts(ctx, viewer.companyId, userId);
  return accounts.map(publicAccount);
}

// ── my-social.posts: List personal posts ────────────────────────────────────

export async function myPostsAction(
  ctx: PluginContext,
  viewer: Viewer,
): Promise<unknown> {
  const userId = requireUser(viewer, "list personal posts");
  const posts = await listPersonalPosts(ctx, viewer.companyId, userId);
  const accountsById = new Map<string, AccountRow>();

  // Fetch destination accounts
  for (const post of posts) {
    const destinations = await destinationsForPost(ctx, post.id);
    for (const dest of destinations) {
      if (!accountsById.has(dest.account_id)) {
        const account = await getAccount(ctx, viewer.companyId, dest.account_id);
        if (account) {
          accountsById.set(dest.account_id, account);
        }
      }
    }
  }

  // Convert to UI format
  const result = [];
  for (const post of posts) {
    const destinations = await destinationsForPost(ctx, post.id);
    result.push(postOut(post, destinations, accountsById));
  }
  return result;
}

// ── my-social.create-draft: Create a personal draft ──────────────────────────

export async function myCreateDraftAction(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const body = requiredString(params, "body");
  const accountIds = extractAccountIds(params);

  // Agents can create drafts for any user (with targetUserId), but humans only for themselves
  let targetUserId: string;
  if (viewer.isAgent) {
    targetUserId = requiredString(params, "targetUserId");
  } else {
    targetUserId = requireUser(viewer, "create a personal draft");
  }

  // Validate accounts exist and belong to target user
  await validatePersonalAccounts(
    ctx,
    viewer.companyId,
    accountIds,
    targetUserId,
  );

  // Create the draft
  const postId = randomUUID();
  const row: PostWrite = {
    id: postId,
    company_id: viewer.companyId,
    body,
    status: "draft",
    scope: "personal",
    owner_user_id: targetUserId,
    media: [],
    overrides: {},
    scheduled_at: null,
    first_comment: null,
    client_kind: null,
    client_ref: null,
    client_name: null,
    source: viewer.isAgent ? "agent" : "manual",
    source_ref: null,
    created_by_agent_id: viewer.agentId,
  };

  await insertPost(ctx, row);

  // Attach accounts
  for (const accountId of accountIds) {
    await insertDestination(ctx, {
      companyId: viewer.companyId,
      postId,
      accountId,
    });
  }

  const created = (await getPost(ctx, viewer.companyId, postId))!;
  return { id: created.id, status: created.status };
}

// ── my-social.update-draft: Update a personal draft ──────────────────────────

export async function myUpdateDraftAction(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const userId = requireUser(viewer, "update a personal draft");
  const postId = requiredString(params, "postId");
  const body = requiredString(params, "body");
  const accountIds = extractAccountIds(params);

  const post = await getPost(ctx, viewer.companyId, postId);
  if (!post) {
    throw new SocialError("Post not found");
  }

  // Verify ownership and status
  if (post.scope !== "personal" || post.owner_user_id !== userId) {
    throw new SocialError("Cannot edit this personal post");
  }
  if (post.status !== "draft") {
    throw new SocialError("Only draft posts can be edited");
  }

  // Validate new accounts
  await validatePersonalAccounts(
    ctx,
    viewer.companyId,
    accountIds,
    userId,
  );

  // Update content
  await updatePostContent(ctx, viewer.companyId, postId, { body });

  // Update destinations
  const existing = await destinationsForPost(ctx, postId);
  for (const dest of existing) {
    await deleteDestination(ctx, viewer.companyId, postId, dest.account_id);
  }
  for (const accountId of accountIds) {
    await insertDestination(ctx, {
      companyId: viewer.companyId,
      postId,
      accountId,
    });
  }

  const updated = (await getPost(ctx, viewer.companyId, postId))!;
  return { id: updated.id, status: updated.status };
}

// ── my-social.delete-draft: Delete a personal draft ──────────────────────────

export async function myDeleteDraftAction(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const userId = requireUser(viewer, "delete a personal draft");
  const postId = requiredString(params, "postId");

  const post = await getPost(ctx, viewer.companyId, postId);
  if (!post) {
    throw new SocialError("Post not found");
  }

  // Verify ownership and status
  if (post.scope !== "personal" || post.owner_user_id !== userId) {
    throw new SocialError("Cannot delete this personal post");
  }
  if (post.status !== "draft") {
    throw new SocialError("Only draft posts can be deleted");
  }

  await deletePost(ctx, viewer.companyId, postId);
  return { deleted: postId };
}

// ── my-social.approve: Approve and schedule/publish personal draft ──────────

export async function myApproveAction(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const userId = requireUser(viewer, "approve a personal post");
  const postId = requiredString(params, "postId");
  const mode = requiredString(params, "mode");

  if (mode !== "now" && mode !== "schedule") {
    throw new SocialError("mode must be 'now' or 'schedule'");
  }

  const post = await getPost(ctx, viewer.companyId, postId);
  if (!post) {
    throw new SocialError("Post not found");
  }

  // Verify ownership
  if (post.scope !== "personal" || post.owner_user_id !== userId) {
    throw new SocialError("Only the post owner can approve it");
  }

  // Must be draft
  if (post.status !== "draft") {
    throw new SocialError("Only draft posts can be approved");
  }

  // Transition to approved (handles approval flow if needed)
  await approvePostByPerson(ctx, viewer, post);

  if (mode === "now") {
    // Publish immediately
    const { publishPost } = await import("./publish.js");
    const config = await loadSocialConfig(ctx, viewer.companyId);
    const result = await publishPost(ctx, config, postId);
    return {
      status: "published",
      message: `Published to ${result.published} destination(s)`,
    };
  } else {
    // Schedule
    const scheduledAt = optionalString(params, "scheduledAt");
    if (!scheduledAt) {
      throw new SocialError("scheduledAt is required when scheduling");
    }

    const now = new Date();
    const scheduleTime = new Date(scheduledAt);
    if (scheduleTime <= now) {
      throw new SocialError("Scheduled time must be in the future");
    }

    await setPostStatus(
      ctx,
      viewer.companyId,
      postId,
      ["approved"],
      "scheduled",
      scheduledAt,
    );

    return {
      status: "scheduled",
      scheduledAt,
      message: "Post scheduled",
    };
  }
}

// ── my-social.disconnect-account: Disconnect a personal account ──────────────

export async function myDisconnectAccountAction(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const userId = requireUser(viewer, "disconnect a personal account");
  const accountId = requiredString(params, "accountId");

  const account = await getAccount(ctx, viewer.companyId, accountId);
  if (!account) {
    throw new SocialError("Account not found");
  }

  // Verify ownership
  if (account.scope !== "personal" || account.owner_user_id !== userId) {
    throw new SocialError("Cannot disconnect this personal account");
  }

  await disconnectAccount(ctx, viewer.companyId, accountId, "disconnected via My Social");
  return { disconnected: accountId };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractAccountIds(params: Record<string, unknown>): string[] {
  const value = params.accountIds;
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
}

async function validatePersonalAccounts(
  ctx: PluginContext,
  companyId: string,
  accountIds: string[],
  targetUserId: string,
): Promise<void> {
  for (const accountId of accountIds) {
    const account = await getAccount(ctx, companyId, accountId);
    if (!account) {
      throw new SocialError(`Account ${accountId} not found`);
    }
    if (account.scope !== "personal") {
      throw new SocialError(
        `${account.display_name} is not a personal account`,
      );
    }
    if (account.owner_user_id !== targetUserId) {
      throw new SocialError(
        `${account.display_name} is not owned by the target user`,
      );
    }
  }
}
