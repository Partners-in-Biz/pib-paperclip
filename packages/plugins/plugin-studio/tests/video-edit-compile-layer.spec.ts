import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompileError, compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { BLEND_CSS, blendChannel, frameCoverage, type LayerBlend } from "../src/video-edit/layer.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("base", 1)]: { path: "base.mp4", kind: "video" },
  [inputKey("top", 1)]: { path: "top.mp4", kind: "video" },
  [inputKey("png", 1)]: { path: "top.png", kind: "image" },
  [inputKey("jpg", 1)]: { path: "top.jpg", kind: "image" },
  [inputKey("black", 1)]: { path: "black.mp4", kind: "video" },
};
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const doc = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const graphOf = (d: EditDoc) => compileVideo(d, inputs, "out.mp4").files[0]!.content;
const MODES = Object.keys(BLEND_CSS) as LayerBlend[];
const PIP = { x: 270, y: 480, scale: 0.5 };

describe("blend + frame: compiled graph", () => {
  it("normal and an empty frame compile to the plain overlay graph", () => {
    const plain = compileVideo(doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1))]), inputs, "out.mp4");
    const same = compileVideo(doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1, { blendMode: "normal", frame: { borderWidth: 0, cornerRadius: 0 } }))]), inputs, "out.mp4");
    expect(same).toEqual(plain);
  });

  it("a blend mode places the overlay on a transparent canvas over its interval and blends with lut2", () => {
    const g = graphOf(doc([video(clip("b", "base", 0, 2)), overlay(clip("o", "top", 0.5, 1, { blendMode: "multiply", transform: PIP }))]));
    expect(g).toMatch(/color=c=black@0:s=1080x1920:r=30:d=1,format=yuva420p,setpts=PTS-STARTPTS\+0\.5\/TB\[bcv\d+\]/);
    expect(g).toMatch(/trim=start=0\.5:end=1\.5,scale=in_color_matrix=bt709,format=gbrp\[bbt\d+\]/);
    expect(g).toContain("lut2=c0='clip(round(255*((x/255)*(y/255))),0,255)'");
    expect(g).toMatch(/alphamerge\[bbl\d+\];\n\[bb\d+\]\[bbl\d+\]overlay=x=0:y=0:eof_action=pass\[base\d+\]/);
  });

  it("a frame builds its mask and border once from the first frame, before fades", () => {
    const g = graphOf(doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "png", 0, 1, { fadeIn: 0.2, frame: { borderWidth: 6, borderColor: "#ff0000", cornerRadius: 20 } }))]));
    expect(g).toMatch(/force_divisible_by=2,format=yuva420p,split\[frp\d+\]\[frs\d+\];\[frs\d+\]trim=end_frame=1,split\[frs\d+\]\[frs\d+\];/);
    expect(g).toContain("format=gray,geq=lum='st(0,0.2*min(W,H));");
    expect(g).toContain("format=gbrap,geq=r=255:g=0:b=0:a='");
    expect(g.indexOf("geq=")).toBeLessThan(g.indexOf("fade=t=in"));
  });

  it("a frame with scale keys runs before the keyed scale; rotation is refused", () => {
    const keyed = graphOf(doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1, { frame: { cornerRadius: 10 }, keyframes: { scale: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] } }))]));
    expect(keyed.indexOf("geq=")).toBeLessThan(keyed.indexOf("eval=frame"));
    const rotated = doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1, { transform: { rotate: 10 }, frame: { borderWidth: 4 } }))]);
    expect(() => compileVideo(rotated, inputs, "out.mp4")).toThrow(CompileError);
    expect(() => compileVideo(rotated, inputs, "out.mp4")).toThrow(/frame_with_rotation/);
  });

  it("refuses a frame on every compile path that can rotate: static, rotate keys, rotate + scale keys", () => {
    const rot = [{ t: 0, value: 0 }, { t: 1, value: 45 }];
    const sc = [{ t: 0, value: 0.5 }, { t: 1, value: 1 }];
    const cases = [
      { transform: { rotate: 10 }, frame: { cornerRadius: 20 } },
      { frame: { cornerRadius: 20, borderWidth: 5 }, keyframes: { rotate: rot } },
      { frame: { borderWidth: 5 }, keyframes: { rotate: rot, scale: sc } },
    ];
    for (const extra of cases) {
      const d = doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1, extra))]);
      expect(() => compileVideo(d, inputs, "out.mp4")).toThrow(/frame_with_rotation/);
    }
    // Rotate keys with an empty frame still compile.
    const empty = doc([video(clip("b", "base", 0, 1)), overlay(clip("o", "top", 0, 1, { frame: { cornerRadius: 0, borderWidth: 0 }, keyframes: { rotate: rot } }))]);
    expect(graphOf(empty)).not.toContain("geq=");
  });
});

describe("frame coverage (shared with the preview)", () => {
  const f = { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 };
  it("corner outside, edge band border, centre picture", () => {
    expect(frameCoverage(f, 540, 960, 0.5, 0.5)).toEqual({ inside: 0, border: 0 });
    expect(frameCoverage(f, 540, 960, 270.5, 2.5)).toEqual({ inside: 1, border: 1 });
    expect(frameCoverage(f, 540, 960, 270.5, 480.5)).toEqual({ inside: 1, border: 0 });
  });
});

// ---- real renders: flat 1080x1920 colours, frame 5 decoded to RGB with the BT.709 TV-range matrix ----
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;
let dir = "";

async function ffmpeg(args: string[]) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: dir, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}
const source = (name: string, hex: string) =>
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x${hex}:s=108x192:r=30:d=1`, "-vf", "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-y", name]);

/** Frame 5 of the render as packed RGB 0..255 (BT.709 TV range, as the encoder tagged nothing else). */
async function render(d: EditDoc): Promise<Buffer> {
  const compiled = compileVideo(d, inputs, "out.mp4");
  for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
  await ffmpeg(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin"));
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", "out.mp4", "-vf", "select='eq(n,5)',scale=in_color_matrix=bt709:in_range=tv,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, maxBuffer: 1 << 24 });
  expect(r.stdout.length).toBe(W * H * 3);
  return r.stdout;
}
/** Mean RGB over the n x n box at (x0, y0). */
function rgbAt(p: Buffer, x0: number, y0: number, n = 8): number[] {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) for (let c = 0; c < 3; c++) s[c]! += p[(y * W + x) * 3 + c]!;
  return s.map((v) => v / (n * n));
}
const BASE = [0x30, 0x90, 0xc0];
const TOP = [0xd0, 0x60, 0x40];
const expectNear = (got: number[], want: number[], tol: number, what: string) =>
  got.forEach((g, i) => expect(Math.abs(g - want[i]!), `${what}: got ${got.map(Math.round)} want ${want.map(Math.round)}`).toBeLessThanOrEqual(tol));

describe.skipIf(!hasFfmpeg)("blend + frame with real ffmpeg", () => {
  // The formula runs on the colours lut2 sees: the decoded sources, measured through the same render path.
  let base: number[] = [];
  let top: number[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "studio-layer-"));
    await source("base.mp4", "3090C0");
    await source("top.mp4", "D06040");
    await source("black.mp4", "000000");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xD06040:s=108x192,format=rgba", "-frames:v", "1", "-y", "top.png"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xD06040:s=108x192", "-frames:v", "1", "-q:v", "1", "-y", "top.jpg"]);
    base = rgbAt(await render(doc([video(clip("b", "base", 0, 0.5))])), W / 2 - 4, H / 2 - 4);
    top = rgbAt(await render(doc([video(clip("b", "top", 0, 0.5))])), W / 2 - 4, H / 2 - 4);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Tolerance: 4/255 = YUV 4:2:0 TV-range round trip of a flat colour (measured <= 2) + 2/255 (plan parity rule).
  for (const mode of MODES) {
    it(`${mode}: full-frame overlay matches the W3C formula on flat colours`, async () => {
      const p = await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", "top", 0, 0.5, { blendMode: mode }))]));
      const want = base.map((b, i) => 255 * blendChannel(mode, b / 255, top[i]! / 255));
      expectNear(rgbAt(p, W / 2 - 4, H / 2 - 4), want, 4, mode);
    }, 120_000);
  }

  // Colour path per input kind (rule PAR-10158): lighten over black is the layer itself, so it must match `normal`.
  for (const kind of ["top", "png", "jpg"]) {
    it(`${kind}: lighten over black matches the normal overlay of the same picture`, async () => {
      const normal = rgbAt(await render(doc([video(clip("b", "black", 0, 0.5)), overlay(clip("o", kind, 0, 0.5))])), W / 2 - 4, H / 2 - 4);
      const lighten = rgbAt(await render(doc([video(clip("b", "black", 0, 0.5)), overlay(clip("o", kind, 0, 0.5, { blendMode: "lighten" }))])), W / 2 - 4, H / 2 - 4);
      expectNear(lighten, normal, 2, kind);
    }, 120_000);
  }

  it("a blended PiP leaves the base untouched outside its box and outside its interval", async () => {
    const pip = await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", "top", 0, 0.5, { blendMode: "difference", transform: PIP }))]));
    expectNear(rgbAt(pip, 200, 200), base, 3, "outside the box");
    expectNear(rgbAt(pip, 806, 1436), base.map((b, i) => Math.abs(b - top[i]!)), 4, "inside the box");
    const later = await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", "top", 0.3, 0.2, { blendMode: "difference" }))]));
    expectNear(rgbAt(later, W / 2 - 4, H / 2 - 4), base, 3, "frame 5 is before the clip");
  }, 120_000);

  it("a PiP with radius 20% and a 6 px border: corner = base, border = border colour, centre = picture", async () => {
    const p = await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", "top", 0, 0.5, { transform: PIP, frame: { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 } }))]));
    // PiP is 540x960 centred at (540+270, 960+480): its box is x 540..1080, y 960..1920.
    expectNear(rgbAt(p, 542, 962, 4), BASE, 4, "rounded corner");
    expectNear(rgbAt(p, 806, 962, 2), [255, 0, 0], 6, "border band");
    expectNear(rgbAt(p, 806, 1436), TOP, 4, "picture centre");
    expectNear(rgbAt(p, 200, 200), BASE, 4, "outside the PiP");
  }, 120_000);
});
