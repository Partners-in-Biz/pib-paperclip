/**
 * Client preview pages: the live page's HTML with the proposed copy swapped in, a "not live" banner and the
 * client's Approve / Request changes form. Pure string work (no DOM in the worker), deliberately conservative:
 * scripts are removed so the preview is static, and agent-written body HTML is stripped of anything active.
 */

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

/** Visible words of a page: no scripts, styles, tags or the preview's own bar. */
export function visibleWords(html: string): string[] {
  const text = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<div id="pib-preview-bar"[\s\S]*?<\/form><\/div><div style="height:64px"><\/div>/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
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

/** The content area: the entry-content / post-content block, else <main>, else <article>. */
/** Top-level <article> elements in document order (a listing page has one per item). */
function topLevelArticles(html: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /<article\b[^>]*>/gi;
  let from = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index < from) continue;
    const range = elementEnd(html, m.index, "article");
    if (!range) break;
    const close = html.indexOf(">", range.innerEnd);
    out.push({ start: m.index, end: close === -1 ? range.innerEnd : close + 1 });
    from = close === -1 ? range.innerEnd : close + 1;
    re.lastIndex = from;
  }
  return out;
}

/**
 * Where the page's own content is: the entry-content / post-content block, else <main>, else the single <article>.
 * A listing page (category archive, shop) has many <article> items and no such block: the area is the run of items,
 * so copy added "before" lands above the whole listing and "after" below it, never inside the first item.
 */
function findContentArea(html: string): { innerStart: number; innerEnd: number; listing?: boolean } | null {
  const candidates: Array<{ re: RegExp; tag: string }> = [
    { re: /<(div|section)\b[^>]*class\s*=\s*"[^"]*\b(entry-content|post-content|wp-block-post-content)\b[^"]*"[^>]*>/i, tag: "" },
    { re: /<(main)\b[^>]*>/i, tag: "main" },
  ];
  for (const c of candidates) {
    const m = c.re.exec(html);
    if (!m) continue;
    const range = elementEnd(html, m.index, c.tag || m[1]!.toLowerCase());
    if (range) return range;
  }
  const articles = topLevelArticles(html);
  if (articles.length === 1) {
    const only = articles[0]!;
    const range = elementEnd(html, only.start, "article");
    if (range) return range;
  }
  // The run of items can hold theme blocks between them (a partners section, an ad): headings in it are the theme's, not the page's.
  if (articles.length > 1) return { innerStart: articles[0]!.start, innerEnd: articles[articles.length - 1]!.end, listing: true };
  return null;
}

function setMeta(html: string, attr: "name" | "property", key: string, value: string): string {
  const tag = `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*>`, "i");
  return re.test(html) ? html.replace(re, tag) : html.replace(/<head\b[^>]*>/i, (h) => `${h}${tag}`);
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
    const title = `<title>${escapeHtml(changes.title)}</title>`;
    html = /<title\b/i.test(html) ? html.replace(/<title\b[\s\S]*?<\/title\s*>/i, title) : html.replace(/<head\b[^>]*>/i, (h) => `${h}${title}`);
    html = setMeta(html, "property", "og:title", changes.title);
    applied.push("title");
  }
  if (changes.metaDescription) {
    html = setMeta(html, "name", "description", changes.metaDescription);
    html = setMeta(html, "property", "og:description", changes.metaDescription);
    applied.push("metaDescription");
  }
  // The page's heading: replace an H1 that sits inside the content area (the page's own title). An H1 outside it
  // belongs to the theme (a header or footer heading shared by every page): never overwrite that; the new heading
  // goes at the top of the content instead and the theme's stays as it is.
  let headingHtml = "";
  if (changes.h1) {
    const area = findContentArea(html);
    let replaced = false;
    if (area && !area.listing) {
      const inner = html.slice(area.innerStart, area.innerEnd);
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
    const area = findContentArea(html);
    if (area) {
      const at = mode === "replace" ? [area.innerStart, area.innerEnd] : mode === "after" ? [area.innerEnd, area.innerEnd] : [area.innerStart, area.innerStart];
      html = `${html.slice(0, at[0])}${body}${html.slice(at[1])}`;
      if (changes.bodyHtml) applied.push("bodyHtml");
      if (headingHtml) applied.push("h1");
      if (mode === "replace" && changes.bodyHtml) notes.push("The page's whole content area was replaced.");
    } else if (/<\/h1\s*>/i.test(html)) {
      html = html.replace(/<\/h1\s*>/i, (m) => `${m}${body}`);
      if (changes.bodyHtml) applied.push("bodyHtml");
      if (headingHtml) applied.push("h1");
      notes.push("No content area was found on the live page, so the copy was placed after the heading.");
    } else notes.push("Could not find where the copy goes on the live page; it was not shown.");
  }

  if (changes.css) {
    html = html.replace(/<\/head\s*>/i, `<style id="pib-redesign-css">${sanitizeCss(changes.css)}</style></head>`);
    applied.push("css");
  }

  const banner =
    `<div id="pib-preview-bar" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111827;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;box-shadow:0 -2px 12px rgba(0,0,0,.3)">` +
    `<span><strong>Proposed changes, not live.</strong> ${opts.clientName ? `For ${escapeHtml(opts.clientName)}. ` : ""}Nothing here is on the website yet.</span>` +
    `<form method="post" action="/p/${escapeHtml(opts.token)}/decision" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0">` +
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
