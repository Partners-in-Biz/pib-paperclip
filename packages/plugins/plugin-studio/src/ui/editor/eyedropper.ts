/**
 * Eyedropper (PAR-10169): the KeyFramePanel switches it on for one overlay clip, the Player catches the next click on the
 * preview and samples that clip's source `<video>` (the colour before any grade, which is the colour the render keys).
 * A tiny external store, so the panel and the player need no shared parent. Esc or a second click on the button cancels.
 */
import { hexOf, meanRgb, pickPoint } from "./chroma-panel.js";

export type PickResult = { color: string } | { error: string };
export interface EyedropperState { clipId: string | null }

let state: EyedropperState = { clipId: null };
let done: ((r: PickResult) => void) | null = null;
const fns = new Set<() => void>();
const emit = () => fns.forEach((f) => f());

export const eyedropper = {
  subscribe(fn: () => void) { fns.add(fn); return () => void fns.delete(fn); },
  getState: (): EyedropperState => state,
  start(clipId: string, onDone: (r: PickResult) => void) { done = onDone; state = { clipId }; emit(); },
  cancel() { done = null; if (state.clipId) { state = { clipId: null }; emit(); } },
  finish(result: PickResult) { const cb = done; done = null; state = { clipId: null }; emit(); cb?.(result); },
};

/** Samples a 3x3 patch of the video's current frame. Errors read as a sentence for the panel. */
export function sampleVideo(video: HTMLVideoElement, clientX: number, clientY: number, make: () => HTMLCanvasElement = () => document.createElement("canvas")): PickResult {
  const source = { width: video.videoWidth, height: video.videoHeight };
  if (!source.width || video.readyState < 2) return { error: "The clip has no picture to pick from yet." };
  const r = video.getBoundingClientRect();
  const at = pickPoint(r, source, clientX, clientY);
  if (!at) return { error: "Click on the clip's picture." };
  try {
    const canvas = make();
    canvas.width = 3;
    canvas.height = 3;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { error: "This browser cannot read the picture, so type the colour instead." };
    ctx.drawImage(video, Math.max(0, at.x - 1), Math.max(0, at.y - 1), 3, 3, 0, 0, 3, 3);
    const rgb = meanRgb(ctx.getImageData(0, 0, 3, 3).data);
    return rgb ? { color: hexOf(rgb) } : { error: "That spot is transparent." };
  } catch {
    // A cross-origin frame taints the canvas (no CORS answer for the preview link).
    return { error: "The preview can't be read here, so type the colour instead." };
  }
}
