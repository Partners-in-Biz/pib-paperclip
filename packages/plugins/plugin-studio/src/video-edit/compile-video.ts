/**
 * Compiles the picture of an edit document (schema v1) into ffmpeg arguments. Pure: no I/O, no shell. The result is an
 * args array for `spawn("ffmpeg", args)` run with the render work dir as cwd, plus the files to write into that dir first
 * (the filter graph goes in a script file, so a 200-clip edit never hits the argument length limit).
 *
 * Picture model: the first `video` track is the main track. Its clips are joined in time order with `concat`; a clip with
 * `transitionIn` that overlaps the clip before it is joined with `xfade=fade` over the overlap (no overlap: it fades in from
 * black); gaps, the lead-in before the first clip and the tail up to the edit's end are black `color` segments. Every
 * `overlay` track is then laid over that base in track order, each clip at its centre offset x/y and fit scale.
 * Keyframes (schema v2, D1d1): x/y/scale/rotate keys on a main or overlay clip are evaluated per frame from the shared
 * `keyframes.ts` curve, in clip-local time (from the clip's `start`, transition overlap included), before xfade/overlay.
 * Opacity keys (D1d2) scale the clip's alpha per frame (`sendcmd` driving `colorchannelmixer aa`), times its fade alpha.
 * Text and caption tracks are drawn last, over everything, by `compile-text.ts` (A5a). Sound is compiled by
 * `compile-audio.ts` (A5b) into the same graph; a silent edit gets no audio stream (`-an`). Anything else outside this
 * model throws `CompileError` with `unsupported_feature:<name>`.
 */
import { StudioError } from "../errors.js";
import { AUDIO_ENCODER_ARGS, buildAudioGraph } from "./compile-audio.js";
import { buildTextLayers } from "./compile-text.js";
import { fontsDir } from "./fonts.js";
import { toFfmpegExpr } from "./keyframes.js";
import { clipDuration, editDuration, type EditDoc, type MediaClip, type Transform, type TransitionType } from "./timeline.js";

/** A downloaded source: `path` is local (absolute or relative to the work dir); `kind` comes from the asset row/probe. */
export interface CompileInput { path: string; kind: "video" | "image" | "audio"; hasAudio?: boolean }
/** Inputs keyed by `inputKey(assetId, version)`. */
export type CompileInputs = Record<string, CompileInput>;
export interface CompileFile { name: string; content: string }
export interface CompiledVideo { args: string[]; files: CompileFile[] }
/** The video half of a render, for the audio compiler to extend: input args, graph lines, the final label, work-dir files. */
export interface VideoGraph { inputArgs: string[]; filters: string[]; outLabel: string; inputCount: number; duration: number; files: CompileFile[] }
/** `fontsDir`: where the bundled TTFs are (default: beside the worker); only read when the edit has text or captions. */
export interface CompileOptions { fontsDir?: string; loudnorm?: boolean }

export const GRAPH_FILE = "video.graph";
/** H.264 High, CRF 20 capped at 6 Mbit/s: a 180 s 1080x1920 render stays near 140 MB (plan PAR-8276, Critic 2d). */
export const ENCODER_ARGS = ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p"] as const;

export type CompileErrorCode = "unsupported_feature" | "missing_input" | "bad_input_path";
/** The edit can't be compiled. Deterministic: the render fails at once, no retry. Message is `<code>:<detail>`. */
export class CompileError extends StudioError {
  constructor(readonly reason: CompileErrorCode, readonly detail: string) {
    super(`${reason}:${detail}`, reason);
    this.name = "CompileError";
  }
}

export const inputKey = (assetId: string, version: number) => `${assetId}@${version}`;
const unsupported = (name: string): never => {
  throw new CompileError("unsupported_feature", name);
};
const ms = (n: number) => Math.round(n * 1000) / 1000;
/** A number for the graph: millisecond precision, never exponent notation (all values are range-checked by normalizeEdit). */
export const num = (n: number) => {
  const v = ms(n);
  return Object.is(v, -0) ? "0" : String(v);
};
const EPS = 0.0005;

/** `file:` stops ffmpeg reading a path as a protocol (`http:`, `concat:`) or an option (`-x`). */
export function filePath(path: string): string {
  if (!path || /[\0\n\r]/.test(path)) throw new CompileError("bad_input_path", "empty or has control characters");
  return `file:${path}`;
}

const isIdentity = (t: Transform) => t.x === 0 && t.y === 0 && t.scale === 1 && t.rotate === 0;
const hasCrop = (t: Transform) => t.crop.left + t.crop.top + t.crop.right + t.crop.bottom > 0;
const keysOf = (clip: MediaClip, prop: "x" | "y" | "scale" | "rotate") => clip.keyframes?.[prop];
/** Scale or rotate keys: the clip's size changes per frame. */
const reshapes = (clip: MediaClip) => Boolean(keysOf(clip, "scale") || keysOf(clip, "rotate"));
/** Any motion keys: the overlay position is evaluated per frame. */
const animated = (clip: MediaClip) => reshapes(clip) || Boolean(keysOf(clip, "x") || keysOf(clip, "y"));
const fadesOpacity = (clip: MediaClip) => Boolean(clip.keyframes?.opacity);

class Graph {
  inputArgs: string[] = [];
  filters: string[] = [];
  private inputs = 0;
  private labels = 0;
  private opacities = 0;
  constructor(readonly doc: EditDoc, readonly sources: CompileInputs) {}

  label(prefix: string) {
    return `${prefix}${this.labels++}`;
  }

  /** Adds the clip's source as an input, trimmed on the input side (`-ss`/`-t`); images loop for the clip's length. */
  input(clip: MediaClip): { index: number; kind: CompileInput["kind"] } {
    const source = this.sources[inputKey(clip.assetId, clip.version)];
    if (!source) throw new CompileError("missing_input", inputKey(clip.assetId, clip.version));
    if (source.kind === "image") this.inputArgs.push("-loop", "1", "-framerate", String(this.doc.project.fps), "-t", num(clipDuration(clip)), "-i", filePath(source.path));
    else if (source.kind === "video") this.inputArgs.push("-ss", num(clip.in), "-t", num(clip.out - clip.in), "-i", filePath(source.path));
    else unsupported(`input_kind_${String(source.kind)}`);
    return { index: this.inputs++, kind: source.kind };
  }

  /** Black for `duration` seconds at project size and rate. */
  black(duration: number): string {
    const { width, height, fps } = this.doc.project;
    const out = this.label("blk");
    this.filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${num(duration)},format=yuv420p,setsar=1[${out}]`);
    return out;
  }

  /** Timing chain shared by both tracks: zero-based pts, speed, optional timeline shift, constant project rate. */
  private timing(clip: MediaClip, kind: CompileInput["kind"], shift: number): string[] {
    const speed = kind === "video" && clip.speed !== 1 ? `/${num(clip.speed)}` : "";
    const pts = speed ? `(PTS-STARTPTS)${speed}` : "PTS-STARTPTS";
    return [`setpts=${shift ? `${pts}+${num(shift)}/TB` : pts}`, `fps=${this.doc.project.fps}`];
  }

  private crop(t: Transform): string[] {
    if (!hasCrop(t)) return [];
    const { left, top, right, bottom } = t.crop;
    return [`crop=w=iw*${num(1 - left - right)}:h=ih*${num(1 - top - bottom)}:x=iw*${num(left)}:y=ih*${num(top)}`];
  }

  /** User crop (fractions), rotation (canvas grows to fit, transparent corners) and fit-inside scale times `scale`. */
  private shape(t: Transform, fill = "none"): string[] {
    const { width, height } = this.doc.project;
    const out: string[] = ["format=yuva420p", ...this.crop(t)];
    // rotw()/roth() take the angle itself: `a` is not a variable inside ow/oh.
    const angle = `${num(t.rotate)}*PI/180`;
    if (t.rotate !== 0) out.push(`rotate=a=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=${fill}`);
    out.push(`scale=w=${num(width * t.scale)}:h=${num(height * t.scale)}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
    return out;
  }

  /**
   * Shape of a clip with scale/rotate keys; `offset` is the clip's local 0 on the filter clock (`t`). Only the last step
   * changes size per frame. Rotate keys: fit the unrotated clip, turn it on a fixed diagonal canvas about its centre (so
   * corners may leave the frame), then scale. Scale keys only: today's static shape at scale 1 (a static rotation keeps
   * its rotated-box fit), then scale. Fill is `black@0`: `c=none` leaves the canvas corners undefined.
   */
  private keyedShape(clip: MediaClip, offset: number): string[] {
    const { width, height } = this.doc.project;
    const t = clip.transform;
    const s = toFfmpegExpr(keysOf(clip, "scale"), t.scale, offset);
    const scale = `scale=w='max(2,iw*(${s}))':h='max(2,ih*(${s}))':eval=frame`;
    if (!keysOf(clip, "rotate")) return [...this.shape({ ...t, scale: 1 }, "black@0"), scale];
    const r = toFfmpegExpr(keysOf(clip, "rotate"), t.rotate, offset);
    return [
      "format=yuva420p",
      ...this.crop(t),
      `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `rotate=a='(${r})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0`,
      scale,
    ];
  }

  /**
   * Opacity keys (D1d2): `colorchannelmixer aa` scales the alpha already on the frame, so final alpha = keyframe opacity x
   * the alpha the fades left there. One `sendcmd` [expr] command sets `aa` on every frame of the clip's interval
   * `[offset, offset+length)`. Inside sendcmd `T` is undefined and `PTS` is in time-base units, so clip-local time is
   * `TI*length` (TI runs 0..1 over the interval). Clamped to 0..1 (`aa` takes -2..2). Each mixer gets its own `@op<n>`
   * name so the command reaches only it. Base opacity is 1 (no static opacity field).
   */
  private opacity(clip: MediaClip, offset: number): string[] {
    const kfs = clip.keyframes?.opacity;
    if (!kfs) return [];
    const length = clipDuration(clip);
    const expr = toFfmpegExpr(kfs, 1, 0, "LT").replace(/\bLT\b/g, `(TI*${num(length)})`);
    const target = `colorchannelmixer@op${this.opacities++}`;
    const cmd = `${num(offset)}-${num(offset + length)} [expr] ${target} aa 'clip(${expr},0,1)'`;
    // Three parsers unquote in turn: filtergraph (`[],;`), filter options (`:`), then sendcmd's own argument token.
    const opt = cmd.replace(/[\\':]/g, "\\$&");
    return ["format=rgba", `sendcmd=c=${opt.replace(/[\\'[\],;]/g, "\\$&")}`, target];
  }

  private overlayAt(clip: MediaClip, offset: number) {
    const t = clip.transform;
    if (!animated(clip)) return `x=(W-w)/2+${num(t.x)}:y=(H-h)/2+${num(t.y)}`;
    const x = toFfmpegExpr(keysOf(clip, "x"), t.x, offset);
    const y = toFfmpegExpr(keysOf(clip, "y"), t.y, offset);
    return `x='(W-w)/2+${x}':y='(H-h)/2+${y}':eval=frame`;
  }

  /** One main-track clip as a full-frame yuv420p segment of exactly its timeline length. */
  mainClip(clip: MediaClip, fadeInFromBlack: number): string {
    const { width, height } = this.doc.project;
    const { index, kind } = this.input(clip);
    const length = clipDuration(clip);
    const fades: string[] = [];
    const fadeIn = Math.max(clip.fadeIn, fadeInFromBlack);
    if (fadeIn > 0) fades.push(`fade=t=in:st=0:d=${num(fadeIn)}`);
    if (clip.fadeOut > 0) fades.push(`fade=t=out:st=${num(length - clip.fadeOut)}:d=${num(clip.fadeOut)}`);
    const out = this.label("seg");
    const tail = ["format=yuv420p", "setsar=1", ...fades, `trim=duration=${num(length)}`];
    const t = clip.transform;
    if (isIdentity(t) && !animated(clip) && !fadesOpacity(clip)) {
      // The common case: fit inside the frame, letterbox with black.
      const steps = [
        ...this.timing(clip, kind, 0),
        ...this.crop(t),
        `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=w=${width}:h=${height}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`,
        ...tail,
      ];
      this.filters.push(`[${index}:v]${steps.join(",")}[${out}]`);
      return out;
    }
    // Moved, scaled, rotated or keyframed: lay it on its own black frame so any part outside the frame is clipped.
    // The segment starts at the clip's own 0, so keyframe offset is 0 (xfade later shifts the whole segment). Opacity is
    // alpha over that black frame; the fades after it then darken to black, so the picture is opacity x fade.
    const shaped = this.label("shp");
    const shape = reshapes(clip) ? this.keyedShape(clip, 0) : this.shape(t);
    this.filters.push(`[${index}:v]${[...this.timing(clip, kind, 0), ...shape, ...this.opacity(clip, 0)].join(",")}[${shaped}]`);
    const bg = this.black(length);
    this.filters.push(`[${bg}][${shaped}]overlay=${this.overlayAt(clip, 0)}:eof_action=pass,${tail.join(",")}[${out}]`);
    return out;
  }

  /** Lays one overlay clip over `base`, shifted to its timeline start; alpha fades. Returns the new base label. */
  overlayClip(base: string, clip: MediaClip): string {
    if (clip.transitionIn) unsupported("overlay_transition");
    const { index, kind } = this.input(clip);
    const length = clipDuration(clip);
    // Frames carry timeline time here, so the clip's local 0 is at `clip.start`.
    const shape = reshapes(clip) ? this.keyedShape(clip, clip.start) : this.shape(clip.transform);
    const steps = [...this.timing(clip, kind, clip.start), ...shape];
    if (clip.fadeIn > 0) steps.push(`fade=t=in:st=${num(clip.start)}:d=${num(clip.fadeIn)}:alpha=1`);
    if (clip.fadeOut > 0) steps.push(`fade=t=out:st=${num(clip.start + length - clip.fadeOut)}:d=${num(clip.fadeOut)}:alpha=1`);
    steps.push(...this.opacity(clip, clip.start));
    const shaped = this.label("ov");
    this.filters.push(`[${index}:v]${steps.join(",")}[${shaped}]`);
    const out = this.label("base");
    this.filters.push(`[${base}][${shaped}]overlay=${this.overlayAt(clip, clip.start)}:eof_action=pass[${out}]`);
    return out;
  }

  /** Joins segments in order; `pending` collects a concat run until an xfade (or the end) closes it. */
  join(parts: { label: string; xfade: null | { type: TransitionType; offset: number; duration: number } }[]): string {
    let acc: string | null = null;
    let pending: string[] = [];
    const flush = () => {
      if (acc) pending.unshift(acc);
      if (pending.length === 1) acc = pending[0];
      else if (pending.length > 1) {
        const out = this.label("cat");
        // concat outputs a 1/1000000 timebase; xfade needs both inputs on the segments' 1/fps.
        this.filters.push(`${pending.map((l) => `[${l}]`).join("")}concat=n=${pending.length}:v=1:a=0,settb=1/${this.doc.project.fps}[${out}]`);
        acc = out;
      }
      pending = [];
    };
    for (const part of parts) {
      if (!part.xfade) {
        pending.push(part.label);
        continue;
      }
      flush();
      const out = this.label("xf");
      this.filters.push(`[${acc}][${part.label}]xfade=transition=${part.xfade.type}:duration=${num(part.xfade.duration)}:offset=${num(part.xfade.offset)}[${out}]`);
      acc = out;
    }
    flush();
    if (!acc) throw new Error("join: no segments");
    return acc;
  }
}

/** Builds the picture graph. Throws `CompileError` for what Phase A can't render. */
export function buildVideoGraph(doc: EditDoc, sources: CompileInputs, options: CompileOptions = {}): VideoGraph {
  const videoTracks = doc.tracks.filter((t) => t.kind === "video" && t.clips.length > 0);
  if (videoTracks.length > 1) unsupported("multiple_video_tracks");
  const duration = editDuration(doc);
  if (duration <= 0) unsupported("empty_edit");

  const g = new Graph(doc, sources);
  const main = videoTracks[0]?.kind === "video" ? [...videoTracks[0].clips].sort((a, b) => a.start - b.start) : [];
  const parts: Parameters<Graph["join"]>[0] = [];
  let end = 0; // timeline end of what is joined so far
  for (const clip of main) {
    const overlap = ms(end - clip.start);
    const xfade = clip.transitionIn && overlap > EPS ? { type: clip.transitionIn.type, offset: clip.start, duration: overlap } : null;
    if (overlap > EPS && !xfade) unsupported("overlapping_clips");
    if (clip.start - end > EPS) {
      parts.push({ label: g.black(clip.start - end), xfade: null });
      end = clip.start;
    }
    // A transition with nothing before it to cross into fades in from black.
    const fromBlack = clip.transitionIn && !xfade ? clip.transitionIn.duration : 0;
    parts.push({ label: g.mainClip(clip, fromBlack), xfade });
    end = ms(clip.start + clipDuration(clip));
  }
  if (duration - end > EPS) parts.push({ label: g.black(duration - end), xfade: null });

  let base = g.join(parts);
  for (const track of doc.tracks) {
    if (track.kind !== "overlay") continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) base = g.overlayClip(base, clip);
  }
  const text = buildTextLayers(doc, base, () => options.fontsDir ?? fontsDir());
  g.filters.push(...text.filters);
  const outLabel = "vout";
  g.filters.push(`[${text.outLabel}]format=yuv420p,setsar=1[${outLabel}]`);
  return { inputArgs: g.inputArgs, filters: g.filters, outLabel, inputCount: g.inputArgs.filter((a) => a === "-i").length, duration, files: text.files };
}

/** Full ffmpeg args for a render (picture, text, sound) to `outputPath` (relative to the work dir, or absolute). */
export function compileVideo(doc: EditDoc, sources: CompileInputs, outputPath: string, options: CompileOptions = {}): CompiledVideo {
  const graph = buildVideoGraph(doc, sources, options);
  const audio = buildAudioGraph(doc, sources, graph.inputCount, { loudnorm: options.loudnorm });
  const filters = [...graph.filters, ...audio.filters];
  // Per-frame shapes add filter threads; on a 16-core host the default (one per core) pushes the address space past the
  // 6 GiB `--as` cap in ffmpeg.ts. Capped for keyframed edits only, so plain edits keep their argv byte-identical.
  const keyed = doc.tracks.some((track) => (track.kind === "video" || track.kind === "overlay") && (track.clips as MediaClip[]).some(animated));
  const args = [
    "-hide_banner", "-nostdin", "-y",
    ...graph.inputArgs,
    ...audio.inputArgs,
    ...(keyed ? ["-filter_complex_threads", "4"] : []),
    "-filter_complex_script", GRAPH_FILE,
    "-map", `[${graph.outLabel}]`,
    ...(audio.outLabel ? ["-map", `[${audio.outLabel}]`, ...AUDIO_ENCODER_ARGS] : ["-an"]),
    ...ENCODER_ARGS,
    "-r", String(doc.project.fps),
    "-t", num(graph.duration),
    "-movflags", "+faststart",
    filePath(outputPath),
  ];
  return { args, files: [{ name: GRAPH_FILE, content: `${filters.join(";\n")}\n` }, ...graph.files] };
}
