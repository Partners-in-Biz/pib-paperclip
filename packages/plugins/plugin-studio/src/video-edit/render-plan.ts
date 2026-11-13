/**
 * Splits a heavy render into passes that each fit a memory budget (plan PAR-10436 rev 2, steps 0 and 1). Pure: no I/O.
 *
 * Weight: every ffmpeg `-i` of a render costs memory. A picture input (main or overlay, video or image) weighs its pixel
 * rate against 1080x1920 at 30 fps, at least 1 (a 4K30 source weighs 4); a sound input (an audio-track clip, or the
 * separate `-i` of a picture clip with sound, compile-audio.ts) weighs `audioWeight`. An edit whose total weight is
 * within `passBudget` renders in one pass, as today.
 *
 * Otherwise the main track is cut, in time order, into chunks of weight <= `passBudget - 1` (at least two when there
 * is a cut and that still lightens the main track, `halve`: the pipeline runs a level's chunks side by side). Each chunk is a pass:
 * a sub-doc that holds only its main clips, shifted to the chunk's start, rendered by the unchanged `compileVideo`. The
 * final doc swaps the main track for one plain clip per chunk output and keeps every other track. If that main track is
 * still heavier than its share of the budget, it is chunked again (recursion); passes are listed leaves first.
 *
 * Frame grid: the single pass cuts every main segment on the edit's frame grid (`frameAt` in compile-video.ts). A chunk
 * pass keeps its clips' exact times, shifted by its `origin` (the edit time of its 0), and is compiled with that
 * `origin`, so it cuts on the same grid and renders exactly the frames of that stretch of the single pass. A chunk
 * after the first starts on the frame where the previous chunk's picture stops: its origin is that frame's time, or its
 * first clip's start when that is earlier (the same frame). A gap before its first clip becomes lead-in black (an edit
 * doc can't hold trailing black). The final doc places each chunk output at its origin, so its clip audio lands on the
 * same sample, and the sub-frame gaps between chunk clips there span no frames. An xfade across a boundary stays in the
 * final doc: chunk B starts at its first clip, whose copy drops `transitionIn`; the final clip for chunk B carries it
 * and overlaps chunk A by the same amount.
 *
 * Audio stems (step 2): if the audio tracks (music included) weigh more than `passBudget / 2`, their clips are cut, in
 * time order, into stems of weight <= `passBudget`. A stem pass mixes its clips (shifted to the stem start) to one WAV
 * with no loudnorm; the final doc's audio tracks become one track of stem clips (volume 1, no fades). `amix normalize=0`
 * is a plain sum and loudnorm runs only in the final pass, so the mix is the same. Repeated until the stems fit.
 *
 * Overlay layers (step 3): if the final doc still doesn't fit, the overlays that do fit next to the base, the stems and
 * the other audio go to the final pass (the last ones in composite order: track order, then start, as `buildVideoGraph`
 * lays them). The ones before are burnt in layer passes, in that same order: a layer pass holds the base (the main
 * track, then the previous layer's output as one full-length clip whose audio passes through) plus its overlays at their
 * absolute times. Text and captions stay in the final pass, so the z-order is the same. Passes are listed chunks, then
 * stems, then layers; each reads only sources and earlier pass outputs.
 */
import { join } from "node:path";
import { clipHasSound, hasClipAudio } from "./compile-audio.js";
import { CompileError, frameAt, inputKey, type CompileInput, type CompileInputs } from "./compile-video.js";
import { clipDuration, editDuration, type AudioClip, type EditDoc, type MediaClip, type Track } from "./timeline.js";

/**
 * Measured by the T1 spike (PAR-10460, pib-vps, every look and adjust): a pass of weight 10 peaks near 4500 MiB VmPeak
 * under the 6 GiB `--as` cap (weight 12: 5107 MiB, over the 5 GiB bar), and an audio input costs about 0.05 of a graded
 * video input, so 0.1 keeps a 2x margin.
 */
export const PASS_BUDGET = 10;
export const AUDIO_WEIGHT = 0.1;
const BASE_RATE = 1080 * 1920 * 30;
const W_EPS = 1e-9;
const EPS = 0.0005; // compile-video.ts: smaller overlaps and gaps are ignored
const MAX_LEVELS = 8;

export interface PlanOptions { workdir: string; passBudget?: number; audioWeight?: number; ext?: string }
/**
 * One intermediate render: compile `doc` with `sources` to `output`; `frames` long, an audio stream iff `hasAudio`.
 * `stem` passes render sound only (a WAV, `compileAudioStem`); `chunk` and `layer` passes render with `compileVideo`
 * and `{ intermediate: true, origin }`: `origin` is the edit time of the doc's 0 (0 for stems and layers).
 */
export interface RenderPass { kind: "chunk" | "stem" | "layer"; id: string; level: number; doc: EditDoc; sources: CompileInputs; output: string; origin: number; duration: number; frames: number; hasAudio: boolean; weight: number }
export type RenderPlan =
  | { kind: "single"; weight: number }
  | { kind: "tooComplex"; weight: number; input: string; inputWeight: number }
  | { kind: "multi"; weight: number; levels: number; passes: RenderPass[]; final: { doc: EditDoc; sources: CompileInputs; weight: number } };

const ms = (n: number) => Math.round(n * 1000) / 1000;
const NO_TRANSFORM = { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
/** A plain clip that plays a whole pass output from `start`. */
const plain = (id: string, start: number, out: number) => ({ id, assetId: id, version: 1, start, in: 0, out, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 });

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

/**
 * Two chunks instead of one (PAR-11217): ffmpeg 6.1 runs a whole filter graph on one thread, so a chunk pass is bound
 * by that thread (about 0.9 s of it per second of graded 1080x1920), and two chunk passes run side by side
 * (render-pipeline.ts) take about 0.6 of the wall. Cut where the two halves' durations are closest, only at a cut
 * `chunkMain` allows (no overlap, or an overlap with a transition); `[clips]` when there is none.
 */
function halve(clips: MediaClip[], end: (c: MediaClip) => number): MediaClip[][] {
  const from = clips[0]?.start ?? 0;
  const to = Math.max(...clips.map(end));
  let best = -1;
  let gap = Infinity;
  for (let i = 1; i < clips.length; i++) {
    const before = Math.max(...clips.slice(0, i).map(end));
    if (before - clips[i].start > EPS && clips[i].transitionIn === null) continue;
    const d = Math.abs(clips[i].start - from - (to - clips[i].start));
    if (d < gap) [best, gap] = [i, d];
  }
  return best < 0 ? [clips] : [clips.slice(0, best), clips.slice(best)];
}

/** One level of main-track chunking: the chunk passes and the doc that joins their outputs. */
function chunkMain(doc: EditDoc, sources: CompileInputs, level: number, opts: Required<PlanOptions>, split = true): Level {
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
  const end = (c: MediaClip) => ms(c.start + clipDuration(c));
  if (split && groups.length === 1) groups.splice(0, 1, ...halve(clips, end));
  const passes: RenderPass[] = [];
  const finals: MediaClip[] = [];
  const outputs: CompileInputs = {};
  let clipEnd: number | null = null; // where the previous chunk's clips end
  for (const [c, group] of groups.entries()) {
    const first = group[0];
    const overlap = clipEnd === null ? 0 : ms(clipEnd - first.start);
    const xfade = overlap > EPS && first.transitionIn !== null;
    if (overlap > EPS && !xfade) throw new CompileError("unsupported_feature", "overlapping_clips");
    // The chunk's 0 in edit time: the frame where the previous chunk's picture stops (`frameAt(origin) == frameAt(clipEnd)`).
    const origin = xfade ? first.start : Math.min(first.start, ms(frameAt(clipEnd ?? 0, fps) / fps));

    const sub: EditDoc = {
      schemaVersion: doc.schemaVersion,
      project: { ...doc.project },
      tracks: [{ id: track.id, kind: "video", clips: group.map((clip, i) => ({ ...structuredClone(clip), start: ms(clip.start - origin), ...(i === 0 && xfade ? { transitionIn: null } : {}) })) }],
    };
    const subSources = sourcesFor(sub, sources);
    const duration = editDuration(sub);
    clipEnd = Math.max(...group.map(end)); // == ms(origin + duration)
    const frames = frameAt(clipEnd, fps) - frameAt(origin, fps);

    const id = `chunk-${level}-${c}`;
    const output = join(opts.workdir, id, `out.${opts.ext}`);
    const hasAudio = hasClipAudio(sub, subSources);
    passes.push({ kind: "chunk", id, level, doc: sub, sources: subSources, output, origin, duration, frames, hasAudio, weight: editWeight(sub, subSources, opts.audioWeight) });
    outputs[inputKey(id, 1)] = { path: output, kind: "video", hasAudio, width, height, fps };
    finals.push({
      ...plain(id, origin, duration),
      transform: structuredClone(NO_TRANSFORM), transitionIn: xfade && first.transitionIn ? { ...first.transitionIn } : null,
    });
  }

  const finalDoc: EditDoc = {
    schemaVersion: doc.schemaVersion,
    project: { ...doc.project },
    tracks: doc.tracks.map((t, i) => (i === index ? { id: t.id, kind: "video" as const, clips: finals } : structuredClone(t))),
  };
  return { passes, doc: finalDoc, sources: sourcesFor(finalDoc, { ...sources, ...outputs }) };
}

/** Step 2: while the audio tracks weigh more than `AUDIO_SHARE` (half the pass budget), mix their clips into stems (recursively). */
function stemAudio(doc: EditDoc, sources: CompileInputs, opts: Required<PlanOptions>): Level {
  const { fps } = doc.project;
  const per = Math.floor((opts.passBudget + W_EPS) / opts.audioWeight); // clips per stem
  const passes: RenderPass[] = [];
  let cur: Level = { passes, doc, sources };
  for (let level = 0; level < MAX_LEVELS && per >= 2; level++) {
    // Time order; ties keep track order, as `soundClips` does.
    const clips = cur.doc.tracks.flatMap((t) => (t.kind === "audio" ? t.clips.map((c) => ({ c, t })) : [])).map((x, i) => ({ ...x, i }))
      .sort((a, b) => a.c.start - b.c.start || a.i - b.i);
    if (clips.length * opts.audioWeight <= opts.passBudget / 2 + W_EPS) break;
    const first = cur.doc.tracks.findIndex((t) => t.kind === "audio");
    const trackId = cur.doc.tracks[first].id;
    const stems: AudioClip[] = [];
    const outputs: CompileInputs = {};
    for (let s = 0; s * per < clips.length; s++) {
      const group = clips.slice(s * per, (s + 1) * per);
      const start = group[0].c.start;
      // Each clip stays on its own track, so clips that overlap across tracks stay valid.
      const tracks = cur.doc.tracks.flatMap((t): Track[] => {
        const own = group.filter((x) => x.t === t).map((x) => ({ ...structuredClone(x.c), start: ms(x.c.start - start) }));
        return own.length ? [{ id: t.id, kind: "audio", clips: own }] : [];
      });
      const sub: EditDoc = { schemaVersion: doc.schemaVersion, project: { ...doc.project }, tracks };
      const subSources = sourcesFor(sub, cur.sources);
      const duration = editDuration(sub);
      const id = `stem-${level}-${s}`;
      const output = join(opts.workdir, id, "out.wav");
      passes.push({ kind: "stem", id, level, doc: sub, sources: subSources, output, origin: 0, duration, frames: frameAt(duration, fps), hasAudio: true, weight: editWeight(sub, subSources, opts.audioWeight) });
      outputs[inputKey(id, 1)] = { path: output, kind: "audio", hasAudio: true };
      stems.push(plain(id, start, duration));
    }
    // One track of stem clips. Stems can overlap in time (a long music bed); `buildAudioGraph` sums them all the same.
    const tracks = cur.doc.tracks.flatMap((t, i): Track[] => (i === first ? [{ id: trackId, kind: "audio", clips: stems }] : t.kind === "audio" ? [] : [structuredClone(t)]));
    const next: EditDoc = { schemaVersion: doc.schemaVersion, project: { ...doc.project }, tracks };
    cur = { passes, doc: next, sources: sourcesFor(next, { ...cur.sources, ...outputs }) };
  }
  return cur;
}

const BASE_TRACK = "layer-base";

/** Step 3: burn the overlays that don't fit the final pass onto the base, in today's composite order. */
function layerOverlays(doc: EditDoc, sources: CompileInputs, opts: Required<PlanOptions>): Level {
  const { fps, width, height } = doc.project;
  const budget = opts.passBudget + W_EPS;
  if (editWeight(doc, sources, opts.audioWeight) <= budget) return { passes: [], doc, sources };
  const known: CompileInputs = { ...sources };
  const weightOf = (t: Track) => sum(trackInputs(t, known, fps, opts.audioWeight));
  const index = mainIndex(doc);
  // compile-video.ts buildVideoGraph: overlay tracks in order, each track's clips by start (stable).
  const items = doc.tracks.flatMap((t, ti) => (t.kind === "overlay" ? [...t.clips].sort((a, b) => a.start - b.start).map((clip) => ({ ti, clip, weight: weightOf({ ...t, clips: [clip] }) })) : []));
  const fixed = sum(doc.tracks.flatMap((t, i) => (i === index || t.kind === "overlay" ? [] : [{ weight: weightOf(t) }])));
  const layerOut = inputWeight({ path: "", kind: "video", width, height, fps }, fps, opts.audioWeight) + opts.audioWeight;
  // The final pass takes the last overlays that fit next to a layer output and the other tracks.
  let k = items.length;
  for (let load = 0; k > 0 && fixed + layerOut + load + items[k - 1].weight <= budget; k--) load += items[k - 1].weight;
  const finalLoad = sum(items.slice(k));

  const passes: RenderPass[] = [];
  let base: Track | null = index >= 0 ? doc.tracks[index] : null;
  const emit = (group: typeof items) => {
    const id = `layer-${passes.length}`;
    const tracks: Track[] = base ? [structuredClone(base)] : [];
    for (const [ti, t] of doc.tracks.entries()) {
      const clips = group.filter((x) => x.ti === ti).map((x) => structuredClone(x.clip));
      if (clips.length) tracks.push({ id: t.id, kind: "overlay", clips });
    }
    const sub: EditDoc = { schemaVersion: doc.schemaVersion, project: { ...doc.project }, tracks };
    const subSources = sourcesFor(sub, known);
    const duration = editDuration(sub);
    const hasAudio = hasClipAudio(sub, subSources);
    const output = join(opts.workdir, id, `out.${opts.ext}`);
    passes.push({ kind: "layer", id, level: passes.length, doc: sub, sources: subSources, output, origin: 0, duration, frames: frameAt(duration, fps), hasAudio, weight: editWeight(sub, subSources, opts.audioWeight) });
    known[inputKey(id, 1)] = { path: output, kind: "video", hasAudio, width, height, fps };
    base = { id: base?.id ?? BASE_TRACK, kind: "video", clips: [{ ...plain(id, 0, duration), transform: structuredClone(NO_TRANSFORM), transitionIn: null }] };
  };
  for (let i = 0; i < k; ) {
    const fromMain = passes.length === 0 && base !== null;
    const group: typeof items = [];
    for (let load = base ? weightOf(base) : 0; i < k && load + items[i].weight <= budget; i++) {
      group.push(items[i]);
      load += items[i].weight;
    }
    // Nothing fits next to the main track: render it alone first. One overlay too heavy for any layer goes alone.
    if (!group.length && !fromMain) group.push(items[i++]);
    emit(group);
  }
  if (passes.length === 0 && base && weightOf(base) + finalLoad + fixed > budget) emit([]);

  const last = new Set(items.slice(k).map((x) => x.clip));
  const tracks = doc.tracks.map((t, i): Track => {
    if (i === index && base) return structuredClone(base);
    if (t.kind === "overlay") return { ...t, clips: t.clips.filter((c) => last.has(c)).map((c) => structuredClone(c)) };
    return structuredClone(t);
  });
  if (index < 0 && base) tracks.unshift(base);
  const next: EditDoc = { schemaVersion: doc.schemaVersion, project: { ...doc.project }, tracks };
  return { passes, doc: next, sources: sourcesFor(next, known) };
}

/**
 * Plans the render of `doc`. `single`: today's one pass. `tooComplex`: one input weighs more than `passBudget - 1`, so
 * no chunk can hold it (an edit that fits the budget as a whole still renders in one pass). `multi`: run `passes` in
 * order, then the final doc. Audio stems are planned first, so the main track's share counts the stems, not the clips.
 */
export function planRender(doc: EditDoc, sources: CompileInputs, options: PlanOptions): RenderPlan {
  const opts: Required<PlanOptions> = { workdir: options.workdir, passBudget: options.passBudget ?? PASS_BUDGET, audioWeight: options.audioWeight ?? AUDIO_WEIGHT, ext: options.ext ?? "mov" };
  const all = doc.tracks.flatMap((t) => trackInputs(t, sources, doc.project.fps, opts.audioWeight));
  const weight = sum(all);
  if (weight <= opts.passBudget + W_EPS) return { kind: "single", weight };
  const heaviest = all.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (heaviest.weight > opts.passBudget - 1 + W_EPS) return { kind: "tooComplex", weight, input: heaviest.key, inputWeight: heaviest.weight };

  const stems = stemAudio(doc, sources, opts);
  let current: Level = { passes: [], doc: stems.doc, sources: stems.sources };
  const passes: RenderPass[] = [];
  let levels = 0;
  while (levels < MAX_LEVELS) {
    const index = mainIndex(current.doc);
    if (index < 0) break;
    const inputs = current.doc.tracks.map((t) => sum(trackInputs(t, current.sources, doc.project.fps, opts.audioWeight)));
    const main = inputs[index];
    const others = sum(inputs.map((w) => ({ weight: w }))) - main;
    // The floor is two inputs: merging two chunk outputs into one costs a whole re-encode of the edit to save one input.
    // After a level the main track holds only chunk outputs, so the floor is two plain inputs plus the `audioWeight` of
    // those that carry sound: outputs with sound (1 + `audioWeight` each) stop the loop where silent ones (1 each) do,
    // and a silent plan is unchanged (PAR-11417: the halved main track of the worst-case edit with sound weighs 2.2 and
    // took a 180 s `chunk-1-0` pass to save 1.1). Counting the sound that is there, not a flat 2 x (1 + `audioWeight`),
    // keeps level 0 as it was: source clips with sound still chunk when they are over the floor of 2.
    const track = current.doc.tracks[index] as Extract<Track, { kind: "video" | "overlay" }>;
    const sound = levels > 0 ? track.clips.filter((c) => clipHasSound(track.kind, c, current.sources)).length * opts.audioWeight : 0;
    if (main <= Math.max(2 + sound, opts.passBudget - others) + W_EPS) break;
    const mainOf = (l: Level) => sum(trackInputs(l.doc.tracks[index], l.sources, doc.project.fps, opts.audioWeight));
    let next = chunkMain(current.doc, current.sources, levels, opts);
    // Two outputs can weigh what their clips did (one light clip each): then one chunk, as before the split.
    if (mainOf(next) >= main - W_EPS) next = chunkMain(current.doc, current.sources, levels, opts, false);
    const nextMain = mainOf(next);
    if (nextMain >= main - W_EPS) break; // no progress (a budget too small to merge chunk outputs): stop here
    passes.push(...next.passes);
    current = next;
    levels++;
  }
  const layers = layerOverlays(current.doc, current.sources, opts);
  const final = { doc: layers.doc, sources: layers.sources, weight: editWeight(layers.doc, layers.sources, opts.audioWeight) };
  return { kind: "multi", weight, levels, passes: [...passes, ...stems.passes, ...layers.passes], final };
}
