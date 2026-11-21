export const CANVAS_NODE_KINDS = [
  "sticky",
  "note",
  "frame",
  "shape",
  "text",
] as const;

export type CanvasNodeKind = (typeof CANVAS_NODE_KINDS)[number];

export const CANVAS_NODE_COLORS = [
  "yellow",
  "amber",
  "blue",
  "emerald",
  "rose",
  "violet",
  "slate",
] as const;

export type CanvasNodeColor = (typeof CANVAS_NODE_COLORS)[number];

export const CANVAS_SHAPE_VARIANTS = [
  "rect",
  "pill",
  "diamond",
] as const;

export type CanvasShapeVariant = (typeof CANVAS_SHAPE_VARIANTS)[number];

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  color: CanvasNodeColor;
  title: string;
  content: string;
  /** When kind === "note", references a PersonalNote.id */
  noteId?: string | null;
  /** When kind === "shape", selects rect / pill / diamond */
  shape?: CanvasShapeVariant;
  /** Linked Paperclip issue identifier if this sticky/frame was handed to an agent */
  handedOffIssueId?: string | null;
  handedOffIssueIdentifier?: string | null;
}

export interface CanvasConnector {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  color?: CanvasNodeColor;
  dashed?: boolean;
}

export interface CanvasStroke {
  id: string;
  points: Array<{ x: number; y: number }>;
  color: CanvasNodeColor;
  width: number;
  highlighter?: boolean;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PlanningCanvasData {
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  strokes?: CanvasStroke[];
  viewport: CanvasViewport;
}

export interface PlanningCanvasBoard {
  id: string;
  companyId: string;
  userId: string;
  title: string;
  description: string;
  data: PlanningCanvasData;
  createdAt: string;
  updatedAt: string;
}
