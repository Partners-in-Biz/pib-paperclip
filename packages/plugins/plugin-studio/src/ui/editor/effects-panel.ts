/**
 * Effects panel logic (PAR-10179): pure op builders for the EffectsPanel. Each change is one `setProps { effects }`
 * batch (the list replaces the clip's; `null` removes it) and returns the ops that undo it, from the clip as it is now.
 */
import { EFFECTS, LIMITS, type Effect, type EffectId, type MediaClip, type TrackKind } from "../../video-edit/timeline.js";
import type { LookEdit } from "./look-panel.js";

export const EFFECT_LABELS: Record<EffectId, string> = { zoomPunch: "Zoom punch", shake: "Shake", flash: "Flash", rgbSplit: "RGB split", blurIn: "Blur in" };
export const EFFECT_IDS: readonly EffectId[] = EFFECTS;
export const DEFAULT_EFFECT_INTENSITY = 1;
export const hasEffectsPanel = (kind: TrackKind): boolean => kind === "video" || kind === "overlay";
export const effectsOf = (clip: MediaClip): Effect[] => clip.effects ?? [];
export const effectAt = (clip: MediaClip, id: EffectId): Effect | undefined => effectsOf(clip).find((e) => e.id === id);

const write = (clip: MediaClip, next: Effect[]): LookEdit => ({
  ops: [{ op: "setProps", clipId: clip.id, props: { effects: next.length ? next : null } }],
  undo: [{ op: "setProps", clipId: clip.id, props: { effects: clip.effects ?? null } }],
});

/** Turns an effect on (at full strength) or off. A fourth effect gives no edit: the panel shows the limit instead. */
export function toggleEffectOps(clip: MediaClip, id: EffectId): LookEdit | null {
  if (!EFFECT_IDS.includes(id)) return null;
  const list = effectsOf(clip);
  if (effectAt(clip, id)) return write(clip, list.filter((e) => e.id !== id));
  if (list.length >= LIMITS.maxEffects) return null;
  return write(clip, [...list, { id, intensity: DEFAULT_EFFECT_INTENSITY }]);
}

/** Moves one effect's strength. 0 removes it (the worker drops a 0 anyway); out of range is clamped. */
export function setEffectIntensityOps(clip: MediaClip, id: EffectId, value: number): LookEdit | null {
  const cur = effectAt(clip, id);
  if (!cur || !Number.isFinite(value)) return null;
  const next = Math.min(1, Math.max(0, value));
  if (next === cur.intensity) return null;
  const list = effectsOf(clip);
  return write(clip, next === 0 ? list.filter((e) => e.id !== id) : list.map((e) => (e.id === id ? { ...e, intensity: next } : e)));
}

export const clearEffectsOps = (clip: MediaClip): LookEdit | null => (effectsOf(clip).length ? write(clip, []) : null);
export const atEffectLimit = (clip: MediaClip): boolean => effectsOf(clip).length >= LIMITS.maxEffects;
