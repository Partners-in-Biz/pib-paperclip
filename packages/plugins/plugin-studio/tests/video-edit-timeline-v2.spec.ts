import { describe, expect, it } from "vitest";
import { EASES, EditError, LIMITS, normalizeEdit, TRANSITIONS } from "../src/video-edit/timeline.js";

const media = (extra: Record<string, unknown> = {}) => ({ id: "c", assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const doc = (kind: string, clip: Record<string, unknown>, schemaVersion?: number) => ({ ...(schemaVersion ? { schemaVersion } : {}), project: { size: "9:16", fps: 30 }, tracks: [{ id: "t", kind, clips: [clip] }] });
const video = (extra: Record<string, unknown>, v?: number) => doc("video", media(extra), v);
const text = (extra: Record<string, unknown>) => doc("text", { id: "c", start: 0, text: "Hi", duration: 3, ...extra });
const keys = (n: number, prop = "x") => ({ [prop]: Array.from({ length: n }, (_, i) => ({ t: i * 0.05, value: i })) });

function refused(input: unknown, options?: Parameters<typeof normalizeEdit>[1]): EditError {
  try {
    normalizeEdit(input, options);
  } catch (error) {
    expect(error).toBeInstanceOf(EditError);
    return error as EditError;
  }
  throw new Error("expected an EditError");
}

describe("schema v2: transitions, keyframes and the rollback-safe writer", () => {
  it("has the 15 curated xfade transitions and 5 eases", () => {
    expect(TRANSITIONS).toHaveLength(15);
    expect(TRANSITIONS[0]).toBe("fade");
    expect(EASES).toEqual(["linear", "easeIn", "easeOut", "easeInOut", "hold"]);
  });

  it("writes v1 when no v2 feature is used, also for v2 input and empty keyframes", () => {
    expect(normalizeEdit(video({ transitionIn: { type: "fade", duration: 1 } })).schemaVersion).toBe(1);
    expect(normalizeEdit(video({}, 2)).schemaVersion).toBe(1);
    for (const empty of [{}, [], { x: [] }, { x: [], volume: [], opacity: null }]) {
      const out = normalizeEdit(video({ keyframes: empty }, 2));
      expect(out.schemaVersion).toBe(1);
      expect("keyframes" in out.tracks[0].clips[0]).toBe(false);
      expect(JSON.stringify(out)).toBe(JSON.stringify(normalizeEdit(video({}))));
    }
  });

  it("writes v2 for a non-fade transition or any keyframe, and reads it back unchanged", () => {
    const wipe = normalizeEdit(video({ transitionIn: { type: "wipeleft", duration: 0.5 } }));
    expect(wipe.schemaVersion).toBe(2);
    const kf = normalizeEdit(video({ keyframes: { opacity: [{ t: 0, value: 0 }, { t: 1, value: 1, ease: "easeOut" }], x: [{ t: 4, value: -20, ease: "hold" }] } }, 1));
    expect(kf.schemaVersion).toBe(2);
    // Fixed property order, ease defaults to linear, values rounded like every other time.
    expect(kf.tracks[0].clips[0]).toMatchObject({ keyframes: { x: [{ t: 4, value: -20, ease: "hold" }], opacity: [{ t: 0, value: 0, ease: "linear" }, { t: 1, value: 1, ease: "easeOut" }] } });
    expect(Object.keys((kf.tracks[0].clips[0] as { keyframes: object }).keyframes)).toEqual(["x", "opacity"]);
    for (const d of [wipe, kf]) expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(d))))).toBe(JSON.stringify(d));
  });

  it("t runs from the clip's start to its end at speed, transition overlap included", () => {
    const fast = video({ speed: 2, keyframes: { scale: [{ t: 2, value: 2 }] } });
    expect(normalizeEdit(fast).schemaVersion).toBe(2);
    expect(refused(video({ speed: 2, keyframes: { scale: [{ t: 2.001, value: 2 }] } }))).toMatchObject({ reason: "out_of_range", path: "tracks[0].clips[0].keyframes.scale[0].t" });
    const overlapping = { project: { fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [media(), media({ id: "d", start: 3, transitionIn: { type: "slideup", duration: 1 }, keyframes: { y: [{ t: 0, value: 5 }, { t: 4, value: 0 }] } })] }] };
    expect(normalizeEdit(overlapping).schemaVersion).toBe(2);
  });

  it("accepts 50 keys per property and refuses 51 with keyframe_limit", () => {
    expect(normalizeEdit(video({ keyframes: { ...keys(LIMITS.maxKeyframes), ...keys(50, "rotate") } })).schemaVersion).toBe(2);
    expect(refused(video({ keyframes: keys(51) }))).toMatchObject({ reason: "keyframe_limit", code: "bad_edit", path: "tracks[0].clips[0].keyframes.x" });
  });

  it("refuses unsorted or duplicate times, bad numbers, unknown eases and transitions", () => {
    const at = (...ts: number[]) => video({ keyframes: { x: ts.map((t) => ({ t, value: 0 })) } });
    expect(refused(at(1, 0.5))).toMatchObject({ reason: "keyframe_order", path: "tracks[0].clips[0].keyframes.x[1].t" });
    expect(refused(at(1, 1))).toMatchObject({ reason: "keyframe_order" });
    expect(refused(at(1, 1.0004)).reason).toBe("keyframe_order"); // the same millisecond after rounding
    for (const bad of [NaN, Infinity, -Infinity]) expect(refused(video({ keyframes: { x: [{ t: 0, value: bad }] } }))).toMatchObject({ reason: "invalid", path: "tracks[0].clips[0].keyframes.x[0].value" });
    expect(refused(video({ keyframes: { x: [{ t: NaN, value: 0 }] } })).reason).toBe("invalid");
    expect(refused(video({ keyframes: { x: [{ t: 0, value: 1e308 }] } })).reason).toBe("out_of_range");
    expect(refused(video({ keyframes: { opacity: [{ t: 0, value: 1.5 }] } })).reason).toBe("out_of_range");
    expect(refused(video({ keyframes: { x: [{ t: 0, value: 0, ease: "bounce" }] } }))).toMatchObject({ reason: "unknown_ease", path: "tracks[0].clips[0].keyframes.x[0].ease" });
    expect(refused(video({ transitionIn: { type: "wipe", duration: 1 } }))).toMatchObject({ reason: "unknown_transition", path: "tracks[0].clips[0].transitionIn.type" });
    expect(refused(video({ keyframes: { crop: [{ t: 0, value: 0 }] } })).reason).toBe("invalid");
    expect(refused(video({ keyframes: [{ t: 0, value: 0 }] })).reason).toBe("invalid");
    expect(refused({ schemaVersion: 6 }).reason).toBe("unsupported_version");
  });

  it("refuses volume keyframes on a clip without sound with no_audio", () => {
    const vol = { volume: [{ t: 0, value: 0 }, { t: 2, value: 1 }] };
    expect(normalizeEdit(doc("audio", media({ keyframes: vol }))).schemaVersion).toBe(2);
    expect(normalizeEdit(video({ keyframes: vol })).schemaVersion).toBe(2);
    expect(refused(video({ keyframes: vol }), { hasAudio: (id) => id !== "asset-1" })).toMatchObject({ reason: "no_audio", path: "tracks[0].clips[0].keyframes.volume" });
    expect(refused(text({ keyframes: vol })).reason).toBe("no_audio");
    expect(refused(doc("audio", media({ keyframes: { x: [{ t: 0, value: 0 }] } }))).reason).toBe("invalid");
    expect(normalizeEdit(text({ keyframes: { x: [{ t: 0, value: 0 }], opacity: [{ t: 3, value: 0 }] } })).schemaVersion).toBe(2);
  });
});
