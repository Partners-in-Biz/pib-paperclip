/**
 * Whether a post can publish to each of its destinations, as `validate-post`
 * shows it. Kept apart from service.ts so approval (which schedules an approved
 * post) and the client-answer job can validate without a viewer.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { inScope, scopeLabel, scopeOfRow } from "./clients.js";
import { accountMeta, destinationsForPost, getAccount, iso, isManual, table, type PostRow, postMedia } from "./db.js";
import { OPENING_CHARS, openingOf } from "./calendar-check.js";
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
    if (account.status === "disabled" || (!isManual(account) && !account.token_enc)) list.push(`${account.display_name} is disconnected`);
    else if (account.status === "needs_reconnect") list.push(`${account.display_name} needs to be reconnected`);
    results.push({ accountId: account.id, platform: account.platform, accountName: account.display_name, problems: list, published: false });
    problems.push(...list.map((p) => `${PLATFORM_LABELS[account.platform as SocialPlatform]} (${account.display_name}): ${p}`));
  }
  problems.push(...(await samePostOnAccounts(ctx, companyId, post)));
  return { postId: post.id, ok: problems.length === 0, problems, destinations: results };
}

/** How close two copies may be before the second is refused. */
export const DOUBLE_POST_WINDOW_HOURS = 48;

/**
 * The same post (same opening words) already scheduled or published to one of this post's accounts within 48 hours:
 * scheduling this one would post it twice there (Facebook and Instagram got two copies on 16 and 17 Nov 2026). Archive one
 * copy, or take the shared account off one. A failed read adds nothing (the other checks still stand).
 */
export async function samePostOnAccounts(ctx: PluginContext, companyId: string, post: PostRow): Promise<string[]> {
  const opening = openingOf(post.body ?? "");
  if (!opening) return [];
  try {
    const rows = await ctx.db.query<{ id: string; status: string; at: unknown; names: string | null }>(
      `SELECT o.id, o.status, coalesce(o.published_at, o.scheduled_at) AS at,
              string_agg(DISTINCT a.display_name, ', ') AS names
         FROM ${table(ctx, "posts")} o
         JOIN ${table(ctx, "destinations")} od ON od.post_id = o.id
         JOIN ${table(ctx, "destinations")} md ON md.account_id = od.account_id AND md.post_id = $2
         LEFT JOIN ${table(ctx, "accounts")} a ON a.id = od.account_id
        WHERE o.company_id = $1 AND o.id <> $2 AND o.archived_at IS NULL
          AND o.status IN ('scheduled', 'publishing', 'published', 'partially_published')
          AND coalesce(o.published_at, o.scheduled_at) BETWEEN coalesce($3::timestamptz, now()) - make_interval(hours => $5)
                                                           AND coalesce($3::timestamptz, now()) + make_interval(hours => $5)
          AND trim(left(trim(regexp_replace(lower(o.body), '[^[:alnum:]]+', ' ', 'g')), ${OPENING_CHARS})) = $4
        GROUP BY o.id, o.status, o.published_at, o.scheduled_at`,
      [companyId, post.id, iso(post.scheduled_at), opening, DOUBLE_POST_WINDOW_HOURS],
    );
    return rows.map((row) => `The same post is already ${row.status.replace("_", " ")} to ${row.names ?? "one of these accounts"} (${String(row.id).slice(0, 8)}, ${iso(row.at) ?? "no time"}): this copy would post it twice there. Archive one copy, or remove the shared account.`);
  } catch (error) {
    ctx.logger.info("Social double-post check skipped", { postId: post.id, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}


