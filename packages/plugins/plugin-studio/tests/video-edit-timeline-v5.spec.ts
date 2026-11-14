import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOps, OpError } from "../src/video-edit/ops.js";
import { classifyRenderError } from "../src/video-edit/runner.js";
import { isSticker, NOTO_EMOJI, PIB_SHAPES, STICKER_PACKS, stickerIds } from "../src/video-edit/sticker-packs.js";
import { BLEND_MODES, EditError, EFFECTS, FEATURE_VERSION, featurePaths, KEYFRAME_PROPS, normalizeEdit, requiredVersion, SCHEMA_VERSION, TEXT_ANIMATIONS, type EditDoc, type StickerRef, type TextAnimation } from "../src/video-edit/timeline.js";

const media = (extra: Record<string, unknown> = {}) => ({ id: "c", assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const sticker = (extra: Record<string, unknown> = {}) => ({ id: "c", sticker: { pack: "noto-emoji", id: "fire" }, in: 0, out: 4, start: 0, ...extra });
const title = (extra: Record<string, unknown> = {}) => ({ id: "c", start: 0, text: "Hi", duration: 2, ...extra });
const doc = (kind: string, clip: Record<string, unknown>, schemaVersion?: number) => ({ ...(schemaVersion ? { schemaVersion } : {}), project: { size: "9:16", fps: 30 }, tracks: [{ id: "t", kind, clips: [clip] }] });
/** A clip read back for assertions: any field, with the v5 objects typed. */
type ClipView = Record<string, unknown> & { sticker?: StickerRef; animation?: TextAnimation };
const clipOf = (d: EditDoc, i = 0) => d.tracks[0].clips[i] as unknown as ClipView;
const top = (v: (typeof FEATURE_VERSION)[string]) => (typeof v === "number" ? v : Math.max(...Object.values(v)));
const roundTrips = (d: EditDoc) => expect(JSON.stringify(normalizeEdit(JSON.parse(JSON.stringify(d))))).toBe(JSON.stringify(d));

function refused(input: unknown): EditError {
  try {
    normalizeEdit(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EditError);
    return error as EditError;
  }
  throw new Error("expected an EditError");
}

/** Every field of every track kind at once, with values that use each FEATURE_VERSION row (v1 to v5). */
const MAX_DOC = {
  project: { size: "16:9", fps: 60 },
  tracks: [
    { id: "v", kind: "video", clips: [
      media({ id: "v1", fadeIn: 0.5, fadeOut: 0.5, speed: 2, volume: 0.5, transform: { x: 1, y: 2, scale: 1.5, rotate: 10, crop: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 } }, transitionIn: { type: "fade", duration: 1 },
        keyframes: Object.fromEntries(KEYFRAME_PROPS.map((p) => [p, [{ t: 0, value: 1 }, { t: 1, value: 0.5, ease: "easeIn" }]])), adjust: { brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: 4000, blur: 10, vignette: 0.4 }, look: { id: "mono", intensity: 0.5 },
        effects: EFFECTS.slice(0, 3).map((id) => ({ id, intensity: 0.5 })) }),
      media({ id: "v2", start: 2, transitionIn: { type: "wipeleft", duration: 0.5 }, effects: EFFECTS.slice(3).map((id) => ({ id })) }),
    ] },
    { id: "o", kind: "overlay", clips: BLEND_MODES.filter((m) => m !== "normal").map((m, i) => media({ id: `o${i}`, start: i * 4, out: 4, blendMode: m, ...(i ? {} : { chromaKey: { color: "#00FF00" }, frame: { borderWidth: 2 } }) })) },
    { id: "s", kind: "overlay", clips: STICKER_PACKS.map((pack, i) => sticker({ id: `s${i}`, start: i * 4, sticker: { pack, id: stickerIds(pack)[0] } })) },
    { id: "a", kind: "audio", clips: [media({ id: "a1" })] },
    { id: "x", kind: "text", clips: TEXT_ANIMATIONS.map((a, i) => title({ id: `t${i}`, start: i * 2, animation: { in: a, out: TEXT_ANIMATIONS[(i + 1) % TEXT_ANIMATIONS.length] } })) },
    { id: "k", kind: "caption", clips: [{ id: "k1", start: 0, style: "karaoke", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
  ],
};

describe("schema v5: FEATURE_VERSION rows for stickers, effects and text animation", () => {
  it("reads 1 to 5 and refuses 6 with unsupported_version", () => {
    expect(SCHEMA_VERSION).toBe(5);
    for (const v of [1, 2, 3, 4, 5]) expect(normalizeEdit(doc("video", media(), v)).schemaVersion).toBe(1);
    expect(refused(doc("video", media(), 6))).toMatchObject({ reason: "unsupported_version", path: "schemaVersion", code: "bad_edit" });
  });

  it("every leaf a max-feature doc emits has a row, and every row is emitted (no stale rows)", () => {
    const full = normalizeEdit(MAX_DOC);
    expect(full.schemaVersion).toBe(5);
    const emitted = new Set(featurePaths(full).map(([p]) => p));
    expect([...emitted].filter((p) => !Object.hasOwn(FEATURE_VERSION, p))).toEqual([]);
    expect(Object.keys(FEATURE_VERSION).filter((p) => !emitted.has(p))).toEqual([]);
    roundTrips(full);
  });

  it("an unknown emitted key or value throws instead of stamping a lower version", () => {
    const full = normalizeEdit(MAX_DOC);
    const swap = (t: number, clip: Record<string, unknown>) => ({ ...full, tracks: full.tracks.map((tr, i) => (i === t ? { ...tr, clips: [clip] } : tr)) }) as unknown as EditDoc;
    const [v, s, x] = [full.tracks[0].clips[0], full.tracks[2].clips[0], full.tracks[4].clips[0]] as unknown as ClipView[];
    expect(() => requiredVersion(swap(0, { ...v, effects: [{ id: "glitch", intensity: 1 }] }))).toThrow(/clip\.effects\[\]\.id = glitch/);
    expect(() => requiredVersion(swap(0, { ...v, effects: [{ id: "shake", intensity: 1, seed: 3 }] }))).toThrow(/clip\.effects\[\]\.seed/);
    expect(() => requiredVersion(swap(2, { ...s, sticker: { pack: "giphy", id: "x" } }))).toThrow(/clip\.sticker\.pack = giphy/);
    expect(() => requiredVersion(swap(4, { ...x, animation: { in: "spin", inDuration: 1 } }))).toThrow(/clip\.animation\.in = spin/);
    expect(() => requiredVersion(swap(4, { ...x, animation: { ...x.animation, loop: true } }))).toThrow(/clip\.animation\.loop/);
  });

  const FEATURES: [string, string, Record<string, unknown>][] = [
    ...STICKER_PACKS.map((pack): [string, string, Record<string, unknown>] => [`sticker ${pack}`, "overlay", sticker({ sticker: { pack, id: stickerIds(pack).at(-1) } })]),
    ...EFFECTS.map((id): [string, string, Record<string, unknown>] => [`effect ${id} on video`, "video", media({ effects: [{ id }] })]),
    ["effects on overlay", "overlay", media({ effects: [{ id: "flash", intensity: 0.3 }, { id: "blurIn" }] })],
    ...TEXT_ANIMATIONS.map((a): [string, string, Record<string, unknown>] => [`animation in ${a}`, "text", title({ animation: { in: a } })]),
    ...TEXT_ANIMATIONS.map((a): [string, string, Record<string, unknown>] => [`animation out ${a}`, "text", title({ animation: { out: a, outDuration: 1 } })]),
  ];
  it.each(FEATURES)("%s alone stamps version 5 and round-trips", (_name, kind, clip) => {
    const out = normalizeEdit(doc(kind, clip, 1));
    expect(out.schemaVersion).toBe(5);
    roundTrips(out);
  });
  it("the feature table covers every v5 row", () => {
    const covered = new Set(FEATURES.flatMap(([, kind, clip]) => featurePaths(normalizeEdit(doc(kind, clip))).map(([p]) => p)));
    const v5 = Object.keys(FEATURE_VERSION).filter((p) => top(FEATURE_VERSION[p]) === 5);
    expect(v5.length).toBe(8);
    expect(v5.filter((p) => !covered.has(p))).toEqual([]);
  });

  it("v1 golden fixtures and a v2, v3 and v4 doc round-trip byte-identical", () => {
    const dir = join(import.meta.dirname, "../src/video-edit/__fixtures__/golden-argv");
    const docs = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { doc: unknown }[]).map((c) => c.doc));
    expect(docs.length).toBeGreaterThan(10);
    for (const d of docs) expect(JSON.stringify(normalizeEdit(d))).toBe(JSON.stringify(d));
    for (const [kind, extra, v] of [["video", { transitionIn: { type: "zoomin", duration: 1 } }, 2], ["video", { adjust: { blur: 3 }, look: { id: "noir" } }, 3], ["overlay", { blendMode: "screen", frame: { cornerRadius: 10 } }, 4]] as const) {
      const out = normalizeEdit(doc(kind, media(extra)));
      expect(out.schemaVersion).toBe(v);
      roundTrips(out);
    }
  });

  it("a rolled-back build fails a queued v5 render once as deterministic, not retried (Q11)", () => {
    expect(classifyRenderError(new EditError("schemaVersion: version 5 is not supported", "unsupported_version", "schemaVersion")).kind).toBe("deterministic");
    expect(classifyRenderError(refused(doc("video", media(), 6))).kind).toBe("deterministic");
  });
});

describe("schema v5: the sticker manifest", () => {
  it("holds the 150-sticker Noto subset and the pib-shapes set, with unique ids and codepoints", () => {
    expect(Object.keys(NOTO_EMOJI)).toHaveLength(150);
    expect(new Set(Object.values(NOTO_EMOJI)).size).toBe(150);
    for (const [id, cp] of Object.entries(NOTO_EMOJI)) expect([id, cp]).toEqual([expect.stringMatching(/^[a-z0-9-]{1,32}$/), expect.stringMatching(/^[0-9a-f]{4,5}$/)]);
    for (const id of Object.keys(PIB_SHAPES)) expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
  });
  it("isSticker accepts manifest keys only", () => {
    expect(isSticker("noto-emoji", "fire")).toBe(true);
    expect(isSticker("pib-shapes", "star")).toBe(true);
    for (const [pack, id] of [["noto-emoji", "star-x"], ["noto-emoji", "__proto__"], ["noto-emoji", "toString"], ["pib-shapes", "../fire"], ["library", "fire"], ["__proto__", "fire"], [1, "fire"], ["noto-emoji", 1]]) expect(isSticker(pack, id)).toBe(false);
  });
});

describe("schema v5: normalizeEdit", () => {
  it("a sticker clip has no assetId or version, has no sound, and lives on overlay tracks only", () => {
    const out = clipOf(normalizeEdit(doc("overlay", sticker({ version: 3 }))));
    expect(Object.keys(out).slice(0, 4)).toEqual(["id", "start", "sticker", "in"]);
    expect(["assetId" in out, "version" in out]).toEqual([false, false]);
    expect(refused(doc("overlay", sticker({ keyframes: { volume: [{ t: 0, value: 1 }] } })))).toMatchObject({ reason: "no_audio" });
    for (const kind of ["video", "audio"]) expect(refused(doc(kind, sticker()))).toMatchObject({ reason: "invalid", path: "tracks[0].clips[0].sticker" });
  });

  it("effects: intensity defaults to 1, a 0 intensity is dropped, and an empty list leaves a v1 doc", () => {
    expect(clipOf(normalizeEdit(doc("video", media({ effects: [{ id: "shake" }, { id: "flash", intensity: 0 }] })))).effects).toEqual([{ id: "shake", intensity: 1 }]);
    const plain = JSON.stringify(normalizeEdit(doc("video", media())));
    for (const neutral of [{ effects: [] }, { effects: null }, { effects: [{ id: "flash", intensity: 0 }] }]) expect(JSON.stringify(normalizeEdit(doc("video", media(neutral), 5)))).toBe(plain);
    for (const kind of ["audio", "text"]) expect("effects" in clipOf(normalizeEdit(doc(kind, kind === "text" ? title({ effects: [{ id: "shake" }] }) : media({ effects: [{ id: "shake" }] }))))).toBe(false);
  });

  it("animation: only the sides set are kept, lengths default to 0.5 s (shared on a short clip)", () => {
    expect(clipOf(normalizeEdit(doc("text", title({ animation: { in: "pop", outDuration: 9 } })))).animation).toEqual({ in: "pop", inDuration: 0.5 });
    expect(clipOf(normalizeEdit(doc("text", title({ duration: 0.6, animation: { in: "pop", out: "fadeUp" } })))).animation).toEqual({ in: "pop", inDuration: 0.3, out: "fadeUp", outDuration: 0.3 });
    const plain = JSON.stringify(normalizeEdit(doc("text", title())));
    for (const neutral of [{ animation: null }, { animation: {} }, { animation: { in: null, out: null, inDuration: 1 } }]) expect(JSON.stringify(normalizeEdit(doc("text", title(neutral), 5)))).toBe(plain);
  });

  it.each([
    ["overlay", sticker({ sticker: { pack: "giphy", id: "fire" } }), "unknown_sticker", "sticker.pack"],
    ["overlay", sticker({ sticker: { id: "fire" } }), "unknown_sticker", "sticker.pack"],
    ["overlay", sticker({ sticker: { pack: "noto-emoji", id: "fire2" } }), "unknown_sticker", "sticker.id"],
    ["overlay", sticker({ sticker: { pack: "noto-emoji", id: "__proto__" } }), "unknown_sticker", "sticker.id"],
    ["overlay", sticker({ sticker: { pack: "pib-shapes", id: "../../etc/passwd" } }), "unknown_sticker", "sticker.id"],
    ["overlay", sticker({ sticker: { pack: "pib-shapes", id: "fire" } }), "unknown_sticker", "sticker.id"],
    ["overlay", sticker({ sticker: { pack: "noto-emoji", id: "fire", file: "x.png" } }), "invalid", "sticker.file"],
    ["overlay", sticker({ sticker: "fire" }), "invalid", "sticker"],
    ["overlay", sticker({ assetId: "asset-1", version: 1 }), "invalid", "assetId"],
    ["video", media({ effects: [{ id: "glitch" }] }), "unknown_effect", "effects[0].id"],
    ["video", media({ effects: [{ id: "toString" }] }), "unknown_effect", "effects[0].id"],
    ["video", media({ effects: [{ id: "shake" }, { id: "shake", intensity: 0 }] }), "duplicate", "effects[1].id"],
    ["video", media({ effects: [{ id: "shake" }, { id: "flash" }, { id: "rgbSplit" }, { id: "blurIn" }] }), "too_many", "effects"],
    ["video", media({ effects: [{ id: "shake", intensity: 1.01 }] }), "out_of_range", "effects[0].intensity"],
    ["video", media({ effects: [{ id: "shake", intensity: -0.1 }] }), "out_of_range", "effects[0].intensity"],
    ["video", media({ effects: [{ id: "shake", intensity: Number.NaN }] }), "invalid", "effects[0].intensity"],
    ["video", media({ effects: [{ id: "shake", intensity: "0.5" }] }), "invalid", "effects[0].intensity"],
    ["video", media({ effects: [{ id: "shake", at: 1 }] }), "invalid", "effects[0].at"],
    ["video", media({ effects: ["shake"] }), "invalid", "effects[0]"],
    ["video", media({ effects: { id: "shake" } }), "invalid", "effects"],
    ["text", title({ animation: { in: "spin" } }), "unknown_animation", "animation.in"],
    ["text", title({ animation: { out: "__proto__" } }), "unknown_animation", "animation.out"],
    ["text", title({ animation: { in: 3 } }), "unknown_animation", "animation.in"],
    ["text", title({ animation: { in: "pop", inDuration: 0.01 } }), "out_of_range", "animation.inDuration"],
    ["text", title({ animation: { in: "pop", inDuration: 5.5 } }), "out_of_range", "animation.inDuration"],
    ["text", title({ animation: { out: "pop", outDuration: Number.POSITIVE_INFINITY } }), "invalid", "animation.outDuration"],
    ["text", title({ animation: { in: "pop", inDuration: 1.5, out: "fadeUp", outDuration: 1 } }), "out_of_range", "animation.outDuration"],
    ["text", title({ animation: { in: "pop", ease: "linear" } }), "invalid", "animation.ease"],
    ["text", title({ animation: "pop" }), "invalid", "animation"],
  ])("%s refuses %j", (kind, clip, reason, field) => {
    expect(refused(doc(kind, clip))).toMatchObject({ reason, path: `tracks[0].clips[0].${field}`, code: "bad_edit" });
  });
});

describe("schema v5 ops (writer path: applyOps)", () => {
  const edit = () => ({ project: { size: "9:16", fps: 30 }, tracks: [
    { id: "v", kind: "video", clips: [media({ id: "a" })] },
    { id: "o", kind: "overlay", clips: [media({ id: "b" })] },
    { id: "o2", kind: "overlay", clips: [sticker({ id: "s" })] },
    { id: "t", kind: "text", clips: [title({ id: "title", duration: 4 })] },
  ] });
  const find = (d: EditDoc, id: string) => d.tracks.flatMap((t) => t.clips as unknown as ClipView[]).find((c) => c.id === id)!;
  const opRefusal = (ops: unknown[], base: unknown = edit()): OpError => {
    try {
      applyOps(base, ops);
    } catch (error) {
      expect(error).toBeInstanceOf(OpError);
      return error as OpError;
    }
    throw new Error("expected an OpError");
  };

  it("setProps swaps an overlay's source between an asset and a sticker", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "b", props: { sticker: { pack: "pib-shapes", id: "star" } } }]);
    expect([d.schemaVersion, find(d, "b").sticker, "assetId" in find(d, "b"), "version" in find(d, "b")]).toEqual([5, { pack: "pib-shapes", id: "star" }, false, false]);
    d = applyOps(d, [{ op: "setProps", clipId: "b", props: { assetId: "asset-2", version: 2 } }, { op: "setProps", clipId: "s", props: { assetId: "asset-3", version: 1 } }]);
    expect([d.schemaVersion, find(d, "b").assetId, "sticker" in find(d, "b"), "sticker" in find(d, "s")]).toEqual([1, "asset-2", false, false]);
    expect(opRefusal([{ op: "setProps", clipId: "b", props: { sticker: { pack: "noto-emoji", id: "nope" } } }])).toMatchObject({ reason: "unknown_sticker", opIndex: 0 });
    expect(opRefusal([{ op: "setProps", clipId: "a", props: { sticker: { pack: "noto-emoji", id: "fire" } } }])).toMatchObject({ reason: "invalid", path: "ops[0].props.sticker" });
  });

  it("setProps sets effects on video and overlay clips (the list replaces; null removes) and refuses them on text", () => {
    let d = applyOps(edit(), [{ op: "setProps", clipId: "a", props: { effects: [{ id: "zoomPunch" }] } }, { op: "setProps", clipId: "s", props: { effects: [{ id: "shake", intensity: 0.4 }, { id: "flash" }] } }]);
    expect([d.schemaVersion, find(d, "a").effects, find(d, "s").effects]).toEqual([5, [{ id: "zoomPunch", intensity: 1 }], [{ id: "shake", intensity: 0.4 }, { id: "flash", intensity: 1 }]]);
    d = applyOps(d, [{ op: "setProps", clipId: "s", props: { effects: [{ id: "rgbSplit" }] } }, { op: "setProps", clipId: "a", props: { effects: null } }]);
    expect([find(d, "s").effects, "effects" in find(d, "a")]).toEqual([[{ id: "rgbSplit", intensity: 1 }], false]);
    expect(opRefusal([{ op: "setProps", clipId: "title", props: { effects: [{ id: "shake" }] } }])).toMatchObject({ reason: "invalid", path: "ops[0].props.effects" });
    expect(opRefusal([{ op: "setProps", clipId: "a", props: { effects: [{ id: "vhs" }] } }])).toMatchObject({ reason: "unknown_effect", opIndex: 0 });
  });

  it("setProps merges a text animation per field; null removes a side or the whole animation", () => {
    const noSticker = { ...edit(), tracks: edit().tracks.filter((t) => t.id !== "o2") };
    let d = applyOps(noSticker, [{ op: "setProps", clipId: "title", props: { animation: { in: "typewriter" } } }, { op: "setProps", clipId: "title", props: { animation: { out: "slideLeft", inDuration: 1.2 } } }]);
    expect([d.schemaVersion, find(d, "title").animation]).toEqual([5, { in: "typewriter", inDuration: 1.2, out: "slideLeft", outDuration: 0.5 }]);
    d = applyOps(d, [{ op: "setProps", clipId: "title", props: { animation: { in: null } } }]);
    expect(find(d, "title").animation).toEqual({ out: "slideLeft", outDuration: 0.5 });
    d = applyOps(d, [{ op: "setProps", clipId: "title", props: { animation: null } }]);
    expect([d.schemaVersion, "animation" in find(d, "title")]).toEqual([1, false]);
    expect(opRefusal([{ op: "setProps", clipId: "b", props: { animation: { in: "pop" } } }])).toMatchObject({ reason: "invalid", path: "ops[0].props.animation" });
    expect(opRefusal([{ op: "setProps", clipId: "title", props: { animation: { in: "wobble" } } }])).toMatchObject({ reason: "unknown_animation", opIndex: 0 });
  });

  it("split gives the entry animation to the left part and the exit to the right, each fitted to its part", () => {
    const animated = applyOps(edit(), [{ op: "setProps", clipId: "title", props: { animation: { in: "pop", inDuration: 2, out: "fadeUp", outDuration: 1.5 } } }]);
    const d = applyOps(animated, [{ op: "split", clipId: "title", at: 1 }]);
    expect([find(d, "title").animation, find(d, "title-2").animation]).toEqual([{ in: "pop", inDuration: 1 }, { out: "fadeUp", outDuration: 1.5 }]);
    const exitOnly = applyOps(edit(), [{ op: "setProps", clipId: "title", props: { animation: { out: "pop" } } }, { op: "split", clipId: "title", at: 2 }]);
    expect(["animation" in find(exitOnly, "title"), find(exitOnly, "title-2").animation]).toEqual([false, { out: "pop", outDuration: 0.5 }]);
  });

  it("split, trim and move between overlays keep stickers and effects; a sticker can't go on the video track", () => {
    const styled = applyOps(edit(), [{ op: "setProps", clipId: "s", props: { effects: [{ id: "blurIn" }], blendMode: "screen" } }]);
    const d = applyOps(styled, [{ op: "split", clipId: "s", at: 2 }, { op: "trim", clipId: "s-2", out: 3.5 }, { op: "move", clipId: "s-2", trackId: "o", start: 5 }]);
    for (const id of ["s", "s-2"]) expect(find(d, id)).toMatchObject({ sticker: { pack: "noto-emoji", id: "fire" }, effects: [{ id: "blurIn", intensity: 1 }], blendMode: "screen" });
    expect(find(d, "s-2")).toMatchObject({ in: 2, out: 3.5, start: 5 });
    expect(opRefusal([{ op: "move", clipId: "s", trackId: "v", start: 4 }], styled)).toMatchObject({ reason: "invalid", opIndex: 0, path: "tracks[0].clips[1].sticker" });
    const down = applyOps(applyOps(edit(), [{ op: "setProps", clipId: "b", props: { effects: [{ id: "flash" }] } }]), [{ op: "move", clipId: "b", trackId: "v", start: 4 }]);
    expect(find(down, "b").effects).toEqual([{ id: "flash", intensity: 1 }]);
  });
});
