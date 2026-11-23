import type { CanvasConnector, CanvasNode, CanvasStroke } from "@paperclipai/shared";

export type ToolMode = "select" | "hand" | "sticky" | "frame" | "shape" | "text" | "connect" | "pen";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.0;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

export type HistoryEntry = { nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[] };

export type DragConnectState = {
  fromNodeId: string;
  startX: number;
  startY: number;
  currX: number;
  currY: number;
};
