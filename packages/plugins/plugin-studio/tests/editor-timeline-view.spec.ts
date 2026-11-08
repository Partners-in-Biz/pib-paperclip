import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, type Clip, type EditDoc } from "../src/video-edit/timeline.js";
import {
  clipLabel,
  clipUnderPlayhead,
  docLength,
  fitScale,
  formatTime,
  hitTest,
  MAX_PX_PER_SECOND,
  MIN_CLIP_SECONDS,
  MIN_PX_PER_SECOND,
  pxToSeconds,
  secondsToPx,
  tickStep,
  rippleBox,
  trimResult,
} from "../src/ui/editor/timeline-view.js";

const transform = { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
const media = (id: string, start: number, inPoint: number, out: number, speed = 1) =>
  ({ id, assetId: "a1", version: 1, start, in: inPoint, out, speed, volume: 1, fadeIn: 0, fadeOut: 0, transform, transitionIn: null }) as Clip;
const text = (id: string, start: number, duration: number) =>
  ({ id, text: `Hello ${id}`, start, duration, font: null, color: "#ffffff", fontSize: 48, fadeIn: 0, fadeOut: 0, transform, transitionIn: null }) as Clip;
const doc = (): EditDoc =>
  ({
    schemaVersion: 1,
    project: { size: "9:16", width: 1080, height: 1920, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", clips: [media("a", 0, 0, 4), media("b", 4, 2, 8), media("c", 12, 0, 2)] },
      { id: "o1", kind: "overlay", clips: [media("o", 5, 0, 2)] },
      { id: "t1", kind: "text", clips: [text("t", 0, 3)] },
    ],
  }) as unknown as EditDoc;

describe("px <-> seconds", () => {
  it("converts both ways and rounds to ms", () => {
    expect(secondsToPx(2.5, 40)).toBe(100);
    expect(pxToSeconds(100, 40)).toBe(2.5);
    expect(pxToSeconds(1, 3)).toBe(0.333);
    expect(pxToSeconds(-20, 40)).toBe(-0.5);
    expect(pxToSeconds(10, 0)).toBe(0);
    for (const s of [0, 0.125, 7, 179.999]) expect(pxToSeconds(secondsToPx(s, 37), 37)).toBe(s);
  });
  it("fits the edit into the width within the zoom limits", () => {
    expect(fitScale(10, 500)).toBe(50);
    expect(fitScale(0, 500)).toBe(50); // empty edit shows 10 s
    expect(fitScale(180, 300)).toBe(MIN_PX_PER_SECOND);
    expect(fitScale(1, 5000)).toBe(MAX_PX_PER_SECOND);
    expect(fitScale(10, -5)).toBe(MIN_PX_PER_SECOND);
  });
  it("picks a readable ruler step and formats times", () => {
    expect(tickStep(100)).toBe(1);
    expect(tickStep(20)).toBe(5);
    expect(tickStep(0.5)).toBe(60);
    expect(formatTime(83.25)).toBe("1:23.3");
    expect(formatTime(59.96)).toBe("1:00.0");
    expect(formatTime(-1)).toBe("0:00.0");
  });
});

describe("hitTest", () => {
  const clips = doc().tracks[0].clips as Clip[];
  it("finds the body and both trim edges", () => {
    // 10 px/s, 8 px edge = 0.8 s
    expect(hitTest(clips, 2, 10, 8)).toEqual({ clipId: "a", part: "body" });
    expect(hitTest(clips, 0.5, 10, 8)).toEqual({ clipId: "a", part: "in" });
    expect(hitTest(clips, 3.5, 10, 8)).toEqual({ clipId: "a", part: "out" });
    expect(hitTest(clips, 4, 10, 8)).toEqual({ clipId: "b", part: "in" }); // a shared edge belongs to the clip that starts there
  });
  it("returns null on empty space", () => {
    expect(hitTest(clips, 11, 10)).toBeNull();
    expect(hitTest(clips, 15, 10)).toBeNull();
    expect(hitTest([], 1, 10)).toBeNull();
  });
  it("keeps a short clip's middle selectable and gives untrimmable clips no edges", () => {
    expect(hitTest([media("s", 0, 0, 0.3)], 0.15, 10, 8)).toEqual({ clipId: "s", part: "body" });
    expect(hitTest(doc().tracks[2].clips as Clip[], 0.1, 10, 8)).toEqual({ clipId: "t", part: "body" });
  });
});

describe("clipUnderPlayhead", () => {
  it("picks the top-most picture track", () => {
    expect(clipUnderPlayhead(doc(), 1)?.clip.id).toBe("a");
    expect(clipUnderPlayhead(doc(), 5.5)?.clip.id).toBe("o"); // overlay sits above video
    expect(clipUnderPlayhead(doc(), 7)?.clip.id).toBe("b");
    expect(clipUnderPlayhead(doc(), 4)?.clip.id).toBe("b"); // end is exclusive
  });
  it("is null in a gap, past the end, or with no doc", () => {
    expect(clipUnderPlayhead(doc(), 11)).toBeNull();
    expect(clipUnderPlayhead(doc(), 30)).toBeNull();
    expect(clipUnderPlayhead(null, 0)).toBeNull();
  });
  it("can look at other kinds", () => {
    expect(clipUnderPlayhead(doc(), 1, ["text"])?.clip.id).toBe("t");
  });
});

describe("trimResult", () => {
  it("trims the out edge with one trim op", () => {
    const r = trimResult(media("a", 0, 0, 4), "out", -1.5);
    expect(r).toEqual({ start: 0, end: 2.5, shift: -1.5, ops: [{ op: "trim", clipId: "a", out: 2.5, ripple: true }] });
    expect(trimResult(media("a", 0, 0, 4, 2), "out", 1)?.ops).toEqual([{ op: "trim", clipId: "a", out: 6, ripple: true }]);
    // Alt held: a free trim, the later clips stay put.
    expect(trimResult(media("a", 0, 0, 4), "out", -1.5, true)).toEqual({ start: 0, end: 2.5, shift: 0, ops: [{ op: "trim", clipId: "a", out: 2.5, ripple: false }] });
  });
  it("ripples the in edge by default: one trim, start kept, later clips shift by the change in length", () => {
    expect(trimResult(media("b", 4, 2, 8), "in", 1)).toEqual({ start: 4, end: 9, shift: -1, ops: [{ op: "trim", clipId: "b", in: 3, ripple: true }] });
    expect(trimResult(media("b", 4, 2, 8), "in", -1)).toEqual({ start: 4, end: 11, shift: 1, ops: [{ op: "trim", clipId: "b", in: 1, ripple: true }] });
    expect(trimResult(media("x", 1, 5, 8), "in", -10)).toMatchObject({ start: 1, end: 9 }); // only in >= 0 limits a ripple
  });
  it("free (Alt) keeps the end still on the in edge: shrink is trim then move, grow is move then trim", () => {
    expect(trimResult(media("b", 4, 2, 8), "in", 1, true)).toEqual({ start: 5, end: 10, shift: 0, ops: [{ op: "trim", clipId: "b", in: 3, ripple: false }, { op: "move", clipId: "b", start: 5 }] });
    expect(trimResult(media("b", 4, 2, 8), "in", -1, true)).toEqual({ start: 3, end: 10, shift: 0, ops: [{ op: "move", clipId: "b", start: 3 }, { op: "trim", clipId: "b", in: 1, ripple: false }] });
  });
  it("clamps at the source start, the timeline start and the shortest clip", () => {
    expect(trimResult(media("b", 4, 2, 8), "in", -10, true)?.start).toBe(2); // in can't go below 0
    expect(trimResult(media("x", 1, 5, 8), "in", -10, true)?.start).toBe(0); // start can't go below 0
    expect(trimResult(media("a", 0, 0, 4), "out", -10)?.end).toBe(MIN_CLIP_SECONDS);
    expect(trimResult(media("b", 4, 2, 8), "in", 99, true)?.start).toBe(ms(10 - MIN_CLIP_SECONDS));
  });
  it("is null for no change or an untrimmable clip", () => {
    expect(trimResult(media("a", 0, 0, 4), "out", 0)).toBeNull();
    expect(trimResult(media("a", 0, 0, 4), "in", -1)).toBeNull(); // already at in 0 and start 0
    expect(trimResult(text("t", 0, 3), "out", 1)).toBeNull();
    expect(trimResult(media("a", 0, 0, 4), "out", Number.NaN)).toBeNull();
  });
  it("produces batches the worker accepts, with neighbours touching", () => {
    // b sits right after a; growing b's in edge into the gap and a's out edge to meet it must not overlap at any step.
    const base = doc();
    const shrinkIn = trimResult(media("b", 4, 2, 8), "in", 1, true)!;
    const afterShrink = applyOps(base, shrinkIn.ops);
    const b = (afterShrink.tracks[0].clips as Clip[]).find((c) => c.id === "b")!;
    expect(b).toMatchObject({ start: 5, in: 3, out: 8 });
    const growIn = trimResult(b, "in", -1, true)!;
    const back = applyOps(afterShrink, growIn.ops);
    expect((back.tracks[0].clips as Clip[]).find((c) => c.id === "b")).toMatchObject({ start: 4, in: 2, out: 8 });
    const growA = trimResult(media("a", 0, 0, 4), "out", 0.5, true)!;
    expect(() => applyOps(base, growA.ops)).toThrow(); // would overlap b: the worker refuses, nothing applies
  });
});

describe("ripple trim (PAR-8324)", () => {
  // Three clips back to back on one track, a gap before the third, and a clip on another track.
  const three = (): EditDoc => normalizeEdit({
    schemaVersion: 1,
    project: { size: "9:16", fps: 30 },
    tracks: [
      { id: "v", kind: "video", clips: [media("c1", 0, 0, 4), media("c2", 4, 0, 4), media("c3", 9, 0, 4)] },
      { id: "m", kind: "audio", clips: [media("music", 4, 0, 6)] },
    ],
  });
  const starts = (doc: EditDoc, id: string) => (doc.tracks.find((t) => t.id === id)!.clips as Clip[]).map((c) => c.start);

  it("one ops batch per gesture; after a reload clips 2 and 3 start earlier with no new gap", () => {
    const doc = three();
    const r = trimResult((doc.tracks[0].clips as Clip[])[0], "out", -1)!;
    expect(r.ops).toHaveLength(1);
    const reloaded = normalizeEdit(JSON.parse(JSON.stringify(applyOps(doc, r.ops))));
    expect(starts(reloaded, "v")).toEqual([0, 3, 8]); // c2 touches c1, c3 keeps its 1 s gap
    expect(starts(reloaded, "m")).toEqual([4]);
  });
  it("Alt (free) leaves the gap", () => {
    const doc = three();
    const r = trimResult((doc.tracks[0].clips as Clip[])[0], "out", -1, true)!;
    expect(starts(applyOps(doc, r.ops), "v")).toEqual([0, 4, 9]);
  });
  it("rippleBox previews the later clips moving, and nothing else", () => {
    const clips = three().tracks[0].clips as Clip[];
    const r = trimResult(clips[0], "out", -1)!;
    expect(clips.map((c) => rippleBox(c, clips[0], r))).toEqual([{ start: 0, end: 4 }, { start: 3, end: 7 }, { start: 8, end: 12 }]);
    const free = trimResult(clips[0], "out", -1, true)!;
    expect(rippleBox(clips[1], clips[0], free)).toEqual({ start: 4, end: 8 });
  });
});

describe("labels and length", () => {
  it("names clips and measures the doc", () => {
    expect(clipLabel(text("t", 0, 3))).toBe("Hello t");
    expect(clipLabel(media("a", 0, 0, 4))).toBe("a");
    expect(clipLabel({ id: "cap", start: 0, style: "plain", words: [{ text: "hi", start: 0, end: 1 }, { text: "there", start: 1, end: 2 }] } as Clip)).toBe("hi there");
    expect(docLength(doc())).toBe(14);
    expect(docLength(null)).toBe(0);
  });
});

function ms(n: number) {
  return Math.round(n * 1000) / 1000;
}
