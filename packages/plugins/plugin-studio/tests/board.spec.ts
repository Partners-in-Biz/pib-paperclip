import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/canvas-rules.js";
import { connectionProblem, fromFlow, History, isConflict, newId, toFlow, type FlowNode } from "../src/ui/board.js";

const nodes = [
  { id: "p", type: "prompt" },
  { id: "s", type: "source" },
  { id: "i", type: "image" },
  { id: "v", type: "video" },
  { id: "o", type: "output" },
];

describe("canvas page board logic", () => {
  it("allows the connections the worker allows and explains the rest", () => {
    expect(connectionProblem(nodes, [], "p", "i")).toBeNull();
    expect(connectionProblem(nodes, [], "s", "v")).toBeNull();
    expect(connectionProblem(nodes, [], "i", "o")).toBeNull();
    expect(connectionProblem(nodes, [], "p", "o")).toBe("A prompt card can't feed a output card.");
    expect(connectionProblem(nodes, [], "v", "i")).toMatch(/can't feed/);
    expect(connectionProblem(nodes, [], "i", "i")).toBe("A card can't connect to itself.");
    expect(connectionProblem(nodes, [{ source: "p", target: "i" }], "p", "i")).toBe("Those cards are already connected.");
    expect(connectionProblem(nodes, [{ source: "i", target: "o" }], "o", "i")).toBe("Connections can't go round in a loop.");
    expect(connectionProblem(nodes, [], "p", "missing")).toBe("That card is not on the canvas.");
  });

  it("round-trips a board through React Flow, dropping empty fields", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 10, y: 20 }, data: { text: "A sunny shop front", label: "Brief" } },
        { id: "b", type: "image", position: { x: 300, y: 20 }, data: { prompt: "" } },
      ],
      edges: [{ id: "e1", source: "a", target: "b" }],
      viewport: { x: 5, y: 6, zoom: 1.5 },
    };
    const flow = toFlow(doc);
    const back = fromFlow(flow.nodes, flow.edges, doc.viewport);
    expect(back.nodes[1].data).toEqual({});
    expect(back).toEqual({ ...doc, nodes: [doc.nodes[0], { ...doc.nodes[1], data: {} }] });
  });

  it("makes ids the worker accepts", () => {
    for (let i = 0; i < 20; i++) expect(newId("n")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("undoes and redoes whole snapshots, and a new change clears redo", () => {
    const h = new History(2);
    const snap = (n: number) => ({ nodes: [{ id: `n${n}` } as FlowNode], edges: [] });
    h.push(snap(1));
    h.push(snap(2));
    h.push(snap(3));
    expect(h.undo(snap(4))).toEqual(snap(3));
    expect(h.undo(snap(3))).toEqual(snap(2));
    expect(h.undo(snap(2))).toBeNull();
    expect(h.redo(snap(2))).toEqual(snap(3));
    h.push(snap(9));
    expect(h.canRedo).toBe(false);
  });

  it("recognises a revision conflict", () => {
    expect(isConflict({ code: "canvas_conflict", message: "x" })).toBe(true);
    expect(isConflict(new Error("Someone saved this canvas since you opened it (now revision 4). Reload to see their changes."))).toBe(true);
    expect(isConflict(new Error("network down"))).toBe(false);
  });
});
