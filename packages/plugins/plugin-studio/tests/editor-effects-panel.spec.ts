import { describe, expect, it } from "vitest";
import { normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { applyOps } from "../src/video-edit/ops.js";
import { clearEffectsOps, EFFECT_IDS, hasEffectsPanel, setEffectIntensityOps, toggleEffectOps } from "../src/ui/editor/effects-panel.js";
import type { LookEdit } from "../src/ui/editor/look-panel.js";

const docOf = (extra: Record<string, unknown> = {}): EditDoc =>
  normalizeEdit({ tracks: [{ id: "v", kind: "video", clips: [{ id: "a", assetId: "a1", version: 1, start: 0, in: 0, out: 4, ...extra }] }] });
const find = (doc: EditDoc) => doc.tracks[0].clips[0] as MediaClip;
const run = (doc: EditDoc, edit: LookEdit | null, which: "ops" | "undo" = "ops"): EditDoc => {
  if (!edit) throw new Error("no edit");
  return applyOps(doc, edit[which]);
};

describe("effects panel ops", () => {
  it("lists the five effects and only video and overlay get the panel", () => {
    expect([...EFFECT_IDS]).toEqual(["zoomPunch", "shake", "flash", "rgbSplit", "blurIn"]);
    expect(hasEffectsPanel("video") && hasEffectsPanel("overlay")).toBe(true);
    expect(hasEffectsPanel("text") || hasEffectsPanel("audio")).toBe(false);
  });
  it("toggles an effect on at full strength, off again, and undoes both", () => {
    const d0 = docOf();
    const d1 = run(d0, toggleEffectOps(find(d0), "shake"));
    expect(find(d1).effects).toEqual([{ id: "shake", intensity: 1 }]);
    expect(find(run(d1, toggleEffectOps(find(d1), "shake")) ).effects).toBeUndefined();
    expect(find(run(d1, toggleEffectOps(find(d0), "shake"), "undo")).effects).toBeUndefined();
    const d2 = run(d1, toggleEffectOps(find(d1), "shake"));
    expect(find(run(d2, toggleEffectOps(find(d1), "shake"), "undo")).effects).toEqual([{ id: "shake", intensity: 1 }]);
  });
  it("refuses a fourth effect", () => {
    const d = docOf({ effects: [{ id: "zoomPunch" }, { id: "shake" }, { id: "flash" }] });
    expect(toggleEffectOps(find(d), "blurIn")).toBeNull();
    expect(toggleEffectOps(find(d), "flash")).not.toBeNull();
  });
  it("sets, clamps and removes a strength; undo restores it", () => {
    const d0 = docOf({ effects: [{ id: "flash", intensity: 1 }] });
    const d1 = run(d0, setEffectIntensityOps(find(d0), "flash", 0.4));
    expect(find(d1).effects).toEqual([{ id: "flash", intensity: 0.4 }]);
    expect(find(run(d1, setEffectIntensityOps(find(d0), "flash", 0.4), "undo")).effects).toEqual([{ id: "flash", intensity: 1 }]);
    expect(setEffectIntensityOps(find(d0), "flash", 1)).toBeNull();
    expect(setEffectIntensityOps(find(d0), "flash", Number.NaN)).toBeNull();
    expect(setEffectIntensityOps(find(d0), "shake", 0.5)).toBeNull();
    expect(find(run(d0, setEffectIntensityOps(find(d0), "flash", 0))).effects).toBeUndefined();
    const half = docOf({ effects: [{ id: "flash", intensity: 0.5 }] });
    expect(find(run(half, setEffectIntensityOps(find(half), "flash", 7))).effects).toEqual([{ id: "flash", intensity: 1 }]);
  });
  it("clears every effect in one batch and undoes it", () => {
    const d0 = docOf({ effects: [{ id: "shake", intensity: 0.5 }, { id: "blurIn", intensity: 1 }] });
    const edit = clearEffectsOps(find(d0));
    expect(find(run(d0, edit)).effects).toBeUndefined();
    expect(find(run(run(d0, edit), edit, "undo")).effects).toEqual([{ id: "shake", intensity: 0.5 }, { id: "blurIn", intensity: 1 }]);
    expect(clearEffectsOps(find(docOf()))).toBeNull();
  });
});
