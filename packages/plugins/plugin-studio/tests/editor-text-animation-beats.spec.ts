import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";
import { ANIMATION_LABELS, ANIMATION_PRESETS, findTextClip, formOf, textEditOps } from "../src/ui/editor/text-track.js";
import { beatsAnswer, cutPlan, cuttableTracks, markerPercents } from "../src/ui/editor/beat-panel.js";
import { cutToBeatOps } from "../src/video-edit/cut-to-beat.js";

const doc = (extra: Record<string, unknown> = {}): EditDoc => normalizeEdit({
  tracks: [
    { id: "video", kind: "video", clips: [
      { id: "v1", assetId: "a1", version: 1, start: 0, in: 0, out: 2.3 },
      { id: "v2", assetId: "a1", version: 1, start: 2.3, in: 0, out: 2.2 },
    ] },
    { id: "titles", kind: "text", clips: [{ id: "t1", start: 0, duration: 4, text: "Hi", ...extra }] },
    { id: "audio", kind: "audio", clips: [{ id: "m1", assetId: "a2", version: 1, start: 0, in: 0, out: 4.5 }] },
  ],
});

describe("text animation picker", () => {
  const clip = (d: EditDoc) => findTextClip(d, "t1")!.clip;
  it("lists every schema preset with a label", () => {
    expect(ANIMATION_PRESETS.length).toBe(9);
    for (const a of ANIMATION_PRESETS) expect(ANIMATION_LABELS[a]).toBeTruthy();
  });
  it("sends nothing for an unchanged form, and an animation is applied through setProps", () => {
    const d = doc();
    expect(textEditOps(clip(d), formOf(clip(d)))).toBeNull();
    const made = textEditOps(clip(d), { ...formOf(clip(d)), animIn: "pop", animInDuration: "0.4", animOut: "fadeUp" });
    if (!made || "error" in made) throw new Error("expected ops");
    const back = clip(applyOps(d, made.ops as never));
    expect(back.animation).toEqual({ in: "pop", inDuration: 0.4, out: "fadeUp", outDuration: 0.5 });
    expect(formOf(back)).toMatchObject({ animIn: "pop", animInDuration: "0.4", animOut: "fadeUp", animOutDuration: "0.5" });
  });
  it("removes one side, then both, with the merge the worker takes", () => {
    const d = doc({ animation: { in: "pop", out: "bounce" } });
    const one = textEditOps(clip(d), { ...formOf(clip(d)), animOut: "" }) as { ops: never[] };
    expect(clip(applyOps(d, one.ops)).animation).toEqual({ in: "pop", inDuration: 0.5 });
    const none = textEditOps(clip(d), { ...formOf(clip(d)), animIn: "", animOut: "" }) as { ops: { props: Record<string, unknown> }[] };
    expect(none.ops[0].props.animation).toBeNull();
    expect(clip(applyOps(d, none.ops as never)).animation).toBeUndefined();
  });
  it("refuses an unknown preset, a bad length and animations longer than the clip before the worker", () => {
    const c = clip(doc());
    expect(textEditOps(c, { ...formOf(c), animIn: "spin" })).toHaveProperty("error");
    expect(textEditOps(c, { ...formOf(c), animIn: "pop", animInDuration: "9" })).toHaveProperty("error");
    expect(textEditOps(c, { ...formOf(c), animIn: "pop", animInDuration: "3", animOut: "pop", animOutDuration: "2" })).toHaveProperty("error");
    expect(textEditOps(c, { ...formOf(c), duration: "0.5", animIn: "pop", animInDuration: "0.4", animOut: "pop", animOutDuration: "0.4" })).toHaveProperty("error");
  });
});

describe("beat markers", () => {
  it("reads the worker answer and refuses a malformed one", () => {
    expect(beatsAnswer({ tempo: 120, timelineBeats: [0.5, "x", 1], cached: true })).toEqual({ tempo: 120, timelineBeats: [0.5, 1], cached: true });
    expect(beatsAnswer({ tempo: 120 })).toBeNull();
    expect(beatsAnswer(null)).toBeNull();
  });
  it("places markers as a percentage of the clip and thins out a huge list", () => {
    expect(markerPercents([0, 1, 2, 5], 0, 4)).toEqual([0, 25, 50]);
    expect(markerPercents([1], 0, 0)).toEqual([]);
    expect(markerPercents(Array.from({ length: 2000 }, (_, i) => i / 10), 0, 200).length).toBeLessThanOrEqual(400);
  });
  it("offers only video and overlay tracks that hold clips", () => {
    expect(cuttableTracks(doc())).toEqual([{ id: "video", kind: "video", clips: 2 }]);
    expect(cuttableTracks(null)).toEqual([]);
  });
});

describe("cut to beat preview and undo", () => {
  const d = doc();
  const ops = cutToBeatOps(d, "video", [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], 0.5 + 0.001);
  it("lists each cut and the undo restores the original doc exactly", () => {
    const plan = cutPlan(d, ops)!;
    expect(plan.rows.length).toBe(ops.length);
    expect(ops.length).toBeGreaterThan(0);
    expect(plan.rows[0]).toMatchObject({ clipId: "v1", from: 2.3, to: 2, cutAt: 2 });
    const cut = applyOps(d, plan.ops as never);
    expect(cut).not.toEqual(d);
    expect(applyOps(cut, plan.undo as never)).toEqual(d);
  });
  it("returns null for ops that do not fit the doc", () => {
    expect(cutPlan(d, [{ op: "trim", clipId: "nope", out: 1 }])).toBeNull();
    expect(cutPlan(d, "x")).toBeNull();
  });
});
