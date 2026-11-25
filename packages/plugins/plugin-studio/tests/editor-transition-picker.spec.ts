import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, TRANSITIONS, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { clipJoins, MAX_TRANSITION_SECONDS, TRANSITION_LABELS, TRANSITION_TYPES, transitionOps } from "../src/ui/editor/timeline-view.js";

const media = (id: string, start: number, out: number, transitionIn: unknown = null) => ({ id, assetId: "a1", version: 1, start, in: 0, out, transitionIn });
const docOf = (clips: ReturnType<typeof media>[], extra: unknown[] = []): EditDoc => normalizeEdit({ tracks: [{ id: "video", kind: "video", clips }, ...extra] });
const starts = (doc: EditDoc) => (doc.tracks[0].clips as MediaClip[]).map((c) => `${c.id}@${c.start}`);
const tr = (doc: EditDoc, id: string) => (doc.tracks[0].clips as MediaClip[]).find((c) => c.id === id)!.transitionIn;

describe("transition list", () => {
  it("is the worker's 15 xfade types, each with a label", () => {
    expect([...TRANSITION_TYPES]).toEqual([...TRANSITIONS]);
    expect(TRANSITION_TYPES).toHaveLength(15);
    for (const t of TRANSITION_TYPES) expect(TRANSITION_LABELS[t]).toBeTruthy();
  });
});

describe("clipJoins", () => {
  it("lists back-to-back and overlapping main-track clips, not gaps", () => {
    const doc = docOf([media("a", 0, 3), media("b", 3, 3), media("c", 5.5, 2, { type: "wipeleft", duration: 0.5 }), media("d", 9, 2)]);
    const joins = clipJoins(doc);
    expect(joins.map((j) => `${j.fromId}>${j.toId}`)).toEqual(["a>b", "b>c"]);
    expect(joins[0]).toMatchObject({ at: 3, overlap: 0, transition: null, maxDuration: 2.5 }) // b keeps 0.5 s for its b>c window;
    expect(joins[1]).toMatchObject({ at: 5.75, overlap: 0.5, transition: { type: "wipeleft", duration: 0.5 } });
    // c is 2 s long: the cap is the shorter side.
    expect(joins[1].maxDuration).toBe(2);
  });
  it("caps at the worker limit and leaves the other window of each clip whole", () => {
    const doc = docOf([media("a", 0, 20), media("b", 19, 2, { type: "fade", duration: 1 }), media("c", 21, 20)]);
    const [ab, bc] = clipJoins(doc);
    expect(ab.maxDuration).toBe(2);
    expect(bc.maxDuration).toBe(1); // b is 2 s, 1 s of it is the a>b window
    expect(clipJoins(docOf([media("a", 0, 20), media("b", 20, 20)]))[0].maxDuration).toBe(MAX_TRANSITION_SECONDS);
  });
  it("only the main track: none when the first picture track is an overlay or there is no video", () => {
    expect(clipJoins(null)).toEqual([]);
    const overlayFirst = normalizeEdit({ tracks: [{ id: "o", kind: "overlay", clips: [media("x", 0, 2), media("y", 2, 2)] }, { id: "v", kind: "video", clips: [media("a", 0, 2), media("b", 2, 2)] }] });
    expect(clipJoins(overlayFirst)).toEqual([]);
  });
});

describe("transitionOps (add, change, remove, undo through the worker's applyOps)", () => {
  const base = docOf([media("a", 0, 3), media("b", 3, 3), media("c", 6, 3)], [{ id: "o1", kind: "overlay", clips: [media("o", 4, 1)] }]);

  it("add: sets transitionIn, then ripples b and later clips earlier by the length; other tracks stay", () => {
    const ops = transitionOps(base, "b", { type: "slideleft", duration: 0.5 })!;
    expect(ops.map((o) => o.op)).toEqual(["setProps", "move", "move"]);
    const next = applyOps(base, ops);
    expect(starts(next)).toEqual(["a@0", "b@2.5", "c@5.5"]);
    expect(tr(next, "b")).toEqual({ type: "slideleft", duration: 0.5 });
    expect((next.tracks[1].clips[0] as MediaClip).start).toBe(4);
    expect(next.schemaVersion).toBe(2);
    expect(clipJoins(next)[0].transition).toEqual({ type: "slideleft", duration: 0.5 });
  });

  it("change type only is one setProps; a longer or shorter length ripples", () => {
    const added = applyOps(base, transitionOps(base, "b", { type: "slideleft", duration: 0.5 })!);
    const typeOnly = transitionOps(added, "b", { type: "circleopen", duration: 0.5 })!;
    expect(typeOnly).toEqual([{ op: "setProps", clipId: "b", props: { transitionIn: { type: "circleopen", duration: 0.5 } } }]);
    const longer = applyOps(added, transitionOps(added, "b", { type: "circleopen", duration: 1.2 })!);
    expect(starts(longer)).toEqual(["a@0", "b@1.8", "c@4.8"]);
    const shorterOps = transitionOps(longer, "b", { type: "dissolve", duration: 0.2 })!;
    expect(shorterOps.map((o) => o.op)).toEqual(["move", "move", "setProps"]);
    const shorter = applyOps(longer, shorterOps);
    expect(starts(shorter)).toEqual(["a@0", "b@2.8", "c@5.8"]);
    expect(tr(shorter, "b")).toEqual({ type: "dissolve", duration: 0.2 });
  });

  it("remove: clips move back last-first, then transitionIn is null; a plain edit saves as v1 again", () => {
    const added = applyOps(base, transitionOps(base, "b", { type: "wipeup", duration: 1 })!);
    const removed = applyOps(added, transitionOps(added, "b", null)!);
    expect(removed).toEqual(base);
    expect(removed.schemaVersion).toBe(1);
  });

  it("undo: replaying the join's previous value restores the doc exactly", () => {
    const withFade = applyOps(base, transitionOps(base, "c", { type: "fade", duration: 0.4 })!);
    const before = clipJoins(withFade).find((j) => j.toId === "c")!.transition;
    const changed = applyOps(withFade, transitionOps(withFade, "c", { type: "zoomin", duration: 1 })!);
    expect(applyOps(changed, transitionOps(changed, "c", before)!)).toEqual(withFade);
  });

  it("works on every one of the 15 types", () => {
    for (const type of TRANSITION_TYPES) expect(tr(applyOps(base, transitionOps(base, "b", { type, duration: 0.3 })!), "b")).toEqual({ type, duration: 0.3 });
  });

  it("returns null for no change, a missing join, a bad length or an unknown type", () => {
    expect(transitionOps(base, "b", null)).toBeNull();
    expect(transitionOps(base, "a", { type: "fade", duration: 0.5 })).toBeNull();
    expect(transitionOps(base, "o", { type: "fade", duration: 0.5 })).toBeNull();
    expect(transitionOps(base, "b", { type: "fade", duration: 0.05 })).toBeNull();
    expect(transitionOps(base, "b", { type: "fade", duration: 3.5 })).toBeNull();
    expect(transitionOps(base, "b", { type: "fade", duration: Number.NaN })).toBeNull();
    expect(transitionOps(base, "b", { type: "spin" as never, duration: 0.5 })).toBeNull();
    const added = applyOps(base, transitionOps(base, "b", { type: "fade", duration: 0.5 })!);
    expect(transitionOps(added, "b", { type: "fade", duration: 0.5 })).toBeNull();
  });
});
