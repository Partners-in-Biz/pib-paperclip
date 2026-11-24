import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@paperclipai/shared";
import { buildOutline, nodeAriaLabel } from "./outline-order";

const n = (id: string, x: number, y: number, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, kind: "sticky", x, y, width: 100, height: 80, zIndex: 2, color: "yellow", title: id, content: "", ...over }) as CanvasNode;

describe("buildOutline", () => {
  it("lists frames in reading order, each followed by its nodes, then loose nodes", () => {
    const nodes = [
      n("loose-b", 900, 0),
      n("in-b", 520, 20),
      n("frameB", 500, 0, { kind: "frame", width: 300, height: 300 }),
      n("in-a2", 150, 20),
      n("in-a1", 20, 20),
      n("frameA", 0, 0, { kind: "frame", width: 400, height: 300 }),
      n("loose-a", 0, 600),
    ];
    const out = buildOutline(nodes).map((e) => `${e.depth}:${e.node.id}`);
    expect(out).toEqual(["0:frameA", "1:in-a1", "1:in-a2", "0:frameB", "1:in-b", "0:loose-b", "0:loose-a"]);
  });
  it("puts a node in the smallest frame that holds it and is stable", () => {
    const nodes = [
      n("outer", 0, 0, { kind: "frame", width: 1000, height: 1000 }),
      n("inner", 100, 100, { kind: "frame", width: 300, height: 300 }),
      n("x", 150, 150),
    ];
    const out = buildOutline(nodes);
    expect(out.map((e) => e.node.id)).toEqual(["outer", "inner", "x"]);
    expect(buildOutline([...nodes].reverse()).map((e) => e.node.id)).toEqual(["outer", "inner", "x"]);
  });
  it("is empty for an empty board and labels untitled nodes", () => {
    expect(buildOutline([])).toEqual([]);
    expect(nodeAriaLabel(n("a", 0, 0, { title: "", content: "" }))).toBe("Sticky note: Untitled");
    expect(nodeAriaLabel(n("a", 0, 0, { title: "x".repeat(200) })).length).toBeLessThan(110);
  });
});
