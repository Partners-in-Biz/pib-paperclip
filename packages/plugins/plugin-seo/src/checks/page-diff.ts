/**
 * The diff gate: what a rewritten page lost. Pure functions over two HTML strings (the live page and the changed
 * version). An agent that edits a page can drop a ranking table, a form or the schema without any error, so before
 * a change goes to review the plugin lists every element the old page had and the new one does not.
 *
 * Elements are compared by their content, not by position: a table is its first cells, a list its first items,
 * an image its file, a link its address, a block of structured data its type. Wording changes inside a paragraph are not
 * elements and are never reported.
 */
import { decodeEntities, extractMeta, findTags, jsonLdNodes } from "./parse.js";

export type ElementKind = "heading" | "table" | "list" | "image" | "form" | "embed" | "internal-link" | "schema" | "title" | "meta-description";

export interface PageElement {
  kind: ElementKind;
  /** What identifies the element: stable between two versions of the same page. */
  key: string;
  /** Short readable form for the list shown to a person. */
  label: string;
}

const collapse = (value: string): string => decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (value: string, max = 60): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const norm = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
}

function blocks(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]!);
}

function internalHref(href: string, baseUrl: string): string | null {
  const value = href.trim();
  if (!value || value.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(value)) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${path}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

function imageFile(src: string): string {
  const clean = src.split(/[?#]/)[0] ?? src;
  return (clean.split("/").pop() ?? clean).toLowerCase();
}

/** Every element of the page that a rewrite could silently drop. */
export function pageElements(html: string, baseUrl: string): PageElement[] {
  const page = stripNoise(html);
  const body = page.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? page;
  const out: PageElement[] = [];
  const seen = new Set<string>();
  const add = (element: PageElement): void => {
    const id = `${element.kind}|${element.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(element);
  };

  const meta = extractMeta(html);
  if (meta.title) add({ kind: "title", key: norm(meta.title), label: `Title: ${clip(meta.title)}` });
  if (meta.description) add({ kind: "meta-description", key: norm(meta.description), label: `Meta description: ${clip(meta.description)}` });

  for (const level of ["h1", "h2", "h3"]) {
    for (const inner of blocks(body, level)) {
      const text = collapse(inner);
      if (text) add({ kind: "heading", key: norm(text), label: `${level.toUpperCase()}: ${clip(text)}` });
    }
  }

  for (const table of blocks(body, "table")) {
    const rows = blocks(table, "tr");
    const cells = rows.map((row) => collapse(row)).filter(Boolean);
    const head = cells[0] ?? "";
    if (!head) continue;
    add({ kind: "table", key: norm(head), label: `Table (${rows.length} ${rows.length === 1 ? "row" : "rows"}) starting "${clip(head, 50)}"` });
    // Each row is its own element: a table that lost three of ten rows is reported as three lost rows.
    for (const row of cells.slice(1)) add({ kind: "table", key: `row:${norm(row)}`, label: `Table row: ${clip(row, 60)}` });
  }

  for (const tag of ["ul", "ol"]) {
    for (const list of blocks(body, tag)) {
      const items = blocks(list, "li").map(collapse).filter(Boolean);
      if (items.length < 3) continue;
      add({ kind: "list", key: norm(items[0]!), label: `List (${items.length} items) starting "${clip(items[0]!, 50)}"` });
    }
  }

  for (const img of findTags(body, "img")) {
    const src = img.src ?? img["data-src"] ?? "";
    if (!src || src.startsWith("data:")) continue;
    add({ kind: "image", key: imageFile(src), label: `Image: ${imageFile(src)}` });
  }

  for (const form of findTags(body, "form")) {
    const action = form.action ?? "";
    add({ kind: "form", key: norm(`${form.id ?? ""} ${form.name ?? ""} ${action}`) || "form", label: `Form${action ? ` posting to ${clip(action, 50)}` : ""}` });
  }

  for (const tag of ["iframe", "video", "audio", "embed", "object"]) {
    for (const el of findTags(body, tag)) {
      const src = el.src ?? el.data ?? "";
      add({ kind: "embed", key: `${tag}:${src.split(/[?#]/)[0]}`, label: `${tag}${src ? `: ${clip(src, 60)}` : ""}` });
    }
  }

  for (const a of findTags(body, "a")) {
    const path = a.href ? internalHref(a.href, baseUrl) : null;
    if (path) add({ kind: "internal-link", key: path, label: `Link to ${path}` });
  }

  for (const node of jsonLdNodes(html)) {
    const type = node["@type"];
    const types = (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string");
    for (const t of types) add({ kind: "schema", key: t.toLowerCase(), label: `Structured data: ${t}` });
  }

  return out;
}

export interface PageDiff {
  /** In the old page, not in the new one. */
  lost: PageElement[];
  /** In the new page, not in the old one. */
  gained: PageElement[];
  kept: number;
  /** Lost elements counted per kind, for the one-line summary. */
  lostByKind: Record<string, number>;
  words: { before: number; after: number };
}

function wordCount(html: string): number {
  const text = collapse(stripNoise(html).replace(/<head\b[\s\S]*?<\/head>/i, " "));
  return text ? text.split(" ").length : 0;
}

export function diffPages(before: { html: string; url: string }, after: { html: string; url: string }): PageDiff {
  const was = pageElements(before.html, before.url);
  const now = pageElements(after.html, after.url);
  const nowIds = new Set(now.map((e) => `${e.kind}|${e.key}`));
  const wasIds = new Set(was.map((e) => `${e.kind}|${e.key}`));
  const lost = was.filter((e) => !nowIds.has(`${e.kind}|${e.key}`));
  const gained = now.filter((e) => !wasIds.has(`${e.kind}|${e.key}`));
  const lostByKind: Record<string, number> = {};
  for (const e of lost) lostByKind[e.kind] = (lostByKind[e.kind] ?? 0) + 1;
  return { lost, gained, kept: was.length - lost.length, lostByKind, words: { before: wordCount(before.html), after: wordCount(after.html) } };
}

/** One sentence for the issue and the review: what was lost, in plain words. */
export function diffSummary(diff: PageDiff): string {
  if (diff.lost.length === 0) return "Nothing the old page had is missing from the new version.";
  const parts = Object.entries(diff.lostByKind).map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
  return `The new version is missing ${diff.lost.length} ${diff.lost.length === 1 ? "element" : "elements"} the old page had (${parts.join(", ")}). Restore each one, or name it as removed on purpose.`;
}
