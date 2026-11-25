import { z } from "zod";
import { PLANNING_CANVAS_LIMITS, type CanvasShapeVariant, type PlanningCanvasItemInput } from "./types/planning-canvas.js";

/**
 * Planning Canvas import (plan PAR-13925 sections G and L, C9). Turns a small
 * markdown outline or a Mermaid flowchart into `add` items with auto-layout.
 * Pure: the route wraps the result in one atomic ops batch. Anything outside
 * the supported subset throws `PlanningCanvasImportError` with a 1-based line.
 *
 * Markdown: `#`..`######` headings become frames (stacked down the board);
 * `-`, `*`, `+` and `1.` bullets become stickies inside the latest heading's
 * frame. Blank lines are skipped; any other line, or a bullet before the first
 * heading, is an error.
 *
 * Mermaid: `flowchart|graph [TD|TB|LR|RL|BT]`; nodes `A`, `A[t]`, `A(t)`,
 * `A{t}`, `A((t))`; edges `-->`, `---`, `-.->`, `==>` with optional `|label|`,
 * chained (`A --> B --> C`); `subgraph id [title]` ... `end` becomes a frame.
 * `%%` comment lines and `;` line endings are ignored.
 */

export const PLANNING_CANVAS_IMPORT_FORMATS = ["markdown", "mermaid"] as const;
export type PlanningCanvasImportFormat = (typeof PLANNING_CANVAS_IMPORT_FORMATS)[number];

export const planningCanvasImportSchema = z.strictObject({
  format: z.enum(PLANNING_CANVAS_IMPORT_FORMATS),
  source: z.string().min(1).max(100_000),
  /** Top-left of the imported block. */
  at: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
  /** Makes a retry idempotent (same as `clientBatchId` on ops). */
  clientBatchId: z.string().min(1).max(100).optional(),
});
export type PlanningCanvasImportInput = z.infer<typeof planningCanvasImportSchema>;

export class PlanningCanvasImportError extends Error {
  constructor(readonly line: number, readonly reason: string) {
    super(`Line ${line}: ${reason}`);
    this.name = "PlanningCanvasImportError";
  }
}

export interface PlanningCanvasImportOptions {
  at?: { x: number; y: number };
  /** Item key prefix; keys must be unique on a board. */
  keyPrefix?: string;
}

const NODE_W = 200;
const NODE_H = 80;
const GAP_X = 80;
const GAP_Y = 60;
const PAD = 30;
const FRAME_TITLE = 40;
const STICKY_W = 220;
const STICKY_H = 120;
const STICKY_GAP = 20;
const STICKY_COLS = 3;

/** Longest Mermaid node or subgraph id: keeps `imp-xxxxxxxx-sub-<id>-NNN` within the 100-character item key. */
const ID_MAX = 60;
const MAX_ITEMS = PLANNING_CANVAS_LIMITS.opsPerBatchMax;

function countItem(count: number, line: number): number {
  if (count + 1 > MAX_ITEMS) throw new PlanningCanvasImportError(line, `import would create more than ${MAX_ITEMS} items (the per-batch limit); split it`);
  return count + 1;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

function frameItem(key: string, x: number, y: number, width: number, height: number, title: string, zIndex: number): PlanningCanvasItemInput {
  return { itemType: "node", key, kind: "frame", x, y, width, height, zIndex, color: "slate", title: clip(title, 300), content: "" };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.+?)\s*$/;

export function importMarkdownOutline(source: string, options: PlanningCanvasImportOptions = {}): PlanningCanvasItemInput[] {
  const prefix = options.keyPrefix ?? "imp";
  const origin = options.at ?? { x: 0, y: 0 };
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let count = 0;
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    const heading = HEADING.exec(raw);
    if (heading) {
      count = countItem(count, line);
      sections.push({ title: heading[1]!, bullets: [] });
      return;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      const section = sections[sections.length - 1];
      if (!section) throw new PlanningCanvasImportError(line, "bullet before the first heading");
      count = countItem(count, line);
      section.bullets.push(bullet[1]!);
      return;
    }
    throw new PlanningCanvasImportError(line, "only headings and bullets are supported");
  });
  if (sections.length === 0) throw new PlanningCanvasImportError(1, "no heading found");

  const items: PlanningCanvasItemInput[] = [];
  const width = PAD * 2 + STICKY_COLS * STICKY_W + (STICKY_COLS - 1) * STICKY_GAP;
  let y = origin.y;
  sections.forEach((section, s) => {
    const rows = Math.ceil(section.bullets.length / STICKY_COLS);
    const height = FRAME_TITLE + PAD + Math.max(1, rows) * (STICKY_H + STICKY_GAP);
    items.push(frameItem(`${prefix}-h${s + 1}`, origin.x, y, width, height, section.title, 0));
    section.bullets.forEach((text, b) => {
      items.push({
        itemType: "node", key: `${prefix}-h${s + 1}-b${b + 1}`, kind: "sticky",
        x: origin.x + PAD + (b % STICKY_COLS) * (STICKY_W + STICKY_GAP),
        y: y + FRAME_TITLE + Math.floor(b / STICKY_COLS) * (STICKY_H + STICKY_GAP),
        width: STICKY_W, height: STICKY_H, zIndex: 1, color: "yellow", title: clip(text, 300), content: "",
      });
    });
    y += height + GAP_Y;
  });
  return items;
}

// ---------------------------------------------------------------------------
// Mermaid flowchart
// ---------------------------------------------------------------------------

type Direction = "TD" | "TB" | "LR" | "RL" | "BT";
interface MNode { id: string; text: string; shape: "rect" | "round" | "diamond" | "circle"; group: number | null }
interface MEdge { from: string; to: string; label?: string; dashed: boolean }
interface MGroup { id: string; title: string; parent: number | null }

const ID = /[A-Za-z_][A-Za-z0-9_]*/y;
const EDGE = /\s*(-\.->|-->|---|==>)\s*(?:\|([^|]*)\|\s*)?/y;

function unquote(text: string) {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

export function importMermaidFlowchart(source: string, options: PlanningCanvasImportOptions = {}): PlanningCanvasItemInput[] {
  const prefix = options.keyPrefix ?? "imp";
  const origin = options.at ?? { x: 0, y: 0 };
  const lines = source.split(/\r?\n/);
  let direction: Direction | null = null;
  const nodes = new Map<string, MNode>();
  const edges: MEdge[] = [];
  const groups: MGroup[] = [];
  const stack: number[] = [];
  let count = 0;

  const declare = (id: string, text: string | null, shape: MNode["shape"] | null, line: number) => {
    if (id.length > ID_MAX) throw new PlanningCanvasImportError(line, `node id \`${clip(id, 20)}\` is longer than ${ID_MAX} characters`);
    const group = stack.length ? stack[stack.length - 1]! : null;
    const existing = nodes.get(id);
    if (!existing) count = countItem(count, line);
    if (!existing) nodes.set(id, { id, text: text ?? id, shape: shape ?? "rect", group });
    else if (text !== null) { existing.text = text; existing.shape = shape ?? existing.shape; }
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim().replace(/;+$/, "").trim();
    if (text === "" || text.startsWith("%%")) return;
    if (!direction) {
      const header = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?$/.exec(text);
      if (!header) throw new PlanningCanvasImportError(line, "expected `flowchart` or `graph` with TD, TB, LR, RL or BT");
      direction = (header[1] as Direction | undefined) ?? "TD";
      return;
    }
    if (text === "end") {
      if (!stack.length) throw new PlanningCanvasImportError(line, "`end` without `subgraph`");
      stack.pop();
      return;
    }
    const sub = /^subgraph\s+(.+)$/.exec(text);
    if (sub) {
      const withTitle = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[(.*)\]$/.exec(sub[1]!.trim());
      const id = withTitle ? withTitle[1]! : sub[1]!.trim();
      const title = withTitle ? unquote(withTitle[2]!) : unquote(id);
      if (id.length > ID_MAX) throw new PlanningCanvasImportError(line, `subgraph id is longer than ${ID_MAX} characters`);
      count = countItem(count, line);
      groups.push({ id: withTitle ? id : id.replace(/[^A-Za-z0-9_]+/g, "_") || `g${groups.length + 1}`, title, parent: stack.length ? stack[stack.length - 1]! : null });
      stack.push(groups.length - 1);
      return;
    }

    let pos = 0;
    const fail = (reason: string): never => { throw new PlanningCanvasImportError(line, reason); };
    const readNode = (): string => {
      ID.lastIndex = pos;
      const m = ID.exec(text);
      if (!m) return fail(`expected a node id at column ${pos + 1}`);
      pos = ID.lastIndex;
      const rest = text.slice(pos);
      const shapes: Array<[string, string, MNode["shape"]]> = [["((", "))", "circle"], ["[", "]", "rect"], ["(", ")", "round"], ["{", "}", "diamond"]];
      for (const [open, close, shape] of shapes) {
        if (!rest.startsWith(open)) continue;
        const end = rest.indexOf(close, open.length);
        if (end < 0) return fail(`unclosed \`${open}\``);
        const label = unquote(rest.slice(open.length, end));
        if (label === "") return fail("empty node text");
        pos += end + close.length;
        declare(m[0], label, shape, line);
        return m[0];
      }
      declare(m[0], null, null, line);
      return m[0];
    };

    let prev = readNode();
    while (pos < text.length) {
      EDGE.lastIndex = pos;
      const e = EDGE.exec(text);
      if (!e) return fail(`unsupported syntax at column ${pos + 1}`);
      pos = EDGE.lastIndex;
      const next = readNode();
      const label = e[2]?.trim();
      count = countItem(count, line);
      edges.push({ from: prev, to: next, dashed: e[1] === "-.->", ...(label ? { label: clip(label, 120) } : {}) });
      prev = next;
    }
  });
  if (!direction) throw new PlanningCanvasImportError(1, "expected `flowchart` or `graph` header");
  if (stack.length) throw new PlanningCanvasImportError(lines.length, "`subgraph` without `end`");
  if (nodes.size === 0) throw new PlanningCanvasImportError(lines.length, "no nodes");

  // Layers by longest path; edges that close a cycle are ignored for layering.
  const layer = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  const out = new Map<string, string[]>();
  for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const visit = (id: string, depth: number) => {
    if (state.get(id) === 1) return;
    if ((layer.get(id) ?? -1) >= depth && state.get(id) === 2) return;
    layer.set(id, Math.max(layer.get(id) ?? 0, depth));
    state.set(id, 1);
    for (const to of out.get(id) ?? []) visit(to, depth + 1);
    state.set(id, 2);
  };
  const hasIncoming = new Set(edges.filter((e) => e.from !== e.to).map((e) => e.to));
  for (const id of nodes.keys()) if (!hasIncoming.has(id)) visit(id, 0);
  for (const id of nodes.keys()) if (!layer.has(id)) visit(id, 0);

  const perLayer = new Map<number, string[]>();
  for (const id of nodes.keys()) {
    const l = layer.get(id) ?? 0;
    (perLayer.get(l) ?? perLayer.set(l, []).get(l)!).push(id);
  }
  const horizontal = direction === "LR" || direction === "RL";
  const reversed = direction === "RL" || direction === "BT";
  const maxLayer = Math.max(...perLayer.keys());
  const place = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of perLayer) {
    const along = (reversed ? maxLayer - l : l) * ((horizontal ? NODE_W + GAP_X : NODE_H + GAP_Y));
    ids.forEach((id, i) => {
      const across = i * (horizontal ? NODE_H + GAP_Y : NODE_W + GAP_X);
      place.set(id, horizontal ? { x: origin.x + PAD + along, y: origin.y + PAD + FRAME_TITLE + across } : { x: origin.x + PAD + across, y: origin.y + PAD + FRAME_TITLE + along });
    });
  }

  const depthOf = (g: number): number => (groups[g]!.parent === null ? 0 : 1 + depthOf(groups[g]!.parent!));
  const items: PlanningCanvasItemInput[] = [];
  const bounds = groups.map(() => ({ x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }));
  const grow = (g: number | null, x: number, y: number, w: number, h: number) => {
    for (let at = g; at !== null; at = groups[at]!.parent) {
      const b = bounds[at]!;
      b.x1 = Math.min(b.x1, x - PAD); b.y1 = Math.min(b.y1, y - PAD - FRAME_TITLE);
      b.x2 = Math.max(b.x2, x + w + PAD); b.y2 = Math.max(b.y2, y + h + PAD);
    }
  };
  const keyOf = (id: string) => `${prefix}-n-${id}`;
  const nodeItems: PlanningCanvasItemInput[] = [];
  for (const n of nodes.values()) {
    const p = place.get(n.id)!;
    grow(n.group, p.x, p.y, NODE_W, NODE_H);
    const shape: CanvasShapeVariant | undefined = n.shape === "round" || n.shape === "circle" ? "pill" : n.shape === "diamond" ? "diamond" : undefined;
    nodeItems.push({
      itemType: "node", key: keyOf(n.id), kind: shape ? "shape" : "sticky", x: p.x, y: p.y, width: NODE_W, height: NODE_H,
      zIndex: groups.length + 1, color: n.shape === "diamond" ? "amber" : "yellow", title: clip(n.text, 300), content: "", ...(shape ? { shape } : {}),
    });
  }
  groups.forEach((g, i) => {
    const b = bounds[i]!;
    if (!Number.isFinite(b.x1)) { b.x1 = origin.x; b.y1 = origin.y; b.x2 = origin.x + NODE_W; b.y2 = origin.y + NODE_H; }
    items.push(frameItem(`${prefix}-sub-${g.id}-${i + 1}`, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, g.title, depthOf(i)));
  });
  items.push(...nodeItems);
  edges.forEach((e, i) => {
    items.push({ itemType: "connector", key: `${prefix}-e${i + 1}`, fromKey: keyOf(e.from), toKey: keyOf(e.to), ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}) });
  });
  return items;
}

export function planningCanvasImportItems(input: Pick<PlanningCanvasImportInput, "format" | "source">, options: PlanningCanvasImportOptions = {}): PlanningCanvasItemInput[] {
  return input.format === "markdown" ? importMarkdownOutline(input.source, options) : importMermaidFlowchart(input.source, options);
}
