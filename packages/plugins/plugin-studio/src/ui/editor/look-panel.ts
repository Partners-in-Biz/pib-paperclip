/**
 * Adjust & Look panel logic (PAR-10160): pure op builders for the LookPanel. Every change is one `setProps` batch
 * (adjust fields merge per field and a neutral value removes the field; `look` merges, `null` removes it), and every
 * builder returns the ops that undo it, taken from the clip as it is now.
 */
import { ADJUST_RANGE, NEUTRAL_ADJUST, PIB_BASIC_IDS, type Adjust, type LookRef } from "../../video-edit/looks.js";
import type { Clip, EditDoc, MediaClip, TrackKind } from "../../video-edit/timeline.js";

export type Op = Record<string, unknown>;
export interface LookEdit { ops: Op[]; undo: Op[] }
export type AdjustField = keyof Adjust;

/** Slider rows in the order the render applies them. */
export const ADJUST_ROWS: readonly { field: AdjustField; label: string; step: number }[] = [
  { field: "brightness", label: "Brightness", step: 0.01 },
  { field: "contrast", label: "Contrast", step: 0.01 },
  { field: "saturation", label: "Saturation", step: 0.01 },
  { field: "temperature", label: "Temperature (K)", step: 100 },
  { field: "blur", label: "Blur", step: 0.5 },
  { field: "vignette", label: "Vignette", step: 0.01 },
];
export const LOOK_IDS: readonly string[] = PIB_BASIC_IDS;
export const DEFAULT_INTENSITY = 1;

export const hasLookPanel = (kind: TrackKind): boolean => kind === "video" || kind === "overlay";
export const lookLabel = (id: string): string => id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
export const adjustValue = (clip: MediaClip, field: AdjustField): number => clip.adjust?.[field] ?? NEUTRAL_ADJUST[field];
export const isGraded = (clip: MediaClip): boolean => Boolean(clip.look) || Object.keys(clip.adjust ?? {}).length > 0;

const set = (clipId: string, props: Record<string, unknown>): Op => ({ op: "setProps", clipId, props });
const clamp = (field: AdjustField, v: number): number => Math.min(ADJUST_RANGE[field][1], Math.max(ADJUST_RANGE[field][0], v));

/** One slider moved. A value outside the range is clamped; a non-number gives no edit. */
export function setAdjustOps(clip: MediaClip, field: AdjustField, value: number): LookEdit | null {
  if (!Number.isFinite(value)) return null;
  const next = clamp(field, value);
  if (next === adjustValue(clip, field)) return null;
  return { ops: [set(clip.id, { adjust: { [field]: next } })], undo: [set(clip.id, { adjust: { [field]: adjustValue(clip, field) } })] };
}

/** Picks a look (full intensity when the clip had none, else it keeps its strength); the same look again removes it. */
export function setLookOps(clip: MediaClip, id: string): LookEdit | null {
  if (!LOOK_IDS.includes(id)) return null;
  const undo = set(clip.id, { look: clip.look ?? null });
  if (clip.look?.id === id) return { ops: [set(clip.id, { look: null })], undo: [undo] };
  const look: LookRef = { pack: "pib-basic", id, intensity: clip.look?.intensity ?? DEFAULT_INTENSITY };
  return { ops: [set(clip.id, { look })], undo: [undo] };
}

export function setIntensityOps(clip: MediaClip, intensity: number): LookEdit | null {
  if (!clip.look || !Number.isFinite(intensity)) return null;
  const next = Math.min(1, Math.max(0, intensity));
  if (next === clip.look.intensity) return null;
  return { ops: [set(clip.id, { look: { ...clip.look, intensity: next } })], undo: [set(clip.id, { look: clip.look })] };
}

/** Removes the clip's look and every adjust field. */
export function resetOps(clip: MediaClip): LookEdit | null {
  if (!isGraded(clip)) return null;
  const undo: Record<string, unknown> = {};
  if (clip.adjust) undo.adjust = { ...clip.adjust };
  if (clip.look) undo.look = clip.look;
  return { ops: [set(clip.id, { adjust: null, look: null })], undo: [set(clip.id, undo)] };
}

/** A clip's whole grade as a setProps that replaces what is there (absent fields go neutral, adjust merges per field). */
const gradeProps = (from: MediaClip): Record<string, unknown> => ({
  adjust: Object.fromEntries(ADJUST_ROWS.map(({ field }) => [field, adjustValue(from, field)])),
  look: from.look ?? null,
});

export const mediaClips = (doc: EditDoc | null): MediaClip[] =>
  (doc?.tracks ?? []).filter((t) => hasLookPanel(t.kind)).flatMap((t) => t.clips as Clip[]) as MediaClip[];

/** Copies the selected clip's look and adjust onto every other video and overlay clip: one batch, one undo. */
export function applyToAllOps(doc: EditDoc | null, source: MediaClip): LookEdit | null {
  const others = mediaClips(doc).filter((c) => c.id !== source.id && JSON.stringify(gradeProps(c)) !== JSON.stringify(gradeProps(source)));
  if (!others.length) return null;
  return { ops: others.map((c) => set(c.id, gradeProps(source))), undo: others.map((c) => set(c.id, gradeProps(c))) };
}
