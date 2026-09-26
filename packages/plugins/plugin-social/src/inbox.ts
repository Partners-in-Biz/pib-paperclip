/**
 * Social inbox: `poll-inbox` (every 15 minutes) pulls comments on recent
 * posts and mentions into inbox_items (deduped per account + external id);
 * `reply` publishes a real reply through the platform when it supports it.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { envFor } from "./accounts.js";
import { loadSocialConfig, type SocialConfig } from "./config.js";
import {
  companiesWithAccounts,
  getAccount,
  insertDestination,
  insertInboxItem,
  insertPost,
  listAccounts,
  recentPublishedForAccount,
  saveInboxReply,
  type AccountRow,
  type InboxItemRow,
} from "./db.js";
import { SocialError } from "./domain.js";
import { providerFor } from "./oauth/registry.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";
import { freshAccount } from "./tokens.js";

/** Platforms whose inbox reads comments per published post (the others read account-level mentions). */
const PER_POST_INBOX = new Set(["facebook", "instagram", "threads", "youtube"]);
export const INBOX_PLATFORMS = ["facebook", "instagram", "threads", "youtube", "x", "bluesky", "mastodon"];

async function pollAccount(ctx: PluginContext, config: SocialConfig, row: AccountRow): Promise<number> {
  if (!isSocialPlatform(row.platform)) return 0;
  const provider = providerFor(row.platform);
  if (!provider.inbox) return 0;
  const recent = await recentPublishedForAccount(ctx, row.id, 14, 10);
  if (PER_POST_INBOX.has(row.platform) && recent.length === 0) return 0;
  const account = await freshAccount(ctx, config, row);
  const env = await envFor(config, row.platform, account.meta);
  const items = await provider.inbox(env, account, recent.map((d) => ({ externalId: d.external_id! })));
  const byExternal = new Map(recent.map((d) => [d.external_id!, d]));
  let added = 0;
  for (const item of items) {
    const dest = item.destinationExternalId ? byExternal.get(item.destinationExternalId) : undefined;
    const inserted = await insertInboxItem(ctx, {
      id: randomUUID(),
      company_id: config.companyId,
      account_id: row.id,
      platform: row.platform,
      kind: item.kind,
      author: item.author.slice(0, 200),
      body: item.body.slice(0, 5000),
      status: "new",
      external_id: item.externalId,
      parent_external_id: item.parentExternalId,
      permalink: item.permalink,
      destination_id: dest?.id ?? null,
      post_id: dest?.post_id ?? null,
      received_at: item.receivedAt,
      // Inbox items belong to the account's scope.
      client_kind: row.client_ref ? row.client_kind ?? "company" : null,
      client_ref: row.client_ref,
      client_name: row.client_ref ? row.client_name : null,
    });
    if (inserted) added += 1;
  }
  return added;
}

export async function pollInboxJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>) {
  const summary = { accounts: 0, added: 0, errors: 0 };
  for (const companyId of await companiesWithAccounts(ctx)) {
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    const accounts = (await listAccounts(ctx, companyId)).filter((a) => a.token_enc && (a.status === "connected" || a.status === "expiring"));
    for (const row of accounts) {
      if (!INBOX_PLATFORMS.includes(row.platform)) continue;
      summary.accounts += 1;
      try {
        summary.added += await pollAccount(ctx, config, row);
      } catch (error) {
        summary.errors += 1;
        ctx.logger.info("Social inbox poll failed", { accountId: row.id, platform: row.platform, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return summary;
}

export type ReplyMode = "sent" | "suggested" | "draft_post";

/**
 * Reply to an inbox item. People send immediately; agents only send when
 * `allowAgentReplies` is on, otherwise the reply is stored as a suggestion.
 * Platforms without a reply API get a draft post instead.
 */
export async function replyToInboxItem(
  ctx: PluginContext,
  input: { companyId: string; item: InboxItemRow; body: string; byAgent: boolean; agentId: string | null; userId: string | null },
): Promise<{ itemId: string; mode: ReplyMode; externalId?: string | null; postId?: string }> {
  const { companyId, item } = input;
  const body = input.body.trim();
  if (!body) throw new SocialError("Reply text is required");
  const config = await loadSocialConfig(ctx, companyId);
  const row = item.account_id ? await getAccount(ctx, companyId, item.account_id) : null;
  const platform = row && isSocialPlatform(row.platform) ? row.platform : null;
  const provider = platform ? providerFor(platform) : null;
  if (row && platform && provider?.reply && item.external_id) {
    if (input.byAgent && !config.allowAgentReplies) {
      await saveInboxReply(ctx, companyId, item.id, { status: item.status === "new" ? "read" : item.status, replyDraft: body, replied: false });
      return { itemId: item.id, mode: "suggested" };
    }
    const account = await freshAccount(ctx, config, row);
    const env = await envFor(config, platform, account.meta);
    const outcome = await provider.reply(env, account, {
      externalId: item.external_id,
      parentExternalId: item.parent_external_id,
      kind: item.kind,
      author: item.author,
    }, body);
    if (!outcome.ok) throw new SocialError(`${PLATFORM_LABELS[platform]} reply failed: ${outcome.error ?? "unknown error"}`);
    await saveInboxReply(ctx, companyId, item.id, { status: "replied", replyDraft: null, replyBody: body, replyExternalId: outcome.externalId ?? null, replied: true });
    return { itemId: item.id, mode: "sent", externalId: outcome.externalId ?? null };
  }
  // No reply API: keep the old behaviour and draft a post for review.
  const postId = randomUUID();
  await insertPost(ctx, {
    id: postId,
    company_id: companyId,
    body,
    status: "draft",
    scope: "org",
    owner_user_id: input.userId,
    media: [],
    overrides: {},
    first_comment: null,
    // The draft belongs to the account's scope (or the item's, when the account is gone).
    client_kind: (row ?? item).client_ref ? (row ?? item).client_kind ?? "company" : null,
    client_ref: (row ?? item).client_ref ?? null,
    client_name: (row ?? item).client_ref ? (row ?? item).client_name ?? null : null,
    source: "inbox_reply",
    source_ref: item.id,
    created_by_agent_id: input.agentId,
  });
  if (row && row.scope === "org" && row.token_enc) await insertDestination(ctx, { companyId, postId, accountId: row.id });
  await saveInboxReply(ctx, companyId, item.id, { status: "read", replyDraft: body, replied: false });
  return { itemId: item.id, mode: "draft_post", postId };
}
