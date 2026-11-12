/**
 * Read a brand from a website: the colours, fonts, logo and the words the site uses for itself. A program reads the
 * page and its stylesheets; nothing is rendered. The result is a proposal: `colors` is ranked with the evidence for
 * each, so an agent (or a person) can check the picks against the page before they go into a brand kit.
 *
 * `parseBrandHtml` and `parseBrandCss` are pure (tested without a network). `extractBrandFromSite` fetches through
 * the host's guarded `ctx.http.fetch` (kit `safeFetch`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { safeFetch } from "./safe-fetch.js";

export interface BrandColor {
  /** `#rrggbb`, lower case. */
  hex: string;
  /** Higher is stronger evidence that this is a brand colour. */
  score: number;
  /** Where it was seen, most telling first: `theme-color`, `var --primary`, `used 14 times`. */
  evidence: string[];
  role?: "primary" | "secondary" | "accent";
}

export interface BrandFindings {
  /** The address that answered, after redirects. */
  url: string;
  siteName: string | null;
  /** The page title and descriptions, and the main headings: what the site says about itself, for the voice. */
  title: string | null;
  description: string | null;
  headings: string[];
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  /** Every brand-like colour found, strongest first (12 at most). */
  colors: BrandColor[];
  /** Font families, headings first (6 at most). */
  fonts: string[];
  /** The best logo address, and the other candidates in order. */
  logoUrl: string | null;
  logoCandidates: string[];
  /** What could not be read, in plain words. */
  notes: string[];
}

const MAX_STYLESHEETS = 6;
/** Below this score a colour is not picked for a role on frequency alone. */
export const MIN_PICK_SCORE = 10;
const MAX_CSS_CHARS = 700_000;

// ── colours ─────────────────────────────────────────────────────────────────

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** Any CSS colour literal we read (hex 3/4/6/8, rgb(a), hsl(a)) as `#rrggbb`; null when it is not one or is see-through. */
export function toHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === "0") return null;
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    if (h.length === 6) return `#${h}`;
    if (h.length === 8) return h.slice(6) === "00" ? null : `#${h.slice(0, 6)}`;
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return `#${hex2(+m[1]!)}${hex2(+m[2]!)}${hex2(+m[3]!)}`;
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const h = (+m[1]! % 360) / 360;
    const s = +m[2]! / 100;
    const l = +m[3]! / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
      const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return `#${hex2(channel(h + 1 / 3) * 255)}${hex2(channel(h) * 255)}${hex2(channel(h - 1 / 3) * 255)}`;
  }
  return null;
}

/** Hue (0-360), saturation and lightness (0-1) of `#rrggbb`. */
export function hsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** White, black and greys: a page's paper and ink, not its brand. */
export function isNeutral(hex: string): boolean {
  const { s, l } = hsl(hex);
  return s < 0.12 || l > 0.95 || l < 0.06;
}

function distinct(a: string, b: string): boolean {
  const x = hsl(a);
  const y = hsl(b);
  const hue = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return hue > 18 || Math.abs(x.l - y.l) > 0.18 || Math.abs(x.s - y.s) > 0.3;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{5,40}\)|hsla?\([^)]{5,40}\)/g;
/** Presets that ship with a framework or a page builder: on every site that uses it, so never this site's brand. */
const STOCK_VAR = /(--wp--preset--color--(black|white|cyan-bluish-gray|pale-pink|vivid-red|luminous-vivid-orange|luminous-vivid-amber|light-green-cyan|vivid-green-cyan|pale-cyan-blue|vivid-cyan-blue|vivid-purple)|--wp-admin-|--wp-components-|--wp-block-|--bs-(blue|indigo|purple|pink|red|orange|yellow|green|teal|cyan|gray|white|black|light|dark|primary|secondary)\b|--tw-|--swiper-|--fa-|--woocommerce)/i;
/** Default colours of common themes and builders (Divi, the WordPress admin, Bootstrap, Elementor): a hit is weak evidence. */
const STOCK_HEX = new Set(["#2ea3f2", "#007cba", "#0073aa", "#006ba1", "#005a87", "#0d6efd", "#007bff", "#6c757d", "#6ec1e4", "#61ce70", "#54595f", "#7a7a7a", "#96588a", "#7f54b3", "#a46497"]);
const ROLE_VAR: Array<[BrandColor["role"], RegExp]> = [
  ["primary", /(^|-)(primary|brand|main|theme)(-|$)/i],
  ["secondary", /(^|-)secondary(-|$)/i],
  ["accent", /(^|-)(accent|highlight|cta)(-|$)/i],
];

export interface CssBrand {
  /** hex → count of uses in declarations. */
  uses: Map<string, number>;
  /** Colours set on a custom property whose name says what it is for. */
  roleVars: Array<{ hex: string; name: string; role: NonNullable<BrandColor["role"]> }>;
  headingFonts: string[];
  bodyFonts: string[];
  faceFonts: string[];
}

const GENERIC_FONT = /^(.* fallback|inherit|initial|unset|revert|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|-apple-system|blinkmacsystemfont|segoe ui( emoji| symbol)?|apple color emoji|noto color emoji|helvetica( neue)?|arial|verdana|tahoma|trebuchet ms|times( new roman)?|georgia|courier( new)?|menlo|monaco|consolas|liberation (sans|mono|serif)|lucida (grande|console|sans unicode)|dejavu sans( mono)?|ubuntu|cantarell|oxygen(-sans)?|fira sans|droid sans|sf pro (text|display)|var\(.*)$/i;
const ICON_FONT = /(icon|awesome|glyph|dashicons|eicons|swiper|fontello|icomoon|material symbols|star|woocommerce|slick|genericons|ionicons|flexslider|revicons|elementskit|themify|linearicons|et-line|etmodules|socicon|videojs|photoswipe|emoji)/i;

function families(value: string): string[] {
  return value
    .replace(/!important/gi, "")
    .split(",")
    .map((f) => f.replace(/["']/g, "").trim())
    .filter((f) => f && f.length <= 60 && /^[\p{L}\p{N} ._-]+$/u.test(f) && !GENERIC_FONT.test(f) && !ICON_FONT.test(f));
}

/** Colours and fonts from stylesheet text. */
export function parseBrandCss(css: string): CssBrand {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: CssBrand = { uses: new Map(), roleVars: [], headingFonts: [], bodyFonts: [], faceFonts: [] };
  // Custom properties that name a role.
  for (const m of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)[;}]/g)) {
    const name = m[1]!;
    if (STOCK_VAR.test(name)) continue;
    const hex = toHex(m[2]!.trim());
    if (!hex) continue;
    const role = ROLE_VAR.find(([, re]) => re.test(name.replace(/^--/, "")))?.[0];
    if (role) out.roleVars.push({ hex, name, role });
  }
  // Every colour in a declaration that paints something.
  for (const m of text.matchAll(/(?:^|[;{\s])(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|fill|stroke|outline-color)\s*:\s*([^;}{]+)/g)) {
    for (const lit of m[2]!.match(COLOR_LITERAL) ?? []) {
      const hex = toHex(lit);
      if (hex) out.uses.set(hex, (out.uses.get(hex) ?? 0) + 1);
    }
  }
  for (const m of text.matchAll(/@font-face\s*{[^}]*?font-family\s*:\s*([^;}]+)/gi)) out.faceFonts.push(...families(m[1]!));
  for (const m of text.matchAll(/([^{}]{1,300}){([^{}]*?font-family\s*:\s*([^;}]+)[^{}]*)}/g)) {
    const selector = m[1]!.trim();
    const fams = families(m[3]!);
    if (!fams.length) continue;
    if (/(^|[\s,>+~])(h[1-3]|\.?(heading|title|display|headline)[\w-]*)(?=$|[\s,:.>+~])/i.test(selector)) out.headingFonts.push(fams[0]!);
    else if (/(^|[\s,])(body|html|:root|p)(?=$|[\s,:.])/i.test(selector)) out.bodyFonts.push(fams[0]!);
  }
  return out;
}

// ── html ────────────────────────────────────────────────────────────────────

const decode = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(+n));
const strip = (s: string): string => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode((m[1] ?? m[2] ?? m[3] ?? "").trim()) : null;
}

function resolve(href: string | null, base: string): string | null {
  if (!href || /^(data|javascript|blob):/i.test(href)) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface HtmlBrand {
  siteName: string | null;
  title: string | null;
  description: string | null;
  headings: string[];
  themeColor: string | null;
  /** The page's own `<style>` blocks, then its `style="…"` attributes as rules (page builders put brand colours there). */
  inlineCss: string;
  stylesheets: string[];
  googleFonts: string[];
  logoCandidates: string[];
}

/** What the page itself says: names, headings, theme colour, stylesheets, font links and logo candidates (best first). */
export function parseBrandHtml(html: string, baseUrl: string): HtmlBrand {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (key: string): string | null => {
    for (const tag of metas) {
      const name = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
      if (name === key) return attr(tag, "content");
    }
    return null;
  };
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const stylesheets: string[] = [];
  const googleFonts: string[] = [];
  const icons: Array<{ url: string; size: number; apple: boolean }> = [];
  for (const tag of links) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = resolve(attr(tag, "href"), baseUrl);
    if (!href) continue;
    if (/fonts\.googleapis\.com\/css/i.test(href)) {
      for (const fam of new URL(href).searchParams.getAll("family")) {
        for (const one of fam.split("|")) {
          const name = one.split(":")[0]!.replace(/\+/g, " ").trim();
          if (name && !ICON_FONT.test(name)) googleFonts.push(name);
        }
      }
      continue;
    }
    if (rel.split(/\s+/).includes("stylesheet")) stylesheets.push(href);
    if (/(^|\s)(apple-touch-icon|icon|shortcut icon)(\s|$)/.test(rel)) {
      const size = Math.max(0, ...(attr(tag, "sizes") ?? "").split(/\s+/).map((s) => parseInt(s, 10) || 0));
      icons.push({ url: href, size, apple: rel.includes("apple") });
    }
  }
  const logos: string[] = [];
  // 1. What the site declares as its logo (schema.org).
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found = /"logo"\s*:\s*(?:"([^"]+)"|{[^}]*?"url"\s*:\s*"([^"]+)")/.exec(m[1]!);
    const url = resolve(found ? (found[1] ?? found[2] ?? "").replace(/\\\//g, "/") : null, baseUrl);
    if (url) logos.push(url);
  }
  // 2. An image the markup calls a logo (the header's comes first in the page).
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hay = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`;
    if (!/logo/i.test(hay)) continue;
    const url = resolve(attr(tag, "src") ?? attr(tag, "data-src"), baseUrl);
    if (url) logos.push(url);
    if (logos.length >= 4) break;
  }
  // 3. Icons, largest first; 4. the share image (often a photo, so last).
  icons.sort((a, b) => Number(b.apple) - Number(a.apple) || b.size - a.size);
  logos.push(...icons.map((i) => i.url));
  const og = resolve(meta("og:image"), baseUrl);
  if (og) logos.push(og);

  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  const styleAttrs = [...html.matchAll(/\sstyle\s*=\s*"([^"]{4,600})"/gi)].slice(0, 400).map((m) => `x{${decode(m[1]!)}}`);
  const inlineCss = [...styleBlocks, ...styleAttrs].join("\n");
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const headings = [...body.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => strip(m[2]!)).filter((t) => t.length > 2 && t.length < 200);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    siteName: meta("og:site_name") ?? meta("application-name"),
    title: title ? strip(title[1]!) || null : null,
    description: meta("description") ?? meta("og:description"),
    headings: [...new Set(headings)].slice(0, 8),
    themeColor: toHex(meta("theme-color") ?? "") ?? toHex(meta("msapplication-tilecolor") ?? ""),
    inlineCss,
    stylesheets: [...new Set(stylesheets)],
    googleFonts: [...new Set(googleFonts)],
    logoCandidates: [...new Set(logos)].slice(0, 8),
  };
}

// ── putting it together ─────────────────────────────────────────────────────

function uniqueFonts(lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const font of list) {
      const key = font.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(font);
    }
  }
  return out.slice(0, 6);
}

/** Rank the colours and pick primary, secondary and accent. Pure: `page` and the stylesheet texts in, findings out. */
export function brandFromParts(url: string, page: HtmlBrand, cssTexts: string[], notes: string[] = []): BrandFindings {
  const css = parseBrandCss([page.inlineCss, ...cssTexts].join("\n"));
  const byHex = new Map<string, BrandColor>();
  const add = (hex: string, score: number, evidence: string, role?: BrandColor["role"]) => {
    if (isNeutral(hex)) return;
    const known = byHex.get(hex) ?? { hex, score: 0, evidence: [] };
    known.score += score;
    if (!known.evidence.includes(evidence)) known.evidence.push(evidence);
    if (role && !known.role) known.role = role;
    byHex.set(hex, known);
  };
  if (page.themeColor) add(page.themeColor, 40, "theme-color");
  for (const v of css.roleVars) add(v.hex, v.role === "primary" ? 45 : 30, `var ${v.name}`, v.role);
  for (const [hex, n] of css.uses) add(hex, Math.min(35, Math.round(Math.log2(n + 1) * 7)), `used ${n} time${n === 1 ? "" : "s"}`);
  for (const c of byHex.values()) {
    if (!STOCK_HEX.has(c.hex) || c.role) continue;
    c.score = Math.round(c.score / 4);
    c.evidence.push("a theme's default colour");
  }
  const colors = [...byHex.values()].sort((a, b) => b.score - a.score).slice(0, 12);

  const taken: string[] = [];
  // A colour seen once or twice with no name is a guess: it stays in `colors` for a person or agent to judge.
  const pick = (role: NonNullable<BrandColor["role"]>): string | null => {
    const named = colors.find((c) => c.role === role && !taken.includes(c.hex));
    const choice = named ?? colors.find((c) => c.score >= MIN_PICK_SCORE && !taken.includes(c.hex) && taken.every((t) => distinct(t, c.hex)));
    if (!choice) return null;
    taken.push(choice.hex);
    return choice.hex;
  };
  const primaryColor = pick("primary");
  const secondaryColor = pick("secondary");
  const accentColor = pick("accent");
  if (!colors.length) notes.push("No brand colour was found in the page or its stylesheets (the site may set colours in scripts or images). Read them from a screenshot.");
  const fonts = uniqueFonts([css.headingFonts, page.googleFonts, css.bodyFonts, css.faceFonts]);
  if (!fonts.length) notes.push("No web font was found: the site uses system fonts, or loads fonts from a script.");
  if (!page.logoCandidates.length) notes.push("No logo was found in the page.");
  return {
    url,
    siteName: page.siteName,
    title: page.title,
    description: page.description,
    headings: page.headings,
    primaryColor,
    secondaryColor,
    accentColor,
    colors,
    fonts,
    logoUrl: page.logoCandidates[0] ?? null,
    logoCandidates: page.logoCandidates,
    notes,
  };
}

export class BrandExtractError extends Error {}

/** Fetch the page and up to six of its stylesheets, and read the brand from them. Throws `BrandExtractError` when the page does not answer. */
export async function extractBrandFromSite(ctx: PluginContext, siteUrl: string): Promise<BrandFindings> {
  let page;
  try {
    page = await safeFetch(ctx, siteUrl, { headers: { Accept: "text/html,*/*" }, maxChars: 1_500_000 });
  } catch (error) {
    throw new BrandExtractError(`${siteUrl} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (page.status >= 400) throw new BrandExtractError(`${siteUrl} answered ${page.status}. Check the address, or read the brand from a screenshot.`);
  const html = parseBrandHtml(page.text, page.url);
  const notes: string[] = [];
  const cssTexts: string[] = [];
  let budget = MAX_CSS_CHARS;
  for (const sheet of html.stylesheets.slice(0, MAX_STYLESHEETS)) {
    if (budget <= 0) break;
    try {
      const res = await safeFetch(ctx, sheet, { headers: { Accept: "text/css,*/*" }, maxChars: budget });
      if (res.status < 400) {
        cssTexts.push(res.text);
        budget -= res.text.length;
      }
    } catch {
      notes.push(`A stylesheet could not be read: ${sheet.slice(0, 120)}`);
    }
  }
  if (html.stylesheets.length > MAX_STYLESHEETS) notes.push(`Only the first ${MAX_STYLESHEETS} of ${html.stylesheets.length} stylesheets were read.`);
  return brandFromParts(page.url, html, cssTexts, notes);
}
