import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";
import { addAudioOps, audioEditOps, audioFrameAt, audioMute, audioWindow, findAudioClip, formOf } from "../src/ui/editor/audio-track.js";

const media = { id: "v1", assetId: "a1", version: 1, start: 0, in: 0, out: 10 };
const aud = (id: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId: "m1", version: 1, start, in: 0, out, ...extra });
const docOf = (clips: unknown[] | null): EditDoc =>
  normalizeEdit({ tracks: [{ id: "video", kind: "video", clips: [media] }, ...(clips ? [{ id: "music", kind: "audio", clips }] : [])] });

describe("addAudioOps", () => {
  it("creates an audio track when there is none and the worker accepts the batch", () => {
    const doc = docOf(null);
    const made = addAudioOps(doc, { id: "m1", version: 2, seconds: 30 }, 1.5);
    if ("error" in made) throw new Error(made.error);
    expect(made.ops.map((o) => o.op)).toEqual(["addTrack", "addClip"]);
    const clip = findAudioClip(applyOps(doc, made.ops), made.clipId)!.clip;
    expect(clip).toMatchObject({ start: 1.5, in: 0, out: 30, volume: 1, assetId: "m1", version: 2 });
  });
  it("uses the existing track, skips a clip under the playhead and fits before the next one", () => {
    const doc = docOf([aud("a", 0, 2), aud("b", 4, 2)]);
    const made = addAudioOps(doc, { id: "m2", version: 1, seconds: 30 }, 1);
    if ("error" in made) throw new Error(made.error);
    expect(made.ops).toHaveLength(1);
    expect(findAudioClip(applyOps(doc, made.ops), made.clipId)!.clip).toMatchObject({ start: 2, out: 2 });
  });
  it("cuts to the 180 s limit and refuses with no room or no length", () => {
    const made = addAudioOps(docOf(null), { id: "m1", version: 1, seconds: 500 }, 170);
    expect(made).toMatchObject({ start: 170 });
    expect(applyOps(docOf(null), (made as { ops: unknown[] }).ops).tracks.at(-1)!.clips[0]).toMatchObject({ out: 10 });
    expect(addAudioOps(docOf([aud("a", 0, 2), aud("b", 2.05, 2)]), { id: "m1", version: 1, seconds: 5 }, 0)).toHaveProperty("error"); // 0.05 s gap
    expect(addAudioOps(docOf(null), { id: "m1", version: 1, seconds: 0 }, 0)).toHaveProperty("error");
    expect(addAudioOps(null, { id: "m1", version: 1, seconds: 3 }, 0)).toHaveProperty("error");
  });
});

describe("audioEditOps", () => {
  const doc = docOf([aud("a", 0, 10)]);
  const clip = findAudioClip(doc, "a")!.clip;
  it("round-trips volume and fades through the worker's ops", () => {
    const made = audioEditOps(clip, { volume: "1.5", fadeIn: "2", fadeOut: "1" });
    expect(made).toEqual({ ops: [{ op: "setProps", clipId: "a", props: { volume: 1.5, fadeIn: 2, fadeOut: 1 } }] });
    expect(findAudioClip(applyOps(doc, (made as { ops: unknown[] }).ops), "a")!.clip).toMatchObject({ volume: 1.5, fadeIn: 2, fadeOut: 1 });
  });
  it("sends nothing when nothing changed and only the changed fields otherwise", () => {
    expect(audioEditOps(clip, formOf(clip))).toBeNull();
    expect(audioEditOps(clip, { ...formOf(clip), volume: "0" })).toMatchObject({ ops: [{ props: { volume: 0 } }] });
  });
  it("refuses bad values before sending", () => {
    expect(audioEditOps(clip, { ...formOf(clip), volume: "2.5" })).toHaveProperty("error");
    expect(audioEditOps(clip, { ...formOf(clip), volume: "" })).toHaveProperty("error");
    expect(audioEditOps(clip, { ...formOf(clip), fadeIn: "-1" })).toHaveProperty("error");
    expect(audioEditOps(clip, { volume: "1", fadeIn: "6", fadeOut: "6" })).toHaveProperty("error");
  });
});

describe("audioFrameAt", () => {
  const clip = findAudioClip(docOf([aud("a", 2, 14, { volume: 0.8, fadeIn: 2, fadeOut: 2, speed: 2, in: 4 })]), "a")!.clip; // 5 s long (10 s of source at 2x)
  it("is null outside the clip", () => {
    expect(audioFrameAt(clip, 1.9)).toBeNull();
    expect(audioFrameAt(clip, 7)).toBeNull();
  });
  it("maps timeline time to source time with speed, and ramps the fades", () => {
    expect(audioFrameAt(clip, 2)).toMatchObject({ sourceTime: 4, volume: 0 });
    expect(audioFrameAt(clip, 3)!.volume).toBeCloseTo(0.4);
    expect(audioFrameAt(clip, 3.5)).toMatchObject({ sourceTime: 7 });
    expect(audioFrameAt(clip, 4)!.volume).toBeCloseTo(0.8);
    expect(audioFrameAt(clip, 6)!.volume).toBeCloseTo(0.4);
  });
  it("caps a volume above 1 for the element", () => {
    const loud = findAudioClip(docOf([aud("l", 0, 5, { volume: 2 })]), "l")!.clip;
    expect(audioFrameAt(loud, 1)!.volume).toBe(1);
  });
});

describe("audioWindow and mute", () => {
  it("lists clips playing now or starting within the lookahead, not finished or far ones", () => {
    const doc = docOf([aud("done", 0, 2), aud("now", 3, 5), aud("soon", 9, 2), aud("far", 40, 2)]);
    expect(audioWindow(doc, 4).map((c) => c.clip.id)).toEqual(["now", "soon"]);
  });
  it("toggles a track's preview mute and tells listeners", () => {
    let calls = 0;
    const off = audioMute.subscribe(() => calls++);
    audioMute.toggle("music");
    expect(audioMute.isMuted("music")).toBe(true);
    audioMute.toggle("music");
    expect(audioMute.isMuted("music")).toBe(false);
    expect(calls).toBe(2);
    off();
  });
});
