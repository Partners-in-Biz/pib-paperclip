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
};

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
  if (!canConnect(from.type, to.type)) return `A ${from.type} card can't feed a ${to.type} card.`;
  if (edges.some((e) => e.source === source && e.target === target)) return "Those cards are already connected.";
  if (hasCycle(nodes, [...edges, { source, target }])) return "Connections can't go round in a loop.";
  return null;
}

/** Ids the worker accepts (letters, digits, - and _), unique enough for one board. */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Undo and redo over whole snapshots. Push before a change; undo hands back the state to show. */
export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];

  constructor(private readonly limit = 100) {}

  push(state: Snapshot): void {
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
