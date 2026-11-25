import type { CanvasConnector, CanvasNode } from "@paperclipai/shared";

/**
 * Viewport culling and level of detail (PAR-13948 C17, plan PAR-13925 section F). Pure, so the
 * maths is unit-tested without a browser.
 *
 * Only items inside the visible world rect plus a one-screen margin on every side are mounted.
 * The rect is snapped outward to a world grid (256 px at zoom 1, scaled with the zoom), so a small
 * pan does not change the mounted set: it changes only when the view crosses a grid line.
 */
export const LOD_ZOOM = 0.4;
const SNAP_AT_ZOOM_1 = 256;

export type Viewport = { x: number; y: number; zoom: number };
export type Size = { width: number; height: number };
export type CullRect = { left: number; top: number; right: number; bottom: number };

export function isLowDetail(zoom: number) {
  return zoom < LOD_ZOOM;
}

/** World rect to keep mounted: the visible rect plus one screen on each side, snapped outward. */
export function cullRect(viewport: Viewport, size: Size, margin = 1): CullRect {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const w = size.width / zoom;
  const h = size.height / zoom;
  const left = -viewport.x / zoom - w * margin;
  const top = -viewport.y / zoom - h * margin;
  const snap = SNAP_AT_ZOOM_1 * 2 ** Math.round(Math.log2(1 / zoom));
  return {
    left: Math.floor(left / snap) * snap,
    top: Math.floor(top / snap) * snap,
    right: Math.ceil((left + w * (1 + 2 * margin)) / snap) * snap,
    bottom: Math.ceil((top + h * (1 + 2 * margin)) / snap) * snap,
  };
}

export function sameRect(a: CullRect, b: CullRect) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function overlaps(rect: CullRect, x: number, y: number, width: number, height: number) {
  return x < rect.right && x + width > rect.left && y < rect.bottom && y + height > rect.top;
}

/** Nodes inside the rect, in their paint order. `keep` (selected, editing, connecting) always stays mounted. */
export function cullNodes(sortedNodes: CanvasNode[], rect: CullRect, keep: ReadonlySet<string>): CanvasNode[] {
  return sortedNodes.filter((n) => keep.has(n.id) || overlaps(rect, n.x, n.y, n.width, n.height));
}

/** Connectors whose bounding box (both end nodes) touches the rect. */
export function cullConnectors(connectors: CanvasConnector[], nodeById: ReadonlyMap<string, CanvasNode>, rect: CullRect): CanvasConnector[] {
  return connectors.filter((c) => {
    const a = nodeById.get(c.fromNodeId);
    const b = nodeById.get(c.toNodeId);
    if (!a || !b) return false;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return overlaps(rect, x, y, Math.max(a.x + a.width, b.x + b.width) - x, Math.max(a.y + a.height, b.y + b.height) - y);
  });
}
