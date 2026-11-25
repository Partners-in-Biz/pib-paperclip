/**
 * The pixel effects of a clip (rgbSplit, blurIn, flash; `video-edit/effects.ts`) as an SVG filter spec for the preview
 * (PAR-10177). The numbers come from `effectFrame` (render px); here they are scaled to the filter's CSS px: by
 * `display` (CSS px per render px) and, for an overlay, divided by the clip's own scale, because the layer's CSS
 * transform runs after its filter and would scale them again (the render applies them after the shape, in render px).
 * Zoom and shake are not pixel effects: `clipTransform` carries them.
 */
import type { EffectFrame } from "../../video-edit/effects.js";

export interface EffectPixels {
  /** Red moves left and blue right by this many CSS px (0: none). */
  split: number;
  /** Gaussian sigma in CSS px (0: none). */
  blur: number;
  /** 0..1 mix towards white (0: none). */
  white: number;
}

/** `null` when the frame has no pixel effect on it (zoom and shake need no filter). */
export function effectPixels(fx: EffectFrame | null, display: number, clipScale = 1): EffectPixels | null {
  if (!fx) return null;
  const k = display / Math.max(clipScale, 0.01);
  const px: EffectPixels = { split: fx.split * k, blur: fx.blur * k, white: fx.white };
  return px.split > 0 || px.blur > 0 || px.white > 0 ? px : null;
}

/** The flash as a colour matrix: each channel c becomes c + w(1 - c), alpha kept (`effects.ts` `flashAt`). */
export const flashMatrix = (w: number): number[] => [
  1 - w, 0, 0, 0, w,
  0, 1 - w, 0, 0, w,
  0, 0, 1 - w, 0, w,
  0, 0, 0, 1, 0,
];
