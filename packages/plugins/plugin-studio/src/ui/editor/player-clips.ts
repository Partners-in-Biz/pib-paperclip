/** Pure clip lookups for the Player (PAR-8314), kept apart from React so they are unit tested. */
import type { EditDoc, MediaClip } from "../../video-edit/timeline.js";

export const clipLength = (c: Pick<MediaClip, "in" | "out" | "speed">) => Math.max(0, (c.out - c.in) / (c.speed || 1));

export function videoClips(doc: EditDoc | null): MediaClip[] {
  if (!doc) return [];
  return doc.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips as MediaClip[]).sort((a, b) => a.start - b.start);
}

export function timelineEnd(doc: EditDoc | null): number {
  return videoClips(doc).reduce((end, c) => Math.max(end, c.start + clipLength(c)), 0);
}

/** The clip showing at `playhead`, or null in a gap / past the end. */
export function clipAt(doc: EditDoc | null, playhead: number): MediaClip | null {
  return videoClips(doc).find((c) => playhead >= c.start && playhead < c.start + clipLength(c)) ?? null;
}

