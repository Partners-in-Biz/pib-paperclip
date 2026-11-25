import { describe, expect, it } from "vitest";
import { assignSlots, buildPreviewPlan, clipTransform, frameAt, keyedText, transitionMix } from "../src/ui/editor/preview-plan.js";
import { TRANSITIONS, type EditDoc, type Keyframes, type TextClip, type TransitionType } from "../src/video-edit/timeline.js";

// PAR-8449: the D1-REL golden shape. Three 3 s clips on the main track, 0.5 s transitions (wipeleft, fadeblack); clip b
// carries x/y/scale/rotate/opacity keyframes. Sample times: each clip's first frame, mid-clip, inside every window.
const T = { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
const media = (id: string, start: number, transitionIn: { type: TransitionType; duration: number } | null, keyframes?: Keyframes) =>
  ({ id, assetId: "a-" + id, version: 1, start, in: 0, out: 3, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, transform: T, transitionIn, ...(keyframes ? { keyframes } : {}) });
const KB: Keyframes = {
  x: [{ t: 0, value: 0, ease: "linear" }, { t: 2, value: 540, ease: "linear" }],
  y: [{ t: 0, value: -480, ease: "easeOut" }, { t: 3, value: 480, ease: "linear" }],
  scale: [{ t: 0, value: 1, ease: "easeInOut" }, { t: 2, value: 2, ease: "linear" }],
  rotate: [{ t: 0, value: 0, ease: "hold" }, { t: 1, value: 90, ease: "linear" }],
  opacity: [{ t: 0, value: 1, ease: "linear" }, { t: 3, value: 0.4, ease: "linear" }],
};
export const golden = {
  schemaVersion: 2, project: { size: "9:16", width: 1080, height: 1920, fps: 30 },
  tracks: [{ id: "v1", kind: "video", clips: [media("a", 0, null), media("b", 2.5, { type: "wipeleft", duration: 0.5 }, KB), media("c", 5, { type: "fadeblack", duration: 0.5 })] }],
} as unknown as EditDoc;
const plan = buildPreviewPlan(golden);
const ids = (t: number) => frameAt(plan, t).layers.map((l) => l.segment.clipId);

describe("preview plan: transitions and keyframes (PAR-8449)", () => {
  it("finds the xfade windows on the main track only", () => {
    expect(plan.segments.map((s) => [s.clipId, s.from, s.transition, s.transitionDuration, s.fadeIn])).toEqual([
      ["a", null, null, 0, 0], ["b", "a", "wipeleft", 0.5, 0], ["c", "b", "fadeblack", 0.5, 0],
    ]);
    expect(plan.end).toBe(8);
    const overlay = { ...golden, tracks: [{ id: "v1", kind: "video", clips: [media("a", 0, null)] }, { id: "v2", kind: "video", clips: [media("o", 1, { type: "wipeleft", duration: 0.5 })] }] } as unknown as EditDoc;
    expect(buildPreviewPlan(overlay).segments[1]).toMatchObject({ from: null, transition: null, fadeIn: 0.5 });
  });

  it("shows one layer outside windows and the keyed values at a clip's first frame and mid-clip", () => {
    expect(ids(0)).toEqual(["a"]);
    expect(frameAt(plan, 0).layers[0]).toMatchObject({ x: 0, y: 0, scale: 1, rotate: 0, alpha: 1, opacity: 1, clipPath: null, transform: null });
    expect(ids(3)).toEqual(["b"]);
    const mid = frameAt(plan, 4).layers[0]; // b at lt = 1.5
    expect(mid.x).toBeCloseTo(405, 6);
    expect(mid.y).toBeCloseTo(-480 + 960 * 0.5 * 1.5, 6); // easeOut at p = 0.5
    expect(mid.scale).toBeCloseTo(1 + 0.75 ** 2 * (3 - 1.5), 6);
    expect(mid.rotate).toBeCloseTo(90, 6);
    expect(mid.alpha).toBeCloseTo(1 - 0.6 * 0.5, 6);
    expect(clipTransform(mid, golden.project)).toMatch(/^translate\(37\.5%, 12\.5%\) scale\(1\.843[78]\) rotate\(90deg\)$/);
  });

  it("wipes b in over a: first frame of b, middle and end of the window", () => {
    const first = frameAt(plan, 2.5);
    expect(first.segment?.clipId).toBe("b");
    expect(ids(2.5)).toEqual(["a", "b"]);
    expect(first.layers[1]).toMatchObject({ clipPath: "inset(0 0 0 100%)", x: 0, y: -480, scale: 1, rotate: 0, alpha: 1 });
    const mid = frameAt(plan, 2.75);
    expect(mid.layers.map((l) => l.clipPath)).toEqual([null, "inset(0 0 0 50%)"]);
    expect(mid.layers[1].x).toBeCloseTo(67.5, 6);
    expect(mid.layers[0].sourceTime).toBeCloseTo(2.75, 6);
    expect(mid.layers[1].sourceTime).toBeCloseTo(0.25, 6);
    expect(mid.layers.map((l) => l.volume)).toEqual([0.5, 0.5]);
    expect(frameAt(plan, 2.999).layers[1].clipPath).toBe("inset(0 0 0 0.2%)");
  });

  it("dips through black between b and c, with b's keys still running", () => {
    const f = frameAt(plan, 5.25);
    expect(ids(5.25)).toEqual(["b", "c"]);
    expect(f.matte).toEqual({ color: "black", opacity: 1 });
    expect(f.layers.map((l) => l.opacity)).toEqual([0, 0.3418]);
    expect(f.layers[0].x).toBe(540);
    expect(f.layers[0].alpha).toBeCloseTo(1 - 0.6 * (2.75 / 3), 6);
    const early = frameAt(plan, 5.01).layers[0];
    expect(early.opacity).toBeGreaterThan(0.9);
  });

  it("every transition hides the incoming clip at p = 0 and shows it fully at p = 1", () => {
    const hidden = (l: { opacity: number; clipPath: string | null; transform: string | null }) =>
      l.opacity === 0 || /inset\([^)]*100%|circle\(0%/.test(l.clipPath ?? "") || /translate\((-?100%|0%, -?100%)/.test(l.transform ?? "");
    const full = (l: { opacity: number; clipPath: string | null; transform: string | null }) =>
      l.opacity === 1 && (!l.clipPath || /inset\(0 0 0 0%\)|inset\(0 0% 0 0\)|inset\(0% 0 0 0\)|inset\(0 0 0% 0\)|circle\(141/.test(l.clipPath)) && (!l.transform || /translate\(0%, 0%\)/.test(l.transform));
    for (const type of TRANSITIONS) {
      const start = transitionMix(type, 0);
      const end = transitionMix(type, 1);
      if (start.inOnTop) expect(hidden(start.in), type).toBe(true);
      else expect(start.out.clipPath, type).toBe("circle(141.4214% at 50% 50%)");
      expect(full(end.in) && (end.inOnTop || end.out.clipPath === "circle(0% at 50% 50%)"), type).toBe(true);
    }
    expect(transitionMix("slideleft", 0.25)).toMatchObject({ out: { transform: "translate(-25%, 0%)" }, in: { transform: "translate(75%, 0%)" } });
    expect(transitionMix("zoomin", 0.25)).toMatchObject({ out: { transform: "scale(2)" }, in: { opacity: 0 } });
    expect(transitionMix("fadewhite", 0.5).matte?.color).toBe("white");
  });

  it("keeps the outgoing clip in its slot through the window, then preloads the next", () => {
    let s = assignSlots({ slots: [null, null], active: 0 }, frameAt(plan, 1).segment, frameAt(plan, 1).next);
    expect(s).toEqual({ slots: ["a", "b"], active: 0 });
    const w = frameAt(plan, 2.75);
    s = assignSlots(s, w.segment, w.layers[0].segment);
    expect(s).toEqual({ slots: ["a", "b"], active: 1 });
    s = assignSlots(s, frameAt(plan, 3.5).segment, frameAt(plan, 3.5).next);
    expect(s).toEqual({ slots: ["c", "b"], active: 1 });
  });

  it("moves and fades text with its keyframes", () => {
    const text = { id: "t", start: 1, duration: 2, fadeIn: 0, fadeOut: 0, text: "Hi", font: null, color: "#FFFFFF", fontSize: 64, transform: T, transitionIn: null,
      keyframes: { x: [{ t: 0, value: -100, ease: "linear" }, { t: 2, value: 100, ease: "linear" }], opacity: [{ t: 0, value: 0, ease: "linear" }, { t: 1, value: 1, ease: "linear" }] } } as TextClip;
    const k = keyedText(text, 1.5, 0.8);
    expect(k.clip.transform.x).toBe(-50);
    expect(k.clip.transform.y).toBe(0);
    expect(k.opacity).toBeCloseTo(0.4, 6);
    const plain = { ...text, keyframes: undefined };
    expect(keyedText(plain, 1.5, 0.8)).toEqual({ clip: plain, opacity: 0.8 });
  });
});
