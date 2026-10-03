/**
 * The pages of a site, for splitting a site-wide task into page groups: the sitemap (a sitemap index is followed to
 * its child sitemaps), with the pages the sprint already knows about first. Fetches through the SSRF-guarded
 * `SiteFetcher` within a deadline; a site without a sitemap falls back to the known pages.
 */
import { comparableUrl, parseSitemap } from "./parse.js";
import { absoluteUrl, mapLimit, originOf, resolveSitemapUrl, type SiteFetcher } from "./site.js";
import { MAX_SPLIT_PAGES } from "../engine/chunks.js";

export interface SitePages {
  /** The home page first, then known pages, then the sitemap's order. */
  urls: string[];
  sitemapUrl: string | null;
  /** Some child sitemaps were not read (too many, or time ran out): the list is a lower bound. */
  partial: boolean;
  /** The site has more pages than the plugin splits over (the first MAX_SPLIT_PAGES are kept). */
  capped: boolean;
  source: "sitemap" | "known" | "none";
}

const NOT_A_PAGE = /\.(jpe?g|png|gif|webp|svg|avif|pdf|zip|xml|txt|css|js|json|mp4|mp3)(\?|$)/i;
const MAX_CHILD_SITEMAPS = 8;

/** Pages of `siteUrl` from its sitemap, `known` pages (keyword and content targets) first after the home page. */
export async function collectSitePages(fetcher: SiteFetcher, siteUrl: string, opts: { known?: string[]; maxUrls?: number; deadlineMs?: number } = {}): Promise<SitePages> {
  const deadlineAt = Date.now() + (opts.deadlineMs ?? 15_000);
  const max = opts.maxUrls ?? MAX_SPLIT_PAGES;
  const origin = originOf(siteUrl);
  const host = new URL(origin).host;
  const home = `${origin}/`;
  const keep = (url: string): string | null => {
    const comparable = comparableUrl(url, origin);
    if (!comparable || NOT_A_PAGE.test(comparable)) return null;
    try {
      return new URL(comparable).host === host ? comparable : null;
    } catch {
      return null;
    }
  };
  const known = (opts.known ?? []).map(keep).filter((u): u is string => Boolean(u));
  let sitemapUrl: string | null = null;
  let fromSitemap: string[] = [];
  let partial = false;
  try {
    sitemapUrl = await resolveSitemapUrl(fetcher, siteUrl);
    const res = await fetcher(sitemapUrl, { maxChars: 5_000_000 });
    if (res.status >= 500) partial = true; // a server error says nothing about the site's size: the list is a lower bound
    if (res.status < 400) {
      const parsed = parseSitemap(res.text);
      if (parsed.kind === "urlset") fromSitemap = parsed.urls;
      if (parsed.kind === "index") {
        const children = parsed.sitemaps.slice(0, MAX_CHILD_SITEMAPS);
        if (parsed.sitemaps.length > MAX_CHILD_SITEMAPS) partial = true;
        const fetched = await mapLimit(children, 3, deadlineAt, async (child) => parseSitemap((await fetcher(absoluteUrl(child, siteUrl), { maxChars: 5_000_000 })).text).urls);
        if (fetched.timedOut) partial = true;
        fromSitemap = fetched.results.flatMap((r) => r ?? []);
      }
    }
  } catch {
    partial = true;
  }
  const ordered = [home, ...known, ...fromSitemap].map(keep).filter((u): u is string => Boolean(u));
  const unique = [...new Set(ordered)];
  const hasSitemap = fromSitemap.length > 0;
  return {
    urls: unique.slice(0, max),
    sitemapUrl: hasSitemap ? sitemapUrl : null,
    partial,
    capped: unique.length > max,
    source: hasSitemap ? "sitemap" : known.length > 0 ? "known" : "none",
  };
}
