import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildPreviewPlan, containBox, previewGrade, VIGNETTE_K } from "../src/ui/editor/preview-plan.js";
import { applyAdjust, applyLook, applyPrimitives, eqCode, eqPlane, PIB_BASIC_IDS, toSvgPrimitives, vignetteGain, type Rgb } from "../src/video-edit/looks.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

// PAR-10159 (D2d): the preview grade comes from the same looks.ts primitives as the render. The pixel parity against
// the D2c render runs in a real browser (harness attached to the issue); these pin the pure part.
const one = (extra: Record<string, unknown>) =>
  buildPreviewPlan(normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [{ id: "c1", assetId: "a", version: 1, start: 0, in: 0, out: 3, ...extra }] }] })).segments[0]!;
const BOX = { width: 360, height: 640 };
const COLOURS: Rgb[] = [[0.35, 0.33, 0.43], [0.62, 0.45, 0.3], [0.3, 0.55, 0.6], [0.5, 0.5, 0.5], [0.7, 0.62, 0.55]];

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("eqCode matches ffmpeg eq code for code", () => {
  // vf_eq: luma gets contrast + brightness, chroma gets saturation as its contrast. Flat YUV in, one pixel of each plane out.
  const settings = [[0.12, 1, 1], [-0.3, 1, 1], [0.01, 1, 1], [0, 1.3, 1], [0, 0.7, 1], [0, 1, 1.6], [0, 1, 0.5], [0.05, 1.1, 1.2], [-0.1, 1.3, 1.4]] as const;
  for (const [b, c, s] of settings) {
    it(`brightness ${b} contrast ${c} saturation ${s}`, () => {
      for (const [y, u, v] of [[60, 90, 170], [126, 128, 128], [200, 160, 100]] as const) {
        const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=16x16:d=0.04,format=yuv420p,geq=lum=${y}:cb=${u}:cr=${v},eq=brightness=${b}:contrast=${c}:saturation=${s}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
        const got = [r.stdout[8 * 16 + 8], r.stdout[256 + 36], r.stdout[320 + 36]];
        const want = [b !== 0 || c !== 1 ? eqCode(c, b, y) : y, ...[u, v].map((x) => (s !== 1 ? eqCode(s, 0, x) : x))];
        expect(got, `yuv ${y},${u},${v}`).toEqual(want);
      }
    });
  }
});

describe("eqPlane", () => {
  it("is the mean of eqCode over the TV range (where eq does not clip)", () => {
    for (const [c, b] of [[1, 0.12], [1.3, 0], [0.7, -0.1], [1.6, 0], [1.1, 0.05]] as const) {
      const p = eqPlane(c, b);
      let [err, n] = [0, 0];
      for (let x = 16; x <= 235; x++) {
        const out = eqCode(c, b, x);
        if (out > 0 && out < 255) [err, n] = [err + out - (x * p.k + p.o), n + 1];
      }
      expect(n).toBeGreaterThan(100);
      expect(Math.abs(err / n)).toBeLessThan(0.15); // under a fifth of a code: the floor bias is (d-1)/2d only on average
    }
  });
});

describe("preview grade (looks + adjust)", () => {
  it("carries the clip's look and adjust on its segment, null when absent", () => {
    expect(one({})).toMatchObject({ look: null, adjust: null });
    expect(one({ look: { id: "warm", intensity: 0.5 }, adjust: { blur: 3, contrast: 1 } })).toMatchObject({ look: { pack: "pib-basic", id: "warm", intensity: 0.5 }, adjust: { blur: 3 } });
  });

  it("is null when nothing changes the picture", () => {
    expect(previewGrade(one({}), BOX, null)).toBeNull();
    expect(previewGrade(one({ look: { id: "noir", intensity: 0 } }), BOX, null)).toBeNull();
  });

  it("puts the filter region on the contained picture, the whole box until the source size is known", () => {
    expect(containBox(BOX, null)).toEqual({ x: 0, y: 0, width: 360, height: 640 });
    expect(containBox(BOX, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 320 - 101.25, width: 360, height: 202.5 });
    expect(containBox(BOX, { width: 1080, height: 2520 })).toMatchObject({ y: 0, height: 640, width: 640 * (1080 / 2520) });
  });

  it("uses looks.ts primitives in render order, blur scaled to the picture's displayed width", () => {
    const s = one({ look: { id: "teal-orange", intensity: 0.7 }, adjust: { brightness: 0.1, temperature: 4000, blur: 12 } });
    const g = previewGrade(s, BOX, { width: 1080, height: 1920 })!;
    expect(g.primitives).toEqual([...toSvgPrimitives(s.look!), ...toSvgPrimitives(s.adjust!, { displayWidth: 360 })]);
    expect(g.primitives.map((p) => p.kind)).toEqual(["matrix", "table", "matrix", "linear", "blur"]);
    expect(g.primitives.at(-1)).toEqual({ kind: "blur", std: 4 }); // 12 at 1080 -> 4 at 360
    expect(g.vignette).toBeNull();
    // A 16:9 source in a 9:16 frame is 360 wide on screen too; a tall one is narrower, so its blur is smaller.
    const tall = previewGrade(s, BOX, { width: 1080, height: 2520 })!.primitives.at(-1) as { std: number };
    expect(tall.std).toBeCloseTo((12 * 640 * (1080 / 2520)) / 1080, 9);
  });

  it("matches the render's colour maths for every look and each colour field", () => {
    const cases = [
      ...PIB_BASIC_IDS.map((id) => ({ look: { id, intensity: 1 } })),
      { adjust: { brightness: 0.12 } }, { adjust: { contrast: 1.3 } }, { adjust: { saturation: 1.6 } }, { adjust: { temperature: 4500 } },
      { look: { id: "cinematic", intensity: 0.6 }, adjust: { brightness: 0.05, contrast: 1.1, saturation: 1.2, temperature: 5500 } },
    ];
    for (const c of cases) {
      const s = one(c);
      const g = previewGrade(s, BOX, null)!;
      for (const rgb of COLOURS) {
        const looked = s.look ? applyLook(rgb, s.look) : rgb;
        const want = s.adjust ? applyAdjust(looked, s.adjust) : looked;
        const got = applyPrimitives(rgb, g.primitives);
        for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!) * 255, `${JSON.stringify(c)} ${rgb}`).toBeLessThan(1);
      }
    }
  });

  it("vignette: a radial gain image over the picture, radius half its diagonal, composited with ffmpeg's TV-range offset", () => {
    const g = previewGrade(one({ adjust: { vignette: 0.7 } }), BOX, { width: 1920, height: 1080 })!;
    expect(g.primitives).toEqual([]);
    expect(g.vignette!.k).toBeCloseTo(16 / 219, 12);
    expect(VIGNETTE_K).toBe(16 / 219);
    const svg = decodeURIComponent(g.vignette!.href.replace("data:image/svg+xml,", ""));
    expect(svg).toContain(`width='360' height='202.5'`);
    expect(svg).toContain(`cx='180' cy='101.25' r='${Math.round((Math.hypot(360, 202.5) / 2) * 10000) / 10000}'`);
    const stops = [...svg.matchAll(/offset='([\d.]+)' stop-color='rgb\(([\d.]+)%/g)].map((m) => [Number(m[1]), Number(m[2]) / 100]);
    expect(stops).toHaveLength(33);
    for (const [offset, gain] of stops) expect(gain).toBeCloseTo(vignetteGain(0.7, offset!), 4);
    // The linear interpolation between stops stays far under one code value.
    for (let i = 0; i + 1 < stops.length; i++) {
      const mid = (stops[i]![0]! + stops[i + 1]![0]!) / 2;
      expect(Math.abs((stops[i]![1]! + stops[i + 1]![1]!) / 2 - vignetteGain(0.7, mid)) * 255).toBeLessThan(0.5);
    }
  });
});
