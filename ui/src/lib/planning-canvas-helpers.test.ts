import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@paperclipai/shared";
import {
  alignSelectedNodes,
  buildFrameAgentBrief,
  buildSelectionAgentBrief,
  CANVAS_BOARD_TEMPLATES,
  computeConnectorPath,
  exportBoardToMarkdown,
  getNodesInRect,
  getNodesInsideFrame,
  snapToGrid,
  strokePointsToSvgPath,
} from "./planning-canvas-helpers";

describe("planning-canvas-helpers", () => {
  it("snaps coordinates to the grid", () => {
    expect(snapToGrid(29, 20)).toBe(20);
    expect(snapToGrid(31, 20)).toBe(40);
  });

  it("finds nodes inside a frame and bundles them into an agent brief", () => {
    const frame: CanvasNode = {
      id: "f1",
      kind: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      zIndex: 1,
      color: "emerald",
      title: "Now",
      content: "",
    };
    const inside: CanvasNode = {
      id: "s1",
      kind: "sticky",
      x: 50,
      y: 60,
      width: 200,
      height: 120,
      zIndex: 5,
      color: "yellow",
      title: "Ship onboarding",
      content: "Polish step 2",
    };
    const outside: CanvasNode = {
      id: "s2",
      kind: "sticky",
      x: 600,
      y: 60,
      width: 200,
      height: 120,
      zIndex: 5,
      color: "blue",
      title: "Later item",
      content: "",
    };

    const children = getNodesInsideFrame(frame, [frame, inside, outside]);
    expect(children.map((n) => n.id)).toEqual(["s1"]);

    const brief = buildFrameAgentBrief(frame, [frame, inside, outside], new Map());
    expect(brief.title).toBe("Now");
    expect(brief.description).toContain("Ship onboarding");
    expect(brief.description).toContain("Polish step 2");
    expect(brief.description).not.toContain("Later item");
  });

  it("computes smooth SVG Bezier connector paths between nodes", () => {
    const a: CanvasNode = {
      id: "a",
      kind: "sticky",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      zIndex: 2,
      color: "yellow",
      title: "A",
      content: "",
    };
    const b: CanvasNode = {
      id: "b",
      kind: "sticky",
      x: 400,
      y: 0,
      width: 200,
      height: 100,
      zIndex: 2,
      color: "blue",
      title: "B",
      content: "",
    };

    const geom = computeConnectorPath(a, b);
    expect(geom.startX).toBe(200);
    expect(geom.endX).toBe(400);
    expect(geom.midX).toBe(300);
    expect(geom.path.startsWith("M 200 50 C ")).toBe(true);
  });

  it("builds valid Miro-style starter templates", () => {
    for (const tpl of CANVAS_BOARD_TEMPLATES) {
      const built = tpl.build();
      expect(built.nodes.length).toBeGreaterThan(0);
      expect(built.viewport.zoom).toBeGreaterThan(0);
    }
  });

  it("selects nodes inside a marquee rect, aligns them, and builds a multi-selection brief", () => {
    const n1: CanvasNode = {
      id: "n1",
      kind: "sticky",
      x: 40,
      y: 80,
      width: 200,
      height: 120,
      zIndex: 2,
      color: "yellow",
      title: "Draft deck",
      content: "Include Q4 metrics",
    };
    const n2: CanvasNode = {
      id: "n2",
      kind: "sticky",
      x: 160,
      y: 220,
      width: 200,
      height: 120,
      zIndex: 2,
      color: "blue",
      title: "Book demo calls",
      content: "",
    };

    const hit = getNodesInRect([n1, n2], { x: 0, y: 0, width: 300, height: 300 });
    expect(hit.map((n) => n.id)).toEqual(["n1", "n2"]);

    const alignedLeft = alignSelectedNodes([n1, n2], ["n1", "n2"], "left");
    expect(alignedLeft.map((n) => n.x)).toEqual([40, 40]);

    const distributed = alignSelectedNodes([n1, n2], ["n1", "n2"], "distribute-h");
    expect(distributed[1]!.x).toBe(40 + 200 + 28);

    const brief = buildSelectionAgentBrief([n1, n2], new Map());
    expect(brief.title).toContain("2 items");
    expect(brief.description).toContain("Draft deck");
    expect(brief.description).toContain("Book demo calls");

    const svgPath = strokePointsToSvgPath([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 30, y: 25 },
    ]);
    expect(svgPath.startsWith("M 0 0 Q ")).toBe(true);
  });

  it("exports a full board with frames and connectors into structured Markdown", () => {
    const built = CANVAS_BOARD_TEMPLATES[0]!.build();
    const md = exportBoardToMarkdown("Q4 Roadmap", built.nodes, built.connectors, new Map());
    expect(md).toContain("# Q4 Roadmap");
    expect(md).toContain("## Now (This Week)");
    expect(md).toContain("## Flow & Dependencies");
    expect(md).toContain("Ship key priority → Next milestone (unlocks)");
  });
});
