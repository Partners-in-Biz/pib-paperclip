/**
 * RSS 2.0 feed reader for create-feed-digest: allow-listed fetch (the caller holds the list),
 * parse, sanitize and pick. Pure functions plus one fetch wrapper.
 *
 * The host's ctx.http.fetch has its own SSRF protection, a fixed 30 s timeout and a 200 MB limit and
 * returns the whole body, so the size check here runs after the download.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const MAX_FEED_CHARS = 1_000_000;
export const MAX_FEED_ITEMS = 100;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 1_000;
export const MAX_LINK = 2_000;

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  guid: string | null;
  categories: string[];
}

export interface CleanFeedItem extends FeedItem {
  /** guid, else link. */
  key: string;
}

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

/** Fetches a feed as text. Only https; every failure is one FeedError naming the URL. */
export async function fetchFeed(ctx: PluginContext, url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FeedError(`Feed ${url} refused: not a valid address.`);
  }
  if (parsed.protocol !== "https:") throw new FeedError(`Feed ${url} refused: only https addresses are fetched.`);

  let res: Response;
  try {
    res = await ctx.http.fetch(parsed.toString(), { method: "GET", headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new FeedError(`Feed ${url} could not be fetched: ${cause}`);
  }
  if (res.status < 200 || res.status > 299) throw new FeedError(`Feed ${url} answered with status ${res.status}.`);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("xml") && !type.includes("rss")) throw new FeedError(`Feed ${url} is not a feed: content-type is "${type || "missing"}".`);
  let body: string;
  try {
    body = await res.text();
  } catch (error) {
    throw new FeedError(`Feed ${url} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (body.length > MAX_FEED_CHARS) throw new FeedError(`Feed ${url} is too large: over ${MAX_FEED_CHARS} characters.`);
  return body;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-z]+));/g, (match, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name] ?? match;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The text of a field: CDATA is taken as written, anything else is entity-decoded once. */
function fieldText(raw: string): { text: string; cdata: boolean } {
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  if (cdata) return { text: raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"), cdata: true };
  return { text: decodeEntities(raw), cdata: false };
}

function tagValues(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  for (const m of block.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

function plain(raw: string, max: number): string {
  const { text, cdata } = fieldText(raw);
  // Escaped markup (&lt;p&gt;) is decoded above, then stripped. CDATA text may still hold entities.
  const stripped = stripHtml(text);
  return collapse(cdata ? decodeEntities(stripped) : stripped).slice(0, max);
}

/** The <item> elements of an RSS 2.0 feed, as plain text with caps applied. */
export function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
    if (items.length >= MAX_FEED_ITEMS) break;
    const block = match[1] ?? "";
    const first = (tag: string, max: number): string => plain(tagValues(block, tag)[0] ?? "", max);
    const guid = first("guid", MAX_LINK);
    const pub = first("pubDate", 100);
    items.push({
      title: first("title", MAX_TITLE),
      link: first("link", MAX_LINK),
      description: first("description", MAX_DESCRIPTION),
      pubDate: pub || null,
      guid: guid || null,
      categories: tagValues(block, "category").map((c) => plain(c, MAX_TITLE)).filter(Boolean),
    });
  }
  return items;
}

/** Breaks every "{{" so feed text can never form a merge token: "{{x}}" becomes "{ {x}}". */
export function escapeMergeTokens(text: string): string {
  return text.replace(/\{(?=\{)/g, "{ ");
}

function isHttps(link: string): boolean {
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

/** Drops an item without an https link; keys it by guid, else link; escapes merge tokens in all text. */
export function sanitizeItem(item: FeedItem): CleanFeedItem | null {
  if (!isHttps(item.link)) return null;
  const guid = item.guid?.trim() || null;
  return {
    title: escapeMergeTokens(item.title),
    link: escapeMergeTokens(item.link),
    description: escapeMergeTokens(item.description),
    pubDate: item.pubDate,
    guid: guid === null ? null : escapeMergeTokens(guid),
    categories: item.categories.map(escapeMergeTokens),
    key: escapeMergeTokens(guid ?? item.link),
  };
}

export interface PickOptions {
  category?: string;
  exclude: Set<string>;
  max: number;
}

function time(item: CleanFeedItem): number | null {
  if (!item.pubDate) return null;
  const t = Date.parse(item.pubDate);
  return Number.isNaN(t) ? null : t;
}

/** Filters by exact category, drops used keys, newest first (undated after dated, in feed order), cut at max. */
export function pickItems(items: CleanFeedItem[], options: PickOptions): CleanFeedItem[] {
  const wanted = options.category ? escapeMergeTokens(options.category) : null;
  return items
    .filter((i) => (wanted === null || i.categories.includes(wanted)) && !options.exclude.has(i.key))
    .map((item, index) => ({ item, index, t: time(item) }))
    .sort((a, b) => (a.t === null && b.t === null ? a.index - b.index : a.t === null ? 1 : b.t === null ? -1 : b.t - a.t || a.index - b.index))
    .slice(0, Math.max(0, options.max))
    .map((x) => x.item);
}
