/**
 * The one op builder that puts a sound asset on the audio track (PAR-8322, shared since PAR-8407 T3). Pure, no React:
 * the editor (AudioTrack.tsx) and the server voiceover action (voiceover.ts) both call it.
 */
import { freeId } from "../ui/editor/timeline-view.js";
import type { AudioClip, EditDoc } from "./timeline.js";

const MAX_SECONDS = 180;
const MIN_SECONDS = 0.1;
const ms = (n: number) => Math.round(n * 1000) / 1000;

export interface AudioPick { id: string; version: number; /** Length of the source in seconds. */ seconds: number }
type Ops = { ops: Record<string, unknown>[] };

export const audioLength = (c: AudioClip) => Math.max(0, (c.out - c.in) / (c.speed || 1));

/**
 * The batch that puts a Library asset's sound on the first audio track at `at` (creating the track when there is
 * none). The clip plays the whole source, cut to fit the edit's 180 s limit and before the next clip on the track.
 */
export function addAudioOps(doc: EditDoc | null, pick: AudioPick, at: number): (Ops & { clipId: string; start: number }) | { error: string } {
  if (!doc) return { error: "The edit isn't loaded yet." };
  const length = Math.floor(pick.seconds * 1000) / 1000;
  if (!(length > 0)) return { error: "Studio couldn't read how long this sound is." };
  const track = doc.tracks.find((t) => t.kind === "audio");
  const trackId = track ? track.id : freeId(doc, "audio");
  const clips = [...((track?.clips ?? []) as AudioClip[])].sort((a, b) => a.start - b.start);
  let start = ms(Math.max(0, at));
  for (const c of clips) if (c.start <= start && start < ms(c.start + audioLength(c))) start = ms(c.start + audioLength(c));
  const next = clips.find((c) => c.start >= start);
  const room = ms(Math.min(next ? next.start - start : Infinity, MAX_SECONDS - start));
  if (room < MIN_SECONDS) return { error: "There is no room for sound here. Move the playhead to a free spot on the audio track." };
  const clipId = freeId(doc, "aud");
  const clip = { id: clipId, assetId: pick.id, version: pick.version, in: 0, out: Math.min(length, room), start, volume: 1 };
  const ops: Record<string, unknown>[] = track ? [] : [{ op: "addTrack", track: { id: trackId, kind: "audio" } }];
  ops.push({ op: "addClip", trackId, clip });
  return { ops, clipId, start };
}
