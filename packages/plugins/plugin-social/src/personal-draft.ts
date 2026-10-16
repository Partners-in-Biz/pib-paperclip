/**
 * Personal draft: agents create drafts in a board user's private My Social queue.
 * The owner must approve; agents cannot publish, approve or read tokens.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  destinationsForPost,
  getAccount,
  getAccountsByIds,
  getPost,
  insertDestination,
  insertPost,
  listAccounts,
  type PostRow,
} from "./db.js";
import { SocialError, assertDestination, type AccountScope } from "./domain.js";
import {
  assertAccountScope,
  getPostDetail,
  normalizeOverrides,
  optionalString,
  postParams,
  proposedTime,
  requiredString,
  type Viewer,
} from "./service.js";
import { mediaFromAssetIds } from "./media.js";
import type { PostStatus } from "./platforms.js";

/**
 * Create a draft in a board user's personal My Social queue.
 * The agent or the user creating it specifies targetUserId (the queue owner).
 * Humans can only create drafts in their own queue (targetUserId === viewer.userId).
 * Agents can create drafts for any user in the company.
 */
export async function createPersonalDraftRecord(ctx: PluginContext, viewer: Viewer, input: Record<string, unknown>) {
  const params = postParams(input);
  const body = requiredString(params, "body");
  const targetUserId = requiredString(params, "targetUserId");

  // Humans can only target themselves
  if (!viewer.isAgent && viewer.userId !== targetUserId) {
    throw new SocialError("You can only create drafts in your own queue");
  }

  // Personal drafts must not have a client (own work only)
  const media = (await mediaFromAssetIds(ctx, viewer.companyId, params.mediaAssetIds, null)) ?? [];
  const overrides = normalizeOverrides(params.overrides) ?? {};

  // Parse account IDs
  const accountIds: string[] = [];
  const value = params.accountIds;
  if (value) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new SocialError("accountIds must be a list of ids");
    }
    accountIds.push(...Array.from(new Set((value as string[]).map((v) => String(v).trim()).filter(Boolean))));
  }

  // Validate accounts: must be personal accounts owned by targetUserId
  const accounts = [];
  for (const accountId of accountIds) {
    const account = await getAccount(ctx, viewer.companyId, accountId);
    if (!account) {
      throw new SocialError(`Account ${accountId} is not visible`);
    }

    // Personal accounts must be owned by the target user
    if (account.scope !== "personal") {
      throw new SocialError(
        `${account.display_name} is an organisation account. Personal drafts can only use personal accounts.`,
      );
    }
    if (account.owner_user_id !== targetUserId) {
      throw new SocialError(
        `${account.display_name} is owned by another user. Personal drafts can only use accounts owned by the queue owner.`,
      );
    }
    // Verify account scope matches
    assertAccountScope(
      {
        client_kind: null,
        client_ref: null,
        client_name: null,
      },
      account,
    );
    // Double-check assertDestination: personal post + personal account must be owned by the same user
    assertDestination({
      postScope: "personal",
      accountScope: account.scope,
      accountOwnerUserId: account.owner_user_id,
      actorUserId: targetUserId,
    });

    accounts.push(account);
  }

  const row = {
    id: randomUUID(),
    company_id: viewer.companyId,
    body,
    status: "draft" as PostStatus,
    scope: "personal" as AccountScope,
    owner_user_id: targetUserId,
    media,
    overrides,
    first_comment: optionalString(params, "firstComment") ?? null,
    scheduled_at: null, // Never schedule personal drafts
    client_kind: null,
    client_ref: null,
    client_name: null,
    source: viewer.isAgent ? "agent" : "manual",
    source_ref: null,
    created_by_agent_id: viewer.agentId,
  };

  await insertPost(ctx, row);
  const post = (await getPost(ctx, viewer.companyId, row.id))!;

  // Attach accounts
  for (const account of accounts) {
    await insertDestination(ctx, { companyId: viewer.companyId, postId: post.id, accountId: account.id });
  }

  // Return minimal payload: no tokens, no client info
  return getPersonalDraftOut(post, viewer.companyId);
}

/**
 * Output for a personal draft: minimal, no token fields.
 */
function getPersonalDraftOut(post: PostRow, companyId: string) {
  return {
    id: post.id,
    status: post.status,
    owner: post.owner_user_id,
    link: `/PAR/social/me?post=${post.id}`,
  };
}
