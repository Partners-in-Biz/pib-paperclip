/**
 * "Remove silences" dialog logic (PAR-10183), pure and React-free so it is unit tested; SilenceDialog.tsx draws it.
 * The worker owns the detection and the ops (`video-edit-cut-silences`); this file clamps the three settings the same
 * way the worker does, reads its dry-run answer, and finds the clips the tool can read sound from.
 */
import type { EditDoc } from "../../video-edit/timeline.js";

/** Same defaults and ranges as SILENCE_PARAMS in video-edit/silence.ts (a test keeps them equal; that file can't load in the browser). */
export const SILENCE_FIELDS = {
  threshold: { label: "Threshold (dB)", default: -30, min: -60, max: -10, step: 1, hint: "Sound quieter than this counts as silence." },
  minSilence: { label: "Shortest silence (s)", default: 0.5, min: 0.2, max: 5, step: 0.1, hint: "Silences shorter than this stay." },
  padding: { label: "Padding (s)", default: 0.1, max: 1, min: 0, step: 0.05, hint: "Silence kept next to the sound on each side." },
} as const;
export type SilenceField = keyof typeof SILENCE_FIELDS;
export type SilenceSettings = Record<SilenceField, number>;
export const DEFAULT_SETTINGS: SilenceSettings = { threshold: -30, minSilence: 0.5, padding: 0.1 };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The typed text as a number inside the field's range; null when it is not a number (the caller keeps the old value). */
export function clampField(field: SilenceField, raw: string | number): number | null {
  const n = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return null;
  const f = SILENCE_FIELDS[field];
  return round(Math.min(f.max, Math.max(f.min, n)));
}

export interface SilencePlan { ops: unknown[]; cuts: number; secondsSaved: number; duration: number | null }

/** The dry-run answer as the dialog needs it, or null when the worker's answer is not one. */
export function silencePlan(raw: unknown): SilencePlan | null {
  const o = raw as { ops?: unknown; duration?: unknown; silences?: { cuts?: unknown; secondsSaved?: unknown } } | null;
  const s = o?.silences;
  if (!o || !Array.isArray(o.ops) || !s || typeof s.cuts !== "number" || typeof s.secondsSaved !== "number") return null;
  return { ops: o.ops, cuts: s.cuts, secondsSaved: s.secondsSaved, duration: typeof o.duration === "number" ? o.duration : null };
}

/** The selected clip when the tool can read sound from it: a video, overlay or audio clip with a library asset (not a sticker, picture caption or text). */
export function silenceClip(doc: EditDoc | null, clipId: string | null): { id: string; kind: string } | null {
  if (!doc || !clipId) return null;
  for (const t of doc.tracks) {
    const c = (t.clips as unknown as Array<Record<string, unknown>>).find((x) => x.id === clipId);
    if (!c) continue;
    if (t.kind !== "video" && t.kind !== "overlay" && t.kind !== "audio") return null;
    if ("sticker" in c || typeof c.assetId !== "string" || !c.assetId) return null;
    return { id: clipId, kind: t.kind };
  }
  return null;
}

export const savedText = (p: Pick<SilencePlan, "cuts" | "secondsSaved">) =>
  `${p.cuts} silence${p.cuts === 1 ? "" : "s"} · ${round(p.secondsSaved)} s shorter`;
