import { describe, expect, it } from "vitest";
import { SeoError } from "../src/service/common.js";
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
    expect(out.html).toContain('action="https://preview.partnersinbiz.online/p/x/tok123/decision"');
    expect(out.html).toContain("Proposed changes, not live.");
  });

  it("with no content area, places the copy at the first heading and reports it", () => {
    const bare = buildPreviewHtml("<html><head></head><body><h1>A</h1><p>x</p></body></html>", "https://x.co.za/", { bodyHtml: "<p>n</p>" }, { token: "t" });
    expect(bare.applied).toEqual(["bodyHtml"]);
    expect(bare.html).toContain("<body><p>n</p><h1>A</h1><p>x</p><div id=\"pib-preview-bar\"");
    expect(bare.notes[0]).toMatch(/first heading/);
  });

  it("refuses with a message naming contentSelector when there is no heading either", () => {
    const run = () => buildPreviewHtml("<html><head></head><body><p>x</p></body></html>", "https://x.co.za/", { h1: "H", bodyHtml: "<p>n</p>" }, { token: "t" });
    expect(run).toThrow(SeoError);
    expect(run).toThrow(/contentSelector/);
  });

});

describe("base href does not hijack the decision form", () => {
  it("uses absolute preview origin URL so base href cannot affect the form action", () => {
    const withBaseHref = buildPreviewHtml(
      `<html><head><base href="https://huntandgun.co.za/category/safe/"></head><body><h1>Guns</h1><p>text</p></body></html>`,
      "https://huntandgun.co.za/category/safe/shotguns",
      { title: "Shotguns" },
      { token: "tok456" },
    );
    expect(withBaseHref.html).toContain('action="https://preview.partnersinbiz.online/p/huntandgun/tok456/decision"');
    // Verify that resolving the action URL with the base href still points to preview origin
    const actionUrl = withBaseHref.html.match(/action="([^"]+)"/)?.[1];
    if (actionUrl) {
      const resolved = new URL(actionUrl, "https://huntandgun.co.za/category/safe/");
      expect(resolved.origin).toBe("https://preview.partnersinbiz.online");
    }
  });

  it("works with another client domain", () => {
    const withBaseHref = buildPreviewHtml(
      `<html><head><base href="https://agriauctionssa.co.za/"></head><body><h1>Auctions</h1><p>text</p></body></html>`,
      "https://agriauctionssa.co.za/",
      { title: "Auctions" },
      { token: "tok789" },
    );
    expect(withBaseHref.html).toContain('action="https://preview.partnersinbiz.online/p/agriauctionssa/tok789/decision"');
    const actionUrl = withBaseHref.html.match(/action="([^"]+)"/)?.[1];
    if (actionUrl) {
      const resolved = new URL(actionUrl, "https://agriauctionssa.co.za/");
      expect(resolved.origin).toBe("https://preview.partnersinbiz.online");
      expect(resolved.pathname).toBe("/p/agriauctionssa/tok789/decision");
    }
  });
});

describe("sanitizeBody", () => {
  it("removes active content", () => {
    const html = sanitizeBody('<p onclick="x()">a</p><a href="javascript:evil()">l</a><iframe src="u"></iframe><form><input></form><style>p{}</style>');
    expect(html).toBe('<p>a</p><a href="#">l</a>');
  });
});

describe("Google Translate widget filtering", () => {
  it("ignores the Google Translate widget when counting visible words", () => {
    const liveWithWidget = `<html><head></head><body>
      <main><div class="entry-content"><p>real content words here</p></div></main>
      <div id="google_translate_element" class="skiptranslate goog-te-gadget">
        <div class="goog-te-menu-value"><span class="goog-te-menu-value">Language</span></div>
        <select class="goog-te-combo"><option>English</option><option>Spanish</option></select>
      </div>
    </body></html>`;

    const liveWithoutWidget = `<html><head></head><body>
      <main><div class="entry-content"><p>real content words here</p></div></main>
    </body></html>`;

    const previewHtml = `<html><head></head><body>
      <main><div class="entry-content"><p>real content words here</p><p>new words added</p></div></main>
      <div id="pib-preview-bar"></div>
    </body></html>`;

    const statsWithWidget = previewStats(liveWithWidget, previewHtml);
    const statsWithoutWidget = previewStats(liveWithoutWidget, previewHtml);

    // Both should have the same kept percentage since the widget words should be ignored
    expect(statsWithWidget.liveWords).toBe(4);
    expect(statsWithoutWidget.liveWords).toBe(4);
    expect(statsWithWidget.keptPct).toBe(statsWithoutWidget.keptPct);
    expect(statsWithWidget.keptPct).toBeGreaterThan(90);
  });

  it("handles single-quoted attributes, nesting and apostrophes", () => {
    const live = `<body><p>don't stop</p><div id='google_translate_element'><div><select><option>English</option><option>Spanish</option></select></div></div><p>after it</p></body>`;
    const stats = previewStats(live, "<body><p>x</p></body>");
    expect(stats.liveWords).toBe(4);
  });

  it("ignores elements with VIpgJd classes (Google Translate generated UI)", () => {
    const live = `<html><head></head><body>
      <p>page text</p>
      <div class="VIpgJd-obfuscate"><span class="VIpgJd-dEh-Heb">Hidden UI</span></div>
    </body></html>`;

    const preview = `<html><head></head><body>
      <p>page text</p>
    </body></html>`;

    const stats = previewStats(live, preview);
    expect(stats.keptPct).toBe(100);
    expect(stats.removedWords).toBe(0);
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

describe("pages without landmarks", () => {
  const opts = { token: "t" };
  const cards = `<div class="wrapNew"><div class="cardsNew">${[1, 2, 3].map((i) => `<article class="cardNew"><h3>Partner ${i}</h3><p>partner text ${i}</p></article>`).join("")}</div></div>`;
  const form = `<div class="comment-form"><div class="FormBody"><h2>List Your Lot</h2><form id="listingForm"><input name="lot"></form></div></div>`;
  const header = `<header><nav><h2>Menu</h2></nav><form class="search"><input name="s"></form></header>`;
  const footer = `<footer><h1>Partner websites to check out</h1></footer>`;
  const pasted = `<html><body>${cards}</body></html>`;
  const live = `<html><head></head><body>${header}${form}${footer}${pasted}</body></html>`;

  it("(a) lands before the h2 and before the footer, never in the partner cards", () => {
    const before = buildPreviewHtml(live, "https://x.co.za/list/", { bodyHtml: "<p>NEW</p>" }, opts);
    expect(before.html).toContain(`<p>NEW</p><h2>List Your Lot</h2>`);
    expect(before.html.match(/NEW/g)).toHaveLength(1);
    const after = buildPreviewHtml(live, "https://x.co.za/list/", { bodyHtml: "<p>NEW</p>", bodyMode: "after" }, opts);
    expect(after.html).toContain(`</form></div></div><p>NEW</p><footer>`);
    for (const out of [before, after]) expect(out.html).toContain(`<div class="cardsNew"><article class="cardNew"><h3>Partner 1</h3>`);
    expect(() => buildPreviewHtml(live, "https://x.co.za/list/", { bodyHtml: "<p>NEW</p>", bodyMode: "replace" }, opts)).toThrow(/contentSelector/);
  });

  it("contentSelector picks the block, refuses unsupported and unmatched selectors", () => {
    const sel = (contentSelector: string, extra = {}) => buildPreviewHtml(live, "https://x.co.za/list/", { bodyHtml: "<p>NEW</p>", contentSelector, ...extra }, opts);
    expect(sel(".comment-form").html).toContain(`<div class="comment-form"><p>NEW</p><div class="FormBody">`);
    expect(sel("div.comment-form", { bodyMode: "after" }).html).toContain(`</form></div><p>NEW</p></div><footer>`);
    expect(sel("#listingForm").html).toContain(`<form id="listingForm"><p>NEW</p>`);
    expect(sel("form#listingForm").html).toContain(`<form id="listingForm"><p>NEW</p>`);
    expect(sel("header").html).toContain(`<header><p>NEW</p><nav>`);
    expect(() => sel("div > p")).toThrow(/not supported/);
    expect(() => sel("[data-x]")).toThrow(/not supported/);
    expect(() => sel(".nope")).toThrow(/"\.nope" matches no element/);
    expect(() => sel("span.comment-form")).toThrow(/matches no element/);
  });

  it("(b) Agri Studies shape: role=main page with the partner article after the footer", () => {
    const shop = `<html><head></head><body><div class="wrap"><div class="content"><div class="main col-md-12" role="main"><div class="page-header"><h1 class="page-title">Core Courses</h1></div><ul class="products"><li class="product"><h2>Course A</h2></li><li class="product"><h2>Course B</h2></li></ul></div></div></div><footer id="containerfooter"><div>f</div></footer><style>.cardNew{}</style>${cards.replace(/<div class="wrapNew">|<\/div>$/g, "")}</body></html>`;
    const out = buildPreviewHtml(shop, "https://agristudies.co.za/product-category/corecourses/", { bodyHtml: "<p>NEW</p>", bodyMode: "after" }, opts);
    expect(out.html).toContain(`</ul><p>NEW</p></div></div></div><footer`);
    expect(out.html.indexOf("NEW")).toBeLessThan(out.html.indexOf("<footer"));
  });

  it("(c) uses role=main on any tag when there is no <main>", () => {
    const html = `<html><head></head><body><header><h1>Site</h1></header><section role="main"><p>page words</p></section><footer>f</footer></body></html>`;
    const out = buildPreviewHtml(html, "https://x.co.za/", { bodyHtml: "<p>NEW</p>" }, opts);
    expect(out.html).toContain(`<section role="main"><p>NEW</p><p>page words</p>`);
  });

  it("(d) ignores articles after the footer or after a second html/body", () => {
    const one = `<html><head></head><body><div id="c"><article><p>post</p></article></div><footer>f</footer><article class="w1"><p>a</p></article><article class="w2"><p>b</p></article></body></html>`;
    const o1 = buildPreviewHtml(one, "https://x.co.za/", { bodyHtml: "<p>NEW</p>" }, opts);
    expect(o1.html).toContain(`<article><p>NEW</p><p>post</p></article>`);
    const two = `<html><head></head><body><div id="c"><h1>T</h1><p>t</p></div><body><article>x</article><article>y</article></body></html>`;
    const o2 = buildPreviewHtml(two, "https://x.co.za/", { bodyHtml: "<p>NEW</p>", bodyMode: "after" }, opts);
    expect(o2.html).toContain(`<p>t</p></div><p>NEW</p><body><article>x`);
  });

  it("a footer inside an article is not the boundary", () => {
    const html = `<html><head></head><body><article><p>post</p><footer>by me</footer><p>tail</p></article><footer>f</footer></body></html>`;
    const out = buildPreviewHtml(html, "https://x.co.za/", { bodyHtml: "<p>NEW</p>", bodyMode: "after" }, opts);
    expect(out.html).toContain(`<p>tail</p><p>NEW</p></article><footer>f`);
  });

  it("(e) a heading in header, nav or aside is never the anchor", () => {
    const html = `<html><head></head><body><header><h1>Site</h1></header><aside><h1>Side</h1></aside><div><h2>Real</h2><p>x</p></div><footer>f</footer></body></html>`;
    const out = buildPreviewHtml(html, "https://x.co.za/", { bodyHtml: "<p>NEW</p>" }, opts);
    expect(out.html).toContain(`<p>NEW</p><h2>Real</h2>`);
    expect(out.html).toContain(`<header><h1>Site</h1></header>`);
  });

  it("prefers an h1 over an earlier h2", () => {
    const html = `<html><head></head><body><div><h2>Early</h2></div><div><h1>Title</h1></div><footer>f</footer></body></html>`;
    const out = buildPreviewHtml(html, "https://x.co.za/", { bodyHtml: "<p>NEW</p>" }, opts);
    expect(out.html).toContain(`<p>NEW</p><h1>Title</h1>`);
  });

  it("(f) no heading before the footer is refused naming contentSelector", () => {
    const html = `<html><head></head><body><header><h1>Site</h1></header><div><p>x</p></div><footer><h1>F</h1></footer></body></html>`;
    expect(() => buildPreviewHtml(html, "https://x.co.za/", { bodyHtml: "<p>NEW</p>" }, opts)).toThrow(/contentSelector/);
  });
});

describe("buildPreviewHtml social tags (PAR-8665)", () => {
  // Shape of the agriauctionssa.co.za head: theme + SEO plugin both print og/twitter tags, some twice, with
  // name= and property= mixed, plus an SVG <title> in the body that must stay.
  const LIVE_DUP = `<!doctype html><html><head><title>Live &amp; Online Farm Auctions | Agri Auctions SA</title>
<meta name="description" content="Old description">
<meta property="og:title" content="AGRI AUCTIONS SA"><meta property="og:title" content="AGRI AUCTIONS SA">
<meta property="og:title" content="Live &amp; Online Farm Auctions | Agri Auctions SA">
<meta property="og:description" content="Old og description"><meta name="og:description" content="Old og description 2">
<meta name="twitter:title" content="Old twitter title"><meta property="twitter:title" content="Old twitter title 2">
<meta name="twitter:description" content="Old twitter description"><title>Second title</title>
<meta property="og:image" content="https://x.co.za/img.jpg"></head>
<body><main><div class="entry-content"><svg><title>Logo</title></svg><p>copy</p></div></main></body></html>`;
  const TITLE = "Farm Equipment Auctions Near Me | Agri Auctions SA";
  const DESC = "Find farm equipment auctions near you across South Africa.";
  const out = buildPreviewHtml(LIVE_DUP, "https://x.co.za/auctions/", { title: TITLE, metaDescription: DESC }, { token: "tok" });
  const head = out.html.slice(0, out.html.search(/<\/head>/i));
  const metas = (key: string) => [...head.matchAll(new RegExp(`<meta\\b[^>]*(?:name|property)="${key}"[^>]*content="([^"]*)"`, "gi"))].map((m) => m[1]);

  it("outputs exactly one of each title/description tag, all matching the proposal", () => {
    expect(metas("og:title")).toEqual([TITLE]);
    expect(metas("twitter:title")).toEqual([TITLE]);
    expect(metas("og:description")).toEqual([DESC]);
    expect(metas("twitter:description")).toEqual([DESC]);
    expect(metas("description")).toEqual([DESC]);
    expect([...head.matchAll(/<title>([^<]*)<\/title>/gi)].map((m) => m[1])).toEqual([TITLE]);
    expect(out.html).not.toMatch(/AGRI AUCTIONS SA"|Old (og|twitter)|Second title/);
  });

  it("leaves other head tags and body <title> elements alone", () => {
    expect(metas("og:image")).toEqual(["https://x.co.za/img.jpg"]);
    expect(out.html).toContain("<svg><title>Logo</title></svg>");
  });

  it("adds the social tags when the live page has none", () => {
    const bare = buildPreviewHtml("<html><head></head><body><main><p>x</p></main></body></html>", "https://x.co.za/", { title: TITLE, metaDescription: DESC }, { token: "tok" });
    const h = bare.html.slice(0, bare.html.search(/<\/head>/i));
    for (const k of ["og:title", "twitter:title", "og:description", "twitter:description"]) expect(h).toContain(`"${k}"`);
    expect(h).toContain(`<title>${TITLE}</title>`);
  });
});
