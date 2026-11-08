/**
 * Live preview plan (PAR-8319): what the Player shows at timeline time t, without ffmpeg. Pure, so it is unit tested.
 * Each video clip becomes a segment on the timeline; `frameAt` says which segment shows at t, which source second of
 * its asset to show (speed applied), how opaque it is (fade in/out; a fade-in transition previews as a fade from
 * black) and how loud, plus the segment to preload next. Between clips (a gap) the preview is black.
 */
import type { EditDoc } from "../../video-edit/timeline.js";
import { clipLength, videoClips } from "./player-clips.js";

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
}

export interface PreviewPlan {
  segments: PreviewSegment[];
  /** End of the last segment: the length of the preview. */
  end: number;
}

export interface PreviewFrame {
  /** `clip`: a segment shows; `gap`: black before the next segment; `end`: at or past the end (or nothing to play). */
  kind: "clip" | "gap" | "end";
  segment: PreviewSegment | null;
  /** The source second to show (0 when no segment shows). */
  sourceTime: number;
  /** 0..1 picture opacity over black. */
  opacity: number;
  /** 0..1 element volume (clip volume above 1 is capped in the preview). */
  volume: number;
  /** The segment that plays after this point, to preload. */
  next: PreviewSegment | null;
}

/** Times this close count as equal (the edit rounds to milliseconds). */
const EPS = 1e-6;
/** Last showable source second: just before `out`, so a frame exists. */
const FRAME = 0.001;

export function buildPreviewPlan(doc: EditDoc | null): PreviewPlan {
  const segments: PreviewSegment[] = [];
  for (const c of videoClips(doc)) {
    const length = clipLength(c);
    if (length <= 0) continue;
    segments.push({
      clipId: c.id,
      assetId: c.assetId,
      start: c.start,
      end: c.start + length,
      in: c.in,
      out: c.out,
      speed: c.speed || 1,
      volume: c.volume ?? 1,
      fadeIn: Math.max(c.fadeIn || 0, c.transitionIn?.duration ?? 0),
      fadeOut: c.fadeOut || 0,
    });
  }
  return { segments, end: segments.reduce((end, s) => Math.max(end, s.end), 0) };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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

/** The Player's two `<video>` slots: which clip each holds, and which one shows. */
export interface PreviewSlots {
  slots: [string | null, string | null];
  active: 0 | 1;
}

/**
 * Next slot assignment. The current clip stays in (or moves to) the slot that already holds it, so a preloaded clip is
 * shown without a reload; the next clip goes into the other slot. In a gap, the next clip preloads in the idle slot.
 * Idempotent: the same input gives the same slots.
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
  if (!segments.length || t >= plan.end - EPS) return { kind: "end", segment: null, sourceTime: 0, opacity: 0, volume: 0, next: null };
  // Segments are sorted by start; where two overlap (two video tracks), the later start shows.
  let index = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.start > t + EPS) break;
    if (t < s.end - EPS) index = i;
  }
  if (index < 0) {
    const next = segments.find((s) => s.start > t + EPS) ?? null;
    return { kind: "gap", segment: null, sourceTime: 0, opacity: 0, volume: 0, next };
  }
  const segment = segments[index];
  const fade = fadeAt(segment, t);
  // Sorted by start and the later start wins, so the next segment in the list is the next one to show.
  const next = segments[index + 1] ?? null;
  return { kind: "clip", segment, sourceTime: sourceTimeAt(segment, t), opacity: fade, volume: clamp01(segment.volume * fade), next };
}
