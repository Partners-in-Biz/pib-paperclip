// TEMPORARY dogfood probe (Toby, PAR-10170). Not committed.
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { renderPasses } from "../src/video-edit/render-pipeline.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";
import { pipTransform } from "../src/ui/editor/layer-panel.js";

const DIR = process.env.DOGFOOD_DIR!;
const W = 1080, H = 1920;
const sh = (args: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { cwd: DIR }); if (r.status !== 0) throw new Error(r.stderr.toString()); };
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const doc = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v" + Math.random().toString(36).slice(2, 6), kind: "video", clips });
const overlay = (id: string, ...clips: unknown[]) => ({ id, kind: "overlay", clips });
const ctl = { signal: new AbortController().signal, started: async () => true, passEnded: async () => {} } as never;
const yuv = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
const solid = (name: string, hex: string, d: number, w = 108, h = 192) => sh(["-f", "lavfi", "-i", `color=c=0x${hex}:s=${w}x${h}:r=30:d=${d}`, "-vf", `format=rgb24,${yuv}`, "-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", name]);
const src = (name: string, path = name + ".mp4", kind = "video") => ({ [inputKey(name, 1)]: { path: join(DIR, path), kind } }) as CompileInputs;

async function renderDoc(d: ReturnType<typeof doc>, sources: CompileInputs, sub: string) {
  const dir = join(DIR, sub); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  // sample ffmpeg VmPeak / VmHWM while rendering
  let vmPeak = 0, rss = 0; let stop = false; const perPass = new Map<string, { vmPeakMiB: number; rssMiB: number; cpuSec?: number; firstSeen?: number; lastSeen?: number }>();
  const sampler = (async () => { while (!stop) {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try { const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); if (comm !== "ffmpeg") continue;
        const cwd = readlinkSync(`/proc/${pid}/cwd`); if (!cwd.startsWith(dir)) continue; // only this render's ffmpeg
        const s = readFileSync(`/proc/${pid}/status`, "utf8"); const g = (k: string) => Number(new RegExp(k + ":\\s+(\\d+)").exec(s)?.[1] ?? 0);
        const k = `${pid} ${cwd.slice(dir.length) || "/"}`; const o = perPass.get(k) ?? { vmPeakMiB: 0, rssMiB: 0 };
        const st = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); const cpu = (Number(st[11]) + Number(st[12])) / 100; const now = (Date.now() - t0) / 1000;
        perPass.set(k, { vmPeakMiB: Math.max(o.vmPeakMiB, Math.round(g("VmPeak") / 1024)), rssMiB: Math.max(o.rssMiB, Math.round(g("VmHWM") / 1024)), cpuSec: cpu, firstSeen: o.firstSeen ?? now, lastSeen: now });
        vmPeak = Math.max(vmPeak, g("VmPeak")); rss = Math.max(rss, g("VmHWM")); } catch { /* gone */ }
    } await new Promise((r) => setTimeout(r, 400)); } })();
  let rep: any; let err: any;
  try { rep = await renderPasses(d, sources, dir, ctl, {}); } catch (e) { err = e; }
  stop = true; await sampler; console.log("PERPASS", sub, JSON.stringify(Object.fromEntries(perPass)));
  if (err) { console.log('RENDER_FAIL', sub, JSON.stringify({ wall: (Date.now() - t0) / 1000, vmPeakMiB: Math.round(vmPeak / 1024), rssMiB: Math.round(rss / 1024), msg: String(err.message), code: err.code, tail: err.stderrTail })); throw err; }
  const wall = (Date.now() - t0) / 1000;
  return { rep, wall, vmPeakMiB: Math.round(vmPeak / 1024), rssMiB: Math.round(rss / 1024), out: join(dir, "out.mp4") };
}
/** RGB mean of an n x n box of frame `fr` of a file (bt709 tv). */
function px(file: string, fr: number, x: number, y: number, n = 4): number[] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select='eq(n,${fr})',scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
  const p = r.stdout; if (p.length !== W * H * 3) throw new Error("bad frame " + p.length);
  const s = [0, 0, 0]; for (let j = y; j < y + n; j++) for (let i = x; i < x + n; i++) for (let c = 0; c < 3; c++) s[c]! += p[(j * W + i) * 3 + c]!;
  return s.map((v) => Math.round(v / (n * n)));
}
const near = (g: number[], w: number[], tol: number, what: string) => g.forEach((v, i) => expect(Math.abs(v - w[i]!), `${what}: got ${g} want ${w}`).toBeLessThanOrEqual(tol));

describe("dogfood PAR-10170", () => {
  it("setup", () => {
    mkdirSync(DIR, { recursive: true });
    solid("base.mp4", "3090C0", 2); solid("top.mp4", "D06040", 2);
    // green screen: 00B140 background with a red-ish subject square in the middle
    sh(["-f", "lavfi", "-i", "color=c=0x00B140:s=108x192:r=30:d=2", "-vf", `drawbox=x=34:y=64:w=40:h=64:color=0xD03030:t=fill,format=rgb24,${yuv}`, "-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "green.mp4"]);
  }, 60_000);

  it("PiP bottom-right M, radius 20%, border 6px", async () => {
    const t = pipTransform({ width: W, height: H }, "bottom-right", "M");
    console.log("PIP_TRANSFORM", JSON.stringify(t));
    const d = doc([video(clip("b", "base", 0, 1)), overlay("o", clip("o", "top", 0, 1, { transform: t, frame: { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 } }))]);
    const r = await renderDoc(d, { ...src("base"), ...src("top") }, "pip");
    const sc = t.scale; const bw = Math.round(W * sc), bh = Math.round(H * sc);
    const x0 = Math.round((W - bw) / 2 + t.x), y0 = Math.round((H - bh) / 2 + t.y);
    console.log("PIP_BOX", x0, y0, bw, bh);
    const BASE = [0x30, 0x90, 0xc0], TOP = [0xd0, 0x60, 0x40];
    const out = r.out;
    console.log("PIP_CORNER", px(out, 5, x0 + 2, y0 + 2, 3), "BORDER", px(out, 5, x0 + Math.round(bw / 2), y0 + 2, 2), "CENTRE", px(out, 5, x0 + bw / 2 - 4, y0 + bh / 2 - 4, 8), "OUTSIDE", px(out, 5, 100, 100, 8));
    near(px(out, 5, x0 + 2, y0 + 2, 3), BASE, 5, "corner = base");
    near(px(out, 5, x0 + Math.round(bw / 2), y0 + 2, 2), [255, 0, 0], 8, "border");
    near(px(out, 5, x0 + bw / 2 - 4, y0 + bh / 2 - 4, 8), TOP, 5, "centre");
    near(px(out, 5, 100, 100, 8), BASE, 5, "outside");
  }, 300_000);

  it("multiply overlay", async () => {
    const d = doc([video(clip("b", "base", 0, 1)), overlay("o", clip("o", "top", 0, 1, { blendMode: "multiply" }))]);
    const r = await renderDoc(d, { ...src("base"), ...src("top") }, "mult");
    const BASE = [0x30, 0x90, 0xc0], TOP = [0xd0, 0x60, 0x40];
    const want = BASE.map((b, i) => (b * TOP[i]!) / 255);
    const got = px(r.out, 5, W / 2 - 4, H / 2 - 4, 8);
    console.log("MULTIPLY got", got, "want", want.map(Math.round));
    near(got, want, 5, "multiply");
  }, 300_000);

  it("chroma key green screen", async () => {
    const d = doc([video(clip("b", "base", 0, 1)), overlay("o", clip("o", "green", 0, 1, { chromaKey: { color: "#00B140", similarity: 0.15, blend: 0.05, spill: 0.3 } }))]);
    const r = await renderDoc(d, { ...src("base"), ...src("green") }, "chroma");
    const BASE = [0x30, 0x90, 0xc0];
    const bg = px(r.out, 5, 100, 200, 8); const subj = px(r.out, 5, W / 2 - 4, H / 2 - 4, 8);
    console.log("CHROMA background(keyed)", bg, "subject", subj);
    near(bg, BASE, 5, "green keyed out -> base");
    near(subj, [0xd0, 0x30, 0x30], 8, "subject kept");
  }, 300_000);

  it("worst case 180 s edit (slice 2 + 3 features)", async () => {
    // 30 s sources at 1080x1920 30 fps with sound
    for (const n of ["wb", "wo", "wg"]) {
      const vf = n === "wg" ? "drawbox=x=300:y=600:w=480:h=700:color=0xD03030:t=fill" : "null";
      const col = n === "wg" ? "0x00B140" : n === "wb" ? "0x3090C0" : "0xD06040";
      sh(["-f", "lavfi", "-i", `color=c=${col}:s=${W}x${H}:r=30:d=30`, "-f", "lavfi", "-i", "sine=f=440:d=30", "-vf", vf + ",noise=alls=20:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", n + ".mp4"]);
    }
    const feats = { look: { id: "teal-orange", intensity: 0.6 }, adjust: { brightness: 0.1, contrast: 1.2, saturation: 0.8, temperature: 4000, blur: 10, vignette: 0.5 } };
    const t = pipTransform({ width: W, height: H }, "bottom-right", "M");
    const frame = { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 };
    const base: unknown[] = [], mult: unknown[] = [], key: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      base.push(clip("b" + i, "wb", i * 30, 30, { ...feats }));
      mult.push(clip("m" + i, "wo", i * 30, 30, { blendMode: "multiply", transform: t, frame, fadeIn: 0.5, adjust: { brightness: 0.1, vignette: 0.3 }, look: { id: "mono" } }));
      key.push(clip("k" + i, "wg", i * 30, 30, { chromaKey: { color: "#00B140", similarity: 0.15, blend: 0.05, spill: 0.3 }, transform: { ...t, x: -t.x }, frame: { cornerRadius: 20, borderWidth: 4, borderColor: "#FFFFFF" } }));
    }
    const V = process.env.VARIANT; const d = doc([video(...base), ...(V === "key" ? [] : [overlay("om", ...mult)]), ...(V === "mult" ? [] : [overlay("ok", ...key)])]);
    const r = await renderDoc(d, { ...src("wb"), ...src("wo"), ...src("wg") }, "worst");
    const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", r.out]).stdout.toString().trim();
    console.log("WORST", JSON.stringify({ wallSec: r.wall, rssMiB: r.rssMiB, vmPeakMiB: r.vmPeakMiB, plan: r.rep.plan, weight: r.rep.weight, passes: r.rep.passes.length, outDuration: dur }));
    expect(Number(dur)).toBeGreaterThan(179.5);
    expect(r.wall).toBeLessThanOrEqual(600);
  }, 1_500_000);
});
