import { describe, expect, it } from "vitest";
import { normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { applyOps } from "../src/video-edit/ops.js";
import { hexOf, KEY_DEFAULTS, meanRgb, pickPoint, setFrameOps, setKeyOps, toggleKeyOps } from "../src/ui/editor/chroma-panel.js";
import { eyedropper, sampleVideo } from "../src/ui/editor/eyedropper.js";
import type { LayerEdit } from "../src/ui/editor/layer-panel.js";

const media = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: "a1", version: 1, start: 0, in: 0, out: 4, ...extra });
const docOf = (extra: Record<string, unknown> = {}): EditDoc =>
  normalizeEdit({ tracks: [{ id: "v", kind: "video", clips: [media("a")] }, { id: "o1", kind: "overlay", clips: [media("p", extra)] }] });
const clipP = (d: EditDoc) => d.tracks[1].clips[0] as MediaClip;
const run = (d: EditDoc, e: LayerEdit | null, which: "ops" | "undo" = "ops") => { if (!e) throw new Error("no edit"); return applyOps(d, e[which]); };

describe("chroma key ops", () => {
  it("switches the key on with defaults and off again, and undoes both", () => {
    const d = docOf();
    const onEdit = toggleKeyOps(clipP(d), true);
    const on = run(d, onEdit);
    expect(clipP(on).chromaKey).toEqual({ color: "#00FF00", ...KEY_DEFAULTS });
    expect(toggleKeyOps(clipP(on), true)).toBeNull();
    expect(clipP(run(on, onEdit, "undo")).chromaKey).toBeUndefined();
    const offEdit = toggleKeyOps(clipP(on), false);
    const off = run(on, offEdit);
    expect(clipP(off).chromaKey).toBeUndefined();
    expect(clipP(run(off, offEdit, "undo")).chromaKey).toEqual(clipP(on).chromaKey);
  });
  it("a picked colour on a clip with no key writes a whole key; on a keyed clip it keeps the numbers", () => {
    const d = docOf();
    const picked = run(d, setKeyOps(clipP(d), { color: "#12ab9f" }));
    expect(clipP(picked).chromaKey).toEqual({ color: "#12AB9F", ...KEY_DEFAULTS });
    const tuned = run(picked, setKeyOps(clipP(picked), { similarity: 0.3, blend: 0.2, spill: 0.5 }));
    const again = run(tuned, setKeyOps(clipP(tuned), { color: "#00B140" }));
    expect(clipP(again).chromaKey).toEqual({ color: "#00B140", similarity: 0.3, blend: 0.2, spill: 0.5 });
    expect(clipP(run(again, setKeyOps(clipP(tuned), { color: "#00B140" }), "undo")).chromaKey).toEqual(clipP(tuned).chromaKey);
  });
  it("clamps to the ranges and refuses a bad colour, a non-number or no change", () => {
    const d = docOf({ chromaKey: { color: "#00FF00", similarity: 0.1, blend: 0, spill: 0 } });
    expect(clipP(run(d, setKeyOps(clipP(d), { similarity: 0 }))).chromaKey!.similarity).toBe(0.01);
    expect(clipP(run(d, setKeyOps(clipP(d), { spill: 9 }))).chromaKey!.spill).toBe(1);
    expect(setKeyOps(clipP(d), { color: "green" })).toBeNull();
    expect(setKeyOps(clipP(d), { blend: Number.NaN })).toBeNull();
    expect(setKeyOps(clipP(d), { similarity: 0.1 })).toBeNull();
  });
});

describe("frame ops", () => {
  it("sets border, colour and radius; a frame with neither border nor radius is dropped", () => {
    const d = docOf();
    const w = run(d, setFrameOps(clipP(d), { borderWidth: 6 }));
    expect(clipP(w).frame).toEqual({ borderWidth: 6, borderColor: "#FFFFFF", cornerRadius: 0 });
    const c = run(w, setFrameOps(clipP(w), { borderColor: "#ff0000", cornerRadius: 80 }));
    expect(clipP(c).frame).toEqual({ borderWidth: 6, borderColor: "#FF0000", cornerRadius: 50 });
    expect(clipP(run(c, setFrameOps(clipP(w), { borderColor: "#ff0000", cornerRadius: 80 }), "undo")).frame).toEqual(clipP(w).frame);
    expect(setFrameOps(clipP(d), { borderColor: "#ff0000" })).toBeNull();
    const none = run(w, setFrameOps(clipP(w), { borderWidth: 0 }));
    expect(clipP(none).frame).toBeUndefined();
    expect(clipP(run(none, setFrameOps(clipP(w), { borderWidth: 0 }), "undo")).frame).toEqual(clipP(w).frame);
  });
  it("clamps the border to 40 px and refuses a bad colour", () => {
    const d = docOf();
    expect(clipP(run(d, setFrameOps(clipP(d), { borderWidth: 99 }))).frame!.borderWidth).toBe(40);
    expect(setFrameOps(clipP(d), { borderColor: "#fff" })).toBeNull();
  });
});

describe("eyedropper sampling", () => {
  it("maps a click through the object-fit letterbox into video pixels", () => {
    const rect = { left: 100, top: 50, width: 400, height: 400 };
    const src = { width: 1920, height: 1080 }; // picture is 400 x 225, centred vertically: top at 50 + 87.5
    expect(pickPoint(rect, src, 300, 250)).toEqual({ x: 960, y: 540 });
    expect(pickPoint(rect, src, 100, 137.5)).toEqual({ x: 0, y: 0 });
    expect(pickPoint(rect, src, 499.99, 362.49)).toEqual({ x: 1919, y: 1079 });
    expect(pickPoint(rect, src, 300, 60)).toBeNull();
    expect(pickPoint({ ...rect, width: 0 }, src, 300, 250)).toBeNull();
  });
  it("averages a patch, skips transparent pixels, and formats hex", () => {
    expect(meanRgb([0, 100, 0, 255, 0, 200, 0, 255, 9, 9, 9, 0])).toEqual([0, 150, 0]);
    expect(meanRgb([1, 2, 3, 0])).toBeNull();
    expect(hexOf([0, 177.4, 64])).toBe("#00B140");
  });
  const video = (extra: Record<string, unknown> = {}) => ({ videoWidth: 100, videoHeight: 100, readyState: 4, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), ...extra }) as unknown as HTMLVideoElement;
  const canvas = (data: number[], throws = false) => () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => { if (throws) throw new Error("tainted"); }, getImageData: () => ({ data }) }) }) as unknown as HTMLCanvasElement;
  it("returns the patch colour, and a sentence for each failure", () => {
    const green = Array.from({ length: 9 }, () => [0, 177, 64, 255]).flat();
    expect(sampleVideo(video(), 50, 50, canvas(green))).toEqual({ color: "#00B140" });
    expect(sampleVideo(video({ readyState: 0 }), 50, 50, canvas(green))).toMatchObject({ error: expect.stringContaining("no picture") });
    expect(sampleVideo(video(), 500, 50, canvas(green))).toMatchObject({ error: expect.stringContaining("picture") });
    expect(sampleVideo(video(), 50, 50, canvas(green, true))).toMatchObject({ error: expect.stringContaining("type the colour") });
  });
  it("the store hands the result to the one that asked, once, and cancel drops it", () => {
    const got: unknown[] = [];
    eyedropper.start("p", (r) => got.push(r));
    expect(eyedropper.getState().clipId).toBe("p");
    eyedropper.finish({ color: "#112233" });
    eyedropper.finish({ color: "#445566" });
    expect(got).toEqual([{ color: "#112233" }]);
    expect(eyedropper.getState().clipId).toBeNull();
    eyedropper.start("p", (r) => got.push(r));
    eyedropper.cancel();
    eyedropper.finish({ color: "#000000" });
    expect(got).toHaveLength(1);
  });
});
