/**
 * Beat markers and "Cut to beat" logic (PAR-10180), pure and React-free so it is unit tested; BeatPanel.tsx draws it.
 * The worker owns the beats and the cuts (`video-edit-detect-beats`, `video-edit-cut-to-beat`); this file only reads
 * their answers, lists the cuts for a preview, and builds the ops that put them back.
 */
import { applyOps } from "../../video-edit/ops.js";
import { clipDuration, type Clip, type EditDoc, type MediaClip } from "../../video-edit/timeline.js";

type Op = Record<string, unknown>;
export const EVERY_CHOICES = [1, 2, 4] as const;
/** More markers than this are not drawn (a 3-minute track at 180 bpm has 540). */
export const MAX_MARKERS = 400;
const ms = (n: number) => Math.round(n * 1000) / 1000;

export interface BeatsAnswer { tempo: number; timelineBeats: number[]; cached?: boolean; warning?: string }
export interface CutPreviewRow { clipId: string; from: number; to: number; cutAt: number }
export interface CutPlan { ops: Op[]; rows: CutPreviewRow[]; undo: Op[] }

/** The beats answer as the UI needs it, or null when the worker's answer is not one. */
export function beatsAnswer(raw: unknown): BeatsAnswer | null {
  const o = raw as { tempo?: unknown; timelineBeats?: unknown; cached?: unknown; warning?: unknown } | null;
  if (!o || typeof o.tempo !== "number" || !Array.isArray(o.timelineBeats)) return null;
  return { tempo: o.tempo, timelineBeats: o.timelineBeats.filter((b): b is number => typeof b === "number" && Number.isFinite(b)), cached: o.cached === true, ...(typeof o.warning === "string" && o.warning ? { warning: o.warning } : {}) };
}

/** Marker positions as a percentage of the clip's length, for the beats inside [start, start + duration]. */
export function markerPercents(beats: readonly number[], start: number, duration: number): number[] {
  if (!(duration > 0)) return [];
  const inside = beats.filter((b) => b >= start && b <= start + duration);
  const step = Math.max(1, Math.ceil(inside.length / MAX_MARKERS));
  return inside.filter((_, i) => i % step === 0).map((b) => ms(((b - start) / duration) * 100));
}

/** The tracks Cut to beat can cut: video and overlay tracks that hold a clip with a source. */
export function cuttableTracks(doc: EditDoc | null): { id: string; kind: string; clips: number }[] {
  return (doc?.tracks ?? []).filter((t) => (t.kind === "video" || t.kind === "overlay") && t.clips.length > 0).map((t) => ({ id: t.id, kind: t.kind, clips: t.clips.length }));
}

/** Ops that put `before` back after `ops` ran on it: each trim reverted (latest first, with ripple), keys and transition restored. */
export function cutUndoOps(before: EditDoc, ops: readonly Op[]): Op[] {
  const find = (doc: EditDoc, id: string) => doc.tracks.flatMap((t) => t.clips as Clip[]).find((c) => c.id === id) as MediaClip | undefined;
  const undo: Op[] = [];
  let work = before;
  const steps: Op[][] = [];
  for (const op of ops) {
    const was = find(work, String(op.clipId));
    if (!was) continue;
    work = applyOps(work, [op as never]);
    const now = find(work, String(op.clipId))!;
    const back: Op[] = [{ op: "trim", clipId: was.id, in: was.in, out: was.out, ripple: true }];
    const props: Op = {};
    if (JSON.stringify(now.keyframes ?? null) !== JSON.stringify(was.keyframes ?? null)) props.keyframes = was.keyframes ?? null;
    if (JSON.stringify(now.transitionIn ?? null) !== JSON.stringify(was.transitionIn ?? null)) props.transitionIn = was.transitionIn ?? null;
    if (Object.keys(props).length) back.push({ op: "setProps", clipId: was.id, props });
    steps.push(back);
  }
  for (const back of steps.reverse()) undo.push(...back);
  return undo;
}

/** The worker's cut ops (a dry run) as a list a person can read, plus the ops that undo them. Null when they don't apply to `doc`. */
export function cutPlan(doc: EditDoc, rawOps: unknown): CutPlan | null {
  if (!Array.isArray(rawOps)) return null;
  const ops = rawOps.filter((o): o is Op => !!o && typeof o === "object");
  try {
    const rows: CutPreviewRow[] = [];
    let work = doc;
    const clipOf = (d: EditDoc, id: string) => d.tracks.flatMap((t) => t.clips as Clip[]).find((c) => c.id === id) as MediaClip | undefined;
    for (const op of ops) {
      const was = clipOf(work, String(op.clipId));
      work = applyOps(work, [op as never]);
      const now = clipOf(work, String(op.clipId));
      if (was && now) rows.push({ clipId: was.id, from: ms(clipDuration(was)), to: ms(clipDuration(now)), cutAt: ms(now.start + clipDuration(now)) });
    }
    return { ops, rows, undo: cutUndoOps(doc, ops) };
  } catch {
    return null;
  }
}
