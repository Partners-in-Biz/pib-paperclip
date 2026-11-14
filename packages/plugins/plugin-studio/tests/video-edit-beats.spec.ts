/** Beat detection (PAR-8279 D4e): accuracy on click tracks, the 180 s budget with real ffmpeg, the cache and run limits. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { audioExtractArgs } from "../src/video-edit/auto-caption.js";
import { BEAT_RUN, BEATS_ALGO, detectBeats, detectBeatsAction, extractBeatAudio, SAMPLE_RATE, timelineBeats, wavSamples } from "../src/video-edit/beats.js";
import { containedArgv, runContained } from "../src/video-edit/ffmpeg.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const doc = normalizeEdit({ tracks: [{ id: "music", kind: "audio", clips: [{ id: "m1", assetId: "a1", version: 2, in: 1, out: 31, start: 4 }] }] });
vi.mock("../src/video-edit/store.js", () => ({ getVideoEdit: async () => ({ id: "e1", revision: 3, client: null, doc }) }));
vi.mock("../src/video-edit/render-pipeline.js", () => ({
  resolveInputs: async () => [{ assetId: "a1", version: 2, key: "k", mime: "audio/wav", kind: "audio", bytes: 10 }],
}));
vi.mock("../src/config.js", () => ({ StudioConfig: class { bucket = async () => ({}) } }));
vi.mock("../src/video-edit/workdir.js", () => ({
  withRenderWorkdir: async (_id: string, _bytes: number, fn: (dir: string) => unknown) => fn(scratch),
  downloadObjectToWorkdir: async () => ({ path: join(scratch, "source.bin"), bytes: 10 }),
}));
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "beats-spec-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** 10 ms 1 kHz clicks from 0.25 s. */
function clicks(bpm: number, sec: number): { samples: Float32Array; truth: number[] } {
  const samples = new Float32Array(sec * SAMPLE_RATE);
  const truth: number[] = [];
  for (let t0 = 0.25; t0 < sec - 0.1; t0 += 60 / bpm) {
    truth.push(t0);
    const i0 = Math.round(t0 * SAMPLE_RATE);
    for (let i = 0; i < 0.01 * SAMPLE_RATE; i++) samples[i0 + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
  }
  return { samples, truth };
}

const within20ms = (beats: number[], truth: number[]) => truth.filter((b) => beats.some((x) => Math.abs(x - b) <= 0.02)).length / truth.length;

describe("detectBeats", () => {
  it.each([90, 120, 150])("click track at %i BPM: tempo within 1 BPM, at least 95 percent of beats within 20 ms", (bpm) => {
    const { samples, truth } = clicks(bpm, 60);
    const grid = detectBeats(samples);
    expect(Math.abs(grid.tempo - bpm)).toBeLessThan(1);
    expect(within20ms(grid.beats, truth)).toBeGreaterThanOrEqual(0.95);
    expect(grid.algo).toBe(BEATS_ALGO);
  });

  it("finds nothing in silence or under 4 s", () => {
    expect(detectBeats(new Float32Array(SAMPLE_RATE * 2)).beats).toEqual([]);
  });

  it("reads the data chunk of a WAV past other chunks", () => {
    const wav = new Uint8Array(12 + 8 + 4 + 8 + 4);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode("RIFF\0\0\0\0WAVELIST"), 0);
    view.setUint32(16, 4, true);
    wav.set(new TextEncoder().encode("data"), 24);
    view.setUint32(28, 99, true); // past the end: clamped
    view.setInt16(32, -16384, true);
    view.setInt16(34, 32767, true);
    expect(Array.from(wavSamples(wav))).toEqual([-0.5, 32767 / 32768]);
  });

  it("maps source beats into the clip on the timeline", () => {
    expect(timelineBeats([0.5, 1, 2, 31], { start: 4, in: 1, out: 31, speed: 2 })).toEqual([4, 4.5]);
  });
});

describe("extract and cache", () => {
  it("runs ffmpeg contained with the beat limits", async () => {
    const argv = containedArgv(audioExtractArgs("/w/source.bin", 0, 360, "/w/audio.wav"), BEAT_RUN);
    expect(argv.slice(0, 7)).toEqual(["/usr/bin/timeout", "-k", "5", "20", "/usr/bin/prlimit", `--as=${1024 ** 3}`, `--fsize=${16 * 1024 ** 2}`]);
    const calls: Array<{ args: string[]; opts: object }> = [];
    const samples = await extractBeatAudio({} as PluginContext, "co", { assetId: "a1", version: 2, key: "k", mime: "audio/wav", kind: "audio", bytes: 10 }, (args, opts) => {
      calls.push({ args, opts });
      writeFileSync(join(scratch, "audio.wav"), Buffer.from("RIFF\0\0\0\0WAVEdata\x02\0\0\0\0\x40", "latin1"));
      return { done: Promise.resolve({ outcome: "ok", exitCode: 0, signal: null, stderrTail: "", stdout: "", durationMs: 1 }) };
    });
    expect(calls).toEqual([{ args: audioExtractArgs(join(scratch, "source.bin"), 0, 360, join(scratch, "audio.wav")), opts: { ...BEAT_RUN, cwd: scratch } }]);
    expect(Array.from(samples)).toEqual([0.5]);
  });

  it("stores the grid per asset version; a hit skips ffmpeg; another algorithm's value is a miss", async () => {
    const state = new Map<string, unknown>([["beats:a1:v2", { algo: BEATS_ALGO - 1, tempo: 1, beats: [] }]]);
    const ctx = { state: { get: async (k: { stateKey: string; scopeId: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v) } } as unknown as PluginContext;
    const extract = vi.fn(async () => clicks(120, 30).samples);
    const first = await detectBeatsAction(ctx, "co", { editId: "e1", clipId: "m1" }, { extract });
    expect(first).toMatchObject({ assetId: "a1", version: 2, cached: false, tempo: expect.closeTo(120, 0) });
    expect(first.timelineBeats[0]).toBeCloseTo(4.25, 1);
    expect((state.get("beats:a1:v2") as { algo: number }).algo).toBe(BEATS_ALGO);
    const second = await detectBeatsAction(ctx, "co", { editId: "e1", clipId: "m1" }, { extract });
    expect(second).toMatchObject({ cached: true, beats: first.beats });
    expect(extract).toHaveBeenCalledTimes(1);
    await expect(detectBeatsAction(ctx, "co", { editId: "e1", clipId: "nope" }, { extract })).rejects.toThrow(/not in this video edit/);
  });
});

describe.skipIf(!hasFfmpeg)("real ffmpeg (pib-vps)", () => {
  it("a 180 s 120 BPM track: extract and detect in under 10 s", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "beats-ffmpeg-"));
    try {
      const src = join(dir, "clicks.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.8*sin(2*PI*1000*t)*lt(mod(t+0.25\\,0.5)\\,0.01):s=44100:c=stereo", "-t", "180", "-y", src]);
      const t0 = performance.now();
      const out = join(dir, "audio.wav");
      const res = await runContained(audioExtractArgs(src, 0, 360, out), { ...BEAT_RUN, cwd: dir }).done;
      expect(res.outcome).toBe("ok");
      const grid = detectBeats(wavSamples(new Uint8Array(readFileSync(out))));
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(Math.abs(grid.tempo - 120)).toBeLessThan(1);
      expect(within20ms(grid.beats, Array.from({ length: 359 }, (_, i) => 0.25 + i * 0.5))).toBeGreaterThanOrEqual(0.95);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
