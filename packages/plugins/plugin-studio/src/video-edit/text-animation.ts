/**
 * Text in/out animation presets (schema v5, PAR-8279 D4d1). Pure, no node imports: the render (compile-text.ts writes
 * each preset as ASS: `\move`, `\t(\fscx\fscy)`, `\t(\1a\3a)`, per-unit reveal tags) and the editor preview (D4d2)
 * both read the tables and functions here, so they draw the same motion.
 *
 * A preset is described for the entry side as a function of progress `p` (0 = clip start, 1 = the entry is done):
 * - `move`: the text starts `distance x min(width, height)` output pixels away along (dx, dy) and moves to its rest
 *   position linearly (ASS `\move` is linear, so the curve here is too);
 * - `scale` / `alpha`: piecewise-linear curves of [p, value] points, constant before the first and after the last;
 * - `reveal`: the text appears one character (grapheme) or one word at a time, in order.
 * The exit side plays the same curves backwards in time (`q` = time left / exit length), and a move keeps going the
 * same way: slideLeft enters from the right and leaves to the left.
 */
import type { TextAnimation, TextAnimationPreset } from "./timeline.js";

export type Curve = readonly (readonly [p: number, value: number])[];
export interface PresetShape {
  move?: { dx: -1 | 0 | 1; dy: -1 | 0 | 1; distance: number };
  scale?: Curve;
  alpha?: Curve;
  reveal?: "char" | "word";
}

const fadeIn: Curve = [[0, 0], [0.5, 1]];
export const PRESETS: Record<TextAnimationPreset, PresetShape> = {
  fadeUp: { move: { dx: 0, dy: 1, distance: 0.05 }, alpha: [[0, 0], [1, 1]] },
  slideLeft: { move: { dx: 1, dy: 0, distance: 0.2 }, alpha: fadeIn },
  slideRight: { move: { dx: -1, dy: 0, distance: 0.2 }, alpha: fadeIn },
  slideUp: { move: { dx: 0, dy: 1, distance: 0.2 }, alpha: fadeIn },
  slideDown: { move: { dx: 0, dy: -1, distance: 0.2 }, alpha: fadeIn },
  pop: { scale: [[0, 0], [0.6, 1.1], [1, 1]], alpha: [[0, 0], [0.3, 1]] },
  bounce: { scale: [[0, 0], [0.4, 1.2], [0.7, 0.9], [1, 1]], alpha: [[0, 0], [0.2, 1]] },
  typewriter: { reveal: "char" },
  wordByWord: { reveal: "word" },
};

/** Seconds rounded to the millisecond, the resolution of ASS `\t` / `\move` times. */
export const ms = (n: number) => Math.round(n * 1000) / 1000;

export function curveAt(curve: Curve, p: number): number {
  const first = curve[0]!;
  if (p <= first[0]) return first[1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [pa, a] = curve[i]!;
    const [pb, b] = curve[i + 1]!;
    if (p < pb) return a + ((b - a) * (p - pa)) / (pb - pa);
  }
  return curve[curve.length - 1]![1];
}

/** One side of a clip's animation: its preset and its time span [from, to] in clip-local seconds. */
export interface Phase { side: "in" | "out"; preset: TextAnimationPreset; from: number; to: number }

export function phases(animation: TextAnimation | undefined, duration: number): Phase[] {
  const out: Phase[] = [];
  if (animation?.in) out.push({ side: "in", preset: animation.in, from: 0, to: animation.inDuration ?? 0 });
  if (animation?.out) out.push({ side: "out", preset: animation.out, from: duration - (animation.outDuration ?? 0), to: duration });
  return out;
}

/** Progress towards rest at clip-local `t` inside `phase`: 0 at the far end (clip start / clip end), 1 at rest. */
export function restProgress(phase: Phase, t: number): number {
  const length = phase.to - phase.from;
  const p = phase.side === "in" ? (t - phase.from) / length : (phase.to - t) / length;
  return Math.min(1, Math.max(0, p));
}

/** Pixel offset from rest at progress `p`; the exit side mirrors it so the motion keeps its direction. */
export function moveOffset(phase: Phase, p: number, frame: { width: number; height: number }): { dx: number; dy: number } {
  const move = PRESETS[phase.preset].move;
  if (!move) return { dx: 0, dy: 0 };
  const d = (1 - p) * move.distance * Math.min(frame.width, frame.height) * (phase.side === "in" ? 1 : -1);
  return { dx: move.dx * d, dy: move.dy * d };
}

/** The pieces a reveal preset shows one by one; joined, `prefix + text` of every unit plus `tail` is the whole text. */
export interface RevealUnit { prefix: string; text: string }
export function revealUnits(text: string, kind: "char" | "word"): { units: RevealUnit[]; tail: string } {
  const units: RevealUnit[] = [];
  let pending = "";
  if (kind === "char") {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      if (segment === "\n") pending += segment;
      else {
        units.push({ prefix: pending, text: segment });
        pending = "";
      }
    }
    return { units, tail: pending };
  }
  let end = 0;
  for (const m of text.matchAll(/(\s*)(\S+)/g)) {
    units.push({ prefix: m[1]!, text: m[2]! });
    end = m.index! + m[0].length;
  }
  return { units, tail: text.slice(end) };
}

/**
 * Clip-local time at which reveal unit `i` of `n` changes: on entry unit i appears at `from + i/n x length` (the first
 * at once, the last a step before the end); on exit unit i disappears at `to - i/n x length` (the last first).
 */
export function revealTime(phase: Phase, i: number, n: number): number {
  const step = ((phase.to - phase.from) * i) / n;
  return ms(phase.side === "in" ? phase.from + step : phase.to - step);
}

/** How many of `n` reveal units show at clip-local `t` inside `phase` (always a leading run of units). */
export function revealCount(phase: Phase, t: number, n: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) {
    const at = revealTime(phase, i, n);
    if (phase.side === "in" ? t >= at : t < at) k = i + 1;
    else break;
  }
  return k;
}

export interface AnimatedText { duration: number; transform: { x: number; y: number }; animation?: TextAnimation }
export interface TextAnimationState {
  /** Centre of the text in output pixels. */
  x: number;
  y: number;
  /** Multiplier on the clip's size (fontSize x transform.scale). */
  scale: number;
  /** Multiplier on the clip's opacity (fades and keyframes are applied on top). */
  alpha: number;
  /** Reveal units shown (of `revealUnits(...).units.length`), or null when the whole text shows. */
  shown: number | null;
}

/** The animated state of a text clip at clip-local time `t`; `units` is the reveal unit count of its text. */
export function textAnimationAt(clip: AnimatedText, frame: { width: number; height: number }, t: number, units = 0): TextAnimationState {
  const state: TextAnimationState = { x: frame.width / 2 + clip.transform.x, y: frame.height / 2 + clip.transform.y, scale: 1, alpha: 1, shown: null };
  const phase = phases(clip.animation, clip.duration).find((ph) => t >= ph.from && t <= ph.to);
  if (!phase) return state;
  const shape = PRESETS[phase.preset];
  const p = restProgress(phase, t);
  const off = moveOffset(phase, p, frame);
  state.x += off.dx;
  state.y += off.dy;
  if (shape.scale) state.scale = curveAt(shape.scale, p);
  if (shape.alpha) state.alpha = curveAt(shape.alpha, p);
  if (shape.reveal) state.shown = revealCount(phase, t, units);
  return state;
}
