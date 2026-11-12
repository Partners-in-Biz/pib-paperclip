/**
 * Multi-pass equals single pass, with real ffmpeg (plan PAR-10436 rev 2, Q6 and Risks; T7 PAR-10465).
 *
 * Each case plans an edit with a small pass budget, runs every pass through `runContained` in plan order (stems with
 * `compileAudioStem`, chunks and layers with `compileVideo(..., { intermediate: true })`), renders the final doc, and
 * compares that against the single pass of the same doc: frame count exact, audio duration within 1 frame, mean PSNR
 * >= 42 dB and per-frame minimum >= 35 dB, and the RMS of the audio difference <= -50 dBFS. On CI a missing ffmpeg fails
 * the spec instead of skipping it. A pure part (no ffmpeg) checks the frame grid on 2000 seeded random layouts: every
 * frame of the chunked render shows the same clip frame (or black) as the single pass.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIO_ENCODER_ARGS, compileAudioStem, INTERMEDIATE_AUDIO_ENCODER_ARGS } from "../src/video-edit/compile-audio.js";
import { compileVideo, inputKey, mainSegments, type CompiledVideo, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { planRender, type RenderPass } from "../src/video-edit/render-plan.js";
import { FPS, normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

/** The audio weight these cases were written for (the tuned default in render-plan.ts may move; the plan shapes must not). */
const AUDIO_WEIGHT = 0.25;

const W = 320;
const H = 240;
const BAR = { meanPsnr: 42, minPsnr: 35, audioDiffDb: -50 };
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
/** Locally a missing ffmpeg skips the real-ffmpeg cases; on CI they run (and fail) so a green run always holds proof. */
const runReal = hasFfmpeg || Boolean(process.env.CI);

let dir = "";
let sources: CompileInputs = {};

async function ff(args: string[], cwd: string, tool: "ffmpeg" | "ffprobe" = "ffmpeg"): Promise<string> {
  const res = await runContained(tool === "ffmpeg" ? ["-loglevel", "error", "-y", ...args] : ["-v", "error", ...args], { cwd, tool, timeoutSec: 600, captureStdout: tool === "ffprobe" }).done;
  if (res.outcome !== "ok") throw new Error(`${tool} ${res.outcome}: ${res.stderrTail}`);
  return res.stdout;
}

/** Runs one compiled render in `cwd` (its graph and text files are written there first). */
async function render(compiled: CompiledVideo, cwd: string): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  for (const f of compiled.files) writeFileSync(join(cwd, f.name), f.content);
  await ff(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin" && a !== "-y"), cwd);
}

/**
 * The same render with float PCM sound in a `.mov` instead of AAC: the mix the delivery encoder receives. The audio bar
 * is checked here. ffmpeg's AAC encoder turns a 1-ULP float difference (the stems sum in a different order) into a large
 * one: case (d) is -142 dBFS before AAC but -39 dBFS after it on ffmpeg 8.1 (-58 on 6.1); with `-aac_pns 0` -52, with
 * `-aac_coder fast` -77. That difference comes from the shared final encoder, not from the planner (PAR-10465).
 */
function withPcmSound(compiled: CompiledVideo, output: string): CompiledVideo {
  const args = [...compiled.args];
  const at = args.findIndex((_, i) => AUDIO_ENCODER_ARGS.every((a, j) => args[i + j] === a));
  if (at < 0) throw new Error("no delivery audio encoder in the args");
  args.splice(at, AUDIO_ENCODER_ARGS.length, ...INTERMEDIATE_AUDIO_ENCODER_ARGS);
  args[args.length - 1] = `file:${output}`;
  return { ...compiled, args };
}

/** 320x240 fixtures: `testsrc2` pictures (one with a 440 Hz tone), a music bed, a loud tone, a still. */
async function fixtures(): Promise<void> {
  const src = (size: string, d: number, extra = "") => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${d}${extra}`];
  const x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p"];
  await ff([...src(`${W}x${H}`, 14), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=14", ...x264, "-c:a", "aac", "-b:a", "192k", "av.mp4"], dir);
  await ff([...src(`${W}x${H}`, 14), "-vf", "hue=h=120", ...x264, "alt.mp4"], dir);
  await ff([...src(`${W}x${H}`, 14), "-vf", "negate", ...x264, "neg.mp4"], dir);
  await ff([...src("128x96", 14), ...x264, "small.mp4"], dir);
  await ff([...src("96x72", 1), "-frames:v", "1", "logo.png"], dir);
  await ff(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=20", "-c:a", "aac", "-b:a", "192k", "music.m4a"], dir);
  await ff(["-f", "lavfi", "-i", "aevalsrc=0.45*sin(2*PI*330*t)|0.45*sin(2*PI*495*t):s=48000:d=6", "-c:a", "pcm_s16le", "loud.wav"], dir);
  const video = (path: string, hasAudio = false) => ({ path: join(dir, path), kind: "video" as const, hasAudio, width: W, height: H, fps: 30 });
  sources = {
    [inputKey("av", 1)]: video("av.mp4", true),
    [inputKey("alt", 1)]: video("alt.mp4"),
    [inputKey("neg", 1)]: video("neg.mp4"),
    [inputKey("small", 1)]: { ...video("small.mp4"), width: 128, height: 96 },
    [inputKey("logo", 1)]: { path: join(dir, "logo.png"), kind: "image", width: 96, height: 72 },
    [inputKey("music", 1)]: { path: join(dir, "music.m4a"), kind: "audio", hasAudio: true },
    [inputKey("loud", 1)]: { path: join(dir, "loud.wav"), kind: "audio", hasAudio: true },
  };
}

/** A clip `len` s long on the timeline from `start`, reading its source from `from`. */
let ids = 0;
const clip = (assetId: string, start: number, len: number, { from = 0, ...extra }: Record<string, unknown> & { from?: number; speed?: number } = {}) =>
  ({ id: `c${ids++}`, assetId, version: 1, start, in: from, out: Math.round((from + len * (extra.speed ?? 1)) * 1000) / 1000, ...extra });
/** A 320x240 edit (the compiler reads `width`/`height`; the size preset only matters to the UI). */
function edit(tracks: unknown[], fps = 30): EditDoc {
  const doc = normalizeEdit({ project: { size: "16:9", fps }, tracks }, { hasAudio: (id) => sources[inputKey(id, 1)]?.hasAudio });
  return { ...doc, project: { ...doc.project, width: W, height: H } };
}

/** Single pass and multi-pass renders of `doc` (delivery files, and the same final renders with PCM sound). */
async function renderBoth(name: string, doc: EditDoc, passBudget: number) {
  const root = join(dir, name);
  const single = join(root, "single", "out.mp4");
  const singleMix = join(root, "single", "mix.mov");
  const singleRender = compileVideo(doc, sources, single);
  await render(singleRender, dirname(single));
  await render(withPcmSound(singleRender, singleMix), dirname(single));
  const plan = planRender(doc, sources, { workdir: join(root, "multi"), passBudget, audioWeight: AUDIO_WEIGHT });
  if (plan.kind !== "multi") throw new Error(`${name}: expected a multi-pass plan, got ${plan.kind}`);
  for (const pass of plan.passes) {
    const compiled = pass.kind === "stem" ? compileAudioStem(pass.doc, pass.sources, pass.output) : compileVideo(pass.doc, pass.sources, pass.output, { intermediate: true, origin: pass.origin });
    await render(compiled, dirname(pass.output));
    // Each picture pass renders exactly the frames the plan gives it (the final doc trims and joins on that count).
    if (pass.kind !== "stem") expect((await probe(pass.output)).frames, `${name}: ${pass.id} frames`).toBe(pass.frames);
  }
  const multi = join(root, "multi", "final", "out.mp4");
  const multiMix = join(root, "multi", "final", "mix.mov");
  const finalRender = compileVideo(plan.final.doc, plan.final.sources, multi);
  await render(finalRender, dirname(multi));
  await render(withPcmSound(finalRender, multiMix), dirname(multi));
  return { single, multi, singleMix, multiMix, passes: plan.passes };
}

async function probe(path: string): Promise<{ frames: number; audio: number | null }> {
  const v = await ff(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path], dir, "ffprobe");
  const a = await ff(["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", path], dir, "ffprobe");
  return { frames: Number(v.trim()), audio: a.trim() ? Number(a.trim()) : null };
}

const psnrOf = (mse: number) => (mse <= 0 ? Infinity : 10 * Math.log10((255 * 255) / mse));

/** Mean PSNR (from the mean MSE, the stricter form) and the worst frame, from the `psnr` filter's stats file. */
async function psnr(a: string, b: string, cwd: string): Promise<{ mean: number; min: number; worstFrame: number }> {
  await ff(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr=stats_file=psnr.log", "-f", "null", "-"], cwd);
  const mse = readFileSync(join(cwd, "psnr.log"), "utf8").trim().split("\n").map((l) => Number(/mse_avg:(\S+)/.exec(l)?.[1]));
  if (!mse.length || mse.some(Number.isNaN)) throw new Error("psnr: no stats");
  const worst = mse.reduce((w, m, i) => (m > mse[w] ? i : w), 0);
  return { mean: psnrOf(mse.reduce((s, m) => s + m, 0) / mse.length), min: psnrOf(mse[worst]), worstFrame: worst + 1 };
}

/** RMS level (dBFS) of `a - b` over the whole audio (sample by sample, both as float stereo), from `astats`. */
async function audioDiff(a: string, b: string, cwd: string): Promise<number> {
  const f = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  const graph = `[0:a]${f}[x];[1:a]${f}[y];[x][y]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3,astats=metadata=1:reset=0,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=rms.log`;
  await ff(["-i", a, "-i", b, "-filter_complex", graph, "-f", "null", "-"], cwd);
  const values = [...readFileSync(join(cwd, "rms.log"), "utf8").matchAll(/RMS_level=(\S+)/g)].map((m) => m[1]);
  const last = values.at(-1);
  if (last === undefined) throw new Error("astats: no RMS level");
  return last === "-inf" ? -Infinity : Number(last);
}

async function expectEquivalent(name: string, doc: EditDoc, passBudget: number): Promise<RenderPass[]> {
  const { single, multi, singleMix, multiMix, passes } = await renderBoth(name, doc, passBudget);
  const cwd = join(dir, name);
  const [s, m] = [await probe(single), await probe(multi)];
  expect(s.frames).toBeGreaterThan(0);
  expect(m.frames, `${name}: frame count`).toBe(s.frames);
  expect(s.audio, `${name}: single pass has audio`).not.toBeNull();
  expect(m.audio, `${name}: multi-pass has audio`).not.toBeNull();
  expect(Math.abs((m.audio ?? 0) - (s.audio ?? 0)), `${name}: audio duration`).toBeLessThanOrEqual(1 / doc.project.fps + 1e-6);
  const p = await psnr(multi, single, cwd);
  const diff = await audioDiff(multiMix, singleMix, cwd);
  const delivered = await audioDiff(multi, single, cwd); // after AAC: logged only, see withPcmSound
  console.info(`${name}: ${passes.length} passes, ${m.frames} frames, audio ${s.audio}/${m.audio} s, PSNR mean ${p.mean.toFixed(2)} min ${p.min.toFixed(2)} (frame ${p.worstFrame}), audio diff ${diff.toFixed(1)} dBFS (after AAC ${delivered.toFixed(1)})`);
  expect(p.mean, `${name}: mean PSNR`).toBeGreaterThanOrEqual(BAR.meanPsnr);
  expect(p.min, `${name}: min PSNR at frame ${p.worstFrame}`).toBeGreaterThanOrEqual(BAR.minPsnr);
  expect(diff, `${name}: audio difference RMS (dBFS)`).toBeLessThanOrEqual(BAR.audioDiffDb);
  return passes;
}

const kinds = (passes: RenderPass[]) => passes.reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {});

/** Deterministic PRNG (mulberry32), so a failing layout is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ms = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What each output frame of the main track shows: `<clip id>:<clip frame>` or `black`. A clip that plays a chunk output
 * expands to that chunk's own frames (the chunk compiled at its `origin`), so a chunked plan expands to its final picture.
 */
function shownFrames(doc: EditDoc, origin: number, chunks: Map<string, RenderPass>): string[] {
  const out: string[] = [];
  for (const s of mainSegments(doc, origin)) {
    if (s.xfade) throw new Error("shownFrames: no xfade in these layouts");
    const chunk = s.clip ? chunks.get(s.clip.assetId) : undefined;
    const inner = chunk ? shownFrames(chunk.doc, chunk.origin, chunks) : null;
    if (chunk && inner && (inner.length !== chunk.frames || s.frames !== chunk.frames)) {
      throw new Error(`${chunk.id}: renders ${inner.length} frames, plan says ${chunk.frames}, the final doc plays ${s.frames}`);
    }
    for (let j = 0; j < s.frames; j++) out.push(!s.clip ? "black" : inner ? inner[j] : `${s.clip.id}:${j}`);
  }
  return out;
}

/**
 * A random main track of 4 to 14 clips (weight 1 each) with gaps, starts summed in ms as the editor does. `aligned`:
 * lengths and gaps are whole frames, rounded to ms; otherwise any ms value.
 */
function randomLayout(seed: number, aligned: boolean): EditDoc {
  const r = rng(seed);
  const fps = FPS[Math.floor(r() * FPS.length)];
  const len = () => (aligned ? ms(Math.ceil(r() * 24) / fps) : ms(0.02 + r() * 0.8));
  const clips: object[] = [];
  let at = 0;
  for (let i = 0, n = 4 + Math.floor(r() * 11); i < n; i++) {
    if (r() < 0.4) at = ms(at + len());
    const length = len();
    clips.push({ id: `c${i}`, assetId: "g", version: 1, start: at, in: 0, out: length });
    at = ms(at + length);
  }
  return normalizeEdit({ project: { size: "16:9", fps }, tracks: [{ id: "v", kind: "video", clips }] });
}

describe("chunked main track keeps the single pass frame grid (pure, 2000 seeded layouts)", () => {
  const gridSources: CompileInputs = { [inputKey("g", 1)]: { path: "/w/g.mp4", kind: "video", hasAudio: false, width: W, height: H, fps: 30 } };
  for (const aligned of [true, false]) {
    it(`${aligned ? "whole-frame lengths and gaps (ms-rounded)" : "any ms lengths and gaps"}: same frames, every clip on the same frame`, () => {
      const failures: string[] = [];
      let chunked = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        const doc = randomLayout(seed, aligned);
        const plan = planRender(doc, gridSources, { workdir: "/w/multi", passBudget: 3 });
        if (plan.kind !== "multi") continue;
        chunked++;
        const single = shownFrames(doc, 0, new Map());
        let multi: string[];
        try {
          multi = shownFrames(plan.final.doc, 0, new Map(plan.passes.map((p) => [p.id, p])));
        } catch (e) {
          failures.push(`seed ${seed}: ${(e as Error).message}`);
          continue;
        }
        const firstOf = (frames: string[]) => Object.fromEntries(frames.map((f, i) => [f.split(":")[0], i]).filter(([id, i]) => frames.findIndex((g) => g.split(":")[0] === id) === i));
        if (multi.length !== single.length) failures.push(`seed ${seed}: ${multi.length} frames, single pass ${single.length}`);
        else if (multi.some((f, i) => f !== single[i])) failures.push(`seed ${seed}: clip start frames ${JSON.stringify(firstOf(multi))}, single pass ${JSON.stringify(firstOf(single))}`);
      }
      expect(chunked).toBeGreaterThan(900);
      expect(failures.slice(0, 5), `${failures.length} of ${chunked} layouts differ`).toEqual([]);
    });
  }
});

describe.skipIf(!runReal)("multi-pass render equals the single pass (real ffmpeg, runContained)", () => {
  beforeAll(async () => {
    if (!hasFfmpeg) return; // the first case fails with the reason
    dir = mkdtempSync(join(tmpdir(), "studio-multipass-"));
    await fixtures();
  }, 120_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ffmpeg and ffprobe are installed (CI must run these cases, not skip them)", () => {
    expect(hasFfmpeg).toBe(true);
  });

  it("(a) budget 3: 7 clips, an xfade across a chunk boundary, a gap, a look, clip audio and music", async () => {
    const doc = edit([
      { id: "v", kind: "video", clips: [
        clip("av", 0, 1.5),
        clip("alt", 1, 1.5, { from: 1, transitionIn: { type: "fade", duration: 0.5 } }),
        clip("neg", 2.5, 1, { from: 3, look: { id: "warm", intensity: 0.8 } }),
        clip("alt", 3.5, 1, { from: 5 }),
        clip("neg", 4.5, 1, { from: 6 }),
        clip("alt", 6, 1, { from: 7 }),
        clip("neg", 7, 1, { from: 8 }),
      ] },
      { id: "m", kind: "audio", clips: [clip("music", 0.5, 7, { volume: 0.5 })] },
    ]);
    const passes = await expectEquivalent("a", doc, 3);
    expect(kinds(passes).chunk).toBeGreaterThanOrEqual(4);
    // The xfade clip opens chunk 1 without its transition; the final doc keeps it.
    expect(passes.some((p) => p.kind === "chunk" && p.level === 0 && p.id.endsWith("-1"))).toBe(true);
  }, 600_000);

  it("(b) a non-aligned edit: speed 1.5, 0.35 s cuts at 30 fps, about 30 chunks", async () => {
    const doc = edit([
      { id: "v", kind: "video", clips: Array.from({ length: 30 }, (_, i) => clip(i % 2 ? "alt" : "neg", Math.round(i * 350) / 1000, 0.35, { speed: 1.5, from: (i * 0.37) % 8 })) },
      { id: "m", kind: "audio", clips: [clip("music", 0, 10.5)] },
    ]);
    // Budget 2 can't chunk at all (a chunk of weight 1 is one clip, so no level reduces the main track); budget 3 is
    // the smallest that does: 30 clips -> 15 -> 8 -> 4 -> 2 chunk outputs, 29 chunk passes over 4 levels.
    const passes = await expectEquivalent("b", doc, 3);
    expect(kinds(passes)).toEqual({ chunk: 29 });
  }, 600_000);

  it("(c) 6 overlays on two tracks across two layer passes, two overlapping across tracks", async () => {
    const at = (x: number, y: number, scale = 0.4) => ({ transform: { x, y, scale, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } } });
    const doc = edit([
      { id: "v", kind: "video", clips: [clip("av", 0, 6)] },
      { id: "o1", kind: "overlay", clips: [clip("small", 0.5, 1.5, at(-80, -60, 1)), clip("logo", 2, 2, at(60, 40, 1)), clip("alt", 4.5, 1, { ...at(0, 0), look: { id: "mono", intensity: 1 } })] },
      { id: "o2", kind: "overlay", clips: [clip("neg", 1, 2, at(50, -50)), clip("small", 3, 1.5, at(-40, 50, 1)), clip("logo", 4.5, 1.5, at(100, 80, 1))] },
    ]);
    const passes = await expectEquivalent("c", doc, 4);
    expect(kinds(passes)).toEqual({ layer: 2 });
  }, 600_000);

  it("(d) 12 audio clips in stems, a loud sum over full scale", async () => {
    // Four tracks of three back-to-back 2 s clips, staggered by 0.5 s: four tones overlap at a time, and the 0.45-amplitude
    // ones sum to a peak near 1.5, above full scale: a stem must keep it (float PCM), as the single pass does.
    const doc = edit([
      { id: "v", kind: "video", clips: [clip("alt", 0, 7.5)] },
      ...[0, 1, 2, 3].map((k) => ({ id: `a${k}`, kind: "audio", clips: [0, 1, 2].map((j) => clip(k === 3 ? "music" : "loud", k * 0.5 + j * 2, 2, { from: (k * 0.7 + j * 0.3) % 3 })) })),
    ]);
    const passes = await expectEquivalent("d", doc, 2);
    expect(kinds(passes)).toEqual({ stem: 2 });
  }, 600_000);

  it("(e) chunk starts off the frame grid: ms-summed whole-frame cuts after a lead-in gap", async () => {
    // Before chunks were cut on the edit's grid (origin), the last clip here landed on frame 45 instead of 44.
    const doc = edit([
      { id: "v", kind: "video", clips: [clip("av", 0.367, 0.5, { from: 1 }), clip("alt", 0.867, 0.167, { from: 2 }), clip("neg", 1.034, 0.433, { from: 3 }), clip("av", 1.467, 0.6, { from: 4 })] },
      { id: "m", kind: "audio", clips: [clip("music", 0, 2.1, { volume: 0.5 })] },
    ]);
    const passes = await expectEquivalent("e", doc, 3);
    expect(kinds(passes).chunk).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
