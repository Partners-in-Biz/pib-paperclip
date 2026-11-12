/** reframePath (PAR-10126 D5b2a): pure, runs in CI. Source 1920x1080 into a 1080x1920 frame unless stated. */
import { describe, expect, it } from "vitest";
import type { Box, Track } from "../src/ml/track.js";
import { valueAt } from "../src/video-edit/keyframes.js";
import { reframePath } from "../src/video-edit/reframe-path.js";
import { LIMITS } from "../src/video-edit/timeline.js";

const FRAME = { width: 1080, height: 1920 };
const CLIP = { in: 0, out: 10, speed: 1 };
const face = (cx: number, cy: number, size = 200): Box => ({ x: cx - size / 2, y: cy - size / 2, w: size, h: size, score: 0.9 });
const track = (boxesAt: (t: number) => Box[], to = 10, width = 1920, height = 1080, from = 0): Track => ({
  fps: 30,
  width,
  height,
  samples: Array.from({ length: Math.round((to - from) * 5) + 1 }, (_, i) => {
    const t = from + i / 5;
    return { t, boxes: boxesAt(t) };
  }),
});

/** Largest allowed |offset| on an axis for a covering picture. */
const limit = (w: number, h: number, frame: { width: number; height: number }, scale: number, axis: "x" | "y") => {
  const fit = Math.min(frame.width / w, frame.height / h);
  return axis === "x" ? (w * fit * scale - frame.width) / 2 : (h * fit * scale - frame.height) / 2;
};

describe("reframePath", () => {
  it("returns the covering scale only for an empty track", () => {
    expect(reframePath({ fps: 30, width: 1920, height: 1080, samples: [] }, CLIP, FRAME)).toEqual({ scale: 3.1605, keyframes: {} });
    expect(reframePath(track(() => []), CLIP, FRAME).keyframes).toEqual({});
  });

  it("a still face left of centre pans the picture right (positive x), once", () => {
    const r = reframePath(track(() => [face(480, 540)]), CLIP, FRAME);
    expect(r.keyframes.y).toBeUndefined();
    expect(r.keyframes.x).toHaveLength(1);
    // (480 - 960) source px * 0.5625 * 3.1605 = -853.2 -> picture moves +853.2
    expect(r.keyframes.x![0]!.value).toBeCloseTo(853.2, 0);
  });

  it("follows the larger face when two are visible", () => {
    const r = reframePath(track(() => [face(300, 540, 120), face(1500, 540, 260)]), CLIP, FRAME);
    expect(r.keyframes.x![0]!.value).toBeLessThan(0); // the face at x=1500 is right of centre
  });

  it("prefers a persistent face over a larger one that shows for a single sample", () => {
    const r = reframePath(track((t) => (t === 2 ? [face(1700, 540, 600), face(300, 540, 150)] : [face(300, 540, 150)])), CLIP, FRAME);
    expect(r.keyframes.x!.every((k) => k.value > 0)).toBe(true);
  });

  it("smooths a one-sample jump over 1 s", () => {
    const r = reframePath(track((t) => [face(t === 5 ? 1100 : 960, 540)]), CLIP, FRAME);
    // A raw jump of 140 source px is ~249 frame px; averaged over 6 samples it is ~41 px, under the 3% band (32.4) only barely.
    const peak = Math.max(...(r.keyframes.x ?? []).map((k) => Math.abs(k.value)));
    expect(peak).toBeLessThan(120);
  });

  it("ignores moves under 3% of the frame width", () => {
    // 10 source px = 17.8 frame px < 32.4
    const r = reframePath(track((t) => [face(960 + (t > 5 ? 10 : 0), 540)]), CLIP, FRAME);
    expect(r.keyframes.x).toHaveLength(1);
  });

  it("writes a key for a real move", () => {
    const r = reframePath(track((t) => [face(700 + 500 * Math.min(1, Math.max(0, (t - 4) / 2)), 540, 300)]), CLIP, FRAME);
    expect(r.keyframes.x!.length).toBeGreaterThan(1);
    expect(r.keyframes.x![0]!.value).toBeGreaterThan(0);
    expect(r.keyframes.x![r.keyframes.x!.length - 1]!.value).toBeLessThan(0);
  });

  it("writes at most 50 keys per property for a restless face, ends kept", () => {
    const r = reframePath(track((t) => [face(960 + 400 * Math.sin(t * 3), 540, 400)], 170), { in: 0, out: 170, speed: 1 }, FRAME);
    expect(r.keyframes.x!.length).toBeLessThanOrEqual(LIMITS.maxKeyframes);
    expect(r.keyframes.x!.length).toBeGreaterThan(10);
    const ts = r.keyframes.x!.map((k) => k.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(ts).size).toBe(ts.length);
  });

  it("maps source time to clip time through in and speed", () => {
    // Source 4..8 s at speed 2: clip lasts 2 s. Face left until source 6 s, then right.
    const t = track((s) => [face(600 + 700 * Math.min(1, Math.max(0, (s - 5) / 2)), 540, 300)], 10);
    const r = reframePath(t, { in: 4, out: 8, speed: 2 }, FRAME);
    const ts = r.keyframes.x!.map((k) => k.t);
    expect(ts[0]).toBe(0);
    expect(Math.max(...ts)).toBeLessThanOrEqual(2);
    expect(r.keyframes.x![0]!.value).toBeGreaterThan(0);
    expect(r.keyframes.x![r.keyframes.x!.length - 1]!.value).toBeLessThan(0);
    // Samples outside 4..8 never count: face only exists at source 0..3 -> empty.
    expect(reframePath(track(() => [face(300, 540)], 3), { in: 4, out: 8, speed: 1 }, FRAME).keyframes).toEqual({});
  });

  it("emits y keys only when the source is taller than the frame", () => {
    const wide = reframePath(track(() => [face(960, 200)]), CLIP, FRAME);
    expect(wide.keyframes.y).toBeUndefined();
    const tall = reframePath(track(() => [face(540, 400)], 10, 1080, 1920), CLIP, { width: 1920, height: 1080 });
    expect(tall.keyframes.x).toBeUndefined();
    expect(tall.keyframes.y).toHaveLength(1);
    expect(tall.keyframes.y![0]!.value).toBeGreaterThan(0); // face above centre: picture moves down
  });

  it("same aspect: scale 1, no keys", () => {
    expect(reframePath(track(() => [face(500, 500)], 10, 1920, 1080), CLIP, { width: 1280, height: 720 })).toEqual({ scale: 1, keyframes: {} });
  });

  it("valueAt at three times gives the expected offsets", () => {
    // Face at source x=600 until 4 s, glides to x=1300 by 6 s.
    const r = reframePath(track((t) => [face(600 + 700 * Math.min(1, Math.max(0, (t - 4) / 2)), 540, 300)]), CLIP, FRAME);
    const k = 0.5625 * r.scale;
    const x = r.keyframes.x!;
    expect(valueAt(x, 0, 0)).toBeCloseTo(-(600 - 960) * k, 0);
    expect(valueAt(x, 2, 0)).toBeCloseTo(-(600 - 960) * k, 0);
    // The last key may trail the exact value by less than the 3% dead-band (32.4 px).
    expect(Math.abs(valueAt(x, 9.5, 0) - -(1300 - 960) * k)).toBeLessThan(32.4);
  });

  it("keeps the picture covering the frame for 1,000 random tracks (property)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const sizes: Array<[number, number]> = [[1920, 1080], [1080, 1920], [1280, 720], [1000, 1000], [3840, 2160]];
    const frames = [FRAME, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1080, height: 1350 }];
    for (let n = 0; n < 1000; n++) {
      const [w, h] = sizes[Math.floor(rnd() * sizes.length)]!;
      const frame = frames[Math.floor(rnd() * frames.length)]!;
      const dur = 1 + rnd() * 60;
      const t = track((s) => {
        if (rnd() < 0.2) return [];
        const count = 1 + Math.floor(rnd() * 3);
        return Array.from({ length: count }, () => face(rnd() * w * 1.2 - w * 0.1, rnd() * h * 1.2 - h * 0.1, 30 + rnd() * 300));
      }, dur, w, h);
      const speed = 0.25 + rnd() * 3;
      const r = reframePath(t, { in: rnd() * 2, out: dur, speed }, frame);
      for (const axis of ["x", "y"] as const) {
        const max = limit(w, h, frame, r.scale, axis);
        const keys = r.keyframes[axis] ?? [];
        expect(keys.length).toBeLessThanOrEqual(LIMITS.maxKeyframes);
        if (max < 1e-6) expect(keys).toEqual([]);
        for (const key of keys) expect(Math.abs(key.value)).toBeLessThanOrEqual(Math.max(0, max) + 1e-9);
      }
      // Covering: shown picture is at least the frame on both axes.
      const fit = Math.min(frame.width / w, frame.height / h);
      expect(w * fit * r.scale).toBeGreaterThanOrEqual(frame.width - 1e-6);
      expect(h * fit * r.scale).toBeGreaterThanOrEqual(frame.height - 1e-6);
    }
  });
});
