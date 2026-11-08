import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompileError, compileVideo, GRAPH_FILE, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { editDuration, normalizeEdit } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("a", 1)]: { path: "in/a.mp4", kind: "video" },
  [inputKey("b", 1)]: { path: "in/b.mp4", kind: "video" },
  [inputKey("c", 2)]: { path: "in/c.mp4", kind: "video" },
  [inputKey("logo", 1)]: { path: "in/logo.png", kind: "image" },
};
const clip = (id: string, assetId: string, start: number, inPoint: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: assetId === "c" ? 2 : 1, start, in: inPoint, out, ...extra });
const edit = (tracks: unknown[], size = "9:16") => normalizeEdit({ project: { size, fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const overlay = (...clips: unknown[]) => ({ id: "o", kind: "overlay", clips });
const compile = (tracks: unknown[], size?: string) => compileVideo(edit(tracks, size), inputs, "out.mp4");
const graph = (r: { files: { name: string; content: string }[] }) => r.files[0].content;

function errorOf(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompileError) return error;
    throw error;
  }
  throw new Error("expected a CompileError");
}

describe("compileVideo snapshots", () => {
  it("one clip: trim on input, fit + pad, H.264 High encoder, faststart", () => {
    const r = compile([video(clip("c1", "a", 0, 2, 7))]);
    expect(r).toMatchSnapshot();
    expect(r.args).toEqual(expect.arrayContaining(["-ss", "2", "-t", "5", "-i", "file:in/a.mp4"]));
    expect(r.args.join(" ")).toContain("-c:v libx264 -profile:v high -preset medium -crf 20 -maxrate 6M -bufsize 12M -pix_fmt yuv420p");
    expect(r.args.slice(-3)).toEqual(["-movflags", "+faststart", "file:out.mp4"]);
    expect(graph(r)).toContain("pad=w=1080:h=1920");
  });

  it("three clips back to back: one concat", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 2), clip("c2", "b", 2, 1, 4), clip("c3", "c", 5, 0, 1))]);
    expect(r).toMatchSnapshot();
    expect(graph(r)).toContain("[seg0][seg1][seg2]concat=n=3:v=1:a=0");
    expect(r.args).toContain("6");
  });

  it("xfade: a fade transition over the overlap", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 3), clip("c2", "b", 2, 0, 3, { transitionIn: { type: "fade", duration: 1 } }), clip("c3", "c", 5, 0, 1))]);
    expect(r).toMatchSnapshot();
    expect(graph(r)).toContain("[seg0][seg1]xfade=transition=fade:duration=1:offset=2[xf3]");
    expect(graph(r)).toContain("[xf3][seg2]concat=n=2");
  });

  it("transition with nothing before it fades in from black", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 3, { transitionIn: { type: "fade", duration: 0.5 } }))]);
    expect(graph(r)).toContain("fade=t=in:st=0:d=0.5");
    expect(graph(r)).not.toContain("xfade");
  });

  it("overlay: image at x/y/scale with crop, rotation and alpha fades over the main track", () => {
    const r = compile([
      video(clip("c1", "a", 0, 0, 6)),
      overlay(clip("o1", "logo", 1, 0, 3, { fadeIn: 0.5, fadeOut: 0.25, transform: { x: -200, y: 300, scale: 0.25, rotate: 15, crop: { left: 0.1, right: 0.1 } } })),
    ]);
    expect(r).toMatchSnapshot();
    expect(r.args).toEqual(expect.arrayContaining(["-loop", "1", "-framerate", "30", "-t", "3", "-i", "file:in/logo.png"]));
    const g = graph(r);
    expect(g).toContain("setpts=PTS-STARTPTS+1/TB");
    expect(g).toContain("scale=w=270:h=480:force_original_aspect_ratio=decrease");
    expect(g).toContain("overlay=x=(W-w)/2+-200:y=(H-h)/2+300:eof_action=pass");
    expect(g).toContain("fade=t=in:st=1:d=0.5:alpha=1");
  });

  it("gaps: black lead-in, gap and tail up to the overlay's end", () => {
    const r = compile([video(clip("c1", "a", 1, 0, 2), clip("c2", "b", 4, 0, 1)), overlay(clip("o1", "logo", 0, 0, 7))]);
    expect(r).toMatchSnapshot();
    const g = graph(r);
    expect(g).toContain("color=c=black:s=1080x1920:r=30:d=1,");
    expect(g).toContain("color=c=black:s=1080x1920:r=30:d=2,");
    expect(g).toContain("[blk0][seg1][blk2][seg3][blk4]concat=n=5");
    expect(r.args).toEqual(expect.arrayContaining(["-t", "7"]));
  });

  it("speed 0.5 and 2: setpts divides, source length on input, timeline length trimmed", () => {
    const r = compile([video(clip("slow", "a", 0, 0, 2, { speed: 0.5 }), clip("fast", "b", 4, 0, 4, { speed: 2 }))]);
    expect(r).toMatchSnapshot();
    const g = graph(r);
    expect(g).toContain("setpts=(PTS-STARTPTS)/0.5,fps=30");
    expect(g).toContain("setpts=(PTS-STARTPTS)/2,fps=30");
    expect(g).toContain("trim=duration=4[seg0]");
    expect(g).toContain("trim=duration=2[seg1]");
    expect(r.args).toEqual(expect.arrayContaining(["-t", "6"]));
  });

  it("moved main clip is laid on its own black frame", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 2, { transform: { x: 50, scale: 1.5, rotate: 90 } }))], "16:9");
    const g = graph(r);
    expect(g).toContain("rotate=a=90*PI/180:ow=rotw(90*PI/180):oh=roth(90*PI/180):c=none,scale=w=2880:h=1620");
    expect(g).toContain("[blk2][shp1]overlay=x=(W-w)/2+50:y=(H-h)/2+0:eof_action=pass");
  });
});

describe("compileVideo contract", () => {
  it("returns an args array of plain strings, never a shell string; odd paths stay one argument", () => {
    const odd = { [inputKey("a", 1)]: { path: "/w/my clip; rm -rf ~ $(x).mp4", kind: "video" as const } };
    const r = compileVideo(edit([video(clip("c1", "a", 0, 0, 1))]), odd, "/w/out put.mp4");
    expect(Array.isArray(r.args)).toBe(true);
    expect(r.args.every((a) => typeof a === "string")).toBe(true);
    expect(r.args).toContain("file:/w/my clip; rm -rf ~ $(x).mp4");
    expect(r.args.at(-1)).toBe("file:/w/out put.mp4");
    expect(r.args).toEqual(expect.arrayContaining(["-filter_complex_script", GRAPH_FILE, "-map", "[vout]", "-an"]));
    expect(r.files.map((f) => f.name)).toEqual([GRAPH_FILE]);
  });

  it.each([
    ["text", [video(clip("c1", "a", 0, 0, 1)), { id: "t", kind: "text", clips: [{ id: "t1", text: "Hi", duration: 1 }] }]],
    ["caption", [{ id: "cap", kind: "caption", clips: [{ id: "k1", words: [{ text: "hi", start: 0, end: 1 }] }] }]],
    ["audio", [{ id: "m", kind: "audio", clips: [clip("m1", "a", 0, 0, 1)] }]],
    ["multiple_video_tracks", [video(clip("c1", "a", 0, 0, 1)), { id: "v2", kind: "video", clips: [clip("c2", "b", 0, 0, 1)] }]],
    ["overlay_transition", [overlay(clip("o1", "logo", 0, 0, 2, { transitionIn: { type: "fade", duration: 1 } }))]],
    ["empty_edit", [video()]],
  ])("refuses %s with unsupported_feature", (feature, tracks) => {
    const e = errorOf(() => compile(tracks as unknown[]));
    expect(e.message).toBe(`unsupported_feature:${feature}`);
    expect(e.code).toBe("unsupported_feature");
  });

  it("names a missing input", () => {
    const e = errorOf(() => compileVideo(edit([video(clip("c1", "zzz", 0, 0, 1))]), inputs, "out.mp4"));
    expect(e.message).toBe("missing_input:zzz@1");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("compileVideo with real ffmpeg", () => {
  it("renders gap + speed + xfade + moved clip + image overlay to the edit's length", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-compile-video-"));
    try {
      const run = (args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { cwd: dir, encoding: "utf8" });
      expect(run(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "3", "-pix_fmt", "yuv420p", "a.mp4"]).status).toBe(0);
      expect(run(["-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1", "logo.png"]).status).toBe(0);
      const doc = normalizeEdit({
        project: { size: "1:1", fps: 30 },
        tracks: [
          video(
            { id: "c1", assetId: "a", version: 1, start: 0, in: 0, out: 2 },
            { id: "c2", assetId: "a", version: 1, start: 2.5, in: 0, out: 2, speed: 2 },
            { id: "c3", assetId: "a", version: 1, start: 3, in: 0, out: 1, speed: 0.5, transitionIn: { type: "fade", duration: 0.5 }, transform: { x: 100, scale: 0.5, rotate: 10 } },
          ),
          overlay({ id: "o1", assetId: "logo", version: 1, start: 1, in: 0, out: 2, fadeIn: 0.3, transform: { x: -200, y: 200, scale: 0.3 } }),
        ],
      });
      const r = compileVideo(doc, { [inputKey("a", 1)]: { path: "a.mp4", kind: "video" }, [inputKey("logo", 1)]: { path: "logo.png", kind: "image" } }, "out.mp4");
      for (const f of r.files) writeFileSync(join(dir, f.name), f.content);
      const render = spawnSync("ffmpeg", [...r.args.slice(0, 3), "-loglevel", "error", ...r.args.slice(3)], { cwd: dir, encoding: "utf8" });
      expect(render.stderr).toBe("");
      expect(render.status).toBe(0);
      const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,profile,width,height,pix_fmt,nb_read_frames:format=duration", "-of", "json", "out.mp4"], { cwd: dir, encoding: "utf8" });
      const info = JSON.parse(probe.stdout) as { streams: Record<string, unknown>[]; format: { duration: string } };
      expect(info.streams).toHaveLength(1);
      expect(info.streams[0]).toMatchObject({ codec_name: "h264", profile: "High", width: 1080, height: 1080, pix_fmt: "yuv420p" });
      expect(Math.abs(Number(info.format.duration) - editDuration(doc))).toBeLessThan(0.1);
      expect(Math.abs(Number(info.streams[0].nb_read_frames) - editDuration(doc) * 30)).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
