import { describe, expect, it } from "vitest";
import { hasClipAudio } from "../src/video-edit/compile-audio.js";
import { compileVideo, frameAt, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { editWeight, inputWeight, planRender, type RenderPass, type RenderPlan } from "../src/video-edit/render-plan.js";
import { clipDuration, editDuration, normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";

const ms = (n: number) => Math.round(n * 1000) / 1000;
const WD = "/srv/studio/render-1";
const fhd = (name: string, extra: object = {}) => ({ path: `${WD}/${name}`, kind: "video" as const, hasAudio: false, width: 1080, height: 1920, fps: 30, ...extra });
const inputs: CompileInputs = {
  [inputKey("g", 1)]: fhd("g.mp4"),
  [inputKey("s", 1)]: fhd("s.mp4", { hasAudio: true }),
  [inputKey("uhd", 1)]: fhd("uhd.mp4", { width: 3840, height: 2160 }),
  [inputKey("uhds", 1)]: fhd("uhds.mp4", { width: 3840, height: 2160, hasAudio: true }),
  [inputKey("uhd60", 1)]: fhd("uhd60.mp4", { width: 3840, height: 2160, fps: 60 }),
  [inputKey("huge", 1)]: fhd("huge.mp4", { width: 7680, height: 4320, fps: 60 }),
  [inputKey("png", 1)]: { path: `${WD}/logo.png`, kind: "image", width: 1080, height: 1080 },
  [inputKey("music", 1)]: { path: `${WD}/music.m4a`, kind: "audio", hasAudio: true },
};
const GRADE = { look: { id: "warm", intensity: 0.5 }, adjust: { vignette: 0.5 } };
const clip = (id: string, assetId: string, start: number, len: number, extra: object = {}) => ({ id, assetId, version: 1, start, in: 0, out: len, ...extra });
/** `n` back-to-back clips of `len` s; `pick(i)` overrides the asset or adds fields. */
const run = (n: number, len: number, pick: (i: number) => object = () => ({})) =>
  Array.from({ length: n }, (_, i) => clip(`c${i}`, "g", Math.round(i * len * 1000) / 1000, len, { ...GRADE, ...pick(i) }));
const edit = (main: unknown[], rest: unknown[] = [], fps = 30) => normalizeEdit({ project: { size: "9:16", fps }, tracks: [{ id: "v", kind: "video", clips: main }, ...rest] });
/** The budget these cases were written for (the tuned defaults in render-plan.ts may move; the planning rules do not). */
const AUDIO_WEIGHT = 0.25;
const SPEC = { passBudget: 8, audioWeight: AUDIO_WEIGHT };
const plan = (doc: EditDoc, passBudget = SPEC.passBudget, audioWeight = SPEC.audioWeight) => planRender(doc, inputs, { workdir: WD, passBudget, audioWeight });
function multi(p: RenderPlan) {
  if (p.kind !== "multi") throw new Error(`expected multi, got ${p.kind}`);
  return p;
}
const mainOf = (doc: EditDoc) => doc.tracks[0].clips as MediaClip[];
const graph = (doc: EditDoc, sources: CompileInputs) => compileVideo(doc, sources, "out.mp4").files[0].content;
const inputCount = (doc: EditDoc, sources: CompileInputs) => compileVideo(doc, sources, "out.mp4").args.filter((a) => a === "-i").length;

describe("render plan weights", () => {
  it("AC1: an edit within budget renders in one pass", () => {
    const p = plan(edit(run(3, 10), [{ id: "o", kind: "overlay", clips: [clip("o1", "png", 1, 2)] }, { id: "m", kind: "audio", clips: [clip("m1", "music", 0, 30)] }]));
    expect(p).toEqual({ kind: "single", weight: 4.25 });
  });

  it("AC2: every -i counts, picture inputs by pixel rate", () => {
    const fps = 30;
    expect(inputWeight(inputs["uhd@1"], fps)).toBe(4);
    expect(inputWeight(inputs["uhd60@1"], fps)).toBe(8);
    expect(inputWeight({ path: "x.png", kind: "image", width: 3840, height: 2160, fps: 120 }, fps)).toBe(4); // images run at the project rate
    expect(inputWeight(inputs["png@1"], fps)).toBe(1);
    expect(inputWeight(inputs["png@1"], 60)).toBe(1.125);
    expect(inputWeight({ path: "x.mp4", kind: "video" }, fps)).toBe(1);
    expect(inputWeight(inputs["music@1"], fps, 0.5)).toBe(0.5);
    const doc = edit([clip("a", "s", 0, 5), clip("b", "uhd", 5, 5)], [
      { id: "o", kind: "overlay", clips: [clip("o1", "png", 0, 2), clip("o2", "s", 3, 2)] },
      { id: "m", kind: "audio", clips: [clip("m1", "music", 0, 10)] },
      { id: "vo", kind: "audio", clips: [clip("vo1", "music", 1, 3, { volume: 0.5 })] },
    ]);
    // main 1 + 0.25 (clip audio) + 4, overlays 1 + 1 + 0.25, music 0.25, voiceover 0.25
    expect(editWeight(doc, inputs, AUDIO_WEIGHT)).toBe(8);
    expect(inputCount(doc, inputs)).toBe(8);
  });

  it("AC12: one input heavier than budget - 1 is too complex; a heavy edit that fits stays single", () => {
    expect(plan(edit([clip("a", "huge", 0, 5), clip("b", "g", 5, 5)]))).toMatchObject({ kind: "tooComplex", input: "huge@1", inputWeight: 32 });
    expect(plan(edit([clip("a", "uhd60", 0, 5), clip("b", "g", 5, 5)]))).toMatchObject({ kind: "tooComplex", input: "uhd60@1" });
    expect(plan(edit([clip("a", "uhd60", 0, 5)]))).toEqual({ kind: "single", weight: 8 });
  });
});

describe("main-track chunks", () => {
  it("AC3: 2 x budget + 1 graded clips: chunks in time order, each within budget - 1", () => {
    const p = multi(plan(edit(run(17, 1))));
    expect(p.levels).toBe(1);
    expect(p.passes.map((x) => mainOf(x.doc).map((c) => c.id))).toEqual([
      ["c0", "c1", "c2", "c3", "c4", "c5", "c6"], ["c7", "c8", "c9", "c10", "c11", "c12", "c13"], ["c14", "c15", "c16"],
    ]);
    for (const x of p.passes) expect(x.weight).toBeLessThanOrEqual(7);
    expect(mainOf(p.final.doc).map((c) => [c.assetId, c.start, c.out])).toEqual([["chunk-0-0", 0, 7], ["chunk-0-1", 7, 7], ["chunk-0-2", 14, 3]]);
  });

  it("PAR-11217: a main track that fits one chunk is cut in two at the cut nearest its middle", () => {
    // 6 x 30 s graded clips (the worst-case edit's base): one chunk of weight 6 would fit; the pipeline runs two at once.
    const ov = (n: number, len: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, kind: "overlay", clips: [clip(`o${i}c`, "g", 0, len, GRADE)] }));
    const doc = edit(run(6, 30), ov(3, 180));
    const p = multi(plan(doc));
    const chunks = p.passes.filter((x) => x.kind === "chunk");
    expect(chunks.map((x) => [x.id, x.origin, x.duration, mainOf(x.doc).map((c) => c.id)])).toEqual([
      ["chunk-0-0", 0, 90, ["c0", "c1", "c2"]],
      ["chunk-0-1", 90, 90, ["c3", "c4", "c5"]],
    ]);
    // 7 clips: the middle (70 s) is not a cut; 60 / 80 s and 80 / 60 s are equally near: the first wins.
    expect(multi(plan(edit(run(7, 20), ov(3, 140)))).passes
      .filter((x) => x.kind === "chunk").map((x) => mainOf(x.doc).length)).toEqual([3, 4]);
    // A cut inside a dissolve is allowed (the xfade moves to the final doc): here it is the one nearest the middle.
    const dissolve = { type: "dissolve", duration: 0.5 };
    const xf = multi(plan(edit([clip("a", "g", 0, 15, GRADE), clip("b", "g", 14.5, 10, { ...GRADE, transitionIn: dissolve }), clip("c", "g", 24.5, 5, GRADE)], ov(6, 29.5))));
    expect(xf.passes.filter((x) => x.kind === "chunk").map((x) => mainOf(x.doc).map((c) => c.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("PAR-11217: when two chunk outputs would weigh what their clips did, one chunk as before", () => {
    // Two plain clips with sound (1.25 each): two outputs weigh 2.5 again, so halving makes no progress and is skipped.
    const doc = edit([clip("a", "s", 0, 5), clip("b", "s", 5, 5)], Array.from({ length: 3 }, (_, i) => ({ id: `o${i}`, kind: "overlay", clips: [clip(`o${i}c`, "g", 0, 10, GRADE)] })));
    const p = multi(plan(doc, 4));
    expect(p.passes.filter((x) => x.kind === "chunk").map((x) => x.id)).toEqual(["chunk-0-0"]);
  });

  it("AC4: boundaries on the frame grid, chunks tile the main track, durations add up in frames", () => {
    const main = Array.from({ length: 17 }, (_, i) => clip(`c${i}`, "g", Math.round(i * 1.05 * 1000) / 1000, 1.01));
    const doc = edit(main);
    const p = multi(plan(doc));
    const finals = mainOf(p.final.doc);
    const end = Math.max(...main.map((c) => c.start + c.out));
    for (const [i, f] of finals.entries()) {
      const pass = p.passes[i];
      // The final clip plays the chunk where its clips were; the chunk starts on the frame the previous one stops on.
      expect(f.start).toBe(pass.origin);
      expect(f.out).toBe(pass.duration);
      expect(frameAt(ms(f.start + f.out), 30) - frameAt(f.start, 30)).toBe(pass.frames);
      if (i > 0) expect(frameAt(f.start, 30)).toBe(frameAt(ms(finals[i - 1].start + finals[i - 1].out), 30));
    }
    expect(p.passes.reduce((s, x) => s + x.frames, 0)).toBe(frameAt(end, 30));
    expect(editDuration(p.final.doc)).toBe(editDuration(doc));
  });

  it("AC5: gaps inside a chunk, and before its first clip, are black in that chunk", () => {
    const main = run(17, 1).map((c, i) => ({ ...c, start: c.start + (i >= 3 ? 2 : 0) + (i >= 7 ? 1.5 : 0) }));
    const p = multi(plan(edit(main)));
    expect(mainOf(p.passes[0].doc).map((c) => c.start)).toEqual([0, 1, 2, 5, 6, 7, 8]);
    expect(graph(p.passes[0].doc, p.passes[0].sources)).toContain("color=c=black:s=1080x1920:r=30:d=2,");
    expect(mainOf(p.passes[1].doc)[0].start).toBe(1.5);
    expect(graph(p.passes[1].doc, p.passes[1].sources)).toContain("color=c=black:s=1080x1920:r=30:d=1.5,");
  });

  it("AC6: an xfade across a boundary moves to the final doc; a fade from black stays in its chunk", () => {
    const main = run(17, 1, (i) => (i === 7 ? { transitionIn: { type: "dissolve", duration: 0.5 } } : i === 14 ? { transitionIn: { type: "fade", duration: 0.3 } } : {}))
      .map((c, i) => ({ ...c, start: c.start - (i >= 7 ? 0.5 : 0) + (i >= 14 ? 1 : 0) }));
    const p = multi(plan(edit(main)));
    const [a, b, c] = mainOf(p.final.doc);
    expect(mainOf(p.passes[1].doc)[0].transitionIn).toBeNull();
    expect(b.transitionIn).toEqual({ type: "dissolve", duration: 0.5 });
    expect(a.start + a.out - b.start).toBeCloseTo(0.5, 9);
    expect(p.passes[0].duration).toBe(7); // chunk A ends at its last clip
    expect(mainOf(p.passes[2].doc)[0].transitionIn).toEqual({ type: "fade", duration: 0.3 });
    expect(c.transitionIn).toBeNull();
    expect(graph(p.final.doc, p.final.sources)).toContain("xfade=transition=dissolve:duration=0.5:offset=6.5");
  });

  it("AC7: look, adjust, keyframes, speed and fades are copied; starts shift by the chunk start", () => {
    const main = run(17, 1, (i) => ({ in: 1, out: 3, speed: 2, fadeIn: 0.2, fadeOut: 0.3, keyframes: { x: [{ t: 0, value: -50 }, { t: 1, value: i }] } }));
    const doc = edit(main);
    const p = multi(plan(doc));
    const original = new Map(mainOf(doc).map((c) => [c.id, c]));
    for (const [i, x] of p.passes.entries()) {
      const start = mainOf(p.final.doc)[i].start;
      for (const c of mainOf(x.doc)) expect(c).toEqual({ ...original.get(c.id), start: Math.round((original.get(c.id)!.start - start) * 1000) / 1000 });
    }
  });

  it("AC8: overlay, text, caption and audio tracks appear only in the final doc", () => {
    const rest = [
      { id: "o", kind: "overlay", clips: [clip("o1", "png", 1, 2)] },
      { id: "t", kind: "text", clips: [{ id: "t1", start: 0, duration: 2, text: "Hi" }] },
      { id: "cap", kind: "caption", clips: [{ id: "k1", start: 0, words: [{ text: "hi", start: 0, end: 0.5 }] }] },
      { id: "m", kind: "audio", clips: [clip("m1", "music", 0, 17)] },
    ];
    const doc = edit(run(17, 1), rest);
    const p = multi(plan(doc));
    for (const x of p.passes) expect(x.doc.tracks.map((t) => t.kind)).toEqual(["video"]);
    expect(p.final.doc.tracks.slice(1)).toEqual(doc.tracks.slice(1));
  });

  it("AC9: chunk hasAudio follows hasClipAudio; chunk sources are absolute paths in the work dir", () => {
    const main = Array.from({ length: 20 }, (_, i) => clip(`c${i}`, i === 7 ? "s" : i >= 13 ? "png" : "g", i, 1));
    const p = multi(plan(edit(main)));
    expect(p.passes.map((x) => mainOf(x.doc).length)).toEqual([7, 6, 7]);
    expect(p.passes.map((x) => x.hasAudio)).toEqual([false, true, false]);
    for (const x of p.passes) {
      expect(x.hasAudio).toBe(hasClipAudio(x.doc, x.sources));
      expect(p.final.sources[inputKey(x.id, 1)]).toEqual({ path: `${WD}/${x.id}/out.mov`, kind: "video", hasAudio: x.hasAudio, width: 1080, height: 1920, fps: 30 });
    }
    expect(hasClipAudio(p.final.doc, p.final.sources)).toBe(true);
  });

  it("AC10: 200 x 0.9 s graded clips recurse until every pass fits; leaves first", () => {
    const doc = edit(run(200, 0.9, () => ({ assetId: "s" })));
    const p = multi(plan(doc));
    expect(p.levels).toBe(3);
    const ids = p.passes.map((x) => x.id);
    const count = (level: number) => p.passes.filter((x) => x.level === level).length;
    expect([count(0), count(1), count(2)]).toEqual([40, 8, 2]);
    expect(ids).toEqual([0, 1, 2].flatMap((l) => Array.from({ length: count(l) }, (_, i) => `chunk-${l}-${i}`)));
    for (const x of p.passes) {
      expect(x.weight).toBeLessThanOrEqual(7);
      expect(inputCount(x.doc, x.sources)).toBe(x.weight / 1.25 * 2); // picture + clip audio per clip
      for (const c of mainOf(x.doc)) if (x.level > 0) expect(c.assetId).toMatch(new RegExp(`^chunk-${x.level - 1}-`));
      expect(() => normalizeEdit(x.doc)).not.toThrow();
    }
    expect(p.final.weight).toBeLessThanOrEqual(8);
    expect(mainOf(p.final.doc).map((c) => c.assetId)).toEqual(["chunk-2-0", "chunk-2-1"]);
    expect(editDuration(p.final.doc)).toBe(180);
    expect(mainOf(p.final.doc).reduce((s, c) => s + clipDuration(c), 0)).toBeCloseTo(180, 9);
    expect(normalizeEdit(p.final.doc).tracks[0].clips).toHaveLength(2);
    expect(p.final.weight).toBe(2 * (1 + AUDIO_WEIGHT));
  });

  it("AC11: the input doc and sources are not mutated", () => {
    const doc = edit(run(17, 1, (i) => (i === 7 ? { transitionIn: { type: "fade", duration: 0.5 }, start: 6.5 } : {})), [{ id: "o", kind: "overlay", clips: [clip("o1", "png", 1, 2)] }]);
    const before = structuredClone(doc);
    const sources = structuredClone(inputs);
    const p = multi(planRender(doc, sources, { workdir: WD, ...SPEC }));
    expect(doc).toEqual(before);
    expect(sources).toEqual(inputs);
    expect(p.final.doc.tracks[1]).not.toBe(doc.tracks[1]);
  });
});

const audioClips = (doc: EditDoc) => doc.tracks.flatMap((t) => (t.kind === "audio" ? t.clips : []));
/** Overlay ids in the order `buildVideoGraph` lays them: track order, then start. */
const composite = (doc: EditDoc) => doc.tracks.flatMap((t) => (t.kind === "overlay" ? [...t.clips].sort((a, b) => a.start - b.start).map((c) => c.id) : []));
const byKind = (p: { passes: RenderPass[] }, kind: RenderPass["kind"]) => p.passes.filter((x) => x.kind === kind);
/** Every pass and the final pass read only the original sources or the output of an earlier pass. */
function expectTopological(p: ReturnType<typeof multi>) {
  const made = new Set<string>();
  const original = new Set(Object.values(inputs).map((s) => s.path));
  const check = (sources: CompileInputs) => {
    for (const s of Object.values(sources)) expect(original.has(s.path) || made.has(s.path), s.path).toBe(true);
  };
  for (const x of p.passes) {
    check(x.sources);
    made.add(x.output);
  }
  check(p.final.sources);
}
/** `n` graded overlays over 3 tracks that overlap across tracks; each track lists its clips latest first. */
const overlays = (n: number) => [0, 1, 2].map((k) => ({
  id: `o${k}`, kind: "overlay",
  clips: Array.from({ length: n }, (_, i) => i).filter((i) => i % 3 === k).reverse()
    .map((i) => clip(`ov${i}`, i % 4 === 0 ? "s" : "png", Math.floor(i / 3) * 1.5 + [0.5, 0, 0.5][k], 1.5, GRADE)),
}));
const words = { id: "cap", kind: "caption", clips: [{ id: "k1", start: 0, words: [{ text: "hi", start: 0, end: 0.5 }] }] };
const title = { id: "t", kind: "text", clips: [{ id: "t1", start: 0, duration: 2, text: "Hi" }] };

describe("audio stems", () => {
  const sixty = (vol = 0.8) => [
    { id: "a1", kind: "audio", clips: Array.from({ length: 30 }, (_, i) => clip(`x${i}`, "music", Math.round(i * 0.2 * 1000) / 1000, 0.2, { volume: vol, fadeIn: 0.1 })) },
    { id: "a2", kind: "audio", clips: Array.from({ length: 30 }, (_, i) => clip(`y${i}`, "music", Math.round((i * 0.2 + 0.1) * 1000) / 1000, 0.2)) },
  ];

  it("AC1+AC2: 60 audio-track clips (music too) group into stems in time order; one audio track of plain stem clips", () => {
    const doc = edit(run(2, 4), [...sixty(), { id: "m", kind: "audio", clips: [clip("m1", "music", 0, 8)] }]);
    const p = multi(plan(doc));
    const stems = byKind(p, "stem");
    // Each clip stays on its own track inside the stem (x on a1, y on a2, the music bed on m).
    expect(stems.map((x) => [x.id, x.doc.tracks.map((t) => t.id), audioClips(x.doc).length])).toEqual([["stem-0-0", ["a1", "a2", "m"], 32], ["stem-0-1", ["a1", "a2"], 29]]);
    const timeOrder = (d: EditDoc) => audioClips(d).map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map(({ c }) => c.id);
    const order = timeOrder(doc);
    expect(stems.flatMap((x) => timeOrder(x.doc))).toEqual(order);
    expect(order[0]).toBe("x0");
    expect(audioClips(stems[0].doc).map((c) => c.id)).toContain("m1"); // music is one more clip
    for (const x of stems) {
      expect(x.weight).toBeLessThanOrEqual(8);
      expect(x.output).toBe(`${WD}/${x.id}/out.wav`);
      expect(Math.min(...audioClips(x.doc).map((c) => c.start))).toBe(0);
      expect(() => normalizeEdit(x.doc)).not.toThrow();
    }
    const original = new Map(audioClips(doc).map((c) => [c.id, c]));
    for (const c of audioClips(stems[1].doc)) expect(c).toEqual({ ...original.get(c.id), start: Math.round((original.get(c.id)!.start - 3.1) * 1000) / 1000 });
    const finalAudio = p.final.doc.tracks.filter((t) => t.kind === "audio");
    expect(finalAudio).toHaveLength(1);
    expect(finalAudio[0].clips).toEqual([
      { id: "stem-0-0", assetId: "stem-0-0", version: 1, start: 0, in: 0, out: 8, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
      { id: "stem-0-1", assetId: "stem-0-1", version: 1, start: 3.1, in: 0, out: 3, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
    ]);
    expect(p.final.sources["stem-0-1@1"]).toEqual({ path: `${WD}/stem-0-1/out.wav`, kind: "audio", hasAudio: true });
    expect(editDuration(p.final.doc)).toBe(editDuration(doc));
    expect(p.final.weight).toBeLessThanOrEqual(8);
    expect(byKind(p, "chunk")).toEqual([]);
  });

  it("AC1: audio within AUDIO_SHARE is not stemmed", () => {
    const doc = edit(run(17, 1), [{ id: "a", kind: "audio", clips: Array.from({ length: 16 }, (_, i) => clip(`x${i}`, "music", i, 1)) }]);
    const p = multi(plan(doc));
    expect(byKind(p, "stem")).toEqual([]);
    expect(p.final.doc.tracks[1]).toEqual(doc.tracks[1]);
  });
});

describe("overlay layers", () => {
  it("AC3: 12 graded overlays + 2 main clips keep today's composite order; text and captions only in the final pass", () => {
    for (const budget of [8, 6, 4]) {
      const doc = edit(run(2, 4), [...overlays(12), title, words]);
      const p = multi(plan(doc, budget));
      const layers = byKind(p, "layer");
      expect(layers.length).toBeGreaterThanOrEqual(budget === 8 ? 1 : 2);
      expect(p.passes).toEqual(layers);
      expect([...layers.flatMap((x) => composite(x.doc)), ...composite(p.final.doc)]).toEqual(composite(doc));
      for (const x of layers) {
        expect(new Set(x.doc.tracks.map((t) => t.kind))).toEqual(new Set(["video", "overlay"]));
        expect(x.weight).toBeLessThanOrEqual(budget);
        expect(() => normalizeEdit(x.doc)).not.toThrow();
      }
      expect(p.final.doc.tracks.filter((t) => t.kind === "text" || t.kind === "caption")).toEqual([title, words].map((t) => normalizeEdit({ project: { size: "9:16" }, tracks: [t] }).tracks[0]));
      expect(p.final.weight).toBeLessThanOrEqual(budget);
      expect(editDuration(p.final.doc)).toBe(editDuration(doc));
      expectTopological(p);
    }
  });

  it("AC4: a layer pass holds the previous base as its only main clip, full length, its audio passing through", () => {
    const doc = edit([clip("a", "s", 0, 4), clip("b", "g", 4, 4)], overlays(12));
    const p = multi(plan(doc, 6));
    const [l0, l1] = byKind(p, "layer");
    // The first layer composites onto the main track as the main planner left it (2.25 > its share of 2: one chunk).
    expect(mainOf(l0.doc).map((c) => c.id)).toEqual(["chunk-0-0"]);
    expect(l0.hasAudio).toBe(true);
    expect(mainOf(l1.doc)).toEqual([{ id: "layer-0", assetId: "layer-0", version: 1, start: 0, in: 0, out: l0.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }, transitionIn: null }]);
    expect(l0.duration).toBe(8);
    expect(l1.sources["layer-0@1"]).toEqual({ path: `${WD}/layer-0/out.mov`, kind: "video", hasAudio: true, width: 1080, height: 1920, fps: 30 });
    const base = graph(l1.doc, l1.sources).split("\n").find((l) => /^\[\d+:a\]/.test(l)); // sound in start order: the base first
    expect(base).toBeDefined();
    expect(base).not.toMatch(/volume=|afade|adelay/);
    expect(mainOf(p.final.doc).map((c) => c.assetId)).toEqual([`layer-${byKind(p, "layer").length - 1}`]);
  });

  it("AC4: a main track too heavy to share a layer is rendered alone first", () => {
    const pngs = Array.from({ length: 6 }, (_, i) => clip(`p${i}`, "png", 2 + i, 1));
    const doc = edit(run(2, 4), [{ id: "o", kind: "overlay", clips: [clip("big", "uhds", 0, 2), ...pngs] }]);
    const p = multi(plan(doc, 6));
    expect(byKind(p, "chunk")).toHaveLength(0);
    const layers = byKind(p, "layer");
    expect(layers.map((x) => composite(x.doc))).toEqual([[], ["big"], ["p0", "p1"]]); // big (4.25) doesn't fit next to the 2 main clips
    expect(mainOf(layers[0].doc).map((c) => c.id)).toEqual(["c0", "c1"]);
    expect(layers.map((x) => x.weight)).toEqual([2, 5.25, 3.25]);
    expect(composite(p.final.doc)).toEqual(["p2", "p3", "p4", "p5"]);
    expect(p.final.weight).toBe(5.25);
    expectTopological(p);
  });
});

describe("recursion and order", () => {
  it("AC5+AC6: stems and layers recurse until every pass fits; passes are topologically ordered", () => {
    const voice = { id: "a", kind: "audio", clips: Array.from({ length: 60 }, (_, i) => clip(`x${i}`, "music", i * 0.25, 0.25)) };
    const doc = edit(run(20, 0.75, (i) => (i % 2 ? { assetId: "s" } : {})), [...overlays(30), title, words, voice]);
    const p = multi(plan(doc, 6, 1));
    const stems = byKind(p, "stem");
    expect([0, 1].map((l) => stems.filter((x) => x.level === l).length)).toEqual([10, 2]);
    expect(byKind(p, "layer").length).toBeGreaterThan(5);
    expect(byKind(p, "chunk").length).toBeGreaterThan(0);
    expect(p.levels).toBeGreaterThan(1);
    for (const x of p.passes) expect(x.weight, x.id).toBeLessThanOrEqual(6);
    expect(p.final.weight).toBeLessThanOrEqual(6);
    expect(p.final.doc.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips.map((c) => c.assetId))).toEqual(["stem-1-0", "stem-1-1"]);
    expect([...byKind(p, "layer").flatMap((x) => composite(x.doc)), ...composite(p.final.doc)]).toEqual(composite(doc));
    expect(editDuration(p.final.doc)).toBe(editDuration(doc));
    expectTopological(p);
    expect(p.passes.map((x) => x.kind)).toEqual([...byKind(p, "chunk"), ...stems, ...byKind(p, "layer")].map((x) => x.kind));
    expect(() => normalizeEdit(p.final.doc)).not.toThrow();
  });
});
