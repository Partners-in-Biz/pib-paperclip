import { describe, expect, it } from "vitest";
import { brandFromParts, cleanFontName, extractBrandFromSite, hsl, isNeutral, markupUsage, parseBrandCss, parseBrandHtml, toHex } from "../src/brand-extract.js";

const HTML = `<!doctype html><html><head>
<title>Acme Bakery | Fresh bread in Pretoria</title>
<meta name="description" content="Sourdough &amp; pastries baked every morning.">
<meta property="og:site_name" content="Acme Bakery">
<meta property="og:image" content="/img/share.jpg">
<meta name="theme-color" content="#B5451B">
<meta name="generator" content="WordPress 6.6">
<link rel="stylesheet" href="/css/site.css?v=3">
<link rel="stylesheet" href="https://cdn.example/lib.css">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400&family=Caveat&display=swap" rel="stylesheet">
<link rel="icon" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","logo":"https:\\/\\/acme.example\\/img\\/logo-mark.svg"}</script>
<style>:root{--brand-primary:#b5451b;--brand-primary-foreground:#ffffff;--color-accent-hover:#7a2c10} body{font-family:Inter,sans-serif;color:#222;background:#fffaf2}</style>
</head><body>
<header class="site-header"><img class="site-logo" src="/img/logo.png" alt="Acme Bakery"><nav><a class="nav-link" href="/">Home</a><a class="nav-link" href="/menu">Menu</a><a class="nav-link" href="/find">Find us</a></nav></header>
<h1 class="hero-title">Bread worth <em>waking up</em> for</h1><h2>Baked at 4am, gone by noon</h2>
<a class="btn btn-primary" href="/order">Order</a> <a class="btn btn-primary" href="/menu">Menu</a> <button class="btn btn-primary">Call</button>
<span class="tag">New</span><span class="tag">Rye</span><span class="tag">Seeded</span><span class="tag">Today</span>
<a style="background-color:#f0b429;color:#fff">Sale</a>
<img src="/img/hero.jpg" alt="Loaves">
<script>var x = "<h1 class='ghost'>not a heading</h1>";</script>
</body></html>`;

const CSS = `
/* theme */
h1, h2 { font-family: "Playfair Display", Georgia, serif; color: #b5451b }
.btn-primary { background: var(--brand-primary); border-color: #B5451B }
.btn-primary:hover { background-color: #8f3514 }
.nav-link { color: #b5451b } .note { color: #777 } .card { background: #fff; border: 1px solid #eee }
.tag { background: hsl(150, 40%, 30%) }
.bg-sky-500 { background-color: #0ea5e9 } .text-sky-500 { color: #0ea5e9 } .border-sky-500 { border-color: #0ea5e9 } .ring-sky-500{ outline-color:#0ea5e9 }
.promo { background: #2ea3f2 } .x{color:#2ea3f2} .y{color:#2ea3f2}
.script-font { font-family: Caveat, cursive }
@font-face { font-family: "FontAwesome"; src: url(fa.woff) }
@font-face { font-family: 'Playfair Display Fallback'; src: local(Georgia) }
:root { --wp--preset--color--vivid-red: #cf2e2e; --wp-admin-theme-color: #007cba; --secondary: #2e6b4d; --brand-primary: #b5451b }
`;

describe("colour helpers", () => {
  it("reads hex, rgb, hsl, a bare hsl triple and oklch, and drops see-through colours", () => {
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("rgb(240, 180, 41)")).toBe("#f0b429");
    expect(toHex("rgba(0,0,0,0)")).toBeNull();
    expect(toHex("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(toHex("222.2 47.4% 11.2%")).toBe("#0f172a");
    expect(toHex("oklch(100% 0 0)")).toBe("#ffffff");
    expect(toHex("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
    expect(toHex("#11223300")).toBeNull();
    expect(toHex("red")).toBeNull();
  });
  it("knows paper and ink from brand colours", () => {
    expect(isNeutral("#ffffff")).toBe(true);
    expect(isNeutral("#777777")).toBe(true);
    expect(isNeutral("#b5451b")).toBe(false);
    expect(Math.round(hsl("#ff0000").h)).toBe(0);
  });
});

describe("markupUsage", () => {
  it("counts classes and tags of the markup, not of scripts", () => {
    const usage = markupUsage(HTML);
    expect(usage.classes.get("btn-primary")).toBe(3);
    expect(usage.classes.get("tag")).toBe(4);
    expect(usage.classes.has("ghost")).toBe(false);
    expect(usage.tags.get("h1")).toBe(1);
  });
});

describe("parseBrandHtml", () => {
  const page = parseBrandHtml(HTML, "https://acme.example/");
  it("reads what the site says about itself", () => {
    expect(page.siteName).toBe("Acme Bakery");
    expect(page.title).toBe("Acme Bakery | Fresh bread in Pretoria");
    expect(page.description).toBe("Sourdough & pastries baked every morning.");
    expect(page.headings).toEqual(["Bread worth waking up for", "Baked at 4am, gone by noon"]);
    expect(page.themeColor).toBe("#b5451b");
    expect(page.generator).toBe("WordPress 6.6");
    expect(page.placeholder).toBeNull();
  });
  it("lists stylesheets and Google font families, not the font link as a stylesheet", () => {
    expect(page.stylesheets).toEqual(["https://acme.example/css/site.css?v=3", "https://cdn.example/lib.css"]);
    expect(page.googleFonts).toEqual(["Playfair Display", "Inter", "Caveat"]);
  });
  it("orders logo candidates: declared logo, logo image, icons. The share image is kept apart", () => {
    expect(page.logoCandidates).toEqual([
      "https://acme.example/img/logo-mark.svg",
      "https://acme.example/img/logo.png",
      "https://acme.example/apple-touch-icon.png",
      "https://acme.example/favicon-32.png",
    ]);
    expect(page.shareImage).toBe("https://acme.example/img/share.jpg");
  });
  it("turns style attributes into rules so builder colours count", () => {
    expect(page.inlineCss).toContain("[style]{background-color:#f0b429;color:#fff}");
  });
  it("knows a Google Sites placeholder", () => {
    const sites = parseBrandHtml(`<html><head><title>Poppy</title><script src="https://www.gstatic.com/_/atari/_/js/x.js"></script></head><body><img class="logo" src="/g.png"></body></html>`, "https://www.poppy.example/");
    expect(sites.placeholder).toBe("Google Sites");
  });
});

describe("parseBrandCss: a colour counts by the elements that use it", () => {
  const usage = markupUsage(HTML);
  const css = parseBrandCss(CSS, usage);
  it("weighs a rule by the elements its selector matches, and resolves variables", () => {
    // .btn-primary background (3, through var(--brand-primary)) + border (3) + .nav-link (3) + h1, h2 (2)
    expect(css.uses.get("#b5451b")).toBe(11);
    expect(css.buttons.get("#b5451b")).toBe(3);
    expect(css.uses.get("#2e6b4d")).toBe(4);
  });
  it("counts a hover rule a tenth, and an unused utility nothing", () => {
    expect(css.uses.get("#8f3514")).toBeCloseTo(0.3);
    expect(css.uses.get("#0ea5e9")).toBe(0);
  });
  it("with no markup every rule counts once", () => {
    expect(parseBrandCss(CSS).uses.get("#0ea5e9")).toBe(4);
  });
  it("takes a role from a variable's name, not from its foreground, hover or shade", () => {
    const vars = parseBrandCss(":root{--brand-primary:#b5451b;--brand-primary-foreground:#fff;--color-accent-hover:#7a2c10;--primary-700:#123456;--bg-main:#eceae4;--secondary:#2e6b4d}");
    expect(vars.roleVars).toEqual([{ hex: "#b5451b", name: "--brand-primary", role: "primary" }, { hex: "#2e6b4d", name: "--secondary", role: "secondary" }]);
  });
  it("reads fonts from rules that match the markup: headings, body, then others", () => {
    expect(css.headingFonts).toEqual(["Playfair Display"]);
    expect(css.otherFonts).toEqual([]);
    expect(css.faceFonts).toEqual([]);
    expect(parseBrandCss("body{font-family:Inter,sans-serif}", usage).bodyFonts).toEqual(["Inter"]);
  });
});

describe("font names", () => {
  it("keeps a family and drops ids, weights, generics and icon fonts", () => {
    expect(cleanFontName('"Playfair Display"')).toBe("Playfair Display");
    expect(cleanFontName("avenir-lt-w01_35-light1475496")).toBe("Avenir LT");
    expect(cleanFontName("poppins-semibold")).toBe("Poppins");
    expect(cleanFontName("din-next-w01-light")).toBe("Din Next");
    for (const junk of ["lg", "Geneva", "sans-serif", "FontAwesome", "wfont_a1b2c3d4e5", "Inter Fallback", "var(--font)"]) expect(cleanFontName(junk), junk).toBeNull();
  });
});

describe("brandFromParts", () => {
  const page = parseBrandHtml(HTML, "https://acme.example/");
  const found = brandFromParts("https://acme.example/", page, [CSS]);
  it("picks the colour the page uses most, with its evidence", () => {
    expect(found.primaryColor).toBe("#b5451b");
    expect(found.colors[0]!.hex).toBe("#b5451b");
    expect(found.colors[0]!.evidence).toEqual(expect.arrayContaining(["theme-color", "var --brand-primary", "button background (on 3 buttons)", "on 11 elements"]));
  });
  it("takes a second colour only from another hue with strong evidence", () => {
    expect(found.secondaryColor).toBe("#2e6b4d");
    // The inline sale colour is used once, and the hover shade is the first colour again: neither is picked.
    expect(found.accentColor).toBeNull();
  });
  it("never picks an unused utility, a theme default, or the page's paper and ink", () => {
    const picks = [found.primaryColor, found.secondaryColor, found.accentColor];
    expect(picks).not.toContain("#0ea5e9");
    expect(picks).not.toContain("#2ea3f2");
    expect(found.colors.some((c) => c.hex === "#0ea5e9")).toBe(false);
    expect(found.backgroundColor).toBe("#fffaf2");
    expect(found.textColor).toBe("#222222");
    expect(found.colors.some((c) => c.hex === "#fffaf2" || c.hex === "#222222")).toBe(false);
  });
  it("lists the fonts the page uses, and apart from them the ones it only loads", () => {
    expect(found.fonts).toEqual(["Playfair Display", "Inter"]);
    expect(found.fontsDeclared).toEqual(["Caveat"]);
  });
  it("offers a PNG before an SVG as the logo, and never the share image", () => {
    expect(found.logoUrl).toBe("https://acme.example/img/logo.png");
    expect(found.logoCandidates).not.toContain("https://acme.example/img/share.jpg");
    expect(found.shareImage).toBe("https://acme.example/img/share.jpg");
    expect(found.notes).toEqual([]);
  });
  it("says so when the only logo is an SVG, and when a page is bare", () => {
    const svg = brandFromParts("https://s.example/", parseBrandHtml(`<html><body><img class="logo" src="/mark.svg"><p class="a">x</p></body></html>`, "https://s.example/"), []);
    expect(svg.logoUrl).toBe("https://s.example/mark.svg");
    expect(svg.notes.join(" ")).toMatch(/SVG or ICO/);
    const bare = brandFromParts("https://bare.example/", parseBrandHtml("<html><body><p>Hi</p></body></html>", "https://bare.example/"), []);
    expect(bare).toMatchObject({ primaryColor: null, fonts: [], logoUrl: null });
    expect(bare.notes.join(" ")).toMatch(/built by scripts/);
  });
  it("reads nothing from a site builder's placeholder", () => {
    const sites = brandFromParts("https://p.example/", parseBrandHtml(`<html><head><script src="https://www.gstatic.com/_/atari/x.js"></script><style>.a{background:#1a73e8}</style></head><body><div class="a"></div><img class="logo" src="/g.png"></body></html>`, "https://p.example/"), []);
    expect(sites).toMatchObject({ primaryColor: null, colors: [], fonts: [], logoUrl: null, generator: "Google Sites" });
    expect(sites.notes[0]).toMatch(/Google Sites page/);
  });
  it("on a page built by scripts it picks only a colour the site names", () => {
    const shell = `<html><head><meta name="theme-color" content="#f59e0b"></head><body><div id="root"></div></body></html>`;
    const css = ".bg-orange-400{background-color:#fb923c} .text-orange-400{color:#fb923c} .border-orange-400{border-color:#fb923c} body{font-family:'Inter Tight',Inter,sans-serif}";
    const named = brandFromParts("https://spa.example/", parseBrandHtml(shell, "https://spa.example/"), [css]);
    expect(named).toMatchObject({ primaryColor: "#f59e0b", secondaryColor: null, fonts: ["Inter Tight"] });
    const unnamed = brandFromParts("https://spa.example/", parseBrandHtml(shell.replace(/<meta[^>]*>/, ""), "https://spa.example/"), [css]);
    expect(unnamed.primaryColor).toBeNull();
    expect(unnamed.notes.join(" ")).toMatch(/built by scripts/);
  });

  it("counts a dark colour only where it fills something", () => {
    const html = `<html><body>${'<p class="copy">text</p>'.repeat(30)}<div class="band"></div><div class="band"></div><div class="chip"></div><div class="chip"></div><div class="chip"></div></body></html>`;
    const dark = brandFromParts("https://d.example/", parseBrandHtml(html, "https://d.example/"), [".copy{color:#0f172a} .band{background:#002333} .chip{background:#c5521c}"]);
    expect(dark.colors.map((c) => c.hex)).toEqual(["#c5521c", "#002333"]);
  });
});

describe("extractBrandFromSite", () => {
  const ctx = (pages: Record<string, { status?: number; body: string }>) => ({
    http: {
      fetch: async (url: string) => {
        const page = pages[url];
        if (!page) throw new Error("blocked");
        return { status: page.status ?? 200, headers: new Headers(), text: async () => page.body };
      },
    },
  }) as never;
  it("fetches the page and its stylesheets through the guarded fetch", async () => {
    const found = await extractBrandFromSite(ctx({ "https://acme.example/": { body: HTML }, "https://acme.example/css/site.css?v=3": { body: CSS } }), "https://acme.example/");
    expect(found.primaryColor).toBe("#b5451b");
    expect(found.fonts[0]).toBe("Playfair Display");
    expect(found.notes).toEqual(["A stylesheet could not be read: https://cdn.example/lib.css"]);
  });
  it("says so when the site does not answer", async () => {
    await expect(extractBrandFromSite(ctx({}), "https://down.example/")).rejects.toThrow(/did not answer/);
    await expect(extractBrandFromSite(ctx({ "https://gone.example/": { status: 404, body: "" } }), "https://gone.example/")).rejects.toThrow(/answered 404/);
  });
});
