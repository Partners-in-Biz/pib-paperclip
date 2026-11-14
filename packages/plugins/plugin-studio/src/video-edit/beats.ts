/**
 * Beat detection (PAR-8279 D4e). The clip's source sound is cut to 16 kHz mono PCM with the contained
 * ffmpeg runner (`audioExtractArgs`, as auto-captions do); onsets are spectral flux over a log spectrum, the tempo is
 * the autocorrelation peak of the onset curve (weighted towards 120 BPM so a half or double tempo loses), and beats
 * come from dynamic programming over the onsets at that tempo (Ellis 2007). Pure TypeScript, no model, no provider.
 *
 * The result is kept per asset version in plugin state (company scope, key `beats:<assetId>:v<version>`, one key per
 * asset, no shared list), so a second call skips ffmpeg. Two calls racing both compute and write the same value.
 * Beats are source seconds; `timelineBeats` maps them onto the timeline through the clip's in, start and speed.
 * Cut-to-beat (cut-to-beat.ts) builds on this.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeOfRow } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { audioExtractArgs } from "./auto-caption.js";
import { runContained, type RunOptions, type RunResult } from "./ffmpeg.js";
import { resolveInputs, type ResolvedInput } from "./render-pipeline.js";
import { getVideoEdit } from "./store.js";
import type { EditDoc, MediaClip } from "./timeline.js";
import { downloadObjectToWorkdir, withRenderWorkdir } from "./workdir.js";

/** Bump when the detector changes: an older cached value then reads as a miss. */
export const BEATS_ALGO = 1;
export const SAMPLE_RATE = 16_000;
/** The longest stretch of a source that is analysed, from its start. */
export const MAX_ANALYSE_SEC = 360;
const FRAME = 512;
const HOP = 160;
const FPS = SAMPLE_RATE / HOP;
/**
 * The flux peaks as a sound enters the window, so a frame's onset time is its centre plus this; measured on click and
 * kick tracks at 90-150 BPM.
 */
const ONSET_SEC = 0.0055;
export const BPM_RANGE = [60, 200] as const;

/**
 * Limits of the extract run, inside the 30 s host RPC timeout: ffmpeg only decodes sound here. The output is at most
 * 360 s of 16-bit 16 kHz mono (11.5 MB).
 */
export const BEAT_RUN: RunOptions = { timeoutSec: 20, killAfterSec: 5, asLimitBytes: 1024 ** 3, fsizeBytes: 16 * 1024 ** 2 };

export interface BeatGrid {
  algo: number;
  tempo: number;
  /** Source seconds, ascending, ms precision. */
  beats: number[];
}

const ms = (x: number) => Math.round(x * 1000) / 1000;

function bad(message: string, code = "bad_edit"): never {
  throw new StudioError(message, code);
}

/** The samples of a 16-bit PCM WAV as -1..1 (the `data` chunk; a header length past the end is clamped). */
export function wavSamples(wav: Uint8Array): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") {
      const n = Math.floor(Math.min(size, wav.length - at - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(at + 8 + i * 2, true) / 32768;
      return out;
    }
    at += 8 + size + (size & 1);
  }
  return new Float32Array(0);
}

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k), s = Math.sin(a * k);
        const p = i + k, q = p + len / 2;
        const tr = re[q]! * c - im[q]! * s, ti = re[q]! * s + im[q]! * c;
        re[q] = re[p]! - tr;
        im[q] = im[p]! - ti;
        re[p] = re[p]! + tr;
        im[p] = im[p]! + ti;
      }
    }
  }
}

/** Spectral flux of the log spectrum, one value per 10 ms frame, zero mean and unit spread. */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2 + 1;
  const win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[f * HOP + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 0; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      if (f > 0 && cur[k]! > prev[k]!) flux += cur[k]! - prev[k]!;
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  const mean = env.reduce((s, v) => s + v, 0) / (frames || 1);
  const sd = Math.sqrt(env.reduce((s, v) => s + (v - mean) ** 2, 0) / (frames || 1)) || 1;
  return env.map((v) => (v - mean) / sd);
}

/** The beat period in frames: the autocorrelation peak in `BPM_RANGE`, weighted by a log-normal prior at 120 BPM. */
export function beatPeriod(env: Float64Array): number {
  const [lo, hi] = [Math.floor((60 * FPS) / BPM_RANGE[1]), Math.ceil((60 * FPS) / BPM_RANGE[0])];
  const ac = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i]! * env[i - lag]!;
    ac[lag] = s / env.length;
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const score = ac[lag]! * Math.exp(-0.5 * Math.log2((60 * FPS) / lag / 120) ** 2);
    if (score > bestScore) [best, bestScore] = [lag, score];
  }
  const [a, b, c] = [ac[best - 1]!, ac[best]!, ac[best + 1]!];
  const d = a - 2 * b + c;
  return d < 0 ? best + (0.5 * (a - c)) / d : best;
}

/** Beat frames (fractional) by dynamic programming over the onsets at `period` frames per beat. */
export function trackBeats(env: Float64Array, period: number): number[] {
  const n = env.length;
  const sigma = period / 32;
  const reach = Math.ceil(3 * sigma);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    for (let k = -reach; k <= reach; k++) if (t + k >= 0 && t + k < n) local[t] += env[t + k]! * Math.exp(-0.5 * (k / sigma) ** 2);
  }
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0;
    for (let p = Math.max(0, t - Math.round(2 * period)); p <= t - Math.round(period / 2); p++) {
      const s = score[p]! - 100 * Math.log((t - p) / period) ** 2;
      if (back[t] < 0 || s > best) [best, back[t]] = [s, p];
    }
    score[t] = local[t]! + (back[t] >= 0 ? best : 0);
  }
  let last = Math.max(0, n - Math.ceil(period));
  for (let t = last; t < n; t++) if (score[t]! > score[last]!) last = t;
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]!) beats.unshift(t);
  // Beats in silence at either end carry no onset: drop those under half the RMS onset strength.
  const floor = 0.5 * Math.sqrt(beats.reduce((s, t) => s + Math.max(0, local[t]!) ** 2, 0) / (beats.length || 1));
  while (beats.length && local[beats[0]!]! < floor) beats.shift();
  while (beats.length && local[beats[beats.length - 1]!]! < floor) beats.pop();
  // Sub-frame position: the parabola through the onset peak.
  return beats.map((t) => {
    const [a, b, c] = [env[t - 1] ?? env[t]!, env[t]!, env[t + 1] ?? env[t]!];
    const d = a - 2 * b + c;
    return d < 0 ? t + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : t;
  });
}

/** Tempo and beats (seconds) of mono 16 kHz samples. The tempo is the least-squares slope of the beat times. */
export function detectBeats(samples: Float32Array): BeatGrid {
  const env = onsetEnvelope(samples);
  if (env.length < 4 * FPS) return { algo: BEATS_ALGO, tempo: 0, beats: [] };
  const frames = trackBeats(env, beatPeriod(env));
  const beats = frames.map((f) => ms(Math.max(0, (f * HOP + FRAME / 2) / SAMPLE_RATE + ONSET_SEC)));
  const n = beats.length;
  if (n < 2) return { algo: BEATS_ALGO, tempo: 0, beats };
  const mx = (n - 1) / 2, my = beats.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  beats.forEach((y, x) => ((sxy += (x - mx) * (y - my)), (sxx += (x - mx) ** 2)));
  return { algo: BEATS_ALGO, tempo: Math.round((60 / (sxy / sxx)) * 100) / 100, beats };
}

export const beatsStateKey = (companyId: string, assetId: string, version: number) =>
  ({ scopeKind: "company" as const, scopeId: companyId, namespace: "studio", stateKey: `beats:${assetId}:v${version}` });

function cachedGrid(value: unknown): BeatGrid | null {
  const v = value as Partial<BeatGrid> | null;
  return v && v.algo === BEATS_ALGO && typeof v.tempo === "number" && Array.isArray(v.beats) && v.beats.every(Number.isFinite) ? (v as BeatGrid) : null;
}

type Run = (args: string[], opts: RunOptions) => { done: Promise<RunResult> };

/** The source's first `MAX_ANALYSE_SEC` of sound as 16 kHz mono samples, through the contained runner (`BEAT_RUN`). */
export async function extractBeatAudio(ctx: PluginContext, companyId: string, input: ResolvedInput, run: Run = runContained): Promise<Float32Array> {
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  return withRenderWorkdir(`beats-${randomUUID().slice(0, 8)}`, input.bytes, async (dir) => {
    const src = await downloadObjectToWorkdir(bucket, companyId, input.key, dir, "source.bin");
    const out = join(dir, "audio.wav");
    const res = await run(audioExtractArgs(src.path, 0, MAX_ANALYSE_SEC, out), { ...BEAT_RUN, cwd: dir }).done;
    if (res.outcome !== "ok") bad(`Studio could not read this clip's sound (${res.outcome}). Check that the clip has sound.`, "no_audio");
    return wavSamples(new Uint8Array(await readFile(out)));
  });
}

export interface BeatDeps {
  extract?: (ctx: PluginContext, companyId: string, input: ResolvedInput) => Promise<Float32Array>;
}

export type Edit = Awaited<ReturnType<typeof getVideoEdit>>;

export function soundClip(doc: EditDoc, clipId: string): MediaClip {
  for (const t of doc.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (!c) continue;
    if (t.kind === "video" || t.kind === "overlay" || t.kind === "audio") return c as MediaClip;
    bad(`Clip ${clipId} is on a ${t.kind} track; pick a video or sound clip.`);
  }
  bad(`Clip ${clipId} is not in this video edit.`, "not_found");
}

/** The beats of the clip's asset version: from plugin state, else extracted, detected and stored. */
export async function gridFor(ctx: PluginContext, companyId: string, edit: Edit, clip: MediaClip, deps: BeatDeps): Promise<{ grid: BeatGrid; cached: boolean }> {
  const scope = scopeOfRow({ client_kind: edit.client ? String(edit.client.kind) : null, client_ref: edit.client?.id ?? null });
  let input: ResolvedInput;
  try {
    // Checks the asset belongs to this edit's company and client before anything is read or cached.
    [input] = await resolveInputs(ctx, companyId, scope, { ...edit.doc, tracks: [{ id: "src", kind: "video", clips: [clip] }] });
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e), "unknown_asset");
  }
  if (input.kind === "image") bad("A picture has no sound; pick a video or sound clip.");
  const key = beatsStateKey(companyId, input.assetId, input.version);
  const hit = cachedGrid(await ctx.state.get(key));
  if (hit) return { grid: hit, cached: true };
  const grid = detectBeats(await (deps.extract ?? extractBeatAudio)(ctx, companyId, input));
  await ctx.state.set(key, grid);
  return { grid, cached: false };
}

/** Source beats as timeline seconds inside the clip (`in`..`out` at its speed). */
export function timelineBeats(beats: readonly number[], clip: Pick<MediaClip, "start" | "in" | "out" | "speed">): number[] {
  return beats.filter((b) => b >= clip.in && b < clip.out).map((b) => ms(clip.start + (b - clip.in) / clip.speed));
}

export const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** `video-edit-detect-beats`: tempo and beats of a clip's sound, as source seconds and on the timeline. */
export async function detectBeatsAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, deps: BeatDeps = {}) {
  const clipId = text(params.clipId);
  if (!clipId) bad("clipId is required: the video or sound clip to find beats in.");
  const edit = await getVideoEdit(ctx, companyId, text(params.editId));
  const clip = soundClip(edit.doc, clipId);
  const { grid, cached } = await gridFor(ctx, companyId, edit, clip, deps);
  return { editId: edit.id, revision: edit.revision, clipId, assetId: clip.assetId, version: clip.version, tempo: grid.tempo, beats: grid.beats, timelineBeats: timelineBeats(grid.beats, clip), cached };
}
