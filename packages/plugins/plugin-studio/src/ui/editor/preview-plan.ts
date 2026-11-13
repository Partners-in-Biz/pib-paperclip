/**
 * Live preview plan (PAR-8319): what the Player shows at timeline time t, without ffmpeg. Pure, so it is unit tested.
 * Each video clip becomes a segment on the timeline; `frameAt` says which segment shows at t, which source second of
 * its asset to show (speed applied), how opaque it is and how loud, plus the segment to preload next. Between clips (a
 * gap) the preview is black.
 * Transitions and keyframes (PAR-8449): inside a main-track transition window two layers show, the outgoing and the
 * incoming clip, styled with CSS that follows ffmpeg's xfade maths (clip-path for wipe/circle, transform for
 * slide/zoom, a black/white matte for fadeblack/fadewhite, opacity for fade/dissolve). Each layer's clip is moved,
 * scaled, rotated and faded by its keyframes through `valueAt`, the evaluator the render uses (plan Q9: `t` counts from
 * the clip's own start). A transition with no overlapping clip before it previews as a fade from black, as before.
 * Looks and colour adjust (PAR-10159): `previewGrade` turns a clip's look and adjust into an SVG filter on its video,
 * from the same `looks.ts` primitives the render's ffmpeg filters come from (see there for the formulas).
 * Overlay layers (PAR-10166, slice 3): clips on `overlay` tracks show over the base in track order (later track on top),
 * each with its blend mode (CSS `mix-blend-mode`, `layer.ts` `BLEND_CSS`) and frame (`layerFrame`: rounded corners and a
 * border inside the edge, the geometry of the render's `frameStill`).
 */
import type { EditDoc, Frame, Keyframes, MediaClip, TextClip, TransitionType } from "../../video-edit/timeline.js";
import { valueAt } from "../../video-edit/keyframes.js";
import { toSvgPrimitives, vignetteStops, type Adjust, type LookRef, type SvgPrimitive } from "../../video-edit/looks.js";
import { BLEND_CSS, cornerRadiusPx, type LayerBlend } from "../../video-edit/layer.js";
import { clipLength } from "./player-clips.js";

export interface PreviewSegment {
  clipId: string;
  assetId: string;
  /** Timeline start and end, in seconds. */
  start: number;
  end: number;
  /** Source in and out points, in seconds of the asset. */
  in: number;
  out: number;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** The main-track clip this one transitions from (it overlaps this one's start), its xfade type and window length. */
  from: string | null;
  transition: TransitionType | null;
  transitionDuration: number;
  /** Static transform: centre offset in output px, scale (1 = fit), rotation in degrees. */
  transform: { x: number; y: number; scale: number; rotate: number };
  keyframes: Keyframes;
  /** Schema v3 grade: the clip's look and its non-neutral adjust fields (null when absent). */
  look: LookRef | null;
  adjust: Partial<Adjust> | null;
  /** Schema v4 overlay clip fields (null on the main track and when unset). */
  blendMode: LayerBlend | null;
  frame: Frame | null;
}

export interface PreviewPlan {
  segments: PreviewSegment[];
  /** Overlay-track clips, lowest track first (paint order); they never set `end` or take part in `frameAt`. */
  overlays: PreviewSegment[];
  /** End of the last segment: the length of the preview. */
  end: number;
}

/** How a whole layer looks in a transition (the frame-sized box around the clip). */
export interface LayerLook {
  opacity: number;
  clipPath: string | null;
  transform: string | null;
}

/** One clip on screen: its transition look plus its keyframed placement inside the frame. */
export interface PreviewLayer extends LayerLook {
  segment: PreviewSegment;
  sourceTime: number;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  /** 0..1 keyframe opacity x fade (plan Q13). */
  alpha: number;
  /** 0..1 element volume. */
  volume: number;
}

export interface PreviewFrame {
  /** `clip`: a segment shows; `gap`: black before the next segment; `end`: at or past the end (or nothing to play). */
  kind: "clip" | "gap" | "end";
  /** The showing segment (the incoming one inside a transition). */
  segment: PreviewSegment | null;
  /** The source second to show (0 when no segment shows). */
  sourceTime: number;
  /** 0..1 picture opacity of `segment` over black. */
  opacity: number;
  /** 0..1 element volume of `segment` (clip volume above 1 is capped in the preview). */
  volume: number;
  /** The segment that plays after this point, to preload. */
  next: PreviewSegment | null;
  /** Layers in paint order, bottom first: one, or two inside a transition window. */
  layers: PreviewLayer[];
  /** fadeblack/fadewhite: the colour layer painted between the two layers. */
  matte: { color: "black" | "white"; opacity: number } | null;
}

/** Times this close count as equal (the edit rounds to milliseconds). */
const EPS = 1e-6;
/** Last showable source second: just before `out`, so a frame exists. */
const FRAME = 0.001;
const NONE: Keyframes = {};

export function buildPreviewPlan(doc: EditDoc | null): PreviewPlan {
  const segments: PreviewSegment[] = [];
  const overlays: PreviewSegment[] = [];
  const main = doc?.tracks.find((t) => t.kind === "video");
  for (const track of doc?.tracks ?? []) {
    if (track.kind !== "video" && track.kind !== "overlay") continue;
    let prev: { id: string; end: number } | null = null;
    for (const c of [...(track.clips as MediaClip[])].sort((a, b) => a.start - b.start)) {
      const length = clipLength(c);
      if (length <= 0) continue;
      const tr = c.transitionIn;
      // An xfade needs the clip before it on the main track to overlap its start (plan Q1).
      const xfade = !!tr && track === main && !!prev && prev.end > c.start + EPS;
      (track.kind === "overlay" ? overlays : segments).push({
        clipId: c.id,
        assetId: c.assetId,
        start: c.start,
        end: c.start + length,
        in: c.in,
        out: c.out,
        speed: c.speed || 1,
        volume: c.volume ?? 1,
        fadeIn: xfade ? c.fadeIn || 0 : Math.max(c.fadeIn || 0, tr?.duration ?? 0),
        fadeOut: c.fadeOut || 0,
        from: xfade ? prev!.id : null,
        transition: xfade ? tr!.type : null,
        transitionDuration: xfade ? Math.min(tr!.duration, prev!.end - c.start) : 0,
        transform: { x: c.transform?.x ?? 0, y: c.transform?.y ?? 0, scale: c.transform?.scale ?? 1, rotate: c.transform?.rotate ?? 0 },
        keyframes: c.keyframes ?? NONE,
        look: c.look ?? null,
        adjust: c.adjust ?? null,
        blendMode: track.kind === "overlay" ? c.blendMode ?? null : null,
        frame: track.kind === "overlay" ? c.frame ?? null : null,
      });
      prev = { id: c.id, end: c.start + length };
    }
  }
  segments.sort((a, b) => a.start - b.start);
  return { segments, overlays, end: segments.reduce((end, s) => Math.max(end, s.end), 0) };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000 || 0;
const pct = (n: number) => `${r4(n * 100)}%`;
/** ffmpeg xfade's smoothstep. */
const smoothstep = (e0: number, e1: number, x: number) => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};

/** 0..1 fade factor of a segment at timeline time t. */
export function fadeAt(s: PreviewSegment, t: number): number {
  let f = 1;
  if (s.fadeIn > 0) f = Math.min(f, (t - s.start) / s.fadeIn);
  if (s.fadeOut > 0) f = Math.min(f, (s.end - t) / s.fadeOut);
  return clamp01(f);
}

/** The source second of a segment at timeline time t (speed applied, kept inside in..out). */
export function sourceTimeAt(s: PreviewSegment, t: number): number {
  const src = s.in + (t - s.start) * s.speed;
  return Math.min(Math.max(src, s.in), Math.max(s.in, s.out - FRAME));
}

/** The timeline time at which a segment shows a given source second (the inverse of `sourceTimeAt`). */
export function timelineTimeAt(s: PreviewSegment, sourceTime: number): number {
  return s.start + (sourceTime - s.in) / s.speed;
}

export interface TransitionMix {
  out: LayerLook;
  in: LayerLook;
  matte: PreviewFrame["matte"];
  /** False only for circleclose, where the outgoing clip shrinks inside a circle on top. */
  inOnTop: boolean;
}

const look = (opacity = 1, clipPath: string | null = null, transform: string | null = null): LayerLook => ({ opacity: r4(opacity), clipPath, transform });

/**
 * The CSS look of both layers at transition progress p (0 at the window's start, 1 at its end). Follows libavfilter's
 * vf_xfade, whose own progress P runs 1 -> 0: wipes split the frame at P, slides shift by P frames, circles cut at the
 * smoothstep's midpoint (hard edge), fadeblack/fadewhite and zoomin use the same smoothsteps and weights.
 */
export function transitionMix(type: TransitionType, p: number): TransitionMix {
  const P = 1 - clamp01(p);
  const plain = { out: look(), matte: null, inOnTop: true };
  switch (type) {
    case "fade":
    case "dissolve": // dissolve dithers per pixel; on average it is a fade
      return { ...plain, in: look(1 - P) };
    case "fadeblack":
    case "fadewhite": {
      // Weights of outgoing, incoming and colour, turned into opacities of layers stacked out < matte < in.
      const s1 = smoothstep(0.8, 1, P);
      const s2 = smoothstep(0.2, 1, P);
      const wb = (1 - P) * (1 - s2);
      const wk = P * (1 - s1) + (1 - P) * s2;
      const ok = wb < 1 ? clamp01(wk / (1 - wb)) : 0;
      const oa = wb < 1 && ok < 1 ? clamp01((P * s1) / ((1 - wb) * (1 - ok))) : 0;
      return { out: look(oa), in: look(wb), matte: { color: type === "fadeblack" ? "black" : "white", opacity: r4(ok) }, inOnTop: true };
    }
    case "wipeleft": return { ...plain, in: look(1, `inset(0 0 0 ${pct(P)})`) };
    case "wiperight": return { ...plain, in: look(1, `inset(0 ${pct(P)} 0 0)`) };
    case "wipeup": return { ...plain, in: look(1, `inset(${pct(P)} 0 0 0)`) };
    case "wipedown": return { ...plain, in: look(1, `inset(0 0 ${pct(P)} 0)`) };
    case "slideleft": return { ...plain, out: look(1, null, `translate(${pct(P - 1)}, 0%)`), in: look(1, null, `translate(${pct(P)}, 0%)`) };
    case "slideright": return { ...plain, out: look(1, null, `translate(${pct(1 - P)}, 0%)`), in: look(1, null, `translate(${pct(-P)}, 0%)`) };
    case "slideup": return { ...plain, out: look(1, null, `translate(0%, ${pct(P - 1)})`), in: look(1, null, `translate(0%, ${pct(P)})`) };
    case "slidedown": return { ...plain, out: look(1, null, `translate(0%, ${pct(1 - P)})`), in: look(1, null, `translate(0%, ${pct(-P)})`) };
    // xfade's radius unit is half the frame diagonal; CSS circle() % is the diagonal / sqrt 2, so 1 unit = 70.71%.
    case "circleopen": return { ...plain, in: look(1, `circle(${pct(Math.max(0, 2 - 3 * P) * Math.SQRT1_2)} at 50% 50%)`) };
    case "circleclose": return { out: look(1, `circle(${pct(Math.max(0, 3 * P - 1) * Math.SQRT1_2)} at 50% 50%)`), in: look(), matte: null, inOnTop: false };
    case "zoomin": {
      const zf = smoothstep(0.5, 1, P);
      return { ...plain, out: look(1, null, `scale(${r4(1 / Math.max(zf, 0.01))})`), in: look(1 - smoothstep(0, 0.5, P)) };
    }
  }
}

function layerAt(s: PreviewSegment, t: number, l: LayerLook, gain: number): PreviewLayer {
  const k = s.keyframes;
  const lt = t - s.start;
  const fade = fadeAt(s, t);
  return {
    ...l,
    segment: s,
    sourceTime: sourceTimeAt(s, t),
    x: valueAt(k.x, lt, s.transform.x),
    y: valueAt(k.y, lt, s.transform.y),
    scale: valueAt(k.scale, lt, s.transform.scale),
    rotate: valueAt(k.rotate, lt, s.transform.rotate),
    alpha: clamp01(valueAt(k.opacity, lt, 1) * fade),
    volume: clamp01(valueAt(k.volume, lt, s.volume) * fade * gain),
  };
}

/** CSS transform placing a layer's clip in the frame like the render does: centre offset, then scale, then rotation. */
export function clipTransform(l: Pick<PreviewLayer, "x" | "y" | "scale" | "rotate">, project: { width: number; height: number }): string {
  return `translate(${pct(l.x / project.width)}, ${pct(l.y / project.height)}) scale(${r4(l.scale)}) rotate(${r4(l.rotate)}deg)`;
}

/**
 * ffmpeg `vignette` (run on yuv420p TV range) multiplies the luma code, black's 16 included, and the chroma about 127,
 * so on full-scale RGB it is `gain*in - VIGNETTE_K*(1 - gain)`: corners go below black (measured on ffmpeg 6.1.1, a
 * black frame's corner Y fell from 16 to 1). The preview composites the same line with feComposite arithmetic.
 */
export const VIGNETTE_K = 16 / 219;
/** Gradient stops for the vignette mask: 33 keep the linear interpolation of cos^4 well under 1/255. */
const VIGNETTE_STOPS = 33;

export interface Box { x: number; y: number; width: number; height: number }

/** A clip's grade as an SVG filter on its `<video>` (CSS px of the element, before the layer's transform). */
export interface PreviewGrade {
  /** The picture inside the element (`object-fit: contain`), so letterbox bars stay out of blur and vignette. */
  region: Box;
  /** Look then eq, colortemperature and gblur in render order; blur std in CSS px of the picture's width. */
  primitives: SvgPrimitive[];
  /** The radial gain image to lay on `region`, composited as `gain*in - k*(1 - gain)`. */
  vignette: { href: string; k: number } | null;
}

/** Where `object-fit: contain` puts a source of `source` size inside `box`; the whole box until the size is known. */
export function containBox(box: { width: number; height: number }, source: { width: number; height: number } | null): Box {
  if (!source || !(source.width > 0) || !(source.height > 0)) return { x: 0, y: 0, width: box.width, height: box.height };
  const s = Math.min(box.width / source.width, box.height / source.height);
  const width = source.width * s;
  const height = source.height * s;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** The vignette's gain as an SVG image of the picture's size: radius half its diagonal, the `looks.ts` falloff. */
export function vignetteImage(v: number, width: number, height: number): string {
  const [w, h] = [r4(width), r4(height)];
  const stops = vignetteStops(v, VIGNETTE_STOPS).map(({ offset, gain }) => {
    const g = pct(gain);
    return `<stop offset='${r4(offset)}' stop-color='rgb(${g},${g},${g})'/>`;
  });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' preserveAspectRatio='none'>`
    + `<radialGradient id='v' gradientUnits='userSpaceOnUse' cx='${r4(w / 2)}' cy='${r4(h / 2)}' r='${r4(Math.hypot(w, h) / 2)}'>${stops.join("")}</radialGradient>`
    + `<rect width='${w}' height='${h}' fill='url(#v)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The preview filter for a segment's look and adjust inside an element of `box` CSS px showing a source of `source`
 * px. Blur scales with the picture's displayed width (the render blurs at render width, plan parity method). `null`
 * when the grade changes nothing.
 */
export function previewGrade(s: Pick<PreviewSegment, "look" | "adjust">, box: { width: number; height: number }, source: { width: number; height: number } | null): PreviewGrade | null {
  if (!s.look && !s.adjust) return null;
  const region = containBox(box, source);
  const primitives = [...(s.look ? toSvgPrimitives(s.look) : []), ...(s.adjust ? toSvgPrimitives(s.adjust, { displayWidth: region.width }) : [])];
  const v = s.adjust?.vignette ?? 0;
  const vignette = v > 0 && region.width > 0 && region.height > 0 ? { href: vignetteImage(v, region.width, region.height), k: VIGNETTE_K } : null;
  return primitives.length || vignette ? { region, primitives, vignette } : null;
}

/** A text clip at t with its x/y/opacity keyframes applied (text scale and rotate are not rendered, plan Q14). */
export function keyedText(clip: TextClip, t: number, opacity: number): { clip: TextClip; opacity: number } {
  const k = clip.keyframes;
  if (!k) return { clip, opacity };
  const lt = t - clip.start;
  const transform = { ...clip.transform, x: valueAt(k.x, lt, clip.transform.x), y: valueAt(k.y, lt, clip.transform.y) };
  return { clip: { ...clip, transform }, opacity: clamp01(opacity * valueAt(k.opacity, lt, 1)) };
}

/** The Player's two `<video>` slots: which clip each holds, and which one shows. */
export interface PreviewSlots {
  slots: [string | null, string | null];
  active: 0 | 1;
}

/**
 * Next slot assignment. The current clip stays in (or moves to) the slot that already holds it, so a preloaded clip is
 * shown without a reload; the next clip goes into the other slot. In a gap, the next clip preloads in the idle slot.
 * Inside a transition the Player passes the outgoing clip as `next`, so it keeps its slot. Idempotent.
 */
export function assignSlots(prev: PreviewSlots, current: PreviewSegment | null, next: PreviewSegment | null): PreviewSlots {
  const slots: [string | null, string | null] = [prev.slots[0], prev.slots[1]];
  let active = prev.active;
  if (current) {
    const held = slots.indexOf(current.clipId);
    if (held >= 0) active = held as 0 | 1;
    else {
      // Do not overwrite a slot that already holds the next clip.
      active = next && slots[0] === next.clipId ? 1 : next && slots[1] === next.clipId ? 0 : active;
      slots[active] = current.clipId;
    }
    const idle = (1 - active) as 0 | 1;
    if (next && next.clipId !== current.clipId) slots[idle] = next.clipId;
  } else if (next && !slots.includes(next.clipId)) {
    slots[(1 - active) as 0 | 1] = next.clipId;
  }
  return { slots, active };
}

/** What shows at timeline time t. A clip's end belongs to whatever comes after it (the next clip, a gap or the end). */
export function frameAt(plan: PreviewPlan, t: number): PreviewFrame {
  const { segments } = plan;
  if (!segments.length || t >= plan.end - EPS) return { kind: "end", segment: null, sourceTime: 0, opacity: 0, volume: 0, next: null, layers: [], matte: null };
  // Segments are sorted by start; where two overlap (two video tracks, or a transition), the later start shows.
  let index = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.start > t + EPS) break;
    if (t < s.end - EPS) index = i;
  }
  if (index < 0) {
    const next = segments.find((s) => s.start > t + EPS) ?? null;
    return { kind: "gap", segment: null, sourceTime: 0, opacity: 0, volume: 0, next, layers: [], matte: null };
  }
  const segment = segments[index];
  // Sorted by start and the later start wins, so the next segment in the list is the next one to show.
  const next = segments[index + 1] ?? null;
  const from = segment.from ? segments.find((s) => s.clipId === segment.from && t < s.end - EPS) : undefined;
  let layers: PreviewLayer[];
  let matte: PreviewFrame["matte"] = null;
  if (from && segment.transition) {
    const p = clamp01((t - segment.start) / segment.transitionDuration);
    const mix = transitionMix(segment.transition, p);
    const outgoing = layerAt(from, t, mix.out, 1 - p);
    const incoming = layerAt(segment, t, mix.in, p);
    layers = mix.inOnTop ? [outgoing, incoming] : [incoming, outgoing];
    matte = mix.matte;
  } else {
    layers = [layerAt(segment, t, look(), 1)];
  }
  const top = layers.find((l) => l.segment === segment)!;
  return { kind: "clip", segment, sourceTime: top.sourceTime, opacity: top.alpha, volume: top.volume, next, layers, matte };
}

/** The overlay-track layers showing at t, in paint order (lowest track first). Each carries its keyframed placement. */
export function overlaysAt(plan: PreviewPlan, t: number): PreviewLayer[] {
  return plan.overlays.filter((s) => s.start <= t + EPS && t < s.end - EPS).map((s) => layerAt(s, t, look(), 1));
}

/** The CSS `mix-blend-mode` of an overlay segment (`addition` is `plus-lighter`), or null for a normal blend. */
export const blendCss = (s: Pick<PreviewSegment, "blendMode">): string | null => (s.blendMode ? BLEND_CSS[s.blendMode] : null);

/** An overlay's frame as CSS, in the element's px: the picture box, its corner radius, and the border drawn inside the edge. */
export interface PreviewFrameBox {
  region: Box;
  radius: number;
  borderWidth: number;
  borderColor: string;
}

/**
 * The frame of an overlay segment on its picture (`region`, the `object-fit: contain` box in an element of `box` CSS px).
 * Same geometry as the render's `frameStill`: radius is `cornerRadius` % of the picture's short side; the border is
 * `borderWidth` render px wide inside the outline. The render draws a static-scale frame at its final size, so its border
 * keeps its width whatever the scale; with scale keys the frame scales with the clip. The layer's transform scales the CSS
 * box, so a static scale divides out of the border width here, and `box.width / project.width` turns render px into CSS px.
 * `null` when the segment has no visible frame.
 */
export function layerFrame(s: Pick<PreviewSegment, "frame" | "keyframes">, scale: number, region: Box, box: { width: number }, project: { width: number }): PreviewFrameBox | null {
  const f = s.frame;
  if (!f || (f.cornerRadius <= 0 && f.borderWidth <= 0)) return null;
  const px = box.width / project.width;
  const keyed = !!s.keyframes.scale;
  return {
    region,
    radius: r4(cornerRadiusPx(f, region.width, region.height)),
    borderWidth: r4((f.borderWidth * px) / (keyed ? 1 : Math.max(scale, 0.01))),
    borderColor: f.borderColor,
  };
}
