/**
 * Compiles the sound of an edit document (schema v1) into ffmpeg inputs and filter-graph lines. Pure: no I/O, no shell.
 * `compileVideo` appends the result to the picture graph, so one ffmpeg run renders both.
 *
 * Sound model: every clip that carries sound becomes one segment: the clip's own audio on a `video`/`overlay` track (only
 * when the probe said the source has an audio stream, `hasAudio: true`) and every clip on an `audio` track (music,
 * voiceover: all audio tracks are mixed the same way). Each segment is trimmed to the clip's in/out, sped up or slowed
 * down with `atempo` (chained in steps inside 0.5..2, so 0.25 = 0.5*0.5 and 4 = 2*2), set to the clip's volume, faded
 * in/out and delayed to its timeline start. The segments are summed with `amix normalize=0` (no level change per extra
 * track), optionally run through `loudnorm`, and padded/cut to the edit's length. Encoded as AAC 48 kHz stereo 160k.
 * An edit with no sound has no segments: the output then has no audio stream at all (`-an`).
 */
import { CompileError, filePath, inputKey, num, type CompileInputs } from "./compile-video.js";
import { clipDuration, editDuration, type AudioClip, type EditDoc, type MediaClip } from "./timeline.js";

export interface AudioOptions { loudnorm?: boolean }
/** The sound half of a render: extra input args, graph lines, and the final label (`null`: the edit is silent). */
export interface AudioGraph { inputArgs: string[]; filters: string[]; outLabel: string | null }

export const AUDIO_ENCODER_ARGS = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] as const;
/** EBU R128 single pass, aimed at social platforms (-14 LUFS); loudnorm resamples to 192 kHz, so resample back after. */
export const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000";
const SAMPLE_RATE = 48000;

/** `atempo` factors whose product is `speed`, each inside 0.5..2 (the range every ffmpeg build accepts). */
export function atempoChain(speed: number): number[] {
  const steps: number[] = [];
  let rest = speed;
  while (rest > 2 + 1e-9) {
    steps.push(2);
    rest /= 2;
  }
  while (rest < 0.5 - 1e-9) {
    steps.push(0.5);
    rest /= 0.5;
  }
  rest = Math.round(rest * 1000) / 1000;
  if (rest !== 1) steps.push(rest);
  return steps;
}

type SoundClip = (MediaClip | AudioClip) & { fromTrack: "picture" | "audio" };

/** The clips that carry sound, in timeline order (ties: track order). */
function soundClips(doc: EditDoc, sources: CompileInputs): SoundClip[] {
  const out: SoundClip[] = [];
  for (const track of doc.tracks) {
    if (track.kind === "audio") {
      for (const clip of track.clips) out.push({ ...clip, fromTrack: "audio" });
    } else if (track.kind === "video" || track.kind === "overlay") {
      for (const clip of track.clips) {
        const source = sources[inputKey(clip.assetId, clip.version)];
        if (source?.kind === "video" && source.hasAudio === true) out.push({ ...clip, fromTrack: "picture" });
      }
    }
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map(({ c }) => c);
}

/** Builds the sound graph. Input indexes start at `firstInput` (the picture graph's input count). */
export function buildAudioGraph(doc: EditDoc, sources: CompileInputs, firstInput: number, options: AudioOptions = {}): AudioGraph {
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  for (const clip of soundClips(doc, sources)) {
    const key = inputKey(clip.assetId, clip.version);
    const source = sources[key];
    if (!source) throw new CompileError("missing_input", key);
    if (source.kind === "image") throw new CompileError("unsupported_feature", "audio_from_image");
    if (source.kind === "video" && source.hasAudio === false) throw new CompileError("unsupported_feature", "audio_clip_without_audio");
    const index = firstInput + labels.length;
    const span = clip.out - clip.in;
    inputArgs.push("-ss", num(clip.in), "-t", num(span), "-i", filePath(source.path));

    const length = clipDuration(clip);
    const transition = "transitionIn" in clip && clip.transitionIn ? clip.transitionIn.duration : 0;
    const fadeIn = Math.max(clip.fadeIn, transition);
    const steps = [
      `aresample=${SAMPLE_RATE}`,
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `atrim=duration=${num(span)}`,
      "asetpts=PTS-STARTPTS",
      ...atempoChain(clip.speed).map((f) => `atempo=${num(f)}`),
      `atrim=duration=${num(length)}`,
    ];
    if (clip.volume !== 1) steps.push(`volume=${num(clip.volume)}`);
    if (fadeIn > 0) steps.push(`afade=t=in:st=0:d=${num(fadeIn)}`);
    if (clip.fadeOut > 0) steps.push(`afade=t=out:st=${num(length - clip.fadeOut)}:d=${num(clip.fadeOut)}`);
    const delay = Math.round(clip.start * 1000);
    if (delay > 0) steps.push(`adelay=delays=${delay}:all=1`);
    const label = `aud${labels.length}`;
    filters.push(`[${index}:a]${steps.join(",")}[${label}]`);
    labels.push(label);
  }
  if (labels.length === 0) return { inputArgs, filters, outLabel: null };

  const duration = num(editDuration(doc));
  const mix = labels.length > 1 ? [`amix=inputs=${labels.length}:duration=longest:normalize=0`] : [];
  const tail = [...mix, ...(options.loudnorm ? [LOUDNORM] : []), `apad=whole_dur=${duration}`, `atrim=duration=${duration}`];
  const outLabel = "aout";
  filters.push(`${labels.map((l) => `[${l}]`).join("")}${tail.join(",")}[${outLabel}]`);
  return { inputArgs, filters, outLabel };
}
