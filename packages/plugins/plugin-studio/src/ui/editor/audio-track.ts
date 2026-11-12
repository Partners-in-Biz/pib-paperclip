/**
 * Audio track logic (PAR-8322), pure and React-free so it is unit tested. Music and voiceover come from a Library
 * video/audio asset (its sound only; no TTS). Every change is one `video-edit-apply-ops` batch the worker validates.
 * The track mute is a preview-only switch (the edit document has no track mute; a render always includes the clips,
 * so silence a clip for good with volume 0). Preview volume is capped at 1 because an `<audio>` element cannot go louder.
 */
import { audioLength } from "../../video-edit/audio-ops.js";
import type { AudioClip, EditDoc } from "../../video-edit/timeline.js";

// The op builder is shared with the server voiceover action (PAR-8407 T3).
export { addAudioOps, audioLength, type AudioPick } from "../../video-edit/audio-ops.js";

export const VOLUME_RANGE = [0, 2] as const;
const ms = (n: number) => Math.round(n * 1000) / 1000;
/** Seconds ahead of the playhead an audio clip gets its element and starts loading. */
export const AUDIO_LOOKAHEAD = 5;

export interface AudioForm { volume: string; fadeIn: string; fadeOut: string }
type Ops = { ops: Record<string, unknown>[] };

export function audioClips(doc: EditDoc | null): { trackId: string; clip: AudioClip }[] {
  const out: { trackId: string; clip: AudioClip }[] = [];
  for (const t of doc?.tracks ?? []) if (t.kind === "audio") for (const clip of t.clips) out.push({ trackId: t.id, clip });
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function findAudioClip(doc: EditDoc | null, clipId: string | null): { trackId: string; clip: AudioClip } | null {
  return (clipId && audioClips(doc).find((c) => c.clip.id === clipId)) || null;
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

/** Voiceover from a script (PAR-8418). Mirrors video-edit/tts.ts and tts-price.ts (a test keeps them equal); not imported, they pull server code. */
export const VOICEOVER_MAX_CHARS = 4000;
export const VOICEOVER_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export const VOICEOVER_CREDITS_PER_CHAR = 0.00024;

/** Credits for a script of `chars` characters, rounded to 4 places like the server (4,000 chars is 0.96). */
export const voiceoverCredits = (chars: number): number => Math.round(Math.max(0, chars) * VOICEOVER_CREDITS_PER_CHAR * 1e4) / 1e4;

/** The `video-edit-voiceover` arguments for the form, or the reason it can't be sent. The server trims the script, so the count does too. */
export function voiceoverParams(text: string, voice: string, at: number): { script: string; voice: string; at: number } | { error: string } {
  const script = text.trim();
  if (!script) return { error: "Type the words to speak." };
  if (script.length > VOICEOVER_MAX_CHARS) return { error: `A voiceover takes at most ${VOICEOVER_MAX_CHARS} characters; this is ${script.length}.` };
  return { script, voice: (VOICEOVER_VOICES as readonly string[]).includes(voice) ? voice : VOICEOVER_VOICES[0], at: Math.max(0, at) };
}

/** Music from a prompt (PAR-10257). Mirrors music/stable-audio-price.ts (a test keeps them equal); not imported, it pulls server code. */
export const MUSIC_MAX_PROMPT_CHARS = 2000;
export const MUSIC_MAX_SECONDS = 180;
export const MUSIC_DEFAULT_SECONDS = 30;
export const MUSIC_PRICE_LABEL = "USD 0.08 · 1.28 credits";

/** The `video-edit-music` arguments for the form, or the reason it can't be sent. The server trims the prompt, so the count does too. */
export function musicParams(prompt: string, duration: string | number, at: number): { prompt: string; duration: number; at: number } | { error: string } {
  const text = prompt.trim();
  if (!text) return { error: "Describe the music you want." };
  if (text.length > MUSIC_MAX_PROMPT_CHARS) return { error: `Music takes at most ${MUSIC_MAX_PROMPT_CHARS} characters; this is ${text.length}.` };
  const seconds = typeof duration === "string" ? (duration.trim() === "" ? NaN : Number(duration)) : duration;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > MUSIC_MAX_SECONDS) return { error: `Length must be from 1 to ${MUSIC_MAX_SECONDS} seconds.` };
  return { prompt: text, duration: seconds, at: Math.max(0, at) };
}

/** What the overview's `musicUsage` says, as the Studio page line. "unknown" never guesses a figure. */
export function musicUsageLine(usage: { status?: string; usedUsd?: number; capUsd?: number } | null | undefined): string {
  if (!usage || usage.status !== "ok" || typeof usage.usedUsd !== "number" || typeof usage.capUsd !== "number") return "Stable Audio this month: unknown";
  return `Stable Audio this month: USD ${usage.usedUsd.toFixed(2)} of ${usage.capUsd}`;
}
