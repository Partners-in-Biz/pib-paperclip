/**
 * Read a brand from a website: the colours, fonts, logo and the words the site uses for itself. A program reads the
 * page and its stylesheets; nothing is rendered. The result is a proposal: `colors` is ranked with the evidence for
 * each, so an agent (or a person) can check the picks against the page before they go into a brand kit.
 *
 * How colours are ranked (0.2, after the first real run on 32 sites): a colour counts by how many elements of the
 * page use it, not by how often it stands in a stylesheet. A utility stylesheet (Tailwind) and a theme (WordPress,
 * Wix) carry a whole palette, and most of it paints nothing. So each rule is weighed by the elements its selector
 * matches in the markup, a hover or focus rule counts for little, and a button's background counts extra.
 *
 * `markupUsage`, `parseBrandHtml`, `parseBrandCss` and `brandFromParts` are pure (tested without a network).
 * `extractBrandFromSite` fetches through the host's guarded `ctx.http.fetch` (kit `safeFetch`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { safeFetch } from "./safe-fetch.js";

export interface BrandColor {
  /** `#rrggbb`, lower case. */
  hex: string;
  /** Higher is stronger evidence that this is a brand colour. */
  score: number;
  /** Where it was seen, most telling first: `theme-color`, `var --primary`, `button background`, `on 14 elements`. */
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
  /** The page's own paper and ink (often white and near-black: part of the look, never picked as a brand colour). */
  backgroundColor: string | null;
  textColor: string | null;
  /** Every brand-like colour found, strongest first (12 at most). */
  colors: BrandColor[];
  /** Font families the page uses, headings first (4 at most). */
  fonts: string[];
  /** Families the page loads but no rule that matches the markup uses. */
  fontsDeclared: string[];
  /** The best logo address (a PNG, JPEG or WebP before an SVG or ICO), and the other candidates in order. */
  logoUrl: string | null;
  logoCandidates: string[];
  /** The share image (`og:image`): usually a photo or a banner, so never offered as the logo. */
  shareImage: string | null;
  /** What built the page when it says so (WordPress, Wix, Google Sites…). */
  generator: string | null;
  /** What could not be read, in plain words. */
  notes: string[];
}

const MAX_STYLESHEETS = 6;
const MAX_CSS_CHARS = 700_000;
/** Below this score a colour is not picked for a role on use alone. */
export const MIN_PICK_SCORE = 10;
/** Lighter than this is the page's paper; darker than `INK_LIGHTNESS` counts only where it fills something. */
const PAPER_LIGHTNESS = 0.88;
const INK_LIGHTNESS = 0.17;
/** A second or third colour needs this much: a guess there does more harm than an empty field. */
const MIN_SECOND_SCORE = 30;

// ── colours ─────────────────────────────────────────────────────────────────

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const h = (((hDeg % 360) + 360) % 360) / 360;
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

/** OKLCH (lightness 0-1, chroma, hue in degrees) to sRGB. Out-of-range channels are clipped. */
function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055) * 255;
  return `#${hex2(gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))}${hex2(gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))}${hex2(gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))}`;
}

const NUM = "(-?\\d*\\.?\\d+)";
const RGB_RE = new RegExp(`^rgba?\\(\\s*${NUM}[\\s,]+${NUM}[\\s,]+${NUM}(?:[\\s,/]+${NUM}%?)?\\s*\\)$`);
const HSL_RE = new RegExp(`^hsla?\\(\\s*${NUM}(?:deg)?[\\s,]+${NUM}%[\\s,]+${NUM}%(?:[\\s,/]+${NUM}%?)?\\s*\\)$`);
const HSL_BARE_RE = new RegExp(`^${NUM}(?:deg)?\\s+${NUM}%\\s+${NUM}%$`);
const OKLCH_RE = new RegExp(`^oklch\\(\\s*${NUM}(%?)\\s+${NUM}\\s+${NUM}(?:deg)?(?:\\s*/\\s*${NUM}%?)?\\s*\\)$`);

/**
 * Any CSS colour we read as `#rrggbb`: hex (3, 4, 6, 8), rgb(a), hsl(a), oklch, and a bare `H S% L%` triple (the
 * form some design systems keep in a variable). Null when it is not one, or is fully see-through.
 */
export function toHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  let m: RegExpExecArray | null = /^#([0-9a-f]{3,8})$/.exec(v);
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
  m = RGB_RE.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return `#${hex2(+m[1]!)}${hex2(+m[2]!)}${hex2(+m[3]!)}`;
  }
  m = HSL_RE.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return hslToHex(+m[1]!, +m[2]! / 100, +m[3]! / 100);
  }
  m = HSL_BARE_RE.exec(v);
  if (m) return hslToHex(+m[1]!, +m[2]! / 100, +m[3]! / 100);
  m = OKLCH_RE.exec(v);
  if (m) {
    if (m[5] !== undefined && parseFloat(m[5]) === 0) return null;
    return oklchToHex(m[2] ? +m[1]! / 100 : +m[1]!, +m[3]!, +m[4]!);
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

/** Far enough apart to be a second brand colour: another hue. A darker or lighter shade of a picked colour is not one. */
function distinct(a: string, b: string): boolean {
  const x = hsl(a);
  const y = hsl(b);
  return Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h)) > 25;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\([^()]{5,60}\)/g;
/** Presets that ship with a framework or a page builder: on every site that uses it, so never this site's brand. */
const STOCK_VAR = /(--wp--preset--color--(black|white|cyan-bluish-gray|pale-pink|vivid-red|luminous-vivid-orange|luminous-vivid-amber|light-green-cyan|vivid-green-cyan|pale-cyan-blue|vivid-cyan-blue|vivid-purple)|--wp-admin-|--wp-components-|--wp-block-|--bs-(blue|indigo|purple|pink|red|orange|yellow|green|teal|cyan|gray|white|black|light|dark|primary|secondary)\b|--tw-|--swiper-|--fa-|--woocommerce)/i;
/** Default colours of common themes and builders (Divi, the WordPress admin, Bootstrap, Elementor, Wix): a hit is weak evidence. */
const STOCK_HEX = new Set(["#2ea3f2", "#007cba", "#0073aa", "#006ba1", "#005a87", "#0d6efd", "#007bff", "#6c757d", "#6ec1e4", "#61ce70", "#54595f", "#7a7a7a", "#96588a", "#7f54b3", "#a46497", "#c72c00", "#116dff", "#428bca", "#337ab7", "#974df3", "#7e3bd0", "#06d253", "#25d366"]);
/** A variable that is named after a role but holds its text, background, state or shade (`--primary-foreground`, `--bg-main`, `--accent-hover`, `--primary-700`). */
const NOT_A_ROLE = /(^|-)(bg|background|text|fg|foreground|surface|border|ring|muted|contrast|on|hover|active|focus|pressed|disabled|dark|darker|light|lighter|soft|subtle|tint|shade|alpha|rgb|\d{2,3})(-|$)/i;
const ROLE_VAR: Array<[BrandColor["role"], RegExp]> = [
  ["primary", /(^|-)(primary|brand|main|theme)(-|$)/i],
  ["secondary", /(^|-)secondary(-|$)/i],
  ["accent", /(^|-)(accent|highlight|cta)(-|$)/i],
];

/** How often each class and tag stands in the page's markup: what a stylesheet rule is weighed by. */
export interface MarkupUsage {
  classes: Map<string, number>;
  tags: Map<string, number>;
}

export function markupUsage(html: string): MarkupUsage {
  const classes = new Map<string, number>();
  const tags = new Map<string, number>();
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  for (const m of body.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const token of (m[1] ?? m[2] ?? "").split(/\s+/)) if (token) classes.set(token, (classes.get(token) ?? 0) + 1);
  }
  for (const m of body.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)) {
    const tag = m[1]!.toLowerCase();
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return { classes, tags };
}

const STATE_RE = /:(hover|focus|focus-visible|focus-within|active|visited|disabled|checked|target)\b|::(selection|placeholder)\b/i;
const BUTTON_RE = /(^|[\s>+~,])(button|input)\b|\[type=["']?(submit|button)|\.[\w-]*(btn|button|cta)[\w-]*/i;
const unescapeCss = (s: string): string => s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
const MAX_ELEMENTS = 60;

interface SelectorWeight {
  /** Elements of the page the rule paints (capped). 1 when no markup was given. */
  n: number;
  state: boolean;
  button: boolean;
  link: boolean;
  /** `heading`, `body` or null, for font rules. */
  text: "heading" | "body" | null;
}

/**
 * Weigh one selector list against the markup: the elements all its selectors paint together. Hover and focus
 * selectors count only when the list has no other (then `state` is set and the caller counts them a tenth).
 */
function weigh(selectorList: string, usage: MarkupUsage | undefined): SelectorWeight {
  const best: SelectorWeight = { n: 0, state: false, button: false, link: false, text: null };
  let plain = 0;
  let stateful = 0;
  let top = -1;
  for (const raw of selectorList.split(",")) {
    const selector = raw.trim();
    if (!selector || selector.startsWith("@")) continue;
    const state = STATE_RE.test(selector);
    // The subject: the last compound, with pseudo parts left out.
    const subject = (selector.split(/\s*[>+~]\s*|\s+/).pop() ?? selector).replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "");
    const classNames = [...selector.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[A-Za-z0-9_-])+)/g)].map((m) => unescapeCss(m[1]!));
    const subjectClasses = [...subject.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[A-Za-z0-9_-])+)/g)].map((m) => unescapeCss(m[1]!));
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(subject)?.[0]?.toLowerCase() ?? null;
    let n: number;
    if (!usage) n = 1;
    else if (classNames.some((c) => !usage.classes.has(c))) n = 0;
    else if (subjectClasses.length) n = Math.min(...subjectClasses.map((c) => usage.classes.get(c) ?? 0));
    else if (tag && tag !== "html" && tag !== "body") n = usage.tags.get(tag) ?? 0;
    else n = 1;
    n = Math.min(n, MAX_ELEMENTS);
    const text: SelectorWeight["text"] = /^h[1-3]$/.test(tag ?? "") || subjectClasses.some((c) => /^(heading|title|headline|display)/i.test(c))
      ? "heading"
      : !subjectClasses.length && (tag === "body" || tag === "html" || tag === "p" || /^(:root|\*)$/.test(subject.trim()) || subject.trim() === "")
        ? "body"
        : null;
    if (state) stateful += n;
    else plain += n;
    // What kind of rule it is comes from its most used selector.
    if (n > top) {
      top = n;
      best.button = BUTTON_RE.test(selector);
      best.link = tag === "a";
      best.text = text;
    } else if (n === top && text && !best.text) best.text = text;
  }
  best.state = plain === 0 && stateful > 0;
  best.n = Math.min(best.state ? stateful : plain, MAX_ELEMENTS);
  return best;
}

export interface CssBrand {
  /** hex → the elements that use it (a hover or focus rule counts a tenth). */
  uses: Map<string, number>;
  /** hex → the part of `uses` that fills something (background, border, fill, stroke): a dark colour only counts here, as text it is ink. */
  fills: Map<string, number>;
  /** hex → the buttons whose background it is. */
  buttons: Map<string, number>;
  /** hex → the links whose text colour it is. */
  links: Map<string, number>;
  /** Colours set on a custom property whose name says what it is for. */
  roleVars: Array<{ hex: string; name: string; role: NonNullable<BrandColor["role"]> }>;
  /** The page's own paper and ink, from the body or root rule. */
  background: string | null;
  ink: string | null;
  headingFonts: string[];
  bodyFonts: string[];
  /** Other families a rule that matches the markup uses, most used first. */
  otherFonts: string[];
  /** Families declared with `@font-face`. */
  faceFonts: string[];
}

const GENERIC_FONT = /^(.* fallback|inherit|initial|unset|revert|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|-apple-system|blinkmacsystemfont|segoe ui( emoji| symbol)?|apple color emoji|noto color emoji|helvetica( neue)?|arial|verdana|tahoma|geneva|trebuchet ms|times( new roman)?|georgia|courier( new)?|menlo|monaco|consolas|liberation (sans|mono|serif)|lucida (grande|console|sans unicode)|dejavu sans( mono)?|ubuntu|cantarell|oxygen(-sans)?|fira sans|droid sans|sf pro (text|display)|sfmono-regular|var\(.*)$/i;
const ICON_FONT = /(icon|awesome|glyph|dashicons|eicons|swiper|fontello|icomoon|material symbols|star|woocommerce|slick|genericons|ionicons|flexslider|revicons|elementskit|themify|linearicons|et-line|etmodules|socicon|videojs|photoswipe|emoji)/i;
const WEIGHT_SUFFIX = /[-_ ](thin|hairline|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|bold|extrabold|ultrabold|heavy|black|italic|oblique|condensed|variable|vf)\d*$/i;

/** One family name as a person would write it; null for a generic, an icon font, or a builder's internal id. */
export function cleanFontName(raw: string): string | null {
  let name = raw.replace(/!important/gi, "").replace(/["']/g, "").trim();
  if (!name || name.length > 60 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) return null;
  // Wix and some font services name a face `avenir-lt-w01_35-light1475496`: keep the family part.
  const service = /^(.+?)[-_]w\d\d[-_]/i.exec(name);
  if (service) name = service[1]!;
  for (let i = 0; i < 3 && WEIGHT_SUFFIX.test(name); i += 1) name = name.replace(WEIGHT_SUFFIX, "");
  if (name.replace(/[^\p{L}]/gu, "").length < 3) return null;
  if (/\d{4,}/.test(name) || /(?=[0-9a-f]*\d)[0-9a-f]{8,}/i.test(name)) return null;
  if (GENERIC_FONT.test(name) || ICON_FONT.test(name)) return null;
  // A slug (`din-next`, `poppins`) reads as a name: `DIN Next` is beyond a program, `Din Next` is close enough.
  if (name === name.toLowerCase() && !name.includes(" ")) {
    name = name.split(/[-_]/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
  }
  return name;
}

function families(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const name = cleanFontName(part);
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** Colours and fonts from stylesheet text, weighed by the markup when it is given. */
export function parseBrandCss(css: string, usage?: MarkupUsage): CssBrand {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: CssBrand = { uses: new Map(), fills: new Map(), buttons: new Map(), links: new Map(), roleVars: [], background: null, ink: null, headingFonts: [], bodyFonts: [], otherFonts: [], faceFonts: [] };
  // Custom properties: the first definition wins (the default theme stands before a dark one).
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)[;}]/g)) if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  const resolve = (value: string, depth = 0): string =>
    depth > 4 ? value : value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fallback?: string) => {
      const known = vars.get(name);
      return known !== undefined ? resolve(known, depth + 1) : fallback !== undefined ? resolve(fallback, depth + 1) : "";
    });
  for (const [name, raw] of vars) {
    if (STOCK_VAR.test(name)) continue;
    const bare = name.replace(/^--/, "");
    const role = NOT_A_ROLE.test(bare) ? undefined : ROLE_VAR.find(([, re]) => re.test(bare))?.[0];
    if (!role) continue;
    const hex = toHex(resolve(raw));
    if (hex) out.roleVars.push({ hex, name, role });
  }
  const add = (map: Map<string, number>, hex: string, n: number) => map.set(hex, (map.get(hex) ?? 0) + n);
  const otherFonts = new Map<string, number>();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    const block = m[2]!;
    if (/@font-face/i.test(selector)) {
      const face = /font-family\s*:\s*([^;}]+)/i.exec(block);
      if (face) out.faceFonts.push(...families(face[1]!));
      continue;
    }
    if (selector.startsWith("@") && !selector.includes("{")) continue;
    if (!/(color|background|border|fill|stroke|font-family)/i.test(block)) continue;
    const w = weigh(selector, usage);
    for (const d of block.matchAll(/(?:^|;)\s*(color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|fill|stroke|outline-color|font-family)\s*:\s*([^;]+)/gi)) {
      const prop = d[1]!.toLowerCase();
      const value = resolve(d[2]!);
      if (prop === "font-family") {
        const first = families(value)[0];
        if (!first || w.n === 0) continue;
        if (w.text === "heading") out.headingFonts.push(first);
        else if (w.text === "body") out.bodyFonts.push(first);
        else otherFonts.set(first, (otherFonts.get(first) ?? 0) + w.n);
        continue;
      }
      const background = prop.startsWith("background");
      for (const lit of value.match(COLOR_LITERAL) ?? []) {
        const hex = toHex(lit);
        if (!hex) continue;
        if (w.text === "body" && !w.state && w.n > 0) {
          if (background && !out.background) out.background = hex;
          if (prop === "color" && !out.ink) out.ink = hex;
        }
        if (w.n === 0) {
          if (!out.uses.has(hex)) out.uses.set(hex, 0);
          continue;
        }
        add(out.uses, hex, w.state ? w.n / 10 : w.n);
        if (prop !== "color") add(out.fills, hex, w.state ? w.n / 10 : w.n);
        if (!w.state && w.button && background) add(out.buttons, hex, w.n);
        if (!w.state && w.link && prop === "color") add(out.links, hex, w.n);
      }
    }
  }
  out.otherFonts = [...otherFonts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([name]) => name);
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

function resolveUrl(href: string | null, base: string): string | null {
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
  shareImage: string | null;
  generator: string | null;
  /** A site builder's own page (a Google Sites placeholder): its colours, fonts and logo are the builder's. */
  placeholder: string | null;
  usage: MarkupUsage;
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
    const href = resolveUrl(attr(tag, "href"), baseUrl);
    if (!href) continue;
    if (/fonts\.googleapis\.com\/css/i.test(href)) {
      for (const fam of new URL(href).searchParams.getAll("family")) {
        for (const one of fam.split("|")) {
          const name = cleanFontName(one.split(":")[0]!.replace(/\+/g, " "));
          if (name) googleFonts.push(name);
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
    const url = resolveUrl(found ? (found[1] ?? found[2] ?? "").replace(/\\\//g, "/") : null, baseUrl);
    if (url) logos.push(url);
  }
  // 2. An image the markup calls a logo (the header's comes first in the page).
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hay = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`;
    if (!/logo/i.test(hay)) continue;
    const url = resolveUrl(attr(tag, "src") ?? attr(tag, "data-src"), baseUrl);
    if (url) logos.push(url);
    if (logos.length >= 4) break;
  }
  // 3. Icons, largest first. The share image is never a logo candidate: it is usually a photo.
  icons.sort((a, b) => Number(b.apple) - Number(a.apple) || b.size - a.size);
  logos.push(...icons.map((i) => i.url));

  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  const styleAttrs = [...html.matchAll(/\sstyle\s*=\s*"([^"]{4,600})"/gi)].slice(0, 400).map((m) => `[style]{${decode(m[1]!)}}`);
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const headings = [...body.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => strip(m[2]!)).filter((t) => t.length > 2 && t.length < 200);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const generator = meta("generator");
  const googleSites = /sites\.google\.com|\/_\/atari\/|Google Sites/i.test(`${baseUrl} ${generator ?? ""} ${html.slice(0, 20_000)}`);
  return {
    siteName: meta("og:site_name") ?? meta("application-name"),
    title: title ? strip(title[1]!) || null : null,
    description: meta("description") ?? meta("og:description"),
    headings: [...new Set(headings)].slice(0, 8),
    themeColor: toHex(meta("theme-color") ?? "") ?? toHex(meta("msapplication-tilecolor") ?? ""),
    inlineCss: [...styleBlocks, ...styleAttrs].join("\n"),
    stylesheets: [...new Set(stylesheets)],
    googleFonts: [...new Set(googleFonts)],
    logoCandidates: [...new Set(logos)].slice(0, 8),
    shareImage: resolveUrl(meta("og:image"), baseUrl),
    generator: googleSites ? "Google Sites" : generator,
    placeholder: googleSites ? "Google Sites" : null,
    usage: markupUsage(html),
  };
}

// ── putting it together ─────────────────────────────────────────────────────

function uniqueFonts(lists: string[][], max: number): string[] {
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
  return out.slice(0, max);
}

const RASTER = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const count = (n: number, what: string): string => `on ${Math.round(n)} ${what}${Math.round(n) === 1 ? "" : "s"}`;

/** Rank the colours and pick primary, secondary and accent. Pure: `page` and the stylesheet texts in, findings out. */
export function brandFromParts(url: string, page: HtmlBrand, cssTexts: string[], notes: string[] = []): BrandFindings {
  const base = {
    url,
    siteName: page.siteName,
    title: page.title,
    description: page.description,
    headings: page.headings,
    shareImage: page.shareImage,
    generator: page.generator,
  };
  if (page.placeholder) {
    notes.push(`This is a ${page.placeholder} page: its colours, fonts and logo are the builder's, not this company's. Nothing was read from it.`);
    return { ...base, primaryColor: null, secondaryColor: null, accentColor: null, backgroundColor: null, textColor: null, colors: [], fonts: [], fontsDeclared: [], logoUrl: null, logoCandidates: [], notes };
  }
  const css = parseBrandCss([page.inlineCss, ...cssTexts].join("\n"), page.usage);
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
  for (const [hex, n] of css.buttons) if (n >= 1) add(hex, Math.min(30, 18 + Math.round(Math.log2(n + 1) * 4)), `button background (${count(n, "button")})`);
  for (const [hex, all] of css.uses) {
    const { l } = hsl(hex);
    // A dark colour used for text is the page's ink, and a very light one is its paper: only a dark fill counts.
    const n = l > PAPER_LIGHTNESS ? 0 : l < INK_LIGHTNESS ? (css.fills.get(hex) ?? 0) : all;
    if (n >= 0.5) add(hex, Math.min(35, Math.round(Math.log2(n + 1) * 7)), count(n, "element"));
    else if (byHex.has(hex)) byHex.get(hex)!.evidence.push(all >= 0.5 ? "used as the page's paper or ink" : "no element of this page uses it");
  }
  for (const [hex, n] of css.links) if (n >= 2) add(hex, 8, `link colour (${count(n, "link")})`);
  for (const c of byHex.values()) {
    if (!STOCK_HEX.has(c.hex) || c.role) continue;
    c.score = Math.round(c.score / 4);
    c.evidence.push("a theme's default colour");
  }
  const colors = [...byHex.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);

  const taken: string[] = [];
  // The strongest colour first, then other hues. The page's own paper and ink are never picked, and a colour with
  // little use and no name is a guess: it stays in `colors` for a person or agent to judge.
  // A page built by scripts in the browser has almost no markup: use counts say nothing there, only a named colour does.
  const scripted = [...page.usage.tags.values()].reduce((a, b) => a + b, 0) < 40;
  const pickable = (c: BrandColor, min: number): boolean => {
    const { l } = hsl(c.hex);
    if (STOCK_HEX.has(c.hex) && !c.role) return false;
    if (scripted && !c.role && !c.evidence.includes("theme-color")) return false;
    return c.score >= min && c.hex !== css.background && c.hex !== css.ink && l <= PAPER_LIGHTNESS && !taken.includes(c.hex) && taken.every((t) => distinct(t, c.hex));
  };
  const pick = (): string | null => {
    const choice = colors.find((c) => pickable(c, taken.length ? MIN_SECOND_SCORE : MIN_PICK_SCORE));
    if (!choice) return null;
    taken.push(choice.hex);
    return choice.hex;
  };
  const primaryColor = pick();
  const secondaryColor = primaryColor ? pick() : null;
  const accentColor = secondaryColor ? pick() : null;
  if (!primaryColor) {
    notes.push(scripted
      ? "This page is built by scripts in the browser: its markup does not show which colours it uses. Read them from a screenshot of the live page; `colors` lists what the stylesheet holds."
      : "No brand colour had enough evidence on this page (the site may set colours in scripts or images). Read them from a screenshot; `colors` lists what was seen.");
  }

  const used = uniqueFonts([css.headingFonts, css.bodyFonts, css.otherFonts], 4);
  const declared = uniqueFonts([page.googleFonts, css.faceFonts], 8).filter((f) => !used.some((u) => u.toLowerCase() === f.toLowerCase()));
  // No rule that matches the markup names a font (a page built by scripts): fall back to what it loads.
  const fonts = used.length ? used : declared.slice(0, 3);
  if (!fonts.length) notes.push("No web font was found: the site uses system fonts, or loads fonts from a script.");
  const logoUrl = page.logoCandidates.find((u) => RASTER.test(u)) ?? page.logoCandidates[0] ?? null;
  if (!page.logoCandidates.length) notes.push("No logo was found in the page.");
  else if (logoUrl && !RASTER.test(logoUrl)) notes.push("The only logo on the page is an SVG or ICO file. The media library takes PNG, JPEG, GIF and WebP: ask for a PNG, or convert it.");
  return {
    ...base,
    primaryColor,
    secondaryColor,
    accentColor,
    backgroundColor: css.background,
    textColor: css.ink,
    colors,
    fonts,
    fontsDeclared: used.length ? declared : declared.slice(3),
    logoUrl,
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
  for (const sheet of html.placeholder ? [] : html.stylesheets.slice(0, MAX_STYLESHEETS)) {
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
  if (!html.placeholder && html.stylesheets.length > MAX_STYLESHEETS) notes.push(`Only the first ${MAX_STYLESHEETS} of ${html.stylesheets.length} stylesheets were read.`);
  return brandFromParts(page.url, html, cssTexts, notes);
}
