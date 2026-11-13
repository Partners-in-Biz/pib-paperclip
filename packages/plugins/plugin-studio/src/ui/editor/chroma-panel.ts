/**
 * Chroma key and frame controls, pure logic (PAR-10169, slice 3 D3e2): op builders for the KeyFramePanel and the
 * eyedropper's pixel sampling. Each builder returns the ops and the ops that undo them (a `LayerEdit`, as the layer panel).
 * `setProps` merges a partial `chromaKey` only into an existing one, so a first key is written whole; the frame is always
 * written whole. `null` removes either. The server clamps every number again (`normalizeEdit`); the clamps here keep
 * the inputs honest.
 */
import { LIMITS, type ChromaKey, type Frame, type MediaClip } from "../../video-edit/timeline.js";
import { containBox } from "./preview-plan.js";
import type { LayerEdit, Op } from "./layer-panel.js";

export const KEY_DEFAULTS: Readonly<Omit<ChromaKey, "color">> = { similarity: 0.1, blend: 0, spill: 0 };
/** A green screen: where the key starts when it is first switched on, before a colour is picked. */
export const DEFAULT_KEY_COLOR = "#00FF00";
export const KEY_FIELDS = [
  { field: "similarity", label: "Similarity", min: LIMITS.similarity[0], max: LIMITS.similarity[1], step: 0.01 },
  { field: "blend", label: "Blend", min: 0, max: 1, step: 0.01 },
  { field: "spill", label: "Spill", min: 0, max: 1, step: 0.01 },
] as const;
export const FRAME_FIELDS = [
  { field: "borderWidth", label: "Border", unit: "px", min: LIMITS.borderWidth[0], max: LIMITS.borderWidth[1], step: 1 },
  { field: "cornerRadius", label: "Radius", unit: "%", min: LIMITS.cornerRadius[0], max: LIMITS.cornerRadius[1], step: 1 },
] as const;

const set = (clipId: string, props: Record<string, unknown>): Op => ({ op: "setProps", clipId, props });
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (s: unknown): s is string => typeof s === "string" && HEX.test(s);
export const hexOf = (rgb: readonly [number, number, number]) => `#${rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** Switches the key on (green, the defaults) or off. Null when it is already that way. */
export function toggleKeyOps(clip: MediaClip, on: boolean): LayerEdit | null {
  if (on === Boolean(clip.chromaKey)) return null;
  return on
    ? { ops: [set(clip.id, { chromaKey: { color: DEFAULT_KEY_COLOR, ...KEY_DEFAULTS } })], undo: [set(clip.id, { chromaKey: null })] }
    : { ops: [set(clip.id, { chromaKey: null })], undo: [set(clip.id, { chromaKey: { ...clip.chromaKey! } })] };
}

/** Changes the key colour (a picked pixel) or one number; switches the key on if it is off. Null for a bad value or no change. */
export function setKeyOps(clip: MediaClip, patch: Partial<ChromaKey>): LayerEdit | null {
  const now = clip.chromaKey;
  const next: ChromaKey = { color: now?.color ?? DEFAULT_KEY_COLOR, ...(now ?? KEY_DEFAULTS) } as ChromaKey;
  for (const [k, v] of Object.entries(patch) as [keyof ChromaKey, unknown][]) {
    if (k === "color") { if (!isHex(v)) return null; next.color = v.toUpperCase(); continue; }
    const f = KEY_FIELDS.find((x) => x.field === k);
    if (!f || typeof v !== "number" || !Number.isFinite(v)) return null;
    next[k] = Math.round(clamp(v, f.min, f.max) * 100) / 100;
  }
  if (now && now.color === next.color && now.similarity === next.similarity && now.blend === next.blend && now.spill === next.spill) return null;
  return { ops: [set(clip.id, { chromaKey: next })], undo: [set(clip.id, { chromaKey: now ? { ...now } : null })] };
}

/** Changes the frame's border width, border colour or corner radius. A frame with neither border nor radius is the same as none. */
export function setFrameOps(clip: MediaClip, patch: Partial<Frame>): LayerEdit | null {
  const now = clip.frame;
  const next: Frame = { borderWidth: 0, borderColor: "#FFFFFF", cornerRadius: 0, ...(now ?? {}) };
  for (const [k, v] of Object.entries(patch) as [keyof Frame, unknown][]) {
    if (k === "borderColor") { if (!isHex(v)) return null; next.borderColor = v.toUpperCase(); continue; }
    const f = FRAME_FIELDS.find((x) => x.field === k);
    if (!f || typeof v !== "number" || !Number.isFinite(v)) return null;
    next[k] = Math.round(clamp(v, f.min, f.max));
  }
  if (now && now.borderWidth === next.borderWidth && now.borderColor === next.borderColor && now.cornerRadius === next.cornerRadius) return null;
  if (!now && !next.borderWidth && !next.cornerRadius) return null;
  return { ops: [set(clip.id, { frame: next })], undo: [set(clip.id, { frame: now ? { ...now } : null })] };
}

/**
 * Where a click lands in a video's own pixels: the video is drawn `object-fit: contain` in `rect` (its on-screen box),
 * so the letterbox is skipped. Null outside the picture.
 */
export function pickPoint(rect: { left: number; top: number; width: number; height: number }, source: { width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0) || !(source.width > 0) || !(source.height > 0)) return null;
  const pic = containBox({ width: rect.width, height: rect.height }, source);
  const u = (clientX - rect.left - pic.x) / pic.width;
  const v = (clientY - rect.top - pic.y) / pic.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { x: Math.min(source.width - 1, Math.floor(u * source.width)), y: Math.min(source.height - 1, Math.floor(v * source.height)) };
}

/** Mean RGB of RGBA bytes (a 3x3 patch, so one noisy pixel does not set the key). Fully transparent pixels count for nothing. */
export function meanRgb(rgba: ArrayLike<number>): [number, number, number] | null {
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! === 0) continue;
    n++;
    for (let c = 0; c < 3; c++) sum[c]! += rgba[i + c]!;
  }
  return n ? [sum[0]! / n, sum[1]! / n, sum[2]! / n] : null;
}
