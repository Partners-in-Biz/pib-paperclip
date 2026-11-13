/**
 * `create-feed-digest` (PAR-11279): one draft email campaign from an allow-listed
 * RSS feed, then the normal launch approval. Nothing is sent here.
 *
 * An item is used only once a campaign holding it has left draft. The keys live
 * on the campaign row (one INSERT), so a draft that is cancelled, refused by
 * preflight or never answered keeps its items unused.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import { insertCampaign, insertStep, table } from "./db.js";
import { CampaignError, createCampaign, type CampaignDraft } from "./domain.js";
import { fetchFeed, FeedError, parseRss, pickItems, sanitizeItem, type CleanFeedItem } from "./feed.js";
import { optionalString, requiredString, stringList } from "./params.js";

export const DIGEST_MAX_ITEMS = 10;
const LAUNCHED = "('scheduled', 'active', 'paused', 'completed')";

type Owner = { userId?: string | null; agentId?: string | null };
type RequestApproval = (ctx: PluginContext, companyId: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The "feed + category" part of a query: no category matches only digests made without one. */
function scope(feedUrl: string, category: string | null, firstParam: number): { sql: string; params: unknown[] } {
  return category === null
    ? { sql: `feed_url = $${firstParam} AND feed_category IS NULL`, params: [feedUrl] }
    : { sql: `feed_url = $${firstParam} AND feed_category = $${firstParam + 1}`, params: [feedUrl, category] };
}

/** The newest digest of this feed that is still a draft. */
async function openDraft(ctx: PluginContext, companyId: string, feedUrl: string, category: string | null) {
  const where = scope(feedUrl, category, 2);
  const rows = await ctx.db.query<{ id: string; approval_issue_id: string | null }>(
    `SELECT id, approval_issue_id FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1 AND ${where.sql} AND status = 'draft'
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, ...where.params],
  );
  return rows[0] ?? null;
}

/** Item keys of the digests of this feed that were launched. */
async function usedKeys(ctx: PluginContext, companyId: string, feedUrl: string, category: string | null): Promise<Set<string>> {
  const where = scope(feedUrl, category, 2);
  const rows = await ctx.db.query<{ feed_item_keys: unknown }>(
    `SELECT feed_item_keys FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1 AND ${where.sql} AND status IN ${LAUNCHED} AND feed_item_keys IS NOT NULL`,
    [companyId, ...where.params],
  );
  const used = new Set<string>();
  for (const row of rows) {
    const keys = typeof row.feed_item_keys === "string" ? (JSON.parse(row.feed_item_keys) as unknown) : row.feed_item_keys;
    if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") used.add(key);
  }
  return used;
}

/** One block per item: title, text, link. The link is re-read from the validated https URL. The send path escapes it for the HTML part. */
export function digestBody(items: CleanFeedItem[]): string {
  return items
    .map((item) => [item.title, item.description, new URL(item.link).href].filter(Boolean).join("\n"))
    .join("\n\n");
}

export async function createFeedDigest(ctx: PluginContext, companyId: string, params: Record<string, unknown>, owner: Owner, requestApproval: RequestApproval) {
  const feedUrl = requiredString(params, "feedUrl");
  const config = await readConfig(ctx, companyId);
  const allowed = Array.isArray(config.digestFeedUrls) ? config.digestFeedUrls.filter((url): url is string => typeof url === "string").map((url) => url.trim()) : [];
  if (!allowed.includes(feedUrl)) {
    throw new CampaignError(`${feedUrl} is not an allowed digest feed. Add it to "Digest feeds" (digestFeedUrls) in the Campaigns settings first.`);
  }
  const tags = stringList(params, "audienceTags").map((tag) => tag.trim()).filter(Boolean).filter((tag, i, all) => all.indexOf(tag) === i);
  if (tags.length < 1 || tags.length > 5) throw new CampaignError("audienceTags needs 1 to 5 CRM tags: a digest never goes to all contacts.");
  const name = requiredString(params, "name");
  const subject = requiredString(params, "subject");
  const category = optionalString(params, "category") || null;

  const open = await openDraft(ctx, companyId, feedUrl, category);
  if (open) {
    // A failed lookup only softens the message below; request-campaign-approval re-checks.
    const issue = open.approval_issue_id ? await ctx.issues.get(open.approval_issue_id, companyId).catch(() => null) : null;
    const waiting = issue !== null && issue.status !== "cancelled";
    return {
      campaignId: open.id,
      created: false,
      approvalIssueId: waiting ? open.approval_issue_id : null,
      approvalOpened: false,
      message: waiting
        ? "A digest of this feed is already a draft with an open approval. Nothing new was created: approve the open one."
        : "A digest of this feed is already a draft. Nothing new was created: fix it and call request-campaign-approval, or approve the open one.",
    };
  }

  let items: CleanFeedItem[];
  try {
    items = parseRss(await fetchFeed(ctx, feedUrl)).map(sanitizeItem).filter((item): item is CleanFeedItem => item !== null);
  } catch (error) {
    if (error instanceof FeedError) throw new CampaignError(error.message);
    throw error;
  }
  const picked = pickItems(items, { ...(category ? { category } : {}), exclude: await usedKeys(ctx, companyId, feedUrl, category), max: DIGEST_MAX_ITEMS });
  if (picked.length === 0) return { created: false, approvalOpened: false, message: "Nothing new in this feed: every item is already in a launched digest." };

  const campaign: CampaignDraft = {
    ...createCampaign({
      companyId,
      name,
      description: `Feed digest of ${feedUrl}${category ? ` (category ${category})` : ""}: ${picked.length} item${picked.length === 1 ? "" : "s"}.`,
      audienceTags: tags,
      audienceMode: "tags",
      delivery: "email",
      ownerUserId: owner.userId ?? null,
      ownerAgentId: owner.agentId ?? null,
    }),
    feedUrl,
    feedCategory: category,
    feedItemKeys: picked.map((item) => item.key),
  };
  await insertCampaign(ctx, campaign);
  await insertStep(ctx, { companyId, campaignId: campaign.id, step: { position: 1, delayDays: 0, subject, body: digestBody(picked), htmlBody: null, variant: "a" } });

  try {
    const approval = await requestApproval(ctx, companyId, { campaignId: campaign.id });
    return { campaignId: campaign.id, created: true, items: picked.length, approvalOpened: true, ...approval };
  } catch (error) {
    if (!(error instanceof CampaignError)) throw error;
    return { campaignId: campaign.id, created: true, items: picked.length, approvalOpened: false, errors: error.message };
  }
}

