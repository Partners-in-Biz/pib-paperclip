import { describe, expect, it } from "vitest";
import { normalizeDoc } from "../src/canvas.js";
import { cardStatus } from "../src/ui/card-look.js";
import { reviewQueue } from "../src/ui/phone-review.js";

// The worker's save check for the canvas Edit card (PAR-8323): the card and its wires save, old boards are unchanged.
describe("canvas Edit card on save", () => {
  const doc = {
    nodes: [
      { id: "v1", type: "video", position: { x: 0, y: 0 }, data: { assetId: "vid-1" } },
      { id: "s1", type: "source", position: { x: 0, y: 300 }, data: { assetId: "img-1" } },
      { id: "e1", type: "edit", position: { x: 400, y: 0 }, data: { label: "Ad cut", editId: "0b0c1d2e-aaaa-bbbb-cccc-000000000001", assetId: "out-1", renderId: "r-1", junk: "dropped" } },
      { id: "l1", type: "layout", position: { x: 800, y: 0 }, data: {} },
    ],
    edges: [
      { id: "a", source: "v1", target: "e1" },
      { id: "b", source: "s1", target: "e1" },
      { id: "c", source: "e1", target: "l1" },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  it("keeps the edit, render and output ids and the wires in and out", () => {
    const out = normalizeDoc(doc);
    expect(out.nodes[2]).toEqual({ id: "e1", type: "edit", position: { x: 400, y: 0 }, data: { label: "Ad cut", editId: "0b0c1d2e-aaaa-bbbb-cccc-000000000001", assetId: "out-1", renderId: "r-1" } });
    expect(out.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["v1>e1", "s1>e1", "e1>l1"]);
  });

  it("refuses a prompt into an Edit card and an Edit card into an output card", () => {
    const prompt = { id: "p1", type: "prompt", position: { x: 0, y: 0 }, data: { text: "x" } };
    const output = { id: "o1", type: "output", position: { x: 0, y: 0 }, data: {} };
    expect(() => normalizeDoc({ ...doc, nodes: [...doc.nodes, prompt], edges: [{ id: "x", source: "p1", target: "e1" }] })).toThrow(/prompt card can't feed a edit card/);
    expect(() => normalizeDoc({ ...doc, nodes: [...doc.nodes, output], edges: [{ id: "x", source: "e1", target: "o1" }] })).toThrow(/edit card can't feed a output card/);
  });

  it("loads a board saved before the Edit card unchanged", () => {
    const old = { nodes: [{ id: "p1", type: "prompt", position: { x: 1, y: 2 }, data: { text: "A shop" } }, { id: "i1", type: "image", position: { x: 300, y: 2 }, data: { assetId: "img-9" } }], edges: [{ id: "a", source: "p1", target: "i1" }], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(normalizeDoc(old)).toEqual(old);
  });

  it("counts a rendered Edit card for Approve and shows Done", () => {
    expect(cardStatus("edit", { assetId: "out-1" }, undefined)).toEqual({ label: "Done", tone: "done" });
    expect(cardStatus("edit", {}, undefined)).toBeNull();
    const queue = reviewQueue([{ id: "e1", type: "edit", position: { x: 0, y: 0 }, data: { assetId: "out-1", label: "Ad cut" } }], [{ id: "out-1", name: "Ad cut.mp4", kind: "video" }]);
    expect(queue.map((q) => [q.cardId, q.kind])).toEqual([["e1", "video"]]);
  });
});
