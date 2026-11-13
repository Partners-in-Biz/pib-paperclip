/**
 * Layer look of an overlay clip (PAR-8279 slice 3, D3b): blend mode and frame. Pure, no node imports: the render
 * compiles `blendLutExpr` and `frameStill`, the editor preview uses CSS `mix-blend-mode` (`BLEND_CSS`, the W3C
 * Compositing formula in `blendChannel`) and `frameCoverage` / `cornerRadiusPx` for `border-radius` and the border.
 * Blend works per RGB channel on sRGB-encoded values (no gamma), base = backdrop Cb, layer = source Cs.
 *
 * Why `lut2` and not ffmpeg's `blend=all_mode`: measured on ffmpeg 6.1.1 with flat colours, `blend` matches the W3C
 * formula within 2/255 for seven modes (with the base as its top input; `overlay` conditions on top), but its
 * `softlight` is a different curve (up to 25/255 off). `lut2` evaluates our formula once per (base, layer) code pair
 * into a 256x256 table, so every mode is the formula and costs one table lookup per pixel.
 */
import type { BlendMode, Frame } from "./timeline.js";

export type LayerBlend = Exclude<BlendMode, "normal">;

/** The CSS `mix-blend-mode` for each mode (the browser implements `blendChannel`). */
export const BLEND_CSS: Readonly<Record<LayerBlend, string>> = {
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  addition: "plus-lighter",
  difference: "difference",
  softlight: "soft-light",
};

/** W3C soft-light's D(Cb). */
const softD = (cb: number) => (cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb));

/** One channel of the blended colour, `cb` the base and `cs` the layer, both 0..1 (W3C Compositing Level 1). */
export function blendChannel(mode: LayerBlend, cb: number, cs: number): number {
  switch (mode) {
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "overlay": return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "darken": return Math.min(cb, cs);
    case "lighten": return Math.max(cb, cs);
    case "addition": return Math.min(1, cb + cs);
    case "difference": return Math.abs(cb - cs);
    case "softlight": return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softD(cb) - cb);
  }
}

/**
 * `blendChannel` as an ffmpeg expression over 8-bit codes, `x` the base and `y` the layer (lut2's first and second
 * input), rounded and clamped to 0..255. Contains commas: quote it in the graph.
 */
export function blendLutExpr(mode: LayerBlend): string {
  const b = "(x/255)";
  const s = "(y/255)";
  const f: Record<LayerBlend, string> = {
    multiply: `${b}*${s}`,
    screen: `${b}+${s}-${b}*${s}`,
    overlay: `if(lte(${b},0.5),2*${b}*${s},1-2*(1-${b})*(1-${s}))`,
    darken: `min(${b},${s})`,
    lighten: `max(${b},${s})`,
    addition: `min(1,${b}+${s})`,
    difference: `abs(${b}-${s})`,
    softlight: `if(lte(${s},0.5),${b}-(1-2*${s})*${b}*(1-${b}),${b}+(2*${s}-1)*(if(lte(${b},0.25),((16*${b}-12)*${b}+4)*${b},sqrt(${b}))-${b}))`,
  };
  return `clip(round(255*(${f[mode]})),0,255)`;
}

/** Corner radius in px of a `w` x `h` picture: `cornerRadius` % of the short side (50 = a circle on a square). */
export const cornerRadiusPx = (f: Pick<Frame, "cornerRadius">, w: number, h: number): number => (f.cornerRadius / 100) * Math.min(w, h);

/** Signed distance of the point (px, from the top-left) to the edge of the rounded rectangle; negative inside. */
export function frameDistance(f: Pick<Frame, "cornerRadius">, w: number, h: number, x: number, y: number): number {
  const r = cornerRadiusPx(f, w, h);
  const dx = Math.abs(x - w / 2) - w / 2 + r;
  const dy = Math.abs(y - h / 2) - h / 2 + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

const coverage = (d: number) => Math.min(1, Math.max(0, 0.5 - d));

/**
 * Of the pixel centred at (x, y): `inside` 0..1 how much stays (the rounded mask, one px of anti-aliasing), `border`
 * 0..1 how much is border colour (the band `borderWidth` px wide inside the outline).
 */
export function frameCoverage(f: Frame, w: number, h: number, x: number, y: number): { inside: number; border: number } {
  const d = frameDistance(f, w, h, x, y);
  return { inside: coverage(d), border: f.borderWidth > 0 ? coverage(d) * Math.min(1, Math.max(0, d + f.borderWidth + 0.5)) : 0 };
}

/**
 * `frameCoverage` as `geq` expressions (W, H, X, Y; X/Y are pixel corners, so +0.5 is the centre), 0..255: `mask` the
 * rounded-corner alpha (null when square), `ring` the border alpha (null without a border), and the border colour.
 */
export function frameStill(f: Frame): { mask: string | null; ring: string | null; color: [number, number, number] } {
  const num = (n: number) => String(Math.round(n * 1000) / 1000);
  // Register 3: frameDistance at the pixel centre.
  const d = `st(0,${num(f.cornerRadius / 100)}*min(W,H));st(1,abs(X+0.5-W/2)-W/2+ld(0));st(2,abs(Y+0.5-H/2)-H/2+ld(0));st(3,hypot(max(ld(1),0),max(ld(2),0))+min(max(ld(1),ld(2)),0)-ld(0))`;
  const inside = "clip(0.5-ld(3),0,1)";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(f.borderColor.slice(i, i + 2), 16)) as [number, number, number];
  return {
    mask: f.cornerRadius > 0 ? `${d};255*${inside}` : null,
    ring: f.borderWidth > 0 ? `${d};255*${inside}*clip(ld(3)+${num(f.borderWidth)}+0.5,0,1)` : null,
    color: [r, g, b],
  };
}
