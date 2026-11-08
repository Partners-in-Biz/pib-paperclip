/**
 * The canvas rules that both the worker and the page need: card types, limits, which card may feed which, and the
 * loop check. No Node or database imports here, so the page bundle can use the same rules the worker enforces.
 */
export const NODE_TYPES = ["prompt", "text", "source", "image", "video", "output", "layout", "edit"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const MAX_NODES = 300;
export const MAX_EDGES = 600;
export const MAX_TEXT = 4000;
export const MAX_LABEL = 120;
export const MAX_TITLE = 120;

/** Which card may feed which. Outputs only come out of a generating card; prompts and sources only feed. */
const FEEDS: Record<NodeType, readonly NodeType[]> = {
  prompt: ["image", "video"],
  // Words only go to a Layout card, which sets them as real text. Image models garble lettering.
  text: ["layout"],
  source: ["image", "video", "layout", "edit"],
  image: ["image", "video", "output", "layout", "edit"],
  video: ["output", "edit"],
  output: ["image", "video", "layout", "edit"],
  layout: [],
  // A video edit (PAR-8323) takes pictures and videos in and sends its rendered video on, like any asset card.
  edit: ["layout"],
};

export interface CanvasNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: Record<string, string>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export function emptyDoc(): CanvasDoc {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

export function canConnect(from: NodeType, to: NodeType): boolean {
  return FEEDS[from].includes(to);
}

/** Card types that can take a connection in, and that can send one out. */
export function acceptsInput(type: NodeType): boolean {
  return NODE_TYPES.some((from) => canConnect(from, type));
}

export function sendsOutput(type: NodeType): boolean {
  return FEEDS[type].length > 0;
}

export function hasCycle(nodes: ReadonlyArray<{ id: string }>, edges: ReadonlyArray<{ source: string; target: string }>): boolean {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some((n) => visit(n.id));
}
