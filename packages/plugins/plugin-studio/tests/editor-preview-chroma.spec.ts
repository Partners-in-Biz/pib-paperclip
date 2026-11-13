import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COEFFS, despillRgb, keyCoverage, keyDistance, rgbToYuv, type Rgb } from "../src/video-edit/chroma.js";
import { normalizeEdit, type ChromaKey } from "../src/video-edit/timeline.js";
import { buildPreviewPlan } from "../src/ui/editor/preview-plan.js";
import { chromaUniforms, createChromaGl, FRAGMENT_SHADER, keyPixel, NO_KEY_LABEL, type CanvasLike } from "../src/ui/editor/chroma-gl.js";

const GREEN: ChromaKey = { color: "#00B140", similarity: 0.12, blend: 0.08, spill: 0.6 };
// Deterministic pseudo-random colours (no Math.random: a failure must replay).
const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** The RGB (0..1) that decodes from TV-range Y, Cb, Cr codes in BT.709: the browser's side of the key. */
function fromYuv(y: number, u: number, v: number): Rgb {
  const [kr, kb] = COEFFS.bt709;
  const Y = (y - 16) / 219, Pb = (u - 128) / 224, Pr = (v - 128) / 224;
  const r = Y + 2 * (1 - kr) * Pr, b = Y + 2 * (1 - kb) * Pb;
  return [r, (Y - kr * r - kb * b) / (1 - kr - kb), b];
}

describe("preview chroma key (D3d2): uniforms come from chroma.ts", () => {
  it("the Cb/Cr rows reproduce rgbToYuv", () => {
    const p = chromaUniforms(GREEN);
    const next = rand(7);
    for (let i = 0; i < 200; i++) {
      const rgb = [next(), next(), next()].map((c) => Math.round(c * 255)) as Rgb;
      const [, u, v] = rgbToYuv(rgb, "bt709");
      const f = rgb.map((c) => c / 255) as Rgb;
      expect(Math.abs(128 + f[0] * p.cb[0] + f[1] * p.cb[1] + f[2] * p.cb[2] - u)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(128 + f[0] * p.cr[0] + f[1] * p.cr[1] + f[2] * p.cr[2] - v)).toBeLessThanOrEqual(0.5);
    }
    expect(p.key).toEqual(rgbToYuv([0x00, 0xb1, 0x40], "bt709").slice(1));
  });

  it("uses the render's matrix: BT.601 only for an ungraded image", () => {
    expect(chromaUniforms(GREEN, true, false).key).toEqual(rgbToYuv([0x00, 0xb1, 0x40], "bt601").slice(1));
    expect(chromaUniforms(GREEN, true, true).key).toEqual(chromaUniforms(GREEN).key);
  });

  it("keyPixel alpha is keyCoverage of the 3x3 mean keyDistance (8-bit, as vf_chromakey)", () => {
    const next = rand(11);
    for (const k of [GREEN, { ...GREEN, blend: 0 }, { color: "#1030E0", similarity: 0.3, blend: 0.2, spill: 0 }]) {
      const p = chromaUniforms(k);
      for (let i = 0; i < 300; i++) {
        const codes = Array.from({ length: 9 }, () => [16 + Math.round(next() * 219), 16 + Math.round(next() * 224), 16 + Math.round(next() * 224)]);
        const mean = codes.reduce((s, [, u, v]) => s + keyDistance(k, u, v), 0) / 9;
        const want = Math.floor(keyCoverage(k, mean) * 255) / 255;
        const got = keyPixel(p, fromYuv(...(codes[4] as Rgb)), codes.map((c) => fromYuv(...(c as Rgb))))[3];
        expect(Math.abs(got - want)).toBeLessThanOrEqual(1 / 255 + 1e-9);
      }
    }
  });

  it("a neighbour off the frame counts as the key colour (distance 0)", () => {
    const k = { ...GREEN, similarity: 0.2, blend: 0.4 };
    const p = chromaUniforms(k);
    const red: Rgb = [1, 0, 0];
    const inside = keyPixel(p, red, Array(9).fill(red))[3];
    const corner = keyPixel(p, red, [null, null, null, null, red, red, null, red, red])[3];
    const [, u, v] = rgbToYuv([255, 0, 0]);
    expect(corner).toBeCloseTo(Math.floor(keyCoverage(k, (4 * keyDistance(k, u, v)) / 9) * 255) / 255, 2);
    expect(corner).toBeLessThan(inside);
  });

  it("despill matches despillRgb for green and blue screens, and is off for other keys", () => {
    const next = rand(3);
    const keys: ChromaKey[] = [GREEN, { color: "#2040F0", similarity: 0.1, blend: 0.1, spill: 0.8 }, { color: "#E01010", similarity: 0.1, blend: 0.1, spill: 1 }, { ...GREEN, spill: 0 }];
    for (const k of keys) {
      const p = chromaUniforms(k);
      for (let i = 0; i < 100; i++) {
        const rgb = [next(), next(), next()] as Rgb;
        const got = keyPixel(p, rgb, Array(9).fill(rgb)).slice(0, 3);
        const want = despillRgb(k, rgb).map((c) => Math.floor(c * 255) / 255);
        got.forEach((c, j) => expect(c).toBeCloseTo(want[j]!, 9));
      }
    }
    expect(chromaUniforms({ color: "#E01010", similarity: 0.1, blend: 0.1, spill: 1 }).spill).toBe(0);
  });

  it("the shader is the same formula (sqrt of du^2+dv^2 over 2*255^2, mean of 9, clamp, 8-bit truncation)", () => {
    for (const part of ["255.0 * 255.0 * 2.0", "sum / 9.0", "clamp((dist - similarity) / blend, 0.0, 1.0)", "floor(a * 255.0) / 255.0", "(c.r + c.b) * 0.5", "(c.r + c.g) * 0.5", "vec4(c * a, a)"]) expect(FRAGMENT_SHADER).toContain(part);
  });
});

describe("preview chroma key (D3d2): fallback without WebGL", () => {
  it("createChromaGl is null when the browser has no WebGL", () => {
    const p = chromaUniforms(GREEN);
    expect(createChromaGl({ getContext: () => null }, p)).toBeNull();
    expect(createChromaGl({ getContext: () => { throw new Error("blocked"); } } as CanvasLike, p)).toBeNull();
  });

  it("createChromaGl is null when the shader does not compile", () => {
    const gl = new Proxy({ VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, getShaderParameter: () => false }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => ({})) });
    expect(createChromaGl({ getContext: () => gl as unknown as WebGLRenderingContext }, chromaUniforms(GREEN))).toBeNull();
  });

  it("the overlay plays unkeyed under the 'preview without key' label when the key reports none", () => {
    expect(NO_KEY_LABEL).toBe("Preview without key");
    const player = readFileSync(new URL("../src/ui/editor/Player.tsx", import.meta.url), "utf8");
    // Video hidden only while the key draws; label outside the blend group; canvas hidden on fallback.
    expect(player).toContain('opacity: seg.chromaKey && keyed !== "none" ? 0 : undefined');
    expect(player).toContain('{keyed === "none" ? <NoKeyLabel clipId={seg.clipId} /> : null}');
    expect(player).toContain('display: keyed === "none" ? "none" : "block"');
    const layer = readFileSync(new URL("../src/ui/editor/ChromaLayer.tsx", import.meta.url), "utf8");
    expect(layer).toMatch(/if \(!gl\) \{\s*status\.current\("none"\);/);
    expect(layer).toContain('"webglcontextlost"');
  });

  it("the plan carries the overlay's key (main track never)", () => {
    const doc = normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [
      { id: "v", kind: "video", clips: [{ id: "m", assetId: "a", version: 1, start: 0, in: 0, out: 2 }] },
      { id: "o", kind: "overlay", clips: [{ id: "k", assetId: "b", version: 1, start: 0, in: 0, out: 2, chromaKey: GREEN }] },
    ] });
    const plan = buildPreviewPlan(doc);
    expect(plan.overlays[0]!.chromaKey).toEqual(GREEN);
    expect(plan.segments[0]!.chromaKey).toBeNull();
  });
});
