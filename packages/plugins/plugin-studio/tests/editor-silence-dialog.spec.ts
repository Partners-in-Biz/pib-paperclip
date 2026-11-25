import { describe, expect, it } from "vitest";
import { clampField, DEFAULT_SETTINGS, SILENCE_FIELDS, savedText, silenceClip, silencePlan } from "../src/ui/editor/silence-dialog.js";
import { SILENCE_PARAMS } from "../src/video-edit/silence.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const doc = normalizeEdit({
  tracks: [
    { id: "v", kind: "video", clips: [{ id: "a", assetId: "a1", version: 1, start: 0, in: 0, out: 4 }] },
    { id: "o", kind: "overlay", clips: [{ id: "s", sticker: { pack: "noto-emoji", id: "fire" }, start: 0, in: 0, out: 3 }] },
  ],
});

describe("silence dialog logic", () => {
  it("keeps the worker's defaults and ranges", () => {
    for (const f of Object.keys(SILENCE_PARAMS) as (keyof typeof SILENCE_PARAMS)[]) {
      expect(SILENCE_FIELDS[f].default).toBe(SILENCE_PARAMS[f].default);
      expect([SILENCE_FIELDS[f].min, SILENCE_FIELDS[f].max]).toEqual([...SILENCE_PARAMS[f].range]);
      expect(DEFAULT_SETTINGS[f]).toBe(SILENCE_PARAMS[f].default);
    }
  });
  it("clamps typed values and ignores non-numbers", () => {
    expect(clampField("threshold", "-99")).toBe(-60);
    expect(clampField("threshold", "0")).toBe(-10);
    expect(clampField("minSilence", "0.05")).toBe(0.2);
    expect(clampField("padding", 0.1234)).toBe(0.123);
    for (const bad of ["", " ", "abc", "-", NaN, Infinity]) expect(clampField("padding", bad as never)).toBeNull();
  });
  it("reads the dry-run answer and refuses anything else", () => {
    expect(silencePlan({ ops: [{ op: "split" }], duration: 6, silences: { cuts: 2, secondsSaved: 1.5 } })).toEqual({ ops: [{ op: "split" }], cuts: 2, secondsSaved: 1.5, duration: 6 });
    expect(silencePlan({ ops: [], silences: { cuts: 0, secondsSaved: 0 } })?.duration).toBeNull();
    expect(silencePlan(null)).toBeNull();
    expect(silencePlan({ ops: "x", silences: { cuts: 1, secondsSaved: 1 } })).toBeNull();
    expect(silencePlan({ ops: [] })).toBeNull();
    expect(savedText({ cuts: 1, secondsSaved: 0.5 })).toBe("1 silence · 0.5 s shorter");
    expect(savedText({ cuts: 3, secondsSaved: 2 })).toBe("3 silences · 2 s shorter");
  });
  it("offers only clips that have sound", () => {
    expect(silenceClip(doc, "a")).toEqual({ id: "a", kind: "video" });
    expect(silenceClip(doc, "s")).toBeNull();
    expect(silenceClip(doc, "nope")).toBeNull();
    expect(silenceClip(doc, null)).toBeNull();
    expect(silenceClip(null, "a")).toBeNull();
  });
});
