import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIB_BASIC_IDS } from "../src/video-edit/looks.js";
import { applyOps, OpError } from "../src/video-edit/ops.js";
import { classifyRenderError } from "../src/video-edit/runner.js";
import { ADJUST_FIELDS, EditError, FEATURE_VERSION, featurePaths, KEYFRAME_PROPS, normalizeEdit, requiredVersion, SCHEMA_VERSION, type EditDoc } from "../src/video-edit/timeline.js";

const media = (extra: Record<string, unknown> = {}) => ({ id: "c", assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const doc = (kind: string, clip: Record<string, unknown>, schemaVersion?: number) => ({ ...(schemaVersion ? { schemaVersion } : {}), project: { size: "9:16", fps: 30 }, tracks: [{ id: "t", kind, clips: [clip] }] });
const video = (extra: Record<string, unknown>, v?: number) => doc("video", media(extra), v);
const FULL_ADJUST = { brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: 4000, blur: 10, vignette: 0.4 };
const clipOf = (d: EditDoc, i = 0) => d.tracks[0].clips[i] as unknown as Record<string, any>;
/** The highest version a FEATURE_VERSION row can stamp; v4+ rows are covered by their own spec. */
const top = (v: (typeof FEATURE_VERSION)[string]) => (typeof v === "number" ? v : Math.max(...Object.values(v)));
const upTo3 = (p: string) => top(FEATURE_VERSION[p]) <= 3;

function refused(input: unknown): EditError {
  try {
    normalizeEdit(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EditError);
    return error as EditError;
  }
  throw new Error("expected an EditError");
}

/** Every field of every track kind at once, with values that use each FEATURE_VERSION row. */
const MAX_DOC = {
  project: { size: "16:9", fps: 60 },
  tracks: [
    { id: "v", kind: "video", clips: [
      media({ id: "v1", fadeIn: 0.5, fadeOut: 0.5, speed: 2, volume: 0.5, transform: { x: 1, y: 2, scale: 1.5, rotate: 10, crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 } }, transitionIn: { type: "fade", duration: 1 },
        keyframes: Object.fromEntries(KEYFRAME_PROPS.map((p) => [p, [{ t: 0, value: 1 }, { t: 1, value: 0.5, ease: "easeIn" }]])), adjust: FULL_ADJUST, look: { id: "mono", intensity: 0.5 } }),
      media({ id: "v2", start: 2, transitionIn: { type: "wipeleft", duration: 0.5 } }),
    ] },
    { id: "o", kind: "overlay", clips: [media({ id: "o1", look: { pack: "pib-basic", id: "teal-orange" } })] },
    { id: "a", kind: "audio", clips: [media({ id: "a1" })] },
    { id: "x", kind: "text", clips: [{ id: "t1", start: 0, text: "Hi", duration: 2, font: "Inter" }, { id: "t2", start: 2, text: "Yo", duration: 1 }] },
    { id: "k", kind: "caption", clips: [{ id: "k1", start: 0, style: "karaoke", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
  ],
};

describe("schema v3: FEATURE_VERSION decides the version stamp", () => {
  it("reads 1, 2 and 3 (and 4) and refuses 6 with unsupported_version", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    for (const v of [1, 2, 3]) expect(normalizeEdit(video({}, v)).schemaVersion).toBe(1);
    expect(refused(video({}, 6))).toMatchObject({ reason: "unsupported_version", path: "schemaVersion", code: "bad_edit" });
  });

  it("every leaf a full doc emits has a row, and every v1-v3 row is emitted (no stale rows)", () => {
    const full = normalizeEdit(MAX_DOC);
    expect(full.schemaVersion).toBe(3);
    const emitted = new Set(featurePaths(full).map(([p]) => p));
    expect([...emitted].filter((p) => !Object.hasOwn(FEATURE_VERSION, p))).toEqual([]);
    expect(Object.keys(FEATURE_VERSION).filter(upTo3).filter((p) => !emitted.has(p))).toEqual([]);
  });

  it("an unknown emitted key or value throws instead of stamping a lower version", () => {
    const full = normalizeEdit(MAX_DOC);
    const withExtra = { ...full, tracks: [{ ...full.tracks[0], clips: [{ ...full.tracks[0].clips[0], sparkle: 1 }] }] } as unknown as EditDoc;
    expect(() => requiredVersion(withExtra)).toThrow(/clip\.sparkle = 1 has no FEATURE_VERSION row/);
    const badValue = { ...full, tracks: [{ ...full.tracks[0], clips: [{ ...full.tracks[0].clips[0], transitionIn: { type: "spin", duration: 1 } }] }] } as unknown as EditDoc;
    expect(() => requiredVersion(badValue)).toThrow(/clip\.transitionIn\.type = spin/);
  });

  // One doc per feature above v1: it stamps exactly that feature's version, and together they cover every such row.
  const FEATURES: [string, Record<string, unknown>, number][] = [
    ["non-fade transition", { transitionIn: { type: "slideup", duration: 1 } }, 2],
    ...KEYFRAME_PROPS.map((p): [string, Record<string, unknown>, number] => [`keyframes.${p}`, { keyframes: { [p]: [{ t: 0, value: 1 }] } }, 2]),
    ...ADJUST_FIELDS.map((f): [string, Record<string, unknown>, number] => [`adjust.${f}`, { adjust: { [f]: FULL_ADJUST[f] } }, 3]),
    ["look", { look: { id: "sepia" } }, 3],
  ];
  it.each(FEATURES)("%s alone stamps version %i", (_name, extra, version) => {
    const out = normalizeEdit(video(extra, 1));
    expect(out.schemaVersion).toBe(version);
    expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(out))))).toBe(JSON.stringify(out));
  });
  it("the feature table covers every v2-v3 row", () => {
    const covered = new Set(FEATURES.flatMap(([, extra]) => featurePaths(normalizeEdit(video(extra))).map(([p]) => p)));
    const above1 = Object.keys(FEATURE_VERSION).filter((p) => upTo3(p) && top(FEATURE_VERSION[p]) > 1);
    expect(above1.filter((p) => !covered.has(p))).toEqual([]);
  });
});

describe("schema v3: adjust and look", () => {
  it("drops neutral adjust values: an all-neutral adjust is a byte-identical v1 doc", () => {
    const plain = JSON.stringify(normalizeEdit(video({})));
    for (const neutral of [{}, { brightness: 0, contrast: 1, saturation: 1, temperature: 6600, blur: 0, vignette: 0 }, { brightness: -0 }]) {
      const out = normalizeEdit(video({ adjust: neutral }, 3));
      expect(out.schemaVersion).toBe(1);
      expect(JSON.stringify(out)).toBe(plain);
    }
    expect(clipOf(normalizeEdit(video({ adjust: { vignette: 0.3, brightness: 0, contrast: 1.2 } })))).toMatchObject({ adjust: { contrast: 1.2, vignette: 0.3 } });
    expect(Object.keys(clipOf(normalizeEdit(video({ adjust: { vignette: 0.3, blur: 2, brightness: 0.1 } }))).adjust)).toEqual(["brightness", "blur", "vignette"]);
  });

  it("a look is kept at any intensity, pack and intensity default", () => {
    expect(clipOf(normalizeEdit(video({ look: { id: "noir" } })))).toMatchObject({ look: { pack: "pib-basic", id: "noir", intensity: 1 } });
    const zero = normalizeEdit(video({ look: { id: "noir", intensity: 0 } }));
    expect(zero.schemaVersion).toBe(3);
    for (const id of PIB_BASIC_IDS) expect(normalizeEdit(video({ look: { id } })).schemaVersion).toBe(3);
  });

  it("v1 golden fixtures and a v2 doc round-trip byte-identical", () => {
    const dir = join(import.meta.dirname, "../src/video-edit/__fixtures__/golden-argv");
    const docs = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { doc: unknown }[]).map((c) => c.doc));
    expect(docs.length).toBeGreaterThan(10);
    for (const d of docs) expect(JSON.stringify(normalizeEdit(d))).toBe(JSON.stringify(d));
    const v2 = normalizeEdit(video({ transitionIn: { type: "zoomin", duration: 1 }, keyframes: { scale: [{ t: 0, value: 1 }, { t: 4, value: 2, ease: "easeOut" }] } }));
    expect(v2.schemaVersion).toBe(2);
    expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(v2))))).toBe(JSON.stringify(v2));
  });

  it.each([
    [{ adjust: { brightness: 1.5 } }, "out_of_range", "adjust.brightness"],
    [{ adjust: { contrast: -0.1 } }, "out_of_range", "adjust.contrast"],
    [{ adjust: { saturation: 3.01 } }, "out_of_range", "adjust.saturation"],
    [{ adjust: { temperature: 999 } }, "out_of_range", "adjust.temperature"],
    [{ adjust: { blur: 51 } }, "out_of_range", "adjust.blur"],
    [{ adjust: { vignette: 2 } }, "out_of_range", "adjust.vignette"],
    [{ adjust: { blur: Number.NaN } }, "invalid", "adjust.blur"],
    [{ adjust: { contrast: Number.POSITIVE_INFINITY } }, "invalid", "adjust.contrast"],
    [{ adjust: { saturation: "2" } }, "invalid", "adjust.saturation"],
    [{ adjust: { gamma: 1 } }, "invalid", "adjust.gamma"],
    [{ adjust: [1] }, "invalid", "adjust"],
    [{ look: { id: "nope" } }, "unknown_look", "look.id"],
    [{ look: { id: "constructor" } }, "unknown_look", "look.id"],
    [{ look: { id: "__proto__" } }, "unknown_look", "look.id"],
    [{ look: {} }, "unknown_look", "look.id"],
    [{ look: { pack: "../../etc", id: "mono" } }, "unknown_look", "look.pack"],
    [{ look: { id: "mono", intensity: 1.2 } }, "out_of_range", "look.intensity"],
    [{ look: { id: "mono", intensity: Number.NaN } }, "invalid", "look.intensity"],
    [{ look: "mono" }, "invalid", "look"],
  ])("refuses %j", (extra, reason, field) => {
    expect(refused(video(extra))).toMatchObject({ reason, path: `tracks[0].clips[0].${field}`, code: "bad_edit" });
  });

  it("adjust and look exist on video and overlay clips only (dropped elsewhere)", () => {
    expect(clipOf(normalizeEdit(doc("overlay", media({ adjust: { blur: 3 }, look: { id: "warm" } }))))).toMatchObject({ adjust: { blur: 3 }, look: { id: "warm" } });
    const audio = normalizeEdit(doc("audio", media({ adjust: { blur: 3 }, look: { id: "warm" } })));
    const text = normalizeEdit(doc("text", { id: "c", start: 0, text: "Hi", duration: 2, adjust: { blur: 3 }, look: { id: "warm" } }));
    for (const d of [audio, text]) expect([d.schemaVersion, "adjust" in clipOf(d), "look" in clipOf(d)]).toEqual([1, false, false]);
  });

  it("a rolled-back build fails a queued v3 render once as deterministic, not retried (Q11)", () => {
    const failure = classifyRenderError(new EditError("schemaVersion: version 3 is not supported", "unsupported_version", "schemaVersion"));
    expect(failure.kind).toBe("deterministic");
    try {
      normalizeEdit(video({}, 6));
    } catch (error) {
      expect(classifyRenderError(error).kind).toBe("deterministic");
    }
  });
});

describe("schema v3 ops (writer path: applyOps)", () => {
  const edit = () => ({ project: { size: "9:16", fps: 30 }, tracks: [
    { id: "v", kind: "video", clips: [media({ id: "a" })] },
    { id: "o", kind: "overlay", clips: [media({ id: "b" })] },
    { id: "t", kind: "text", clips: [{ id: "title", text: "Hi", start: 0, duration: 2 }] },
  ] });
  const find = (d: EditDoc, id: string) => d.tracks.flatMap((t) => t.clips as unknown as Record<string, any>[]).find((c) => c.id === id)!;

  it("setProps merges adjust per field, a neutral value or null removes, and the stamp follows", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "a", props: { adjust: { brightness: 0.2, blur: 4 } } }]);
    expect([d.schemaVersion, find(d, "a").adjust]).toEqual([3, { brightness: 0.2, blur: 4 }]);
    d = applyOps(d, [{ op: "setProps", clipId: "a", props: { adjust: { blur: 0, vignette: 0.5 } } }]);
    expect(find(d, "a").adjust).toEqual({ brightness: 0.2, vignette: 0.5 });
    d = applyOps(d, [{ op: "setProps", clipId: "a", props: { adjust: null } }]);
    expect([d.schemaVersion, "adjust" in find(d, "a")]).toEqual([1, false]);
  });

  it("setProps merges look (intensity alone), null removes it; text clips refuse both", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "b", props: { look: { id: "vivid" } } }, { op: "setProps", clipId: "b", props: { look: { intensity: 0.25 } } }]);
    expect([d.schemaVersion, find(d, "b").look]).toEqual([3, { pack: "pib-basic", id: "vivid", intensity: 0.25 }]);
    expect(() => applyOps(edit(), [{ op: "setProps", clipId: "a", props: { look: { intensity: 0.5 } } }])).toThrow(/look\.id/);
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { look: null } }]);
    expect([d.schemaVersion, "look" in find(d, "b")]).toEqual([1, false]);
    for (const props of [{ adjust: { blur: 1 } }, { look: { id: "mono" } }]) {
      try {
        applyOps(edit(), [{ op: "setProps", clipId: "title", props }]);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(OpError);
        expect(error).toMatchObject({ reason: "invalid", opIndex: 0 });
      }
    }
  });

  it("split, trim and move keep adjust and look on every part", () => {
    const styled = applyOps(edit(), [{ op: "setProps", clipId: "a", props: { adjust: { saturation: 2 }, look: { id: "fade", intensity: 0.5 } } }]);
    const d = applyOps(styled, [{ op: "split", clipId: "a", at: 2 }, { op: "trim", clipId: "a-2", out: 3.5 }, { op: "move", clipId: "a-2", trackId: "o", start: 5 }]);
    for (const id of ["a", "a-2"]) expect(find(d, id)).toMatchObject({ adjust: { saturation: 2 }, look: { id: "fade", intensity: 0.5 } });
    expect(d.schemaVersion).toBe(3);
  });
});
