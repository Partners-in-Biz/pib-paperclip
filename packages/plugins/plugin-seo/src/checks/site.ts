/**
 * Site checks that fetch the client's site. All network goes through a
 * `SiteFetcher` (in the worker: the kit's SSRF-guarded `safeFetch`, which
 * follows redirects hop by hop). Work is bounded: page counts are capped and a
 * deadline keeps every check inside the tool gateway's 10 s limit (agent MCP
 * calls get a 504 tool_timeout after 10 s).
 */
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import {
  bodyText,
  canonicalCheck,
  comparableUrl,
  crawlerView,
  extractJsonLd,
  extractLinks,
  extractMeta,
  metaFindings,
  parseRobots,
  parseSitemap,
  robotsFindings,
  type CheckFinding,
  type CrawlerView,
  type PageMeta,
  type ParsedRobots,
  type SchemaResult,
} from "./parse.js";

export type SiteFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; maxChars?: number },
) => Promise<SafeFetchResult>;

export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export function originOf(url: string): string {
  const withScheme = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  return new URL(withScheme).origin;
}

/** True for `sitemap_index.xml` or `sub/sitemap.xml`: a relative path, not a host name. */
export function isBareSitePath(value: string): boolean {
  const v = value.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) return false;
  const first = v.split("/")[0];
  if (v.includes("/")) return !first.includes(".") || first === "." || first === "..";
  return /\.(xml|xml\.gz|txt)$/i.test(v);
}

export function absoluteUrl(url: string, siteUrl?: string | null): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
  if (siteUrl && trimmed.startsWith("/")) return new URL(trimmed, originOf(siteUrl)).toString();
  // A bare file name such as sitemap_index.xml is a path on the site, not a host (PAR-10088).
  if (siteUrl && isBareSitePath(trimmed)) return new URL(trimmed, `${originOf(siteUrl)}/`).toString();
  return new URL(`https://${trimmed}`).toString();
}

const TIMEOUT = Symbol("timeout");

async function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T | typeof TIMEOUT> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `fn` over items with bounded concurrency until the deadline. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  deadlineAt: number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: Array<R | null>; completed: number; timedOut: boolean; done: boolean[] }> {
  const results: Array<R | null> = items.map(() => null);
  // done[i]: item i finished (a failed fetch counts as finished, with a null result).
  const done: boolean[] = items.map(() => false);
  let next = 0;
  let completed = 0;
  let timedOut = false;
  async function worker() {
    while (next < items.length) {
      if (Date.now() >= deadlineAt) {
        timedOut = true;
        return;
      }
      const index = next;
      next += 1;
      const outcome = await withDeadline(fn(items[index]!).catch(() => null), deadlineAt);
      if (outcome === TIMEOUT) {
        timedOut = true;
        return;
      }
      results[index] = outcome;
      done[index] = true;
      completed += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return { results, completed, timedOut: timedOut || completed < items.length, done };
}

// ---------------------------------------------------------------------------

export interface RobotsCheckResult {
  url: string;
  status: number;
  robots: ParsedRobots;
  raw: string;
  findings: CheckFinding[];
}

export async function runRobotsCheck(fetcher: SiteFetcher, siteUrl: string): Promise<RobotsCheckResult> {
  const url = `${originOf(siteUrl)}/robots.txt`;
  const res = await fetcher(url, { maxChars: 200_000 });
  const robots = res.status < 400 ? parseRobots(res.text) : { groups: [], sitemaps: [] };
  return { url, status: res.status, robots, raw: res.text.slice(0, 5000), findings: robotsFindings({ url, status: res.status, robots }) };
}

export interface SitemapCheckResult {
  sitemapUrl: string;
  status: number;
  kind: "urlset" | "index" | "unknown";
  totalUrls: number;
  childSitemaps: string[];
  sampleUrls: string[];
  spotChecked: Array<{ url: string; status: number }>;
  partial: boolean;
  findings: CheckFinding[];
  urls: string[];
}

/** Where sitemaps usually live when robots.txt names none: core, Yoast / Rank Math, WordPress core. */
export const SITEMAP_FALLBACKS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"];
const SITEMAP_MAX_CHARS = 5_000_000;

export async function resolveSitemapUrl(fetcher: SiteFetcher, siteUrl: string, explicit?: string | null): Promise<string> {
  if (explicit) return absoluteUrl(explicit, siteUrl);
  try {
    const robots = await runRobotsCheck(fetcher, siteUrl);
    if (robots.robots.sitemaps[0]) return absoluteUrl(robots.robots.sitemaps[0], siteUrl);
  } catch {
    // fall back to the conventional locations
  }
  const origin = originOf(siteUrl);
  // robots.txt names no sitemap: take the first conventional location that answers.
  for (const path of SITEMAP_FALLBACKS) {
    try {
      const res = await fetcher(`${origin}${path}`, { maxChars: SITEMAP_MAX_CHARS });
      if (res.status < 400) return `${origin}${path}`;
    } catch {
      // try the next location
    }
  }
  return `${origin}/sitemap.xml`;
}

/** Memoise GETs by URL and size for the life of one check, so a probe and the real read share one fetch. */
export function memoFetcher(fetcher: SiteFetcher): SiteFetcher {
  const seen = new Map<string, Promise<SafeFetchResult>>();
  return (url, init) => {
    if (init?.method && init.method !== "GET") return fetcher(url, init);
    const key = `${url}|${init?.maxChars ?? ""}|${JSON.stringify(init?.headers ?? {})}`;
    let hit = seen.get(key);
    if (!hit) {
      hit = fetcher(url, init);
      seen.set(key, hit);
    }
    return hit;
  };
}

export async function runSitemapCheck(
  siteFetcher: SiteFetcher,
  input: {
    siteUrl: string;
    sitemapUrl?: string | null;
    sample?: number;
    deadlineMs?: number;
    maxChildren?: number;
    /** Called with each child sitemap's URLs as it arrives (index = position in the sitemap index). */
    onChildUrls?: (index: number, urls: string[]) => void;
  },
): Promise<SitemapCheckResult> {
  // Sitemap discovery may already have read the sitemap: reuse that response.
  const fetcher = memoFetcher(siteFetcher);
  const deadlineAt = Date.now() + (input.deadlineMs ?? 18_000);
  const sitemapUrl = await resolveSitemapUrl(fetcher, input.siteUrl, input.sitemapUrl);
  const findings: CheckFinding[] = [];
  const add = (severity: CheckFinding["severity"], finding: string, url: string | null = sitemapUrl) =>
    findings.push({ category: "sitemap", severity, url, finding });
  const res = await fetcher(sitemapUrl, { maxChars: SITEMAP_MAX_CHARS });
  if (res.status >= 400) {
    add("high", `Sitemap returns HTTP ${res.status}`);
    return { sitemapUrl, status: res.status, kind: "unknown", totalUrls: 0, childSitemaps: [], sampleUrls: [], spotChecked: [], partial: false, findings, urls: [] };
  }
  const parsed = parseSitemap(res.text);
  let urls = parsed.urls;
  let partial = false;
  const childSitemaps = parsed.sitemaps;
  if (parsed.kind === "index") {
    const maxChildren = Math.max(input.maxChildren ?? 3, 1);
    const children = childSitemaps.slice(0, maxChildren);
    if (childSitemaps.length > maxChildren) partial = true;
    // All children at once: each is one slow round trip on a typical WordPress site.
    const fetched = await mapLimit(children, Math.min(children.length, 10), deadlineAt, async (child) => {
      const childUrls = parseSitemap((await fetcher(absoluteUrl(child, input.siteUrl), { maxChars: SITEMAP_MAX_CHARS })).text).urls;
      input.onChildUrls?.(children.indexOf(child), childUrls);
      return childUrls;
    });
    if (fetched.timedOut) partial = true;
    urls = fetched.results.flatMap((r) => r ?? []);
  }
  if (parsed.kind === "unknown") add("high", "The file is not a sitemap (<urlset> or <sitemapindex> not found)");
  else if (urls.length === 0) add("high", "The sitemap lists no URLs");
  let siteHost = "";
  try {
    siteHost = new URL(originOf(input.siteUrl)).host;
  } catch {
    siteHost = "";
  }
  const foreign = urls.filter((u) => {
    try {
      return new URL(u).host !== siteHost;
    } catch {
      return true;
    }
  });
  if (foreign.length > 0) add("medium", `${foreign.length} sitemap URL(s) are on another host (e.g. ${foreign[0]})`);
  const sampleSize = Math.min(Math.max(input.sample ?? 5, 0), 10);
  const step = urls.length > sampleSize && sampleSize > 0 ? Math.floor(urls.length / sampleSize) : 1;
  const sample = sampleSize > 0 ? urls.filter((_, i) => i % step === 0).slice(0, sampleSize) : [];
  const checked = await mapLimit(sample, 5, deadlineAt, async (u) => {
    let r = await fetcher(u, { method: "HEAD", maxChars: 0 });
    if (r.status === 405 || r.status === 501) r = await fetcher(u, { maxChars: 1000 });
    return { url: u, status: r.status, redirected: r.redirects.length > 0 };
  });
  const spotChecked: Array<{ url: string; status: number }> = [];
  checked.results.forEach((r, i) => {
    if (!r) {
      spotChecked.push({ url: sample[i]!, status: 0 });
      return;
    }
    spotChecked.push({ url: r.url, status: r.status });
    if (r.status >= 400) add("high", `Sitemap URL returns HTTP ${r.status}`, r.url);
    else if (r.redirected) add("low", "Sitemap URL redirects; list the final URL instead", r.url);
  });
  if (checked.timedOut) partial = true;
  return {
    sitemapUrl,
    status: res.status,
    kind: parsed.kind,
    totalUrls: urls.length,
    childSitemaps,
    sampleUrls: urls.slice(0, 20),
    spotChecked,
    partial,
    findings,
    urls,
  };
}

export interface MetaCheckResult {
  url: string;
  finalUrl: string;
  status: number;
  meta: PageMeta;
  findings: CheckFinding[];
}

export async function runMetaCheck(fetcher: SiteFetcher, url: string): Promise<MetaCheckResult> {
  const res = await fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const meta = extractMeta(res.text);
  const findings = res.status >= 400
    ? [{ category: "meta", severity: "critical" as const, url: res.url, finding: `Page returns HTTP ${res.status}` }]
    : metaFindings(res.url, meta);
  return { url, finalUrl: res.url, status: res.status, meta, findings };
}

export async function runCanonicalCheck(fetcher: SiteFetcher, url: string) {
  const res = await fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const result = canonicalCheck({ requestedUrl: url, finalUrl: res.url, html: res.text, linkHeader: res.headers.link });
  return { ...result, status: res.status, redirects: res.redirects };
}

export async function runSchemaCheck(fetcher: SiteFetcher, url: string): Promise<SchemaResult & { url: string; status: number }> {
  const res = await fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  return { ...extractJsonLd(res.text, res.url), url: res.url, status: res.status };
}

export async function runCrawlerSim(fetcher: SiteFetcher, url: string): Promise<CrawlerView> {
  const [page, robots] = await Promise.all([
    fetcher(url, { headers: { "User-Agent": GOOGLEBOT_UA, Accept: "text/html,application/xhtml+xml" } }),
    runRobotsCheck(fetcher, url).catch(() => null),
  ]);
  return crawlerView({
    url,
    finalUrl: page.url,
    status: page.status,
    redirects: page.redirects,
    headers: page.headers,
    html: page.text,
    robots: robots && robots.status < 400 ? robots.robots : null,
  });
}

/** Agent MCP calls time out after 10 s in the tool gateway; 1 s is left for overhead. */
export const LINK_AUDIT_MAX_MS = 7_500;
/** The sitemap (robots.txt, sitemap, child sitemaps) gets at most this; the crawl gets the rest. */
export const LINK_AUDIT_SITEMAP_MS = 5_000;

/** Pages the link audit loads at once. */
export const LINK_AUDIT_CONCURRENCY = 10;
/**
 * Pages loaded at once when less than LINK_AUDIT_SHORT_CRAWL_MS is left after the sitemap (a cold sitemap
 * read on a slow site). Live on agristudies.co.za (PAR-9952), 4-6 s left: 10 at once finished 0-1 pages
 * (each slowed to 5.5 s), 4 at once finished 4.
 */
export const LINK_AUDIT_SHORT_CRAWL_CONCURRENCY = 4;
export const LINK_AUDIT_SHORT_CRAWL_MS = 6_000;
/** Child sitemaps the link audit reads (all at once); more are reported as a partial sitemap. */
export const LINK_AUDIT_MAX_CHILD_SITEMAPS = 25;
/** A cached read or page load still pending after this is dropped and started again (a hung fetch never pins the cache). */
export const LINK_AUDIT_PENDING_MAX_MS = 60_000;
/** How long a fully read sitemap is reused between paged link-audit calls. */
export const LINK_AUDIT_SITEMAP_CACHE_MS = 30 * 60_000;
const SITEMAP_CACHE_MAX_ENTRIES = 50;

/**
 * Sitemaps read by the link audit, keyed by site origin and sitemap URL (PAR-9952). Paged calls
 * (startAt = nextStartAt) reuse the list instead of re-reading a slow sitemap index on every call,
 * which keeps the crawl list stable between pages and leaves the whole budget for the crawl. A read
 * still running when a call times out stays here, so the next call picks it up. Only complete reads
 * are kept once settled.
 */
const sitemapCache = new Map<string, { expiresAt: number; result: Promise<SitemapCheckResult> }>();

/** How long a crawled page's links are reused by the next paged call. */
export const LINK_AUDIT_PAGE_CACHE_MS = 5 * 60_000;
const PAGE_CACHE_MAX_ENTRIES = 1_000;

/**
 * Links per crawled page, keyed by URL (PAR-9952). A page load still running when a call hits its
 * deadline is not wasted: it finishes in the background and the next paged call reads it from here.
 * Only links are kept, never page bodies.
 */
const pageCache = new Map<string, { expiresAt: number; result: Promise<{ page: string; links: ReturnType<typeof extractLinks> }> }>();

function crawlPage(fetcher: SiteFetcher, page: string): Promise<{ page: string; links: ReturnType<typeof extractLinks> }> {
  const hit = pageCache.get(page);
  if (hit && hit.expiresAt > Date.now()) return hit.result;
  if (hit) pageCache.delete(page);
  const result = fetcher(page, { headers: { Accept: "text/html,application/xhtml+xml" }, maxChars: 1_500_000 })
    .then((res) => ({ page, links: res.status < 400 ? extractLinks(res.text, res.url) : [] }));
  const entry = { expiresAt: Date.now() + LINK_AUDIT_PENDING_MAX_MS, result };
  pageCache.set(page, entry);
  while (pageCache.size > PAGE_CACHE_MAX_ENTRIES) pageCache.delete(pageCache.keys().next().value!);
  result.then(
    () => {
      if (pageCache.get(page) === entry) entry.expiresAt = Date.now() + LINK_AUDIT_PAGE_CACHE_MS;
    },
    () => {
      if (pageCache.get(page) === entry) pageCache.delete(page);
    },
  );
  return result;
}

/**
 * While a cold sitemap index is read, start loading the first `count` crawl-list pages as soon as the
 * child sitemaps they come from have arrived, so the first call crawls more than the home page (PAR-9952).
 * The crawl list is the home page, then the de-duplicated child URLs in index order, so once children
 * 0..i are in, the start of the list is fixed.
 */
function warmFirstPages(fetcher: SiteFetcher, home: string, count: number): (index: number, urls: string[]) => void {
  const byChild: Array<string[] | undefined> = [];
  const warmed = new Set<string>();
  const want = Math.min(Math.max(count, 0), LINK_AUDIT_SHORT_CRAWL_CONCURRENCY);
  return (index, urls) => {
    byChild[index] = urls;
    const seen = new Set<string>([home]);
    for (let i = 0; warmed.size < want && byChild[i]; i += 1) {
      for (const url of byChild[i]!) {
        const page = comparableUrl(url);
        if (!page || seen.has(page)) continue;
        seen.add(page);
        if (!warmed.has(page)) {
          warmed.add(page);
          void crawlPage(fetcher, page).catch(() => null);
        }
        if (warmed.size >= want) break;
      }
    }
  };
}

/** Forget cached sitemaps and crawled pages (tests). */
export function clearLinkAuditCache(): void {
  sitemapCache.clear();
  pageCache.clear();
}

function cachedLinkAuditSitemap(
  fetcher: SiteFetcher,
  siteUrl: string,
  explicit: string | null | undefined,
  onChildUrls?: (index: number, urls: string[]) => void,
): Promise<SitemapCheckResult> {
  const key = `${originOf(siteUrl)}|${explicit ? absoluteUrl(explicit, siteUrl) : ""}`;
  const now = Date.now();
  const hit = sitemapCache.get(key);
  if (hit && hit.expiresAt > now) return hit.result;
  if (hit) sitemapCache.delete(key);
  const memo = memoFetcher(fetcher);
  if (!explicit) {
    // Read robots.txt and the most common sitemap index at the same time; resolveSitemapUrl reuses the response.
    void memo(`${originOf(siteUrl)}/sitemap_index.xml`, { maxChars: SITEMAP_MAX_CHARS }).catch(() => null);
  }
  const result = runSitemapCheck(memo, { siteUrl, sitemapUrl: explicit, sample: 0, deadlineMs: LINK_AUDIT_SITEMAP_CACHE_MS, maxChildren: LINK_AUDIT_MAX_CHILD_SITEMAPS, onChildUrls });
  const entry = { expiresAt: Date.now() + LINK_AUDIT_PENDING_MAX_MS, result };
  sitemapCache.set(key, entry);
  while (sitemapCache.size > SITEMAP_CACHE_MAX_ENTRIES) sitemapCache.delete(sitemapCache.keys().next().value!);
  result.then(
    (r) => {
      if (sitemapCache.get(key) !== entry) return;
      if (r.partial || r.status >= 400 || r.urls.length === 0) sitemapCache.delete(key);
      else entry.expiresAt = Date.now() + LINK_AUDIT_SITEMAP_CACHE_MS;
    },
    () => {
      if (sitemapCache.get(key) === entry) sitemapCache.delete(key);
    },
  );
  return result;
}

export interface LinkAuditResult {
  sitemapUrl: string | null;
  pagesInSitemap: number;
  /** Pages this call tried to crawl: the crawl list (home page, then the de-duplicated sitemap URLs) from startAt, up to maxPages. */
  pagesRequested: number;
  pagesCrawled: number;
  partial: boolean;
  sitemapTimedOut: boolean;
  startAt: number;
  /** Pass as startAt to continue; null when nothing is left. Always greater than startAt when pages remain. */
  nextStartAt: number | null;
  /** Pages skipped because the first page of the batch did not load within the budget (the cursor still advances). */
  skippedPages: string[];
  totalInternalLinks: number;
  /** Only on a complete crawl (partial: false): on a partial crawl orphans are not knowable. */
  orphans?: string[];
  topLinked: Array<{ url: string; inbound: number }>;
  linkedNotInSitemap: string[];
  crawledPages: string[];
  findings: CheckFinding[];
  note?: string;
}

export async function runInternalLinkAudit(
  fetcher: SiteFetcher,
  input: { siteUrl: string; sitemapUrl?: string | null; maxPages?: number; deadlineMs?: number; startAt?: number; concurrency?: number },
): Promise<LinkAuditResult> {
  const startedAt = Date.now();
  const budget = Math.min(Math.max(input.deadlineMs ?? LINK_AUDIT_MAX_MS, 0), LINK_AUDIT_MAX_MS);
  const deadlineAt = startedAt + budget;
  const sitemapDeadlineAt = startedAt + Math.min(LINK_AUDIT_SITEMAP_MS, budget);
  const maxPages = Math.min(Math.max(input.maxPages ?? 25, 1), 40);
  const home = comparableUrl(originOf(input.siteUrl)) ?? originOf(input.siteUrl);
  const startAt = Math.max(0, Math.floor(input.startAt ?? 0));
  // The home page is always first in the crawl list: load it while the sitemap is read.
  if (startAt === 0) void crawlPage(fetcher, home).catch(() => null);
  // safeFetch has no abort signal: a read still running at the deadline finishes in the background and is cached for the next call.
  const sitemap = await withDeadline(
    cachedLinkAuditSitemap(fetcher, input.siteUrl, input.sitemapUrl, startAt === 0 ? warmFirstPages(fetcher, home, maxPages - 1) : undefined),
    sitemapDeadlineAt,
  );
  if (sitemap === TIMEOUT) {
    return {
      sitemapUrl: input.sitemapUrl ? absoluteUrl(input.sitemapUrl, input.siteUrl) : null,
      pagesInSitemap: 0,
      pagesRequested: 0,
      pagesCrawled: 0,
      partial: true,
      sitemapTimedOut: true,
      startAt,
      // Never move the cursor back: the next call retries the same batch (the sitemap read carries on in the background).
      nextStartAt: startAt,
      skippedPages: [],
      totalInternalLinks: 0,
      topLinked: [],
      linkedNotInSitemap: [],
      crawledPages: [],
      findings: [],
      note: `The sitemap did not load within ${LINK_AUDIT_SITEMAP_MS / 1000} s, so no pages were crawled. Call again with startAt ${startAt} (nextStartAt); the sitemap keeps loading in the background. Or pass sitemapUrl.`,
    };
  }
  const sitemapSet = new Set(sitemap.urls.map((u) => comparableUrl(u)).filter((u): u is string => !!u));
  const crawlList = [home, ...[...sitemapSet].filter((u) => u !== home)];
  const pages = crawlList.slice(startAt, startAt + maxPages);
  const host = new URL(home).host;
  const inbound = new Map<string, number>(pages.map((p) => [p, 0]));
  const outsideSitemap = new Set<string>();
  let totalLinks = 0;
  const concurrency = input.concurrency
    ?? (deadlineAt - Date.now() < LINK_AUDIT_SHORT_CRAWL_MS ? LINK_AUDIT_SHORT_CRAWL_CONCURRENCY : LINK_AUDIT_CONCURRENCY);
  const crawled = await mapLimit(pages, concurrency, deadlineAt, (page) => crawlPage(fetcher, page));
  // The cursor stops at the first page not finished. Pages finished after it are not reported now: the next
  // call reads them from the page cache, so no page is reported twice.
  const firstUndone = crawled.done.indexOf(false);
  // The first page of the batch did not load within the budget: skip it so the cursor always advances (PAR-9952).
  const skippedPages = firstUndone === 0 ? [pages[0]!] : [];
  const advanceTo = firstUndone > 0 ? startAt + firstUndone : firstUndone === 0 ? startAt + 1 : startAt + pages.length;
  const nextStartAt = advanceTo < crawlList.length ? advanceTo : null;
  const reported = crawled.results.slice(0, firstUndone >= 0 ? firstUndone : pages.length);
  for (const entry of reported) {
    if (!entry) continue;
    const seen = new Set<string>();
    for (const link of entry.links) {
      let linkHost = "";
      try {
        linkHost = new URL(link.url).host;
      } catch {
        continue;
      }
      if (linkHost !== host || link.url === entry.page || seen.has(link.url)) continue;
      seen.add(link.url);
      totalLinks += 1;
      if (inbound.has(link.url)) inbound.set(link.url, (inbound.get(link.url) ?? 0) + 1);
      else if (!sitemapSet.has(link.url)) outsideSitemap.add(link.url);
    }
  }
  const crawledPages = reported.filter(Boolean).map((r) => r!.page);
  const partial = startAt > 0 || nextStartAt !== null || sitemap.partial || skippedPages.length > 0;
  // Orphans need every page's links: only a complete crawl from startAt 0 reports them.
  const orphans = partial ? [] : crawledPages.filter((p) => p !== home && (inbound.get(p) ?? 0) === 0);
  const findings: CheckFinding[] = [
    ...sitemap.findings,
    ...orphans.slice(0, 20).map((url) => ({ category: "links", severity: "medium" as const, url, finding: "No internal links from other crawled pages (orphan)" })),
  ];
  const note = partial
    ? [
      `Partial crawl: ${crawledPages.length} of ${pages.length} requested pages crawled from startAt ${startAt} (${crawlList.length} pages in the crawl list: home page, then sitemap URLs).`,
      skippedPages.length > 0 ? `Skipped ${skippedPages[0]}: it did not load within the time limit.` : "",
      nextStartAt !== null ? `Call again with startAt ${nextStartAt} (nextStartAt) to continue.` : "No pages left after this batch.",
      sitemap.partial ? `The sitemap was not read in full (more than ${LINK_AUDIT_MAX_CHILD_SITEMAPS} child sitemaps, or a child sitemap failed).` : "",
      "Orphans are only reported by one complete crawl from startAt 0, so none are listed or stored.",
    ].filter(Boolean).join(" ")
    : undefined;
  return {
    sitemapUrl: sitemap.sitemapUrl,
    pagesInSitemap: sitemap.totalUrls,
    pagesRequested: pages.length,
    pagesCrawled: crawledPages.length,
    partial,
    sitemapTimedOut: false,
    startAt,
    nextStartAt,
    skippedPages,
    totalInternalLinks: totalLinks,
    ...(partial ? {} : { orphans }),
    note,
    topLinked: [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([url, count]) => ({ url, inbound: count })),
    linkedNotInSitemap: [...outsideSitemap].slice(0, 25),
    crawledPages,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Soft-404 probe: check if nonexistent paths return 200 (app shell)
// ---------------------------------------------------------------------------

export interface Soft404Result {
  url: string;
  status: number;
  findings: CheckFinding[];
}

export async function runSoft404Check(fetcher: SiteFetcher, siteUrl: string): Promise<Soft404Result> {
  const origin = originOf(siteUrl);
  const randomPath = `/pib-soft404-${Math.random().toString(36).slice(2, 10)}`;
  const url = `${origin}${randomPath}`;
  const res = await fetcher(url);
  const findings: CheckFinding[] = [];
  if (res.status === 200) {
    findings.push({ category: "soft-404", severity: "high", url, finding: "Returns HTTP 200 for nonexistent path (app shell returning 200)" });
  }
  return { url, status: res.status, findings };
}

// ---------------------------------------------------------------------------
// Byline/date probe: check for author and date info in article pages
// ---------------------------------------------------------------------------

export interface BylineCheckResult {
  url: string;
  finalUrl: string;
  status: number;
  isArticle: boolean;
  findings: CheckFinding[];
}

export async function runBylineCheck(fetcher: SiteFetcher, url: string): Promise<BylineCheckResult> {
  const page = await fetcher(url, { headers: { "User-Agent": GOOGLEBOT_UA, Accept: "text/html,application/xhtml+xml" } });
  const findings: CheckFinding[] = [];

  // Detect if page is article-like
  const meta = extractMeta(page.text);
  const path = new URL(page.url).pathname.toLowerCase();
  const isArticle = /^article$/.test((meta.ogType ?? "").toLowerCase()) ||
    /\/blog\/[^/]+/.test(path) ||
    /<article\b/.test(page.text);

  if (isArticle && page.status < 400) {
    // Check for byline/author: visible text patterns or structured markers
    const visibleText = bodyText(page.text);
    const hasAuthorInVisibleText = /\b[Bb]y\s+[A-Z]/.test(visibleText) || /written by|author:/i.test(visibleText);
    const hasStructuredAuthor = /rel\s*=\s*["']author|itemprop\s*=\s*["']author|class\s*=\s*["'][^"']*(?:author|byline)/i.test(page.text);
    const hasAuthor = hasAuthorInVisibleText || hasStructuredAuthor;

    // Check for date: visible text or time element (JSON-LD alone is not sufficient)
    const hasDateElement = /<time\b/.test(page.text);
    const hasDateInVisibleText = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}/i.test(visibleText);
    const hasDate = hasDateElement || hasDateInVisibleText;

    if (!hasAuthor) {
      findings.push({ category: "byline", severity: "medium", url: page.url, finding: "No visible author/byline detected" });
    }
    if (!hasDate) {
      findings.push({ category: "byline", severity: "medium", url: page.url, finding: "No visible publication or update date detected" });
    }
  }

  return { url, finalUrl: page.url, status: page.status, isArticle, findings };
}

// ---------------------------------------------------------------------------
// Thin-content probe: surface content pages with below-threshold text size
// ---------------------------------------------------------------------------

export interface ThinContentResult {
  url: string;
  finalUrl: string;
  status: number;
  textLength: number;
  findings: CheckFinding[];
}

export async function runThinContentCheck(fetcher: SiteFetcher, url: string, minChars: number = 200): Promise<ThinContentResult> {
  const page = await fetcher(url, { headers: { "User-Agent": GOOGLEBOT_UA, Accept: "text/html,application/xhtml+xml" } });
  const findings: CheckFinding[] = [];
  let textLength = 0;

  if (page.status < 400) {
    const crawler = crawlerView({
      url,
      finalUrl: page.url,
      status: page.status,
      redirects: page.redirects,
      headers: page.headers,
      html: page.text,
      robots: null,
    });

    textLength = crawler.bodyTextLength;
    if (textLength < minChars) {
      findings.push({
        category: "thin-content",
        severity: "high",
        url: page.url,
        finding: `Only ${textLength} characters of text (below threshold of ${minChars})`,
      });
    }
  }

  return { url, finalUrl: page.url, status: page.status, textLength, findings };
}
