import { describe, expect, it } from "vitest";
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import {
  canonicalCheck,
  comparableUrl,
  crawlerView,
  extractJsonLd,
  extractLinks,
  extractMeta,
  imagesMissingAlt,
  metaFindings,
  parseRobots,
  parseSitemap,
  robotsAllows,
  robotsFindings,
} from "../src/checks/parse.js";
import { mapLimit, runInternalLinkAudit, runSitemapCheck, type SiteFetcher } from "../src/checks/site.js";

const PAGE = `<!doctype html><html lang="en"><head>
<title>Acme Accounting | Bookkeeping &amp; Tax for Durban SMEs</title>
<meta content="Bookkeeping, VAT and payroll for small businesses in Durban. Fixed monthly fees, a real accountant, and answers within a day." name="description">
<meta property="og:title" content="Acme Accounting">
<meta property='og:image' content='https://acme.co.za/og.png'>
<link rel="canonical" href="https://acme.co.za/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do you do VAT?","acceptedAnswer":{"@type":"Answer","text":"Yes."}},{"@type":"Question","name":"Payroll?"}]}]}</script>
</head><body><h1>Accounting for Durban small businesses</h1>
<p>${"Real content. ".repeat(40)}</p>
<a href="/services">Services</a> <a href="https://acme.co.za/about#team">About</a> <a href="https://other.com/x" rel="nofollow">Other</a> <a href="mailto:hi@acme.co.za">Mail</a>
<img src="/a.png" alt="Team photo"><img src="/b.png"><img src="/c.png" alt="">
</body></html>`;

describe("robots.txt", () => {
  const robots = parseRobots(`# comment
User-agent: *
Disallow: /admin
Allow: /admin/public

User-agent: Googlebot
User-agent: Bingbot
Disallow: /private*.pdf$

Sitemap: https://acme.co.za/sitemap.xml`);

  it("groups agents and rules", () => {
    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[1]!.agents).toEqual(["googlebot", "bingbot"]);
    expect(robots.sitemaps).toEqual(["https://acme.co.za/sitemap.xml"]);
  });

  it("applies the longest-match rule per agent", () => {
    expect(robotsAllows(robots, "Mozilla/5.0 (compatible; SomeBot)", "/admin/x")).toBe(false);
    expect(robotsAllows(robots, "SomeBot", "/admin/public/page")).toBe(true);
    // Googlebot has its own group, so the * rules do not apply to it.
    expect(robotsAllows(robots, "Googlebot", "/admin/x")).toBe(true);
    expect(robotsAllows(robots, "Googlebot", "/private-report.pdf")).toBe(false);
    expect(robotsAllows(robots, "Googlebot", "/private-report.pdf?x")).toBe(true);
  });

  it("flags blocking rules and missing sitemaps", () => {
    const blocked = parseRobots("User-agent: *\nDisallow: /");
    const findings = robotsFindings({ url: "https://acme.co.za/robots.txt", status: 200, robots: blocked });
    expect(findings.map((f) => f.severity)).toEqual(["critical", "low"]);
    expect(robotsFindings({ url: "u", status: 404, robots: { groups: [], sitemaps: [] } })[0]!.severity).toBe("info");
    expect(robotsFindings({ url: "u", status: 503, robots: { groups: [], sitemaps: [] } })[0]!.severity).toBe("high");
  });
});

describe("sitemaps", () => {
  it("parses urlsets, indexes, namespaces, CDATA and entities", () => {
    const urlset = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://acme.co.za/</loc></url>
      <url><loc><![CDATA[https://acme.co.za/a?x=1&y=2]]></loc></url>
      <url><loc>https://acme.co.za/b?x=1&amp;y=2</loc><image:image><image:loc>https://acme.co.za/i.png</image:loc></image:image></url>
    </urlset>`);
    expect(urlset.kind).toBe("urlset");
    expect(urlset.urls).toEqual(["https://acme.co.za/", "https://acme.co.za/a?x=1&y=2", "https://acme.co.za/b?x=1&y=2"]);
    const index = parseSitemap(`<sitemapindex><sitemap><loc>https://acme.co.za/post-sitemap.xml</loc></sitemap></sitemapindex>`);
    expect(index).toEqual({ kind: "index", urls: [], sitemaps: ["https://acme.co.za/post-sitemap.xml"] });
    expect(parseSitemap("<html></html>").kind).toBe("unknown");
  });
});

describe("meta, canonical, schema, links", () => {
  it("extracts head tags regardless of attribute order", () => {
    const meta = extractMeta(PAGE);
    expect(meta.title).toBe("Acme Accounting | Bookkeeping & Tax for Durban SMEs");
    expect(meta.description).toMatch(/^Bookkeeping, VAT/);
    expect(meta.ogImage).toBe("https://acme.co.za/og.png");
    expect(meta.canonicals).toEqual(["https://acme.co.za/"]);
    expect(meta.h1).toEqual(["Accounting for Durban small businesses"]);
    expect(meta.lang).toBe("en");
    expect(metaFindings("https://acme.co.za/", meta)).toEqual([]);
  });

  it("applies length rules and flags noindex", () => {
    const meta = extractMeta(`<title>Short</title><meta name="robots" content="noindex, follow"><h1>a</h1><h1>b</h1>`);
    const findings = metaFindings("u", meta).map((f) => f.finding);
    expect(findings).toContain("Title is short (5 chars; aim for 50–60)");
    expect(findings).toContain("Missing meta description");
    expect(findings).toContain("2 <h1> tags (use one)");
    expect(findings.some((f) => f.includes("noindex"))).toBe(true);
    const long = extractMeta(`<title>${"x".repeat(70)}</title>`);
    expect(metaFindings("u", long).some((f) => f.finding.startsWith("Title is long"))).toBe(true);
  });

  it("compares canonicals after normalising", () => {
    expect(canonicalCheck({ requestedUrl: "https://acme.co.za", finalUrl: "https://acme.co.za/", html: PAGE }).matches).toBe(true);
    const elsewhere = canonicalCheck({ requestedUrl: "https://acme.co.za/a", finalUrl: "https://acme.co.za/a", html: PAGE });
    expect(elsewhere.matches).toBe(false);
    expect(elsewhere.findings[0]!.finding).toMatch(/points elsewhere/);
    const proto = canonicalCheck({ requestedUrl: "https://acme.co.za/", finalUrl: "https://acme.co.za/", html: `<link rel="canonical" href="http://acme.co.za/">` });
    expect(proto.findings[0]!.severity).toBe("high");
    const header = canonicalCheck({ requestedUrl: "https://acme.co.za/x", finalUrl: "https://acme.co.za/x", html: "<p></p>", linkHeader: '<https://acme.co.za/x>; rel="canonical"' });
    expect(header).toMatchObject({ source: "header", matches: true });
    expect(canonicalCheck({ requestedUrl: "u", finalUrl: "https://acme.co.za/", html: "<p></p>" }).findings[0]!.finding).toMatch(/No canonical/);
    expect(comparableUrl("HTTPS://Acme.co.za:443/a/#x")).toBe("https://acme.co.za/a");
  });

  it("parses JSON-LD graphs and reports problems", () => {
    const result = extractJsonLd(PAGE, "https://acme.co.za/");
    expect(result.blocks).toBe(1);
    expect(result.types).toEqual(["Organization", "FAQPage"]);
    expect(result.findings.map((f) => f.finding)).toEqual(["FAQ item 2 has no acceptedAnswer.text"]);
    const broken = extractJsonLd(`<script type="application/ld+json">{"@type": "Product",}</script>`);
    expect(broken.invalidBlocks).toBe(1);
    expect(broken.findings[0]!.severity).toBe("high");
    const missing = extractJsonLd(`<script type='application/ld+json'>{"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme"}</script>`);
    expect(missing.findings[0]!.finding).toBe("LocalBusiness missing: address");
    expect(extractJsonLd("<p>none</p>").findings[0]!.finding).toMatch(/No JSON-LD/);
  });

  it("extracts absolute links and images without alt", () => {
    const links = extractLinks(PAGE, "https://acme.co.za/");
    expect(links.map((l) => l.url)).toEqual(["https://acme.co.za/services", "https://acme.co.za/about", "https://other.com/x"]);
    expect(links[2]!.nofollow).toBe(true);
    expect(imagesMissingAlt(PAGE, "https://acme.co.za/")).toEqual({ total: 3, missing: ["https://acme.co.za/b.png"], decorative: 1 });
  });
});

describe("crawler view", () => {
  it("combines status, robots, noindex headers and canonical into indexability", () => {
    const ok = crawlerView({ url: "https://acme.co.za/", finalUrl: "https://acme.co.za/", status: 200, redirects: [], headers: {}, html: PAGE, robots: parseRobots("User-agent: *\nAllow: /") });
    expect(ok.indexable).toBe(true);
    expect(ok.images.missingAlt).toBe(1);
    const hidden = crawlerView({ url: "https://acme.co.za/", finalUrl: "https://acme.co.za/", status: 200, redirects: [], headers: { "x-robots-tag": "noindex" }, html: PAGE, robots: null });
    expect(hidden).toMatchObject({ noindex: true, indexable: false });
    const blocked = crawlerView({ url: "https://acme.co.za/", finalUrl: "https://acme.co.za/", status: 200, redirects: [], headers: {}, html: PAGE, robots: parseRobots("User-agent: Googlebot\nDisallow: /") });
    expect(blocked.blockedByRobots).toBe(true);
    const thin = crawlerView({ url: "u", finalUrl: "https://acme.co.za/app", status: 200, redirects: [], headers: {}, html: `<link rel="canonical" href="https://acme.co.za/app"><div id="root"></div>`, robots: null });
    expect(thin.findings.some((f) => f.finding.includes("JavaScript"))).toBe(true);
  });
});

function fakeSite(pages: Record<string, { status?: number; body: string }>): SiteFetcher {
  return async (url: string): Promise<SafeFetchResult> => {
    const key = comparableUrl(url) ?? url;
    const page = pages[key] ?? pages[url];
    return { status: page ? page.status ?? 200 : 404, url, redirects: [], headers: {}, text: page?.body ?? "", ms: 1 };
  };
}

describe("bounded site checks", () => {
  const site = fakeSite({
    "https://acme.co.za/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://acme.co.za/sitemap_index.xml" },
    "https://acme.co.za/sitemap_index.xml": { body: "<sitemapindex><sitemap><loc>https://acme.co.za/pages.xml</loc></sitemap></sitemapindex>" },
    "https://acme.co.za/pages.xml": { body: "<urlset><url><loc>https://acme.co.za/</loc></url><url><loc>https://acme.co.za/services</loc></url><url><loc>https://acme.co.za/orphan</loc></url><url><loc>https://acme.co.za/gone</loc></url></urlset>" },
    "https://acme.co.za/": { body: `<a href="/services">S</a><a href="/about">A</a>` },
    "https://acme.co.za/services": { body: `<a href="/">Home</a>` },
    "https://acme.co.za/orphan": { body: `<a href="/">Home</a>` },
  });

  it("follows robots.txt to the sitemap index and spot-checks URLs", async () => {
    const result = await runSitemapCheck(site, { siteUrl: "https://acme.co.za", sample: 4 });
    expect(result.sitemapUrl).toBe("https://acme.co.za/sitemap_index.xml");
    expect(result.kind).toBe("index");
    expect(result.totalUrls).toBe(4);
    expect(result.findings.map((f) => f.finding)).toContain("Sitemap URL returns HTTP 404");
  });

  it("finds orphan pages among crawled sitemap pages", async () => {
    const result = await runInternalLinkAudit(site, { siteUrl: "https://acme.co.za", maxPages: 10 });
    expect(result.pagesCrawled).toBe(4);
    expect(result.orphans).toEqual(["https://acme.co.za/orphan", "https://acme.co.za/gone"]);
    expect(result.linkedNotInSitemap).toEqual(["https://acme.co.za/about"]);
    expect(result.partial).toBe(false);
  });

  it("stops at the deadline", async () => {
    const slow = (ms: number) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms));
    const result = await mapLimit([5, 5, 200, 200], 2, Date.now() + 60, (ms) => slow(ms));
    expect(result.timedOut).toBe(true);
    expect(result.results.slice(0, 2)).toEqual([5, 5]);
  });
});
