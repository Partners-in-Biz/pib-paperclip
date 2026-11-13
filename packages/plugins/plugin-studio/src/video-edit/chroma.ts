/**
 * Chroma key of an overlay clip (PAR-8279 slice 3, D3c). Pure, no node imports: the render compiles `chromaKeyFilter`
 * and `despillFilter`; the editor preview (D3d2, WebGL) evaluates `keyCoverage` and `despillRgb` on the same numbers.
 * The key runs on the clip's source picture, before look/adjust and shape, so the key colour is a source colour.
 *
 * Key = ffmpeg `chromakey` (vf_chromakey.c). Per pixel, the Cb/Cr distance of each of its 3x3 neighbours (luma
 * coordinates, so with 4:2:0 mostly the same chroma sample) to the key, d = sqrt((dU^2 + dV^2) / (2 * 255^2)), is
 * averaged; alpha = clip((d - similarity) / blend, 0, 1), or a hard step at `similarity` when blend <= 0.0001. Luma is
 * ignored, so a shadow on the screen keys out too. We pass the key in YUV (`yuv=1`), converted here with the matrix of
 * the frame it keys: BT.709 TV range (video, graded images) or BT.601 TV range (an ungraded image keeps ffmpeg's implicit
 * conversion, as without a key). `chromakey` replaces the alpha plane, so the compile multiplies an image's own alpha
 * back in. The preview keys true RGB with `keyMatrix` of the same clip.
 *
 * Despill = ffmpeg `despill` (vf_despill.c) on packed RGBA after the key: spillmap = max(0, S - (R*mix + O*(1-mix)))
 * with S the screen channel and O the third channel (mix 0.5, expand 0), and S -= spill * spillmap. So spill 1 limits
 * the screen channel to the mean of the other two, spill 0 leaves the picture alone. It knows green and blue screens
 * only: `spillScreen` picks the one the key colour is, and a key that is neither (red, grey) gets no despill.
 */
import type { ChromaKey } from "./timeline.js";

export type Rgb = [number, number, number];
export type SpillScreen = "green" | "blue";

export type YuvMatrix = "bt709" | "bt601";
/** Kr, Kb per matrix (also the preview shader's Cb/Cr rows, `ui/editor/chroma-gl.ts`). */
export const COEFFS: Readonly<Record<YuvMatrix, [number, number]>> = { bt709: [0.2126, 0.0722], bt601: [0.299, 0.114] };
const round3 = (n: number) => String(Math.round(n * 1000) / 1000);
const parseHex = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** 8-bit RGB to TV-range Y, Cb, Cr codes (rounded): the planes `chromakey` reads. */
export function rgbToYuv([r, g, b]: Rgb, matrix: YuvMatrix = "bt709"): Rgb {
  const [KR, KB] = COEFFS[matrix];
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const y = KR * R + (1 - KR - KB) * G + KB * B;
  return [16 + 219 * y, 128 + (224 * (B - y)) / (2 * (1 - KB)), 128 + (224 * (R - y)) / (2 * (1 - KR))].map((c) => Math.min(255, Math.max(0, Math.round(c)))) as Rgb;
}

/** The matrix the clip's frame is in when it is keyed: BT.601 only for an ungraded image (ffmpeg's implicit conversion). */
export const keyMatrix = (isImage: boolean, graded: boolean): YuvMatrix => (isImage && !graded ? "bt601" : "bt709");

/** The key colour's Y, Cb, Cr codes. */
export const keyYuv = (k: Pick<ChromaKey, "color">, matrix: YuvMatrix = "bt709"): Rgb => rgbToYuv(parseHex(k.color), matrix);

/** One Cb/Cr sample's distance to the key, 0..1 (vf_chromakey.c, before the 3x3 mean). */
export function keyDistance(k: Pick<ChromaKey, "color">, u: number, v: number, matrix: YuvMatrix = "bt709"): number {
  const [, ku, kv] = keyYuv(k, matrix);
  return Math.sqrt(((u - ku) ** 2 + (v - kv) ** 2) / (255 * 255 * 2));
}

/** Alpha 0..1 a pixel keeps, from the mean `keyDistance` of its 3x3 neighbourhood (ffmpeg truncates `* 255` to a code). */
export function keyCoverage(k: Pick<ChromaKey, "similarity" | "blend">, distance: number): number {
  if (k.blend > 0.0001) return Math.min(1, Math.max(0, (distance - k.similarity) / k.blend));
  return distance > k.similarity ? 1 : 0;
}

/** The screen `despill` cleans for this key colour: its largest channel when green or blue, else none. */
export function spillScreen(k: Pick<ChromaKey, "color">): SpillScreen | null {
  const [r, g, b] = parseHex(k.color);
  if (g > r && g >= b) return "green";
  if (b > r && b > g) return "blue";
  return null;
}

/** `despill` on one RGB pixel (0..1 floats; ffmpeg truncates `* 255` to a code). Identity without a screen or spill. */
export function despillRgb(k: Pick<ChromaKey, "color" | "spill">, [r, g, b]: Rgb): Rgb {
  const screen = spillScreen(k);
  if (!screen || k.spill <= 0) return [r, g, b];
  const mix = 0.5;
  if (screen === "green") return [r, Math.max(0, g - k.spill * Math.max(0, g - (r * mix + b * (1 - mix)))), b];
  return [r, g, Math.max(0, b - k.spill * Math.max(0, b - (r * mix + g * (1 - mix))))];
}

/** The `chromakey` filter (yuva input, TV range in `matrix`). All values are numbers we format; the colour is re-encoded. */
export function chromaKeyFilter(k: ChromaKey, matrix: YuvMatrix = "bt709"): string {
  const yuv = keyYuv(k, matrix).map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `chromakey=color=0x${yuv}:similarity=${round3(k.similarity)}:blend=${round3(k.blend)}:yuv=1`;
}

/** The `despill` filter (packed RGBA input), or null when `despillRgb` is the identity. */
export function despillFilter(k: ChromaKey): string | null {
  const screen = spillScreen(k);
  if (!screen || k.spill <= 0) return null;
  const s = round3(-k.spill);
  return screen === "green" ? `despill=type=green:mix=0.5:expand=0:red=0:green=${s}:blue=0` : `despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue=${s}`;
}
