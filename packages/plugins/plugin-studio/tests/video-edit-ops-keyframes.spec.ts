import { describe, expect, it } from "vitest";
import { applyOps, OpError } from "../src/video-edit/ops.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const key = (t: number, value: number, ease = "linear") => ({ t, value, ease });
const media = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const input = (aKeys: Record<string, unknown> = { x: [key(0, 0), key(4, 100)], opacity: [key(1, 1, "hold"), key(3, 0)] }) => ({
  schemaVersion: 2,
  project: { size: "9:16", fps: 30 },
  tracks: [
    { id: "v", kind: "video", clips: [media("a", { keyframes: aKeys }), media("b", { start: 4, in: 2, out: 6, transitionIn: { type: "fade", duration: 0.5 } })] },
    { id: "o", kind: "overlay", clips: [media("logo", { out: 2 })] },
    { id: "t", kind: "text", clips: [{ id: "title", text: "Hi", start: 0, duration: 2, keyframes: { scale: [key(0, 1), key(2, 2)] } }] },
  ],
});
const clip = (doc: EditDoc, id: string) => doc.tracks.flatMap((t) => t.clips as { id: string }[]).find((c) => c.id === id) as Record<string, any>;
function apply(ops: unknown[], edit: unknown = input()): EditDoc {
  const doc = applyOps(edit, ops);
  expect(normalizeEdit(doc)).toEqual(doc);
  return doc;
}
function refused(ops: unknown[], edit: unknown = input()): OpError {
  try {
    applyOps(edit, ops);
  } catch (error) {
    expect(error).toBeInstanceOf(OpError);
    return error as OpError;
  }
  throw new Error("expected applyOps to refuse the ops");
}
/** 50 keys 0.05 s apart from `t0`. */
const fifty = (t0: number) => Array.from({ length: 50 }, (_, k) => key(Math.round((t0 + k * 0.05) * 1000) / 1000, k % 2));

describe("video edit ops: keyframes and transitions", () => {
  it("split puts a key at the cut on both halves with the same value, and the right half has no transition", () => {
    const doc = apply([{ op: "split", clipId: "a", at: 1, newId: "a2" }, { op: "split", clipId: "b", at: 5, newId: "b2" }]);
    expect(clip(doc, "a").keyframes).toEqual({ x: [key(0, 0), key(1, 25)], opacity: [key(1, 1, "hold")] });
    expect(clip(doc, "a2").keyframes).toEqual({ x: [key(0, 25), key(3, 100)], opacity: [key(0, 1, "hold"), key(2, 0)] });
    expect(clip(doc, "a").keyframes.x.at(-1).value).toBe(clip(doc, "a2").keyframes.x[0].value);
    expect(clip(doc, "b2").transitionIn).toBeNull();
    expect(clip(doc, "b").transitionIn).toEqual({ type: "fade", duration: 0.5 });
  });

  it("split keeps the eased value at the cut, on media at speed 2 and on text clips", () => {
    const edit = input({ x: [key(0, 0, "easeInOut"), key(2, 100)] });
    (edit.tracks[0].clips[0] as Record<string, unknown>).speed = 2;
    const doc = apply([{ op: "split", clipId: "a", at: 0.5, newId: "a2" }, { op: "split", clipId: "title", at: 1, newId: "title2" }], edit);
    // easeInOut at a quarter of the way: 0.25^2 * (3 - 0.5) = 0.15625.
    expect(clip(doc, "a").keyframes.x).toEqual([key(0, 0, "easeInOut"), key(0.5, 15.625, "easeInOut")]);
    expect(clip(doc, "a2").keyframes.x).toEqual([key(0, 15.625, "easeInOut"), key(1.5, 100)]);
    expect(clip(doc, "title").keyframes.scale.at(-1)).toEqual(key(1, 1.5));
    expect(clip(doc, "title2").keyframes.scale[0]).toEqual(key(0, 1.5));
  });

  it("trim rebases key times, drops keys outside the clip and puts a key with the value on each cut edge", () => {
    const doc = apply([{ op: "trim", clipId: "a", in: 1, out: 3 }]);
    expect(clip(doc, "a").keyframes).toEqual({ x: [key(0, 25), key(2, 75)], opacity: [key(0, 1, "hold"), key(2, 0)] });
    // Making the clip longer at the front moves the keys later, with no new keys.
    const longer = apply([{ op: "trim", clipId: "a", in: 0 }], apply([{ op: "trim", clipId: "a", in: 1 }]));
    expect(clip(longer, "a").keyframes.x).toEqual([key(1, 25), key(4, 100)]);
  });

  it("split or trim that would leave a property over 50 keys is refused with keyframe_limit", () => {
    expect(refused([{ op: "split", clipId: "a", at: 3 }], input({ x: fifty(0) })).reason).toBe("keyframe_limit");
    expect(refused([{ op: "trim", clipId: "a", in: 0.05 }], input({ x: fifty(0.1) })).reason).toBe("keyframe_limit");
    expect(refused([{ op: "trim", clipId: "a", out: 3 }], input({ x: fifty(0.1) })).reason).toBe("keyframe_limit");
    // A cut that drops a key for the one it adds stays at 50.
    expect(clip(apply([{ op: "trim", clipId: "a", in: 0.025 }], input({ x: fifty(0) })), "a").keyframes.x).toHaveLength(50);
  });

  it("setProps replaces keys per property, [] removes one and null removes all", () => {
    let doc = apply([{ op: "setProps", clipId: "a", props: { keyframes: { scale: [key(0, 1), key(4, 2, "easeOut")], opacity: [] } } }]);
    expect(clip(doc, "a").keyframes).toEqual({ x: [key(0, 0), key(4, 100)], scale: [key(0, 1), key(4, 2, "easeOut")] });
    doc = apply([{ op: "setProps", clipId: "a", props: { keyframes: null } }], doc);
    expect(clip(doc, "a").keyframes).toBeUndefined();
    expect(refused([{ op: "setProps", clipId: "a", props: { keyframes: [1] } }]).reason).toBe("invalid");
    expect(refused([{ op: "setProps", clipId: "a", props: { keyframes: { x: fifty(0).concat(key(3.9, 1)) } } }]).reason).toBe("keyframe_limit");
    expect(refused([{ op: "setProps", clipId: "a", props: { keyframes: { x: [key(0, 0, "bounce")] } } }]).reason).toBe("unknown_ease");
  });

  it("setProps takes any transition type on video and overlay clips, keeps the duration, and only fade on text", () => {
    const doc = apply([
      { op: "setProps", clipId: "b", props: { transitionIn: { type: "wipeleft" } } },
      { op: "setProps", clipId: "logo", props: { transitionIn: { type: "dissolve", duration: 0.4 } } },
    ]);
    expect(clip(doc, "b").transitionIn).toEqual({ type: "wipeleft", duration: 0.5 });
    expect(clip(doc, "logo").transitionIn).toEqual({ type: "dissolve", duration: 0.4 });
    expect(refused([{ op: "setProps", clipId: "title", props: { transitionIn: { type: "wipeleft", duration: 0.5 } } }]).reason).toBe("unknown_transition");
    expect(refused([{ op: "setProps", clipId: "b", props: { transitionIn: { type: "spin" } } }]).reason).toBe("unknown_transition");
  });
});
