/**
 * RSS/Atom feeds (`poll-rss`, every 15 minutes): new items become draft
 * posts for review, deduped per feed by guid/link. The first poll of a new
 * feed drafts only the newest item and marks the rest as seen.
 * Feeds are untrusted URLs, so they go through the host's SSRF-guarded fetch.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { safeFetch } from "@partnersinbiz/pib-plugin-kit";
import { inScope, scopeOfRow } from "./clients.js";
import { moduleGate } from "./modules.js";
import {
  activeRssFeeds,
  getAccountsByIds,
  insertDestination,
  insertPost,
  insertRssSeen,
  markRssFeedChecked,
  seenRssKeys,
  type RssFeedRow,
} from "./db.js";

export interface FeedItem {
  key: string;
  title: string;
  link: string | null;
  guid: string | null;
  publishedAt: string | null;
  summary: string;
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function unwrapCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function text(value: string | null): string {
  if (!value) return "";
  return decodeEntities(stripTags(unwrapCdata(value))).trim();
}

function tag(block: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<${name.replace(":", "\\:")}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(":", "\\:")}>`, "i");
    const m = re.exec(block);
    if (m) return m[1] ?? "";
  }
  return null;
}

function attr(tagText: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tagText);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

function atomLink(block: string): string | null {
  const links = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallback: string | null = null;
  for (const l of links) {
    const href = attr(l, "href");
    if (!href) continue;
    const rel = attr(l, "rel");
    if (!rel || rel === "alternate") return href;
    fallback = fallback ?? href;
  }
  return fallback;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : null;
}

/** Tolerant RSS 2.0 / RSS 1.0 / Atom parser. */
export function parseFeed(xml: string): { title: string | null; items: FeedItem[] } {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const blocks = body.match(/<item\b[\s\S]*?<\/item>/gi) ?? body.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const firstBlock = blocks[0] ? body.indexOf(blocks[0]) : body.length;
  const title = text(tag(body.slice(0, firstBlock), ["title"])) || null;
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const itemTitle = text(tag(block, ["title"]));
    const rssLink = tag(block, ["link"]);
    const link = httpUrl(rssLink && !/^\s*$/.test(rssLink) ? text(rssLink) : null) ?? httpUrl(atomLink(block));
    const guid = text(tag(block, ["guid", "id"])) || null;
    const publishedAt = toIso(tag(block, ["pubDate", "published", "updated", "dc:date"]));
    const summaryRaw = tag(block, ["description", "summary", "content:encoded", "content"]);
    const summary = text(summaryRaw).slice(0, 500);
    const keySource = guid ?? link ?? `${itemTitle}|${publishedAt ?? ""}`;
    if (!itemTitle && !link) continue;
    items.push({
      key: createHash("sha256").update(keySource).digest("hex").slice(0, 32),
      title: itemTitle || link || "Untitled",
      link,
      guid,
      publishedAt,
      summary,
    });
  }
  return { title, items };
}

export function draftFromItem(item: FeedItem): { body: string; link: string | null } {
  const lines = [item.title];
  if (item.summary && item.summary !== item.title) lines.push("", item.summary.length > 240 ? `${item.summary.slice(0, 237)}…` : item.summary);
  if (item.link) lines.push("", item.link);
  return { body: lines.join("\n"), link: item.link };
}

async function pollFeed(ctx: PluginContext, feed: RssFeedRow): Promise<number> {
  let res;
  try {
    res = await safeFetch(ctx, feed.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5", "User-Agent": "PiB-Social-RSS/1.0 (+https://partnersinbiz.online)" },
      maxChars: 3_000_000,
    });
  } catch (error) {
    await markRssFeedChecked(ctx, feed.id, { error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
  if (res.status >= 400) {
    await markRssFeedChecked(ctx, feed.id, { error: `HTTP ${res.status}` });
    return 0;
  }
  const parsed = parseFeed(res.text);
  if (parsed.items.length === 0) {
    await markRssFeedChecked(ctx, feed.id, { title: parsed.title, error: "No items found (is this an RSS or Atom feed?)" });
    return 0;
  }
  const items = parsed.items.slice(0, 25);
  const seen = await seenRssKeys(ctx, feed.id, items.map((i) => i.key));
  const fresh = items.filter((i) => !seen.has(i.key));
  const firstPoll = !feed.last_checked_at;
  const toDraft = new Set((firstPoll ? fresh.slice(0, 1) : fresh.slice(0, 5)).map((i) => i.key));
  const wanted = Array.from(new Set([...(feed.account_ids ?? []), ...(feed.account_id ? [feed.account_id] : [])]));
  // Drafts only target org accounts of the feed's own scope.
  const accountIds = toDraft.size && wanted.length
    ? (await getAccountsByIds(ctx, feed.company_id, wanted)).filter((a) => a.scope === "org" && inScope(a, scopeOfRow(feed))).map((a) => a.id)
    : [];
  let drafted = 0;
  for (const item of fresh) {
    let postId: string | null = null;
    if (toDraft.has(item.key)) {
      postId = randomUUID();
      const draft = draftFromItem(item);
      await insertPost(ctx, {
        id: postId,
        company_id: feed.company_id,
        body: draft.body,
        status: "draft",
        scope: "org",
        owner_user_id: feed.created_by_user_id,
        media: [],
        overrides: {},
        first_comment: null,
        client_kind: feed.client_ref ? feed.client_kind ?? "company" : null,
        client_ref: feed.client_ref,
        client_name: feed.client_ref ? feed.client_name : null,
        source: "rss",
        source_ref: feed.id,
        created_by_agent_id: null,
      });
      for (const accountId of accountIds) {
        await insertDestination(ctx, { companyId: feed.company_id, postId, accountId }).catch(() => undefined);
      }
      drafted += 1;
    }
    await insertRssSeen(ctx, {
      companyId: feed.company_id,
      feedId: feed.id,
      itemKey: item.key,
      title: item.title.slice(0, 500),
      link: item.link,
      publishedAt: item.publishedAt,
      postId,
    });
  }
  const newest = items.map((i) => i.publishedAt).filter(Boolean).sort().pop() ?? null;
  await markRssFeedChecked(ctx, feed.id, { title: parsed.title, error: null, lastItemAt: newest });
  return drafted;
}

export async function pollRssJob(ctx: PluginContext) {
  const summary = { feeds: 0, drafted: 0, errors: 0, switchedOff: 0 };
  const on = moduleGate(ctx);
  for (const feed of await activeRssFeeds(ctx)) {
    if (!(await on(feed.company_id))) {
      summary.switchedOff += 1;
      continue;
    }
    summary.feeds += 1;
    try {
      summary.drafted += await pollFeed(ctx, feed);
    } catch (error) {
      summary.errors += 1;
      ctx.logger.info("RSS poll failed", { feedId: feed.id, error: error instanceof Error ? error.message : String(error) });
      await markRssFeedChecked(ctx, feed.id, { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    }
  }
  return summary;
}
