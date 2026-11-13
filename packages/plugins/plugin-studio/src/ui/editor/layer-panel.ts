/**
 * Layers panel logic (PAR-10168, slice 3): pure op builders for the LayerPanel and the Timeline's track up/down.
 * Picture-in-picture is only a transform preset (4 corners x S/M/L) written as one `setProps`; there is no PiP field.
 * The blend picker writes `blendMode` ("normal" removes it). Every builder also returns the ops that undo it.
 */
import { BLEND_MODES, type BlendMode, type EditDoc, type MediaClip } from "../../video-edit/timeline.js";

export type Op = Record<string, unknown>;
export interface LayerEdit { ops: Op[]; undo: Op[] }

export type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type PipSize = "S" | "M" | "L";
export const PIP_CORNERS: readonly { corner: PipCorner; label: string }[] = [
  { corner: "top-left", label: "Top left" }, { corner: "top-right", label: "Top right" },
  { corner: "bottom-left", label: "Bottom left" }, { corner: "bottom-right", label: "Bottom right" },
];
/** Scale 1 is "fit", so these are the share of the frame's width and height the clip fills. */
export const PIP_SCALE: Readonly<Record<PipSize, number>> = { S: 0.25, M: 0.33, L: 0.5 };
/** Gap to the frame edge, as a share of the frame's width and height. */
export const PIP_MARGIN = 0.04;

export const BLEND_LABELS: Readonly<Record<BlendMode, string>> = {
  normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten",
  addition: "Addition", difference: "Difference", softlight: "Soft light",
};
export { BLEND_MODES };

const set = (clipId: string, props: Record<string, unknown>): Op => ({ op: "setProps", clipId, props });
const same = (a: number, b: number) => Math.abs(a - b) < 0.5;

/** Offset of the clip centre from the frame centre (px) and fit scale for a corner and size. Assumes the clip is the frame's shape. */
export function pipTransform(project: { width: number; height: number }, corner: PipCorner, size: PipSize): { x: number; y: number; scale: number } {
  const scale = PIP_SCALE[size];
  const x = Math.round(project.width * ((1 - scale) / 2 - PIP_MARGIN));
  const y = Math.round(project.height * ((1 - scale) / 2 - PIP_MARGIN));
  return { x: corner.endsWith("left") ? -x : x, y: corner.startsWith("top") ? -y : y, scale };
}

/** The preset the clip is on now, or null when its transform is not one of the 12. */
export function currentPip(project: { width: number; height: number }, clip: MediaClip): { corner: PipCorner; size: PipSize } | null {
  for (const { corner } of PIP_CORNERS) {
    for (const size of Object.keys(PIP_SCALE) as PipSize[]) {
      const p = pipTransform(project, corner, size);
      if (same(clip.transform.x, p.x) && same(clip.transform.y, p.y) && Math.abs(clip.transform.scale - p.scale) < 0.005) return { corner, size };
    }
  }
  return null;
}

/** Puts an overlay clip in a corner at a size (rotate and crop stay). Null when it is already there. */
export function setPipOps(project: { width: number; height: number }, clip: MediaClip, corner: PipCorner, size: PipSize): LayerEdit | null {
  const p = pipTransform(project, corner, size);
  const now = currentPip(project, clip);
  if (now && now.corner === corner && now.size === size) return null;
  const { x, y, scale } = clip.transform;
  return { ops: [set(clip.id, { transform: p })], undo: [set(clip.id, { transform: { x, y, scale } })] };
}

/** Back to the full frame, centred. */
export function resetPipOps(clip: MediaClip): LayerEdit | null {
  const { x, y, scale } = clip.transform;
  if (x === 0 && y === 0 && scale === 1) return null;
  return { ops: [set(clip.id, { transform: { x: 0, y: 0, scale: 1 } })], undo: [set(clip.id, { transform: { x, y, scale } })] };
}

export const blendOf = (clip: MediaClip): BlendMode => clip.blendMode ?? "normal";

/** Picks a blend mode; the clip's own mode again, or an unknown one, gives no edit. */
export function setBlendOps(clip: MediaClip, mode: string): LayerEdit | null {
  if (!(BLEND_MODES as readonly string[]).includes(mode) || mode === blendOf(clip)) return null;
  return { ops: [set(clip.id, { blendMode: mode })], undo: [set(clip.id, { blendMode: blendOf(clip) })] };
}

/**
 * Moves a track one step in the list. The first track is the bottom layer and is drawn at the top of the Timeline, so
 * "up" is toward the bottom layer. Null at either end.
 */
export function moveTrackOps(doc: EditDoc | null, trackId: string, dir: "up" | "down"): LayerEdit | null {
  const tracks = doc?.tracks ?? [];
  const from = tracks.findIndex((t) => t.id === trackId);
  const to = dir === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= tracks.length) return null;
  return { ops: [{ op: "moveTrack", trackId, toIndex: to }], undo: [{ op: "moveTrack", trackId, toIndex: from }] };
}
