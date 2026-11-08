import { describe, expect, it } from "vitest";
import { canConnect, MAX_NODES, normalizeDoc } from "../src/canvas.js";

const card = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 10, y: 20 }, data });
const link = (id: string, source: string, target: string) => ({ id, source, target });

describe("canvas document", () => {
  it("keeps the make-them-meet shape: two images feed a third, which feeds a video", () => {
    const doc = normalizeDoc({
      nodes: [card("p1", "prompt", { text: "a fox" }), card("a", "image"), card("b", "image"), card("m", "image", { prompt: "make them meet" }), card("v", "video")],
      edges: [link("e1", "p1", "a"), link("e2", "a", "m"), link("e3", "b", "m"), link("e4", "m", "v")],
      viewport: { x: 5, y: 6, zoom: 1.5 },
    });
    expect(doc.nodes).toHaveLength(5);
    expect(doc.edges).toHaveLength(4);
    expect(doc.viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
  });

  it("drops unknown fields and keeps only each card type's own", () => {
    const doc = normalizeDoc({ nodes: [{ ...card("s", "source", { assetId: "abc-1", url: "https://x", text: "no" }), selected: true }], edges: [] });
    expect(doc.nodes[0]).toEqual({ id: "s", type: "source", position: { x: 10, y: 20 }, data: { assetId: "abc-1" } });
  });

  it("keeps a video card's duration through save and load", () => {
    const saved = normalizeDoc({ nodes: [card("v", "video", { model: "kling-video/v3.0/std/text-to-video", duration: 10 })], edges: [] });
    expect(saved.nodes[0].data.duration).toBe("10");
    const loaded = normalizeDoc(JSON.parse(JSON.stringify(saved)));
    expect(loaded.nodes[0].data).toEqual({ model: "kling-video/v3.0/std/text-to-video", duration: "10" });
    expect(() => normalizeDoc({ nodes: [card("v", "video", { duration: 0 })], edges: [] })).toThrow(/whole number of seconds/);
    expect(() => normalizeDoc({ nodes: [card("v", "video", { duration: "ten" })], edges: [] })).toThrow(/whole number of seconds/);
    expect(normalizeDoc({ nodes: [card("i", "image", { duration: 10 })], edges: [] }).nodes[0].data).toEqual({});
  });

  it("follows the connection rules", () => {
    expect(canConnect("prompt", "image")).toBe(true);
    expect(canConnect("video", "output")).toBe(true);
    expect(canConnect("prompt", "prompt")).toBe(false);
    expect(canConnect("video", "image")).toBe(false);
    expect(() => normalizeDoc({ nodes: [card("p", "prompt"), card("q", "prompt")], edges: [link("e", "p", "q")] })).toThrow(/can't feed/);
    expect(() => normalizeDoc({ nodes: [card("a", "image")], edges: [link("e", "a", "a")] })).toThrow(/itself/);
    expect(() => normalizeDoc({ nodes: [card("a", "image")], edges: [link("e", "a", "gone")] })).toThrow(/isn't on the canvas/);
  });

  it("refuses loops, duplicates and bad input", () => {
    expect(() => normalizeDoc({ nodes: [card("a", "image"), card("b", "image")], edges: [link("e1", "a", "b"), link("e2", "b", "a")] })).toThrow(/loop/);
    expect(() => normalizeDoc({ nodes: [card("a", "image"), card("a", "video")], edges: [] })).toThrow(/share the id/);
    expect(() => normalizeDoc({ nodes: [card("a", "sticker")], edges: [] })).toThrow(/Unknown card type/);
    expect(() => normalizeDoc({ nodes: [card("a", "prompt", { text: 5 })], edges: [] })).toThrow(/must be text/);
    expect(() => normalizeDoc({ nodes: [card("a", "source", { assetId: "../../etc" })], edges: [] })).toThrow(/not an asset id/);
    expect(() => normalizeDoc({ nodes: Array.from({ length: MAX_NODES + 1 }, (_, i) => card(`n${i}`, "prompt")), edges: [] })).toThrow(/at most/);
  });

  it("collapses a repeated connection and clamps the viewport", () => {
    const doc = normalizeDoc({ nodes: [card("p", "prompt"), card("a", "image")], edges: [link("e1", "p", "a"), link("e2", "p", "a")], viewport: { zoom: -3, x: "nope" } });
    expect(doc.edges).toHaveLength(1);
    expect(doc.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
