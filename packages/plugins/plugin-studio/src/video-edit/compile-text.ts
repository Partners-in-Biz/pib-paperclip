/**
 * Compiles the `text` and `caption` tracks of an edit (schema v1) onto the picture graph. Pure: returns filter lines and
 * the files to write into the render work dir; no I/O, no shell.
 *
 * Untrusted text never enters the filter graph: a text clip's words go into `text-<clipId>.txt`, read by drawtext via
 * `textfile=` with `expansion=none` (so `%{...}` is printed, not run). Caption tracks become one ASS file each, drawn by
 * the `ass` filter with `fontsdir=` set to the bundled fonts; ASS text is escaped (`\`, `{`, `}`, newlines). Only paths
 * we choose (work-dir file names, the fonts folder) are written into the graph, escaped for both filter levels.
 * Tracks are drawn in document order over everything the video compiler laid down (main track + overlays).
 *
 * A text clip with an `animation` (schema v5) is drawn through ASS instead (`text-<clipId>.ass`, same `ass` filter and
 * fonts as captions), its presets written from the shared tables in `text-animation.ts`. Text without one keeps its
 * drawtext, byte for byte.
 */
import { CompileError, type CompileFile } from "./compile-video.js";
import type { LayoutFont } from "../layout.js";
import { FONTS, fontFile, fontId } from "./fonts.js";
import { toFfmpegExpr } from "./keyframes.js";
import { moveOffset, phases, PRESETS, revealTime, revealUnits, type Curve, type Phase } from "./text-animation.js";
import type { CaptionClip, CaptionStyle, CaptionWord, EditDoc, Keyframe, TextClip } from "./timeline.js";

export interface TextLayers { filters: string[]; files: CompileFile[]; outLabel: string }

const ms = (n: number) => Math.round(n * 1000) / 1000;
const num = (n: number) => {
  const v = ms(n);
  return Object.is(v, -0) ? "0" : String(v);
};
const signed = (n: number) => (n < 0 ? `-${num(-n)}` : `+${num(n)}`);

/** ffmpeg's two escaping levels: the option value (`\ ' :`), then the filter graph (`\ ' [ ] , ;`). */
export function filterValue(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new CompileError("bad_input_path", "control characters in a filter value");
  const option = value.replace(/[\\':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** drawtext reads the file as is: one line per line, no trailing blank line. */
export function textFileContent(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/**
 * ASS text: `{`/`}` would open an override block and `\N`, `\n`, `\h` are line-break/space codes, so a backslash gets a
 * word joiner (U+2060, zero width) after it and braces become libass's literal `\{` `\}`; newlines become `\N`.
 */
export function assText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\u2060")
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/\n/g, "\\N");
}

/** ASS time `h:mm:ss.cc` from seconds, rounded to centiseconds. */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/** Alpha for fade in/out on [start, end]; undefined when the clip has no fades. */
function fadeAlpha(start: number, end: number, fadeIn: number, fadeOut: number): string | undefined {
  if (fadeIn <= 0 && fadeOut <= 0) return undefined;
  let expr = "1";
  if (fadeOut > 0) expr = `if(gt(t,${num(end - fadeOut)}),(${num(end)}-t)/${num(fadeOut)},${expr})`;
  if (fadeIn > 0) expr = `if(lt(t,${num(start + fadeIn)}),(t-${num(start)})/${num(fadeIn)},${expr})`;
  return expr;
}

export const textFileName = (clip: TextClip) => `text-${clip.id}.txt`;

/** The bundled font of a text clip, refusing what neither text path can draw. */
function textFont(clip: TextClip): LayoutFont {
  const id = fontId(clip.font);
  if (!id) throw new CompileError("unsupported_feature", "text_font");
  const t = clip.transform;
  const keys = clip.keyframes ?? {};
  if (t.rotate !== 0 || keys.rotate) throw new CompileError("unsupported_feature", "text_rotate");
  if (keys.scale) throw new CompileError("unsupported_feature", "text_scale");
  if (t.crop.left + t.crop.top + t.crop.right + t.crop.bottom > 0) throw new CompileError("unsupported_feature", "text_crop");
  return id;
}

/** One drawtext for a text clip: bold face of its font, centred on the frame plus its x/y offset, shown for its time. */
function drawtext(clip: TextClip, fontsDir: string): string {
  const id = textFont(clip);
  const t = clip.transform;
  const keys = clip.keyframes ?? {};
  // Keyframe `t` counts from the clip's start; drawtext's `t` is timeline time, so the curve is offset by `clip.start`.
  const keyed = (kfs: Keyframe[]) => toFfmpegExpr(kfs, 0, clip.start);
  const size = Math.max(1, Math.round(clip.fontSize * t.scale));
  const end = clip.start + clip.duration;
  const fadeIn = Math.max(clip.fadeIn, clip.transitionIn?.duration ?? 0);
  const opts = [
    `fontfile=${filterValue(`${fontsDir}/${fontFile(id, "bold")}`)}`,
    `textfile=${filterValue(textFileName(clip))}`,
    "expansion=none",
    `fontsize=${size}`,
    `fontcolor=0x${clip.color.slice(1)}`,
    `line_spacing=${Math.round(size * 0.2)}`,
    "text_align=C",
    `borderw=${Math.max(1, Math.round(size / 24))}`,
    "bordercolor=0x000000@0.6",
    keys.x ? `x='(w-text_w)/2+(${keyed(keys.x)})'` : `x=(w-text_w)/2${signed(t.x)}`,
    keys.y ? `y='(h-text_h)/2+(${keyed(keys.y)})'` : `y=(h-text_h)/2${signed(t.y)}`,
    `enable='between(t,${num(clip.start)},${num(end)})'`,
  ];
  // Plan Q13: alpha = keyframe opacity x fade alpha (base opacity 1).
  const fade = fadeAlpha(clip.start, end, fadeIn, clip.fadeOut);
  const alpha = keys.opacity ? (fade ? `(${keyed(keys.opacity)})*(${fade})` : keyed(keys.opacity)) : fade;
  if (alpha) opts.push(`alpha='${alpha}'`);
  return `drawtext=${opts.join(":")}`;
}

/** ASS colour `&HAABBGGRR` from `#RRGGBB` (alpha 00 = opaque). */
const assColor = (hex: string, alpha = "00") => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

interface CaptionLook { bold: boolean; size: number; outline: number; shadow: number; marginV: number; primary: string; secondary: string; maxChars: number }
/** Sizes scale with the frame's short side (1080 for every preset), heights with the frame height. */
function looks(width: number, height: number): Record<CaptionStyle, CaptionLook> {
  const unit = Math.min(width, height);
  const r = (n: number) => Math.round(n);
  return {
    plain: { bold: false, size: r(unit * 0.055), outline: r(unit * 0.003), shadow: r(unit * 0.002), marginV: r(height * 0.12), primary: "#FFFFFF", secondary: "#FFFFFF", maxChars: 42 },
    // The TikTok look: heavy face, thick outline, a third of the way up.
    bold: { bold: true, size: r(unit * 0.075), outline: r(unit * 0.007), shadow: 0, marginV: r(height * 0.28), primary: "#FFFFFF", secondary: "#FFFFFF", maxChars: 24 },
    // Karaoke: words turn from white (secondary) to yellow (primary) as they are spoken (`\k`).
    karaoke: { bold: true, size: r(unit * 0.075), outline: r(unit * 0.007), shadow: 0, marginV: r(height * 0.28), primary: "#FFE000", secondary: "#FFFFFF", maxChars: 24 },
  };
}

/** Words on one caption line: break when the line would pass `maxChars` or the speaker pauses longer than 0.7 s. */
export function captionLines(words: CaptionWord[], maxChars: number): CaptionWord[][] {
  const lines: CaptionWord[][] = [];
  let line: CaptionWord[] = [];
  let length = 0;
  for (const word of words) {
    const prev = line[line.length - 1];
    if (prev && (length + 1 + word.text.length > maxChars || word.start - prev.end > 0.7)) {
      lines.push(line);
      line = [];
      length = 0;
    }
    length += (line.length ? 1 : 0) + word.text.length;
    line.push(word);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** `{\kNN}` per word in centiseconds; boundaries are rounded once so the parts add up to the line's length. */
function karaokeText(line: CaptionWord[]): string {
  const cs = (s: number) => Math.round((s - line[0].start) * 100);
  return line
    .map((word, i) => {
      const next = i + 1 < line.length ? line[i + 1].start : word.end;
      return `{\\k${cs(next) - cs(word.start)}}${assText(word.text)}`;
    })
    .join(" ");
}

/** The ASS document for one caption track. */
export function captionAss(doc: EditDoc, clips: CaptionClip[]): string {
  const { width, height } = doc.project;
  const font = FONTS.sans.family;
  const all = looks(width, height);
  const marginH = Math.round(width * 0.08);
  const styles = (Object.keys(all) as CaptionStyle[]).map((name) => {
    const l = all[name];
    return `Style: ${name},${font},${l.size},${assColor(l.primary)},${assColor(l.secondary)},&H00000000,&H80000000,${l.bold ? -1 : 0},0,0,0,100,100,0,0,1,${l.outline},${l.shadow},2,${marginH},${marginH},${l.marginV},1`;
  });
  const events: string[] = [];
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    for (const line of captionLines(clip.words, all[clip.style].maxChars)) {
      const text = clip.style === "karaoke" ? karaokeText(line) : line.map((w) => assText(w.text)).join(" ");
      events.push(`Dialogue: 0,${assTime(clip.start + line[0].start)},${assTime(clip.start + line[line.length - 1].end)},${clip.style},,0,0,0,,${text}`);
    }
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

export const captionFileName = (trackId: string) => `captions-${trackId}.ass`;
export const textAssName = (clip: TextClip) => `text-${clip.id}.ass`;

/**
 * OS/2 metrics of the bundled bold faces (read from fonts/*.ttf; a test re-reads them). libass sizes a face so that
 * winAscent + winDescent fill the style's Fontsize, where drawtext's fontsize is the em, and `\an5` centres that box on
 * `\pos`. So the ASS size is the drawtext size x (winAscent + winDescent) / upem, and `\pos` is raised by the distance
 * from the box centre to the centre of the cap height, which is where drawtext's ink box centres capitals.
 */
export const ASS_FACE: Record<LayoutFont, { upem: number; winAscent: number; winDescent: number; capHeight: number }> = {
  sans: { upem: 2048, winAscent: 1984, winDescent: 494, capHeight: 1490 },
  serif: { upem: 1000, winAscent: 1206, winDescent: 294, capHeight: 700 },
  rounded: { upem: 1000, winAscent: 1077, winDescent: 300, capHeight: 705 },
};

const hexAlpha = (opacity: number) => `&H${Math.round(255 * (1 - Math.min(1, Math.max(0, opacity)))).toString(16).toUpperCase().padStart(2, "0")}&`;
/** Fill and outline alpha for an opacity: the outline is black at 0.6, as drawtext's `bordercolor=0x000000@0.6`. */
const alphaTags = (opacity: number) => `\\1a${hexAlpha(opacity)}\\3a${hexAlpha(0.6 * opacity)}`;

/** drawtext's fade alpha (`fadeAlpha`) at clip-local `t`. */
function fadeAt(t: number, duration: number, fadeIn: number, fadeOut: number): number {
  if (fadeIn > 0 && t < fadeIn) return Math.max(0, t / fadeIn);
  if (fadeOut > 0 && t > duration - fadeOut) return Math.max(0, (duration - t) / fadeOut);
  return 1;
}

/** The ASS document for one animated text clip: one event per phase (entry, rest, exit), each with its own tags. */
export function animatedTextAss(doc: EditDoc, clip: TextClip): string {
  const id = textFont(clip);
  if (Object.keys(clip.keyframes ?? {}).length) throw new CompileError("unsupported_feature", "text_animation_keyframes");
  const frame = { width: doc.project.width, height: doc.project.height };
  const t = clip.transform;
  const size = Math.max(1, Math.round(clip.fontSize * t.scale));
  const face = ASS_FACE[id];
  const lift = ((face.winAscent - face.winDescent - face.capHeight) / 2 / face.upem) * size;
  const rest = { x: frame.width / 2 + t.x, y: frame.height / 2 + t.y - lift };
  const D = clip.duration;
  const fadeIn = Math.max(clip.fadeIn, clip.transitionIn?.duration ?? 0);
  const text = textFileContent(clip.text);
  const ph = phases(clip.animation, D);
  const restFrom = ph.find((p) => p.side === "in")?.to ?? 0;
  const restTo = ph.find((p) => p.side === "out")?.from ?? D;
  const spans: { from: number; to: number; phase?: Phase }[] = [...ph.map((p) => ({ from: p.from, to: p.to, phase: p })), { from: restFrom, to: restTo }];
  const events = spans
    .sort((a, b) => a.from - b.from)
    .flatMap(({ from, to, phase }) => {
      const start = assTime(clip.start + from);
      const end = assTime(clip.start + to);
      if (start === end) return [];
      const origin = Math.round((clip.start + from) * 100) / 100;
      // Milliseconds from the event's (centisecond) start to clip-local `at`.
      const rel = (at: number) => Math.max(0, Math.round((clip.start + at - origin) * 1000));
      const len = rel(to);
      let tags = "";
      let body = assText(text);
      if (fadeIn > 0 || clip.fadeOut > 0) {
        const t2 = Math.min(to, Math.max(from, fadeIn));
        const t3 = Math.min(to, Math.max(t2, D - clip.fadeOut));
        const a = (at: number) => Math.round(255 * (1 - fadeAt(at, D, fadeIn, clip.fadeOut)));
        if (a(from) + a(t2) + a(to) > 0) tags += `\\fade(${a(from)},${a(t2)},${a(to)},0,${rel(t2)},${rel(t3)},${len})`;
      }
      if (!phase) return [`Dialogue: 0,${start},${end},t,,0,0,0,,{\\pos(${num(rest.x)},${num(rest.y)})${tags}}${body}`];
      const shape = PRESETS[phase.preset];
      // Clip-local time of a curve point: entry runs p forwards from the clip start, exit runs it backwards to the end.
      const at = (p: number) => (phase.side === "in" ? phase.from + p * (phase.to - phase.from) : phase.to - p * (phase.to - phase.from));
      const timed = (curve: Curve, write: (v: number) => string) => {
        const pts = curve.map(([p, v]) => [at(p), v] as const).sort((x, y) => x[0] - y[0]);
        let out = write(pts[0]![1]);
        for (let i = 1; i < pts.length; i++) out += `\\t(${rel(pts[i - 1]![0])},${rel(pts[i]![0])},${write(pts[i]![1])})`;
        return out;
      };
      const far = moveOffset(phase, 0, frame);
      const [x1, y1, x2, y2] = phase.side === "in" ? [rest.x + far.dx, rest.y + far.dy, rest.x, rest.y] : [rest.x, rest.y, rest.x + far.dx, rest.y + far.dy];
      tags = (shape.move ? `\\move(${num(x1)},${num(y1)},${num(x2)},${num(y2)},${rel(phase.from)},${rel(phase.to)})` : `\\pos(${num(rest.x)},${num(rest.y)})`) + tags;
      if (shape.scale) tags += timed(shape.scale, (v) => `\\fscx${num(v * 100)}\\fscy${num(v * 100)}`);
      if (shape.alpha) tags += timed(shape.alpha, alphaTags);
      if (shape.reveal) {
        // Every unit is laid out from the start (so the line does not shift); each one's alpha flips at its time.
        const { units, tail } = revealUnits(text, shape.reveal);
        const [hidden, shown] = phase.side === "in" ? [alphaTags(0), alphaTags(1)] : [alphaTags(1), alphaTags(0)];
        body = units.map((u, i) => {
          const r = rel(revealTime(phase, i, units.length));
          const tag = phase.side === "in" && r <= 0 ? shown : `${hidden}\\t(${r},${r + 1},${shown})`;
          return `${assText(u.prefix)}{${tag}}${assText(u.text)}`;
        }).join("") + assText(tail);
      }
      return [`Dialogue: 0,${start},${end},t,,0,0,0,,{${tags}}${body}`];
    });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: t,${FONTS[id].family},${num((size * (face.winAscent + face.winDescent)) / face.upem)},${assColor(clip.color)},${assColor(clip.color)},&H66000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(size / 24))},0,5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Draws every non-empty text and caption track over `base`, in document order. `base` is returned when there are none. */
export function buildTextLayers(doc: EditDoc, base: string, fontsDir: () => string): TextLayers {
  const filters: string[] = [];
  const files: CompileFile[] = [];
  let label = base;
  let n = 0;
  let dir: string | undefined;
  const fonts = () => (dir ??= fontsDir());
  for (const track of doc.tracks) {
    if (track.clips.length === 0 || (track.kind !== "text" && track.kind !== "caption")) continue;
    const out = `tx${n++}`;
    if (track.kind === "text") {
      const clips = [...track.clips].sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        if (clip.animation) files.push({ name: textAssName(clip), content: animatedTextAss(doc, clip) });
        else files.push({ name: textFileName(clip), content: textFileContent(clip.text) });
      }
      const draw = (clip: TextClip) =>
        clip.animation ? `ass=filename=${filterValue(textAssName(clip))}:fontsdir=${filterValue(fonts())}` : drawtext(clip, fonts());
      filters.push(`[${label}]${clips.map(draw).join(",")}[${out}]`);
    } else {
      const name = captionFileName(track.id);
      files.push({ name, content: captionAss(doc, track.clips) });
      filters.push(`[${label}]ass=filename=${filterValue(name)}:fontsdir=${filterValue(fonts())}[${out}]`);
    }
    label = out;
  }
  return { filters, files, outLabel: label };
}
