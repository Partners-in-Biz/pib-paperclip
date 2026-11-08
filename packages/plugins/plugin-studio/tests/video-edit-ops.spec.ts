import { describe, expect, it } from "vitest";
import { applyOps, MAX_OPS, OpError } from "../src/video-edit/ops.js";
import { EditError, LIMITS, normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const media = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const input = () => ({
  schemaVersion: 1,
  project: { size: "9:16", fps: 30 },
  tracks: [
    { id: "v", kind: "video", clips: [media("a", { fadeIn: 0.5, fadeOut: 1 }), media("b", { start: 4, in: 2, out: 6, transitionIn: { type: "fade", duration: 0.5 } })] },
    { id: "o", kind: "overlay", clips: [] },
    { id: "t", kind: "text", clips: [{ id: "title", text: "Hi", start: 0, duration: 2, fadeIn: 0.5, fadeOut: 0.5 }] },
    { id: "cap", kind: "caption", clips: [{ id: "cc", start: 1, words: [{ text: "Buy", start: 0, end: 0.4 }, { text: "now", start: 0.5, end: 0.9 }] }] },
    { id: "m", kind: "audio", clips: [media("music", { out: 8, fadeOut: 1 })] },
  ],
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
const clip = (doc: EditDoc, id: string) => doc.tracks.flatMap((t) => t.clips as { id: string }[]).find((c) => c.id === id) as Record<string, any> | undefined;
const track = (doc: EditDoc, id: string) => doc.tracks.find((t) => t.id === id)!;
/** Applies to a frozen input (so any mutation throws) and checks the result is already normal. */
function apply(ops: unknown[], edit: unknown = input()): EditDoc {
  const doc = applyOps(deepFreeze(edit), deepFreeze(ops));
  expect(normalizeEdit(doc)).toEqual(doc);
  return doc;
}
function refused(ops: unknown[], edit: unknown = input()): OpError {
  const before = JSON.stringify(edit);
  try {
    applyOps(deepFreeze(edit), deepFreeze(ops));
  } catch (error) {
    expect(error).toBeInstanceOf(OpError);
    expect(error).toBeInstanceOf(EditError);
    expect(JSON.stringify(edit)).toBe(before);
    return error as OpError;
  }
  throw new Error("expected applyOps to refuse the ops");
}

describe("video edit ops", () => {
  it("no ops returns a normalised copy, not the input", () => {
    const edit = input();
    const doc = apply([], edit);
    expect(doc).toEqual(normalizeEdit(edit));
    expect(doc).not.toBe(edit);
  });

  it("addClip adds to a track in start order, and refuses unknown tracks, duplicate ids and overlaps", () => {
    const doc = apply([{ op: "addClip", trackId: "o", clip: media("logo2", { start: 3, out: 1 }) }, { op: "addClip", trackId: "o", clip: media("logo1", { out: 1 }) }]);
    expect(track(doc, "o").clips.map((c) => c.id)).toEqual(["logo1", "logo2"]);
    expect(clip(doc, "logo2")).toMatchObject({ start: 3, speed: 1, volume: 1, transitionIn: null });
    expect(refused([{ op: "addClip", trackId: "nope", clip: media("x") }])).toMatchObject({ reason: "not_found", path: "ops[0].trackId", opIndex: 0 });
    expect(refused([{ op: "addClip", trackId: "o", clip: media("a") }]).reason).toBe("duplicate");
    expect(refused([{ op: "addClip", trackId: "v", clip: media("x", { start: 2 }) }]).reason).toBe("overlap");
    expect(refused([{ op: "addClip", trackId: "o" }])).toMatchObject({ reason: "invalid", path: "ops[0].clip" });
  });

  it("split cuts a media clip at a timeline time, with no fade at the cut", () => {
    const doc = apply([{ op: "split", clipId: "a", at: 1.5 }]);
    expect(track(doc, "v").clips.map((c) => c.id)).toEqual(["a", "a-2", "b"]);
    expect(clip(doc, "a")).toMatchObject({ start: 0, in: 0, out: 1.5, fadeIn: 0.5, fadeOut: 0 });
    expect(clip(doc, "a-2")).toMatchObject({ start: 1.5, in: 1.5, out: 4, fadeIn: 0, fadeOut: 1, transitionIn: null });
    // The cut clip's transition stays on its first part only.
    const b = apply([{ op: "split", clipId: "b", at: 5, newId: "b-tail" }]);
    expect(clip(b, "b")).toMatchObject({ in: 2, out: 3, transitionIn: { type: "fade", duration: 0.5 } });
    expect(clip(b, "b-tail")).toMatchObject({ start: 5, in: 3, out: 6, transitionIn: null });
  });

  it("split maps timeline time to source time by speed and picks a free id", () => {
    const edit = input();
    edit.tracks[0].clips = [media("a", { speed: 2, out: 8 }), media("a-2", { start: 10 })];
    const doc = apply([{ op: "split", clipId: "a", at: 1 }], edit);
    expect(clip(doc, "a")).toMatchObject({ in: 0, out: 2 });
    expect(clip(doc, "a-3")).toMatchObject({ start: 1, in: 2, out: 8 });
  });

  it("split cuts text by duration and captions between words", () => {
    const doc = apply([{ op: "split", clipId: "title", at: 0.5 }, { op: "split", clipId: "cc", at: 1.45, newId: "cc2" }]);
    expect(clip(doc, "title")).toMatchObject({ duration: 0.5, fadeIn: 0.5, fadeOut: 0 });
    expect(clip(doc, "title-2")).toMatchObject({ start: 0.5, duration: 1.5, fadeIn: 0, fadeOut: 0.5 });
    expect(clip(doc, "cc")!.words).toEqual([{ text: "Buy", start: 0, end: 0.4 }]);
    expect(clip(doc, "cc2")).toMatchObject({ start: 1.45, words: [{ text: "now", start: 0.05, end: 0.45 }] });
  });

  it("split refuses times outside the clip, inside a word and unknown clips", () => {
    expect(refused([{ op: "split", clipId: "a", at: 0 }])).toMatchObject({ reason: "out_of_range", path: "ops[0].at" });
    expect(refused([{ op: "split", clipId: "a", at: 4 }]).reason).toBe("out_of_range");
    expect(refused([{ op: "split", clipId: "a", at: 9 }]).reason).toBe("out_of_range");
    expect(refused([{ op: "split", clipId: "cc", at: 1.2 }]).message).toContain("inside a word");
    expect(refused([{ op: "split", clipId: "nope", at: 1 }])).toMatchObject({ reason: "not_found", path: "ops[0].clipId" });
    expect(refused([{ op: "split", clipId: "a" }]).reason).toBe("invalid");
    expect(refused([{ op: "split", clipId: "a", at: 1, newId: "b" }]).reason).toBe("duplicate");
  });

  it("trim changes source in/out, keeps the start and fits the fades", () => {
    const doc = apply([{ op: "trim", clipId: "a", in: 1, out: 2 }, { op: "trim", clipId: "music", out: 5 }]);
    expect(clip(doc, "a")).toMatchObject({ start: 0, in: 1, out: 2, fadeIn: 0.5, fadeOut: 0.5 });
    expect(clip(doc, "music")).toMatchObject({ in: 0, out: 5, fadeOut: 1 });
  });

  describe("trim with ripple (PAR-8324)", () => {
    const rip = () => ({
      schemaVersion: 1,
      project: { size: "9:16", fps: 30 },
      tracks: [
        { id: "v", kind: "video", clips: [media("a"), media("b", { start: 4 }), media("c", { start: 10 })] }, // 2 s gap before c
        { id: "o", kind: "overlay", clips: [media("x", { start: 5 })] },
      ],
    });
    const at = (doc: EditDoc, id: string) => (track(doc, id).clips as { start: number }[]).map((c) => c.start);
    it("shortening the out edge pulls the later clips on the track earlier; the gap before c keeps its size", () => {
      const doc = apply([{ op: "trim", clipId: "a", out: 3, ripple: true }], rip());
      expect(at(doc, "v")).toEqual([0, 3, 9]);
      expect(at(doc, "o")).toEqual([5]); // other tracks never move
    });
    it("shortening the in edge keeps the clip's start and pulls the later clips earlier", () => {
      const doc = apply([{ op: "trim", clipId: "a", in: 1, ripple: true }], rip());
      expect(clip(doc, "a")).toMatchObject({ start: 0, in: 1, out: 4 });
      expect(at(doc, "v")).toEqual([0, 3, 9]);
    });
    it("lengthening pushes the later clips later; clips before the trimmed one stay", () => {
      const doc = apply([{ op: "trim", clipId: "b", out: 7, ripple: true }], rip());
      expect(at(doc, "v")).toEqual([0, 4, 13]);
      expect(at(doc, "o")).toEqual([5]);
    });
    it("without ripple (or ripple: false) the old behaviour is unchanged", () => {
      expect(at(apply([{ op: "trim", clipId: "a", out: 3 }], rip()), "v")).toEqual([0, 4, 10]);
      expect(at(apply([{ op: "trim", clipId: "a", out: 3, ripple: false }], rip()), "v")).toEqual([0, 4, 10]);
      expect(refused([{ op: "trim", clipId: "b", out: 7 }], rip()).reason).toBe("overlap");
    });
    it("a ripple that breaks a limit fails the whole batch and applies nothing", () => {
      const error = refused([{ op: "trim", clipId: "a", out: 3, ripple: true }, { op: "trim", clipId: "a", out: LIMITS.maxDuration, ripple: true }], rip());
      expect(error.opIndex).toBe(1);
      expect(refused([{ op: "trim", clipId: "a", out: 3, ripple: "yes" }], rip())).toMatchObject({ reason: "invalid", path: "ops[0].ripple" });
    });
  });
  it("trim refuses out before in, negative in, clips without a source and an empty trim", () => {
    expect(refused([{ op: "trim", clipId: "a", out: 0 }])).toMatchObject({ reason: "out_of_range", path: "ops[0].out" });
    expect(refused([{ op: "trim", clipId: "a", in: 5 }])).toMatchObject({ reason: "out_of_range", path: "ops[0].in" });
    expect(refused([{ op: "trim", clipId: "a", in: -1 }]).reason).toBe("out_of_range");
    expect(refused([{ op: "trim", clipId: "title", out: 1 }])).toMatchObject({ reason: "invalid", path: "ops[0].clipId" });
    expect(refused([{ op: "trim", clipId: "a" }]).reason).toBe("invalid");
    expect(refused([{ op: "trim", clipId: "a", out: "2" }]).reason).toBe("invalid");
    // Lengthening clip a runs into clip b.
    expect(refused([{ op: "trim", clipId: "a", out: 5 }]).reason).toBe("overlap");
  });

  it("move changes start and track", () => {
    const doc = apply([{ op: "move", clipId: "b", start: 6 }, { op: "move", clipId: "a", trackId: "o", start: 1 }]);
    expect(track(doc, "v").clips.map((c) => [c.id, c.start])).toEqual([["b", 6]]);
    expect(track(doc, "o").clips.map((c) => [c.id, c.start])).toEqual([["a", 1]]);
  });

  it("move refuses wrong track kinds, overlaps and out-of-range times", () => {
    expect(refused([{ op: "move", clipId: "a", trackId: "m" }])).toMatchObject({ reason: "invalid", path: "ops[0].trackId" });
    expect(refused([{ op: "move", clipId: "a", trackId: "nope" }]).reason).toBe("not_found");
    expect(refused([{ op: "move", clipId: "a", start: 3 }]).reason).toBe("overlap");
    expect(refused([{ op: "move", clipId: "a", start: -1 }]).reason).toBe("out_of_range");
    expect(refused([{ op: "move", clipId: "b", start: LIMITS.maxDuration }]).reason).toBe("too_long");
    expect(refused([{ op: "move", clipId: "b", start: LIMITS.maxDuration + 1 }]).reason).toBe("out_of_range");
    expect(refused([{ op: "move", clipId: "a" }]).reason).toBe("invalid");
  });

  it("delete removes a clip and refuses unknown ids", () => {
    const doc = apply([{ op: "delete", clipId: "a" }]);
    expect(clip(doc, "a")).toBeUndefined();
    expect(track(doc, "v").clips.map((c) => c.id)).toEqual(["b"]);
    expect(refused([{ op: "delete", clipId: "a" }, { op: "delete", clipId: "a" }])).toMatchObject({ reason: "not_found", opIndex: 1 });
  });

  it("reorder sets the track order and refuses missing, unknown or repeated ids", () => {
    const doc = apply([{ op: "reorder", trackIds: ["m", "cap", "t", "o", "v"] }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["m", "cap", "t", "o", "v"]);
    expect(refused([{ op: "reorder", trackIds: ["v", "o", "t", "cap"] }]).path).toBe("ops[0].trackIds");
    expect(refused([{ op: "reorder", trackIds: ["v", "o", "t", "cap", "x"] }]).reason).toBe("invalid");
    expect(refused([{ op: "reorder", trackIds: ["v", "v", "t", "cap", "m"] }]).reason).toBe("invalid");
    expect(refused([{ op: "reorder", trackIds: "v" }]).reason).toBe("invalid");
  });

  it("setProps changes allowed fields and merges the transform", () => {
    const edit = input();
    (edit.tracks[0].clips[0] as Record<string, unknown>).transform = { x: 10, scale: 2, crop: { left: 0.1 } };
    const doc = apply([{ op: "setProps", clipId: "a", props: { volume: 0.5, transform: { y: 5, crop: { top: 0.2 } } } }, { op: "setProps", clipId: "title", props: { text: "Sale", color: "#00ff00" } }], edit);
    expect(clip(doc, "a")).toMatchObject({ volume: 0.5, transform: { x: 10, y: 5, scale: 2, rotate: 0, crop: { left: 0.1, top: 0.2, right: 0, bottom: 0 } } });
    expect(clip(doc, "title")).toMatchObject({ text: "Sale", color: "#00FF00" });
  });

  it("setProps refuses id changes, unknown fields and values out of range", () => {
    expect(refused([{ op: "setProps", clipId: "a", props: { id: "z" } }])).toMatchObject({ reason: "invalid", path: "ops[0].props.id" });
    expect(refused([{ op: "setProps", clipId: "music", props: { transform: { x: 1 } } }])).toMatchObject({ reason: "invalid", path: "ops[0].props.transform" });
    expect(refused([{ op: "setProps", clipId: "a", props: {} }]).reason).toBe("invalid");
    const speed = refused([{ op: "setProps", clipId: "a", props: { speed: 9 } }]);
    expect(speed).toMatchObject({ reason: "out_of_range", path: "tracks[0].clips[0].speed", opIndex: 0 });
    expect(speed.message).toContain("ops[0] (setProps)");
  });

  it("addTrack inserts at an index and refuses bad tracks", () => {
    const doc = apply([{ op: "addTrack", track: { id: "vo", kind: "audio" }, index: 0 }, { op: "addTrack", track: { id: "end", kind: "text" } }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["vo", "v", "o", "t", "cap", "m", "end"]);
    expect(track(doc, "vo").clips).toEqual([]);
    expect(refused([{ op: "addTrack", track: { id: "v", kind: "audio" } }]).reason).toBe("duplicate");
    expect(refused([{ op: "addTrack", track: { id: "x", kind: "sticker" } }]).reason).toBe("invalid");
    expect(refused([{ op: "addTrack", track: { id: "x", kind: "audio" }, index: 9 }])).toMatchObject({ reason: "out_of_range", path: "ops[0].index" });
    const many = Array.from({ length: LIMITS.maxTracks - 4 }, (_, n) => ({ op: "addTrack", track: { id: `x${n}`, kind: "audio" } }));
    expect(refused(many)).toMatchObject({ reason: "too_many", opIndex: LIMITS.maxTracks - 5 });
  });

  it("removeTrack removes the track with its clips", () => {
    const doc = apply([{ op: "removeTrack", trackId: "v" }]);
    expect(doc.tracks.map((t) => t.id)).toEqual(["o", "t", "cap", "m"]);
    expect(clip(doc, "a")).toBeUndefined();
    expect(refused([{ op: "removeTrack", trackId: "nope" }]).reason).toBe("not_found");
  });

  it("setProject changes size and fps", () => {
    const doc = apply([{ op: "setProject", size: "16:9" }, { op: "setProject", fps: 25 }]);
    expect(doc.project).toEqual({ size: "16:9", width: 1920, height: 1080, fps: 25 });
    expect(refused([{ op: "setProject", fps: 29 }])).toMatchObject({ reason: "invalid", path: "project.fps" });
    expect(refused([{ op: "setProject", size: "2:1" }]).reason).toBe("invalid");
    expect(refused([{ op: "setProject" }]).reason).toBe("invalid");
  });

  it("is all or none: a failing op leaves the input unchanged and applies nothing", () => {
    const edit = input();
    const before = structuredClone(edit);
    const error = refused([{ op: "delete", clipId: "a" }, { op: "setProject", size: "16:9" }, { op: "move", clipId: "b", start: -2 }], edit);
    expect(error.opIndex).toBe(2);
    expect(edit).toEqual(before);
  });

  it("refuses bad op lists and unknown ops", () => {
    expect(refused([{ op: "explode" }])).toMatchObject({ reason: "invalid", path: "ops[0].op" });
    expect(refused(["delete"])).toMatchObject({ reason: "invalid", path: "ops[0]" });
    expect(() => applyOps(input(), "delete" as unknown as unknown[])).toThrow(OpError);
    expect(refused(Array.from({ length: MAX_OPS + 1 }, () => ({ op: "setProject", fps: 30 })))).toMatchObject({ reason: "too_many", opIndex: -1 });
    expect(() => applyOps({ schemaVersion: 3 }, [])).toThrow(EditError);
  });

  it("a chain of edits round-trips through JSON", () => {
    const doc = apply([
      { op: "split", clipId: "a", at: 2 },
      { op: "delete", clipId: "a-2" },
      { op: "move", clipId: "b", start: 2 },
      { op: "addTrack", track: { id: "vo", kind: "audio" } },
      { op: "addClip", trackId: "vo", clip: media("voice", { out: 3, volume: 1.5 }) },
      { op: "reorder", trackIds: ["vo", "v", "o", "t", "cap", "m"] },
    ]);
    expect(applyOps(JSON.parse(JSON.stringify(doc)), [])).toEqual(doc);
    expect(track(doc, "v").clips.map((c) => [c.id, c.start])).toEqual([["a", 0], ["b", 2]]);
  });
});
