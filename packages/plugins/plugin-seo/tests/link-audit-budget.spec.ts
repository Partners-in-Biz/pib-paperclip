import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import { runInternalLinkAudit, type LinkAuditResult, type SiteFetcher } from "../src/checks/site.js";
import { internalLinkAuditTool } from "../src/service/checks.js";
import type { Env } from "../src/service/common.js";

// PAR-6558: the tool gateway kills agent MCP calls after 10 s, so the audit must answer within 9 s.
const ORIGIN = "https://acme.test";

/** A site of `count` pages. Home links to every page but the last (the orphan); every page links home. */
function fakeSite(count: number, delays: { page: number; sitemap?: number }) {
  const fetched: string[] = [];
  const paths = Array.from({ length: count }, (_, i) => `/p${i}`);
  const reply = (url: string, status: number, text: string, ms: number) =>
    new Promise<SafeFetchResult>((resolve) =>
      setTimeout(() => resolve({ status, url, redirects: [], headers: {}, text, ms }), ms));
  const fetcher: SiteFetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/robots.txt") return reply(url, 404, "", 5);
    if (path === "/sitemap.xml") {
      const locs = paths.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("");
      return reply(url, 200, `<urlset>${locs}<url><loc>${ORIGIN}/p0</loc></url></urlset>`, delays.sitemap ?? 5);
    }
    fetched.push(path);
    const links = path === "/" ? paths.slice(0, -1).map((p) => `<a href="${p}">x</a>`).join("") : `<a href="/">home</a>`;
    return reply(url, 200, `<html><body>${links}</body></html>`, delays.page);
  };
  return { fetcher, fetched };
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

describe("internal link audit within the 10 s gateway limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a fast site in full, with orphans", async () => {
    const { fetcher } = fakeSite(5, { page: 50 });
    const { result } = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN, maxPages: 10 }));
    expect(result.partial).toBe(false);
    expect(result.nextStartAt).toBeNull();
    expect(result.pagesRequested).toBe(6);
    expect(result.pagesCrawled).toBe(6);
    expect(result.orphans).toEqual([`${ORIGIN}/p4`]);
    expect(result.findings.filter((f) => f.category === "links").map((f) => f.url)).toEqual([`${ORIGIN}/p4`]);
    expect(result.note).toBeUndefined();
  });

  it("returns a partial result within 9.5 s on a slow site, and continues from nextStartAt without repeats", async () => {
    const site = fakeSite(60, { page: 3_000 });
    const first = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 40, deadlineMs: 60_000 }));
    expect(first.elapsed).toBeLessThanOrEqual(9_500);
    const r1: LinkAuditResult = first.result;
    expect(r1.partial).toBe(true);
    expect(r1.pagesRequested).toBe(40);
    expect(r1.pagesCrawled).toBe(20);
    expect(r1.nextStartAt).toBe(20);
    expect(r1.note).toContain("startAt 20 (nextStartAt)");
    expect(r1).not.toHaveProperty("orphans");
    expect(r1.findings.filter((f) => f.category === "links")).toEqual([]);

    const second = await timed(() => runInternalLinkAudit(site.fetcher, { siteUrl: ORIGIN, maxPages: 40, startAt: r1.nextStartAt! }));
    expect(second.elapsed).toBeLessThanOrEqual(9_500);
    const r2 = second.result;
    expect(r2.startAt).toBe(20);
    expect(r2.pagesCrawled).toBeGreaterThan(0);
    expect(r2.crawledPages.filter((p) => r1.crawledPages.includes(p))).toEqual([]);
    expect(r2.crawledPages).not.toContain(`${ORIGIN}/`);
    expect(r2.partial).toBe(true);
    expect(r2).not.toHaveProperty("orphans");
  });

  it("says so when the sitemap itself times out, with nextStartAt 0", async () => {
    const { fetcher, fetched } = fakeSite(5, { page: 10, sitemap: 7_000 });
    const { result, elapsed } = await timed(() => runInternalLinkAudit(fetcher, { siteUrl: ORIGIN }));
    expect(elapsed).toBeLessThanOrEqual(5_500);
    expect(result).toMatchObject({ partial: true, sitemapTimedOut: true, nextStartAt: 0, pagesCrawled: 0 });
    expect(result.note).toContain("sitemap did not load");
    expect(fetched).toEqual([]);
  });

  it("tool: a partial run returns no orphans or link findings and stores nothing", async () => {
    const { fetcher } = fakeSite(60, { page: 3_000 });
    const env = { site: fetcher } as unknown as Env;
    const { result } = await timed(() => internalLinkAuditTool(env, "company-1", { url: ORIGIN, maxPages: 40 }));
    expect(result.partial).toBe(true);
    expect(result).not.toHaveProperty("orphans");
    expect(result.findings.some((f) => f.category === "links")).toBe(false);
    expect(result.stored).toEqual({ recorded: 0, resolved: 0 });
    expect(result.nextStartAt).toBe(20);
    expect(result.note).toContain("nextStartAt");
  });
});
