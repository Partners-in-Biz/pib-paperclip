import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileVideo, GRAPH_FILE, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { blurInSigma, effectFrame, flashAt, rgbSplitShift, shakeAt, shakeCover, shakeExpr, zoomAt, zoomExpr } from "../src/video-edit/effects.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("box", 1)]: { path: "box.mp4", kind: "video" },
  [inputKey("edge", 1)]: { path: "edge.mp4", kind: "video" },
  [inputKey("flat", 1)]: { path: "flat.mp4", kind: "video" },
  [inputKey("half", 1)]: { path: "half.png", kind: "image" },
};
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const doc = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const fx = (...ids: [string, number][]) => ({ effects: ids.map(([id, intensity]) => ({ id, intensity })) });
const graphOf = (d: EditDoc) => compileVideo(d, inputs, "out.mp4").files[0]!.content;
const SIZE = { width: 1080, height: 1920 };
/** Evaluates one of our ffmpeg expressions in JS (only the functions they use). */
const evalExpr = (expr: string, t: number) => new Function("t", "pow", "max", "sin", "PI", `return ${expr};`)(t, Math.pow, Math.max, Math.sin, Math.PI) as number;

describe("effects: formulas (shared with the preview)", () => {
  it("zoomPunch peaks at 1 + 0.25k on the cut and is back to 1 at 0.4 s; shake cover is 1 + 0.04k", () => {
    expect(zoomAt(1, 0)).toBe(1.25);
    expect(zoomAt(0.5, 0.2)).toBeCloseTo(1.03125);
    expect(zoomAt(1, 0.4)).toBe(1);
    expect(shakeCover(0.5)).toBeCloseTo(1.02);
    expect(shakeAt(1, 0, SIZE)).toEqual({ dx: 0, dy: 0 });
    expect(shakeAt(1, 1 / 36, SIZE).dx).toBeCloseTo(21.6); // A = 0.02 x 1080, sin(pi/2)
  });

  it("flash, rgbSplit and blurIn values; effectFrame combines them", () => {
    expect([flashAt(0.5, 0), flashAt(0.5, 0.15), flashAt(0.5, 0.3)]).toEqual([0.5, 0.25, 0]);
    expect([rgbSplitShift(1, 1080), rgbSplitShift(0.5, 1920), rgbSplitShift(0.01, 1080)]).toEqual([13, 12, 0]);
    expect([blurInSigma(1, 0, 1080), blurInSigma(1, 0.3, 1080), blurInSigma(1, 0.6, 1080)]).toEqual([32.4, 8.1, 0]);
    const f = effectFrame([{ id: "zoomPunch", intensity: 1 }, { id: "shake", intensity: 1 }], 0, SIZE, true);
    expect(f).toEqual({ scale: 1.25 * 1.04, dx: 0, dy: 0, white: 0, split: 0, blur: 0 });
    expect(effectFrame(undefined, 0.1, SIZE, false)).toEqual({ scale: 1, dx: 0, dy: 0, white: 0, split: 0, blur: 0 });
  });

  it("the ffmpeg expressions equal the JS formulas", () => {
    for (const tau of [0, 0.05, 0.13, 0.399, 0.4, 1.7]) {
      expect(evalExpr(zoomExpr(0.7, 2), 2 + tau)).toBeCloseTo(zoomAt(0.7, tau), 6);
      const s = shakeExpr(0.6, 2, SIZE);
      expect(evalExpr(`0${s.x}`, 2 + tau)).toBeCloseTo(shakeAt(0.6, tau, SIZE).dx, 4);
      expect(evalExpr(`0${s.y}`, 2 + tau)).toBeCloseTo(shakeAt(0.6, tau, SIZE).dy, 4);
    }
  });
});

describe("effects: compiled graph", () => {
  it("a main clip's pixel effects run after the fit, before fades: rgbSplit, blurIn, flash", () => {
    const g = graphOf(doc([video(clip("a", "flat", 0, 1, { fadeIn: 0.2, ...fx(["flash", 1], ["blurIn", 1], ["rgbSplit", 1]) }))]));
    expect(g).toContain(
      "color=black,format=yuv420p,scale=in_color_matrix=bt709,format=gbrp,rgbashift=rh=-13:bh=13,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,sendcmd=c=",
    );
    expect(g).toContain("gblur@bi0=sigma=32.4:enable='lt(t,0.6)',geq=lum='lum(X,Y)+1*max(0,1-T/0.3)*(235-lum(X,Y))+0.5'");
    expect(g).toMatch(/enable='between\(t,0,0\.3\)',format=yuv420p,setsar=1,fade=t=in/);
  });

  it("an overlay keeps its alpha through the pixel effects, timed from its start", () => {
    const g = graphOf(doc([video(clip("b", "flat", 0, 3)), overlay(clip("o", "half", 2, 3, fx(["flash", 0.5], ["rgbSplit", 1], ["blurIn", 1])))]));
    expect(g).toContain("format=gbrap,rgbashift=rh=-13:bh=13,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p");
    expect(g).toContain("gblur@bi0=sigma=32.4:enable='lt(t,2.6)'");
    expect(g).toContain(":a='alpha(X,Y)':enable='between(t,2,2.3)'");
    expect(g).toContain("max(0,1-(T-2)/0.3)");
  });

  it("zoomPunch adds a per-frame scale after the shape (no pre-fit); shake moves the overlay position", () => {
    const g = graphOf(doc([video(clip("b", "flat", 0, 3)), overlay(clip("o", "flat", 2, 3, { transform: { scale: 0.5 }, look: { pack: "pib-basic", id: "mono" }, ...fx(["zoomPunch", 1], ["shake", 1]) }))]));
    expect(g).not.toContain("min(iw");
    expect(g).toContain("scale=w=540:h=960:force_original_aspect_ratio=decrease:force_divisible_by=2,scale=w='max(2,iw*(1+0.25*pow(max(0,1-(t-2)/0.4),2)))'");
    expect(g).toContain("overlay=x='(W-w)/2+0+21.6*sin(PI*18*(t-2))':y='(H-h)/2+0+21.6*sin(PI*14*(t-2))':eval=frame");
  });

  it("an overlay's pixel effects run before the size changes per frame (gblur cannot take a size change)", () => {
    const plain = graphOf(doc([video(clip("b", "flat", 0, 3)), overlay(clip("o", "flat", 1, 3, fx(["zoomPunch", 1], ["blurIn", 1])))]));
    expect(plain).toMatch(/gblur@bi0=sigma=32\.4:enable='lt\(t,1\.6\)',scale=w='max\(2,iw\*\(1\+0\.25\*pow\(max\(0,1-\(t-1\)\/0\.4\),2\)\)\)'/);
    const keyed = graphOf(doc([video(clip("b", "flat", 0, 3)), overlay(clip("o", "flat", 1, 3, { keyframes: { scale: [{ t: 0, value: 0.5, ease: "linear" }, { t: 1, value: 1, ease: "linear" }] }, ...fx(["flash", 1]) }))]));
    expect(keyed).toMatch(/enable='between\(t,1,1\.3\)',scale=w='max\(2,iw\*\(if/);
  });

  it("main track: shake folds its cover into the shape; with scale keys, zoom and cover join the keyed scale", () => {
    const shake = graphOf(doc([video(clip("a", "box", 0, 1, fx(["shake", 1])))]));
    expect(shake).toContain("scale=w=1123.2:h=1996.8:force_original_aspect_ratio=decrease");
    expect(shake).toContain("x='(W-w)/2+0+21.6*sin(PI*18*t)'");
    const keyed = graphOf(doc([video(clip("a", "box", 0, 1, { keyframes: { scale: [{ t: 0, value: 1, ease: "linear" }, { t: 1, value: 2, ease: "linear" }] }, ...fx(["zoomPunch", 1], ["shake", 0.5]) }))]));
    expect(keyed).toContain("scale=w='max(2,iw*((if(lt(t,0),1,if(lt(t,1),1+1*((t-0)/1),2)))*((1+0.25*pow(max(0,1-t/0.4),2))*1.02)))'");
  });
});

// ---- real renders (sources at 108x192, fitted x10 to the 1080x1920 frame) ----
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;
let dir = "";
async function ffmpeg(args: string[]) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: dir, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}
/** Frames `frames` of the render as packed RGB (BT.709 TV range). */
async function render(d: EditDoc, frames: number[]): Promise<Buffer[]> {
  const compiled = compileVideo(d, inputs, "out.mp4");
  for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
  await ffmpeg(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin"));
  return frames.map((n) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", "out.mp4", "-vf", `select='eq(n,${n})',scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, maxBuffer: 1 << 24 });
    expect(r.stdout.length).toBe(W * H * 3);
    return r.stdout;
  });
}
const at = (p: Buffer, x: number, y: number, c: number) => p[(y * W + x) * 3 + c]!;
function rgbAt(p: Buffer, x0: number, y0: number, n = 8): number[] {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) for (let c = 0; c < 3; c++) s[c]! += at(p, x, y, c);
  return s.map((v) => v / (n * n));
}
/** First and last index along a row (or column) where channel `c` is above half. */
function span(p: Buffer, c: number, line: number, vertical = false): [number, number] {
  const n = vertical ? H : W;
  const on = (i: number) => (vertical ? at(p, line, i, c) : at(p, i, line, c)) > 128;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) if (on(i)) [first, last] = [first < 0 ? i : first, i];
  return [first, last];
}
/** Largest green step between neighbours on row `y`, for x in [from, to). */
const maxStep = (p: Buffer, y: number, from = 0, to = W - 1) => Math.max(...Array.from({ length: to - from }, (_, i) => Math.abs(at(p, from + i + 1, y, 1) - at(p, from + i, y, 1))));
const near = (got: number[], want: number[], tol: number, what: string) =>
  got.forEach((g, i) => expect(Math.abs(g - want[i]!), `${what}: got ${got.map(Math.round)} want ${want.map(Math.round)}`).toBeLessThanOrEqual(tol));

describe.skipIf(!hasFfmpeg)("effects with real ffmpeg", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "studio-effects-"));
    const enc = ["-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-y"];
    const to709 = "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
    // A white 20x20 box centred on dark grey (200x200 at 440..640 x 860..1060 once fitted).
    await ffmpeg(["-f", "lavfi", "-i", `color=c=0x202020:s=108x192:r=30:d=1,drawbox=x=44:y=86:w=20:h=20:color=white:t=fill,${to709}`, ...enc, "box.mp4"]);
    // Black left half, white right half: the edge lands at x = 540.
    await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=108x192:r=30:d=1,drawbox=x=54:y=0:w=54:h=192:color=white:t=fill,${to709}`, ...enc, "edge.mp4"]);
    await ffmpeg(["-f", "lavfi", "-i", `color=c=0x406080:s=108x192:r=30:d=1,${to709}`, ...enc, "flat.mp4"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x3040C0:s=108x192,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,54),0,255)'", "-frames:v", "1", "-y", "half.png"]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("zoomPunch: the box is 1.25x wide on the cut and back to its size after 0.4 s", async () => {
    const [cut, later] = await render(doc([video(clip("a", "box", 0, 1, fx(["zoomPunch", 1])))]), [0, 15]);
    const width = (p: Buffer) => span(p, 1, H / 2)[1] - span(p, 1, H / 2)[0] + 1;
    expect(Math.abs(width(cut!) - 250)).toBeLessThanOrEqual(3);
    expect(Math.abs(width(later!) - 200)).toBeLessThanOrEqual(3);
  }, 120_000);

  it("shake: the box centre moves by the formula (with the 1.04 cover)", async () => {
    const [p] = await render(doc([video(clip("a", "box", 0, 1, fx(["shake", 1])))]), [1]);
    const { dx, dy } = shakeAt(1, 1 / 30, { width: W, height: H });
    const [x0, x1] = span(p!, 1, Math.round(H / 2 + dy));
    const [y0, y1] = span(p!, 1, Math.round(W / 2 + dx), true);
    expect(Math.abs((x0 + x1) / 2 - (W / 2 + dx))).toBeLessThanOrEqual(1.5);
    expect(Math.abs((y0 + y1) / 2 - (H / 2 + dy))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(x1 - x0 + 1 - 208)).toBeLessThanOrEqual(3);
  }, 120_000);

  it("flash: mixes towards white by flashAt, then the clip is untouched", async () => {
    const frames = await render(doc([video(clip("a", "flat", 0, 1, fx(["flash", 0.5])))]), [0, 3, 12]);
    const base = [0x40, 0x60, 0x80];
    for (const [i, tau] of [0, 0.1, 0.4].entries()) {
      const w = flashAt(0.5, tau);
      near(rgbAt(frames[i]!, 500, 900), base.map((c) => c + w * (255 - c)), 3, `tau ${tau}`);
    }
  }, 120_000);

  it("rgbSplit: red edge moves left and blue right by 13 px, green stays", async () => {
    const [p] = await render(doc([video(clip("a", "edge", 0, 1, fx(["rgbSplit", 1])))]), [5]);
    const [g] = span(p!, 1, H / 2);
    expect(Math.abs(g - 540)).toBeLessThanOrEqual(2);
    expect(Math.abs(span(p!, 0, H / 2)[0] - (g - 13))).toBeLessThanOrEqual(2);
    expect(Math.abs(span(p!, 2, H / 2)[0] - (g + 13))).toBeLessThanOrEqual(2);
  }, 120_000);

  it("blurIn: the edge is soft on the cut, softer than at 0.3 s, and sharp from 0.6 s", async () => {
    const [plain] = await render(doc([video(clip("a", "edge", 0, 1))]), [20]);
    const [cut, mid, after] = await render(doc([video(clip("a", "edge", 0, 1, fx(["blurIn", 1])))]), [0, 9, 20]);
    const sharp = maxStep(plain!, H / 2);
    expect(maxStep(cut!, H / 2)).toBeLessThan(sharp / 4);
    expect(maxStep(cut!, H / 2)).toBeLessThan(maxStep(mid!, H / 2));
    expect(Math.abs(maxStep(after!, H / 2) - sharp)).toBeLessThanOrEqual(2);
  }, 120_000);

  it("an overlay with zoomPunch, rgbSplit and blurIn renders, blurred on the cut and sharp later", async () => {
    const d = doc([video(clip("b", "flat", 0, 1)), overlay(clip("o", "edge", 0, 1, { transform: { scale: 0.5 }, ...fx(["zoomPunch", 1], ["rgbSplit", 1], ["blurIn", 1]) }))]);
    const [cut, after] = await render(d, [0, 25]);
    // The overlay's own black/white edge sits at x = 540; its outer border is 270 px away.
    const [a, c] = [maxStep(after!, H / 2, 500, 580), maxStep(cut!, H / 2, 500, 580)];
    expect(a, `after ${a} cut ${c}`).toBeGreaterThan(4 * c);
  }, 120_000);

  it("an overlay PNG keeps its transparency through flash and rgbSplit; its opaque half flashes white", async () => {
    const [p] = await render(doc([video(clip("b", "flat", 0, 1)), overlay(clip("o", "half", 0, 1, fx(["flash", 1], ["rgbSplit", 0.5])))]), [0]);
    near(rgbAt(p!, 200, 900), [0x40, 0x60, 0x80], 4, "transparent half shows the base");
    near(rgbAt(p!, 800, 900), [255, 255, 255], 4, "opaque half at full flash");
  }, 120_000);
});
