/**
 * PAR-10302 (PAR-10016 T2): the WordPress body check. The Connector can only change a WordPress post's own content, so a
 * preview whose body or link phrase lives in the theme template could never be applied. The page's public REST link
 * (`<link rel="alternate" type="application/json" href=".../wp-json/wp/v2/<type>/<id>">`) gives `content.rendered`, which is
 * what the Connector edits. T3 reuses `wpPostContent`.
 */
import { bodyInsertAreaHtml, visibleWords, type PreviewChanges } from "../engine/preview.js";
import { SeoError, type Env } from "./common.js";

export const WP_BODY_TIMEOUT_MS = 5000;

export type WpPostContent =
  | { kind: "none" }
  | { kind: "skip"; note: string }
  | { kind: "ok"; id: number; template: string; rendered: string };

const skip = (why: string): WpPostContent => ({ kind: "skip", note: `WordPress body check skipped: ${why}` });
const REST_PATH = /^\/wp-json\/wp\/v2\/[a-z0-9_-]+\/(\d+)\/?$/;

/** Only a body or link edit goes into post content (Q3); title, meta, h1 and css never do. */
export const needsWpBodyCheck = (changes: PreviewChanges): boolean => Boolean(changes.bodyHtml) || Boolean(changes.linkEdits?.length);

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const unescapeAttr = (v: string) => v.replace(/&#0*38;|&#x0*26;|&amp;/gi, "&");

/** The first `<link rel="alternate" type="application/json">` whose path is a WordPress post REST route; null when none. */
export function wpRestLink(pageHtml: string, pageUrl: string): { url: URL; id: number } | null {
  for (const tag of pageHtml.match(/<link\b[^>]*>/gi) ?? []) {
    if (!(attr(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) continue;
    if ((attr(tag, "type") ?? "").trim().toLowerCase() !== "application/json") continue;
    const href = attr(tag, "href");
    if (!href) continue;
    let url: URL;
    try { url = new URL(unescapeAttr(href.trim()), pageUrl); } catch { continue; }
    const m = REST_PATH.exec(url.pathname);
    if (m) return { url, id: Number(m[1]) };
  }
  return null;
}

/** Visible text of an HTML fragment, whitespace-collapsed and lower-cased. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi, (_m, d, x) => { const n = d ? Number(d) : parseInt(x, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " "; })
    .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/** Never throws: any failure to reach or read the REST API is a skip row with a note. */
export async function wpPostContent(env: Env, pageHtml: string, pageUrl: string, timeoutMs = WP_BODY_TIMEOUT_MS): Promise<WpPostContent> {
  const link = wpRestLink(pageHtml, pageUrl);
  if (!link) return { kind: "none" };
  const pageHost = new URL(pageUrl).hostname;
  if (link.url.hostname !== pageHost) return skip("the REST link points to another host.");
  const target = `${link.url.origin}${link.url.pathname}?_fields=id,type,template,content`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      env.site(target, { maxRedirects: 2 }),
      new Promise<null>((done) => { timer = setTimeout(() => done(null), timeoutMs); }),
    ]);
    if (!res) return skip("the REST API did not answer within 5 seconds.");
    if (res.url && new URL(res.url).hostname !== pageHost) return skip("the REST API redirected to another host.");
    if (res.status >= 400) return skip(`the site's REST API answered ${res.status}.`);
    let body: unknown;
    try { body = JSON.parse(res.text); } catch { return skip("the REST API did not answer with JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return skip("the REST API did not answer with JSON.");
    const post = body as { id?: unknown; template?: unknown; content?: { rendered?: unknown; protected?: unknown } | null };
    if (post.id !== link.id) return skip("the REST API returned a different post.");
    if (post.content?.protected === true) return skip("the page is password-protected.");
    if (typeof post.content?.rendered !== "string") return skip("the REST API gave no post content for this page (an archive, or a post type without content).");
    return { kind: "ok", id: link.id, template: typeof post.template === "string" ? post.template : "", rendered: post.content.rendered };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return skip(/redirect/i.test(m) ? "the REST API redirected too many times." : "the REST API could not be reached.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** R1 and R3: throw before anything is stored when the change could never be applied to the post content. */
export function assertWpBodyApplicable(body: WpPostContent, changes: PreviewChanges): void {
  if (body.kind !== "ok") return;
  if (visibleWords(body.rendered).length === 0) {
    const tpl = body.template ? `; its body comes from the theme template ${body.template}` : "";
    throw new SeoError(`This page's body is not in its WordPress content: post ${body.id} has no text in its post content${tpl}. A preview here could never be applied, because the Connector can only change post content. Pick another page, or raise a developer task to change the template.`);
  }
  const text = visibleText(body.rendered);
  for (const edit of changes.linkEdits ?? []) {
    if (!text.includes(edit.text.replace(/\s+/g, " ").trim().toLowerCase())) {
      throw new SeoError(`The link text "${edit.text}" is not in this page's WordPress content (post ${body.id}): it is in text the theme prints, which the Connector cannot change. Pick a phrase from the page's own copy, or another page.`);
    }
  }
}

const NO_CHECK_NOTE = "could not check that the copy lands inside the post content";
const longWords = (html: string): Set<string> => new Set(visibleWords(html).filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 4));
const share = (of: Set<string>, within: Set<string>): number => {
  let n = 0;
  for (const w of of) if (within.has(w)) n++;
  return of.size === 0 ? 0 : n / of.size;
};

/**
 * R2 (PAR-10303): the area the copy would go into must overlap the post content in one direction or the other. Run on
 * the HTML the preview is built from. Returns a note when the check could not run; throws R2 when the area is elsewhere.
 */
export function assertInsertArea(body: WpPostContent, builtFrom: string, changes: PreviewChanges): string | null {
  if (body.kind !== "ok") return null;
  const post = longWords(body.rendered);
  if (post.size < 5) return null;
  const variants: PreviewChanges[] = [];
  if (changes.bodyHtml) variants.push(changes);
  if (changes.linkEdits?.length) variants.push({ ...changes, bodyHtml: undefined });
  let note: string | null = null;
  for (const v of variants) {
    const slice = bodyInsertAreaHtml(builtFrom, v);
    const area = slice === null ? null : longWords(slice);
    if (!area || area.size < 5) { note = `WordPress body check skipped: ${NO_CHECK_NOTE}.`; continue; }
    const a = Math.round(share(area, post) * 100);
    const b = Math.round(share(post, area) * 100);
    if (share(area, post) >= 0.5 || share(post, area) >= 0.15) continue;
    throw new SeoError(`The copy would go into ${changes.contentSelector ?? "the content area found on the page"}, which is outside this page's WordPress content (post ${body.id}): ${a}% of its words are post content, and it holds ${b}% of the post content's words. Applying it could not put the copy there. Set contentSelector to the element that holds the post content (for example .entry-content), or pick another page.`);
  }
  return note;
}
