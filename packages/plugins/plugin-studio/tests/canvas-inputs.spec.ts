import { describe, expect, it } from "vitest";
import { normalizeDoc } from "../src/canvas.js";
import { cardInputs, modelOptions } from "../src/canvas-inputs.js";
import { PAGE_MODELS, UNAVAILABLE_MODELS } from "../src/page.js";

const card = (id: string, type: string, data: Record<string, string> = {}, y = 0) => ({ id, type, position: { x: 0, y }, data });

describe("canvas card inputs", () => {
  // The PAR-7753 story: two images, a "make them meet" image from both, a video from that.
  const nodes = [
    card("p1", "prompt", { text: "A red fox" }, 0),
    card("p2", "prompt", { text: "A grey owl" }, 200),
    card("a", "image", { assetId: "asset-fox" }, 0),
    card("b", "image", { assetId: "asset-owl" }, 200),
    card("pm", "prompt", { text: "Make them meet in a forest" }, 400),
    card("m", "image", { prompt: "golden hour" }, 100),
    card("v", "video", {}, 100),
    card("o", "output", {}, 100),
    card("o2", "output", {}, 300),
  ];
  const edges = [
    { source: "p1", target: "a" },
    { source: "p2", target: "b" },
    { source: "a", target: "m" },
    { source: "b", target: "m" },
    { source: "pm", target: "m" },
    { source: "m", target: "v" },
    { source: "m", target: "o" },
    { source: "v", target: "o2" },
  ];

  it("joins connected prompts top to bottom, then the card's own direction, and takes images as references", () => {
    const m = cardInputs(nodes, edges, "m");
    expect(m.prompt).toBe("Make them meet in a forest\n\ngolden hour");
    expect(m.referenceAssetIds).toEqual(["asset-fox", "asset-owl"]);
    expect(m.missing).toEqual([]);
    expect(m.outputIds).toEqual(["o"]);
    expect(cardInputs(nodes, edges, "a")).toEqual({ prompt: "A red fox", referenceAssetIds: [], missing: [], outputIds: [] });
  });

  it("names what is still missing: an image without a result, an empty prompt, a source without a file or with a video", () => {
    const v = cardInputs(nodes, edges, "v");
    expect(v.prompt).toBe("");
    expect(v.missing).toEqual(["the image card has no result yet"]);
    expect(v.outputIds).toEqual(["o2"]);
    const more = [...nodes, card("s", "source", { label: "Logo" }), card("sv", "source", { assetId: "clip" }), card("pe", "prompt")];
    const out = cardInputs(more, [...edges, { source: "s", target: "a" }, { source: "sv", target: "a" }, { source: "pe", target: "a" }], "a", (id) => id === "clip");
    expect(out.missing).toEqual(['"Logo" has no file picked', "the source card is a video, and only images can be references", "the prompt card has no prompt yet"]);
    expect(out.referenceAssetIds).toEqual([]);
  });

  it("uses each reference once", () => {
    const two = [card("s1", "source", { assetId: "x" }), card("s2", "source", { assetId: "x" }), card("i", "image")];
    expect(cardInputs(two, [{ source: "s1", target: "i" }, { source: "s2", target: "i" }], "i").referenceAssetIds).toEqual(["x"]);
  });
});

describe("canvas card model choice", () => {
  it("lists every model of the card's kind, disabling the ones that don't fit with the reason", () => {
    const none = modelOptions("image", 0, PAGE_MODELS, UNAVAILABLE_MODELS);
    expect(none.find((o) => o.id === "higgsfield-ai/soul/v2/standard")?.disabled).toBeNull();
    const two = modelOptions("image", 2, PAGE_MODELS, UNAVAILABLE_MODELS);
    expect(two.find((o) => o.id === "higgsfield-ai/soul/v2/standard")?.disabled).toBe("takes no reference images");
    expect(two.find((o) => o.id === "xai/grok-imagine-image-2.0")?.disabled).toBeNull();
    expect(two.find((o) => o.label.startsWith("Nano Banana 2"))?.disabled).toMatch(/Not on the Higgsfield REST API/);
    const video = modelOptions("video", 0, PAGE_MODELS, UNAVAILABLE_MODELS);
    expect(video.find((o) => o.id === "kling-video/v3.0-turbo/image-to-video")?.disabled).toBe("needs 1 reference image connected");
    expect(video.find((o) => o.label.startsWith("Seedance 2.0"))?.disabled).toMatch(/Not priced/);
    expect(video.every((o) => !o.label.includes("(image)"))).toBe(true);
    const one = modelOptions("video", 1, PAGE_MODELS, UNAVAILABLE_MODELS);
    expect(one.find((o) => o.id === "kling-video/v3.0-turbo/image-to-video")?.disabled).toBeNull();
  });
});

describe("canvas save keeps a card's result", () => {
  it("keeps assetId and groupId on image and video cards", () => {
    const doc = normalizeDoc({ nodes: [card("i", "image", { assetId: "abc-1", groupId: "g-1", model: "z-image/turbo" }), card("v", "video", { assetId: "abc-2" })], edges: [] });
    expect(doc.nodes[0].data).toEqual({ assetId: "abc-1", groupId: "g-1", model: "z-image/turbo" });
    expect(doc.nodes[1].data).toEqual({ assetId: "abc-2" });
    expect(() => normalizeDoc({ nodes: [card("i", "image", { assetId: "../x" })], edges: [] })).toThrow(/not an asset id/);
  });
});
