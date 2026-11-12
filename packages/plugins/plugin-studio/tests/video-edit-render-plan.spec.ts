import { describe, expect, it } from "vitest";
import { hasClipAudio } from "../src/video-edit/compile-audio.js";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { AUDIO_WEIGHT, editWeight, inputWeight, planRender, type RenderPlan } from "../src/video-edit/render-plan.js";
import { clipDuration, editDuration, normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";

const WD = "/srv/studio/render-1";
const fhd = (name: string, extra: object = {}) => ({ path: `${WD}/${name}`, kind: "video" as const, hasAudio: false, width: 1080, height: 1920, fps: 30, ...extra });
const inputs: CompileInputs = {
  [inputKey("g", 1)]: fhd("g.mp4"),
  [inputKey("s", 1)]: fhd("s.mp4", { hasAudio: true }),
  [inputKey("uhd", 1)]: fhd("uhd.mp4", { width: 3840, height: 2160 }),
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
const plan = (doc: EditDoc, passBudget?: number) => planRender(doc, inputs, { workdir: WD, passBudget });
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
    expect(editWeight(doc, inputs)).toBe(8);
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

  it("AC4: boundaries on the frame grid, chunks tile the main track, durations add up in frames", () => {
    const main = Array.from({ length: 17 }, (_, i) => clip(`c${i}`, "g", Math.round(i * 1.05 * 1000) / 1000, 1.01));
    const doc = edit(main);
    const p = multi(plan(doc));
    const finals = mainOf(p.final.doc);
    const end = Math.max(...main.map((c) => c.start + c.out));
    for (const [i, f] of finals.entries()) {
      expect(Math.abs(f.start * 30 - Math.round(f.start * 30))).toBeLessThan(0.02); // on the 30 fps grid (ms-rounded)
      if (i > 0) expect(f.start).toBeCloseTo(finals[i - 1].start + finals[i - 1].out, 9);
      if (i < finals.length - 1) expect(Math.round(f.out * 30)).toBe(p.passes[i].frames);
    }
    const total = finals.reduce((s, f) => s + f.out, 0);
    expect(total).toBeCloseTo(end, 9);
    expect(finals.reduce((s, f) => s + Math.round(f.out * 30), 0)).toBe(Math.round(end * 30));
    expect(editDuration(p.final.doc)).toBe(editDuration(doc));
    for (const x of p.passes) expect(x.frames).toBe(Math.ceil(x.duration * 30 - 1e-6));
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
    const p = multi(planRender(doc, sources, { workdir: WD }));
    expect(doc).toEqual(before);
    expect(sources).toEqual(inputs);
    expect(p.final.doc.tracks[1]).not.toBe(doc.tracks[1]);
  });
});
