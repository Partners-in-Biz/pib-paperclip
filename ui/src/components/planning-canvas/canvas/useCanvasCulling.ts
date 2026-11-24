import { type RefObject, useEffect, useMemo, useState } from "react";
import type { CanvasConnector, CanvasNode } from "@paperclipai/shared";
import { type Size, type Viewport, cullConnectors, cullNodes, cullRect, isLowDetail } from "@/components/planning-canvas/canvas/culling";

type CullingInput = {
  canvasRef: RefObject<HTMLDivElement | null>;
  /** Changes when the viewport element mounts (company and board), so the size observer re-attaches. */
  mountKey: string;
  viewport: Viewport;
  sortedNodes: CanvasNode[];
  connectors: CanvasConnector[];
  nodeById: ReadonlyMap<string, CanvasNode>;
  selectedNodeIds: string[];
  editingNodeId: string | null;
  connectFromId: string | null;
};

function windowSize(): Size {
  return typeof window === "undefined" ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The nodes and connectors to mount for the current view (PAR-13948 C17). The lists keep their
 * identity while the snapped cull rect is unchanged, so a pan inside it re-renders no node.
 */
export function useCanvasCulling(input: CullingInput) {
  const { canvasRef, mountKey, viewport, sortedNodes, connectors, nodeById, selectedNodeIds, editingNodeId, connectFromId } = input;
  const [size, setSize] = useState<Size>(windowSize);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // A 0 px viewport (unlaid-out shell) falls back to the window, so nothing near the view is dropped.
    const measure = () => setSize(el.clientWidth > 0 && el.clientHeight > 0 ? { width: el.clientWidth, height: el.clientHeight } : windowSize());
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasRef, mountKey]);

  const rect = cullRect(viewport, size);
  const keep = useMemo(
    () => new Set([...selectedNodeIds, ...(editingNodeId ? [editingNodeId] : []), ...(connectFromId ? [connectFromId] : [])]),
    [selectedNodeIds, editingNodeId, connectFromId],
  );
  const { left, top, right, bottom } = rect;
  const visibleNodes = useMemo(
    () => cullNodes(sortedNodes, { left, top, right, bottom }, keep),
    [sortedNodes, left, top, right, bottom, keep],
  );
  const visibleConnectors = useMemo(
    () => cullConnectors(connectors, nodeById, { left, top, right, bottom }),
    [connectors, nodeById, left, top, right, bottom],
  );
  return { visibleNodes, visibleConnectors, lowDetail: isLowDetail(viewport.zoom) };
}
