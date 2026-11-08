/**
 * Audio track logic (PAR-8322), pure and React-free so it is unit tested. Music and voiceover come from a Library
 * video/audio asset (its sound only; no TTS). Every change is one `video-edit-apply-ops` batch the worker validates.
 * The track mute is a preview-only switch (the edit document has no track mute; a render always includes the clips,
 * so silence a clip for good with volume 0). Preview volume is capped at 1 because an `<audio>` element cannot go louder.
 */
import type { AudioClip, EditDoc } from "../../video-edit/timeline.js";
import { freeId } from "./timeline-view.js";

export const VOLUME_RANGE = [0, 2] as const;
const MAX_SECONDS = 180;
const MIN_SECONDS = 0.1;
const ms = (n: number) => Math.round(n * 1000) / 1000;
/** Seconds ahead of the playhead an audio clip gets its element and starts loading. */
export const AUDIO_LOOKAHEAD = 5;

export interface AudioPick { id: string; version: number; /** Length of the source in seconds. */ seconds: number }
export interface AudioForm { volume: string; fadeIn: string; fadeOut: string }
type Ops = { ops: Record<string, unknown>[] };

export const audioLength = (c: AudioClip) => Math.max(0, (c.out - c.in) / (c.speed || 1));

export function audioClips(doc: EditDoc | null): { trackId: string; clip: AudioClip }[] {
  const out: { trackId: string; clip: AudioClip }[] = [];
  for (const t of doc?.tracks ?? []) if (t.kind === "audio") for (const clip of t.clips) out.push({ trackId: t.id, clip });
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function findAudioClip(doc: EditDoc | null, clipId: string | null): { trackId: string; clip: AudioClip } | null {
  return (clipId && audioClips(doc).find((c) => c.clip.id === clipId)) || null;
}

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

export const formOf = (c: AudioClip): AudioForm => ({ volume: String(c.volume), fadeIn: String(c.fadeIn), fadeOut: String(c.fadeOut) });

/** The `setProps` batch for a changed form, null when nothing changed, `{ error }` for a bad value. */
export function audioEditOps(clip: AudioClip, form: AudioForm): (Ops & { error?: undefined }) | { error: string } | null {
  const num = (raw: string, label: string, lo: number, hi: number): number | string => {
    const n = raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    if (n < lo || n > hi) return `${label} must be from ${lo} to ${hi}.`;
    return ms(n);
  };
  const length = audioLength(clip);
  const volume = num(form.volume, "Volume", VOLUME_RANGE[0], VOLUME_RANGE[1]);
  const fadeIn = num(form.fadeIn, "Fade in", 0, length);
  const fadeOut = num(form.fadeOut, "Fade out", 0, length);
  for (const v of [volume, fadeIn, fadeOut]) if (typeof v === "string") return { error: v };
  if ((fadeIn as number) + (fadeOut as number) > length + 1e-6) return { error: `Fade in and fade out together can't be longer than the clip (${ms(length)} s).` };
  const props: Record<string, number> = {};
  if (volume !== clip.volume) props.volume = volume as number;
  if (fadeIn !== clip.fadeIn) props.fadeIn = fadeIn as number;
  if (fadeOut !== clip.fadeOut) props.fadeOut = fadeOut as number;
  return Object.keys(props).length ? { ops: [{ op: "setProps", clipId: clip.id, props }] } : null;
}

export interface AudioFrame { clip: AudioClip; /** Source second to play. */ sourceTime: number; /** 0..1 element volume (fades applied, clip volume above 1 capped). */ volume: number }

/** What an audio clip does at timeline time `t`: null outside it. Fades are linear ramps over the clip's own time. */
export function audioFrameAt(clip: AudioClip, t: number): AudioFrame | null {
  const length = audioLength(clip);
  if (length <= 0 || t < clip.start || t >= clip.start + length) return null;
  const local = t - clip.start;
  let gain = clip.volume;
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= local / clip.fadeIn;
  const left = length - local;
  if (clip.fadeOut > 0 && left < clip.fadeOut) gain *= left / clip.fadeOut;
  return { clip, sourceTime: clip.in + local * clip.speed, volume: Math.min(1, Math.max(0, gain)) };
}

/** Clips that need an `<audio>` element now: playing at `t` or starting within the lookahead. */
export function audioWindow(doc: EditDoc | null, t: number): { trackId: string; clip: AudioClip }[] {
  return audioClips(doc).filter(({ clip }) => t < clip.start + audioLength(clip) && clip.start - t <= AUDIO_LOOKAHEAD);
}

/** Preview-only track mute, shared by the audio panel and the player. */
const mutedTracks = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = "";
export const audioMute = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  getSnapshot: () => snapshot,
  isMuted: (trackId: string) => mutedTracks.has(trackId),
  toggle(trackId: string) {
    if (!mutedTracks.delete(trackId)) mutedTracks.add(trackId);
    snapshot = [...mutedTracks].sort().join(",");
    listeners.forEach((fn) => fn());
  },
  reset() {
    mutedTracks.clear();
    snapshot = "";
    listeners.forEach((fn) => fn());
  },
};
