/**
 * Looks and colour adjust (PAR-8279 slice 2, D2a1). Pure, no node imports: the ffmpeg compiler and the editor preview
 * both derive their filters from the data and formulas in this file, so render and preview read the same definition.
 *
 * Colours are RGB triples in 0..1 (sRGB-encoded values; no gamma handling, same as ffmpeg's filters).
 *
 * Facts measured against ffmpeg 6.1.1 (pib-vps build):
 * - `colortemperature` multiplies RGB by `kelvinRgb(T)` and does NOT normalise: 6500 K is not neutral (b = 0.98),
 *   6600 K is exactly (1,1,1). `NEUTRAL_ADJUST.temperature` is therefore 6600.
 * - `vignette=angle=A` multiplies by cos(A * d / dmax)^4, d = distance from the centre, dmax = half the diagonal.
 * - `eq` works on the code values of the decoded frame, which in production is yuv420p BT.709 TV range (Y 16..235).
 *   The compile step must therefore NOT convert to full range before `eq`. Per plane it is integer maths on values
 *   rounded to float (vf_eq.c `process_c`, `eqPlane`): luma gets contrast and brightness, each chroma plane gets
 *   saturation as its contrast with brightness 0. Brightness lands in whole steps of about 2.555 codes (0.12 adds 27,
 *   not 30.7) and saturation pulls chroma one code low (grey at saturation 1.6 gets Cb = Cr = 127). Matched code for
 *   code on 40 colour/setting pairs against ffmpeg 6.1.1 (PAR-10159). As an average over many pixels each plane is
 *   affine, so the SVG path is one colour matrix. Luma is clamped to the code range 0..255 before the chroma is added
 *   back; the SVG matrix clamps only at the end, so the two differ only for colours whose luma leaves that range.
 */

export type Rgb = readonly [number, number, number];
type Pt = readonly [number, number];
/** Row-major 3x3: [rr rg rb, gr gg gb, br bg bb]. */
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
interface LookDef { matrix?: Mat3; curves?: { r?: readonly Pt[]; g?: readonly Pt[]; b?: readonly Pt[] } }

export interface Adjust { brightness: number; contrast: number; saturation: number; temperature: number; blur: number; vignette: number }
export interface LookRef { pack: "pib-basic"; id: string; intensity: number }

export const NEUTRAL_ADJUST: Readonly<Adjust> = { brightness: 0, contrast: 1, saturation: 1, temperature: 6600, blur: 0, vignette: 0 };
/** Blur sigma in `Adjust.blur` is defined at this render width and scales with the actual width. */
export const BLUR_REF_WIDTH = 1080;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** vf_eq.c's integer gain and offset for one plane, from the parameters rounded to float as ffmpeg stores them. */
function eqInts(contrast: number, brightness: number): { ci: number; bi: number } {
  const ci = Math.trunc(Math.fround(contrast) * 256 * 16);
  return { ci, bi: Math.trunc((Math.trunc(100 * Math.fround(brightness) + 100) * 511) / 200) - 128 - Math.trunc(ci / 32) };
}
/** ffmpeg `eq` on one 8-bit code value: `((in * ci) >> 12) + bi`, clipped to 0..255. */
export function eqCode(contrast: number, brightness: number, code: number): number {
  const { ci, bi } = eqInts(contrast, brightness);
  return Math.min(255, Math.max(0, Math.floor((code * ci) / 4096) + bi));
}
/** `eqCode` as the average line `in * k + o` over many pixels: the floor costs (d - 1) / 2d of a code, d the denominator of ci / 4096. */
export function eqPlane(contrast: number, brightness: number): { k: number; o: number } {
  const { ci, bi } = eqInts(contrast, brightness);
  const d = 4096 / gcd(ci, 4096);
  return { k: ci / 4096, o: bi - (d - 1) / (2 * d) };
}

/** BT.709 colour difference back to RGB: what one unit of Cb and Cr (both moved alike) adds to each channel. */
const CHROMA_RGB: Rgb = [1.5748, -(0.2126 * 1.5748 + 0.0722 * 1.8556) / 0.7152, 1.8556];
/** `eq` in full-scale RGB terms: luma `y*ky + dy`, chroma scaled by `ks` about luma, and `dc` added to Cb and Cr. */
function eqRgb(a: Adjust): { ky: number; dy: number; ks: number; dc: number } {
  let [ky, dy, ks, dc] = [1, 0, 1, 0];
  if (a.brightness !== 0 || a.contrast !== 1) {
    const p = eqPlane(a.contrast, a.brightness);
    [ky, dy] = [p.k, (16 * p.k + p.o - 16) / 219];
  }
  if (a.saturation !== 1) {
    const p = eqPlane(a.saturation, 0);
    [ks, dc] = [p.k, (128 * p.k + p.o - 128) / 224];
  }
  return { ky, dy, ks, dc };
}

/** Saturation matrix about BT.709 luma (s = 1 is identity, 0 is mono). */
const sat = (s: number): Mat3 => [
  LUMA[0] * (1 - s) + s, LUMA[1] * (1 - s), LUMA[2] * (1 - s),
  LUMA[0] * (1 - s), LUMA[1] * (1 - s) + s, LUMA[2] * (1 - s),
  LUMA[0] * (1 - s), LUMA[1] * (1 - s), LUMA[2] * (1 - s) + s,
];
const diag = (r: number, g: number, b: number): Mat3 => [r, 0, 0, 0, g, 0, 0, 0, b];
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return o as unknown as Mat3;
};
const contrastCurve = (k: number): Pt[] => [[0, 0], [0.25, 0.25 - k], [0.75, 0.75 + k], [1, 1]];
const allCurves = (pts: Pt[]) => ({ r: pts, g: pts, b: pts });

/** The 12 `pib-basic` looks: a colour matrix then per-channel curves. Defined in code, no third-party LUT. */
export const PIB_BASIC: Readonly<Record<string, LookDef>> = {
  mono: { matrix: sat(0) },
  sepia: { matrix: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131] },
  warm: { matrix: diag(1.08, 1, 0.9) },
  cool: { matrix: diag(0.9, 1, 1.1) },
  "teal-orange": { matrix: mul(diag(1.1, 1, 0.9), sat(1.1)), curves: { r: [[0, 0.02], [0.5, 0.54], [1, 1]], b: [[0, 0.06], [0.5, 0.48], [1, 0.94]] } },
  vivid: { matrix: sat(1.45), curves: allCurves(contrastCurve(0.04)) },
  fade: { matrix: sat(0.85), curves: allCurves([[0, 0.09], [1, 0.95]]) },
  noir: { matrix: sat(0), curves: allCurves(contrastCurve(0.1)) },
  vintage: { matrix: mul(diag(1.05, 1, 0.88), sat(0.8)), curves: allCurves([[0, 0.07], [0.5, 0.5], [1, 0.93]]) },
  cinematic: { matrix: mul(diag(1.05, 1, 0.95), sat(0.9)), curves: { r: [[0, 0.03], [0.5, 0.52], [1, 0.98]], g: contrastCurve(0.05), b: [[0, 0.07], [0.5, 0.5], [1, 0.92]] } },
  bleach: { matrix: sat(0.45), curves: allCurves(contrastCurve(0.09)) },
  punch: { matrix: sat(1.25), curves: allCurves(contrastCurve(0.07)) },
};
export const PIB_BASIC_IDS: readonly string[] = Object.keys(PIB_BASIC);

// ---- curves (ffmpeg `curves` interpolates a natural cubic spline through the points, flat outside them) ----

/** y at x of the natural cubic spline through `pts` (x ascending), clamped to 0..1. */
export function splineAt(pts: readonly Pt[], x: number): number {
  const n = pts.length;
  if (n === 0) return x;
  if (x <= pts[0]![0]) return clamp01(pts[0]![1]);
  if (x >= pts[n - 1]![0]) return clamp01(pts[n - 1]![1]);
  const y2 = new Array<number>(n).fill(0);
  const u = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i - 1]!, c = pts[i]!, q = pts[i + 1]!;
    const sig = (c[0] - p[0]) / (q[0] - p[0]);
    const k = sig * y2[i - 1]! + 2;
    y2[i] = (sig - 1) / k;
    u[i] = (q[1] - c[1]) / (q[0] - c[0]) - (c[1] - p[1]) / (c[0] - p[0]);
    u[i] = (6 * u[i]! / (q[0] - p[0]) - sig * u[i - 1]!) / k;
  }
  for (let i = n - 2; i >= 0; i--) y2[i] = y2[i]! * y2[i + 1]! + u[i]!;
  let lo = 0;
  while (pts[lo + 1]![0] < x) lo++;
  const a = pts[lo]!, b = pts[lo + 1]!, h = b[0] - a[0];
  const A = (b[0] - x) / h, B = (x - a[0]) / h;
  return clamp01(A * a[1] + B * b[1] + ((A * A * A - A) * y2[lo]! + (B * B * B - B) * y2[lo + 1]!) * h * h / 6);
}

// ---- looks ----

function checkIntensity(i: number): number {
  if (!Number.isFinite(i) || i < 0 || i > 1) throw new Error(`looks: intensity must be 0..1, got ${i}`);
  return i;
}

/** The look's matrix and curves blended from identity by `intensity`. Throws on an unknown id or a bad intensity. */
export function resolveLook(look: Pick<LookRef, "id" | "intensity">): { matrix: Mat3; curves: { r: Pt[]; g: Pt[]; b: Pt[] } } {
  const def = Object.prototype.hasOwnProperty.call(PIB_BASIC, look.id) ? PIB_BASIC[look.id]! : undefined;
  if (!def) throw new Error(`looks: unknown pib-basic look "${look.id}"`);
  const t = checkIntensity(look.intensity);
  const m = (def.matrix ?? IDENTITY).map((v, i) => IDENTITY[i]! + (v - IDENTITY[i]!) * t) as unknown as Mat3;
  const curve = (pts?: readonly Pt[]): Pt[] => (pts ?? []).map(([x, y]) => [x, x + (y - x) * t] as Pt);
  const c = def.curves ?? {};
  return { matrix: m, curves: { r: curve(c.r), g: curve(c.g), b: curve(c.b) } };
}

const isIdentityMat = (m: Mat3): boolean => m.every((v, i) => Math.abs(v - IDENTITY[i]!) < 1e-9);
const isIdentityCurve = (pts: readonly Pt[]): boolean => pts.every(([x, y]) => Math.abs(x - y) < 1e-9);

/** Reference result of the ffmpeg chain (`colorchannelmixer` then `curves`) for one colour. */
export function applyLook(rgb: Rgb, look: Pick<LookRef, "id" | "intensity">): Rgb {
  const { matrix: m, curves: c } = resolveLook(look);
  const mixed = [0, 1, 2].map((i) => clamp01(m[i * 3]! * rgb[0] + m[i * 3 + 1]! * rgb[1] + m[i * 3 + 2]! * rgb[2]));
  return [splineAt(c.r, mixed[0]!), splineAt(c.g, mixed[1]!), splineAt(c.b, mixed[2]!)];
}

// ---- adjust ----

const kelvinRgb = (kelvin: number): Rgb => {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255)];
};
/** Per-channel gain of ffmpeg `colortemperature` at `kelvin` (1000..40000). */
export const temperatureGain = (kelvin: number): Rgb => kelvinRgb(kelvin);

/** Vignette gain at normalised distance r (0 centre, 1 corner) for amount v (0..1): the ffmpeg `vignette` falloff. */
export const vignetteAngle = (v: number): number => v * (Math.PI / 3);
export const vignetteGain = (v: number, r: number): number => Math.pow(Math.cos(vignetteAngle(v) * r), 4);
/** Gradient stops for a radial vignette whose radius is half the frame diagonal: offset 0..1 and the gain there. */
export function vignetteStops(v: number, n = 9): { offset: number; gain: number }[] {
  return Array.from({ length: n }, (_, i) => ({ offset: i / (n - 1), gain: vignetteGain(v, i / (n - 1)) }));
}

export const ADJUST_RANGE: Readonly<Record<keyof Adjust, readonly [number, number]>> = {
  brightness: [-1, 1], contrast: [0, 2], saturation: [0, 3], temperature: [1000, 40000], blur: [0, 50], vignette: [0, 1],
};

function fill(a?: Partial<Adjust>): Adjust {
  const o = { ...NEUTRAL_ADJUST, ...a };
  for (const [k, [lo, hi]] of Object.entries(ADJUST_RANGE)) {
    const v = o[k as keyof Adjust];
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`looks: adjust.${k} must be finite and within ${lo}..${hi}, got ${v}`);
  }
  return o;
}

/** Reference result of ffmpeg `eq` then `colortemperature` for one colour (blur and vignette are spatial, see above). */
export function applyAdjust(rgb: Rgb, adjust: Partial<Adjust>): Rgb {
  const a = fill(adjust);
  const y = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
  const e = eqRgb(a);
  const y2 = Math.min(239 / 219, Math.max(-16 / 219, y * e.ky + e.dy)); // the code range 0..255
  const g = temperatureGain(a.temperature);
  return [0, 1, 2].map((i) => clamp01(clamp01(y2 + (rgb[i]! - y) * e.ks + CHROMA_RGB[i]! * e.dc) * g[i]!)) as unknown as Rgb;
}

// ---- ffmpeg output ----

const num = (n: number): string => {
  let s = n.toFixed(4);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};
const clampArg = (n: number): number => Math.max(-2, Math.min(2, n));

/** Look filters in render order. `[]` when the look changes nothing (intensity 0). */
export function lookToFfmpeg(look: Pick<LookRef, "id" | "intensity">): string[] {
  const { matrix: m, curves: c } = resolveLook(look);
  const out: string[] = [];
  if (!isIdentityMat(m)) {
    const keys = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];
    out.push(`colorchannelmixer=${keys.map((k, i) => `${k}=${num(clampArg(m[i]!))}`).join(":")}`);
  }
  const ch = (["r", "g", "b"] as const).filter((k) => !isIdentityCurve(c[k]));
  if (ch.length) out.push(`curves=${ch.map((k) => `${k}='${c[k].map(([x, y]) => `${num(x)}/${num(y)}`).join(" ")}'`).join(":")}`);
  return out;
}

/** Blur sigma in pixels at `renderWidth`. */
export const blurSigma = (blur: number, renderWidth: number): number => (blur * renderWidth) / BLUR_REF_WIDTH;

/** Adjust filters in render order: eq, colortemperature, gblur, vignette. Neutral fields are left out. */
export function adjustToFfmpeg(adjust: Partial<Adjust>, opts: { renderWidth?: number } = {}): string[] {
  const a = fill(adjust);
  const out: string[] = [];
  const eq: string[] = [];
  if (a.brightness !== 0) eq.push(`brightness=${num(a.brightness)}`);
  if (a.contrast !== 1) eq.push(`contrast=${num(a.contrast)}`);
  if (a.saturation !== 1) eq.push(`saturation=${num(a.saturation)}`);
  if (eq.length) out.push(`eq=${eq.join(":")}`);
  if (a.temperature !== NEUTRAL_ADJUST.temperature) out.push(`colortemperature=temperature=${num(a.temperature)}`);
  if (a.blur > 0) out.push(`gblur=sigma=${num(blurSigma(a.blur, opts.renderWidth ?? BLUR_REF_WIDTH))}`);
  if (a.vignette > 0) out.push(`vignette=angle=${num(vignetteAngle(a.vignette))}`);
  return out;
}

/** Filters for a look or an adjust object, from the same data as `toSvgFilter`. */
export function toFfmpeg(x: LookRef | Partial<Adjust>, opts: { renderWidth?: number } = {}): string[] {
  return "id" in x ? lookToFfmpeg(x) : adjustToFfmpeg(x, opts);
}

// ---- SVG output ----

/** One SVG filter primitive as data; `toSvgFilter` prints it, `applyPrimitives` evaluates it (parity tests, D2d). */
export type SvgPrimitive =
  | { kind: "matrix"; values: number[] } // feColorMatrix 4x5 row-major (20 numbers)
  | { kind: "linear"; slope: Rgb; intercept: Rgb } // feComponentTransfer type=linear
  | { kind: "table"; tables: [number[], number[], number[]] } // feComponentTransfer type=table
  | { kind: "blur"; std: number };

const TABLE_N = 65;
const tableOf = (pts: readonly Pt[]): number[] => Array.from({ length: TABLE_N }, (_, i) => splineAt(pts, i / (TABLE_N - 1)));

export function toSvgPrimitives(x: LookRef | Partial<Adjust>, opts: { displayWidth?: number } = {}): SvgPrimitive[] {
  const out: SvgPrimitive[] = [];
  if ("id" in x) {
    const { matrix: m, curves: c } = resolveLook(x);
    if (!isIdentityMat(m)) {
      const v: number[] = [];
      for (let i = 0; i < 3; i++) v.push(m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!, 0, 0);
      out.push({ kind: "matrix", values: [...v, 0, 0, 0, 1, 0] });
    }
    if (!(["r", "g", "b"] as const).every((k) => isIdentityCurve(c[k]))) {
      out.push({ kind: "table", tables: [tableOf(c.r), tableOf(c.g), tableOf(c.b)] });
    }
    return out;
  }
  const a = fill(x);
  if (a.brightness !== 0 || a.contrast !== 1 || a.saturation !== 1) {
    // out_i = ks*in_i + (ky - ks)*Y + dy + e_i*dc (`eqRgb`): affine in RGB, so one matrix (brightness is additive, as eq).
    const e = eqRgb(a);
    const v: number[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) v.push((i === j ? e.ks : 0) + (e.ky - e.ks) * LUMA[j]!);
      v.push(0, e.dy + CHROMA_RGB[i]! * e.dc);
    }
    out.push({ kind: "matrix", values: [...v, 0, 0, 0, 1, 0] });
  }
  if (a.temperature !== NEUTRAL_ADJUST.temperature) out.push({ kind: "linear", slope: temperatureGain(a.temperature), intercept: [0, 0, 0] });
  if (a.blur > 0) out.push({ kind: "blur", std: blurSigma(a.blur, opts.displayWidth ?? BLUR_REF_WIDTH) });
  return out;
}

/** Evaluate primitives on one colour the way a browser does (clamping after each primitive). */
export function applyPrimitives(rgb: Rgb, prims: readonly SvgPrimitive[]): Rgb {
  let c: Rgb = rgb;
  for (const p of prims) {
    if (p.kind === "matrix") {
      const v = p.values;
      c = [0, 1, 2].map((i) => clamp01(v[i * 5]! * c[0] + v[i * 5 + 1]! * c[1] + v[i * 5 + 2]! * c[2] + v[i * 5 + 4]!)) as unknown as Rgb;
    } else if (p.kind === "linear") {
      c = [0, 1, 2].map((i) => clamp01(p.slope[i]! * c[i]! + p.intercept[i]!)) as unknown as Rgb;
    } else if (p.kind === "table") {
      c = [0, 1, 2].map((i) => {
        const t = p.tables[i]!, pos = c[i]! * (t.length - 1), k = Math.min(Math.floor(pos), t.length - 2);
        return clamp01(t[k]! + (t[k + 1]! - t[k]!) * (pos - k));
      }) as unknown as Rgb;
    }
  }
  return c;
}

/** An `<filter>` element for a look or adjust; blur is scaled to `displayWidth`. Vignette is a mask: use `vignetteStops`. */
export function toSvgFilter(x: LookRef | Partial<Adjust>, opts: { id: string; displayWidth?: number }): string {
  if (!/^[A-Za-z][\w-]*$/.test(opts.id)) throw new Error("looks: bad svg filter id");
  const list = (a: readonly number[]) => a.map(num).join(" ");
  const body = toSvgPrimitives(x, opts).map((p) => {
    switch (p.kind) {
      case "matrix": return `<feColorMatrix type="matrix" values="${list(p.values)}"/>`;
      case "linear": return `<feComponentTransfer>${(["R", "G", "B"] as const).map((ch, i) => `<feFunc${ch} type="linear" slope="${num(p.slope[i]!)}" intercept="${num(p.intercept[i]!)}"/>`).join("")}</feComponentTransfer>`;
      case "table": return `<feComponentTransfer>${(["R", "G", "B"] as const).map((ch, i) => `<feFunc${ch} type="table" tableValues="${list(p.tables[i]!)}"/>`).join("")}</feComponentTransfer>`;
      case "blur": return `<feGaussianBlur stdDeviation="${num(p.std)}"/>`;
    }
  });
  return `<filter id="${opts.id}" color-interpolation-filters="sRGB">${body.join("")}</filter>`;
}
