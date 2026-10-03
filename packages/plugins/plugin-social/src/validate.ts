/**
 * Whether a post can publish to each of its destinations, as `validate-post`
 * shows it. Kept apart from service.ts so approval (which schedules an approved
 * post) and the client-answer job can validate without a viewer.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { inScope, scopeLabel, scopeOfRow } from "./clients.js";
import { accountMeta, destinationsForPost, getAccount, type PostRow, postMedia } from "./db.js";
import { foreignMedia } from "./media.js";
import { isSocialPlatform, PLATFORM_LABELS, type SocialPlatform } from "./platforms.js";
import { buildPublishRequest, validateDestination } from "./publish.js";

export interface PostCheck {
  postId: string;
  ok: boolean;
  problems: string[];
  destinations: Array<{ accountId: string; platform: string; accountName: string; problems: string[]; published: boolean }>;
}

export async function validatePostRow(ctx: PluginContext, companyId: string, post: PostRow): Promise<PostCheck> {
  const destinations = await destinationsForPost(ctx, post.id);
  const results: PostCheck["destinations"] = [];
  const problems: string[] = [];
  if (destinations.length === 0) problems.push("Attach at least one destination account");
  for (const asset of await foreignMedia(ctx, companyId, postMedia(post), scopeOfRow(post))) {
    problems.push(`Media "${asset.name}" belongs to ${scopeLabel(asset)}; this post is for ${scopeLabel(post)}. Replace it.`);
  }
  for (const d of destinations) {
    const account = await getAccount(ctx, companyId, d.account_id);
    if (!account || !isSocialPlatform(account.platform)) continue;
    if (d.status === "published") {
      results.push({ accountId: account.id, platform: account.platform, accountName: account.display_name, problems: [], published: true });
      continue;
    }
    const list = validateDestination(account.platform, buildPublishRequest(post, account.platform), accountMeta(account));
    if (!inScope(account, scopeOfRow(post))) list.unshift(`${account.display_name} belongs to ${scopeLabel(account)}, not ${scopeLabel(post)}. Remove it from this post`);
    if (!account.token_enc || account.status === "disabled") list.push(`${account.display_name} is disconnected`);
    else if (account.status === "needs_reconnect") list.push(`${account.display_name} needs to be reconnected`);
    results.push({ accountId: account.id, platform: account.platform, accountName: account.display_name, problems: list, published: false });
    problems.push(...list.map((p) => `${PLATFORM_LABELS[account.platform as SocialPlatform]} (${account.display_name}): ${p}`));
  }
  return { postId: post.id, ok: problems.length === 0, problems, destinations: results };
}
