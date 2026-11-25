// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CanvasConnector, CanvasNode } from "@paperclipai/shared";
import { cullConnectors, cullNodes, cullRect, isLowDetail, sameRect } from "@/components/planning-canvas/canvas/culling";
import { pinchViewport, zoomAbout } from "@/components/planning-canvas/canvas/gestures";

const node = (id: string, x: number, y: number, width = 230, height = 150) =>
  ({ id, kind: "sticky", x, y, width, height, zIndex: 2, color: "yellow", title: id, content: "" }) as CanvasNode;

/** The perf seed's grid: 300 x 220 cells, 90 columns for 5,000 nodes. */
function grid(count: number, cols = 90) {
  return Array.from({ length: count }, (_, i) => node(`n${i}`, (i % cols) * 300, Math.floor(i / cols) * 220));
}

describe("cullRect", () => {
  it("covers the visible rect plus one screen on every side, snapped outward", () => {
    const rect = cullRect({ x: 40, y: 40, zoom: 1 }, { width: 1400, height: 800 });
    expect(rect.left).toBeLessThanOrEqual(-40 - 1400);
    expect(rect.top).toBeLessThanOrEqual(-40 - 800);
    expect(rect.right).toBeGreaterThanOrEqual(-40 + 2 * 1400);
    expect(rect.bottom).toBeGreaterThanOrEqual(-40 + 2 * 800);
    expect(Math.abs(rect.left % 256)).toBe(0);
    expect(rect.right - rect.left).toBeLessThanOrEqual(3 * 1400 + 512);
  });

  it("keeps the same rect for a small pan and moves it after a large one", () => {
    const size = { width: 1400, height: 800 };
    const a = cullRect({ x: 0, y: 0, zoom: 1 }, size);
    expect(sameRect(a, cullRect({ x: -10, y: 0, zoom: 1 }, size))).toBe(true);
    expect(sameRect(a, cullRect({ x: -600, y: 0, zoom: 1 }, size))).toBe(false);
  });

  it("grows with the zoom out", () => {
    const size = { width: 1400, height: 800 };
    const near = cullRect({ x: 0, y: 0, zoom: 1 }, size);
    const far = cullRect({ x: 0, y: 0, zoom: 0.5 }, size);
    expect(far.right - far.left).toBeGreaterThan(1.9 * (near.right - near.left) - 1024);
  });
});

describe("cullNodes", () => {
  it("mounts at most 300 of 5,000 seed nodes at zoom 1 in a 1440 x 900 window", () => {
    const nodes = grid(5000);
    const visible = cullNodes(nodes, cullRect({ x: 40, y: 40, zoom: 1 }, { width: 1440, height: 900 }), new Set());
    expect(visible.length).toBeGreaterThan(50);
    expect(visible.length).toBeLessThanOrEqual(300);
    // Everything on screen is in.
    const onScreen = nodes.filter((n) => n.x + 40 < 1440 && n.y + 40 < 900);
    expect(onScreen.every((n) => visible.includes(n))).toBe(true);
  });

  it("keeps selected or edited nodes far off screen and keeps paint order", () => {
    const nodes = grid(5000);
    const far = nodes[4999]!;
    const visible = cullNodes(nodes, cullRect({ x: 0, y: 0, zoom: 1 }, { width: 1440, height: 900 }), new Set([far.id]));
    expect(visible.at(-1)).toBe(far);
    expect(visible.indexOf(nodes[1]!)).toBeGreaterThan(visible.indexOf(nodes[0]!));
  });
});

describe("cullConnectors", () => {
  it("keeps a connector whose line can cross the view and drops one far away", () => {
    const nodes = [node("a", 0, 0), node("b", 20000, 0), node("c", 20000, 9000), node("d", 20300, 9000)];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const connectors = [
      { id: "ab", fromNodeId: "a", toNodeId: "b" },
      { id: "cd", fromNodeId: "c", toNodeId: "d" },
      { id: "ax", fromNodeId: "a", toNodeId: "missing" },
    ] as CanvasConnector[];
    const kept = cullConnectors(connectors, byId, cullRect({ x: 0, y: 0, zoom: 1 }, { width: 1440, height: 900 }));
    expect(kept.map((c) => c.id)).toEqual(["ab"]);
  });
});

describe("level of detail", () => {
  it("switches below zoom 0.4", () => {
    expect(isLowDetail(0.39)).toBe(true);
    expect(isLowDetail(0.4)).toBe(false);
    expect(isLowDetail(1)).toBe(false);
  });
});

describe("gestures", () => {
  it("zooms about the pointer, keeping the world point under it", () => {
    const next = zoomAbout({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2);
    expect(next).toEqual({ x: -100, y: -100, zoom: 2 });
  });

  it("pinch: spreading the fingers zooms about their midpoint", () => {
    const next = pinchViewport({ x: 0, y: 0, zoom: 1 }, [{ x: 90, y: 100 }, { x: 110, y: 100 }], [{ x: 80, y: 100 }, { x: 120, y: 100 }]);
    expect(next).toEqual({ x: -100, y: -100, zoom: 2 });
  });

  it("two-finger pan: moving both fingers together pans without zooming", () => {
    const next = pinchViewport({ x: 10, y: 20, zoom: 1.5 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 50, y: 30 }, { x: 150, y: 30 }]);
    expect(next).toEqual({ x: 60, y: 50, zoom: 1.5 });
  });

  it("pinch zoom is clamped to the canvas zoom range", () => {
    const next = pinchViewport({ x: 0, y: 0, zoom: 1 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    expect(next.zoom).toBe(2);
  });
});
