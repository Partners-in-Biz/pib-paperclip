import { describe, expect, it } from "vitest";
import { normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { applyOps } from "../src/video-edit/ops.js";
import { BLEND_MODES, blendOf, currentPip, moveTrackOps, PIP_CORNERS, PIP_SCALE, pipTransform, resetPipOps, setBlendOps, setPipOps, type LayerEdit, type PipSize } from "../src/ui/editor/layer-panel.js";

const media = (id: string, start: number, extra: Record<string, unknown> = {}) => ({ id, assetId: "a1", version: 1, start, in: 0, out: 4, ...extra });
const docOf = (extra: Record<string, unknown> = {}): EditDoc =>
  normalizeEdit({ tracks: [
    { id: "v", kind: "video", clips: [media("a", 0)] },
    { id: "o1", kind: "overlay", clips: [media("p", 0, extra)] },
    { id: "o2", kind: "overlay", clips: [media("q", 0)] },
  ] });
const clipP = (doc: EditDoc) => doc.tracks[1].clips[0] as MediaClip;
const run = (doc: EditDoc, edit: LayerEdit | null, which: "ops" | "undo" = "ops"): EditDoc => {
  if (!edit) throw new Error("no edit");
  return applyOps(doc, edit[which]);
};

describe("layer panel ops", () => {
  it("writes each of the 12 PiP presets through the real applier and recognises it again", () => {
    const doc = docOf();
    for (const { corner } of PIP_CORNERS) for (const size of Object.keys(PIP_SCALE) as PipSize[]) {
      const next = run(doc, setPipOps(doc.project, clipP(doc), corner, size));
      expect(currentPip(next.project, clipP(next))).toEqual({ corner, size });
      const t = clipP(next).transform;
      // The clip stays inside the frame.
      expect(Math.abs(t.x) + (doc.project.width * t.scale) / 2).toBeLessThan(doc.project.width / 2);
      expect(Math.abs(t.y) + (doc.project.height * t.scale) / 2).toBeLessThan(doc.project.height / 2);
    }
  });
  it("puts top-left at negative x and y, bottom-right at positive", () => {
    const p = { width: 1080, height: 1920 };
    expect(pipTransform(p, "top-left", "M")).toMatchObject({ x: expect.any(Number), scale: 0.33 });
    expect(pipTransform(p, "top-left", "M").x).toBeLessThan(0);
    expect(pipTransform(p, "top-left", "M").y).toBeLessThan(0);
    expect(pipTransform(p, "bottom-right", "S").x).toBeGreaterThan(0);
    expect(pipTransform(p, "bottom-right", "S").y).toBeGreaterThan(0);
  });
  it("gives no edit for the preset already set, undoes a preset, and resets to the full frame", () => {
    let doc = docOf();
    const first = setPipOps(doc.project, clipP(doc), "top-right", "L");
    const after = run(doc, first);
    expect(setPipOps(after.project, clipP(after), "top-right", "L")).toBeNull();
    expect(run(after, first, "undo").tracks[1].clips[0]).toEqual(clipP(doc));
    doc = run(after, resetPipOps(clipP(after)));
    expect(clipP(doc).transform).toMatchObject({ x: 0, y: 0, scale: 1 });
    expect(resetPipOps(clipP(doc))).toBeNull();
  });
  it("sets, undoes and removes a blend mode (normal removes it)", () => {
    const doc = docOf();
    expect(blendOf(clipP(doc))).toBe("normal");
    for (const m of BLEND_MODES.filter((x) => x !== "normal")) expect(blendOf(clipP(run(doc, setBlendOps(clipP(doc), m))))).toBe(m);
    const screen = run(doc, setBlendOps(clipP(doc), "screen"));
    expect(setBlendOps(clipP(screen), "screen")).toBeNull();
    expect(clipP(run(screen, setBlendOps(clipP(screen), "normal"))).blendMode).toBeUndefined();
    expect(clipP(run(screen, setBlendOps(clipP(doc), "screen"), "undo")).blendMode).toBeUndefined();
    expect(setBlendOps(clipP(doc), "bogus")).toBeNull();
  });
  it("moves a track up or down one step, with its undo, and stops at the ends", () => {
    const doc = docOf();
    expect(moveTrackOps(doc, "v", "up")).toBeNull();
    expect(moveTrackOps(doc, "o2", "down")).toBeNull();
    expect(moveTrackOps(doc, "nope", "up")).toBeNull();
    const down = moveTrackOps(doc, "o1", "down");
    const moved = run(doc, down);
    expect(moved.tracks.map((t) => t.id)).toEqual(["v", "o2", "o1"]);
    expect(run(moved, down, "undo").tracks.map((t) => t.id)).toEqual(["v", "o1", "o2"]);
    expect(run(doc, moveTrackOps(doc, "o2", "up")).tracks.map((t) => t.id)).toEqual(["v", "o2", "o1"]);
  });
});
