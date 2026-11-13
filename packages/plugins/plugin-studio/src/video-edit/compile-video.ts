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
 * Looks and colour adjust (schema v3, D2c) grade each clip right after its timing, before crop/rotate/scale, with the
 * filters `looks.ts` derives (the preview reads the same module), so shape and alpha work on the graded picture.
 * Overlay frame and blend mode (schema v4, D3b) come from `layer.ts`: the frame rounds and borders the shaped picture,
 * a blend mode blends it with the base in RGB (`lut2`) instead of the plain `overlay`.
 * Text and caption tracks are drawn last, over everything, by `compile-text.ts` (A5a). Sound is compiled by
 * `compile-audio.ts` (A5b) into the same graph; a silent edit gets no audio stream (`-an`). Anything else outside this
 * model throws `CompileError` with `unsupported_feature:<name>`.
 */
import { StudioError } from "../errors.js";
import { AUDIO_ENCODER_ARGS, INTERMEDIATE_AUDIO_ENCODER_ARGS, buildAudioGraph } from "./compile-audio.js";
import { buildTextLayers } from "./compile-text.js";
import { fontsDir } from "./fonts.js";
import { toFfmpegExpr } from "./keyframes.js";
import { blendLutExpr, frameStill, type LayerBlend } from "./layer.js";
import { adjustToFfmpeg, lookToFfmpeg } from "./looks.js";
import { clipDuration, editDuration, type EditDoc, type MediaClip, type Transform, type TransitionType } from "./timeline.js";

/**
 * A downloaded source: `path` is local (absolute or relative to the work dir); `kind` comes from the asset row/probe.
 * `width`, `height` and `fps` (from the probe) only weigh the input for the render planner; the compiler ignores them.
 */
export interface CompileInput { path: string; kind: "video" | "image" | "audio"; hasAudio?: boolean; width?: number; height?: number; fps?: number }
/** Inputs keyed by `inputKey(assetId, version)`. */
export type CompileInputs = Record<string, CompileInput>;
export interface CompileFile { name: string; content: string }
export interface CompiledVideo { args: string[]; files: CompileFile[] }
/** The video half of a render, for the audio compiler to extend: input args, graph lines, the final label, work-dir files. */
export interface VideoGraph { inputArgs: string[]; filters: string[]; outLabel: string; inputCount: number; duration: number; files: CompileFile[] }
/** `fontsDir`: where the bundled TTFs are (default: beside the worker); only read when the edit has text or captions. */
export interface CompileOptions {
  fontsDir?: string;
  loudnorm?: boolean;
  /** A multi-pass intermediate: near-lossless H.264 plus PCM sound. The caller names the output `.mov`. Default: the delivery encode. */
  intermediate?: boolean;
  /**
   * The edit time of this doc's 0 (a render-plan chunk pass): main-track segments are cut on the whole edit's frame grid,
   * `frameAt(origin + t)`, so the chunk renders the same frames as that stretch of the single pass. Default 0.
   */
  origin?: number;
}

export const GRAPH_FILE = "video.graph";
/** H.264 High, CRF 20 capped at 6 Mbit/s: a 180 s 1080x1920 render stays near 140 MB (plan PAR-8276, Critic 2d). */
export const ENCODER_ARGS = ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p"] as const;
/**
 * Thread caps for every render (PAR-10432). `-threads` is per file in ffmpeg: the `-threads 4` in `containedArgv`
 * reaches the first input only, so on the 16-core host every other input decoded with 16+ threads, the filter graph
 * ran 16 and x264 about 24. Each thread costs an 8 MiB stack and often its own 64 MiB malloc arena, all counted by
 * the 6 GiB `--as` cap: three 10 s clips with a look reached 186 threads and failed at VmPeak 6143 MiB, and plain
 * 30 s edits already peaked at 5695 MiB. With these caps (and `MALLOC_ARENAS` in ffmpeg.ts) they peak near 2.5 GiB.
 */
/**
 * Lossless intermediate between passes, so a multi-pass render is pixel-identical to the single pass. Any lossy
 * intermediate re-enters the final encoder's own noise: on the T7 equivalence fixtures crf 12 gave mean PSNR 41.0 to
 * 42.4 dB against the single pass and crf 4 gave 42.8 (bar: 42), while qp 0 gives identical frames (PAR-10465). Cost at
 * 1080x1920 30 fps: 2 to 3 MiB/s ungraded, about 14 MB/s graded (the vignette adjust dithers every pixel), so a 180 s
 * full-length pass is up to about 2.5 GB. The render pipeline passes `INTERMEDIATE_FSIZE_BYTES` (render-pipeline.ts).
 */
export const INTERMEDIATE_ENCODER_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv420p"] as const;
export const DECODE_THREADS = 2;
export const FILTER_THREADS = 4;
export const ENCODE_THREADS = 4;

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
/**
 * The project frame grid: the first frame whose (millisecond) time is at or after `t`. A main-track segment over
 * `[s, e)` gets `frameAt(e) - frameAt(s)` frames, so every cut lands on the frame at or after its time and nothing drifts
 * across cuts (a 0.35 s clip at 30 fps is 10 or 11 frames, not always 11). The render planner cuts chunks on this grid.
 */
export function frameAt(t: number, fps: number): number {
  let f = Math.max(0, Math.ceil(t * fps - 1e-6));
  while (f > 0 && ms((f - 1) / fps) >= t - 1e-9) f--;
  return f;
}
/** Frames `color=d=` gives on its own: those that start before the end. */
const ownFrames = (length: number, fps: number) => Math.max(0, Math.ceil(ms(length) * fps - 1e-6));
/**
 * Frames `trim=duration` keeps after `fps`: the duration in the 1/fps timebase, rounded to nearest (`av_rescale_q`), so
 * 0.167 s at 30 fps is 5 frames, not the 6 the grid may need; then the segment gets `trim=end_frame` (PAR-10465).
 */
const trimFrames = (length: number, fps: number) => Math.floor((Math.round(length * 1000) * fps + 500) / 1000);
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
/** A look or a colour adjust on the clip (normalizeEdit drops neutral adjust fields, so present means non-neutral). */
const graded = (clip: MediaClip) => Boolean(clip.look || clip.adjust);

/** Filters that take RGB only. Everything else in a grade runs on YUV (`eq`, `vignette`) or either (`gblur`). */
const RGB_ONLY = /^(colorchannelmixer|curves|colortemperature)=/;
/**
 * YUV <-> RGB with BT.709 named on both sides. ffmpeg's automatic conversion picks the matrix per direction (frame tag
 * one way, BT.601 the other), which moved Y by 2 (untagged) to 7 (BT.709-tagged) code values on a flat colour through
 * an identity `colorchannelmixer`; the same matrix both ways is exact. Input range stays automatic (JPEG is full range).
 * The alpha plane is kept for images only (a PNG may be transparent); video is graded opaque, which measured about
 * 1.8 s cheaper per 10 s of 1080x1920 for a look.
 */
const toRgb = (alpha: boolean) => ["scale=in_color_matrix=bt709", alpha ? "format=gbrap" : "format=gbrp"];
const toYuv = (alpha: boolean) => ["scale=out_color_matrix=bt709:out_range=tv", alpha ? "format=yuva420p" : "format=yuv420p"];

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
    this.inputArgs.push("-threads", String(DECODE_THREADS));
    if (source.kind === "image") this.inputArgs.push("-loop", "1", "-framerate", String(this.doc.project.fps), "-t", num(clipDuration(clip)), "-i", filePath(source.path));
    else if (source.kind === "video") this.inputArgs.push("-ss", num(clip.in), "-t", num(clip.out - clip.in), "-i", filePath(source.path));
    else unsupported(`input_kind_${String(source.kind)}`);
    return { index: this.inputs++, kind: source.kind };
  }

  /** Black for `duration` seconds at project size and rate; `frames`: its grid length when that differs. */
  black(duration: number, frames = ownFrames(duration, this.doc.project.fps)): string {
    const { width, height, fps } = this.doc.project;
    const out = this.label("blk");
    const cut = frames === ownFrames(duration, fps) ? "" : `,trim=end_frame=${frames}`;
    this.filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${num(duration)}${cut},format=yuv420p,setsar=1[${out}]`);
    return out;
  }

  /** Timing chain shared by both tracks: zero-based pts, speed, optional timeline shift, constant project rate. */
  private timing(clip: MediaClip, kind: CompileInput["kind"], shift: number): string[] {
    const speed = kind === "video" && clip.speed !== 1 ? `/${num(clip.speed)}` : "";
    const pts = speed ? `(PTS-STARTPTS)${speed}` : "PTS-STARTPTS";
    return [`setpts=${shift ? `${pts}+${num(shift)}/TB` : pts}`, `fps=${this.doc.project.fps}`];
  }

  /**
   * The clip's look then adjust, in `looks.ts` order: look (mixer, curves), eq, colortemperature, gblur, vignette. Runs
   * on the source frame before crop/shape. RGB-only filters get explicit BT.709 conversions around them and the chain
   * always ends in YUV. Blur first scales the frame to the render width, so the `looks.ts` sigma (at render width) is a
   * fixed fraction of the clip's own width whatever the source resolution. `vignette` has no alpha formats, so on an
   * image it runs on a split copy and the source alpha is merged back (a PNG overlay keeps its transparency). `[]` when
   * not graded.
   */
  private grade(clip: MediaClip, kind: CompileInput["kind"]): string[] {
    if (!graded(clip)) return [];
    const { width } = this.doc.project;
    const alpha = kind === "image";
    // An image starts in RGB with its own decoder matrix (PNG is RGB, JPEG is BT.601 by spec), so every graded image
    // leaves the chain through the explicit BT.709 `toYuv`. Without this an adjust-only PNG fell to ffmpeg's implicit
    // BT.601 and a JPEG look read BT.601 codes as BT.709: Y 101 against 92 for the same pixel (review, PAR-10158).
    const out: string[] = alpha ? ["format=gbrap"] : [];
    let rgb = alpha;
    const yuv = () => {
      if (rgb) out.push(...toYuv(alpha));
      rgb = false;
    };
    for (const f of [...(clip.look ? lookToFfmpeg(clip.look) : []), ...(clip.adjust ? adjustToFfmpeg(clip.adjust, { renderWidth: width }) : [])]) {
      if (RGB_ONLY.test(f)) {
        if (!rgb) out.push(...toRgb(alpha));
        rgb = true;
        out.push(f);
      } else if (f.startsWith("gblur=")) {
        out.push(`scale=w=${width}:h=-2`, f);
      } else if (f.startsWith("vignette=") && alpha) {
        yuv();
        const [a, b, c, d] = [this.label("vga"), this.label("vgb"), this.label("vgc"), this.label("vgd")];
        if (out.at(-1) !== "format=yuva420p") out.push("format=yuva420p");
        out.push(`split[${a}][${b}];[${a}]format=yuv420p,${f}[${c}];[${b}]alphaextract[${d}];[${c}][${d}]alphamerge`);
      } else {
        yuv();
        out.push(f);
      }
    }
    yuv();
    return out;
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
    if (!keysOf(clip, "rotate")) return [...this.shape({ ...t, scale: 1 }, "black@0"), ...this.frame(clip), scale];
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
  mainClip(clip: MediaClip, fadeInFromBlack: number, frames?: number): string {
    const { width, height, fps } = this.doc.project;
    const { index, kind } = this.input(clip);
    const length = clipDuration(clip);
    const fades: string[] = [];
    const fadeIn = Math.max(clip.fadeIn, fadeInFromBlack);
    if (fadeIn > 0) fades.push(`fade=t=in:st=0:d=${num(fadeIn)}`);
    if (clip.fadeOut > 0) fades.push(`fade=t=out:st=${num(length - clip.fadeOut)}:d=${num(clip.fadeOut)}`);
    const out = this.label("seg");
    const cut = frames === undefined || frames === trimFrames(length, fps) ? `trim=duration=${num(length)}` : `trim=end_frame=${Math.max(1, frames)}`;
    const tail = ["format=yuv420p", "setsar=1", ...fades, cut];
    const t = clip.transform;
    if (isIdentity(t) && !animated(clip) && !fadesOpacity(clip)) {
      // The common case: fit inside the frame, letterbox with black.
      const steps = [
        ...this.timing(clip, kind, 0),
        ...this.grade(clip, kind),
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
    this.filters.push(`[${index}:v]${[...this.timing(clip, kind, 0), ...this.grade(clip, kind), ...shape, ...this.opacity(clip, 0)].join(",")}[${shaped}]`);
    const bg = this.black(length);
    this.filters.push(`[${bg}][${shaped}]overlay=${this.overlayAt(clip, 0)}:eof_action=pass,${tail.join(",")}[${out}]`);
    return out;
  }

  /**
   * Frame (schema v4, D3b) on the shaped picture at its fitted size: corners rounded and a border drawn inside the edge
   * along that outline (`layer.ts` `frameStill`; the picture keeps its size and position). Mask and border are built
   * once, with `geq` on the clip's first frame, and reused: the second input of `blend`/`overlay` repeats its one
   * frame. The corner mask multiplies the alpha already there (a PNG keeps its transparency); fades and opacity run
   * after, so the border fades with the clip. With scale keys it runs before the keyed scale, so border and radius scale
   * with the clip (CSS `transform` semantics). Rotation is refused (`frame_with_rotation`): the rounded outline would
   * follow the rotated bounding box. One chain step (sub-chains joined with `;`); `[]` without a visible frame.
   */
  private frame(clip: MediaClip): string[] {
    const f = clip.frame;
    if (!f || (f.cornerRadius <= 0 && f.borderWidth <= 0)) return [];
    if (clip.transform.rotate !== 0 || keysOf(clip, "rotate")) unsupported("frame_with_rotation");
    const still = frameStill(f);
    const [pic, first] = [this.label("frp"), this.label("frs")];
    const stills = [still.mask, still.ring].filter(Boolean).map(() => this.label("frs"));
    const chains = [`format=yuva420p,split[${pic}][${first}]`, `[${first}]trim=end_frame=1${stills.length > 1 ? ",split" : ""}${stills.map((l) => `[${l}]`).join("")}`];
    let last = pic;
    if (still.mask) {
      const [mask, p0, p1, a0, a1, rounded] = ["frm", "frp", "frp", "fra", "fra", "frp"].map((p) => this.label(p));
      chains.push(
        `[${stills[0]}]format=gray,geq=lum='${still.mask}'[${mask}]`,
        `[${last}]split[${p0}][${p1}]`,
        `[${p1}]alphaextract[${a0}]`,
        `[${a0}][${mask}]blend=all_mode=multiply[${a1}]`,
        `[${p0}][${a1}]alphamerge[${rounded}]`,
      );
      last = rounded;
    }
    if (still.ring) {
      const ring = this.label("frr");
      const [r, g, b] = still.color;
      chains.push(`[${stills.at(-1)}]format=gbrap,geq=r=${r}:g=${g}:b=${b}:a='${still.ring}',${toYuv(true).join(",")}[${ring}]`, `[${last}][${ring}]overlay=x=0:y=0,format=yuva420p`);
    } else chains.push(`[${last}]null`);
    return [chains.join(";")];
  }

  /**
   * Blend mode (schema v4, D3b): the overlay goes on a transparent full-frame canvas over its interval (the same
   * placement as `overlay=`), `lut2` blends that canvas with the base in RGB by the `blend.ts` formula, and the result,
   * carrying the canvas alpha, is laid over the base: out = base + alpha x (blend - base). Outside the clip's interval
   * the base passes through untouched. BT.709 both ways, as `grade`. Returns the new base label.
   */
  private blendOver(base: string, shaped: string, clip: MediaClip, mode: LayerBlend): string {
    const { width, height, fps } = this.doc.project;
    const length = clipDuration(clip);
    const [canvas, pc, pa, alpha, b0, b1, bt, lt, bl, merged, out] = ["bcv", "bpc", "bpa", "bpa", "bb", "bb", "bbt", "blt", "bbl", "bbl", "base"].map((p) => this.label(p));
    const expr = blendLutExpr(mode);
    this.filters.push(
      `color=c=black@0:s=${width}x${height}:r=${fps}:d=${num(length)},format=yuva420p,setpts=PTS-STARTPTS+${num(clip.start)}/TB[${canvas}]`,
      `[${canvas}][${shaped}]overlay=${this.overlayAt(clip, clip.start)}:eof_action=pass,format=yuva420p,split[${pc}][${pa}]`,
      `[${base}]split[${b0}][${b1}]`,
      `[${b1}]trim=start=${num(clip.start)}:end=${num(clip.start + length)},${toRgb(false).join(",")}[${bt}]`,
      `[${pc}]${toRgb(false).join(",")}[${lt}]`,
      `[${bt}][${lt}]lut2=c0='${expr}':c1='${expr}':c2='${expr}',${toYuv(false).join(",")}[${bl}]`,
      `[${pa}]alphaextract[${alpha}]`,
      `[${bl}][${alpha}]alphamerge[${merged}]`,
      `[${b0}][${merged}]overlay=x=0:y=0:eof_action=pass[${out}]`,
    );
    return out;
  }

  /** Lays one overlay clip over `base`, shifted to its timeline start; alpha fades. Returns the new base label. */
  overlayClip(base: string, clip: MediaClip): string {
    if (clip.transitionIn) unsupported("overlay_transition");
    const { index, kind } = this.input(clip);
    const length = clipDuration(clip);
    // Frames carry timeline time here, so the clip's local 0 is at `clip.start`.
    const shape = reshapes(clip) ? this.keyedShape(clip, clip.start) : [...this.shape(clip.transform), ...this.frame(clip)];
    const steps = [...this.timing(clip, kind, clip.start), ...this.grade(clip, kind), ...shape];
    if (clip.fadeIn > 0) steps.push(`fade=t=in:st=${num(clip.start)}:d=${num(clip.fadeIn)}:alpha=1`);
    if (clip.fadeOut > 0) steps.push(`fade=t=out:st=${num(clip.start + length - clip.fadeOut)}:d=${num(clip.fadeOut)}:alpha=1`);
    steps.push(...this.opacity(clip, clip.start));
    const shaped = this.label("ov");
    this.filters.push(`[${index}:v]${steps.join(",")}[${shaped}]`);
    if (clip.blendMode) return this.blendOver(base, shaped, clip, clip.blendMode);
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

/**
 * One piece of the main track in join order: a clip (`clip`) or black (`clip: null`), `length` s long, `frames` frames on
 * the grid of `origin` (CompileOptions), joined by concat or, with `xfade`, crossfaded into what comes before it.
 */
export interface MainSegment { clip: MediaClip | null; length: number; frames: number; xfade: null | { type: TransitionType; offset: number; duration: number }; fromBlack: number }

/** The main track as segments: gaps, the lead-in and the tail up to the edit's end are black. Throws `CompileError`. */
export function mainSegments(doc: EditDoc, origin = 0): MainSegment[] {
  const videoTracks = doc.tracks.filter((t) => t.kind === "video" && t.clips.length > 0);
  if (videoTracks.length > 1) unsupported("multiple_video_tracks");
  const duration = editDuration(doc);
  const main = videoTracks[0]?.kind === "video" ? [...videoTracks[0].clips].sort((a, b) => a.start - b.start) : [];
  const out: MainSegment[] = [];
  let end = 0; // timeline end of what is joined so far
  const { fps } = doc.project;
  const span = (from: number, to: number) => frameAt(ms(origin + to), fps) - frameAt(ms(origin + from), fps);
  const black = (from: number, to: number) => ({ clip: null, length: to - from, frames: span(from, to), xfade: null, fromBlack: 0 });
  for (const clip of main) {
    const overlap = ms(end - clip.start);
    const xfade = clip.transitionIn && overlap > EPS ? { type: clip.transitionIn.type, offset: clip.start, duration: overlap } : null;
    if (overlap > EPS && !xfade) unsupported("overlapping_clips");
    if (clip.start - end > EPS) {
      if (span(end, clip.start) > 0) out.push(black(end, clip.start));
      end = clip.start;
    }
    // A transition with nothing before it to cross into fades in from black.
    const fromBlack = clip.transitionIn && !xfade ? clip.transitionIn.duration : 0;
    const clipEnd = ms(clip.start + clipDuration(clip));
    out.push({ clip, length: clipDuration(clip), frames: span(clip.start, clipEnd), xfade, fromBlack });
    end = clipEnd;
  }
  if (duration - end > EPS && span(end, duration) > 0) out.push(black(end, duration));
  return out;
}

/** Builds the picture graph. Throws `CompileError` for what Phase A can't render. */
export function buildVideoGraph(doc: EditDoc, sources: CompileInputs, options: CompileOptions = {}): VideoGraph {
  const segments = mainSegments(doc, options.origin ?? 0);
  const duration = editDuration(doc);
  if (duration <= 0) unsupported("empty_edit");

  const g = new Graph(doc, sources);
  const parts = segments.map((s) => ({ label: s.clip ? g.mainClip(s.clip, s.fromBlack, s.frames) : g.black(s.length, s.frames), xfade: s.xfade }));
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
  const args = [
    "-hide_banner", "-nostdin", "-y",
    ...graph.inputArgs,
    ...audio.inputArgs,
    "-filter_complex_threads", String(FILTER_THREADS),
    "-filter_complex_script", GRAPH_FILE,
    "-map", `[${graph.outLabel}]`,
    ...(audio.outLabel ? ["-map", `[${audio.outLabel}]`, ...(options.intermediate ? INTERMEDIATE_AUDIO_ENCODER_ARGS : AUDIO_ENCODER_ARGS)] : ["-an"]),
    ...(options.intermediate ? INTERMEDIATE_ENCODER_ARGS : ENCODER_ARGS),
    "-threads", String(ENCODE_THREADS),
    "-r", String(doc.project.fps),
    "-t", num(graph.duration),
    "-movflags", "+faststart",
    filePath(outputPath),
  ];
  return { args, files: [{ name: GRAPH_FILE, content: `${filters.join(";\n")}\n` }, ...graph.files] };
}
