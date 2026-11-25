// PAR-13949 (C19): the order the Outline lists nodes in, and the order Tab walks them.
import type { CanvasNode } from "@paperclipai/shared";

export type OutlineEntry = {
  node: CanvasNode;
  /** 0 for a frame or a loose node, 1 for a node inside a frame. */
  depth: 0 | 1;
};

/** Nodes whose tops sit within this many world units read as one row. */
const ROW_BAND = 48;

export function readingCompare(a: CanvasNode, b: CanvasNode): number {
  const rowA = Math.round(a.y / ROW_BAND);
  const rowB = Math.round(b.y / ROW_BAND);
  return rowA - rowB || a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
}

function area(n: CanvasNode): number {
  return n.width * n.height;
}

/** The smallest frame whose box holds the node's centre, or null. */
function owningFrame(node: CanvasNode, frames: CanvasNode[]): CanvasNode | null {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  let best: CanvasNode | null = null;
  for (const f of frames) {
    if (cx < f.x || cx > f.x + f.width || cy < f.y || cy > f.y + f.height) continue;
    if (!best || area(f) < area(best)) best = f;
  }
  return best;
}

/**
 * Frames first in reading order, each followed by the nodes inside it in reading order, then the
 * loose nodes in reading order. Same rule as the page's frame ownership, so it is stable across
 * renders and does not depend on z-index.
 */
export function buildOutline(nodes: CanvasNode[]): OutlineEntry[] {
  const frames = nodes.filter((n) => n.kind === "frame");
  const children = new Map<string, CanvasNode[]>();
  const loose: CanvasNode[] = [];
  for (const n of nodes) {
    if (n.kind === "frame") continue;
    const owner = owningFrame(n, frames);
    if (owner) children.set(owner.id, [...(children.get(owner.id) ?? []), n]);
    else loose.push(n);
  }
  const out: OutlineEntry[] = [];
  for (const f of [...frames].sort(readingCompare)) {
    out.push({ node: f, depth: 0 });
    for (const child of (children.get(f.id) ?? []).sort(readingCompare)) out.push({ node: child, depth: 1 });
  }
  for (const n of loose.sort(readingCompare)) out.push({ node: n, depth: 0 });
  return out;
}

const KIND_LABEL: Record<CanvasNode["kind"], string> = {
  sticky: "Sticky note",
  frame: "Frame",
  shape: "Shape",
  text: "Text",
  note: "Personal note",
};

/** Screen-reader label: kind and the first words of the title or content. */
export function nodeAriaLabel(node: CanvasNode): string {
  const text = (node.title || node.content || "").replace(/\s+/g, " ").trim();
  const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `${KIND_LABEL[node.kind] ?? node.kind}: ${short || "Untitled"}`;
}
