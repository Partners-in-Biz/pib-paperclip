/**
 * The canvas page's plain logic, kept out of React so it can be tested: mapping a saved board to React Flow and back,
 * the connection check people see while dragging, and the undo history.
 */
import type { Edge, Node } from "@xyflow/react";
import { canConnect, hasCycle, NODE_TYPES, type CanvasDoc, type NodeType } from "../canvas-rules.js";

export type CardData = Record<string, string>;
export type FlowNode = Node<CardData, NodeType>;

export interface Snapshot {
  nodes: FlowNode[];
  edges: Edge[];
}

export const CARD_LABELS: Record<NodeType, string> = {
  prompt: "Prompt",
  image: "Image",
  video: "Video",
  source: "Source",
  output: "Output",
  text: "Text",
  layout: "Layout",
  edit: "Edit",
};

/** Cards whose file an Edit card can put on its timeline. */
const EDIT_INPUT_TYPES: readonly string[] = ["source", "image", "video", "output"] satisfies NodeType[];
/** The most files a new video edit takes (createEditAction refuses more). */
export const MAX_EDIT_INPUTS = 20;

/**
 * The files an Edit card starts a video edit from: its wired-in cards top to bottom, then left to right (the order
 * the clips play), each file once, at most MAX_EDIT_INPUTS. `missing` names wired cards that have no file yet.
 */
export function editInputs(nodes: ReadonlyArray<{ id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, string | undefined> }>, edges: ReadonlyArray<{ source: string; target: string }>, cardId: string): { assetIds: string[]; missing: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = (n: { position?: { x: number; y: number } }) => n.position ?? { x: 0, y: 0 };
  const incoming = [...new Set(edges.filter((e) => e.target === cardId).map((e) => e.source))]
    .map((id) => byId.get(id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n) && EDIT_INPUT_TYPES.includes(n!.type ?? ""))
    .sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x);
  const assetIds: string[] = [];
  const missing: string[] = [];
  for (const n of incoming) {
    const assetId = n.data?.assetId;
    const label = n.data?.label?.trim();
    if (!assetId) missing.push(`${label ? `"${label}"` : `The ${n.type} card`} has no file yet`);
    else if (!assetIds.includes(assetId)) assetIds.push(assetId);
  }
  if (assetIds.length > MAX_EDIT_INPUTS) missing.push(`Only the first ${MAX_EDIT_INPUTS} files go into the edit`);
  return { assetIds: assetIds.slice(0, MAX_EDIT_INPUTS), missing };
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

export function toFlow(doc: CanvasDoc): Snapshot {
  return {
    nodes: doc.nodes.map((n) => ({ id: n.id, type: n.type, position: { x: n.position.x, y: n.position.y }, data: { ...n.data } })),
    edges: doc.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/** Back to the saved shape: only the fields the worker keeps, empty values dropped. */
export function fromFlow(nodes: FlowNode[], edges: Edge[], viewport: { x: number; y: number; zoom: number }): CanvasDoc {
  return {
    nodes: nodes
      .filter((n) => isNodeType(n.type))
      .map((n) => {
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(n.data ?? {})) if (typeof value === "string" && value !== "") data[key] = value;
        return { id: n.id, type: n.type as NodeType, position: { x: n.position.x, y: n.position.y }, data };
      }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
  };
}

/** Why this connection is not allowed, in words a person can act on; null when it is fine. Mirrors normalizeDoc. */
export function connectionProblem(nodes: ReadonlyArray<{ id: string; type?: string }>, edges: ReadonlyArray<{ source: string; target: string }>, source: string, target: string): string | null {
  if (source === target) return "A card can't connect to itself.";
  const from = nodes.find((n) => n.id === source);
  const to = nodes.find((n) => n.id === target);
  if (!from || !to || !isNodeType(from.type) || !isNodeType(to.type)) return "That card is not on the canvas.";
  if (!canConnect(from.type, to.type)) return `${article(from.type, true)} ${from.type} card can't feed ${article(to.type)} ${to.type} card.`;
  if (edges.some((e) => e.source === source && e.target === target)) return "Those cards are already connected.";
  if (hasCycle(nodes, [...edges, { source, target }])) return "Connections can't go round in a loop.";
  return null;
}

function article(word: string, capital = false): string {
  const a = /^[aeiou]/.test(word) ? "an" : "a";
  return capital ? a[0].toUpperCase() + a.slice(1) : a;
}

/** Ids the worker accepts (letters, digits, - and _), unique enough for one board. */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** How far each new card steps from one already sitting at the same spot. */
export const CASCADE_STEP = 24;

/**
 * Where a new card goes: at `start` (top-left), stepped down and right by CASCADE_STEP until no card sits within
 * half a step of that spot, so a new card never lands exactly on top of another one.
 */
export function cascadePosition(nodes: ReadonlyArray<{ position: { x: number; y: number } }>, start: { x: number; y: number }, step = CASCADE_STEP): { x: number; y: number } {
  let x = Math.round(start.x);
  let y = Math.round(start.y);
  const near = (p: { x: number; y: number }) => Math.abs(p.x - x) < step / 2 && Math.abs(p.y - y) < step / 2;
  for (let i = 0; i <= nodes.length && nodes.some((n) => near(n.position)); i++) {
    x += step;
    y += step;
  }
  return { x, y };
}

export interface Rect { x: number; y: number; width: number; height: number }
/** A card's size before React Flow has measured it (16rem wide, a square image plus head and foot). */
export const CARD_SIZE = { width: 256, height: 340 };
/** "Fit" never zooms out below this, so card text and buttons stay readable (PAR-7753 live finding). */
export const FIT_MIN_ZOOM = 0.6;

/**
 * The part of the board people can see, in screen pixels: the board box minus the side panel. A panel on the right
 * trims the width; a phone's bottom sheet trims the height. Whichever leaves more room wins.
 */
export function visibleArea(board: Rect, panel: Rect | null): Rect {
  if (!panel || panel.width === 0 || panel.height === 0) return board;
  const right = board.x + board.width;
  const bottom = board.y + board.height;
  const left = { ...board, width: Math.max(0, Math.min(right, panel.x) - board.x) };
  const top = { ...board, height: Math.max(0, Math.min(bottom, panel.y) - board.y) };
  return left.width * left.height >= top.width * top.height ? left : top;
}

type Placed = { position: { x: number; y: number }; measured?: { width?: number; height?: number } };

/**
 * A spot for a new card inside `area` (flow coordinates) that overlaps no card, nearest to `prefer` (the area's
 * centre if not given). Null when the area has no free spot: the caller keeps its own position then.
 */
export function freeSpot(nodes: ReadonlyArray<Placed>, area: Rect, prefer?: { x: number; y: number }, size = CARD_SIZE, gap = 24): { x: number; y: number } | null {
  const want = prefer ?? { x: area.x + area.width / 2 - size.width / 2, y: area.y + area.height / 2 - size.height / 2 };
  const boxes = nodes.map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? size.width, h: n.measured?.height ?? size.height }));
  const free = (x: number, y: number) => boxes.every((b) => x + size.width + gap <= b.x || b.x + b.w + gap <= x || y + size.height + gap <= b.y || b.y + b.h + gap <= y);
  const maxX = area.x + area.width - size.width;
  const maxY = area.y + area.height - size.height;
  if (maxX < area.x || maxY < area.y) return null;
  // At most ~40 x 40 candidates however far out the board is zoomed.
  const stepX = Math.max(gap, (maxX - area.x) / 40);
  const stepY = Math.max(gap, (maxY - area.y) / 40);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = area.y; y <= maxY; y += stepY) {
    for (let x = area.x; x <= maxX; x += stepX) {
      if (!free(x, y)) continue;
      const d = (x - want.x) ** 2 + (y - want.y) ** 2;
      if (d < bestD) { bestD = d; best = { x: Math.round(x), y: Math.round(y) }; }
    }
  }
  return best;
}

/**
 * Where a new card goes: a free spot in view, else the nearest free spot in a 3x wider box around the view (the
 * caller pans to it, `inView` false). Never on top of another card unless the whole wide box is full (null).
 */
export function placeCard(nodes: ReadonlyArray<Placed>, area: Rect, prefer?: { x: number; y: number }): { spot: { x: number; y: number }; inView: boolean } | null {
  const near = freeSpot(nodes, area, prefer);
  if (near) return { spot: near, inView: true };
  const centre = prefer ?? { x: area.x + area.width / 2 - CARD_SIZE.width / 2, y: area.y + area.height / 2 - CARD_SIZE.height / 2 };
  const wide = { x: area.x - area.width, y: area.y - area.height, width: area.width * 3, height: area.height * 3 };
  const far = freeSpot(nodes, wide, centre);
  return far ? { spot: far, inView: false } : null;
}

/** Gap between a source card and the result cards made next to it. */
export const RESULT_GAP_X = 380;
export const RESULT_GAP_Y = 280;
export const EDGE_LABEL_OUTPUT = "generated output";

/** Edges into an output card carry the label "generated output" on screen. It is not saved: it follows from the card type. */
export function labelEdges(nodes: ReadonlyArray<{ id: string; type?: string }>, edges: Edge[]): Edge[] {
  const outputs = new Set(nodes.filter((n) => n.type === "output").map((n) => n.id));
  return edges.map((e) => (outputs.has(e.target) ? { ...e, label: EDGE_LABEL_OUTPUT } : e));
}

export interface ResultCards {
  /** Existing wired output cards (not made by an earlier run) that now show a result. */
  fills: Array<{ id: string; assetId: string }>;
  created: FlowNode[];
  edges: Edge[];
}

/**
 * Where the results of a finished generation go. Wired output cards that an earlier run did not make are filled first,
 * one result each; every other result becomes a new output card (marked `generated`) to the right of the source,
 * joined to it by an edge, so earlier results stay on the board. `room` caps how many cards may still be added.
 */
export function resultCards(nodes: ReadonlyArray<FlowNode>, edges: ReadonlyArray<{ source: string; target: string }>, sourceId: string, assetIds: readonly string[], room: number, makeId: (prefix: string) => string = newId): ResultCards {
  const out: ResultCards = { fills: [], created: [], edges: [] };
  const src = nodes.find((n) => n.id === sourceId);
  const ids = [...new Set(assetIds)];
  if (!src || ids.length === 0) return out;
  const wired = [...new Set(edges.filter((e) => e.source === sourceId).map((e) => e.target))]
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is FlowNode => n?.type === "output" && !n.data.generated);
  wired.forEach((n, i) => out.fills.push({ id: n.id, assetId: ids[Math.min(i, ids.length - 1)] }));
  const taken: Array<{ x: number; y: number }> = nodes.map((n) => n.position);
  for (const assetId of ids.slice(wired.length, wired.length + Math.max(0, room))) {
    const x = src.position.x + RESULT_GAP_X;
    let y = src.position.y;
    while (taken.some((p) => Math.abs(p.x - x) < RESULT_GAP_X - 20 && Math.abs(p.y - y) < RESULT_GAP_Y - 20)) y += RESULT_GAP_Y;
    taken.push({ x, y });
    const id = makeId("n");
    out.created.push({ id, type: "output", position: { x, y }, data: { assetId, generated: "1" } });
    out.edges.push({ id: makeId("e"), source: sourceId, target: id });
  }
  return out;
}

/** Keys that delete the selected cards or connections (React Flow's default is Backspace only, PAR-8104). */
export const DELETE_KEYS = ["Backspace", "Delete"];

/** True while focus is in a field, where Backspace / Delete / Ctrl+Z edit text and must not touch the board. */
export function isTypingTarget(target: { closest?: (selector: string) => unknown } | null | undefined): boolean {
  return Boolean(target && typeof target.closest === "function" && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])"));
}

/** The board without these cards and every connection to or from them. */
export function removeCards(snap: Snapshot, ids: Iterable<string>): Snapshot {
  const gone = new Set(ids);
  return { nodes: snap.nodes.filter((n) => !gone.has(n.id)), edges: snap.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) };
}

/** The board without these connections; the cards stay. */
export function removeConnections(snap: Snapshot, ids: Iterable<string>): Snapshot {
  const gone = new Set(ids);
  return { nodes: snap.nodes, edges: snap.edges.filter((e) => !gone.has(e.id)) };
}

/**
 * What to ask before cards are deleted, or null when nothing needs asking. A card that shows a file (a result, or a
 * picked source) only leaves the board: the file stays in the library, and deleting a card never deletes an asset.
 */
export function deleteConfirmText(cards: ReadonlyArray<{ data?: Record<string, unknown> }>): string | null {
  const withFiles = cards.filter((c) => typeof c.data?.assetId === "string" && c.data.assetId !== "").length;
  if (withFiles === 0) return null;
  const what = cards.length === 1 ? "this card" : `these ${cards.length} cards`;
  return `Delete ${what} from the board? The library ${withFiles === 1 ? "file stays" : "files stay"} in the Studio library; only the card is removed. Undo brings it back.`;
}

/** Undo and redo over whole snapshots. Push before a change; undo hands back the state to show. */
export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];

  constructor(private readonly limit = 100) {}

  push(state: Snapshot): void {
    // React Flow reports a card delete as a node change and an edge change in the same tick; both push the same
    // snapshot. Keep one, so a single Undo brings the card back with its connections.
    if (this.past[this.past.length - 1] === state) return;
    this.past.push(state);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Snapshot): Snapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/** True when a save was refused because someone else saved first (worker code canvas_conflict). */
export function isConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && e.code === "canvas_conflict") return true;
  const text = e && typeof e.message === "string" ? e.message : String(err ?? "");
  return text.includes("canvas_conflict") || text.includes("Someone saved this canvas");
}
