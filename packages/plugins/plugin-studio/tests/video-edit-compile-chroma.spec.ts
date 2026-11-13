import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromaKeyFilter, despillFilter, despillRgb, keyCoverage, keyDistance, keyMatrix, keyYuv, spillScreen } from "../src/video-edit/chroma.js";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { normalizeEdit, type ChromaKey, type EditDoc } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("base", 1)]: { path: "base.mp4", kind: "video" },
  [inputKey("green", 1)]: { path: "green.mp4", kind: "video" },
  [inputKey("png", 1)]: { path: "green.png", kind: "image" },
  [inputKey("flat", 1)]: { path: "flat.mp4", kind: "video" },
  [inputKey("flatpng", 1)]: { path: "flat.png", kind: "image" },
  [inputKey("flatjpg", 1)]: { path: "flat.jpg", kind: "image" },
};
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const doc = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const graphOf = (d: EditDoc) => compileVideo(d, inputs, "out.mp4").files[0]!.content;
const KEY: ChromaKey = { color: "#00B140", similarity: 0.1, blend: 0, spill: 0 };
const keyed = (asset: string, k: Partial<ChromaKey>, extra: Record<string, unknown> = {}) =>
  doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", asset, 0, 0.5, { chromaKey: { ...KEY, ...k }, ...extra }))]);

describe("chroma key: formulas (shared with the preview)", () => {
  it("converts the key with BT.709 TV range and passes it as YUV", () => {
    expect(keyYuv({ color: "#00FF00" })).toEqual([173, 42, 26]);
    expect(keyYuv({ color: "#00FF00" }, "bt601")).toEqual([145, 54, 34]);
    expect([keyMatrix(false, false), keyMatrix(true, true), keyMatrix(true, false)]).toEqual(["bt709", "bt709", "bt601"]);
    expect(chromaKeyFilter({ color: "#00FF00", similarity: 0.15, blend: 0.05, spill: 0 })).toBe("chromakey=color=0xAD2A1A:similarity=0.15:blend=0.05:yuv=1");
  });

  it("keyCoverage: hard step without blend, linear ramp with it", () => {
    expect(keyCoverage({ similarity: 0.1, blend: 0 }, 0.1)).toBe(0);
    expect(keyCoverage({ similarity: 0.1, blend: 0 }, 0.11)).toBe(1);
    expect(keyCoverage({ similarity: 0.1, blend: 0.2 }, 0.2)).toBeCloseTo(0.5);
  });

  it("despill limits the screen channel to the mean of the other two at spill 1; none for a non-green/blue key", () => {
    expect(spillScreen({ color: "#00B140" })).toBe("green");
    expect(spillScreen({ color: "#1040E0" })).toBe("blue");
    expect(spillScreen({ color: "#C02020" })).toBeNull();
    expect(despillRgb({ color: "#00B140", spill: 1 }, [0.4, 0.8, 0.2])).toEqual([0.4, expect.closeTo(0.3), 0.2]);
    expect(despillRgb({ color: "#00B140", spill: 0.5 }, [0.4, 0.8, 0.2])[1]).toBeCloseTo(0.55);
    expect(despillRgb({ color: "#1040E0", spill: 1 }, [0.2, 0.4, 0.9])[2]).toBeCloseTo(0.3);
    expect(despillFilter({ ...KEY, color: "#C02020", spill: 1 })).toBeNull();
    expect(despillFilter({ ...KEY, spill: 0 })).toBeNull();
    expect(despillFilter({ ...KEY, color: "#1040E0", spill: 0.8 })).toBe("despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue=-0.8");
  });
});

describe("chroma key: compiled graph", () => {
  it("keys the source before grade and shape; despill only with spill", () => {
    const g = graphOf(keyed("green", { spill: 0.6 }, { transform: { scale: 0.5 } }));
    expect(g).toMatch(/fps=30,format=yuva420p,chromakey=color=0x[0-9A-F]{6}:similarity=0\.1:blend=0:yuv=1,scale=in_color_matrix=bt709,format=rgba,despill=type=green:mix=0\.5:expand=0:red=0:green=-0\.6:blue=0,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,format=yuva420p,scale=w=540/);
    expect(graphOf(keyed("green", {}))).not.toContain("despill");
  });

  it("a keyed graded video keeps its alpha through the grade", () => {
    const g = graphOf(keyed("green", {}, { adjust: { temperature: 4000 } }));
    expect(g).toMatch(/chromakey=[^,]+,scale=in_color_matrix=bt709,format=gbrap,colortemperature=[^,]+,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p/);
  });

  it("an image's own alpha is multiplied back after the key; an ungraded image keys in its implicit BT.601", () => {
    const g = graphOf(keyed("png", { spill: 1 }));
    expect(g).toMatch(/fps=30,format=yuva420p,split\[ckp\d+\]\[cko\d+\]/);
    expect(g).toContain(`${chromaKeyFilter({ ...KEY, spill: 1 }, "bt601")},scale=in_color_matrix=bt601,format=rgba,despill=`);
    expect(g).toMatch(/\[cka\d+\]\[cko\d+\]blend=all_mode=multiply\[cka\d+\];\[ckp\d+\]\[cka\d+\]alphamerge/);
    const graded = graphOf(keyed("png", {}, { adjust: { contrast: 1.1 } }));
    expect(graded).toMatch(/format=gbrap,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,split\[ckp\d+\]\[cko\d+\]/);
    expect(graded).toContain(chromaKeyFilter(KEY, "bt709"));
    expect(chromaKeyFilter(KEY, "bt601")).not.toBe(chromaKeyFilter(KEY, "bt709"));
  });
});

// ---- real renders: a 108x192 green-screen fixture (scaled x10 to the 1080x1920 frame) ----
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;
const BASE = [0x30, 0x40, 0xc0];
const SUBJECT = [0xd0, 0x60, 0x40];
const SPILL = [0x70, 0xb0, 0x60]; // a subject edge tinted by the screen
// Screen, a 6 px spill band (x 21..27 at source size), the subject (x 27..81, y 48..144).
const SCENE = "color=c=0x00B140:s=108x192:r=30:d=1,drawbox=x=21:y=42:w=66:h=108:color=0x70B060:t=fill,drawbox=x=27:y=48:w=54:h=96:color=0xD06040:t=fill";
let dir = "";

async function ffmpeg(args: string[]) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: dir, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}
const raw = (args: string[], bytes: number) => {
  const r = spawnSync("ffmpeg", ["-v", "error", ...args, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, maxBuffer: 1 << 24 });
  expect(r.stdout.length).toBe(bytes);
  return r.stdout;
};

/** Frame 5 of the render as packed RGB (BT.709 TV range). */
async function render(d: EditDoc): Promise<Buffer> {
  const compiled = compileVideo(d, inputs, "out.mp4");
  for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
  await ffmpeg(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin"));
  return raw(["-i", "out.mp4", "-vf", "select='eq(n,5)',scale=in_color_matrix=bt709:in_range=tv,format=rgb24"], W * H * 3);
}
function rgbAt(p: Buffer, x0: number, y0: number, n = 8): number[] {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) for (let c = 0; c < 3; c++) s[c]! += p[(y * W + x) * 3 + c]!;
  return s.map((v) => v / (n * n));
}
const expectNear = (got: number[], want: number[], tol: number, what: string) =>
  got.forEach((g, i) => expect(Math.abs(g - want[i]!), `${what}: got ${got.map(Math.round)} want ${want.map(Math.round)}`).toBeLessThanOrEqual(tol));

describe.skipIf(!hasFfmpeg)("chroma key with real ffmpeg", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "studio-chroma-"));
    const yuv = ["-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-y"];
    const to709 = "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x3040C0:s=108x192:r=30:d=1", "-vf", to709, ...yuv, "base.mp4"]);
    await ffmpeg(["-f", "lavfi", "-i", `${SCENE},${to709}`, ...yuv, "green.mp4"]);
    // Left half fully transparent (black under alpha 0), right half the green scene.
    await ffmpeg(["-f", "lavfi", "-i", `color=c=0xD06040:s=108x192:r=30:d=1,${to709}`, ...yuv, "flat.mp4"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xD06040:s=108x192,format=rgba", "-frames:v", "1", "-y", "flat.png"]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xD06040:s=108x192", "-frames:v", "1", "-q:v", "1", "-y", "flat.jpg"]);
    await ffmpeg(["-f", "lavfi", "-i", `${SCENE},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,54),0,255)'`, "-frames:v", "1", "-y", "green.png"]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("green fixture: keyed alpha is 0 on the screen and 255 on the subject (the chromakey filter alone)", () => {
    const a = raw(["-i", "green.mp4", "-vf", `format=yuva420p,${chromaKeyFilter(KEY)},alphaextract`], 108 * 192);
    expect(a[100 * 108 + 5]).toBe(0); // screen
    expect(a[96 * 108 + 54]).toBe(255); // subject
    expect(a[96 * 108 + 23]).toBe(255); // spill band: far enough from the key to stay
  });

  it("a soft key's alpha matches keyCoverage on the decoded Cb/Cr", () => {
    const k = { ...KEY, similarity: 0.05, blend: 0.4 };
    const planes = raw(["-i", "green.mp4"], 108 * 192 * 1.5);
    // yuv420p: the 54x96 Cb then Cr planes follow luma; luma (23, 96) is chroma sample (11, 48).
    const u = planes[108 * 192 + 48 * 54 + 11]!;
    const v = planes[108 * 192 * 1.25 + 48 * 54 + 11]!;
    const a = raw(["-i", "green.mp4", "-vf", `format=yuva420p,${chromaKeyFilter(k)},alphaextract`], 108 * 192);
    // Inside the flat band all 9 neighbours share one Cb/Cr, so the mean is that sample's distance.
    expect(Math.abs(a[96 * 108 + 23]! - 255 * keyCoverage(k, keyDistance(k, u, v)))).toBeLessThanOrEqual(1);
  });

  it("render: the screen shows the base, the subject stays itself", async () => {
    const p = await render(keyed("green", {}));
    expectNear(rgbAt(p, 40, 100), BASE, 4, "screen keyed out");
    expectNear(rgbAt(p, W / 2 - 4, H / 2 - 4), SUBJECT, 4, "subject");
  }, 120_000);

  it("spill lowers green at the subject's edge to the despill formula; the subject centre is untouched", async () => {
    const plain = await render(keyed("green", {}));
    const clean = await render(keyed("green", { spill: 1 }));
    const edge = rgbAt(clean, 236, H / 2 - 4);
    expect(edge[1]!).toBeLessThan(rgbAt(plain, 236, H / 2 - 4)[1]! - 30);
    expectNear(edge, despillRgb({ ...KEY, spill: 1 }, SPILL.map((c) => c / 255) as [number, number, number]).map((c) => c * 255), 4, "despilled edge");
    expectNear(rgbAt(clean, W / 2 - 4, H / 2 - 4), SUBJECT, 4, "subject");
  }, 120_000);

  it("a keyed clip with a look, vignette and blur keeps the screen keyed out", async () => {
    const p = await render(keyed("green", { spill: 0.5 }, { look: { pack: "pib-basic", id: "mono" }, adjust: { vignette: 0.5, blur: 2 } }));
    expectNear(rgbAt(p, 40, 100), BASE, 4, "screen keyed out");
    const subject = rgbAt(p, W / 2 - 4, H / 2 - 4);
    expect(Math.max(...subject) - Math.min(...subject), "mono subject").toBeLessThanOrEqual(4);
  }, 120_000);

  // Rule PAR-10158: the key path must not move a colour it keeps, for each input kind and grade variant.
  for (const asset of ["flat", "flatpng", "flatjpg"]) {
    it(`${asset}: a kept flat colour renders as without the key (ungraded, look-only, adjust-only)`, async () => {
      for (const grade of [{}, { look: { pack: "pib-basic", id: "mono" } }, { adjust: { brightness: 0.1 } }]) {
        const plain = rgbAt(await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", asset, 0, 0.5, grade))])), W / 2 - 4, H / 2 - 4);
        const key = rgbAt(await render(keyed(asset, { spill: 1 }, grade)), W / 2 - 4, H / 2 - 4);
        expectNear(key, plain, 2, `${asset} ${JSON.stringify(grade)}`);
      }
    }, 120_000);
  }

  it("a transparent PNG keeps its own transparency where the key would not remove it", async () => {
    const p = await render(keyed("png", {}));
    const unkeyed = await render(doc([video(clip("b", "base", 0, 0.5)), overlay(clip("o", "png", 0, 0.5))]));
    expectNear(rgbAt(p, 300, 1200), BASE, 4, "transparent half");
    expectNear(rgbAt(p, 1000, 100), BASE, 4, "screen keyed out");
    expectNear(rgbAt(p, 700, H / 2 - 4), rgbAt(unkeyed, 700, H / 2 - 4), 2, "subject as without the key");
  }, 120_000);
});
