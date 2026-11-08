/**
 * PAR-8448 (D1e): text x/y/opacity keyframes and volume automation. Graph strings are checked exactly; real ffmpeg
 * renders check the picture (text centre, alpha) and the sound (`astats` RMS within 1 dB of the curve).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompileError, compileVideo, GRAPH_FILE, inputKey, type CompiledVideo, type CompileInputs } from "../src/video-edit/compile-video.js";
import { valueAt } from "../src/video-edit/keyframes.js";
import { normalizeEdit, type Keyframe } from "../src/video-edit/timeline.js";

const edit = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const media = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const audio = (...clips: unknown[]) => ({ id: "music", kind: "audio", clips });
const textTrack = (...clips: unknown[]) => ({ id: "t", kind: "text", clips });
const text = (extra: Record<string, unknown> = {}) => ({ id: "x1", start: 1, duration: 2, text: "H", ...extra });
const graph = (r: CompiledVideo) => r.files.find((f) => f.name === GRAPH_FILE)?.content ?? "";
const lin = (...pairs: [number, number][]) => pairs.map(([t, value]) => ({ t, value, ease: "linear" }));
const inputs: CompileInputs = {
  [inputKey("a", 1)]: { path: "in/a.mp4", kind: "video", hasAudio: true },
  [inputKey("music", 1)]: { path: "in/music.m4a", kind: "audio" },
};
const compile = (tracks: unknown[]) => compileVideo(edit(tracks), inputs, "out.mp4", { fontsDir: "/f" });

function errorOf(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CompileError) return e;
    throw e;
  }
  throw new Error("expected a CompileError");
}

describe("text keyframes", () => {
  it("x/y keys become drawtext expressions offset by the clip start", () => {
    const g = graph(compile([video(media("c1", "a", 0, 4)), textTrack(text({ keyframes: { x: lin([0, 0], [2, 100]), y: lin([1, -50]) } }))]));
    expect(g).toContain(":x='(w-text_w)/2+(if(lt(t,1),0,if(lt(t,3),0+100*((t-1)/2),100)))':");
    expect(g).toContain(":y='(h-text_h)/2+((-50))':");
    expect(g).not.toContain("alpha=");
  });

  it("alpha = keyframe opacity x fadeAlpha", () => {
    const g = graph(compile([video(media("c1", "a", 0, 4)), textTrack(text({ fadeIn: 0.5, keyframes: { opacity: lin([0, 0], [1, 1]) } }))]));
    expect(g).toContain(":alpha='(if(lt(t,1),0,if(lt(t,2),0+1*((t-1)/1),1)))*(if(lt(t,1.5),(t-1)/0.5,1))'");
    const noFade = graph(compile([video(media("c1", "a", 0, 4)), textTrack(text({ keyframes: { opacity: lin([0, 0.5]) } }))]));
    expect(noFade).toContain(":alpha='0.5'");
  });

  it("rotate keys stay text_rotate, scale keys are text_scale", () => {
    expect(errorOf(() => compile([video(media("c1", "a", 0, 4)), textTrack(text({ keyframes: { rotate: lin([0, 10]) } }))])).message).toBe("unsupported_feature:text_rotate");
    expect(errorOf(() => compile([video(media("c1", "a", 0, 4)), textTrack(text({ keyframes: { scale: lin([0, 2]) } }))])).message).toBe("unsupported_feature:text_scale");
  });
});

describe("volume keyframes", () => {
  const curve = "volume=eval=frame:volume='if(lt(t,0),0,if(lt(t,2),0+1*((t-0)/2),1))'";
  it("on an audio clip: replaces the static volume, before fades and delay", () => {
    const g = graph(compile([video(media("c1", "a", 0, 4)), audio(media("m1", "music", 1, 3, { volume: 0.4, fadeOut: 0.5, keyframes: { volume: lin([0, 0], [2, 1]) } }))]));
    expect(g).toContain(`atrim=duration=3,${curve},afade=t=out:st=2.5:d=0.5,adelay=delays=1000:all=1[aud1]`);
    expect(g).not.toContain("volume=0.4");
  });

  it("on the audio of a video clip", () => {
    const g = graph(compile([video(media("c1", "a", 0, 4, { keyframes: { volume: lin([0, 0], [2, 1]) } }))]));
    expect(g).toContain(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=4,asetpts=PTS-STARTPTS,atrim=duration=4,${curve}[aud0]`);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" drawtext ") ?? false;

describe.skipIf(!hasFfmpeg)("keyframes with real ffmpeg", () => {
  const run = (dir: string, args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { cwd: dir, encoding: "utf8" });
  const render = (dir: string, r: CompiledVideo) => {
    for (const f of r.files) writeFileSync(join(dir, f.name), f.content);
    const out = spawnSync("ffmpeg", [...r.args.slice(0, 3), "-loglevel", "error", ...r.args.slice(3)], { cwd: dir, encoding: "utf8" });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
  };
  /** RMS level (dB) of `file`'s audio over [t - 0.05, t + 0.05]. */
  const rmsAt = (dir: string, file: string, t: number) => {
    const p = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-ss", String(t - 0.05), "-t", "0.1", "-i", file, "-vn", "-af", "astats", "-f", "null", "-"], { cwd: dir, encoding: "utf8" });
    const all = [...p.stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)];
    return Number(all[all.length - 1]?.[1]);
  };

  it("volume curve on a video clip's audio and on an audio clip: level at 3 times within 1 dB", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-kf-audio-"));
    try {
      expect(run(dir, ["-f", "lavfi", "-i", "color=black:size=160x284:rate=30", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-t", "3", "-pix_fmt", "yuv420p", "-shortest", "a.mp4"]).status).toBe(0);
      expect(run(dir, ["-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000", "-t", "3", "music.m4a"]).status).toBe(0);
      const local: CompileInputs = { [inputKey("a", 1)]: { path: "a.mp4", kind: "video", hasAudio: true }, [inputKey("music", 1)]: { path: "music.m4a", kind: "audio" } };
      const silentVideo: CompileInputs = { ...local, [inputKey("a", 1)]: { path: "a.mp4", kind: "video", hasAudio: false } };
      const kfs: Keyframe[] = [{ t: 0, value: 0.2, ease: "easeInOut" }, { t: 2, value: 1, ease: "linear" }, { t: 3, value: 0.5, ease: "linear" }];
      const cases = [
        { name: "video", sources: local, tracks: (k?: unknown) => [video(media("c1", "a", 0, 3, k ? { keyframes: { volume: k } } : {}))] },
        { name: "audio", sources: silentVideo, tracks: (k?: unknown) => [video(media("c1", "a", 0, 3)), audio(media("m1", "music", 0, 3, k ? { keyframes: { volume: k } } : {}))] },
      ];
      for (const c of cases) {
        render(dir, compileVideo(edit(c.tracks()), c.sources, `${c.name}-ref.mp4`));
        render(dir, compileVideo(edit(c.tracks(kfs)), c.sources, `${c.name}-kf.mp4`));
        for (const t of [0.5, 1.5, 2.6]) {
          const expected = 20 * Math.log10(valueAt(kfs, t, 1));
          const got = rmsAt(dir, `${c.name}-kf.mp4`, t) - rmsAt(dir, `${c.name}-ref.mp4`, t);
          expect(Math.abs(got - expected), `${c.name} at ${t}s: ${got} dB vs ${expected} dB`).toBeLessThan(1);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("text x keys move the text and opacity keys x fade set its alpha", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-kf-text-"));
    try {
      expect(run(dir, ["-f", "lavfi", "-i", "color=black:size=1080x1920:rate=30", "-t", "2", "-pix_fmt", "yuv420p", "a.mp4"]).status).toBe(0);
      const doc = edit([
        video(media("c1", "a", 0, 2)),
        textTrack({ id: "x1", start: 0, duration: 2, text: "H", fontSize: 300, color: "#FFFFFF", fadeIn: 1, keyframes: { x: lin([0, -300], [2, 300]), opacity: lin([0, 0], [1, 1]) } }),
      ]);
      render(dir, compileVideo(doc, { [inputKey("a", 1)]: { path: "a.mp4", kind: "video", hasAudio: false } }, "out.mp4"));
      const W = 1080;
      const frame = (t: number) => {
        const p = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(t), "-i", "out.mp4", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { cwd: dir, maxBuffer: 1 << 26 });
        const px = p.stdout as Buffer;
        let bg = 255;
        for (const v of px) bg = Math.min(bg, v);
        let sum = 0;
        let sx = 0;
        let mass = 0;
        for (let i = 0; i < px.length; i++) {
          const v = px[i]! - bg;
          sum += v;
          if (v > 8) { sx += (i % W) * v; mass += v; }
        }
        return { sum, cx: mass ? sx / mass : NaN };
      };
      const full = frame(1.5); // opacity 1, fade done
      const early = frame(0.5); // opacity 0.5 x fade 0.5 = 0.25
      expect(Math.abs(full.cx - (W / 2 + valueAt(lin([0, -300], [2, 300]) as Keyframe[], 1.5, 0)))).toBeLessThan(W * 0.01);
      expect(Math.abs(early.cx - (W / 2 + valueAt(lin([0, -300], [2, 300]) as Keyframe[], 0.5, 0)))).toBeLessThan(W * 0.01);
      expect(early.sum / full.sum).toBeGreaterThan(0.2);
      expect(early.sum / full.sum).toBeLessThan(0.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
