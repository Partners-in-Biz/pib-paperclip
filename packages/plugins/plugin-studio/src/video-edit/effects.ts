/**
 * Clip effects (PAR-8279 slice 4, D4c). Pure, no node imports: the render compiles the ffmpeg pieces below and the
 * editor preview (D4f) evaluates the same formulas per frame (`effectFrame`), so render and preview read one definition.
 * tau = seconds from the clip's `start` on the timeline (speed does not change it), k = intensity in (0, 1]. Sizes are
 * in render pixels; the preview scales them by display width / render width.
 *
 * - zoomPunch: the picture scales about its centre by 1 + 0.25k(1 - tau/0.4)^2 (a punch in on the cut that eases back).
 * - shake: the picture moves by A sin(18 pi tau), A sin(14 pi tau), A = 0.02k x the frame's short side, the whole clip.
 *   A main-track clip is also scaled by 1 + 0.04k (`shakeCover`) so the moved frame never shows its edge.
 * - flash: each channel c (0..1) becomes c + w(1 - c), w = k(1 - tau/0.3); alpha is kept. The render mixes Y towards
 *   235 and Cb/Cr towards 128 (TV range), the same affine mix in YUV.
 * - rgbSplit: red moves left and blue right by round(0.012k x frame width) px, the whole clip. Uncovered edge columns
 *   repeat the last one (ffmpeg `rgbashift` edge=smear); alpha does not move.
 * - blurIn: Gaussian blur of sigma 0.03k x frame width x (1 - tau/0.6)^2, alpha included (CSS `blur()` does the same).
 * Picture order: an overlay is shaped, then rgbSplit, blurIn, flash, then its zoom (CSS: `filter`, then `transform`),
 * so its blur scales with the zoom; a main clip is shaped and zoomed onto the frame, then the pixel effects, then fades.
 */
import { exprNum } from "./keyframes.js";
import type { Effect, EffectId } from "./timeline.js";

export const ZOOM_PUNCH = { peak: 0.25, duration: 0.4 } as const;
export const SHAKE = { amplitude: 0.02, hzX: 9, hzY: 7 } as const;
export const FLASH = { duration: 0.3 } as const;
export const RGB_SPLIT = { shift: 0.012 } as const;
export const BLUR_IN = { sigma: 0.03, duration: 0.6 } as const;

export interface FrameSize { width: number; height: number }
/** One frame of a clip's effects: scale factor, offset in px, white mix 0..1, red/blue shift in px, blur sigma in px. */
export interface EffectFrame { scale: number; dx: number; dy: number; white: number; split: number; blur: number }

/** The intensity of `id` on the clip; 0 when absent. */
export const intensity = (effects: readonly Effect[] | undefined, id: EffectId): number => effects?.find((e) => e.id === id)?.intensity ?? 0;
const fall = (tau: number, duration: number) => Math.max(0, 1 - tau / duration);

export const zoomAt = (k: number, tau: number): number => 1 + ZOOM_PUNCH.peak * k * fall(tau, ZOOM_PUNCH.duration) ** 2;
export const shakeAmplitude = (k: number, size: FrameSize): number => SHAKE.amplitude * k * Math.min(size.width, size.height);
export const shakeCover = (k: number): number => 1 + 2 * SHAKE.amplitude * k;
export function shakeAt(k: number, tau: number, size: FrameSize): { dx: number; dy: number } {
  const a = shakeAmplitude(k, size);
  if (a === 0) return { dx: 0, dy: 0 };
  return { dx: a * Math.sin(Math.PI * 2 * SHAKE.hzX * tau), dy: a * Math.sin(Math.PI * 2 * SHAKE.hzY * tau) };
}
export const flashAt = (k: number, tau: number): number => k * fall(tau, FLASH.duration);
export const rgbSplitShift = (k: number, width: number): number => Math.round(RGB_SPLIT.shift * k * width);
export const blurInSigma = (k: number, tau: number, width: number): number => BLUR_IN.sigma * k * width * fall(tau, BLUR_IN.duration) ** 2;

/** Everything the preview needs at clip time `tau`; `mainTrack`: the clip is on the main video track (shake cover). */
export function effectFrame(effects: readonly Effect[] | undefined, tau: number, size: FrameSize, mainTrack: boolean): EffectFrame {
  const k = (id: EffectId) => intensity(effects, id);
  const shake = shakeAt(k("shake"), tau, size);
  return {
    scale: zoomAt(k("zoomPunch"), tau) * (mainTrack ? shakeCover(k("shake")) : 1),
    dx: shake.dx,
    dy: shake.dy,
    white: flashAt(k("flash"), tau),
    split: rgbSplitShift(k("rgbSplit"), size.width),
    blur: blurInSigma(k("blurIn"), tau, size.width),
  };
}

// ---- ffmpeg expressions of the same formulas; `offset` is the clip's local 0 on the filter clock ----
const local = (offset: number, v: string) => (offset ? `(${v}-${exprNum(offset)})` : v);

/** `zoomAt` in `t` (scale filter, eval=frame). */
export const zoomExpr = (k: number, offset: number): string =>
  `1+${exprNum(ZOOM_PUNCH.peak * k)}*pow(max(0,1-${local(offset, "t")}/${exprNum(ZOOM_PUNCH.duration)}),2)`;

/** `shakeAt` in `t` (overlay x/y, eval=frame); each term starts with its sign. */
export function shakeExpr(k: number, offset: number, size: FrameSize): { x: string; y: string } {
  const a = exprNum(shakeAmplitude(k, size));
  const tau = local(offset, "t");
  return { x: `+${a}*sin(PI*${2 * SHAKE.hzX}*${tau})`, y: `+${a}*sin(PI*${2 * SHAKE.hzY}*${tau})` };
}

/** `rgbSplitShift` as `rgbashift` (planar RGB in and out); null at 0 px. */
export const rgbSplitFilter = (k: number, width: number): string | null => {
  const d = rgbSplitShift(k, width);
  return d > 0 ? `rgbashift=rh=-${d}:bh=${d}` : null;
};

/**
 * `flashAt` as `geq` on TV-range YUV (`T` = frame time), on only while the flash lasts (`enable`, so the rest of the
 * clip passes untouched). +0.5 rounds (geq truncates). `alpha`: the frame is yuva420p and its alpha is copied.
 */
export function flashFilter(k: number, offset: number, alpha: boolean): string {
  const w = `${exprNum(k)}*max(0,1-${local(offset, "T")}/${exprNum(FLASH.duration)})`;
  const mix = (plane: string, white: number) => `'${plane}(X,Y)+${w}*(${white}-${plane}(X,Y))+0.5'`;
  const a = alpha ? `:a='alpha(X,Y)'` : "";
  return `geq=lum=${mix("lum", 235)}:cb=${mix("cb", 128)}:cr=${mix("cr", 128)}${a}:enable='between(t,${exprNum(offset)},${exprNum(offset + FLASH.duration)})'`;
}

/** `blurInSigma` for `sendcmd [expr]` over [offset, offset + duration): `TI` runs 0..1 there, so 1 - TI = 1 - tau/duration. */
export const blurInSigmaExpr = (k: number, width: number): string => `${exprNum(BLUR_IN.sigma * k * width)}*(1-TI)*(1-TI)`;
