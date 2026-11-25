/** Auto-cut silences (PAR-8279 D5a1): silencedetect parsing, the cut ops with ripple across tracks, the action, real ffmpeg. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { applyOps } from "../src/video-edit/ops.js";
import { cutSilencesAction, parseSilences, runSilencedetect, SILENCE_RUN, silenceArgs, silenceCuts, silenceOps, timeMap } from "../src/video-edit/silence.js";
import { clipDuration, editDuration, normalizeEdit, type CaptionClip, type Clip, type EditDoc, type MediaClip, type TextClip } from "../src/video-edit/timeline.js";

const FRAME = 1 / 30;
const v = (id: string, start: number, len: number, extra: object = {}) => ({ id, assetId: `a-${id}`, version: 1, in: 0, out: len, start, ...extra });
const doc = normalizeEdit({
  tracks: [
    { id: "main", kind: "video", clips: [v("talk", 0, 3, { keyframes: { opacity: [{ t: 0, value: 0 }, { t: 3, value: 1 }] } }), v("next", 3, 2)] },
    { id: "ov", kind: "overlay", clips: [{ id: "st", sticker: { pack: "noto-emoji", id: "fire" }, in: 0, out: 1, start: 1.5 }] },
    { id: "title", kind: "text", clips: [{ id: "t1", text: "Hi", start: 2.5, duration: 1 }] },
    { id: "cc", kind: "caption", clips: [{ id: "c1", start: 0.2, words: [{ text: "one", start: 0, end: 0.7 }, { text: "two", start: 2, end: 2.6 }] }] },
    { id: "music", kind: "audio", clips: [{ id: "m1", assetId: "song", version: 1, in: 0, out: 6, start: 0, fadeOut: 1 }] },
  ],
});
const byId = (d: EditDoc, id: string): Clip => d.tracks.flatMap((t) => t.clips as Clip[]).find((c) => c.id === id)!;

vi.mock("../src/video-edit/store.js", () => ({ getVideoEdit: async () => ({ id: "e1", revision: 3, client: null, doc }) }));
vi.mock("../src/video-edit/render-pipeline.js", () => ({ resolveInputs: async () => [{ assetId: "a-talk", version: 1, key: "k", mime: "video/mp4", kind: "video", bytes: 1 }] }));
const applied = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/video-edit/actions.js", () => ({ applyOpsAction: async (_c: unknown, _co: string, params: unknown) => (applied.push(params), { revision: 4 }) }));
const ctx = { logger: { info: () => undefined } } as unknown as PluginContext;

describe("parseSilences and silenceArgs", () => {
  it("pairs starts and ends, clamps to the range and runs an open silence to its end", () => {
    const report = "frame:32 pts:65536 pts_time:1.48\nlavfi.silence_start=0.999909\nlavfi.silence_end=2.00011\nlavfi.silence_duration=1.0002\nlavfi.silence_start=-0.002\nlavfi.silence_end=0.6\nlavfi.silence_start=4.5\n";
    expect(parseSilences(report, 5)).toEqual([[1, 2], [0, 0.6], [4.5, 5]]);
    expect(parseSilences("lavfi.silence_end=1\nlavfi.silence_start=nope\n", 5)).toEqual([]);
  });

  it("formats every number itself and writes the report in the workdir", () => {
    expect(silenceArgs("/w/source.bin", 1.23456, 10, -30, 0.5)).toEqual([
      "-y", "-ss", "1.235", "-t", "10", "-i", "file:/w/source.bin", "-map", "0:a:0", "-vn", "-af", "silencedetect=noise=-30dB:d=0.5,ametadata=mode=print:file=silence.txt", "-f", "null", "-",
    ]);
  });
});

describe("silenceCuts and silenceOps", () => {
  const talk = byId(doc, "talk") as MediaClip;

  it("pads cuts next to sound, not at the clip's edges, snaps to frames and drops sub-frame ones", () => {
    expect(silenceCuts(talk, [[1, 2]], 0.1, 30)).toEqual([{ from: 1.1, to: 1.9 }]);
    expect(silenceCuts(talk, [[0, 0.7], [2.5, 3]], 0.1, 30)).toEqual([{ from: 0, to: 0.6 }, { from: 2.6, to: 3 }]);
    expect(silenceCuts(talk, [[1, 1.21]], 0.1, 30)).toEqual([]);
    expect(silenceCuts({ ...talk, speed: 2, out: 6 }, [[1.9, 4.1]], 0.1, 30)).toEqual([{ from: 1, to: 2 }]);
  });

  it("tone / 1 s silence / tone: one cut of 0.8 s; later clips, captions and keyframes follow the ripple", () => {
    const cuts = silenceCuts(talk, [[1, 2]], 0.1, 30);
    const ops = silenceOps(doc, "talk", cuts);
    const out = applyOps(doc, ops);
    expect(Math.abs(editDuration(doc) - editDuration(out) - 0.8)).toBeLessThanOrEqual(FRAME);
    const main = out.tracks[0]!.clips as MediaClip[];
    expect(main.map((c) => [c.id, c.start, c.in, c.out])).toEqual([["talk", 0, 0, 1.1], ["talk-s1", 1.1, 1.9, 3], ["next", 2.2, 0, 2]]);
    // The keys stay on the same source frames: 1.9 of 3 s into the ramp where the right part starts.
    expect(main[1]!.keyframes!.opacity!.map((k) => [k.t, Math.round(k.value * 100) / 100])).toEqual([[0, 0.63], [1.1, 1]]);
    const words = (byId(out, "c1") as CaptionClip).words;
    expect(words.map((w) => [w.text, ms(0.2 + w.start), ms(0.2 + w.end)])).toEqual([["one", 0.2, 0.9], ["two", 1.4, 2]]);
    expect((byId(out, "t1") as TextClip).start).toBe(1.7);
    // Started inside the cut: its front under the cut goes. Music plays on and ends 0.8 s earlier.
    expect([byId(out, "st").start, clipDuration(byId(out, "st")), (byId(out, "st") as MediaClip).in]).toEqual([1.1, 0.6, 0.4]);
    expect([byId(out, "m1").start, clipDuration(byId(out, "m1"))]).toEqual([0, 5.2]);
  });

  it("cuts at the clip's edges with a plain ripple trim, last cut first", () => {
    const ops = silenceOps(doc, "talk", [{ from: 0, to: 0.6 }, { from: 2.6, to: 3 }]);
    expect(ops.slice(0, 2)).toEqual([{ op: "trim", clipId: "talk", out: 2.6, ripple: true }, { op: "trim", clipId: "talk", in: 0.6, ripple: true }]);
    const out = applyOps(doc, ops);
    expect(out.tracks[0]!.clips.map((c) => [c.id, c.start])).toEqual([["talk", 0], ["next", 2]]);
    // A caption word straddling a cut is shortened by the part under it (start of "one", end of "two").
    expect((byId(out, "c1") as CaptionClip).words.map((w) => [w.text, w.start, w.end])).toEqual([["one", 0, 0.3], ["two", 1.6, 2]]);
    expect(editDuration(out)).toBe(5);
  });

  it("maps time: points inside a cut land on its start", () => {
    const at = timeMap([{ from: 1, to: 2 }, { from: 3, to: 3.5 }]);
    expect([0.5, 1.5, 2, 3.2, 4].map(at)).toEqual([0.5, 1, 1, 2, 2.5]);
  });
});

describe("cutSilencesAction", () => {
  const detect = vi.fn(async () => [[1, 2]] as Array<[number, number]>);

  it("dry run returns the ops, the cuts and the seconds saved without saving", async () => {
    applied.length = 0;
    const r = await cutSilencesAction(ctx, "co", { editId: "e1", baseRevision: 3, clipId: "talk", dryRun: true }, { userId: "u1" }, { detect });
    expect(r.silences).toEqual({ clipId: "talk", cuts: 1, secondsSaved: 0.8, threshold: -30, minSilence: 0.5, padding: 0.1 });
    expect(applied).toEqual([]);
    expect(detect).toHaveBeenCalledWith(ctx, "co", expect.objectContaining({ assetId: "a-talk" }), expect.objectContaining({ id: "talk" }), { threshold: -30, minSilence: 0.5 });
  });

  it("saves through apply-ops at the base revision", async () => {
    applied.length = 0;
    const r = await cutSilencesAction(ctx, "co", { editId: "e1", baseRevision: 3, clipId: "talk", threshold: -40, padding: 0 }, { userId: "u1" }, { detect });
    expect(r.revision).toBe(4);
    expect(applied).toEqual([{ editId: "e1", baseRevision: 3, ops: r.ops }]);
    expect(r.silences.secondsSaved).toBe(1);
  });

  it("refuses a stale revision, out-of-range params, a caption clip and an all-silent clip", async () => {
    const call = (p: object, d = detect) => cutSilencesAction(ctx, "co", { editId: "e1", baseRevision: 3, clipId: "talk", ...p }, { userId: "u1" }, { detect: d });
    await expect(call({ baseRevision: 2 })).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(call({ threshold: -5 })).rejects.toThrow(/threshold must be a number from -60 to -10/);
    await expect(call({ minSilence: 0.1 })).rejects.toThrow(/minSilence/);
    await expect(call({ padding: "0.1" })).rejects.toThrow(/padding/);
    await expect(call({ clipId: "c1" })).rejects.toThrow(/caption track/);
    await expect(call({}, vi.fn(async () => [[0, 3]] as Array<[number, number]>))).rejects.toMatchObject({ code: "all_silent" });
  });
});

const ms = (x: number) => Math.round(x * 1000) / 1000;
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("real ffmpeg (pib-vps)", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "silence-spec-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const tone = (name: string, expr: string, sec: number) => {
    const out = join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=44100:c=stereo`, "-t", String(sec), "-y", out]);
    return out;
  };

  it("tone / 1 s silence / tone: one silence, one cut, the edit 0.8 s shorter", async () => {
    const src = tone("tsil.wav", "0.5*sin(2*PI*440*t)*(1-between(t\\,1\\,2))", 3);
    const silences = await runSilencedetect(dir, src, { in: 0, out: 3 }, { threshold: -30, minSilence: 0.5 });
    expect(silences).toHaveLength(1);
    expect(Math.abs(silences[0]![0] - 1)).toBeLessThan(0.01);
    expect(Math.abs(silences[0]![1] - 2)).toBeLessThan(0.01);
    const out = applyOps(doc, silenceOps(doc, "talk", silenceCuts(byId(doc, "talk") as MediaClip, silences, 0.1, 30)));
    expect(Math.abs(editDuration(doc) - editDuration(out) - 0.8)).toBeLessThanOrEqual(FRAME);
  });

  it("reads only the clip's range, from its in point", async () => {
    const src = tone("range.wav", "0.5*sin(2*PI*440*t)*(1-between(t\\,1\\,2))", 3);
    expect(await runSilencedetect(dir, src, { in: 1.5, out: 3 }, { threshold: -30, minSilence: 0.2 })).toEqual([[expect.closeTo(0, 2), expect.closeTo(0.5, 2)]]);
  });

  it("a 180 s input with a silence every 3 s takes under 10 s, inside the run limits", async () => {
    const src = tone("long.mp4", "0.5*sin(2*PI*440*t)*lt(mod(t\\,3)\\,2)", 180);
    const t0 = Date.now();
    const silences = await runSilencedetect(dir, src, { in: 0, out: 180 }, { threshold: -30, minSilence: 0.5 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(silences).toHaveLength(60);
    expect(SILENCE_RUN.timeoutSec).toBeLessThan(30);
  }, 60_000);
});
