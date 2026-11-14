import { describe, expect, it } from "vitest";
import { flashMatrix, effectPixels } from "../src/ui/editor/effect-filter.js";
import { buildPreviewPlan, clipTransform, frameAt, overlaysAt } from "../src/ui/editor/preview-plan.js";
import { effectFrame } from "../src/video-edit/effects.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const MAIN = [{ id: "zoomPunch", intensity: 1 }, { id: "shake", intensity: 0.5 }, { id: "flash", intensity: 1 }] as const;
const doc = normalizeEdit({
  project: { size: "9:16", fps: 30 },
  tracks: [
    { id: "v", kind: "video", clips: [{ id: "b", assetId: "base", version: 1, start: 0, in: 0, out: 4, effects: MAIN }] },
    { id: "o", kind: "overlay", clips: [{ id: "s", sticker: { pack: "noto-emoji", id: "fire" }, start: 1, in: 0, out: 2, effects: [{ id: "rgbSplit", intensity: 1 }, { id: "blurIn", intensity: 1 }] }] },
  ],
});
const project = { width: 1080, height: 1920 };

describe("preview effects", () => {
  it("evaluates the shared effectFrame at clip-local time (tau from the clip start)", () => {
    const plan = buildPreviewPlan(doc);
    expect(plan.project).toEqual(project);
    const layer = frameAt(plan, 0.1).layers[0]!;
    expect(layer.fx).toEqual(effectFrame([...MAIN], 0.1, project, true));
    const sticker = overlaysAt(plan, 1.3)[0]!;
    expect(sticker.fx).toEqual(effectFrame(sticker.segment.effects, 1.3 - 1, project, false));
  });

  it("has no fx without effects", () => {
    const plain = normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [{ id: "b", assetId: "a", version: 1, start: 0, in: 0, out: 2 }] }] });
    expect(frameAt(buildPreviewPlan(plain), 0.5).layers[0]!.fx).toBeNull();
  });

  it("zoom multiplies the scale and shake leads the transform, in CSS px", () => {
    const base = { x: 0, y: 0, scale: 1, rotate: 0 };
    expect(clipTransform(base, project)).toBe("translate(0%, 0%) scale(1) rotate(0deg)");
    const fx = { scale: 1.25, dx: 10, dy: -4, white: 0, split: 0, blur: 0 };
    expect(clipTransform({ ...base, scale: 2, fx }, project, 0.4)).toBe("translate(4px, -1.6px) translate(0%, 0%) scale(2.5) rotate(0deg)");
  });

  it("scales pixel effects to CSS px and undoes the overlay's own scale; none for zoom and shake alone", () => {
    expect(effectPixels({ scale: 1.2, dx: 3, dy: 3, white: 0, split: 0, blur: 0 }, 0.4)).toBeNull();
    expect(effectPixels(null, 0.4)).toBeNull();
    expect(effectPixels({ scale: 1, dx: 0, dy: 0, white: 0.5, split: 13, blur: 20 }, 0.4)).toEqual({ split: 5.2, blur: 8, white: 0.5 });
    expect(effectPixels({ scale: 1, dx: 0, dy: 0, white: 0, split: 13, blur: 20 }, 0.4, 2)).toEqual({ split: 2.6, blur: 4, white: 0 });
  });

  it("flash mixes each channel towards white and keeps alpha (effects.ts flashAt)", () => {
    const m = flashMatrix(0.25);
    expect(m.slice(0, 5)).toEqual([0.75, 0, 0, 0, 0.25]);
    expect(m.slice(15)).toEqual([0, 0, 0, 1, 0]);
  });
});
