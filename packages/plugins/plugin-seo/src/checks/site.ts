/**
 * Site checks that fetch the client's site. All network goes through a
 * `SiteFetcher` (in the worker: the kit's SSRF-guarded `safeFetch`, which
 * follows redirects hop by hop). Work is bounded: page counts are capped and a
 * deadline keeps every check inside the host's 30 s tool/action limit.
 */
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import {
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

export function absoluteUrl(url: string, siteUrl?: string | null): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
  if (siteUrl && trimmed.startsWith("/")) return new URL(trimmed, originOf(siteUrl)).toString();
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
): Promise<{ results: Array<R | null>; completed: number; timedOut: boolean }> {
  const results: Array<R | null> = items.map(() => null);
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
      completed += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return { results, completed, timedOut: timedOut || completed < items.length };
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

export async function resolveSitemapUrl(fetcher: SiteFetcher, siteUrl: string, explicit?: string | null): Promise<string> {
  if (explicit) return absoluteUrl(explicit, siteUrl);
  try {
    const robots = await runRobotsCheck(fetcher, siteUrl);
    if (robots.robots.sitemaps[0]) return absoluteUrl(robots.robots.sitemaps[0], siteUrl);
  } catch {
    // fall back to the conventional location
  }
  return `${originOf(siteUrl)}/sitemap.xml`;
}

export async function runSitemapCheck(
  fetcher: SiteFetcher,
  input: { siteUrl: string; sitemapUrl?: string | null; sample?: number; deadlineMs?: number },
): Promise<SitemapCheckResult> {
  const deadlineAt = Date.now() + (input.deadlineMs ?? 18_000);
  const sitemapUrl = await resolveSitemapUrl(fetcher, input.siteUrl, input.sitemapUrl);
  const findings: CheckFinding[] = [];
  const add = (severity: CheckFinding["severity"], finding: string, url: string | null = sitemapUrl) =>
    findings.push({ category: "sitemap", severity, url, finding });
  const res = await fetcher(sitemapUrl, { maxChars: 5_000_000 });
  if (res.status >= 400) {
    add("high", `Sitemap returns HTTP ${res.status}`);
    return { sitemapUrl, status: res.status, kind: "unknown", totalUrls: 0, childSitemaps: [], sampleUrls: [], spotChecked: [], partial: false, findings, urls: [] };
  }
  const parsed = parseSitemap(res.text);
  let urls = parsed.urls;
  let partial = false;
  const childSitemaps = parsed.sitemaps;
  if (parsed.kind === "index") {
    const children = childSitemaps.slice(0, 3);
    if (childSitemaps.length > 3) partial = true;
    const fetched = await mapLimit(children, 3, deadlineAt, async (child) => parseSitemap((await fetcher(absoluteUrl(child, input.siteUrl), { maxChars: 5_000_000 })).text).urls);
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

export interface LinkAuditResult {
  sitemapUrl: string;
  pagesInSitemap: number;
  pagesCrawled: number;
  partial: boolean;
  totalInternalLinks: number;
  orphans: string[];
  topLinked: Array<{ url: string; inbound: number }>;
  linkedNotInSitemap: string[];
  crawledPages: string[];
  findings: CheckFinding[];
}

export async function runInternalLinkAudit(
  fetcher: SiteFetcher,
  input: { siteUrl: string; sitemapUrl?: string | null; maxPages?: number; deadlineMs?: number },
): Promise<LinkAuditResult> {
  const deadlineAt = Date.now() + (input.deadlineMs ?? 20_000);
  const maxPages = Math.min(Math.max(input.maxPages ?? 25, 1), 40);
  const sitemap = await runSitemapCheck(fetcher, { siteUrl: input.siteUrl, sitemapUrl: input.sitemapUrl, sample: 0, deadlineMs: 8_000 });
  const home = comparableUrl(originOf(input.siteUrl)) ?? originOf(input.siteUrl);
  const sitemapSet = new Set(sitemap.urls.map((u) => comparableUrl(u)).filter((u): u is string => !!u));
  const pages = [home, ...[...sitemapSet].filter((u) => u !== home)].slice(0, maxPages);
  const host = new URL(home).host;
  const inbound = new Map<string, number>(pages.map((p) => [p, 0]));
  const outsideSitemap = new Set<string>();
  let totalLinks = 0;
  const crawled = await mapLimit(pages, 5, deadlineAt, async (page) => {
    const res = await fetcher(page, { headers: { Accept: "text/html,application/xhtml+xml" }, maxChars: 1_500_000 });
    return { page, links: res.status < 400 ? extractLinks(res.text, res.url) : [] };
  });
  for (const entry of crawled.results) {
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
  const crawledPages = crawled.results.filter(Boolean).map((r) => r!.page);
  const orphans = crawledPages.filter((p) => p !== home && (inbound.get(p) ?? 0) === 0);
  const findings: CheckFinding[] = [
    ...sitemap.findings,
    ...orphans.slice(0, 20).map((url) => ({ category: "links", severity: "medium" as const, url, finding: "No internal links from other crawled pages (orphan)" })),
  ];
  return {
    sitemapUrl: sitemap.sitemapUrl,
    pagesInSitemap: sitemap.totalUrls,
    pagesCrawled: crawledPages.length,
    partial: crawled.timedOut || sitemap.partial || sitemapSet.size + 1 > maxPages,
    totalInternalLinks: totalLinks,
    orphans,
    topLinked: [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([url, count]) => ({ url, inbound: count })),
    linkedNotInSitemap: [...outsideSitemap].slice(0, 25),
    crawledPages,
    findings,
  };
}
