/**
 * Reframe path (PAR-10126 D5b2a): turns the runner's face `Track` (source pixels, source seconds) into the `scale` and
 * `x`/`y` keyframes of one video or overlay clip. Pure: no I/O, no ffmpeg, so it runs in CI.
 *
 * Geometry. At transform scale 1 the picture is fitted inside the frame (compile-video.ts `shape`), and `x`/`y` are the
 * offset of the picture's centre from the frame's centre in frame pixels. So the picture covers the frame at
 * `scale = max(W/w, H/h) / min(W/w, H/h)` and may then move by at most `(shown - frame) / 2` on each axis. Every key
 * is clamped to that range, so the picture always covers the frame. An axis with no spare picture gets no keys.
 *
 * Face choice: boxes are linked across samples by centre distance; the chain with the largest summed area (large and
 * persistent) wins. The path is smoothed over a 1 s window, then reduced to keys: a key is only written when the offset
 * has moved at least 3% of the frame width from the last key, and the dead-band widens until at most
 * `LIMITS.maxKeyframes` keys remain. Source time maps to clip time through `in` and `speed`.
 */
import type { Track } from "../ml/track.js";
import type { Keyframe, MediaClip } from "./timeline.js";
import { LIMITS } from "./timeline.js";

export const SMOOTH_SEC = 1;
export const DEADBAND = 0.03;
/** A face may vanish for this long (clip seconds) and still continue the same chain. */
const MAX_GAP_SEC = 1;

export interface ReframePath {
  scale: number;
  keyframes: { x?: Keyframe[]; y?: Keyframe[] };
}

interface Point { t: number; cx: number; cy: number }
interface Link { t: number; cx: number; cy: number; size: number; area: number }

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Chain the boxes sample by sample and return the chain with the largest total area, in clip time. */
function mainFace(samples: Array<{ t: number; boxes: Track["samples"][number]["boxes"] }>): Link[] {
  const chains: Link[][] = [];
  for (const s of samples) {
    const taken = new Set<number>();
    // Biggest boxes first, so a small face cannot steal a chain from a large one.
    const boxes = [...s.boxes].sort((a, b) => b.w * b.h - a.w * a.h);
    for (const b of boxes) {
      const link: Link = { t: s.t, cx: b.x + b.w / 2, cy: b.y + b.h / 2, size: Math.max(b.w, b.h), area: b.w * b.h };
      let best = -1;
      let bestDist = Infinity;
      chains.forEach((chain, i) => {
        if (taken.has(i)) return;
        const last = chain[chain.length - 1]!;
        if (s.t - last.t > MAX_GAP_SEC) return;
        const dist = Math.hypot(link.cx - last.cx, link.cy - last.cy);
        if (dist <= 1.5 * Math.max(link.size, last.size) && dist < bestDist) { best = i; bestDist = dist; }
      });
      if (best >= 0) { chains[best]!.push(link); taken.add(best); } else { chains.push([link]); taken.add(chains.length - 1); }
    }
  }
  let winner: Link[] = [];
  let top = 0;
  for (const chain of chains) {
    const total = chain.reduce((sum, l) => sum + l.area, 0);
    if (total > top) { top = total; winner = chain; }
  }
  return winner;
}

/** Moving average over `SMOOTH_SEC` centred on each point. */
function smooth(points: Link[]): Point[] {
  return points.map((p) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const q of points) {
      if (Math.abs(q.t - p.t) <= SMOOTH_SEC / 2 + 1e-9) { n++; sx += q.cx; sy += q.cy; }
    }
    return { t: p.t, cx: sx / n, cy: sy / n };
  });
}

/**
 * Keys at the points whose value moved `band` from the last key; the first point always gets one. Before a move the
 * resting value is pinned with a flat key at the last quiet sample, so the move is not stretched back over the rest.
 */
function reduce(times: number[], values: number[], band: number): Array<{ t: number; value: number }> {
  const keys: Array<{ t: number; value: number }> = [];
  for (let i = 0; i < times.length; i++) {
    const last = keys[keys.length - 1];
    if (!last) { keys.push({ t: times[i]!, value: values[i]! }); continue; }
    if (Math.abs(values[i]! - last.value) < band || times[i]! <= last.t) continue;
    if (i > 0 && times[i - 1]! > last.t) keys.push({ t: times[i - 1]!, value: last.value });
    keys.push({ t: times[i]!, value: values[i]! });
  }
  return keys;
}

/** Keeps `n` keys: both ends, then repeatedly the key that sits furthest from the line through its kept neighbours. */
function thin(keys: Array<{ t: number; value: number }>, n: number): Array<{ t: number; value: number }> {
  const kept = new Set([0, keys.length - 1]);
  while (kept.size < n) {
    const order = [...kept].sort((a, b) => a - b);
    let worst = -1;
    let worstErr = -1;
    for (let j = 0; j < order.length - 1; j++) {
      const a = keys[order[j]!]!;
      const b = keys[order[j + 1]!]!;
      for (let i = order[j]! + 1; i < order[j + 1]!; i++) {
        const k = keys[i]!;
        const err = Math.abs(k.value - (a.value + ((b.value - a.value) * (k.t - a.t)) / (b.t - a.t || 1)));
        if (err > worstErr) { worstErr = err; worst = i; }
      }
    }
    if (worst < 0) break;
    kept.add(worst);
  }
  return [...kept].sort((a, b) => a - b).map((i) => keys[i]!);
}

function toKeys(times: number[], values: number[], band: number, limit: number): Keyframe[] {
  let keys = reduce(times, values, band);
  if (keys.length > LIMITS.maxKeyframes) keys = thin(keys, LIMITS.maxKeyframes);
  const out: Keyframe[] = [];
  for (const k of keys) {
    const t = round(k.t, 3);
    if (out.length && t <= out[out.length - 1]!.t) continue;
    // Round toward zero so the picture still covers the frame.
    const v = clamp(Math.trunc(k.value * 100) / 100, -limit, limit);
    out.push({ t, value: v === 0 ? 0 : v, ease: "linear" });
  }
  return out;
}

/**
 * `track` is the runner's output for the clip's source range, `clip` supplies `in`/`out`/`speed`, `frame` is the project
 * size the clip is laid over. No usable face: scale only (a centred crop).
 */
export function reframePath(
  track: Track,
  clip: Pick<MediaClip, "in" | "out" | "speed">,
  frame: { width: number; height: number },
): ReframePath {
  const { width: w, height: h } = track;
  if (!(w > 0 && h > 0 && frame.width > 0 && frame.height > 0)) return { scale: 1, keyframes: {} };
  const wide = frame.width / w;
  const tall = frame.height / h;
  const fit = Math.min(wide, tall);
  const cover = Math.max(wide, tall);
  // Ceil so rounding never leaves a sliver of background.
  const scale = clamp(Math.ceil((cover / fit) * 1e4) / 1e4, LIMITS.scale[0], LIMITS.scale[1]);
  const shownW = w * fit * scale;
  const shownH = h * fit * scale;
  const k = fit * scale; // source px -> frame px
  const maxX = Math.max(0, Math.floor((shownW - frame.width) / 2 * 100) / 100);
  const maxY = Math.max(0, Math.floor((shownH - frame.height) / 2 * 100) / 100);

  const speed = clip.speed > 0 ? clip.speed : 1;
  const duration = (clip.out - clip.in) / speed;
  const inRange = track.samples
    .filter((s) => s.t >= clip.in - 1e-9 && s.t <= clip.out + 1e-9 && s.boxes.length > 0)
    .map((s) => ({ t: clamp((s.t - clip.in) / speed, 0, duration), boxes: s.boxes }))
    .sort((a, b) => a.t - b.t);
  const face = mainFace(inRange);
  if (face.length === 0 || (maxX === 0 && maxY === 0)) return { scale, keyframes: {} };

  const path = smooth(face);
  const times = path.map((p) => p.t);
  const band = DEADBAND * frame.width;
  const keyframes: ReframePath["keyframes"] = {};
  if (maxX > 0) {
    const xs = path.map((p) => clamp(-(p.cx - w / 2) * k, -maxX, maxX));
    keyframes.x = toKeys(times, xs, band, maxX);
  }
  if (maxY > 0) {
    const ys = path.map((p) => clamp(-(p.cy - h / 2) * k, -maxY, maxY));
    keyframes.y = toKeys(times, ys, band, maxY);
  }
  return { scale, keyframes };
}
