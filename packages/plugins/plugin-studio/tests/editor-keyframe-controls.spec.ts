import { describe, expect, it } from "vitest";
import { EASES, LIMITS, normalizeEdit, type EditDoc, type Keyframe, type MediaClip } from "../src/video-edit/timeline.js";
import {
  createKeyHistory, EASE_LABELS, KEY_EASES, KEY_LIMIT_TEXT, KEY_RANGES, MAX_KEYFRAMES, keyframeErrorText, keyMarkers, keyProps,
  localTime, moveKeysOps, propValueAt, removeKeyOps, setKeyOps, type KeyEdit,
} from "../src/ui/editor/timeline-view.js";

const clipOf = (keyframes?: unknown, extra: Record<string, unknown> = {}) =>
  normalizeEdit({ tracks: [{ id: "v", kind: "video", clips: [{ id: "a", assetId: "a1", version: 1, start: 2, in: 0, out: 4, keyframes, ...extra }] }] }).tracks[0].clips[0] as MediaClip;
/** The D1a2 `setProps { keyframes }` rule (a list replaces that property's keys), then the worker's validator. */
function apply(clip: MediaClip, edit: KeyEdit | null, which: "ops" | "undo" = "ops"): MediaClip {
  if (!edit || "error" in edit) throw new Error(`no ops: ${JSON.stringify(edit)}`);
  const [op] = edit[which] as { op: string; clipId: string; props: { keyframes: Record<string, Keyframe[]> } }[];
  expect(edit[which]).toHaveLength(1);
  expect(op).toMatchObject({ op: "setProps", clipId: clip.id });
  const keyframes = { ...clip.keyframes, ...op.props.keyframes };
  for (const k of Object.keys(keyframes)) if (!(keyframes as Record<string, unknown[]>)[k].length) delete (keyframes as Record<string, unknown>)[k];
  return clipOf(keyframes);
}

describe("keyframe controls", () => {
  it("offers the properties each kind can animate, the worker's eases and ranges", () => {
    expect(keyProps("video")).toEqual(["x", "y", "scale", "rotate", "opacity", "volume"]);
    expect(keyProps("text")).toEqual(["x", "y", "opacity"]);
    expect(keyProps("audio")).toEqual(["volume"]);
    expect(keyProps("caption")).toEqual([]);
    expect([...KEY_EASES]).toEqual([...EASES]);
    for (const e of KEY_EASES) expect(EASE_LABELS[e]).toBeTruthy();
    expect(MAX_KEYFRAMES).toBe(LIMITS.maxKeyframes);
    expect(KEY_RANGES).toMatchObject({ x: LIMITS.offset, scale: LIMITS.scale, rotate: LIMITS.rotate, opacity: LIMITS.opacity, volume: LIMITS.volume });
  });
  it("reads the playhead in clip time, null outside the clip", () => {
    const clip = clipOf();
    expect(localTime(clip, 3.25)).toBe(1.25);
    expect(localTime(clip, 6)).toBe(4);
    expect(localTime(clip, 1.9)).toBeNull();
    expect(localTime(clip, 6.1)).toBeNull();
  });
  it("add, update, remove a key at the playhead, each one setProps; undo puts it back", () => {
    let clip = clipOf();
    expect(propValueAt(clip, "opacity", 1)).toBe(1);
    clip = apply(clip, setKeyOps(clip, "opacity", 0, 0, "linear"));
    clip = apply(clip, setKeyOps(clip, "opacity", 2, 1, "easeIn"));
    expect(clip.keyframes?.opacity).toEqual([{ t: 0, value: 0, ease: "linear" }, { t: 2, value: 1, ease: "easeIn" }]);
    expect(propValueAt(clip, "opacity", 1)).toBe(0.5);
    expect(setKeyOps(clip, "opacity", 2, 1, "easeIn")).toBeNull(); // nothing changed
    const update = setKeyOps(clip, "opacity", 0, 0.2, "hold");
    const updated = apply(clip, update);
    expect(updated.keyframes?.opacity?.[0]).toEqual({ t: 0, value: 0.2, ease: "hold" });
    expect(apply(updated, update, "undo").keyframes).toEqual(clip.keyframes);
    const removed = apply(clip, removeKeyOps(clip, "opacity", 2));
    expect(removed.keyframes?.opacity).toEqual([{ t: 0, value: 0, ease: "linear" }]);
    expect(apply(removed, removeKeyOps(removed, "opacity", 0)).keyframes).toBeUndefined();
    expect(removeKeyOps(clip, "x", 0)).toBeNull();
  });
  it("refuses out-of-range values and a 51st key with a sentence, not a code", () => {
    const clip = clipOf();
    expect(setKeyOps(clip, "scale", 0, 0, "linear")).toEqual({ error: "Scale must be between 0.01 and 10." });
    expect(setKeyOps(clip, "x", 0, Number.NaN, "linear")).toEqual({ error: "X (px): enter a number." });
    const full = clipOf({ x: Array.from({ length: 50 }, (_, i) => ({ t: i * 0.05, value: i })) });
    expect(setKeyOps(full, "x", 3, 1, "linear")).toEqual({ error: KEY_LIMIT_TEXT });
    expect("ops" in (setKeyOps(full, "x", 0.05, 99, "linear") as object)).toBe(true); // updating a key is fine at the cap
    expect(keyframeErrorText("ops[0].keyframes.x: would leave 51 x keyframes on one clip; the most is 50.")).toBe(KEY_LIMIT_TEXT);
    expect(keyframeErrorText("tracks[0].clips[0].keyframes.x: holds at most 50 keyframes.")).toBe(KEY_LIMIT_TEXT);
    expect(keyframeErrorText("keyframes.volume: this clip has no sound to change the volume of.")).toMatch(/no sound/);
    expect(keyframeErrorText("")).toBe("The key wasn't saved. Try again.");
  });
  it("markers group keys by time; a marker drag moves every key there, clamped to the clip", () => {
    const clip = clipOf({ x: [{ t: 0, value: 0 }, { t: 1, value: 10 }], opacity: [{ t: 1, value: 0.5 }, { t: 3, value: 1 }] });
    expect(keyMarkers(clip)).toEqual([{ t: 0, props: ["x"] }, { t: 1, props: ["x", "opacity"] }, { t: 3, props: ["opacity"] }]);
    const moved = apply(clip, moveKeysOps(clip, 1, 2.5));
    expect(keyMarkers(moved).map((m) => m.t)).toEqual([0, 2.5, 3]);
    expect(moved.keyframes?.opacity).toEqual([{ t: 2.5, value: 0.5, ease: "linear" }, { t: 3, value: 1, ease: "linear" }]);
    const past = apply(clip, moveKeysOps(clip, 0, 9)); // past the end: the key lands on the clip's last frame time
    expect(past.keyframes?.x).toEqual([{ t: 1, value: 10, ease: "linear" }, { t: 4, value: 0, ease: "linear" }]);
    expect(moveKeysOps(clip, 1, 1.0001)).toBeNull();
    expect(moveKeysOps(clip, 1, 3)).toEqual({ error: "Opacity already has a key at 0:03.0 in this clip." });
  });
  it("history keeps the last 20 undo batches and notifies", () => {
    const h = createKeyHistory();
    let calls = 0;
    h.subscribe(() => calls++);
    for (let i = 0; i < 25; i++) h.push({ clipId: `c${i}`, ops: [] });
    expect(h.size()).toBe(20);
    expect(h.peek()?.clipId).toBe("c24");
    h.drop();
    expect(h.peek()?.clipId).toBe("c23");
    expect(calls).toBe(26);
  });
});
