/**
 * Timeline geometry (PAR-8315): pixels <-> seconds, hit-testing a lane, the clip under the playhead and the ops batch a
 * trim drag sends. Pure and React-free so it is unit tested; Timeline.tsx draws with it. Only type imports from the
 * worker's timeline module, so nothing server-side lands in the UI bundle. Times are timeline seconds, rounded to ms.
 */
import type { Clip, EditDoc, Track, TrackKind } from "../../video-edit/timeline.js";

export type TrimEdge = "in" | "out";
export type HitPart = "body" | TrimEdge;
export interface Hit { clipId: string; part: HitPart }

/** Shortest clip a trim leaves, in timeline seconds. */
export const MIN_CLIP_SECONDS = 0.1;
export const MIN_PX_PER_SECOND = 8;
export const MAX_PX_PER_SECOND = 200;

export const ms = (n: number) => Math.round(n * 1000) / 1000;

export function secondsToPx(seconds: number, pxPerSecond: number): number {
  return seconds * pxPerSecond;
}
/** Pixels to seconds, rounded to ms. Not clamped: a drag delta can be negative. */
export function pxToSeconds(px: number, pxPerSecond: number): number {
  return pxPerSecond > 0 ? ms(px / pxPerSecond) : 0;
}

/** Zoom that fits `duration` seconds into `widthPx`, kept between the min and max; an empty edit shows 10 s. */
export function fitScale(duration: number, widthPx: number): number {
  const seconds = duration > 0 ? duration : 10;
  const pps = widthPx > 0 ? widthPx / seconds : MIN_PX_PER_SECOND;
  return Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, pps));
}

/** Same rule as the worker's `clipDuration`. */
export function clipLength(clip: Clip): number {
  if ("words" in clip) return clip.words.length ? clip.words[clip.words.length - 1].end : 0;
  if ("duration" in clip) return clip.duration;
  return ms((clip.out - clip.in) / clip.speed);
}
export const clipEnd = (clip: Clip) => ms(clip.start + clipLength(clip));

/** The end of the last clip on any track. */
export function docLength(doc: EditDoc | null): number {
  let end = 0;
  for (const track of doc?.tracks ?? []) for (const clip of track.clips as Clip[]) end = Math.max(end, clipEnd(clip));
  return end;
}

/** Only clips with a source (video, overlay, audio) can be trimmed; text and captions change through setProps. */
export function isTrimmable(clip: Clip): clip is Clip & { assetId: string; in: number; out: number; speed: number } {
  return "assetId" in clip;
}

/** What a clip is called on the timeline. */
export function clipLabel(clip: Clip): string {
  if ("words" in clip) return clip.words.map((w) => w.text).join(" ") || clip.id;
  if ("text" in clip) return clip.text || clip.id;
  return clip.id;
}

/**
 * The clip at `seconds` on one lane, and which part: within `edgePx` of a trimmable clip's start or end is a trim
 * edge (capped at a third of the clip so a short clip can still be selected), otherwise the body. Null on empty lane.
 */
export function hitTest(clips: readonly Clip[], seconds: number, pxPerSecond: number, edgePx = 8): Hit | null {
  for (const clip of clips) {
    const start = clip.start;
    const end = clipEnd(clip);
    if (seconds < start || seconds >= end) continue;
    if (!isTrimmable(clip) || pxPerSecond <= 0) return { clipId: clip.id, part: "body" };
    const edge = Math.min(edgePx / pxPerSecond, (end - start) / 3);
    if (seconds - start <= edge) return { clipId: clip.id, part: "in" };
    if (end - seconds <= edge) return { clipId: clip.id, part: "out" };
    return { clipId: clip.id, part: "body" };
  }
  return null;
}

/** The clip the viewer sees at `seconds`: the top-most track of `kinds` (last track is the top layer) wins. */
export function clipUnderPlayhead(doc: EditDoc | null, seconds: number, kinds: readonly TrackKind[] = ["video", "overlay"]): { track: Track; clip: Clip } | null {
  const tracks = doc?.tracks ?? [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i];
    if (!kinds.includes(track.kind)) continue;
    for (const clip of track.clips as Clip[]) if (seconds >= clip.start && seconds < clipEnd(clip)) return { track, clip };
  }
  return null;
}

export interface TrimResult { start: number; end: number; ops: Record<string, unknown>[] }

/**
 * Dragging a trimmable clip's edge by `deltaSeconds` of timeline: the clip box to preview and the one ops batch to send.
 * The `out` edge is a `trim` of `out`. The `in` edge keeps the clip's end still, so it is a `trim` of `in` plus a `move`
 * of `start`, ordered so no step overlaps a neighbour (shrink: trim then move; grow: move then trim). Null when the
 * clamped drag changes nothing or the clip can't be trimmed. Clamps: start >= 0, in >= 0, length >= MIN_CLIP_SECONDS.
 */
export function trimResult(clip: Clip, edge: TrimEdge, deltaSeconds: number): TrimResult | null {
  if (!isTrimmable(clip) || !Number.isFinite(deltaSeconds)) return null;
  const length = clipLength(clip);
  if (edge === "out") {
    const delta = Math.max(deltaSeconds, MIN_CLIP_SECONDS - length);
    const out = ms(clip.out + delta * clip.speed);
    if (out === clip.out || out <= clip.in) return null;
    return { start: clip.start, end: ms(clip.start + (out - clip.in) / clip.speed), ops: [{ op: "trim", clipId: clip.id, out }] };
  }
  const delta = Math.min(Math.max(deltaSeconds, -clip.start, -clip.in / clip.speed), length - MIN_CLIP_SECONDS);
  const start = ms(clip.start + delta);
  const inPoint = Math.max(0, ms(clip.in + delta * clip.speed));
  if (start === clip.start || inPoint === clip.in || inPoint >= clip.out) return null;
  const trim = { op: "trim", clipId: clip.id, in: inPoint };
  const move = { op: "move", clipId: clip.id, start };
  return { start, end: clipEnd(clip), ops: delta > 0 ? [trim, move] : [move, trim] };
}

/**
 * What "Split at playhead" cuts (PAR-8317): the selected clip when the playhead is inside it, else the top picture clip
 * under the playhead. Null when no clip is there or a part would be shorter than MIN_CLIP_SECONDS.
 */
export function splitTarget(doc: EditDoc | null, selectedClipId: string | null, playhead: number): { clipId: string; at: number } | null {
  const at = ms(playhead);
  let clip: Clip | null = null;
  if (selectedClipId) {
    for (const track of doc?.tracks ?? []) for (const c of track.clips as Clip[]) if (c.id === selectedClipId && at > c.start && at < clipEnd(c)) clip = c;
  }
  clip ??= clipUnderPlayhead(doc, at)?.clip ?? null;
  if (!clip || at - clip.start < MIN_CLIP_SECONDS || clipEnd(clip) - at < MIN_CLIP_SECONDS) return null;
  return { clipId: clip.id, at };
}

export interface ReorderResult { start: number; ops: Record<string, unknown>[] }

/**
 * Dragging a clip's body by `deltaSeconds` on its lane moves it to a new place in the track's order (PAR-8317). The
 * drop slot is where the dragged clip's centre lands among the other clips' centres. The clips it passes shift by its
 * length (gaps between them are kept) and it takes the freed slot, so the track's total length is unchanged.
 * The worker checks every op on its own, so one batch: `delete` the dragged clip (frees its space), `move` the passed
 * clips in an order where no step overlaps a neighbour, then `addClip` the same clip (same id and props) at its new
 * start. Null when the order is unchanged.
 */
export function reorderResult(trackId: string, clips: readonly Clip[], clipId: string, deltaSeconds: number): ReorderResult | null {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === clipId);
  if (i < 0 || !Number.isFinite(deltaSeconds)) return null;
  const dragged = sorted[i];
  const len = clipLength(dragged);
  const others = sorted.filter((c) => c.id !== clipId);
  const centre = dragged.start + deltaSeconds + len / 2;
  const k = others.filter((c) => c.start + clipLength(c) / 2 < centre).length;
  if (k === i) return null;
  const moves: Record<string, unknown>[] = [];
  let start: number;
  if (k < i) {
    // Moving earlier: others[k..i-1] shift right, last first, into the space the dragged clip left.
    start = others[k].start;
    for (let j = i - 1; j >= k; j--) moves.push({ op: "move", clipId: others[j].id, start: ms(others[j].start + len) });
  } else {
    // Moving later: others[i..k-1] shift left, first first.
    for (let j = i; j < k; j++) moves.push({ op: "move", clipId: others[j].id, start: ms(others[j].start - len) });
    start = ms(clipEnd(others[k - 1]) - len);
  }
  return { start, ops: [{ op: "delete", clipId }, ...moves, { op: "addClip", trackId, clip: { ...dragged, start } }] };
}

/** How long a still image added from the Library shows: the same as the worker's IMAGE_SECONDS (video-edit/actions.ts). */
export const IMAGE_SECONDS = 3;
/** The worker's LIMITS.maxDuration and LIMITS.maxClipsPerTrack (video-edit/timeline.ts), copied so no server code loads. */
export const MAX_EDIT_SECONDS = 180;
export const MAX_CLIPS_PER_TRACK = 200;

/** `<base>-1`, `<base>-2`, ...: the first id no track or clip uses. */
export function freeId(doc: EditDoc | null, base: string): string {
  const used = new Set<string>();
  for (const t of doc?.tracks ?? []) {
    used.add(t.id);
    for (const c of t.clips as Clip[]) used.add(c.id);
  }
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export interface LibraryPick { id: string; kind: string; version: number; /** Video length in seconds; ignored for images. */ seconds?: number }

/**
 * "Add clip" (join, PAR-8317): the ops batch that puts a Library video or image at the end of the first video track,
 * creating that track first when the edit has none. Images show IMAGE_SECONDS; a video is used whole, cut to fit the
 * edit's 180 s limit. Returns `{ error }` when it can't be added.
 */
export function addClipOps(doc: EditDoc | null, pick: LibraryPick): { ops: Record<string, unknown>[]; clipId: string; start: number } | { error: string } {
  if (pick.kind !== "image" && pick.kind !== "video") return { error: "Only videos and pictures can go on the video track." };
  const length = pick.kind === "image" ? IMAGE_SECONDS : Math.floor((pick.seconds ?? 0) * 1000) / 1000;
  if (!(length > 0)) return { error: "Studio couldn't read how long this video is." };
  const track = doc?.tracks.find((t) => t.kind === "video") ?? null;
  const ops: Record<string, unknown>[] = [];
  let trackId: string;
  let start = 0;
  if (track) {
    trackId = track.id;
    if (track.clips.length >= MAX_CLIPS_PER_TRACK) return { error: `A track holds at most ${MAX_CLIPS_PER_TRACK} clips.` };
    for (const c of track.clips as Clip[]) start = Math.max(start, clipEnd(c));
  } else {
    trackId = freeId(doc, "video");
    ops.push({ op: "addTrack", track: { id: trackId, kind: "video" }, index: 0 });
  }
  const room = ms(MAX_EDIT_SECONDS - start);
  if (room < MIN_CLIP_SECONDS) return { error: `The video track is full: an edit is at most ${MAX_EDIT_SECONDS} s.` };
  const clipId = freeId(doc, `clip-${clipCountOf(doc) + 1}`);
  ops.push({ op: "addClip", trackId, clip: { id: clipId, assetId: pick.id, version: pick.version, in: 0, out: Math.min(length, room), start } });
  return { ops, clipId, start };
}
const clipCountOf = (doc: EditDoc | null) => (doc?.tracks ?? []).reduce((n, t) => n + t.clips.length, 0);

/** Ruler step: the smallest of 1, 2, 5, 10, 15, 30, 60 s that puts ticks at least `minGapPx` apart. */
export function tickStep(pxPerSecond: number, minGapPx = 60): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60]) if (step * pxPerSecond >= minGapPx) return step;
  return 60;
}

/** 83.25 -> "1:23.2". */
export function formatTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths - m * 600) / 10;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}
