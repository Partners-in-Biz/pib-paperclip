/**
 * Splits a heavy render into passes that each fit a memory budget (plan PAR-10436 rev 2, steps 0 and 1). Pure: no I/O.
 *
 * Weight: every ffmpeg `-i` of a render costs memory. A picture input (main or overlay, video or image) weighs its pixel
 * rate against 1080x1920 at 30 fps, at least 1 (a 4K30 source weighs 4); a sound input (an audio-track clip, or the
 * separate `-i` of a picture clip with sound, compile-audio.ts) weighs `audioWeight`. An edit whose total weight is
 * within `passBudget` renders in one pass, as today.
 *
 * Otherwise the main track is cut, in time order, into chunks of weight <= `passBudget - 1`. Each chunk is a pass:
 * a sub-doc that holds only its main clips, shifted to the chunk's start, rendered by the unchanged `compileVideo`. The
 * final doc swaps the main track for one plain clip per chunk output and keeps every other track. If that main track is
 * still heavier than its share of the budget, it is chunked again (recursion); passes are listed leaves first.
 *
 * Frame grid: a chunk renders a whole number of frames (`-t` keeps frames that start before the end), so each chunk
 * after the first starts at the frame where the previous chunk's picture stops, and gaps become lead-in black of the
 * next chunk (an edit doc can't hold trailing black). A chunk whose first clip starts less than a frame from the
 * chunk start is shifted so that clip sits at 0. An xfade across a boundary stays in the final doc: chunk B's copy of
 * the clip drops `transitionIn`, the final clip for chunk B carries it and overlaps chunk A by the same amount.
 */
import { join } from "node:path";
import { clipHasSound, hasClipAudio } from "./compile-audio.js";
import { CompileError, inputKey, type CompileInput, type CompileInputs } from "./compile-video.js";
import { clipDuration, editDuration, type EditDoc, type MediaClip, type Track } from "./timeline.js";

/** Defaults until the T1 spike measures them (PAR-10436). */
export const PASS_BUDGET = 8;
export const AUDIO_WEIGHT = 0.25;
const BASE_RATE = 1080 * 1920 * 30;
const W_EPS = 1e-9;
const EPS = 0.0005; // compile-video.ts: smaller overlaps and gaps are ignored
const MAX_LEVELS = 8;

export interface PlanOptions { workdir: string; passBudget?: number; audioWeight?: number; ext?: string }
/** One intermediate render: compile `doc` with `sources` to `output`; `frames` long, an audio stream iff `hasAudio`. */
export interface RenderPass { id: string; level: number; doc: EditDoc; sources: CompileInputs; output: string; duration: number; frames: number; hasAudio: boolean; weight: number }
export type RenderPlan =
  | { kind: "single"; weight: number }
  | { kind: "tooComplex"; weight: number; input: string; inputWeight: number }
  | { kind: "multi"; weight: number; levels: number; passes: RenderPass[]; final: { doc: EditDoc; sources: CompileInputs; weight: number } };

const ms = (n: number) => Math.round(n * 1000) / 1000;
const NO_TRANSFORM = { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } };

/** The weight of one `-i` of `source`. Unknown size weighs 1; an image runs at the project rate. */
export function inputWeight(source: CompileInput, projectFps: number, audioWeight = AUDIO_WEIGHT): number {
  if (source.kind === "audio") return audioWeight;
  if (!source.width || !source.height) return 1;
  const fps = source.kind === "image" ? projectFps : source.fps || projectFps;
  return Math.max(1, (source.width * source.height * fps) / BASE_RATE);
}

function sourceOf(sources: CompileInputs, clip: { assetId: string; version: number }): CompileInput {
  const source = sources[inputKey(clip.assetId, clip.version)];
  if (!source) throw new CompileError("missing_input", inputKey(clip.assetId, clip.version));
  return source;
}

/** Every `-i` a track's clips add, with its weight, in track order. */
function trackInputs(track: Track, sources: CompileInputs, fps: number, audioWeight: number): { key: string; weight: number }[] {
  const out: { key: string; weight: number }[] = [];
  if (track.kind === "text" || track.kind === "caption") return out;
  for (const clip of track.clips) {
    const key = inputKey(clip.assetId, clip.version);
    const source = sourceOf(sources, clip);
    if (track.kind === "audio") out.push({ key, weight: audioWeight });
    else {
      out.push({ key, weight: inputWeight(source, fps, audioWeight) });
      if (clipHasSound(track.kind, clip, sources)) out.push({ key, weight: audioWeight });
    }
  }
  return out;
}

const sum = (inputs: { weight: number }[]) => inputs.reduce((s, i) => s + i.weight, 0);

/** The weight of one render of `doc`: every main, overlay, image, audio-track, music and clip-audio input. */
export function editWeight(doc: EditDoc, sources: CompileInputs, audioWeight = AUDIO_WEIGHT): number {
  return sum(doc.tracks.flatMap((t) => trackInputs(t, sources, doc.project.fps, audioWeight)));
}

/** The index of the main track (the first video track with clips), -1 for none. */
function mainIndex(doc: EditDoc): number {
  const found = doc.tracks.flatMap((t, i) => (t.kind === "video" && t.clips.length > 0 ? [i] : []));
  if (found.length > 1) throw new CompileError("unsupported_feature", "multiple_video_tracks");
  return found[0] ?? -1;
}

/** Only the sources `doc` reads. */
function sourcesFor(doc: EditDoc, all: CompileInputs): CompileInputs {
  const out: CompileInputs = {};
  for (const track of doc.tracks) {
    if (track.kind === "text" || track.kind === "caption") continue;
    for (const clip of track.clips) out[inputKey(clip.assetId, clip.version)] = sourceOf(all, clip);
  }
  return out;
}

interface Level { passes: RenderPass[]; doc: EditDoc; sources: CompileInputs }

/** One level of main-track chunking: the chunk passes and the doc that joins their outputs. */
function chunkMain(doc: EditDoc, sources: CompileInputs, level: number, opts: Required<PlanOptions>): Level {
  const { fps, width, height } = doc.project;
  const index = mainIndex(doc);
  const track = doc.tracks[index] as Extract<Track, { kind: "video" | "overlay" }>;
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const clipWeight = (c: MediaClip) => sum(trackInputs({ ...track, clips: [c] }, sources, fps, opts.audioWeight));

  const groups: MediaClip[][] = [];
  let load = Infinity;
  for (const clip of clips) {
    const w = clipWeight(clip);
    if (load + w > opts.passBudget - 1 + W_EPS) {
      groups.push([]);
      load = 0;
    }
    groups[groups.length - 1].push(clip);
    load += w;
  }

  const framesBelow = (t: number) => Math.max(0, Math.ceil(t * fps - 1e-6));
  const end = (c: MediaClip) => ms(c.start + clipDuration(c));
  const mainEnd = Math.max(...clips.map(end));
  const passes: RenderPass[] = [];
  const finals: MediaClip[] = [];
  const outputs: CompileInputs = {};
  let prev: { start: number; dur: number; endFrame: number; clipEnd: number } | null = null;
  for (const [c, group] of groups.entries()) {
    const first = group[0];
    const overlap = prev ? ms(prev.clipEnd - first.start) : 0;
    const xfade = overlap > EPS && first.transitionIn !== null;
    if (overlap > EPS && !xfade) throw new CompileError("unsupported_feature", "overlapping_clips");
    // Where the chunk sits in the joined main track, and the frame its picture starts on.
    const start: number = !prev ? 0 : xfade ? ms(prev.start + prev.dur - overlap) : ms(prev.endFrame / fps);
    const startFrame: number = !prev ? 0 : xfade ? framesBelow(start) : prev.endFrame;
    const shift = xfade || first.start - start < 1 / fps ? first.start : start;

    const sub: EditDoc = {
      schemaVersion: doc.schemaVersion,
      project: { ...doc.project },
      tracks: [{ id: track.id, kind: "video", clips: group.map((clip, i) => ({ ...structuredClone(clip), start: ms(clip.start - shift), ...(i === 0 && xfade ? { transitionIn: null } : {}) })) }],
    };
    const subSources = sourcesFor(sub, sources);
    const duration = editDuration(sub);
    const frames = framesBelow(duration);
    const endFrame: number = startFrame + frames;
    const last = c === groups.length - 1;
    const dur: number = last ? ms(Math.max(mainEnd - start, 1 / fps)) : ms(ms(endFrame / fps) - start);

    const id = `chunk-${level}-${c}`;
    const output = join(opts.workdir, id, `out.${opts.ext}`);
    const hasAudio = hasClipAudio(sub, subSources);
    passes.push({ id, level, doc: sub, sources: subSources, output, duration, frames, hasAudio, weight: editWeight(sub, subSources, opts.audioWeight) });
    outputs[inputKey(id, 1)] = { path: output, kind: "video", hasAudio, width, height, fps };
    finals.push({
      id, assetId: id, version: 1, start, in: 0, out: dur, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0,
      transform: structuredClone(NO_TRANSFORM), transitionIn: xfade && first.transitionIn ? { ...first.transitionIn } : null,
    });
    prev = { start, dur, endFrame, clipEnd: Math.max(...group.map(end)) };
  }

  const finalDoc: EditDoc = {
    schemaVersion: doc.schemaVersion,
    project: { ...doc.project },
    tracks: doc.tracks.map((t, i) => (i === index ? { id: t.id, kind: "video" as const, clips: finals } : structuredClone(t))),
  };
  return { passes, doc: finalDoc, sources: sourcesFor(finalDoc, { ...sources, ...outputs }) };
}

/**
 * Plans the render of `doc`. `single`: today's one pass. `tooComplex`: one input weighs more than `passBudget - 1`, so
 * no chunk can hold it (an edit that fits the budget as a whole still renders in one pass). `multi`: run `passes` in
 * order, then the final doc. Main-track only (T2): if the other tracks alone are over budget, the final pass is too.
 */
export function planRender(doc: EditDoc, sources: CompileInputs, options: PlanOptions): RenderPlan {
  const opts: Required<PlanOptions> = { workdir: options.workdir, passBudget: options.passBudget ?? PASS_BUDGET, audioWeight: options.audioWeight ?? AUDIO_WEIGHT, ext: options.ext ?? "mov" };
  const all = doc.tracks.flatMap((t) => trackInputs(t, sources, doc.project.fps, opts.audioWeight));
  const weight = sum(all);
  if (weight <= opts.passBudget + W_EPS) return { kind: "single", weight };
  const heaviest = all.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (heaviest.weight > opts.passBudget - 1 + W_EPS) return { kind: "tooComplex", weight, input: heaviest.key, inputWeight: heaviest.weight };

  let current: Level = { passes: [], doc, sources };
  const passes: RenderPass[] = [];
  let levels = 0;
  while (levels < MAX_LEVELS) {
    const index = mainIndex(current.doc);
    if (index < 0) break;
    const inputs = current.doc.tracks.map((t) => sum(trackInputs(t, current.sources, doc.project.fps, opts.audioWeight)));
    const main = inputs[index];
    const others = sum(inputs.map((w) => ({ weight: w }))) - main;
    if (main <= Math.max(2, opts.passBudget - others) + W_EPS) break;
    const next = chunkMain(current.doc, current.sources, levels, opts);
    const nextMain = sum(trackInputs(next.doc.tracks[index], next.sources, doc.project.fps, opts.audioWeight));
    if (nextMain >= main - W_EPS) break; // no progress (a budget too small to merge chunk outputs): stop here
    passes.push(...next.passes);
    current = next;
    levels++;
  }
  return { kind: "multi", weight, levels, passes, final: { doc: current.doc, sources: current.sources, weight: editWeight(current.doc, current.sources, opts.audioWeight) } };
}
