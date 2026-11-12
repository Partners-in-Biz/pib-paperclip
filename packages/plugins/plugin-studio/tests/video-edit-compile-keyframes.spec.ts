import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { valueAt } from "../src/video-edit/keyframes.js";
import { normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";

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

describe("keyframed x/y/scale/rotate: compiled graph", () => {
  it("x/y keys on an identity main clip: static shape, per-frame overlay position at offset 0", () => {
    const g = graphOf(doc([video(clip("c1", "box", 0, 3, { keyframes: { x: [k(0, -100), k(3, 100, "easeOut")], y: [k(1, 50, "hold"), k(2, 0)] } }))]));
    expect(g).toMatchSnapshot();
    expect(g).toContain("x='(W-w)/2+if(lt(t,0),(-100),");
    expect(g).toContain(":eval=frame:eof_action=pass");
    expect(g).not.toContain("pad=");
  });

  it("scale + rotate keys on a main clip: fit, diagonal transparent canvas, per-frame scale", () => {
    const g = graphOf(doc([video(clip("c1", "box", 0, 3, { keyframes: { scale: [k(0, 0.5), k(3, 1)], rotate: [k(0, 0, "easeIn"), k(3, 90)] } }))]));
    expect(g).toMatchSnapshot();
    expect(g).toContain("rotate=a='(if(lt(t,0),0,");
    expect(g).toContain(":ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0,scale=w='max(2,iw*(if(lt(t,0),0.5,");
    expect(g).toContain("))))':eval=frame[shp");
  });

  it("scale keys only with a static rotation keep the rotated-box fit at scale 1", () => {
    const g = graphOf(doc([video(clip("c1", "box", 0, 3, { transform: { rotate: 15 }, keyframes: { scale: [k(0, 0.2), k(2, 0.4)] } }))]));
    expect(g).toMatchSnapshot();
    expect(g).toContain("rotate=a=15*PI/180:ow=rotw(15*PI/180):oh=roth(15*PI/180):c=black@0,scale=w=1080:h=1920:");
  });

  it("overlay clip: every expression sits on the timeline clock at the clip's start", () => {
    const g = graphOf(doc([video(clip("b", "blk", 0, 4)), overlay(clip("o1", "box", 1.5, 2, { fadeOut: 0.3, keyframes: { x: [k(0, 0), k(2, 300)], y: [k(0, 0), k(2, -300)], scale: [k(0, 0.3), k(2, 0.6)], rotate: [k(0, 0), k(2, 45)] } }))]));
    expect(g).toMatchSnapshot();
    expect(g).toContain("setpts=PTS-STARTPTS+1.5/TB");
    expect(g.match(/lt\(t,1\.5\)/g)?.length).toBe(5); // x, y, rotate, scale w and h
    expect(g).toContain("x='(W-w)/2+if(lt(t,1.5),0,");
  });

  it("keyframes are applied to the segment before it enters xfade", () => {
    const g = graphOf(doc([
      video(clip("c1", "blk", 0, 3), clip("c2", "box", 2, 3, { transitionIn: { type: "fade", duration: 1 }, keyframes: { x: [k(0, 0), k(3, 100)] } })),
    ]));
    const lines = g.split(";\n");
    const keyed = lines.findIndex((l) => l.includes(":eval=frame"));
    const xfade = lines.findIndex((l) => l.includes("xfade="));
    expect(keyed).toBeGreaterThan(-1);
    expect(xfade).toBeGreaterThan(keyed);
    expect(lines[xfade]).toContain(`[${/\[(seg\d+)\]$/.exec(lines[keyed])![1]}]xfade=transition=fade:duration=1:offset=2`);
  });

  it("keyframed and plain edits both cap filter threads (PAR-10432)", () => {
    for (const c of [clip("c1", "box", 0, 3, { keyframes: { x: [k(0, 0), k(3, 9)] } }), clip("c1", "box", 0, 3, { transform: { x: 9 } })]) {
      const args = compileVideo(doc([video(c)]), inputs, "out.mp4").args;
      expect(args.slice(args.indexOf("-filter_complex_script") - 2, args.indexOf("-filter_complex_script"))).toEqual(["-filter_complex_threads", "4"]);
    }
  });

  it("an unkeyed clip with the same transform compiles exactly as before (no eval=frame, no black@0)", () => {
    const g = graphOf(doc([video(clip("c1", "box", 0, 3, { transform: { x: 10, rotate: 15, scale: 0.5 } })), overlay(clip("o1", "box", 0, 3, { transform: { rotate: 5 } }))]));
    expect(g).not.toContain("eval=frame");
    expect(g).not.toContain("black@0");
    expect(g).toContain("x=(W-w)/2+10:y=(H-h)/2+0:eof_action=pass");
  });
});

// Real render. A 2:1 white box on black is measured per frame from image moments: the weighted centroid gives the centre,
// the major-axis variance the length (L^2/12 for a rectangle), the principal axis the angle. Moments ignore the xfade
// blend weight, so the same check works inside a transition window.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const W = 1080;
const H = 1920;

interface Shape { cx: number; cy: number; length: number; angle: number }
function measure(gray: Buffer): Shape {
  let m = 0, sx = 0, sy = 0;
  for (let i = 0; i < gray.length; i++) {
    const w = gray[i]! - 30;
    if (w <= 0) continue;
    m += w; sx += w * (i % W); sy += w * Math.floor(i / W);
  }
  const cx = sx / m, cy = sy / m;
  let m20 = 0, m02 = 0, m11 = 0;
  for (let i = 0; i < gray.length; i++) {
    const w = gray[i]! - 30;
    if (w <= 0) continue;
    const dx = (i % W) - cx, dy = Math.floor(i / W) - cy;
    m20 += w * dx * dx; m02 += w * dy * dy; m11 += w * dx * dy;
  }
  m20 /= m; m02 /= m; m11 /= m;
  const major = (m20 + m02) / 2 + Math.sqrt(((m20 - m02) / 2) ** 2 + m11 ** 2);
  return { cx, cy, length: Math.sqrt(12 * major), angle: (0.5 * Math.atan2(2 * m11, m20 - m02) * 180) / Math.PI };
}

/** What `valueAt` says the box looks like `local` seconds into the clip; `fit` = rendered box length at scale 1. */
function expected(c: MediaClip, local: number, fit: number): Shape {
  const kf = c.keyframes ?? {};
  const t = c.transform;
  return {
    cx: W / 2 + valueAt(kf.x, local, t.x),
    cy: H / 2 + valueAt(kf.y, local, t.y),
    length: fit * valueAt(kf.scale, local, t.scale),
    angle: valueAt(kf.rotate, local, t.rotate),
  };
}

function expectClose(got: Shape, want: Shape, label: string) {
  const turn = ((((got.angle - want.angle) % 180) + 270) % 180) - 90; // principal axis is mod 180
  const report = `${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  expect(Math.abs(got.cx - want.cx), report).toBeLessThan(0.01 * W);
  expect(Math.abs(got.cy - want.cy), report).toBeLessThan(0.01 * H);
  expect(Math.abs(got.length - want.length), report).toBeLessThan(0.01 * W);
  // The box end moves (L/2) * angle error: keep that within 1% of the frame too.
  expect((want.length / 2) * Math.abs((turn * Math.PI) / 180), report).toBeLessThan(0.01 * W);
}

async function ffmpeg(args: string[], cwd: string) {
  const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd, timeoutSec: 300 }).done;
  expect(res.stderrTail).toBe("");
  expect(res.outcome).toBe("ok");
}

async function render(d: EditDoc): Promise<{ dir: string; frame: (n: number) => Buffer }> {
  const dir = mkdtempSync(join(tmpdir(), "studio-kf-"));
  await ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=200x100:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "box.mp4"], dir);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=200x100:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "blk.mp4"], dir);
  const compiled = compileVideo(d, inputs, "out.mp4");
  for (const f of compiled.files) writeFileSync(join(dir, f.name), f.content);
  await ffmpeg(compiled.args.slice(3), dir); // drop -hide_banner -nostdin -y, ffmpeg() adds its own
  const frame = (n: number) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", "out.mp4", "-vf", `select='eq(n,${n})'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { cwd: dir, maxBuffer: 1 << 23 });
    expect(r.stdout.length).toBe(W * H);
    return r.stdout;
  };
  return { dir, frame };
}

describe.skipIf(!hasFfmpeg)("keyframed x/y/scale/rotate with real ffmpeg (pixel probe vs valueAt, 1% of frame)", () => {
  it("main track: first frame, mid-clip and inside both transition windows", async () => {
    const d = doc([video(
      clip("b", "box", 0, 3, { keyframes: { x: [k(0, -150), k(3, 150)], y: [k(0, 100, "easeInOut"), k(3, -100)], scale: [k(0, 0.25, "easeOut"), k(1.5, 0.4), k(3, 0.3)], rotate: [k(0, 0, "easeIn"), k(3, 60)] } }),
      clip("gap", "blk", 2, 3, { transitionIn: { type: "fade", duration: 1 } }),
      clip("d", "box", 4, 3, { transitionIn: { type: "fade", duration: 1 }, transform: { y: 50 }, keyframes: { x: [k(0, 200, "easeInOut"), k(3, -200)], scale: [k(0, 0.3)], rotate: [k(0, -30, "hold"), k(1, 20), k(3, 20)] } }),
    )]);
    const [b, , dd] = d.tracks[0]!.clips as MediaClip[];
    const { dir, frame } = await render(d);
    try {
      // 200x100 fits 1080x1920 as 1080x540: length 1080 at scale 1. Frame n is at n/30 s.
      const probes: [MediaClip, number, string][] = [[b!, 0, "b first frame"], [b!, 45, "b mid"], [b!, 72, "b in out-window 2-3 s"], [dd!, 135, "d in in-window 4-5 s"], [dd!, 165, "d mid"], [dd!, 195, "d late"]];
      for (const [c, n, label] of probes) expectClose(measure(frame(n)), expected(c, n / 30 - c.start, 1080), label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("overlay track with a static rotation: first frame, mid-clip, inside the alpha fade-out", async () => {
    const d = doc([video(clip("bg", "blk", 0, 3)), overlay(clip("o1", "box", 0.5, 2, { fadeOut: 0.3, transform: { rotate: 15 }, keyframes: { x: [k(0, -100), k(2, 100)], y: [k(0, 0), k(1, -150, "easeOut"), k(2, 0)], scale: [k(0, 0.2, "easeIn"), k(2, 0.35)] } }))]);
    const o = d.tracks[1]!.clips[0] as MediaClip;
    const { dir, frame } = await render(d);
    try {
      // Static rotation keeps today's fit: the 15 degree box's bounding box (219.1 x 148.4 for 200x100) fits 1080 wide.
      const fit = 200 * (1080 / (200 * Math.cos(Math.PI / 12) + 100 * Math.sin(Math.PI / 12)));
      for (const [n, label] of [[15, "first frame"], [45, "mid"], [72, "in fade-out"]] as const) expectClose(measure(frame(n)), expected(o, n / 30 - o.start, fit), label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
