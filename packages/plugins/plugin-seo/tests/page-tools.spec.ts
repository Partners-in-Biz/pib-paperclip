import { describe, expect, it } from "vitest";
import { diffPages, diffSummary, pageElements } from "../src/checks/page-diff.js";
import { decideKeywordPage, type GscRow } from "../src/engine/keyword-page.js";

const URL = "https://acme.co.za/best-accountants";
const old = `<html><head><title>Best accountants in Durban</title><meta name="description" content="A ranked list"><script type="application/ld+json">{"@type":"FAQPage"}</script></head>
<body><h1>Best accountants</h1><h2>How we rank</h2>
<table><tr><th>Firm</th><th>Score</th></tr><tr><td>Acme</td><td>9</td></tr><tr><td>Beta</td><td>8</td></tr></table>
<ul><li>One</li><li>Two</li><li>Three</li></ul><img src="/img/logo.png"><form action="/quote" id="q"></form>
<a href="/contact">Contact</a><a href="https://other.com/x">Other</a><iframe src="https://youtube.com/embed/x"></iframe></body></html>`;

describe("diff gate", () => {
  it("lists every element that disappeared, row by row", () => {
    const next = `<html><head><title>Best accountants in Durban</title></head><body><h1>Best accountants</h1><table><tr><th>Firm</th><th>Score</th></tr><tr><td>Acme</td><td>9</td></tr></table><a href="/contact">Contact</a></body></html>`;
    const diff = diffPages({ html: old, url: URL }, { html: next, url: URL });
    const labels = diff.lost.map((e) => e.label).join("|");
    expect(labels).toContain("Table row: Beta 8");
    expect(labels).toContain("Meta description");
    expect(labels).toContain("Structured data: FAQPage");
    expect(labels).toContain("Image: logo.png");
    expect(labels).toContain("Form");
    expect(labels).toContain("List (3 items)");
    expect(labels).toContain("youtube.com/embed/x");
    expect(labels).toContain("H2: How we rank");
    expect(labels).not.toContain("Link to /contact");
    expect(labels).not.toContain("other.com");
    expect(diffSummary(diff)).toMatch(/missing \d+ elements/);
  });

  it("is clean when only wording changed", () => {
    const next = old.replace("A ranked list", "A ranked list").replace("<h1>Best accountants</h1>", "<h1>Best accountants</h1>");
    const diff = diffPages({ html: old, url: URL }, { html: next + "<p>New paragraph</p>", url: URL });
    expect(diff.lost).toEqual([]);
    expect(diffSummary(diff)).toMatch(/Nothing/);
    expect(pageElements(old, URL).length).toBeGreaterThan(10);
  });

  it("treats the www and trailing slash forms of an internal link as the same page", () => {
    const a = pageElements(`<body><a href="https://www.acme.co.za/contact/">c</a></body>`, URL);
    const b = pageElements(`<body><a href="/contact">c</a></body>`, URL);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
  });
});

const row = (page: string, query: string, clicks: number, impressions: number, position: number): GscRow => ({ page, query, clicks, impressions, position });

describe("one keyword, one page", () => {
  it("says create when nothing earns the keyword", () => {
    const r = decideKeywordPage([row("/a", "tax tips", 0, 3, 40)], [], "accountant durban");
    expect(r.decision).toBe("create");
    expect(r.page).toBeNull();
  });

  it("says optimise when a page already gets clicks, and lists its other top-5 queries", () => {
    const kw = [row("/accounting", "accountant durban", 12, 300, 6.2)];
    const page = [row("/accounting", "accountant durban", 12, 300, 6.2), row("/accounting", "tax accountant durban", 4, 90, 3.1), row("/accounting", "cheap accountant", 0, 50, 22)];
    const r = decideKeywordPage(kw, page, "Accountant Durban");
    expect(r.decision).toBe("optimise");
    expect(r.page).toBe("/accounting");
    expect(r.secondary.map((s) => s.query)).toEqual(["tax accountant durban"]);
  });

  it("says merge when two pages fight for the keyword", () => {
    const r = decideKeywordPage([row("/a", "accountant durban", 5, 200, 7), row("/b", "accountant durban", 1, 120, 8)], [], "accountant durban");
    expect(r.decision).toBe("merge");
    expect(r.pages).toHaveLength(2);
  });

  it("says optimise on impressions alone when the page is somewhere in the top 10", () => {
    const r = decideKeywordPage([row("/a", "accountant durban", 0, 80, 9)], [], "accountant durban");
    expect(r.decision).toBe("optimise");
  });
});
