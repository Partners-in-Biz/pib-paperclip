import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreviewHtml, type BodyMode } from "../src/engine/preview.js";

// PAR-10107: huntandgun.co.za pages paste a whole HTML document into the WordPress page text: a <style> that paints the
// body dark grey, a stray <body>, then div.containerSet (the white card with the copy), then an auction categories list.
// The proposed copy has to land inside the card. Fixtures: tests/fixtures/README.md.
const SOURCE = readFileSync(resolve("tests/fixtures/huntandgun-hunting.html"), "utf-8");
const RENDERED = readFileSync(resolve("tests/fixtures/huntandgun-hunting-rendered.html"), "utf-8");
const opts = { token: "tok", clientName: "Hunt and Gun" };
const URL_ = "https://huntandgun.co.za/hunting-in-south-africa/";
const build = (html: string, bodyMode: BodyMode) => buildPreviewHtml(html, URL_, { bodyHtml: "<p>NEW</p>", bodyMode }, opts).html;
const CARD = `<div class="containerSet">`;

describe("pasted-document fixtures (PAR-10107)", () => {
  it("the source fixture keeps the live page's order: entry-content, style, stray body, card, close, theme footer", () => {
    const at = (s: string, from = 0) => SOURCE.indexOf(s, from);
    const content = at(`<div class="entry-content">`);
    const steps = [content, at("<style>", content), at("<body data-rsssl=1>", content), at(CARD, content), SOURCE.lastIndexOf("</article>"), at(`<footer id="main-footer">`)];
    expect(steps.every((i) => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(SOURCE.slice(at(CARD), at("Browse From Our Auction")).match(/<section>/g)).toHaveLength(2);
    expect(SOURCE).not.toMatch(/<script|whatsapp|@[a-z0-9-]+\.[a-z]/i);
  });

  it("the rendered fixture (Chromium) has one body and the card inside entry-content", () => {
    expect(RENDERED.match(/<body\b/gi)).toHaveLength(1);
    const content = RENDERED.indexOf(`<div class="entry-content">`);
    expect(content).toBeGreaterThan(0);
    expect(RENDERED.indexOf(CARD)).toBeGreaterThan(content);
    expect(RENDERED.indexOf(CARD)).toBeLessThan(RENDERED.lastIndexOf("</article>"));
  });
});

describe.each([
  ["source", SOURCE],
  ["rendered", RENDERED],
])("copy lands inside the pasted card (%s)", (_name, live) => {
  it("before: first child of div.containerSet", () => {
    expect(build(live, "before")).toMatch(/<div class="containerSet"><p>NEW<\/p>\s*<section>\s*<p>South Africa is renowned/);
  });

  it("after: last child of div.containerSet, above the categories list", () => {
    expect(build(live, "after")).toMatch(/can provide\.<\/p>\s*<\/section>\s*<p>NEW<\/p><\/div>\s*<h1>Browse From Our Auction/);
  });

  it("replace: the card's inner is replaced and the pasted <style> stays", () => {
    const out = build(live, "replace");
    expect(out).toMatch(/<div class="containerSet"><p>NEW<\/p><\/div>\s*<h1>Browse From Our Auction/);
    expect(out).not.toContain("South Africa is renowned");
    expect(out).toContain("background: linear-gradient(to right, #232526, #414345)");
    expect(out).toContain(".containerSet {");
  });

  it("H1 on a buy-a-gun-shaped page changes the card's h1, not the theme's", () => {
    const page = live
      .replace(`<h1 class="entry-title main_title">Hunting</h1>`, `<h1 class="entry-title main_title">buy a gun</h1>`)
      .replace(/(<div class="containerSet">\s*<section>)/, "$1<h1>Buy a Gun</h1>");
    const out = buildPreviewHtml(page, "https://huntandgun.co.za/buy-a-gun/", { h1: "Buy a Gun in South Africa" }, opts);
    expect(out.applied).toEqual(["h1"]);
    expect(out.html).toContain(`<section><h1>Buy a Gun in South Africa</h1>`);
    expect(out.html).toContain(`<h1 class="entry-title main_title">buy a gun</h1>`);
    expect(out.html).toContain(`<h1>Browse From Our Auction categories below</h1>`);
  });
});

describe("unbalanced pasted documents (PAR-10107)", () => {
  const withOpenDivs = (n: number) => SOURCE.replace("</section>", `</section>${'<div class="unclosed">'.repeat(n)}`);
  const footerAt = (html: string) => html.indexOf(`<footer id="main-footer">`);

  it("one unclosed div in the card: the copy never lands after the theme footer", () => {
    for (const mode of ["before", "after", "replace"] as const) {
      const out = build(withOpenDivs(1), mode);
      expect(out.indexOf("<p>NEW</p>")).toBeGreaterThan(0);
      expect(out.indexOf("<p>NEW</p>")).toBeLessThan(footerAt(out));
      expect(out).toContain(`<footer id="main-footer">`);
    }
  });

  // Six unclosed divs push the card's computed close past every theme wrapper and the footer.
  it("the card's close beyond the footer: no descent, the copy stays at the top of entry-content", () => {
    const out = build(withOpenDivs(6), "before");
    expect(out).toContain(`<div class="entry-content"><p>NEW</p>`);
    expect(out).not.toContain(`${CARD}<p>NEW</p>`);
    for (const mode of ["after", "replace"] as const) {
      const o = build(withOpenDivs(6), mode);
      expect(o.indexOf("<p>NEW</p>")).toBeLessThan(footerAt(o));
    }
  });
});

describe("whole-document signature stays narrow (PAR-10107)", () => {
  const page = (content: string) => `<html><head></head><body><article><h1 class="t">T</h1><div class="entry-content">${content}</div></article><footer>f</footer></body></html>`;
  const BODY_STYLE = `<style>body{background:#222}</style>`;

  it("steps into a plain card next to a body-styling <style>, even with blocks after it", () => {
    expect(build(page(`${BODY_STYLE}<div class="card"><p>x</p></div><ul><li>y</li></ul>`), "before")).toContain(`<div class="card"><p>NEW</p><p>x</p>`);
  });

  it("does not step in for a layout card, a flex rule, text before the card, or a style that leaves body alone", () => {
    const cases = [
      `${BODY_STYLE}<div class="row"><p>x</p></div><p>y</p>`,
      `<style>body{background:#222}.card{display:grid}</style><div class="card"><p>x</p></div><p>y</p>`,
      `${BODY_STYLE}<div class="card" style="display: flex"><p>x</p></div>`,
      `${BODY_STYLE}intro text<div class="card"><p>x</p></div>`,
      `<style>.card{color:#333}</style><div class="card"><p>x</p></div><p>y</p>`,
    ];
    for (const c of cases) expect(build(page(c), "before")).toContain(`<div class="entry-content"><p>NEW</p>`);
  });

  it("H1 replace skips a commented-out <h1> (huntandgun.co.za home page shape)", () => {
    const html = page(`${BODY_STYLE}<div class="card"><!-- <h1 class="old">Old</h1> --><h1 class="real">Real</h1><p>x</p></div>`);
    const out = buildPreviewHtml(html, "https://x.co.za/", { h1: "New" }, opts).html;
    expect(out).toContain(`<!-- <h1 class="old">Old</h1> --><h1 class="real">New</h1>`);
  });

  it("a stray body after the content area still ends the content (partner-widget shape)", () => {
    const html = `<html><head></head><body><div class="entry-content"><p>a</p></div><body><div><p>w</p></div></body></html>`;
    expect(build(html, "after")).toContain(`<p>a</p><p>NEW</p></div><body>`);
  });
});
