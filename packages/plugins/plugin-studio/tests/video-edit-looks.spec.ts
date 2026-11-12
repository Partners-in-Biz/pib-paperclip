import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEUTRAL_ADJUST, PIB_BASIC_IDS, adjustToFfmpeg, applyAdjust, applyLook, applyPrimitives, lookToFfmpeg, resolveLook,
  temperatureGain, toFfmpeg, toSvgFilter, toSvgPrimitives, vignetteGain, vignetteStops, type Adjust, type Rgb,
} from "../src/video-edit/looks.js";

const COLOURS: Rgb[] = [[0.2, 0.4, 0.6], [0.8, 0.5, 0.3], [0.5, 0.5, 0.5], [0.1, 0.7, 0.3], [0.9, 0.2, 0.6]];
const E = 1 / 255;
const maxDiff = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

describe("looks: the 12 pib-basic looks", () => {
  it("has exactly the 12 named looks", () => {
    expect([...PIB_BASIC_IDS].sort()).toEqual(["bleach", "cinematic", "cool", "fade", "mono", "noir", "punch", "sepia", "teal-orange", "vintage", "vivid", "warm"]);
  });
  for (const id of ["mono", "sepia", "warm", "cool", "teal-orange", "vivid", "fade", "noir", "vintage", "cinematic", "bleach", "punch"]) {
    describe(id, () => {
      it("intensity 0 is identity: no filter args and colours unchanged", () => {
        expect(lookToFfmpeg({ id, intensity: 0 })).toEqual([]);
        expect(toSvgPrimitives({ pack: "pib-basic", id, intensity: 0 })).toEqual([]);
        for (const c of COLOURS) expect(maxDiff(applyLook(c, { id, intensity: 0 }), c)).toBeLessThan(1e-9);
      });
      it("intensity 0.5 and 1 emit filters, 1 differs from 0.5, snapshots are stable", () => {
        const half = lookToFfmpeg({ id, intensity: 0.5 });
        const full = lookToFfmpeg({ id, intensity: 1 });
        expect(half.length).toBeGreaterThan(0);
        expect(full).not.toEqual(half);
        expect(half).toMatchSnapshot();
        expect(full).toMatchSnapshot();
        for (const f of [...half, ...full]) expect(f).toMatch(/^(colorchannelmixer|curves)=[\w=.:'/ -]+$/);
      });
      it("ffmpeg and SVG paths agree on 5 colours within 1/255 at 0.5 and 1", () => {
        for (const intensity of [0.5, 1]) {
          const prims = toSvgPrimitives({ pack: "pib-basic", id, intensity });
          for (const c of COLOURS) expect(maxDiff(applyLook(c, { id, intensity }), applyPrimitives(c, prims))).toBeLessThanOrEqual(E);
        }
      });
    });
  }
  it("mono at intensity 1 gives equal channels (grey)", () => {
    for (const c of COLOURS) { const o = applyLook(c, { id: "mono", intensity: 1 }); expect(o[0]).toBeCloseTo(o[1], 6); expect(o[1]).toBeCloseTo(o[2], 6); }
  });
  it("refuses an unknown id (also prototype keys) and a bad intensity", () => {
    expect(() => resolveLook({ id: "nope", intensity: 1 })).toThrow(/unknown/);
    expect(() => resolveLook({ id: "constructor", intensity: 1 })).toThrow(/unknown/);
    for (const i of [-0.1, 1.1, NaN, Infinity]) expect(() => resolveLook({ id: "mono", intensity: i })).toThrow(/intensity/);
  });
});

describe("looks: adjust", () => {
  const FIELDS: [keyof Adjust, number[]][] = [
    ["brightness", [-0.1, 0.1]],
    ["contrast", [0.8, 1.2]],
    ["saturation", [0, 0.5, 1.6, 2.4]],
    ["temperature", [2500, 4000, 9000, 20000]],
  ];
  it("neutral adjust has no args and no primitives", () => {
    expect(adjustToFfmpeg({})).toEqual([]);
    expect(adjustToFfmpeg(NEUTRAL_ADJUST)).toEqual([]);
    expect(toSvgPrimitives(NEUTRAL_ADJUST)).toEqual([]);
    for (const c of COLOURS) expect(maxDiff(applyAdjust(c, {}), c)).toBeLessThan(1e-9);
  });
  for (const [field, values] of FIELDS) {
    it(`${field}: ffmpeg and SVG paths agree on 5 colours within 1/255`, () => {
      for (const v of values) {
        const adj = { [field]: v } as Partial<Adjust>;
        expect(adjustToFfmpeg(adj).length).toBe(1);
        const prims = toSvgPrimitives(adj);
        for (const c of COLOURS) expect(maxDiff(applyAdjust(c, adj), applyPrimitives(c, prims))).toBeLessThanOrEqual(E);
      }
    });
  }
  it("combined brightness+contrast+saturation+temperature agree", () => {
    const adj = { brightness: 0.05, contrast: 1.15, saturation: 1.3, temperature: 5000 };
    const prims = toSvgPrimitives(adj);
    for (const c of COLOURS) expect(maxDiff(applyAdjust(c, adj), applyPrimitives(c, prims))).toBeLessThanOrEqual(E);
  });
  it("brightness is additive (SVG intercept), not multiplicative", () => {
    const [p] = toSvgPrimitives({ brightness: 0.2 });
    expect(p).toMatchObject({ kind: "matrix" });
    expect(applyPrimitives([0, 0, 0], [p!])[0]).toBeCloseTo((0.2 * 256) / 219, 6);
  });
  it("ffmpeg args are fixed strings from our numbers, in render order", () => {
    expect(adjustToFfmpeg({ brightness: 0.2, contrast: 1.1, saturation: 0, temperature: 5000, blur: 10, vignette: 0.5 }, { renderWidth: 1080 }))
      .toEqual(["eq=brightness=0.2:contrast=1.1:saturation=0", "colortemperature=temperature=5000", "gblur=sigma=10", "vignette=angle=0.5236"]);
  });
  it("blur sigma scales with render width (SVG with display width)", () => {
    expect(adjustToFfmpeg({ blur: 10 }, { renderWidth: 540 })).toEqual(["gblur=sigma=5"]);
    expect(adjustToFfmpeg({ blur: 10 }, { renderWidth: 1920 })).toEqual(["gblur=sigma=17.7778"]);
    expect(toSvgFilter({ blur: 10 }, { id: "b", displayWidth: 360 })).toContain('stdDeviation="3.3333"');
  });
  it("rejects non-finite fields", () => {
    expect(() => adjustToFfmpeg({ brightness: NaN })).toThrow(/finite/);
  });
});

describe("looks: temperature and vignette against measured ffmpeg 6.1.1 output", () => {
  // Grey 128 through `colortemperature`, rgb24 (measured on pib-vps).
  const MEASURED: [number, [number, number, number]][] = [[1000, [128, 34, 0]], [3500, [128, 96, 70]], [5000, [128, 114, 103]], [8000, [111, 115, 128]], [12000, [95, 106, 128]], [40000, [76, 93, 128]], [6600, [128, 128, 128]]];
  for (const [k, rgb] of MEASURED) {
    it(`${k} K`, () => {
      const g = temperatureGain(k);
      rgb.forEach((v, i) => expect(Math.abs(g[i]! * 128 - v)).toBeLessThanOrEqual(1.5));
    });
  }
  it("6600 K is exact identity, 6500 K is not", () => {
    expect(temperatureGain(6600)).toEqual([1, 1, 1]);
    expect(temperatureGain(6500)[2]).toBeLessThan(0.99);
  });
  it("vignette falls off from 1 at the centre to cos^4 at the corner; 0 is flat", () => {
    expect(vignetteGain(0.7, 0)).toBe(1);
    expect(vignetteGain(0, 1)).toBe(1);
    expect(vignetteGain(1, 1)).toBeCloseTo(Math.pow(Math.cos(Math.PI / 3), 4), 9);
    const s = vignetteStops(0.6);
    expect(s).toHaveLength(9);
    for (let i = 1; i < s.length; i++) expect(s[i]!.gain).toBeLessThan(s[i - 1]!.gain);
  });
});

describe("looks: output shape", () => {
  it("toFfmpeg dispatches on look vs adjust", () => {
    expect(toFfmpeg({ pack: "pib-basic", id: "warm", intensity: 1 })).toEqual(lookToFfmpeg({ id: "warm", intensity: 1 }));
    expect(toFfmpeg({ brightness: 0.1 })).toEqual(["eq=brightness=0.1"]);
  });
  it("toSvgFilter sets sRGB and refuses a bad id", () => {
    const s = toSvgFilter({ pack: "pib-basic", id: "teal-orange", intensity: 1 }, { id: "look1" });
    expect(s).toMatch(/^<filter id="look1" color-interpolation-filters="sRGB">.*<\/filter>$/);
    expect(s).toContain("feColorMatrix");
    expect(s).toContain("tableValues");
    expect(() => toSvgFilter({}, { id: 'x"><script' })).toThrow();
  });
  it("looks.ts imports nothing (pure, browser-safe)", () => {
    const src = readFileSync(new URL("../src/video-edit/looks.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(|node:|\bimport\s*\(/);
  });
});

// Real ffmpeg: our reference model must match what the binary does (skips where ffmpeg is missing).
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
describe.runIf(hasFfmpeg)("looks: reference model vs real ffmpeg", () => {
  // Production pixel format: yuv420p, BT.709, TV range. Each colour is a 2x2 block so 4:2:0 chroma stays per-colour.
  const run = (filters: string[], cols: Rgb[]): Rgb[] => {
    const w = cols.length * 2;
    const row = cols.flatMap((c) => [0, 1].flatMap(() => c.map((v) => Math.round(v * 255))));
    const input = Buffer.from([...row, ...row]);
    const vf = ["scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p", "setparams=colorspace=bt709:range=tv", ...filters, "scale=in_color_matrix=bt709:in_range=tv:out_range=pc", "format=rgb24"].join(",");
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x2`, "-i", "-", "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"], { input });
    expect(r.status).toBe(0);
    const o = r.stdout;
    return cols.map((_, i) => [o[i * 6]! / 255, o[i * 6 + 1]! / 255, o[i * 6 + 2]! / 255] as Rgb);
  };
  for (const id of PIB_BASIC_IDS) {
    it(`look ${id} at 0.5 and 1 within 4/255 (tv-range 4:2:0 + 8-bit matrix/LUT rounding; measured max 3.4/255)`, () => {
      for (const intensity of [0.5, 1]) {
        const got = run(lookToFfmpeg({ id, intensity }), COLOURS);
        COLOURS.forEach((c, i) => expect(maxDiff(got[i]!, applyLook(c, { id, intensity }))).toBeLessThanOrEqual(4 * E));
      }
    });
  }
  it("colortemperature + RGB gains within 2/255", () => {
    const adj = { temperature: 4500 };
    const got = run(adjustToFfmpeg(adj), COLOURS);
    COLOURS.forEach((c, i) => expect(maxDiff(got[i]!, applyAdjust(c, adj))).toBeLessThanOrEqual(3 * E));
  });
  const EQ_CASES: Partial<Adjust>[] = [{ brightness: 0.2 }, { brightness: -0.2 }, { contrast: 1.5 }, { contrast: 0.7 }, { saturation: 2 }, { saturation: 0.5 }, { brightness: -0.1, contrast: 1.3, saturation: 1.4 }];
  // Colours whose luma stays inside 0..1 after the change (the known luma-clamp difference is documented in looks.ts).
  const EQ_COLOURS: Rgb[] = [[0.5, 0.5, 0.5], [0.2, 0.4, 0.6], [0.6, 0.3, 0.3], [0.3, 0.6, 0.4], [0.4, 0.4, 0.5]];
  for (const adj of EQ_CASES) {
    it(`eq ${JSON.stringify(adj)} on yuv420p tv BT.709 within ${Object.keys(adj).length > 1 ? 10 : 7}/255 (measured max 3.6..9.9; 4:2:0 chroma + 8-bit eq LUT)`, () => {
      const got = run(adjustToFfmpeg(adj), EQ_COLOURS);
      EQ_COLOURS.forEach((c, i) => expect(maxDiff(got[i]!, applyAdjust(c, adj))).toBeLessThanOrEqual((Object.keys(adj).length > 1 ? 10 : 7) * E));
    });
  }
  it("adjust values outside the documented ranges throw", () => {
    for (const bad of [{ temperature: 0 }, { temperature: 1e9 }, { brightness: 2 }, { contrast: -1 }, { saturation: 4 }, { blur: 51 }, { vignette: 2 }, { blur: NaN }]) {
      expect(() => adjustToFfmpeg(bad)).toThrow();
    }
  });
});
