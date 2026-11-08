import { describe, expect, it } from "vitest";
import { assignSlots, buildPreviewPlan, frameAt, sourceTimeAt, timelineTimeAt, type PreviewSlots } from "../src/ui/editor/preview-plan.js";
import type { EditDoc } from "../src/video-edit/timeline.js";

type Opts = { speed?: number; volume?: number; fadeIn?: number; fadeOut?: number; transition?: number };
const clip = (id: string, start: number, inn: number, out: number, o: Opts = {}) => ({
  id, assetId: "a-" + id, version: 1, start, in: inn, out, speed: o.speed ?? 1, volume: o.volume ?? 1, fadeIn: o.fadeIn ?? 0, fadeOut: o.fadeOut ?? 0,
  transitionIn: o.transition ? { type: "fade", duration: o.transition } : null,
});
const docOf = (...clips: ReturnType<typeof clip>[]) =>
  ({ schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [{ id: "v1", kind: "video", clips }, { id: "a1", kind: "audio", clips: [] }] }) as unknown as EditDoc;

// Three clips: a 0..3, b at speed 2 (source 0..4 => 2s on the timeline) 3..5, a gap 5..6, c 6..8.
const three = docOf(clip("c", 6, 1, 3), clip("a", 0, 2, 5), clip("b", 3, 0, 4, { speed: 2 }));

describe("preview plan", () => {
  it("orders the segments and ends at the last clip", () => {
    const plan = buildPreviewPlan(three);
    expect(plan.segments.map((s) => [s.clipId, s.start, s.end])).toEqual([["a", 0, 3], ["b", 3, 5], ["c", 6, 8]]);
    expect(plan.end).toBe(8);
    expect(buildPreviewPlan(null)).toEqual({ segments: [], end: 0 });
  });

  it("maps timeline time to source time with speed", () => {
    const plan = buildPreviewPlan(three);
    expect(frameAt(plan, 1).segment?.clipId).toBe("a");
    expect(frameAt(plan, 1).sourceTime).toBe(3);
    const b = frameAt(plan, 4);
    expect(b.segment?.clipId).toBe("b");
    expect(b.sourceTime).toBe(2); // 1s into b at 2x
    expect(timelineTimeAt(b.segment!, 2)).toBe(4);
    expect(frameAt(plan, 7).sourceTime).toBe(2);
  });

  it("hands over at a boundary: a clip's end belongs to the next clip", () => {
    const plan = buildPreviewPlan(three);
    const at3 = frameAt(plan, 3);
    expect(at3.segment?.clipId).toBe("b");
    expect(at3.sourceTime).toBe(0);
    expect(frameAt(plan, 2.999).segment?.clipId).toBe("a");
    expect(frameAt(plan, 2.999).next?.clipId).toBe("b");
    // Rounding noise at the edge does not show the old clip.
    expect(frameAt(plan, 3 - 1e-9).segment?.clipId).toBe("b");
  });

  it("shows black in a gap and names the clip to preload", () => {
    const plan = buildPreviewPlan(three);
    const gap = frameAt(plan, 5);
    expect(gap.kind).toBe("gap");
    expect(gap.segment).toBeNull();
    expect(gap.opacity).toBe(0);
    expect(gap.volume).toBe(0);
    expect(gap.next?.clipId).toBe("c");
    expect(frameAt(plan, 5.5).next?.clipId).toBe("c");
    expect(frameAt(plan, 6).segment?.clipId).toBe("c");
  });

  it("starts with a gap when the first clip starts late", () => {
    const plan = buildPreviewPlan(docOf(clip("x", 2, 0, 1)));
    expect(frameAt(plan, 0).kind).toBe("gap");
    expect(frameAt(plan, 0).next?.clipId).toBe("x");
  });

  it("ends at and past the end, and with no clips", () => {
    const plan = buildPreviewPlan(three);
    expect(frameAt(plan, 8).kind).toBe("end");
    expect(frameAt(plan, 99).kind).toBe("end");
    expect(frameAt(plan, 7.999).segment?.clipId).toBe("c");
    expect(frameAt(buildPreviewPlan(docOf()), 0).kind).toBe("end");
  });

  it("keeps the source time inside in..out", () => {
    const [b] = buildPreviewPlan(docOf(clip("b", 0, 1, 2))).segments;
    expect(sourceTimeAt(b, -1)).toBe(1);
    expect(sourceTimeAt(b, 5)).toBeCloseTo(1.999, 6);
  });

  it("fades opacity and volume in and out, and caps volume at 1", () => {
    const plan = buildPreviewPlan(docOf(clip("f", 0, 0, 4, { fadeIn: 1, fadeOut: 2, volume: 2 })));
    expect(frameAt(plan, 0).opacity).toBe(0);
    expect(frameAt(plan, 0.5).opacity).toBe(0.5);
    expect(frameAt(plan, 0.5).volume).toBe(1); // 2 x 0.5
    expect(frameAt(plan, 1.5).opacity).toBe(1);
    expect(frameAt(plan, 1.5).volume).toBe(1);
    expect(frameAt(plan, 3).opacity).toBe(0.5);
    expect(frameAt(plan, 3.5).opacity).toBe(0.25);
  });

  it("previews a fade-in transition as a fade from black", () => {
    const plan = buildPreviewPlan(docOf(clip("a", 0, 0, 2), clip("t", 2, 0, 2, { transition: 0.5, volume: 0.8 })));
    expect(frameAt(plan, 2.25).opacity).toBe(0.5);
    expect(frameAt(plan, 2.25).volume).toBeCloseTo(0.4, 6);
    expect(frameAt(plan, 3).opacity).toBe(1);
  });

  it("plays a 3-clip edit through two slots: each hand-over shows the preloaded slot", () => {
    const plan = buildPreviewPlan(three);
    let slots: PreviewSlots = { slots: [null, null], active: 0 };
    const seen: string[] = [];
    for (let t = 0; t < plan.end; t += 0.25) {
      const f = frameAt(plan, t);
      const before = slots;
      slots = assignSlots(slots, f.segment, f.next);
      expect(assignSlots(slots, f.segment, f.next)).toEqual(slots); // idempotent
      if (f.segment) {
        expect(slots.slots[slots.active]).toBe(f.segment.clipId);
        // Entering a new clip: it was already preloaded in the other slot.
        if (seen.length && seen[seen.length - 1] !== f.segment.clipId) expect(before.slots).toContain(f.segment.clipId);
        if (seen[seen.length - 1] !== f.segment.clipId) seen.push(f.segment.clipId);
      }
      if (f.next) expect(slots.slots).toContain(f.next.clipId);
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("puts a scrubbed-to clip into a slot that does not hold the next clip", () => {
    const plan = buildPreviewPlan(three);
    const f = frameAt(plan, 4); // b, next c
    const s = assignSlots({ slots: ["c", "a"], active: 1 }, f.segment, f.next);
    expect(s).toEqual({ slots: ["c", "b"], active: 1 });
  });

  it("shows the later clip where two video tracks overlap", () => {
    const doc = { schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [
      { id: "v1", kind: "video", clips: [clip("base", 0, 0, 10)] },
      { id: "v2", kind: "video", clips: [clip("top", 2, 0, 2)] },
    ] } as unknown as EditDoc;
    const plan = buildPreviewPlan(doc);
    expect(frameAt(plan, 1).segment?.clipId).toBe("base");
    expect(frameAt(plan, 1).next?.clipId).toBe("top");
    expect(frameAt(plan, 3).segment?.clipId).toBe("top");
    expect(frameAt(plan, 5).segment?.clipId).toBe("base");
    expect(frameAt(plan, 5).sourceTime).toBe(5);
  });
});
