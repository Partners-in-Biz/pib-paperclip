import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { valueAt } from "../src/video-edit/keyframes.js";
import { clipDuration, normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("box", 1)]: { path: "box.mp4", kind: "video" },
  [inputKey("blk", 1)]: { path: "blk.mp4", kind: "video" },
};
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const k = (t: number, value: number, ease = "linear") => ({ t, value, ease });
const doc = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const graphOf = (d: EditDoc) => compileVideo(d, inputs, "out.mp4").files[0].content;

describe("opacity keyframes: compiled graph", () => {
  it("overlay clip: sendcmd drives colorchannelmixer aa after the alpha fades, over the clip's timeline interval", () => {
    const g = graphOf(doc([video(clip("b", "blk", 0, 4)), overlay(clip("o1", "box", 1.5, 2, { fadeIn: 0.5, keyframes: { opacity: [k(0, 0), k(2, 1, "easeIn")] } }))]));
    expect(g).toMatchSnapshot();
    // Escaped for filtergraph + option parsing; sendcmd then sees: 1.5-3.5 [expr] colorchannelmixer@op0 aa 'clip(if(lt((TI*2),0),0,...),0,1)'
    expect(g).toContain(":alpha=1,format=rgba,sendcmd=c=1.5-3.5 \\[expr\\] colorchannelmixer@op0 aa \\\\\\'clip(if(lt((TI*2)\\,0)\\,0\\,");
    expect(g).toContain("\\,0\\,1)\\\\\\',colorchannelmixer@op0[ov");
    expect(g).toContain("x=(W-w)/2+0:y=(H-h)/2+0:eof_action=pass"); // position stays static
  });

  it("identity main clip with opacity keys leaves the letterbox path for alpha over its black frame, fades after", () => {
    const g = graphOf(doc([video(clip("c1", "box", 0, 3, { fadeOut: 1, keyframes: { opacity: [k(0, 1), k(3, 0.2)] } }))]));
    expect(g).toMatchSnapshot();
    expect(g).not.toContain("pad=");
    expect(g).toMatch(/format=rgba,sendcmd=c=0-3 \\\[expr\\\] colorchannelmixer@op0 aa [^\n]*,colorchannelmixer@op0\[shp\d+\]/);
    expect(g).toContain(":eof_action=pass,format=yuv420p,setsar=1,fade=t=out:st=2:d=1,trim=duration=3");
  });

  it("each keyed clip gets its own mixer name; time is TI, never T or PTS; no geq", () => {
    const op = { keyframes: { opacity: [k(0, 0), k(1, 1)] } };
    const g = graphOf(doc([video(clip("c1", "box", 0, 2, op), clip("c2", "box", 2, 2, op)), overlay(clip("o1", "box", 0.5, 1, op))]));
    for (const n of [0, 1, 2]) expect(g.match(new RegExp(`colorchannelmixer@op${n}\\b`, "g"))).toHaveLength(2);
    expect(g).not.toContain("colorchannelmixer@op3");
    const cmds = g.match(/sendcmd=c=[^\n]*?colorchannelmixer@op\d+(?=\[)/g)!;
    expect(cmds).toHaveLength(3);
    for (const c of cmds) expect(c).not.toMatch(/\bT\b|PTS/);
    expect(g).not.toContain("geq");
  });

  it("opacity keys alone keep today's thread count and static overlay position", () => {
    const args = compileVideo(doc([video(clip("c1", "box", 0, 3, { keyframes: { opacity: [k(0, 0), k(3, 1)] } }))]), inputs, "out.mp4").args;
    expect(args).not.toContain("-filter_complex_threads");
    expect(graphOf(doc([video(clip("c1", "box", 0, 3))]))).not.toContain("sendcmd");
  });
});

// Real render: a white box over black. Gray at the box centre is 255 x (keyframe opacity x fade alpha).
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;

async function ffmpeg(args: string[], cwd: string) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}

async function centreGray(d: EditDoc, frames: number[]): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), "studio-op-"));
  try {
    await ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=200x100:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "box.mp4"], dir);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=200x100:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "blk.mp4"], dir);
    const compiled = compileVideo(d, inputs, "out.mp4");
    for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
    await ffmpeg(compiled.args.slice(3), dir);
    return frames.map((n) => {
      const r = spawnSync("ffmpeg", ["-v", "error", "-i", "out.mp4", "-vf", `select='eq(n,${n})'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { cwd: dir, maxBuffer: 1 << 23 });
      expect(r.stdout.length).toBe(W * H);
      let sum = 0;
      for (let y = H / 2 - 10; y < H / 2 + 10; y++) for (let x = W / 2 - 10; x < W / 2 + 10; x++) sum += r.stdout[y * W + x]!;
      return sum / 400;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Linear fade alpha of `c` at clip-local `local` seconds (fade in from 0, fade out to 0). */
function fadeAlpha(c: MediaClip, local: number): number {
  const len = clipDuration(c);
  const fin = c.fadeIn > 0 ? Math.min(1, Math.max(0, local / c.fadeIn)) : 1;
  const fout = c.fadeOut > 0 ? Math.min(1, Math.max(0, (len - local) / c.fadeOut)) : 1;
  return fin * fout;
}

function expectAlpha(c: MediaClip, frames: number[], got: number[]) {
  frames.forEach((n, i) => {
    const local = n / 30 - c.start;
    const op = valueAt(c.keyframes?.opacity, local, 1);
    const want = op * fadeAlpha(c, local);
    const report = `frame ${n} (local ${local.toFixed(3)} s): opacity ${op.toFixed(3)} x fade ${fadeAlpha(c, local).toFixed(3)}, got gray ${got[i]!.toFixed(1)}`;
    expect(op).toBeGreaterThan(0.05); // probes sit where the keyframes matter
    expect(Math.abs(got[i]! / 255 - want), report).toBeLessThan(0.03);
  });
}

describe.skipIf(!hasFfmpeg)("opacity keyframes with real ffmpeg (alpha = keyframe opacity x fade alpha)", () => {
  it("overlay track: inside the fade-in, mid-clip, inside the fade-out", async () => {
    const d = doc([video(clip("bg", "blk", 0, 4)), overlay(clip("o1", "box", 0.5, 2.5, { fadeIn: 1, fadeOut: 0.5, keyframes: { opacity: [k(0, 1), k(1, 0.4), k(2, 0.8, "easeOut")] } }))]);
    const o = d.tracks[1]!.clips[0] as MediaClip;
    const frames = [30, 60, 81]; // local 0.5 s, 1.5 s, 2.2 s
    expectAlpha(o, frames, await centreGray(d, frames));
  }, 120_000);

  it("main track: inside the fade-in, mid-clip, inside the fade-out", async () => {
    const d = doc([video(clip("c1", "box", 0, 3, { fadeIn: 1, fadeOut: 1, keyframes: { opacity: [k(0, 0.3), k(1.5, 1, "easeInOut"), k(3, 0.5)] } }))]);
    const c = d.tracks[0]!.clips[0] as MediaClip;
    const frames = [15, 45, 75]; // local 0.5 s, 1.5 s, 2.5 s
    expectAlpha(c, frames, await centreGray(d, frames));
  }, 120_000);

  // PAR-10121 acceptance: keys 0 -> 1 over 0-2 s, probes at 0.2 s, 1 s, 5 s (5 s sits inside a 2 s fade-out).
  const ramp = { fadeOut: 2, keyframes: { opacity: [k(0, 0), k(2, 1)] } };
  const acceptanceFrames = [6, 30, 150];

  it("acceptance, main track: 0 -> 1 over 0-2 s, probes at 0.2 s, 1 s, 5 s", async () => {
    const d = doc([video(clip("c1", "box", 0, 6, ramp))]);
    expectAlpha(d.tracks[0]!.clips[0] as MediaClip, acceptanceFrames, await centreGray(d, acceptanceFrames));
  }, 120_000);

  it("acceptance, overlay track: 0 -> 1 over 0-2 s, probes at 0.2 s, 1 s, 5 s", async () => {
    const d = doc([video(clip("bg", "blk", 0, 6)), overlay(clip("o1", "box", 0, 6, ramp))]);
    expectAlpha(d.tracks[1]!.clips[0] as MediaClip, acceptanceFrames, await centreGray(d, acceptanceFrames));
  }, 120_000);
});
