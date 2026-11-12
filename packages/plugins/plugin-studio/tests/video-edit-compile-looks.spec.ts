import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { applyAdjust, applyLook, type Adjust, type LookRef, type Rgb } from "../src/video-edit/looks.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("src", 1)]: { path: "src.mp4", kind: "video" },
  [inputKey("blk", 1)]: { path: "blk.mp4", kind: "video" },
  [inputKey("png", 1)]: { path: "clear.png", kind: "image" },
  [inputKey("grey", 1)]: { path: "grey.mp4", kind: "video" },
  [inputKey("edges", 1)]: { path: "edges.mp4", kind: "video" },
  [inputKey("flatpng", 1)]: { path: "flat.png", kind: "image" },
  [inputKey("flatjpg", 1)]: { path: "flat.jpg", kind: "image" },
};
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const doc = (tracks: unknown[], size = "9:16") => normalizeEdit({ project: { size, fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const graphOf = (d: EditDoc) => compileVideo(d, inputs, "out.mp4").files[0].content;
const ALL = { brightness: 0.1, contrast: 1.2, saturation: 0.8, temperature: 4000, blur: 10, vignette: 0.5 };
const TO_RGB = "scale=in_color_matrix=bt709,format=gbrp";
const TO_YUV = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";

describe("looks + adjust: compiled graph", () => {
  it("main clip: timing -> look -> eq -> temperature -> blur -> vignette -> crop/fit, BT.709 around RGB filters", () => {
    const g = graphOf(doc([video(clip("c1", "src", 0, 2, { look: { id: "teal-orange", intensity: 0.5 }, adjust: ALL }))]));
    expect(g).toMatchSnapshot();
    const order = ["fps=30", TO_RGB, "colorchannelmixer=", "curves=", TO_YUV, "eq=brightness=0.1:contrast=1.2:saturation=0.8", `${TO_RGB},colortemperature=temperature=4000`,
      "scale=w=1080:h=-2,gblur=sigma=10", `${TO_YUV},vignette=angle=0.5236,scale=w=1080:h=1920:force_original_aspect_ratio=decrease`, "pad="];
    const at = order.map((s) => g.indexOf(s));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("overlay and shaped main clips grade after timing, before shape, fades and opacity; images keep alpha", () => {
    const mono = { look: { id: "mono" } };
    const g = graphOf(doc([
      video(clip("c1", "src", 0, 2, { ...mono, transform: { rotate: 10 }, keyframes: { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1 }] } })),
      overlay(clip("o1", "png", 0.5, 1, { look: { id: "warm" }, adjust: { vignette: 1 }, fadeIn: 0.2 })),
    ]));
    expect(g).toMatchSnapshot();
    expect(g).toContain(`fps=30,${TO_RGB},colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126:gg=0.7152:gb=0.0722:br=0.2126:bg=0.7152:bb=0.0722,${TO_YUV},format=yuva420p,rotate=`);
    expect(g).toMatch(/fps=30,format=gbrap,colorchannelmixer=rr=1\.08:[^,]*,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,split\[vga\d+\]\[vgb\d+\];\[vga\d+\]format=yuv420p,vignette=angle=1\.0472\[vgc\d+\];\[vgb\d+\]alphaextract\[vgd\d+\];\[vgc\d+\]\[vgd\d+\]alphamerge,format=yuva420p,scale=w=1080:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2,fade=t=in/);
  });

  it("a graded image starts in RGB with its decoder matrix and always leaves through BT.709", () => {
    const g = graphOf(doc([video(clip("b", "blk", 0, 1)), overlay(clip("o1", "png", 0, 1, { adjust: { saturation: 1.5 } }))]));
    expect(g).toContain("fps=30,format=gbrap,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,eq=saturation=1.5,format=yuva420p");
    expect(g).not.toContain("in_color_matrix");
  });

  it("blur sigma follows the render width (16:9 is 1920 wide)", () => {
    expect(graphOf(doc([video(clip("c1", "src", 0, 2, { adjust: { blur: 10 } }))], "16:9"))).toContain("fps=30,scale=w=1920:h=-2,gblur=sigma=17.7778,scale=w=1920:h=1080");
  });

  it("a look at intensity 0 and an all-neutral adjust compile to the plain graph, argv unchanged", () => {
    const plain = compileVideo(doc([video(clip("c1", "src", 0, 2))]), inputs, "out.mp4");
    const neutral = compileVideo(doc([video(clip("c1", "src", 0, 2, { look: { id: "noir", intensity: 0 }, adjust: { brightness: 0, contrast: 1, temperature: 6600 } }))]), inputs, "out.mp4");
    expect(neutral).toEqual(plain);
  });
});

// ---- real renders: 9:16 sources scaled to fill 1080x1920, frame 5 decoded as raw yuv420p ----
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;
const FLAT: Rgb = [192 / 255, 64 / 255, 32 / 255];
let dir = "";

async function ffmpeg(args: string[]) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: dir, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}

/** Source `name` from a lavfi spec, encoded BT.709 TV range (as phone footage) and tagged so. */
const source = (name: string, lavfi: string) =>
  ffmpeg(["-f", "lavfi", "-i", `${lavfi}:r=30:d=1`, "-vf", "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-y", name]);

interface Planes { y: Buffer; u: Buffer; v: Buffer }
async function render(d: EditDoc, name = "out.mp4"): Promise<Planes> {
  const compiled = compileVideo(d, inputs, name);
  for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
  // ffmpeg() adds its own banner/log flags; -y stays, as every case writes out.mp4.
  await ffmpeg(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin"));
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", name, "-vf", "select='eq(n,5)'", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { cwd: dir, maxBuffer: 1 << 23 });
  expect(r.stdout.length).toBe((W * H * 3) / 2);
  const q = (W * H) / 4;
  return { y: r.stdout.subarray(0, W * H), u: r.stdout.subarray(W * H, W * H + q), v: r.stdout.subarray(W * H + q) };
}

/** Mean of a w x h plane over the box [x0, x0+n) x [y0, y0+n) (whole plane without a box). */
function mean(p: Buffer, w: number, box?: { x0: number; y0: number; n: number }): number {
  if (!box) return p.reduce((s, b) => s + b, 0) / p.length;
  let s = 0;
  for (let y = box.y0; y < box.y0 + box.n; y++) for (let x = box.x0; x < box.x0 + box.n; x++) s += p[y * w + x]!;
  return s / (box.n * box.n);
}
const centre = { x0: W / 2 - 20, y0: H / 2 - 20, n: 40 };
const corner = { x0: 0, y0: 0, n: 40 };
/** Mean absolute horizontal step of the luma plane. */
function edgeEnergy(y: Buffer): number {
  let s = 0;
  for (let r = 0; r < H; r++) for (let x = 0; x + 1 < W; x++) s += Math.abs(y[r * W + x + 1]! - y[r * W + x]!);
  return s / (H * (W - 1));
}
/** Centre patch decoded back to RGB 0..1 with the BT.709 TV-range matrix, clamped as a display does. */
function centreRgb(p: Planes): Rgb {
  const Y = (mean(p.y, W, centre) - 16) / 219;
  const half = { x0: centre.x0 / 2, y0: centre.y0 / 2, n: centre.n / 2 };
  const Cb = (mean(p.u, W / 2, half) - 128) / 224;
  const Cr = (mean(p.v, W / 2, half) - 128) / 224;
  return [Y + 1.5748 * Cr, Y - 0.1873 * Cb - 0.4681 * Cr, Y + 1.8556 * Cb].map((c) => Math.min(1, Math.max(0, c))) as unknown as Rgb;
}
const one = (extra: Record<string, unknown>, assetId = "src") => doc([video(clip("c1", assetId, 0, 0.5, extra))]);

describe.skipIf(!hasFfmpeg)("looks + adjust with real ffmpeg", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "studio-looks-"));
    await source("src.mp4", "color=c=0xC04020:s=108x192");
    await source("blk.mp4", "color=c=black:s=108x192");
    await source("grey.mp4", "color=c=0x808080:s=108x192");
    await source("edges.mp4", "testsrc2=s=540x960");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=white@0:s=108x192,format=rgba", "-frames:v", "1", "-y", "clear.png"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xC04020:s=108x192,format=rgba", "-frames:v", "1", "-y", "flat.png"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xC04020:s=108x192", "-frames:v", "1", "-q:v", "1", "-y", "flat.jpg"]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("brightness +0.2 raises mean luma by 0.2 x 255 (+-3) on raw Y codes", async () => {
    const plain = mean((await render(one({}, "grey"))).y, W);
    const bright = mean((await render(one({ adjust: { brightness: 0.2 } }, "grey"))).y, W);
    expect(Math.abs(bright - plain - 0.2 * 255), `plain ${plain}, bright ${bright}`).toBeLessThanOrEqual(3);
  }, 120_000);

  it("look mono puts U and V at 128 (+-2) on a saturated colour", async () => {
    const plain = await render(one({}));
    expect(Math.abs(mean(plain.u, W / 2) - 128)).toBeGreaterThan(20);
    const mono = await render(one({ look: { id: "mono" } }));
    for (const p of [mono.u, mono.v]) expect(Math.abs(mean(p, W / 2) - 128)).toBeLessThanOrEqual(2);
  }, 120_000);

  it("blur lowers edge energy", async () => {
    const sharp = edgeEnergy((await render(one({}, "edges"))).y);
    const soft = edgeEnergy((await render(one({ adjust: { blur: 10 } }, "edges"))).y);
    expect(soft, `sharp ${sharp}, blurred ${soft}`).toBeLessThan(sharp * 0.5);
  }, 120_000);

  it("vignette darkens the corner, not the centre", async () => {
    const plain = await render(one({}, "grey"));
    const vig = await render(one({ adjust: { vignette: 1 } }, "grey"));
    expect(Math.abs(mean(vig.y, W, centre) - mean(plain.y, W, centre))).toBeLessThanOrEqual(3);
    expect(mean(vig.y, W, corner)).toBeLessThan(mean(vig.y, W, centre) - 40);
  }, 120_000);

  it("vignette keeps the source alpha: a transparent PNG overlay stays invisible", async () => {
    const d = doc([video(clip("b", "blk", 0, 0.5)), overlay(clip("o1", "png", 0, 0.5, { adjust: { vignette: 0.5 } }))]);
    expect(mean((await render(d)).y, W, centre)).toBeLessThanOrEqual(18);
  }, 120_000);

  // Every graded variant of an image takes the same YUV matrix (BT.709): an adjust-only PNG used to fall to ffmpeg's
  // implicit BT.601 (Y 101 against 92) and a JPEG look read its BT.601 codes as BT.709. Near-neutral grades, so the
  // centre Y must agree within 2 codes across PNG/JPEG and look-only/adjust-only/vignette-only (BT.709 Y is 92.4).
  it("graded PNG and JPEG overlays share one BT.709 matrix whatever the grade", async () => {
    const grades = [{ adjust: { saturation: 1.01 } }, { adjust: { vignette: 0.01 } }, { look: { id: "warm", intensity: 0.01 } }];
    const ys: string[] = [];
    for (const assetId of ["flatpng", "flatjpg"]) for (const g of grades) {
      const y = mean((await render(doc([video(clip("b", "blk", 0, 0.5)), overlay(clip("o1", assetId, 0, 0.5, g))]))).y, W, centre);
      ys.push(`${assetId} ${JSON.stringify(g)}: ${y}`);
      expect(Math.abs(y - 92.4), ys.join("; ")).toBeLessThanOrEqual(2);
    }
  }, 120_000);

  // The render matches the looks.ts reference math the preview is built from (flat colour, centre patch). Tolerance is
  // looks.ts's own eq tolerance (7/255, 10/255 combined): measured on this ffmpeg, `eq` moves Y by +25/+50 codes for
  // brightness +0.1/+0.2 but -29/-55 for -0.1/-0.2, so negative brightness lands about 4/255 darker than the formula.
  const cases: [string, { look?: Partial<LookRef>; adjust?: Partial<Adjust> }][] = [
    ["teal-orange", { look: { id: "teal-orange", intensity: 1 } }],
    ["sepia 0.5", { look: { id: "sepia", intensity: 0.5 } }],
    ["temperature 3000", { adjust: { temperature: 3000 } }],
    ["contrast 1.3 + saturation 1.4", { adjust: { contrast: 1.3, saturation: 1.4 } }],
    ["brightness -0.1", { adjust: { brightness: -0.1 } }],
    ["vintage + brightness -0.1", { look: { id: "vintage", intensity: 1 }, adjust: { brightness: -0.1 } }],
  ];
  for (const [name, grade] of cases) {
    it(`colour matches looks.ts: ${name}`, async () => {
      const src = centreRgb(await render(one({})));
      for (let i = 0; i < 3; i++) expect(Math.abs(src[i]! - FLAT[i]!)).toBeLessThan(2 / 255);
      let want: Rgb = src;
      if (grade.look) want = applyLook(want, grade.look as LookRef);
      if (grade.adjust) want = applyAdjust(want, grade.adjust);
      const got = centreRgb(await render(one(grade)));
      const report = `want ${want.map((c) => (c * 255).toFixed(1))}, got ${got.map((c) => (c * 255).toFixed(1))}`;
      const tol = (grade.look && grade.adjust) || Object.keys(grade.adjust ?? {}).length > 1 ? 10 : 7;
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), report).toBeLessThanOrEqual(tol / 255);
    }, 120_000);
  }
});
