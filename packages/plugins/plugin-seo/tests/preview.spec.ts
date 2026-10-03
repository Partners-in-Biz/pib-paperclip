import { describe, expect, it } from "vitest";
import { buildPreviewHtml, previewStats, sanitizeBody } from "../src/engine/preview.js";

const LIVE = `<!doctype html><html><head><title>Old title</title><meta name="description" content="old"><meta name="robots" content="index"><link rel="canonical" href="https://x.co.za/a"><script>track()</script></head>
<body onload="x()"><header><h1>Old heading</h1></header><main><div class="entry-content"><div><p>old copy</p></div><p>more</p></div></main><footer>f</footer></body></html>`;

describe("buildPreviewHtml", () => {
  const out = buildPreviewHtml(LIVE, "https://x.co.za/a", { title: "New <title>", metaDescription: "New description", h1: "New heading", bodyHtml: "<h2>Hi</h2><p>new copy</p><script>bad()</script>", bodyMode: "replace" }, { token: "tok123", clientName: "Acme" });

  it("swaps the proposed fields onto the live page", () => {
    expect([...out.applied].sort()).toEqual(["bodyHtml", "h1", "metaDescription", "title"]);
    expect(out.html).toContain("<title>New &lt;title&gt;</title>");
    expect(out.html).toContain('content="New description"');
    expect(out.html).toContain("New heading</h1>");
    expect(out.html).toContain("<p>new copy</p>");
    expect(out.html).not.toContain("old copy");
    expect(out.html).toContain("<footer>f</footer>");
  });

  it("is static, noindex, based on the live page and carries the answer form", () => {
    expect(out.html).not.toMatch(/<script|track\(\)|bad\(\)|onload/);
    expect(out.html).toContain('<base href="https://x.co.za/a">');
    expect(out.html).toContain('content="noindex,nofollow"');
    expect(out.html).not.toContain("canonical");
    expect(out.html).toContain('action="/p/tok123/decision"');
    expect(out.html).toContain("Proposed changes, not live.");
  });

  it("falls back to after the H1 and reports what it could not place", () => {
    const bare = buildPreviewHtml("<html><head></head><body><h1>A</h1><p>x</p></body></html>", "https://x.co.za/", { bodyHtml: "<p>n</p>" }, { token: "t" });
    expect(bare.applied).toEqual(["bodyHtml"]);
    expect(bare.notes[0]).toMatch(/after the heading/);
    const none = buildPreviewHtml("<html><head></head><body><p>x</p></body></html>", "https://x.co.za/", { h1: "H", bodyHtml: "<p>n</p>" }, { token: "t" });
    expect(none.applied).toEqual([]);
    expect(none.notes).toHaveLength(2);
  });
});

describe("sanitizeBody", () => {
  it("removes active content", () => {
    const html = sanitizeBody('<p onclick="x()">a</p><a href="javascript:evil()">l</a><iframe src="u"></iframe><form><input></form><style>p{}</style>');
    expect(html).toBe('<p>a</p><a href="#">l</a>');
  });
});

describe("how copy is added and what is kept", () => {
  const opts = { token: "t" };
  it("adds before or after the existing content by default and keeps the live text", () => {
    const before = buildPreviewHtml(LIVE, "https://x.co.za/a", { bodyHtml: "<p>intro words here</p>" }, opts);
    expect(before.html).toContain('<div class="entry-content"><p>intro words here</p><div><p>old copy</p>');
    const after = buildPreviewHtml(LIVE, "https://x.co.za/a", { bodyHtml: "<p>outro</p>", bodyMode: "after" }, opts);
    expect(after.html).toMatch(/<p>more<\/p><p>outro<\/p><\/div>/);
    const stats = previewStats(LIVE, before.html);
    expect(stats.keptPct).toBe(100);
    expect(stats.addedWords).toBe(3);
  });

  it("reports how much of the live page a replacement loses", () => {
    const big = `<html><head></head><body><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;
    const replaced = buildPreviewHtml(big, "https://x.co.za/", { bodyHtml: "<p>short intro</p>", bodyMode: "replace" }, opts);
    const stats = previewStats(big, replaced.html);
    expect(stats.keptPct).toBeLessThan(10);
    expect(stats.removedWords).toBeGreaterThan(100);
  });
});

describe("the heading", () => {
  const opts = { token: "t" };
  it("replaces an H1 inside the page content", () => {
    const live = `<html><head></head><body><main><div class="entry-content"><h1>Old title</h1><p>text words</p></div></main></body></html>`;
    const out = buildPreviewHtml(live, "https://x.co.za/", { h1: "New title" }, opts);
    expect(out.html).toContain("<h1>New title</h1>");
    expect(out.html).not.toContain("Old title");
    expect(out.applied).toEqual(["h1"]);
  });

  it("never overwrites a theme heading outside the content: the footer H1 stays and the new heading goes on top", () => {
    const live = `<html><head></head><body><main><div class="entry-content"><p>auction text words</p></div></main><footer><h1 class="h1Title">Partner websites to check out</h1></footer></body></html>`;
    const out = buildPreviewHtml(live, "https://x.co.za/", { h1: "Airguns at auction", bodyHtml: "<p>intro</p>" }, opts);
    expect(out.html).toContain('<h1 class="h1Title">Partner websites to check out</h1>');
    expect(out.html).toContain('<div class="entry-content"><h1>Airguns at auction</h1><p>intro</p><p>auction text words</p>');
    expect([...out.applied].sort()).toEqual(["bodyHtml", "h1"]);
    expect(out.notes.join(" ")).toMatch(/part of the theme/);
    expect(previewStats(live, out.html).removedWords).toBe(0);
  });
});

describe("listing pages", () => {
  const opts = { token: "t" };
  const lots = (n: number) => Array.from({ length: n }, (_, i) => `<article id="post-${i}"><h2>Lot ${i}</h2><p>lot text number ${i}</p></article>`).join("");
  const live = `<html><head></head><body><header><h2>NEXT AUCTION</h2></header><div id="primary">${lots(3)}</div><footer><h1>Partner websites</h1></footer></body></html>`;

  it("adds copy above the whole listing, not inside the first item", () => {
    const out = buildPreviewHtml(live, "https://x.co.za/category/a/", { bodyHtml: "<h1>Pistols at auction</h1><p>intro</p>" }, opts);
    expect(out.html).toContain('<div id="primary"><h1>Pistols at auction</h1><p>intro</p><article id="post-0">');
    expect(out.html).not.toMatch(/<article id="post-0"><h2>Lot 0<\/h2><p>lot text number 0<\/p><h1>/);
    expect(previewStats(live, out.html).removedWords).toBe(0);
  });

  it("after goes below the last item", () => {
    const out = buildPreviewHtml(live, "https://x.co.za/category/a/", { bodyHtml: "<p>outro</p>", bodyMode: "after" }, opts);
    expect(out.html).toMatch(/<p>lot text number 2<\/p><\/article><p>outro<\/p><\/div>/);
  });

  it("does not add the h1 field again when bodyHtml carries its own H1", () => {
    const out = buildPreviewHtml(live, "https://x.co.za/category/a/", { h1: "Pistols at auction", bodyHtml: "<h1>Pistols at auction</h1><p>intro</p>" }, opts);
    expect((out.html.match(/<h1>Pistols at auction<\/h1>/g) ?? []).length).toBe(1);
    expect(out.notes.join(" ")).toMatch(/already has its own H1/);
  });

  it("never treats a theme heading between the items as the page's H1", () => {
    const withTheme = `<html><head></head><body><div id="primary">${lots(2)}<h1 class="h1Title">Partner websites to check out</h1>${lots(1)}</div></body></html>`;
    const out = buildPreviewHtml(withTheme, "https://x.co.za/category/a/", { h1: "Pistols at auction" }, opts);
    expect(out.html).toContain('<h1 class="h1Title">Partner websites to check out</h1>');
    expect(out.html).toContain('<div id="primary"><h1>Pistols at auction</h1><article id="post-0">');
    expect(previewStats(withTheme, out.html).removedWords).toBe(0);
  });

  it("a single article is still its own content area", () => {
    const one = `<html><head></head><body><article><p>post words here</p></article></body></html>`;
    const out = buildPreviewHtml(one, "https://x.co.za/p/", { bodyHtml: "<p>intro</p>" }, opts);
    expect(out.html).toContain("<article><p>intro</p><p>post words here</p></article>");
  });
});
