import { describe, expect, it } from "vitest";
import { brandFromParts, extractBrandFromSite, hsl, isNeutral, parseBrandCss, parseBrandHtml, toHex } from "../src/brand-extract.js";

const HTML = `<!doctype html><html><head>
<title>Acme Bakery | Fresh bread in Pretoria</title>
<meta name="description" content="Sourdough &amp; pastries baked every morning.">
<meta property="og:site_name" content="Acme Bakery">
<meta property="og:image" content="/img/share.jpg">
<meta name="theme-color" content="#B5451B">
<link rel="stylesheet" href="/css/site.css?v=3">
<link rel="stylesheet" href="https://cdn.example/lib.css">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400&display=swap" rel="stylesheet">
<link rel="icon" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","logo":"https:\\/\\/acme.example\\/img\\/logo-mark.svg"}</script>
<style>:root{--brand-primary:#b5451b;--color-accent:rgb(240, 180, 41)} body{font-family:Inter,sans-serif;color:#222}</style>
</head><body>
<header><img class="site-logo" src="/img/logo.png" alt="Acme Bakery"></header>
<h1>Bread worth <em>waking up</em> for</h1><h2>Baked at 4am, gone by noon</h2>
<a style="background-color:#f0b429;color:#fff">Order</a>
<img src="/img/hero.jpg" alt="Loaves">
<script>var x = "<h1>not a heading</h1>";</script>
</body></html>`;

const CSS = `
/* theme */
h1, h2 { font-family: "Playfair Display", Georgia, serif; color: #b5451b }
.btn { background: #b5451b; border-color: #B5451B }
.btn:hover { background-color: #8f3514 }
a { color: #b5451b } .note { color: #777 } .card { background: #fff; border: 1px solid #eee }
.tag { background: #2ea3f2 } .x{color:#2ea3f2} .y{color:#2ea3f2}
@font-face { font-family: "FontAwesome"; src: url(fa.woff) }
@font-face { font-family: 'Playfair Display Fallback'; src: local(Georgia) }
:root { --wp--preset--color--vivid-red: #cf2e2e; --wp-admin-theme-color: #007cba; --secondary: hsl(150, 40%, 30%) }
`;

describe("colour helpers", () => {
  it("reads hex, rgb and hsl, and drops see-through colours", () => {
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("#B5451B")).toBe("#b5451b");
    expect(toHex("rgb(240, 180, 41)")).toBe("#f0b429");
    expect(toHex("rgba(0,0,0,0)")).toBeNull();
    expect(toHex("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(toHex("#11223300")).toBeNull();
    expect(toHex("red")).toBeNull();
  });
  it("knows paper and ink from brand colours", () => {
    expect(isNeutral("#ffffff")).toBe(true);
    expect(isNeutral("#222222")).toBe(true);
    expect(isNeutral("#777777")).toBe(true);
    expect(isNeutral("#b5451b")).toBe(false);
    expect(Math.round(hsl("#ff0000").h)).toBe(0);
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
  });
  it("lists stylesheets and Google font families, not the font link as a stylesheet", () => {
    expect(page.stylesheets).toEqual(["https://acme.example/css/site.css?v=3", "https://cdn.example/lib.css"]);
    expect(page.googleFonts).toEqual(["Playfair Display", "Inter"]);
  });
  it("orders logo candidates: declared logo, logo image, icons (largest), share image", () => {
    expect(page.logoCandidates).toEqual([
      "https://acme.example/img/logo-mark.svg",
      "https://acme.example/img/logo.png",
      "https://acme.example/apple-touch-icon.png",
      "https://acme.example/favicon-32.png",
      "https://acme.example/img/share.jpg",
    ]);
  });
  it("turns style attributes into rules so builder colours count", () => {
    expect(page.inlineCss).toContain("x{background-color:#f0b429;color:#fff}");
  });
});

describe("parseBrandCss", () => {
  const css = parseBrandCss(CSS);
  it("counts painted colours and reads role variables, skipping framework presets", () => {
    expect(css.uses.get("#b5451b")).toBe(4);
    expect(css.roleVars).toEqual([{ hex: "#2e6b4d", name: "--secondary", role: "secondary" }]);
  });
  it("reads heading fonts and drops icon and fallback faces", () => {
    expect(css.headingFonts).toEqual(["Playfair Display"]);
    expect(css.faceFonts).toEqual([]);
  });
});

describe("brandFromParts", () => {
  const found = brandFromParts("https://acme.example/", parseBrandHtml(HTML, "https://acme.example/"), [CSS]);
  it("picks the named and most used colours, and never a theme default on frequency", () => {
    expect(found.primaryColor).toBe("#b5451b");
    expect(found.secondaryColor).toBe("#2e6b4d");
    expect(found.accentColor).toBe("#f0b429");
    expect(found.colors[0]).toMatchObject({ hex: "#b5451b", role: "primary" });
    expect(found.colors[0]!.evidence).toEqual(expect.arrayContaining(["theme-color", "var --brand-primary"]));
    const divi = found.colors.find((c) => c.hex === "#2ea3f2")!;
    expect(divi.evidence).toContain("a theme's default colour");
    expect(found.colors.some((c) => c.hex === "#ffffff" || c.hex === "#777777")).toBe(false);
  });
  it("lists fonts headings first, without duplicates", () => {
    expect(found.fonts).toEqual(["Playfair Display", "Inter"]);
  });
  it("gives the logo and says what is missing on a bare page", () => {
    expect(found.logoUrl).toBe("https://acme.example/img/logo-mark.svg");
    expect(found.notes).toEqual([]);
    const bare = brandFromParts("https://bare.example/", parseBrandHtml("<html><body><p>Hi</p></body></html>", "https://bare.example/"), []);
    expect(bare).toMatchObject({ primaryColor: null, fonts: [], logoUrl: null });
    expect(bare.notes).toHaveLength(3);
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
