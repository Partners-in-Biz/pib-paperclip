/**
 * Client preview pages: the live page's HTML with the proposed copy swapped in, a "not live" banner and the
 * client's Approve / Request changes form. Pure string work (no DOM in the worker), deliberately conservative:
 * scripts are removed so the preview is static, and agent-written body HTML is stripped of anything active.
 */

import { SeoError } from "../service/common.js";
import { PREVIEW_BASE, previewSlug } from "../service/preview-links.js";

/** before = added above the page's existing content (default), after = added below it, replace = takes the place of ALL of it. */
export type BodyMode = "before" | "after" | "replace";

export interface PreviewChanges {
  title?: string;
  metaDescription?: string;
  h1?: string;
  /** HTML added to the page's main content (see bodyMode). */
  bodyHtml?: string;
  bodyMode?: BodyMode;
  /** Redesign tasks only: styles shown on the preview (colours, fonts, spacing, layout). */
  css?: string;
  /** Optional CSS-like selector (#id, .class, tag, tag.class, tag#id) naming the element that is the content area; overrides the automatic search. */
  contentSelector?: string;
  /** One client-facing sentence on why the change helps (shown in the approval email; not part of the page). */
  why?: string;
}

export interface PreviewStats {
  liveWords: number;
  previewWords: number;
  /** Share of the live page's words that are still on the preview (0-100). */
  keptPct: number;
  addedWords: number;
  removedWords: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Remove every element whose opening tag matches openRe, with its whole subtree (nested same-name tags balanced).
 * `keep` turns the removed element into the text left in its place (default: nothing).
 */
function stripElements(html: string, openRe: RegExp, keep: (element: string) => string = () => ""): string {
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  let out = "";
  let pos = 0;
  openRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    if (m.index < pos) continue;
    let end = m.index + m[0].length;
    if (!VOID.test(m[1]) && !/\/>$/.test(m[0])) {
      const tagRe = new RegExp("<(/?)" + m[1] + "\\b[^>]*>", "gi");
      tagRe.lastIndex = end;
      let depth = 1;
      let t: RegExpExecArray | null;
      end = html.length;
      while ((t = tagRe.exec(html))) {
        if (t[1]) depth--;
        else if (!/\/>$/.test(t[0])) depth++;
        if (depth === 0) { end = t.index + t[0].length; break; }
      }
    }
    out += html.slice(pos, m.index) + " " + keep(html.slice(m.index, end)) + " ";
    pos = end;
    openRe.lastIndex = end;
  }
  return out + html.slice(pos);
}

/** Remove Google Translate widget elements to avoid counting their text as page content. */
function stripGoogleTranslateWidget(html: string): string {
  // Main widget container
  html = stripElements(html, /<(div)\b[^>]*\bid\s*=\s*["']?google_translate_element\b[^>]*>/gi);
  // Elements with the skiptranslate class
  html = stripElements(html, /<(\w+)\b[^>]*class\s*=\s*["']?[^"'>]*skiptranslate[^"'>]*["']?[^>]*>/gi);
  // Generated goog-te-* / VIpgJd UI
  html = stripElements(html, /<(\w+)\b[^>]*class\s*=\s*["']?[^"'>]*(?:goog-te|VIpgJd)[^"'>]*["']?[^>]*>/gi);
  return html;
}

/**
 * WooCommerce's related, upsell and cross-sell product strips: the shop picks their products at random on every page
 * load, so two loads of the same page differ by a whole strip of names and excerpts (PAR-9945: 83% "kept" for a
 * title-only change). The word count keeps only the strip's heading; the screenshots still show the strip.
 */
const VOLATILE_PRODUCT_STRIP = /<(section|div)\b[^>]*\bclass\s*=\s*["'](?=[^"']*\bproducts\b)(?=[^"']*\b(?:related|upsells|up-sells|cross-sells)\b)[^"']*["'][^>]*>/gi;

export function hasVolatileProductStrip(html: string): boolean {
  VOLATILE_PRODUCT_STRIP.lastIndex = 0;
  return VOLATILE_PRODUCT_STRIP.test(html);
}

function collapseVolatileStrips(html: string): string {
  return stripElements(html, VOLATILE_PRODUCT_STRIP, (el) => /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/i.exec(el)?.[0] ?? "");
}

/** Visible words of a page: no scripts, styles, tags, the preview's own bar or the products of a random product strip. */
export function visibleWords(html: string): string[] {
  const text = collapseVolatileStrips(stripGoogleTranslateWidget(html))
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<div id="pib-preview-bar"[\s\S]*?<\/form><\/div><div style="height:64px"><\/div>/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    // A browser shows &#82; as R and &ldquo; as a quote mark: decode numbers, drop other named entities (never a word).
    .replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi, (_m, d, x) => { const n = d ? Number(d) : parseInt(x, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " "; })
    .replace(/&(?!amp;)[a-z][a-z0-9]{1,31};/gi, " ")
    .replace(/&amp;/g, "&");
  return (text.toLowerCase().match(WORD) ?? []).slice(0, 200_000);
}

export function previewStats(liveHtml: string, previewHtml: string): PreviewStats {
  const live = visibleWords(liveHtml);
  const next = visibleWords(previewHtml);
  const pool = new Map<string, number>();
  for (const w of next) pool.set(w, (pool.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of live) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      kept += 1;
      pool.set(w, n - 1);
    }
  }
  const keptPct = live.length === 0 ? 100 : Math.round((kept / live.length) * 100);
  return { liveWords: live.length, previewWords: next.length, keptPct, addedWords: Math.max(0, next.length - kept), removedWords: Math.max(0, live.length - kept) };
}

/** A preview that loses more than this share of the live page's text is refused unless the agent says it replaces the page on purpose. */
export const MIN_KEPT_PCT = 70;

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Styles for a redesign preview: no imports, scripts, expressions or ways out of the style element. */
export function sanitizeCss(css: string): string {
  return css
    .replace(/</g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/javascript\s*:/gi, "")
    .replace(/behaviou?r\s*:[^;}]*/gi, "")
    .replace(/-moz-binding\s*:[^;}]*/gi, "")
    .replace(/url\(\s*["']?\s*(?!https?:|data:image\/|\/|#)[^)]*\)/gi, "none")
    .slice(0, 80_000);
}

/** Agent-written HTML: no scripts, frames, forms, event handlers or javascript: URLs. */
export function sanitizeBody(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?(<\/\1\s*>|$)/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** Index just past the element that opens at `open` (tag name `tag`), counting nested same-name tags. */
function elementEnd(html: string, open: number, tag: string): { innerStart: number; innerEnd: number } | null {
  const openEnd = html.indexOf(">", open);
  if (openEnd === -1) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = openEnd + 1;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : /\/>$/.test(m[0]) ? 0 : 1;
    if (depth === 0) return { innerStart: openEnd + 1, innerEnd: m.index };
  }
  return null;
}

/** Top-level <article> elements in document order (a listing page has one per item). */
function topLevelArticles(html: string, limit = html.length): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /<article\b[^>]*>/gi;
  let from = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index < from) continue;
    if (m.index >= limit) break;
    const range = elementEnd(html, m.index, "article");
    if (!range) break;
    const close = html.indexOf(">", range.innerEnd);
    out.push({ start: m.index, end: close === -1 ? range.innerEnd : close + 1 });
    from = close === -1 ? range.innerEnd : close + 1;
    re.lastIndex = from;
  }
  return out;
}

/** The content-area landmarks, most specific first (fresh regexes: they are global and keep lastIndex). */
function contentCandidates(): Array<{ re: RegExp; tag: string }> {
  return [
    { re: /<(div|section)\b[^>]*class\s*=\s*"[^"]*\b(entry-content|post-content|wp-block-post-content)\b[^"]*"[^>]*>/gi, tag: "" },
    { re: /<(main)\b[^>]*>/gi, tag: "main" },
    { re: /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["']main["'][^>]*>/gi, tag: "" },
  ];
}

/**
 * Where the page's own content stops: the earliest of the first <footer> that is not inside an <article>, a second
 * <html> or <body> open tag (a pasted document, such as a theme's partner widget after the footer), and the end of the
 * document. Anything after it is theme, never page content. A stray <html>/<body> inside the content area itself (a
 * whole HTML document pasted into a WordPress page, PAR-10107) is not a boundary: the copy after it is the page's. The
 * area is capped at that footer, so an unclosed tag in the paste never pulls the theme footer into it.
 */
function contentBoundary(html: string): number {
  let end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  if (end === -1) end = html.length;
  let footer = end;
  const articles = topLevelArticles(html);
  const re = /<footer\b/gi;
  for (let m = re.exec(html); m && m.index < end; m = re.exec(html)) {
    if (!articles.some((a) => m!.index > a.start && m!.index < a.end)) {
      footer = m.index;
      break;
    }
  }
  let area: [number, number] | null = null;
  for (const c of contentCandidates()) {
    const m = c.re.exec(html);
    if (!m || m.index >= footer) continue;
    const range = elementEnd(html, m.index, c.tag || m[1]!.toLowerCase());
    area = [m.index, Math.min(range?.innerEnd ?? footer, footer)];
    break;
  }
  let boundary = Math.min(end, footer);
  for (const tag of ["html", "body"]) {
    const tagRe = new RegExp(`<${tag}\\b`, "gi");
    let seen = 0;
    for (let m = tagRe.exec(html); m && m.index < boundary; m = tagRe.exec(html)) {
      if (++seen === 1 || (area && m.index > area[0] && m.index < area[1])) continue;
      boundary = m.index;
      break;
    }
  }
  return boundary;
}

// A content area holding a whole pasted HTML document (WordPress page text that starts with <style> and <body>, then
// one wrapper div: the white card the copy sits on). Copy belongs inside that card, else it lands on the paste's own
// body background and inherits its text colours (PAR-10107). Never stepped into: page-builder and layout wrappers.
const PASTE_SKIP = /\s+|<!--[\s\S]*?-->|<(style|script)\b[^>]*>([\s\S]*?)<\/\1\s*>|<(?:link|meta)\b[^>]*>|<\/?(html|body)\b[^>]*>/iy;
const LAYOUT_CLASS = /et_pb_|elementor|vc_|wpb|wp-block-|is-layout-|fl-|row|col|grid|flex/i;
const LAYOUT_DISPLAY = /\bdisplay\s*:\s*(?:inline-)?(?:flex|grid)\b/i;

/** Style text and stray tags from `at` on, up to the first other node: where that node starts. */
function skipPasteNoise(html: string, at: number, end: number, seen: { styles: string[]; stray: boolean }): number {
  const text = html.slice(0, end);
  for (;;) {
    PASTE_SKIP.lastIndex = at;
    const m = PASTE_SKIP.exec(text);
    if (!m) return at;
    if (m[1]?.toLowerCase() === "style") seen.styles.push(m[2] ?? "");
    if (m[3]) seen.stray = true;
    at += m[0].length;
  }
}

/** CSS rules (comments dropped) as [selector, body] pairs; @media blocks are read rule by rule. */
function cssRules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) out.push([m[1]!.trim(), m[2]!]);
  return out;
}

function pastedCard(html: string, area: { innerStart: number; innerEnd: number }): { innerStart: number; innerEnd: number } | null {
  const lead = { styles: [] as string[], stray: false };
  const at = skipPasteNoise(html, area.innerStart, area.innerEnd, lead);
  const open = /<div\b[^>]*>/iy;
  open.lastIndex = at;
  const tag = open.exec(html)?.[0];
  if (!tag) return null;
  const card = elementEnd(html, at, "div");
  const close = card ? html.indexOf(">", card.innerEnd) + 1 : 0;
  if (!card || close === 0 || close > area.innerEnd) return null;
  const trail = { styles: [] as string[], stray: false };
  const single = skipPasteNoise(html, close, area.innerEnd, trail) === area.innerEnd;
  const styles = [...lead.styles, ...trail.styles];
  const rules = styles.flatMap(cssRules);
  // The plan's rule: the card is the only element, next to a <style> or a stray tag. A paste whose leading style
  // styles the page's own body (or that still has its <body> tag) is a whole document even with blocks after the card.
  const wholeDocument = lead.stray || lead.styles.flatMap(cssRules).some(([sel]) => sel.split(",").some((s) => /^(html|body)(?![\w-])/i.test(s.trim())));
  if (!(single ? styles.length > 0 || lead.stray || trail.stray : wholeDocument)) return null;
  const attr = (name: string): string => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((v) => v !== undefined) ?? "";
  const classes = attr("class").split(/\s+/).filter(Boolean);
  if (classes.some((c) => LAYOUT_CLASS.test(c)) || LAYOUT_DISPLAY.test(attr("style"))) return null;
  const names = [...classes.map((c) => `\\.${c.replace(/[^\w-]/g, "\\$&")}`), ...(attr("id").trim() ? [`#${attr("id").trim().replace(/[^\w-]/g, "\\$&")}`] : [])];
  const named = names.length > 0 ? new RegExp(`(?:${names.join("|")})(?![\\w-])`) : null;
  if (named && rules.some(([sel, body]) => named.test(sel) && LAYOUT_DISPLAY.test(body))) return null;
  return card;
}

/**
 * Where the page's own content is: the entry-content / post-content block, else <main>, else [role="main"], else the
 * single <article>. A listing page (category archive, shop) has many <article> items and no such block: the area is the
 * run of items, so copy added "before" lands above the whole listing and "after" below it, never inside the first item.
 * Only what starts before the boundary counts; the area never runs past it.
 */
const SELECTOR_RE = /^([a-z][a-z0-9]*)?(?:([#.])(-?[_a-z][\w-]*))?$/i;

/** Parses a supported contentSelector (#id, .class, tag, tag.class, tag#id); anything else is refused. */
export function parseContentSelector(raw: string): { tag?: string; kind?: "id" | "class"; name?: string } {
  const sel = raw.trim();
  const m = SELECTOR_RE.exec(sel);
  if (!sel || sel.length > 100 || !m || (!m[1] && !m[3])) {
    throw new SeoError(`contentSelector "${raw.slice(0, 100)}" is not supported. Use #id, .class, tag, tag.class or tag#id (no spaces, combinators or attributes).`);
  }
  return { tag: m[1]?.toLowerCase(), kind: m[2] === "#" ? "id" : m[2] === "." ? "class" : undefined, name: m[3] };
}

/** Every closed element the selector matches, in document order. */
function* selectorMatches(html: string, raw: string): Generator<{ innerStart: number; innerEnd: number }> {
  const sel = parseContentSelector(raw);
  const re = new RegExp(`<${sel.tag ?? "([a-z][a-z0-9]*)"}\\b[^>]*>`, "gi");
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const open = m[0];
    if (sel.kind) {
      const attr = new RegExp(`\\b${sel.kind}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(open);
      const val = attr?.[1] ?? attr?.[2];
      if (val === undefined) continue;
      if (sel.kind === "id" ? val.trim() !== sel.name : !val.split(/\s+/).includes(sel.name!)) continue;
    }
    const tag = (sel.tag ?? m[1]!).toLowerCase();
    const range = elementEnd(html, m.index, tag);
    if (range) yield range;
  }
}

function findBySelector(html: string, raw: string): { innerStart: number; innerEnd: number } {
  for (const range of selectorMatches(html, raw)) return range;
  throw new SeoError(`contentSelector "${raw.trim()}" matches no element on the live page. Check it against the page's HTML, or leave contentSelector out.`);
}

/** How many elements a contentSelector matches (the rendered page is used only when it matches as often as the source). */
export function countBySelector(html: string, raw: string): number {
  let n = 0;
  for (const _ of selectorMatches(html, raw)) n += 1;
  return n;
}

/** A Chromium DOM dump starts at `<html>`: give it the doctype once so the copy renders in standards mode. */
export function withDoctype(html: string): string {
  return /^\s*<!doctype\b/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}

function findContentArea(html: string, boundary: number, selector?: string): { innerStart: number; innerEnd: number; listing?: boolean } | null {
  if (selector) return findBySelector(html, selector);
  // A pasted document's card, one level down, is where the copy goes (PAR-10107); otherwise the area itself.
  const area = (innerStart: number, innerEnd: number) => {
    const a = { innerStart, innerEnd };
    return pastedCard(html, a) ?? a;
  };
  for (const c of contentCandidates()) {
    const m = c.re.exec(html);
    if (!m || m.index >= boundary) continue;
    const range = elementEnd(html, m.index, c.tag || m[1]!.toLowerCase());
    if (range) return area(range.innerStart, Math.min(range.innerEnd, boundary));
  }
  const articles = topLevelArticles(html, boundary);
  if (articles.length === 1) {
    const only = articles[0]!;
    const range = elementEnd(html, only.start, "article");
    if (range) return area(range.innerStart, Math.min(range.innerEnd, boundary));
  }
  // The run of items can hold theme blocks between them (a partners section, an ad): headings in it are the theme's, not the page's.
  if (articles.length > 1) return { innerStart: articles[0]!.start, innerEnd: articles[articles.length - 1]!.end, listing: true };
  return null;
}

/**
 * No landmarks: the first <h1> before the boundary that is not inside a <header>, <nav> or <aside>, else the first
 * such <h2>. Copy goes immediately before that heading ("before") or immediately before the boundary ("after").
 */
function findHeadingAnchor(html: string, boundary: number): { before: number; after: number } | null {
  const chrome: Array<[number, number]> = [];
  for (const tag of ["header", "nav", "aside"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    for (let m = re.exec(html); m && m.index < boundary; m = re.exec(html)) {
      const range = elementEnd(html, m.index, tag);
      if (range) chrome.push([m.index, range.innerEnd]);
    }
  }
  for (const level of ["h1", "h2"]) {
    const re = new RegExp(`<${level}\\b[^>]*>`, "gi");
    for (let m = re.exec(html); m && m.index < boundary; m = re.exec(html)) {
      if (!chrome.some(([s, e]) => m!.index > s && m!.index < e)) return { before: m.index, after: boundary };
    }
  }
  return null;
}

const NO_AREA = "Could not find the page's content area on the live page (no entry-content, <main>, role=main or single article, and no usable heading before the footer). Set contentSelector to say where the copy goes.";

// The head: from <head> to </head> (or to <body> when the close tag is missing). Title and meta rewrites stay inside
// it, so an SVG <title> or a stray meta in the body is never touched.
function headRange(html: string): { start: number; end: number } | null {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const rest = html.slice(start);
  const close = /<\/head\s*>|<body\b/i.exec(rest);
  return { start, end: close ? start + close.index : html.length };
}

function inHead(html: string, edit: (head: string) => string): string {
  const r = headRange(html);
  return r ? `${html.slice(0, r.start)}${edit(html.slice(r.start, r.end))}${html.slice(r.end)}` : html;
}

// One tag per key: drop every existing <meta name|property="key"> in the head (themes and SEO plugins often print two
// or three) and put a single new one where the first was, or at the top of the head. Matches either attribute, since
// sites write og:* and twitter:* with both.
function setMeta(html: string, attr: "name" | "property", key: string, value: string): string {
  const tag = `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*["']${k}["'][^>]*>`, "gi");
  return inHead(html, (head) => {
    let placed = false;
    const out = head.replace(re, () => (placed ? "" : ((placed = true), tag)));
    return placed ? out : `${tag}${out}`;
  });
}

function setTitle(html: string, value: string): string {
  const tag = `<title>${escapeHtml(value)}</title>`;
  return inHead(html, (head) => {
    let placed = false;
    const out = head.replace(/<title\b[\s\S]*?<\/title\s*>/gi, () => (placed ? "" : ((placed = true), tag)));
    return placed ? out : `${tag}${out}`;
  });
}

export interface PreviewResult {
  html: string;
  applied: string[];
  notes: string[];
}

export function buildPreviewHtml(live: string, pageUrl: string, changes: PreviewChanges, opts: { token: string; clientName?: string | null }): PreviewResult {
  const applied: string[] = [];
  const notes: string[] = [];
  let html = live.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "");
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  if (!/<head\b/i.test(html)) html = `<head></head>${html}`;
  html = html.replace(/<base\b[^>]*>/gi, "").replace(/<head\b[^>]*>/i, (h) => `${h}<base href="${escapeHtml(pageUrl)}">`);
  html = html.replace(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/gi, "").replace(/<head\b[^>]*>/i, (h) => `${h}<meta name="robots" content="noindex,nofollow">`);
  html = html.replace(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/gi, "");

  if (changes.title) {
    html = setTitle(html, changes.title);
    html = setMeta(html, "property", "og:title", changes.title);
    html = setMeta(html, "name", "twitter:title", changes.title);
    applied.push("title");
  }
  if (changes.metaDescription) {
    html = setMeta(html, "name", "description", changes.metaDescription);
    html = setMeta(html, "property", "og:description", changes.metaDescription);
    html = setMeta(html, "name", "twitter:description", changes.metaDescription);
    applied.push("metaDescription");
  }
  // The page's heading: replace an H1 that sits inside the content area (the page's own title). An H1 outside it
  // belongs to the theme (a header or footer heading shared by every page): never overwrite that; the new heading
  // goes at the top of the content instead and the theme's stays as it is.
  let headingHtml = "";
  if (changes.h1) {
    const area = findContentArea(html, contentBoundary(html), changes.contentSelector);
    let replaced = false;
    if (area && !area.listing) {
      // A commented-out <h1> is not the page's heading: blank comments out (same length, so offsets hold).
      const inner = html.slice(area.innerStart, area.innerEnd).replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
      const h = /(<h1\b[^>]*>)[\s\S]*?(<\/h1\s*>)/i.exec(inner);
      if (h) {
        const at = area.innerStart + h.index;
        html = `${html.slice(0, at)}${h[1]}${escapeHtml(changes.h1)}${h[2]}${html.slice(at + h[0].length)}`;
        replaced = true;
      }
    }
    if (replaced) applied.push("h1");
    else {
      headingHtml = `<h1>${escapeHtml(changes.h1)}</h1>`;
      notes.push(
        /<h1\b/i.test(html)
          ? "The live page's existing H1 is part of the theme (outside the page content), so it was left as it is and the new heading was added at the top of the content. Style it in bodyHtml if it needs to match."
          : "The live page has no H1, so the new heading was added at the top of the content.",
      );
    }
  }
  if (headingHtml && changes.bodyHtml && /<h1\b/i.test(changes.bodyHtml)) {
    headingHtml = "";
    notes.push("bodyHtml already has its own H1, so the h1 field was not added a second time.");
    applied.push("h1");
  }
  if (changes.bodyHtml || headingHtml) {
    const body = `${headingHtml}${changes.bodyHtml ? sanitizeBody(changes.bodyHtml) : ""}`;
    const mode: BodyMode = changes.bodyHtml ? changes.bodyMode ?? "before" : "before";
    const boundary = contentBoundary(html);
    const area = findContentArea(html, boundary, changes.contentSelector);
    const anchor = area ? null : findHeadingAnchor(html, boundary);
    if (!area && !anchor) throw new SeoError(NO_AREA);
    if (!area && mode === "replace" && changes.bodyHtml) {
      throw new SeoError("bodyMode replace needs a known content area, and this page has none (no entry-content, <main>, role=main or single article). Use before or after, or set contentSelector.");
    }
    const at = area
      ? mode === "replace" ? [area.innerStart, area.innerEnd] : mode === "after" ? [area.innerEnd, area.innerEnd] : [area.innerStart, area.innerStart]
      : mode === "after" ? [anchor!.after, anchor!.after] : [anchor!.before, anchor!.before];
    html = `${html.slice(0, at[0])}${body}${html.slice(at[1])}`;
    if (changes.bodyHtml) applied.push("bodyHtml");
    if (headingHtml) applied.push("h1");
    if (area && mode === "replace" && changes.bodyHtml) notes.push("The page's whole content area was replaced.");
    if (!area) notes.push("No content area was found on the live page, so the copy was placed relative to the page's first heading.");
  }

  // WooCommerce product tabs: its script shows the first panel and hides the rest. A page built from the source has
  // no script left, so every panel would be open at once (PAR-9945); this keeps the visitor's view. A rendered page
  // already carries display:none on the hidden panels, so the rule changes nothing there.
  if (/\bwc-tabs-wrapper\b/.test(html) && /\bwc-tab\b/.test(html)) {
    html = html.replace(/<\/head\s*>/i, `<style id="pib-wc-tabs">.wc-tabs-wrapper .wc-tab ~ .wc-tab{display:none}</style></head>`);
  }
  if (hasVolatileProductStrip(html)) {
    notes.push("The page has a WooCommerce related, upsell or cross-sell products strip: the shop picks its products at random on every load, so other products in the live screenshot are not a change. The kept-text figure counts only the strip's heading.");
  }

  if (changes.css) {
    html = html.replace(/<\/head\s*>/i, `<style id="pib-redesign-css">${sanitizeCss(changes.css)}</style></head>`);
    applied.push("css");
  }

  const slug = previewSlug(pageUrl);
  const decisionUrl = `${PREVIEW_BASE}/p/${slug}/${escapeHtml(opts.token)}/decision`;
  const banner =
    `<div id="pib-preview-bar" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111827;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;box-shadow:0 -2px 12px rgba(0,0,0,.3)">` +
    `<span><strong>Proposed changes, not live.</strong> ${opts.clientName ? `For ${escapeHtml(opts.clientName)}. ` : ""}Nothing here is on the website yet.</span>` +
    `<form method="post" action="${escapeHtml(decisionUrl)}" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0">` +
    `<input name="note" placeholder="Comment (optional)" maxlength="1000" style="padding:6px 8px;border-radius:6px;border:0;min-width:200px;font:inherit">` +
    `<button name="decision" value="approved" style="background:#16a34a;color:#fff;border:0;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer">Approve</button>` +
    `<button name="decision" value="changes_requested" style="background:#f59e0b;color:#111;border:0;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer">Request changes</button>` +
    `</form></div><div style="height:64px"></div>`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${banner}</body>`) : `${html}${banner}`;
  return { html, applied, notes };
}

/** The page the client sees after answering. */
export function thanksHtml(decision: "approved" | "changes_requested"): string {
  const text = decision === "approved" ? "Thank you. We have your approval and will make the change." : "Thank you. We have your comments and will send an updated version.";
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title><body style="font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center"><p>${text}</p></body>`;
}

/** What a visitor sees of a page's head and heading: compared later to tell whether the live page moved since a preview was made (PAR-9006). */
export interface LiveFingerprint {
  title: string;
  metaDescription: string;
  h1: string;
  words: number | null;
  /** How `words` was counted (WORD_COUNTER); a count made another way is not compared. Missing on rows before PAR-9945. */
  counter?: number;
}

/** Bump when visibleWords changes how it counts, so stored fingerprints are not flagged as a changed page. 2 = PAR-9945. */
export const WORD_COUNTER = 2;

const decodeText = (v: string) => v.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Title, meta description, first H1 and the visible word count of a page's html. A listing page (two or more <article> items) skips the count: its items change all the time. */
export function liveFingerprint(html: string, opts: { skipWords?: boolean } = {}): LiveFingerprint {
  const skipWords = opts.skipWords ?? (html.match(/<article\b/gi) ?? []).length > 1;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "";
  let meta = "";
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']description["']/i.test(m[0])) continue;
    meta = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0])?.slice(1, 3).find((x) => x !== undefined) ?? "";
    break;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ?? "";
  return { title: decodeText(title), metaDescription: decodeText(meta), h1: decodeText(h1), words: skipWords ? null : visibleWords(html).length, counter: WORD_COUNTER };
}

/** Fields that differ between the stored and the current fingerprint (words only when both counted them the same way). */
export function fingerprintChanges(stored: LiveFingerprint, now: LiveFingerprint): string[] {
  const out: string[] = [];
  for (const k of ["title", "metaDescription", "h1"] as const) if (stored[k] !== now[k]) out.push(k);
  if (stored.words != null && now.words != null && stored.counter === now.counter && stored.words !== now.words) out.push("words");
  return out;
}
