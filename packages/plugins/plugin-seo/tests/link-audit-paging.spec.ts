import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import { clearLinkAuditCache, runInternalLinkAudit, type SiteFetcher } from "../src/checks/site.js";

// PAR-9952: on agristudies.co.za (Yoast sitemap index with 7 child sitemaps, ~1.7 s per request,
// ~2.5 s per page) the second paged call re-read the whole sitemap, crawled 0 pages and returned
// the same nextStartAt for ever. These tests model that site.
const ORIGIN = "https://farm.test";
const CHILDREN = ["post", "page", "product", "category", "product_brand", "product_cat", "product_tag"];

interface SlowSiteOptions {
  robotsSitemap?: boolean;
  robotsMs?: number;
  sitemapMs?: number;
  pageMs?: number | ((path: string) => number);
  perChild?: number;
}

function slowWordPressSite(opts: SlowSiteOptions = {}) {
  const calls: string[] = [];
  const perChild = opts.perChild ?? 6;
  const childPaths = (child: string) => Array.from({ length: perChild }, (_, i) => `/${child}-${i}/`);
  const allPaths = CHILDREN.flatMap(childPaths);
  const reply = (url: string, status: number, text: string, ms: number) =>
    new Promise<SafeFetchResult>((resolve) => setTimeout(() => resolve({ status, url, redirects: [], headers: {}, text, ms }), ms));
  const fetcher: SiteFetcher = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const sitemapMs = opts.sitemapMs ?? 1_700;
    if (path === "/robots.txt") {
      const body = opts.robotsSitemap === false ? "User-agent: *\nDisallow:\n" : `User-agent: *\nDisallow:\n\nSitemap: ${ORIGIN}/sitemap_index.xml\n`;
      return reply(url, 200, body, opts.robotsMs ?? 1_600);
    }
    if (path === "/sitemap.xml" || path === "/wp-sitemap.xml") return reply(url, 404, "", sitemapMs);
    if (path === "/sitemap_index.xml") {
      const locs = CHILDREN.map((c) => `<sitemap><loc>${ORIGIN}/${c}-sitemap.xml</loc></sitemap>`).join("");
      return reply(url, 200, `<sitemapindex>${locs}</sitemapindex>`, sitemapMs);
    }
    const child = CHILDREN.find((c) => path === `/${c}-sitemap.xml`);
    if (child) {
      const locs = childPaths(child).map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("");
      return reply(url, 200, `<urlset>${locs}</urlset>`, sitemapMs);
    }
    const ms = typeof opts.pageMs === "function" ? opts.pageMs(path) : opts.pageMs ?? 2_500;
    const links = path === "/" ? allPaths.map((p) => `<a href="${p}">x</a>`).join("") : `<a href="/">home</a>`;
    return reply(url, 200, `<html><body>${links}</body></html>`, ms);
  };
  return { fetcher, calls };
}

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; elapsed: number }> {
  const t0 = Date.now();
  let endedAt = Number.NaN;
  const promise = run().then((value) => {
    endedAt = Date.now();
    return value;
  });
  await vi.advanceTimersByTimeAsync(30_000);
  const result = await promise;
  return { result, elapsed: endedAt - t0 };
}

describe("internal link audit paging across calls (PAR-9952)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearLinkAuditCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pages through a slow sitemap index: each call under 10 s, >1 page, no repeats, cursor strictly increases", async () => {
    const site = slowWordPressSite();
    const seen = new Set<string>();
    let startAt = 0;
    let indexReads = 0;
    // 43 pages in the crawl list (home + 42), 15 per call at most: at least 3 calls.
    let calls = 0;
    for (;;) {
      calls += 1;
      expect(calls).toBeLessThanOrEqual(10);
      const before = site.calls.filter((p) => p === "/sitemap_index.xml").length;
      const { result, elapsed } = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt }));
      indexReads += site.calls.filter((p) => p === "/sitemap_index.xml").length - before;
      expect(elapsed).toBeLessThan(10_000);
      expect(result.sitemapTimedOut).toBe(false);
      expect(result.sitemapUrl).toBe(`${ORIGIN}/sitemap_index.xml`);
      expect(result.pagesInSitemap).toBe(42);
      expect(result.startAt).toBe(startAt);
      expect(result.pagesCrawled).toBeGreaterThan(1);
      for (const page of result.crawledPages) {
        expect(seen.has(page)).toBe(false);
        seen.add(page);
      }
      expect(result.partial).toBe(true);
      expect(result).not.toHaveProperty("orphans");
      if (result.nextStartAt === null) break;
      expect(result.nextStartAt).toBeGreaterThan(startAt);
      startAt = result.nextStartAt;
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBe(43);
    // The index is read once and reused by the later calls.
    expect(indexReads).toBe(1);
    expect(site.calls.filter((p) => p === "/post-sitemap.xml")).toHaveLength(1);
  });

  it("loads the home page while a cold sitemap is read, and crawls more than the home page in the first call", async () => {
    // Pages slow down when many load at once, as on a small shared host: 1.3 s alone, +0.3 s per extra page in flight (budget cut to 7.5 s in PAR-10088).
    // Live on agristudies.co.za: ~2.3 s alone, 5.5-6.5 s with 10 at once.
    let inFlight = 0;
    const base = slowWordPressSite({ sitemapMs: 1_500 });
    const fetcher: SiteFetcher = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith(".xml") || path === "/robots.txt") return base.fetcher(url, init);
      base.calls.push(path);
      inFlight += 1;
      await new Promise((r) => setTimeout(r, 0)); // let the rest of the batch start
      const ms = 1_000 + 300 * inFlight;
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return { status: 200, url, redirects: [], headers: {}, text: `<a href="/">home</a>`, ms };
    };
    const { result, elapsed } = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN, maxPages: 15 }));
    expect(elapsed).toBeLessThan(10_000);
    expect(result.crawledPages[0]).toBe(`${ORIGIN}/`);
    expect(result.pagesCrawled).toBeGreaterThan(1);
    expect(result.nextStartAt).toBe(result.pagesCrawled);
  });

  it("reuses pages still loading at the deadline in the next call, without reporting any page twice", async () => {
    // Page i takes 2 s + 0.7 s * i: when call 1 ends, later pages of the batch are still loading or done out of order.
    const site = slowWordPressSite({ sitemapMs: 50, pageMs: (path) => 2_000 + 700 * (Number(path.match(/(\d+)\/?$/)?.[1] ?? 0) + (path.startsWith("/page") ? 6 : 0)) });
    const first = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt: 0 }));
    const r1 = first.result;
    expect(r1.pagesCrawled).toBeGreaterThan(1);
    const loadsAfterFirst = site.calls.filter((p) => !p.endsWith(".xml") && p !== "/robots.txt").length;
    const second = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt: r1.nextStartAt! }));
    const r2 = second.result;
    expect(r2.startAt).toBe(r1.nextStartAt);
    expect(r2.crawledPages.filter((p) => r1.crawledPages.includes(p))).toEqual([]);
    expect(r2.pagesCrawled).toBeGreaterThan(1);
    expect(r2.nextStartAt === null || r2.nextStartAt > r1.nextStartAt!).toBe(true);
    // Pages call 1 already started are not loaded again.
    const loaded = site.calls.filter((p) => !p.endsWith(".xml") && p !== "/robots.txt");
    expect(new Set(loaded).size).toBe(loaded.length);
    expect(loaded.length).toBeGreaterThan(loadsAfterFirst);
  });

  it("finds the sitemap index by itself when robots.txt names none", async () => {
    const site = slowWordPressSite({ robotsSitemap: false, robotsMs: 500, sitemapMs: 500 });
    const { result } = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15 }));
    expect(result.sitemapTimedOut).toBe(false);
    expect(result.sitemapUrl).toBe(`${ORIGIN}/sitemap_index.xml`);
    expect(result.pagesInSitemap).toBe(42);
    expect(result.pagesCrawled).toBeGreaterThan(1);
  });

  it("advances past a first page that never loads instead of returning the same cursor", async () => {
    const site = slowWordPressSite({ sitemapMs: 50, pageMs: (path) => (path.replace(/\/$/, "") === "/post-0" ? 60_000 : 100) });
    const { result } = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt: 1 }));
    expect(result.skippedPages).toHaveLength(1);
    expect(result.skippedPages[0]).toMatch(/\/post-0\/?$/);
    expect(result.nextStartAt).toBe(2);
    expect(result.note).toContain("did not load within the time limit");
    expect(result.partial).toBe(true);
    expect(result).not.toHaveProperty("orphans");
  });

  it("keeps the cursor when the sitemap times out, and the next call uses the sitemap read in the background", async () => {
    const site = slowWordPressSite({ sitemapMs: 3_000, pageMs: 100 });
    const first = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt: 3 }));
    expect(first.result).toMatchObject({ sitemapTimedOut: true, pagesCrawled: 0, nextStartAt: 3 });
    const second = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt: 3 }));
    expect(second.elapsed).toBeLessThan(1_000);
    expect(second.result.sitemapTimedOut).toBe(false);
    expect(second.result.pagesCrawled).toBe(15);
    expect(second.result.nextStartAt).toBe(18);
    expect(site.calls.filter((p) => p === "/sitemap_index.xml")).toHaveLength(1);
  });

  it("does not cache a sitemap that failed, so the next call reads it again", async () => {
    let fail = true;
    const site = slowWordPressSite({ sitemapMs: 10, pageMs: 10 });
    const fetcher: SiteFetcher = (url, init) => {
      if (fail && new URL(url).pathname === "/sitemap_index.xml") {
        return Promise.resolve({ status: 503, url, redirects: [], headers: {}, text: "", ms: 1 });
      }
      return site.fetcher(url, init);
    };
    const first = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN, maxPages: 5 }));
    expect(first.result.pagesInSitemap).toBe(0);
    fail = false;
    const second = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN, maxPages: 5 }));
    expect(second.result.pagesInSitemap).toBe(42);
  });

  it("every URL in [startAt, nextStartAt) is crawled or in skippedPages; unfinished pages are retried (PAR-10132)", async () => {
    const base = slowWordPressSite({ sitemapMs: 100, robotsMs: 100, pageMs: 100 });
    const failing = new Set(["/post-2", "/post-3"]);
    // Late pages are expected in a later call's crawledPages, not in the first call.
    const lateOnce = new Set(["/post-4", "/post-5"]);
    const fetcher: SiteFetcher = async (url, init) => {
      const path = new URL(url).pathname;
      if (failing.has(path)) throw new Error("fetch failed");
      if (lateOnce.has(path)) {
        lateOnce.delete(path);
        await new Promise((r) => setTimeout(r, 60_000)); // finishes long after the deadline
      }
      return base.fetcher(url, init);
    };
    const accounted = new Set<string>();
    let startAt = 0;
    let loops = 0;
    for (;;) {
      loops += 1;
      expect(loops).toBeLessThanOrEqual(20);
      const { result } = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN, maxPages: 15, startAt, concurrency: 5 }));
      const end = result.nextStartAt ?? 43;
      const covered = new Set([...result.crawledPages, ...result.skippedPages]);
      expect(covered.size).toBe(end - startAt);
      for (const page of covered) accounted.add(page);
      if (result.nextStartAt === null) break;
      expect(result.nextStartAt).toBeGreaterThan(startAt);
      startAt = result.nextStartAt;
    }
    expect(accounted.size).toBe(43);
    expect([...accounted].some((x) => x.includes("/post-4"))).toBe(true);
    expect([...accounted].some((x) => x.includes("/post-5"))).toBe(true);
  });
});
