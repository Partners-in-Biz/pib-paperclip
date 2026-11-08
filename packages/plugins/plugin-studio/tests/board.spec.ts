import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/canvas-rules.js";
import { connectionProblem, editInputs, fromFlow, History, isConflict, MAX_EDIT_INPUTS, newId, toFlow, type FlowNode } from "../src/ui/board.js";

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
    expect(connectionProblem(nodes, [], "p", "o")).toBe("A prompt card can't feed an output card.");
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

describe("canvas Edit card (PAR-8323)", () => {
  const board = [
    { id: "s", type: "source", position: { x: 0, y: 200 }, data: { assetId: "img-1", label: "Logo" } },
    { id: "v", type: "video", position: { x: 0, y: 0 }, data: { assetId: "vid-1" } },
    { id: "o", type: "output", position: { x: 0, y: 400 }, data: {} },
    { id: "p", type: "prompt", position: { x: 0, y: 600 }, data: { text: "hi" } },
    { id: "e", type: "edit", position: { x: 400, y: 0 }, data: {} },
    { id: "l", type: "layout", position: { x: 800, y: 0 }, data: {} },
  ];

  it("takes video, image, source and output cards in and feeds only a Layout card", () => {
    for (const from of ["s", "v", "o"]) expect(connectionProblem(board, [], from, "e")).toBeNull();
    expect(connectionProblem(board, [], "p", "e")).toMatch(/can't feed/);
    expect(connectionProblem(board, [], "e", "l")).toBeNull();
    expect(connectionProblem(board, [], "e", "o")).toMatch(/can't feed/);
  });

  it("lists the wired files top to bottom, once each, and names the cards without one", () => {
    const edges = [{ source: "s", target: "e" }, { source: "v", target: "e" }, { source: "o", target: "e" }, { source: "p", target: "e" }, { source: "v", target: "e" }];
    expect(editInputs(board, edges, "e")).toEqual({ assetIds: ["vid-1", "img-1"], missing: ["The output card has no file yet"] });
    expect(editInputs(board, [], "e")).toEqual({ assetIds: [], missing: [] });
  });

  it("caps a new edit at the files the worker accepts", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, type: "source", position: { x: 0, y: i }, data: { assetId: `a${i}` } }));
    const out = editInputs([...many, board[4]!], many.map((n) => ({ source: n.id, target: "e" })), "e");
    expect(out.assetIds).toHaveLength(MAX_EDIT_INPUTS);
    expect(out.assetIds[0]).toBe("a0");
    expect(out.missing).toEqual([`Only the first ${MAX_EDIT_INPUTS} files go into the edit`]);
  });

  it("saves and reloads an Edit card with its edit and output, and an old board is unchanged", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "v", type: "video", position: { x: 0, y: 0 }, data: { assetId: "vid-1" } },
        { id: "e", type: "edit", position: { x: 400, y: 0 }, data: { label: "Ad cut", editId: "ed-1", assetId: "out-1", renderId: "" } },
        { id: "l", type: "layout", position: { x: 800, y: 0 }, data: {} },
      ],
      edges: [{ id: "e1", source: "v", target: "e" }, { id: "e2", source: "e", target: "l" }],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const flow = toFlow(doc);
    const back = fromFlow(flow.nodes, flow.edges, doc.viewport);
    expect(back.nodes[1]).toEqual({ id: "e", type: "edit", position: { x: 400, y: 0 }, data: { label: "Ad cut", editId: "ed-1", assetId: "out-1" } });
    expect(back.edges).toEqual(doc.edges);
    const old: CanvasDoc = { nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: { text: "x" } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const oldFlow = toFlow(old);
    expect(fromFlow(oldFlow.nodes, oldFlow.edges, old.viewport)).toEqual(old);
  });
});
