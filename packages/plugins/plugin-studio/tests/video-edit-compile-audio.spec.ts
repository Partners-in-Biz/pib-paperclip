import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atempoChain, buildAudioGraph } from "../src/video-edit/compile-audio.js";
import { CompileError, compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { editDuration, normalizeEdit } from "../src/video-edit/timeline.js";

const inputs: CompileInputs = {
  [inputKey("a", 1)]: { path: "in/a.mp4", kind: "video", hasAudio: true },
  [inputKey("mute", 1)]: { path: "in/mute.mp4", kind: "video", hasAudio: false },
  [inputKey("music", 1)]: { path: "in/music.m4a", kind: "audio" },
  [inputKey("vo", 1)]: { path: "in/vo.wav", kind: "audio" },
  [inputKey("logo", 1)]: { path: "in/logo.png", kind: "image" },
};
const clip = (id: string, assetId: string, start: number, inPoint: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: inPoint, out, ...extra });
const edit = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (...clips: unknown[]) => ({ id: "v", kind: "video", clips });
const audio = (id: string, ...clips: unknown[]) => ({ id, kind: "audio", clips });
const compile = (tracks: unknown[], loudnorm?: boolean) => compileVideo(edit(tracks), inputs, "out.mp4", { loudnorm });
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

describe("atempoChain", () => {
  it("keeps every step inside 0.5..2", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(0.25)).toEqual([0.5, 0.5]);
    expect(atempoChain(4)).toEqual([2, 2]);
    expect(atempoChain(3)).toEqual([2, 1.5]);
    expect(atempoChain(0.3)).toEqual([0.5, 0.6]);
    expect(atempoChain(1.5)).toEqual([1.5]);
  });
});

describe("compile audio snapshots", () => {
  it("speed 0.25: clip audio slowed with a chained atempo", () => {
    const r = compile([video(clip("c1", "a", 0, 1, 2, { speed: 0.25 }))]);
    expect(r).toMatchSnapshot();
    expect(graph(r)).toContain("[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=1,asetpts=PTS-STARTPTS,atempo=0.5,atempo=0.5,atrim=duration=4[aud0]");
    expect(r.args).toEqual(expect.arrayContaining(["-map", "[vout]", "-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]));
    expect(r.args).not.toContain("-an");
  });

  it("speed 4: clip audio sped up with a chained atempo", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 8, { speed: 4 }))]);
    expect(r).toMatchSnapshot();
    expect(graph(r)).toContain("atempo=2,atempo=2,atrim=duration=2[aud0]");
    expect(graph(r)).toContain("[aud0]apad=whole_dur=2,atrim=duration=2[aout]");
  });

  it("mixed music + voiceover + clip audio: amix normalize=0, volume, fades, delay", () => {
    const r = compile([
      video(clip("c1", "a", 0, 0, 4, { fadeIn: 0.5 }), clip("c2", "mute", 4, 0, 2)),
      audio("music", clip("m1", "music", 0, 10, 16, { volume: 0.3, fadeOut: 1 })),
      audio("voice", clip("vo1", "vo", 1.5, 0, 3, { volume: 1.5 })),
    ]);
    expect(r).toMatchSnapshot();
    const g = graph(r);
    // the muted source adds no audio input; audio inputs follow the two video inputs
    expect(r.args.filter((a) => a === "-i")).toHaveLength(5);
    expect(g).toContain("[2:a]");
    expect(g).toContain("[4:a]");
    expect(g).not.toContain("[5:a]");
    expect(g).toContain("volume=0.3,afade=t=out:st=5:d=1[aud1]");
    expect(g).toContain("volume=1.5,adelay=delays=1500:all=1[aud2]");
    expect(g).toContain("afade=t=in:st=0:d=0.5[aud0]");
    expect(g).toContain("[aud0][aud1][aud2]amix=inputs=3:duration=longest:normalize=0,apad=whole_dur=6,atrim=duration=6[aout]");
    expect(g).not.toContain("loudnorm");
  });

  it("loudnorm is optional and runs after the mix", () => {
    const r = compile([video(clip("c1", "a", 0, 0, 2)), audio("music", clip("m1", "music", 0, 0, 2))], true);
    expect(graph(r)).toContain("amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad=whole_dur=2");
  });

  it("silent edit: no audio input, no audio map, -an", () => {
    const r = compile([video(clip("c1", "mute", 0, 0, 3)), { id: "o", kind: "overlay", clips: [clip("o1", "logo", 0, 0, 1)] }, audio("empty")]);
    expect(r).toMatchSnapshot();
    expect(r.args).toContain("-an");
    expect(r.args).not.toContain("-c:a");
    expect(r.args.filter((a) => a === "-map")).toHaveLength(1);
    expect(graph(r)).not.toContain(":a]");
  });

  it("a video source without hasAudio from the probe counts as silent", () => {
    const g = buildAudioGraph(edit([video(clip("c1", "a", 0, 0, 2))]), { [inputKey("a", 1)]: { path: "a.mp4", kind: "video" } }, 1);
    expect(g).toEqual({ inputArgs: [], filters: [], outLabel: null });
  });

  it("an audio-only edit still gets a black picture and the audio", () => {
    const r = compile([audio("music", clip("m1", "music", 0, 0, 3))]);
    expect(graph(r)).toContain("color=c=black");
    expect(graph(r)).toContain("[0:a]");
    expect(editDuration(edit([audio("music", clip("m1", "music", 0, 0, 3))]))).toBe(3);
  });

  it("refuses an image or a soundless video on an audio track", () => {
    expect(errorOf(() => compile([audio("x", clip("x1", "logo", 0, 0, 1))])).message).toBe("unsupported_feature:audio_from_image");
    expect(errorOf(() => compile([audio("x", clip("x1", "mute", 0, 0, 1))])).message).toBe("unsupported_feature:audio_clip_without_audio");
    expect(errorOf(() => compile([audio("x", { ...clip("x1", "nope", 0, 0, 1) })])).message).toBe("missing_input:nope@1");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("compile audio with real ffmpeg", () => {
  it("renders clip audio at speed 0.25 and 4 mixed with music: one AAC 48 kHz stereo stream of the edit's length", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-compile-audio-"));
    try {
      const run = (args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { cwd: dir, encoding: "utf8" });
      expect(run(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-pix_fmt", "yuv420p", "-shortest", "a.mp4"]).status).toBe(0);
      expect(run(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=22050", "-t", "5", "-ac", "1", "music.m4a"]).status).toBe(0);
      const doc = edit([
        video(clip("c1", "a", 0, 0, 0.5, { speed: 0.25 }), clip("c2", "a", 2, 0, 8, { speed: 4, fadeOut: 0.3 })),
        audio("music", clip("m1", "music", 0.5, 0, 3, { volume: 0.4 })),
      ]);
      const r = compileVideo(doc, { [inputKey("a", 1)]: { path: "a.mp4", kind: "video", hasAudio: true }, [inputKey("music", 1)]: { path: "music.m4a", kind: "audio" } }, "out.mp4");
      for (const f of r.files) writeFileSync(join(dir, f.name), f.content);
      const render = spawnSync("ffmpeg", [...r.args.slice(0, 3), "-loglevel", "error", ...r.args.slice(3)], { cwd: dir, encoding: "utf8" });
      expect(render.stderr).toBe("");
      expect(render.status).toBe(0);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration:format=duration", "-of", "json", "out.mp4"], { cwd: dir, encoding: "utf8" });
      const info = JSON.parse(probe.stdout) as { streams: Record<string, string | number>[]; format: { duration: string } };
      const a = info.streams.find((s) => s.codec_type === "audio");
      expect(info.streams).toHaveLength(2);
      expect(a).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
      expect(Math.abs(Number(a?.duration) - editDuration(doc))).toBeLessThan(0.1);
      expect(Math.abs(Number(info.format.duration) - editDuration(doc))).toBeLessThan(0.1);

      const silent = compileVideo(edit([video(clip("c1", "a", 0, 0, 1))]), { [inputKey("a", 1)]: { path: "a.mp4", kind: "video", hasAudio: false } }, "silent.mp4");
      for (const f of silent.files) writeFileSync(join(dir, f.name), f.content);
      expect(spawnSync("ffmpeg", silent.args, { cwd: dir, encoding: "utf8" }).status).toBe(0);
      const sp = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", "silent.mp4"], { cwd: dir, encoding: "utf8" });
      expect((JSON.parse(sp.stdout) as { streams: unknown[] }).streams).toEqual([{ codec_type: "video" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
