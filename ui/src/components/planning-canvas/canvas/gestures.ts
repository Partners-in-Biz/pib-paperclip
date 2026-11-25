import { clampZoom } from "@/components/planning-canvas/canvas-constants";
import type { Viewport } from "@/components/planning-canvas/canvas/culling";

/** A point in viewport-element coordinates (client minus the element's top-left). */
export type Point = { x: number; y: number };

/** Zoom by `factor` about a point, keeping the world point under it fixed. */
export function zoomAbout(prev: Viewport, at: Point, factor: number): Viewport {
  const zoom = clampZoom(prev.zoom * factor);
  const worldX = (at.x - prev.x) / prev.zoom;
  const worldY = (at.y - prev.y) / prev.zoom;
  return { x: Math.round(at.x - worldX * zoom), y: Math.round(at.y - worldY * zoom), zoom };
}

/**
 * Two-finger gesture: the spread of the fingers sets the zoom and their midpoint pans. The world
 * point under the starting midpoint ends up under the current midpoint.
 */
export function pinchViewport(start: Viewport, from: [Point, Point], to: [Point, Point]): Viewport {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const zoom = clampZoom(d0 >= 1 ? (start.zoom * d1) / d0 : start.zoom);
  const m0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const m1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const worldX = (m0.x - start.x) / start.zoom;
  const worldY = (m0.y - start.y) / start.zoom;
  return { x: Math.round(m1.x - worldX * zoom), y: Math.round(m1.y - worldY * zoom), zoom };
}
