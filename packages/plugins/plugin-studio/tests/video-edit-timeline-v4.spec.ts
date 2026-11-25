import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOps, moveTrackUndo, OP_NAMES, OpError } from "../src/video-edit/ops.js";
import { classifyRenderError } from "../src/video-edit/runner.js";
import { BLEND_MODES, EditError, FEATURE_VERSION, featurePaths, KEYFRAME_PROPS, normalizeEdit, requiredVersion, SCHEMA_VERSION, type EditDoc } from "../src/video-edit/timeline.js";

const media = (extra: Record<string, unknown> = {}) => ({ id: "c", assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const doc = (kind: string, clip: Record<string, unknown>, schemaVersion?: number) => ({ ...(schemaVersion ? { schemaVersion } : {}), project: { size: "9:16", fps: 30 }, tracks: [{ id: "t", kind, clips: [clip] }] });
const overlay = (extra: Record<string, unknown>, v?: number) => doc("overlay", media(extra), v);
const clipOf = (d: EditDoc, i = 0) => d.tracks[0].clips[i] as unknown as Record<string, any>;
const KEY = { color: "#00FF00", similarity: 0.3, blend: 0.1, spill: 0.5 };
const FRAME = { borderWidth: 6, borderColor: "#112233", cornerRadius: 20 };
/** The highest version a FEATURE_VERSION row can stamp; v5+ rows are covered by their own spec. */
const top = (v: (typeof FEATURE_VERSION)[string]) => (typeof v === "number" ? v : Math.max(...Object.values(v)));

function refused(input: unknown): EditError {
  try {
    normalizeEdit(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EditError);
    return error as EditError;
  }
  throw new Error("expected an EditError");
}

/** Every field of every track kind at once, with values that use each FEATURE_VERSION row (v1 to v4). */
const MAX_DOC = {
  project: { size: "16:9", fps: 60 },
  tracks: [
    { id: "v", kind: "video", clips: [
      media({ id: "v1", fadeIn: 0.5, fadeOut: 0.5, speed: 2, volume: 0.5, transform: { x: 1, y: 2, scale: 1.5, rotate: 10, crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 } }, transitionIn: { type: "fade", duration: 1 },
        keyframes: Object.fromEntries(KEYFRAME_PROPS.map((p) => [p, [{ t: 0, value: 1 }, { t: 1, value: 0.5, ease: "easeIn" }]])), adjust: { brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: 4000, blur: 10, vignette: 0.4 }, look: { id: "mono", intensity: 0.5 } }),
      media({ id: "v2", start: 2, transitionIn: { type: "wipeleft", duration: 0.5 } }),
    ] },
    { id: "o", kind: "overlay", clips: BLEND_MODES.filter((m) => m !== "normal").map((m, i) => media({ id: `o${i}`, start: i * 4, out: 4, blendMode: m, ...(i ? {} : { chromaKey: KEY, frame: FRAME }) })) },
    { id: "a", kind: "audio", clips: [media({ id: "a1" })] },
    { id: "x", kind: "text", clips: [{ id: "t1", start: 0, text: "Hi", duration: 2, font: "Inter" }] },
    { id: "k", kind: "caption", clips: [{ id: "k1", start: 0, style: "karaoke", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
  ],
};

describe("schema v4: FEATURE_VERSION rows for overlay layering", () => {
  it("reads 1 to 4 (and 5) and refuses 6 with unsupported_version", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    for (const v of [1, 2, 3, 4]) expect(normalizeEdit(overlay({}, v)).schemaVersion).toBe(1);
    expect(refused(overlay({}, 6))).toMatchObject({ reason: "unsupported_version", path: "schemaVersion", code: "bad_edit" });
  });

  it("every leaf a max-feature doc emits has a row, and every v1-v4 row is emitted (no stale rows)", () => {
    const full = normalizeEdit(MAX_DOC);
    expect(full.schemaVersion).toBe(4);
    const emitted = new Set(featurePaths(full).map(([p]) => p));
    expect([...emitted].filter((p) => !Object.hasOwn(FEATURE_VERSION, p))).toEqual([]);
    expect(Object.keys(FEATURE_VERSION).filter((p) => top(FEATURE_VERSION[p]) <= 4).filter((p) => !emitted.has(p))).toEqual([]);
    expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(full))))).toBe(JSON.stringify(full));
  });

  it("an unknown emitted key or blend value throws instead of stamping a lower version", () => {
    const full = normalizeEdit(MAX_DOC);
    const o = full.tracks[1];
    const swap = (clip: Record<string, unknown>) => ({ ...full, tracks: [full.tracks[0], { ...o, clips: [clip] }] }) as unknown as EditDoc;
    expect(() => requiredVersion(swap({ ...o.clips[0], glow: 1 }))).toThrow(/clip\.glow = 1 has no FEATURE_VERSION row/);
    expect(() => requiredVersion(swap({ ...o.clips[0], blendMode: "glow" }))).toThrow(/clip\.blendMode = glow/);
    expect(() => requiredVersion(swap({ ...o.clips[0], blendMode: "normal" }))).toThrow(/clip\.blendMode = normal/); // normal is never stored
    expect(() => requiredVersion(swap({ ...o.clips[0], chromaKey: { ...KEY, hue: 1 } }))).toThrow(/clip\.chromaKey\.hue/);
  });

  const FEATURES: [string, Record<string, unknown>][] = [
    ...BLEND_MODES.filter((m) => m !== "normal").map((m): [string, Record<string, unknown>] => [`blendMode ${m}`, { blendMode: m }]),
    ["chromaKey", { chromaKey: KEY }],
    ["chromaKey (defaults)", { chromaKey: { color: "#00b140" } }],
    ["frame border", { frame: { borderWidth: 4 } }],
    ["frame radius", { frame: { cornerRadius: 50 } }],
    ["frame", { frame: FRAME }],
  ];
  it.each(FEATURES)("%s alone stamps version 4 and round-trips", (_name, extra) => {
    const out = normalizeEdit(overlay(extra, 1));
    expect(out.schemaVersion).toBe(4);
    expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(out))))).toBe(JSON.stringify(out));
  });
  it("the feature table covers every v4 row", () => {
    const covered = new Set(FEATURES.flatMap(([, extra]) => featurePaths(normalizeEdit(overlay(extra))).map(([p]) => p)));
    const v4 = Object.entries(FEATURE_VERSION).filter(([, v]) => (typeof v === "number" ? v : Math.max(...Object.values(v))) === 4).map(([p]) => p);
    expect(v4.length).toBe(8);
    expect(v4.filter((p) => !covered.has(p))).toEqual([]);
  });
});

describe("schema v4: blendMode, chromaKey, frame", () => {
  it("defaults fill in; colours are upper-cased", () => {
    expect(clipOf(normalizeEdit(overlay({ chromaKey: { color: "#00b140" }, frame: { borderWidth: 2 } })))).toMatchObject({
      chromaKey: { color: "#00B140", similarity: 0.1, blend: 0, spill: 0 }, frame: { borderWidth: 2, borderColor: "#FFFFFF", cornerRadius: 0 },
    });
  });

  it("normal blend and an empty frame are dropped: the doc stays a byte-identical v1 doc", () => {
    const plain = JSON.stringify(normalizeEdit(overlay({})));
    for (const neutral of [{ blendMode: "normal" }, { blendMode: null }, { frame: {} }, { frame: { borderWidth: 0, cornerRadius: 0, borderColor: "#000000" } }, { chromaKey: null }]) {
      const out = normalizeEdit(overlay(neutral, 4));
      expect(out.schemaVersion).toBe(1);
      expect(JSON.stringify(out)).toBe(plain);
    }
  });

  it("v1 golden fixtures, a v2 and a v3 doc round-trip byte-identical", () => {
    const dir = join(import.meta.dirname, "../src/video-edit/__fixtures__/golden-argv");
    const docs = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { doc: unknown }[]).map((c) => c.doc));
    expect(docs.length).toBeGreaterThan(10);
    for (const d of docs) expect(JSON.stringify(normalizeEdit(d))).toBe(JSON.stringify(d));
    for (const [extra, v] of [[{ transitionIn: { type: "zoomin", duration: 1 } }, 2], [{ adjust: { blur: 3 }, look: { id: "noir" } }, 3]] as const) {
      const out = normalizeEdit(doc("video", media(extra)));
      expect(out.schemaVersion).toBe(v);
      expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(out))))).toBe(JSON.stringify(out));
    }
  });

  it("the fields exist on overlay clips only (dropped on video, audio and text)", () => {
    const layered = { blendMode: "screen", chromaKey: KEY, frame: FRAME };
    for (const d of [normalizeEdit(doc("video", media(layered))), normalizeEdit(doc("audio", media(layered))), normalizeEdit(doc("text", { id: "c", start: 0, text: "Hi", duration: 2, ...layered }))]) {
      expect([d.schemaVersion, ...["blendMode", "chromaKey", "frame"].map((k) => k in clipOf(d))]).toEqual([1, false, false, false]);
    }
  });

  it.each([
    [{ blendMode: "glow" }, "unknown_blend", "blendMode"],
    [{ blendMode: "__proto__" }, "unknown_blend", "blendMode"],
    [{ blendMode: 3 }, "unknown_blend", "blendMode"],
    [{ chromaKey: {} }, "invalid", "chromaKey.color"],
    [{ chromaKey: { color: "green" } }, "invalid", "chromaKey.color"],
    [{ chromaKey: { color: "#00FF00;drawbox" } }, "invalid", "chromaKey.color"],
    [{ chromaKey: { ...KEY, similarity: 0 } }, "out_of_range", "chromaKey.similarity"],
    [{ chromaKey: { ...KEY, similarity: 1.01 } }, "out_of_range", "chromaKey.similarity"],
    [{ chromaKey: { ...KEY, blend: 2 } }, "out_of_range", "chromaKey.blend"],
    [{ chromaKey: { ...KEY, spill: -0.1 } }, "out_of_range", "chromaKey.spill"],
    [{ chromaKey: { ...KEY, spill: Number.NaN } }, "invalid", "chromaKey.spill"],
    [{ chromaKey: { ...KEY, similarity: "0.3" } }, "invalid", "chromaKey.similarity"],
    [{ chromaKey: { ...KEY, hue: 1 } }, "invalid", "chromaKey.hue"],
    [{ chromaKey: [KEY] }, "invalid", "chromaKey"],
    [{ frame: { borderWidth: 41 } }, "out_of_range", "frame.borderWidth"],
    [{ frame: { borderWidth: -1 } }, "out_of_range", "frame.borderWidth"],
    [{ frame: { cornerRadius: 50.5 } }, "out_of_range", "frame.cornerRadius"],
    [{ frame: { cornerRadius: Number.POSITIVE_INFINITY } }, "invalid", "frame.cornerRadius"],
    [{ frame: { borderWidth: 2, borderColor: "#FFF" } }, "invalid", "frame.borderColor"],
    [{ frame: { shadow: 1 } }, "invalid", "frame.shadow"],
    [{ frame: "rounded" }, "invalid", "frame"],
  ])("refuses %j", (extra, reason, field) => {
    expect(refused(overlay(extra))).toMatchObject({ reason, path: `tracks[0].clips[0].${field}`, code: "bad_edit" });
  });

  it("a rolled-back build fails a queued v4 render once as deterministic, not retried (Q11)", () => {
    expect(classifyRenderError(new EditError("schemaVersion: version 4 is not supported", "unsupported_version", "schemaVersion")).kind).toBe("deterministic");
    let caught: unknown;
    try {
      normalizeEdit(overlay({}, 6));
    } catch (error) {
      caught = error;
    }
    expect(classifyRenderError(caught).kind).toBe("deterministic");
  });
});

describe("schema v4 ops (writer path: applyOps)", () => {
  const edit = () => ({ project: { size: "9:16", fps: 30 }, tracks: [
    { id: "v", kind: "video", clips: [media({ id: "a" })] },
    { id: "o", kind: "overlay", clips: [media({ id: "b" })] },
    { id: "o2", kind: "overlay", clips: [media({ id: "b2" })] },
    { id: "t", kind: "text", clips: [{ id: "title", text: "Hi", start: 0, duration: 2 }] },
  ] });
  const find = (d: EditDoc, id: string) => d.tracks.flatMap((t) => t.clips as unknown as Record<string, any>[]).find((c) => c.id === id)!;
  const opRefusal = (ops: unknown[], base: unknown = edit()): OpError => {
    try {
      applyOps(base, ops);
    } catch (error) {
      expect(error).toBeInstanceOf(OpError);
      return error as OpError;
    }
    throw new Error("expected an OpError");
  };

  it("setProps sets blendMode; normal or null removes it and the stamp follows", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "b", props: { blendMode: "multiply" } }]);
    expect([d.schemaVersion, find(d, "b").blendMode]).toEqual([4, "multiply"]);
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { blendMode: "normal" } }]);
    expect([d.schemaVersion, "blendMode" in find(d, "b")]).toEqual([1, false]);
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { blendMode: "screen" } }, { op: "setProps", clipId: "b", props: { blendMode: null } }]);
    expect([d.schemaVersion, "blendMode" in find(d, "b")]).toEqual([1, false]);
  });

  it("setProps merges chromaKey and frame per field; null removes them", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "b", props: { chromaKey: { color: "#00FF00" }, frame: { cornerRadius: 20 } } }]);
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { chromaKey: { spill: 0.4 }, frame: { borderWidth: 6, borderColor: "#ff0000" } } }]);
    expect(find(d, "b")).toMatchObject({ chromaKey: { color: "#00FF00", similarity: 0.1, blend: 0, spill: 0.4 }, frame: { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 } });
    expect(d.schemaVersion).toBe(4);
    expect(opRefusal([{ op: "setProps", clipId: "b2", props: { chromaKey: { spill: 0.4 } } }])).toMatchObject({ path: "tracks[2].clips[0].chromaKey.color", opIndex: 0 });
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { chromaKey: null, frame: null } }]);
    expect([d.schemaVersion, "chromaKey" in find(d, "b"), "frame" in find(d, "b")]).toEqual([1, false, false]);
  });

  it("video and text clips refuse the overlay-only props", () => {
    for (const clipId of ["a", "title"]) for (const props of [{ blendMode: "screen" }, { chromaKey: KEY }, { frame: FRAME }]) {
      expect(opRefusal([{ op: "setProps", clipId, props }])).toMatchObject({ reason: "invalid", opIndex: 0 });
    }
  });

  it("split, trim and move between overlays keep the layer fields; a move to the video track drops them", () => {
    const styled = applyOps(edit(), [{ op: "setProps", clipId: "b", props: { blendMode: "overlay", chromaKey: KEY, frame: FRAME } }]);
    const d = applyOps(styled, [{ op: "split", clipId: "b", at: 2 }, { op: "trim", clipId: "b-2", out: 3.5 }, { op: "move", clipId: "b-2", trackId: "o2", start: 5 }]);
    for (const id of ["b", "b-2"]) expect(find(d, id)).toMatchObject({ blendMode: "overlay", chromaKey: KEY, frame: FRAME });
    const down = applyOps(styled, [{ op: "move", clipId: "b", trackId: "v", start: 4 }]);
    expect([down.schemaVersion, ...["blendMode", "chromaKey", "frame"].map((k) => k in find(down, "b"))]).toEqual([1, false, false, false]);
  });
});

describe("moveTrack op", () => {
  const edit = () => ({ project: { size: "9:16", fps: 30 }, tracks: ["v", "o1", "o2", "o3"].map((id, i) => ({ id, kind: i ? "overlay" : "video", clips: [media({ id: `c-${id}`, ...(i === 2 ? { blendMode: "screen" } : {}) })] })) });
  const order = (d: EditDoc) => d.tracks.map((t) => t.id);

  it("is a listed op and moves one track, the others keep their order and clips", () => {
    expect(OP_NAMES).toContain("moveTrack");
    expect(order(applyOps(edit(), [{ op: "moveTrack", trackId: "o1", toIndex: 3 }]))).toEqual(["v", "o2", "o3", "o1"]);
    expect(order(applyOps(edit(), [{ op: "moveTrack", trackId: "o3", toIndex: 1 }]))).toEqual(["v", "o3", "o1", "o2"]);
    const same = applyOps(edit(), [{ op: "moveTrack", trackId: "o2", toIndex: 2 }]);
    expect(JSON.stringify(same)).toBe(JSON.stringify(normalizeEdit(edit())));
    const moved = applyOps(edit(), [{ op: "moveTrack", trackId: "o2", toIndex: 0 }]);
    expect(moved.tracks.map((t) => t.clips.map((c) => c.id))).toEqual([["c-o2"], ["c-v"], ["c-o1"], ["c-o3"]]);
    expect(moved.schemaVersion).toBe(4);
  });

  it.each([
    [{ toIndex: -1 }, "out_of_range"],
    [{ toIndex: 4 }, "out_of_range"],
    [{ toIndex: 1.5 }, "out_of_range"],
    [{ toIndex: "1" }, "out_of_range"],
    [{ toIndex: Number.NaN }, "out_of_range"],
    [{}, "out_of_range"],
  ])("refuses %j with %s and applies nothing", (extra, reason) => {
    const base = edit();
    const before = JSON.stringify(base);
    try {
      applyOps(base, [{ op: "moveTrack", trackId: "o1", toIndex: 1 }, { op: "moveTrack", trackId: "o1", ...extra }]);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OpError);
      expect(error).toMatchObject({ reason, path: "ops[1].toIndex", opIndex: 1 });
    }
    expect(JSON.stringify(base)).toBe(before);
  });

  it("refuses an unknown or missing track", () => {
    expect(() => applyOps(edit(), [{ op: "moveTrack", trackId: "nope", toIndex: 0 }])).toThrow(expect.objectContaining({ reason: "not_found", path: "ops[0].trackId" }));
    expect(() => applyOps(edit(), [{ op: "moveTrack", toIndex: 0 }])).toThrow(expect.objectContaining({ reason: "invalid", path: "ops[0].trackId" }));
  });

  it("undo is the inverse moveTrack: it restores the doc byte-identical", () => {
    const before = normalizeEdit(edit());
    for (const [trackId, toIndex] of [["v", 3], ["o3", 0], ["o1", 2], ["o2", 2]] as const) {
      const undo = moveTrackUndo(before, trackId);
      const after = applyOps(before, [{ op: "moveTrack", trackId, toIndex }]);
      expect(JSON.stringify(applyOps(after, [undo]))).toBe(JSON.stringify(before));
    }
    expect(() => moveTrackUndo(before, "nope")).toThrow(OpError);
  });

  it("reorder, by contrast, needs the full track list (moveTrack is the one-track form)", () => {
    expect(() => applyOps(edit(), [{ op: "reorder", trackIds: ["o1", "v"] }])).toThrow(/must list every track once/);
    expect(order(applyOps(edit(), [{ op: "reorder", trackIds: ["v", "o2", "o3", "o1"] }]))).toEqual(order(applyOps(edit(), [{ op: "moveTrack", trackId: "o1", toIndex: 3 }])));
  });
});
