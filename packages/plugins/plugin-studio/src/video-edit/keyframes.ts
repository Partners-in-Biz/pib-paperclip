/**
 * The one keyframe evaluator (PAR-8279 plan, "One evaluator"). Pure, no node imports: the editor preview imports it and
 * the ffmpeg compiler builds its expressions with it, so preview and render read the same curve.
 *
 * Keys are sorted by unique `t` (seconds from the clip's own `start`, plan Q9); the timeline validator guarantees that.
 * A key's `ease` shapes the segment from that key to the next one. Before the first key the value is the first key's;
 * from the last key on it is the last key's. `hold` keeps the key's value until the next key, then steps.
 * With no keys the value is `base`.
 */

/** Same shape as `Ease` / `Keyframe` in `timeline.ts` (schema v2); kept here so this module stays dependency-free. */
export type KeyframeEase = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";
export interface KeyframeLike { t: number; value: number; ease: KeyframeEase }

/** Digits after the point for every number we print into an ffmpeg expression. */
export const EXPR_DECIMALS = 6;

/** Eased progress for p in 0..1. The polynomials match `easeTerm` below one for one. */
export function ease(kind: KeyframeEase, p: number): number {
  switch (kind) {
    case "linear": return p;
    case "easeIn": return p * p;
    case "easeOut": return p * (2 - p);
    case "easeInOut": return p * p * (3 - 2 * p);
    case "hold": return 0;
  }
}

/** Value at clip-relative time `t`. */
export function valueAt(kfs: readonly KeyframeLike[] | undefined, t: number, base: number): number {
  if (!kfs || kfs.length === 0) return base;
  const first = kfs[0]!;
  if (t < first.t) return first.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t < b.t) return a.value + (b.value - a.value) * ease(a.ease, (t - a.t) / (b.t - a.t));
  }
  return kfs[kfs.length - 1]!.value;
}

/** A finite number printed with `EXPR_DECIMALS` fixed digits, trailing zeros cut, negatives in parentheses. */
export function exprNum(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`keyframes: non-finite number ${n}`);
  let s = n.toFixed(EXPR_DECIMALS);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.startsWith("-") ? `(${s})` : s;
}

function easeTerm(kind: KeyframeEase, p: string): string {
  switch (kind) {
    case "linear": return p;
    case "easeIn": return `${p}*${p}`;
    case "easeOut": return `${p}*(2-${p})`;
    case "easeInOut": return `${p}*${p}*(3-2*${p})`;
    case "hold": return "0";
  }
}

/**
 * The same curve as an ffmpeg expression in `timeVar` (`t` for volume/overlay/scale/rotate, `T` for geq), where the
 * clip's local time 0 sits at `offset` seconds on that filter's clock. Nested `if(lt(...))`, one level per key, so the
 * caller must put it in single quotes inside a filtergraph (it holds commas). Accurate to about 1e-6 per printed number.
 */
export function toFfmpegExpr(kfs: readonly KeyframeLike[] | undefined, base: number, offset = 0, timeVar = "t"): string {
  if (!/^[A-Za-z]+$/.test(timeVar)) throw new Error(`keyframes: bad time variable ${timeVar}`);
  if (!kfs || kfs.length === 0) return exprNum(base);
  if (kfs.length === 1) return exprNum(kfs[0]!.value);
  const last = kfs[kfs.length - 1]!;
  let expr = exprNum(last.value);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    let seg: string;
    if (a.ease === "hold" || a.value === b.value) {
      seg = exprNum(a.value);
    } else {
      const p = `((${timeVar}-${exprNum(a.t + offset)})/${exprNum(b.t - a.t)})`;
      seg = `${exprNum(a.value)}+${exprNum(b.value - a.value)}*${easeTerm(a.ease, p)}`;
    }
    expr = `if(lt(${timeVar},${exprNum(b.t + offset)}),${seg},${expr})`;
  }
  return `if(lt(${timeVar},${exprNum(kfs[0]!.t + offset)}),${exprNum(kfs[0]!.value)},${expr})`;
}
