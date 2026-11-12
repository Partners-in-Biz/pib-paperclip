/**
 * Runner `matte` mode (PAR-10126 D5b0d). Pure parts, `matte()` with fake children and the `bad_engine` exit run in CI.
 * The real runner on the fixture (tests/fixtures/face.mp4 and its reference matte, CC BY 4.0) needs a built dist/ml and
 * ffmpeg: CI skips it (PAR-10141), its output is pasted from pib-vps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChildResult, FfmpegChild } from "../src/ml/io.js";
import { decodeArgs, encodeArgs, MASK_SIZE, matte, parseMatteArgs, parseMatteProbe, toChw01, toGrey, type MatteProbe } from "../src/ml/matte.js";
import { EXIT, main } from "../src/ml/runner.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(pkg, "tests/fixtures/face.mp4");
const reference = join(pkg, "tests/fixtures/face.matte-ref.png");
const tmp = mkdtempSync(join(tmpdir(), "studio-ml-matte-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const args = ["--engine", "local-fast", "--in", "/w/src.mp4", "--from", "2", "--to", "12.5", "--out", "/w/matte.mp4"];
const probe: MatteProbe = { width: 1920, height: 1080, fps: "30000/1001", audio: "copy" };

describe("parseMatteArgs", () => {
  it("reads every flag in any order", () => {
    expect(parseMatteArgs([...args.slice(4), ...args.slice(0, 4)])).toEqual({ engine: "local-fast", input: "/w/src.mp4", from: 2, to: 12.5, out: "/w/matte.mp4" });
  });

  it("names an unknown engine bad_engine", () => {
    expect(() => parseMatteArgs(["--engine", "local-fine", ...args.slice(2)])).toThrow(expect.objectContaining({ code: "bad_engine" }));
  });

  it.each([
    [args.slice(2)],
    [args.slice(0, 8)],
    [[...args.slice(0, 8), "--out", "/w/matte.mov"]],
    [[...args.slice(0, 8), "--out", "-y.mp4"]],
    [[...args, "--engine", "local-fast"]],
    [[...args.slice(0, 4), "--from", "5", "--to", "1", "--out", "/w/m.mp4"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseMatteArgs(argv as string[])).toThrow(expect.objectContaining({ code: "usage" }));
  });
});

describe("probe, decode and encode", () => {
  const streams = (...s: object[]) => JSON.stringify({ streams: s });
  const video = { codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" };

  it("reads size, rate and how to carry the audio", () => {
    expect(parseMatteProbe(streams(video, { codec_type: "audio", codec_name: "aac" }))).toEqual(probe);
    expect(parseMatteProbe(streams({ codec_type: "audio", codec_name: "pcm_s16le" }, { ...video, side_data_list: [{ rotation: 90 }] }))).toEqual({ ...probe, width: 1080, height: 1920, audio: "aac" });
    expect(parseMatteProbe(streams({ ...video, avg_frame_rate: "0/0", r_frame_rate: "120/1" }))).toEqual({ ...probe, fps: "60/1", audio: null });
    expect(() => parseMatteProbe(streams({ ...video, avg_frame_rate: "0/0", r_frame_rate: "0/0" }))).toThrow(expect.objectContaining({ code: "bad_input" }));
    expect(() => parseMatteProbe(streams({ codec_type: "audio", codec_name: "aac" }))).toThrow(expect.objectContaining({ code: "bad_input" }));
  });

  it("decodes the range at the source rate to 256x256 RGB (golden argv)", () => {
    expect(decodeArgs(parseMatteArgs(args), probe)).toEqual([
      "-nostdin", "-v", "error", "-threads", "4", "-ss", "2", "-t", "10.5", "-i", "/w/src.mp4",
      "-an", "-sn", "-dn", "-filter_threads", "1",
      "-vf", "fps=30000/1001,scale=256:256:flags=bilinear", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ]);
  });

  it("stacks colour over matte at a capped bitrate and copies the audio (golden argv)", () => {
    expect(encodeArgs(parseMatteArgs(args), probe)).toEqual([
      "-nostdin", "-v", "error", "-y", "-threads", "4", "-ss", "2", "-t", "10.5", "-i", "/w/src.mp4",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", "256x256", "-framerate", "30000/1001", "-i", "pipe:0",
      "-filter_threads", "1", "-filter_complex",
      "[0:v:0]fps=30000/1001,format=yuv420p[c];[1:v]scale=1920:1080:flags=bilinear,format=yuv420p[m];[c][m]vstack=inputs=2:shortest=1[v]",
      "-map", "[v]", "-map", "0:a:0", "-c:a", "copy",
      "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "/w/matte.mp4",
    ]);
    const noAudio = encodeArgs(parseMatteArgs(args), { ...probe, audio: null });
    expect(noAudio).not.toContain("0:a:0");
    expect(encodeArgs(parseMatteArgs(args), { ...probe, audio: "aac" }).join(" ")).toContain("-map 0:a:0 -c:a aac -b:a 192k");
  });

  it("scales RGB to 0..1 CHW planes and alphas to grey bytes", () => {
    const chw = [...toChw01(Uint8Array.from([0, 51, 255, 255, 102, 0, 51, 0, 0, 0, 0, 0]), new Float32Array(12), 2)];
    expect(chw.map((v) => Math.round(v * 100) / 100)).toEqual([0, 1, 0.2, 0, 0.2, 0.4, 0, 0, 1, 0, 0, 0]);
    expect([...toGrey(Float32Array.from([-0.5, 0, 0.5, 1, 1.5]))]).toEqual([0, 0, 128, 255, 255]);
  });
});

describe("matte with fake children and session", () => {
  const ok: ChildResult = { exitCode: 0, signal: null, stderrTail: "" };
  const out = join(tmp, "fake.mp4");
  writeFileSync(out, Buffer.alloc(1234));
  const frame = Buffer.alloc(MASK_SIZE * MASK_SIZE * 3);
  function fakeStart(frameCount: number, exits: { decode?: ChildResult; encode?: ChildResult } = {}) {
    const written: Buffer[] = [];
    const tools: string[] = [];
    const start = (argv: string[], opts: { tool?: string; stdin?: boolean }): FfmpegChild => {
      tools.push(opts.tool ?? (opts.stdin ? "encode" : "decode"));
      if (opts.tool === "ffprobe") return { pid: 1, argv, stdin: null, stdout: Readable.from([Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 640, height: 360, avg_frame_rate: "12/1" }] }))]), done: Promise.resolve(ok) };
      if (opts.stdin) {
        const stdin = new PassThrough();
        stdin.on("data", (c: Buffer) => written.push(c));
        return { pid: 2, argv, stdin, stdout: null, done: new Promise((r) => stdin.on("end", () => r(exits.encode ?? ok))) };
      }
      return { pid: 3, argv, stdin: null, stdout: Readable.from(Array.from({ length: frameCount }, () => frame)), done: Promise.resolve(exits.decode ?? ok) };
    };
    return { start, written, tools };
  }
  const ort = { Tensor: class { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} } } as never;
  const session = { run: vi.fn(async () => ({ alphas: { data: new Float32Array(MASK_SIZE * MASK_SIZE).fill(1) } })) } as never;
  const a = { engine: "local-fast" as const, input: fixture, from: 0, to: 1, out };

  it("runs the model once per frame and writes one 256x256 grey mask per frame to the encoder", async () => {
    const f = fakeStart(3);
    const r = await matte(a, { ort, session, start: f.start });
    expect(f.tools).toEqual(["ffprobe", "encode", "decode"]);
    expect(Buffer.concat(f.written).length).toBe(3 * MASK_SIZE * MASK_SIZE);
    expect(Buffer.concat(f.written).every((b) => b === 255)).toBe(true);
    expect(r).toEqual({ ok: true, engine: "local-fast", width: 640, height: 360, fps: "12/1", frames: 3, out, bytes: 1234 });
  });

  it("names a failed encode, a failed decode, a missing input and an empty range", async () => {
    const boom: ChildResult = { exitCode: 1, signal: null, stderrTail: "boom" };
    await expect(matte(a, { ort, session, start: fakeStart(1, { encode: boom, decode: boom }).start })).rejects.toMatchObject({ code: "encode_failed" });
    await expect(matte(a, { ort, session, start: fakeStart(1, { decode: boom }).start })).rejects.toMatchObject({ code: "decode_failed" });
    await expect(matte({ ...a, input: "/nope/missing.mp4" }, { ort, session, start: fakeStart(1).start })).rejects.toMatchObject({ code: "bad_input" });
    await expect(matte(a, { ort, session, start: fakeStart(0).start })).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("runner main", () => {
  it("exits bad_engine (8) for an unknown engine before any model loads", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["matte", "--engine", "fal-veed", ...args.slice(2)])).toBe(EXIT.bad_engine);
      expect(JSON.parse(String(write.mock.calls[0]![0]))).toMatchObject({ ok: false, code: "bad_engine" });
    } finally {
      write.mockRestore();
    }
    expect(EXIT.bad_engine).toBe(8);
  });
});

const runner = join(pkg, "dist/ml/runner.mjs");
const real = !process.env.CI && existsSync(runner) && existsSync("/usr/bin/prlimit") && spawnSync("ffmpeg", ["-version"]).status === 0;

// Real process under the production containment line. CI skips it (PAR-10141); pasted from pib-vps.
describe.skipIf(!real)("runner.mjs matte (real process, after pnpm build)", () => {
  const contained = (...argv: string[]) =>
    spawnSync("/usr/bin/timeout", ["-k", "30", "600", "/usr/bin/prlimit", `--as=${6 * 1024 ** 3}`, "--fsize=209715200", "--", "/usr/bin/nice", "-n", "10", process.execPath, runner, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
  const raw = (...argv: string[]) => spawnSync("ffmpeg", ["-v", "error", ...argv, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 1 << 26 }).stdout;
  const probeStreams = (file: string) =>
    spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "json", file], { encoding: "utf8" }).stdout;

  it("writes colour over a matte that overlaps the reference by IoU >= 0.90", () => {
    const out = join(tmp, "face-matte.mp4");
    const r = contained("matte", "--engine", "local-fast", "--in", fixture, "--from", "0", "--to", "8", "--out", out);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, width: 640, height: 360, fps: "12/1", frames: 96 });
    expect(JSON.parse(probeStreams(out)).streams).toEqual([{ codec_type: "video", codec_name: "h264", width: 640, height: 720, nb_frames: "96" }]);
    const got = raw("-i", out, "-vf", "select='eq(n,12)+eq(n,48)+eq(n,84)',crop=640:360:0:360", "-fps_mode", "passthrough");
    const want = raw("-i", reference);
    expect(got.length).toBe(640 * 1080);
    expect(want.length).toBe(640 * 1080);
    const ious: number[] = [];
    for (let f = 0; f < 3; f++) {
      let inter = 0;
      let union = 0;
      for (let i = f * 640 * 360; i < (f + 1) * 640 * 360; i++) {
        const g = got[i]! >= 128;
        const w = want[i]! >= 128;
        if (g && w) inter++;
        if (g || w) union++;
      }
      ious.push(inter / union);
    }
    process.stderr.write(`matte fixture IoU per frame: ${ious.map((v) => v.toFixed(3)).join(", ")}\n`);
    for (const v of ious) expect(v).toBeGreaterThanOrEqual(0.9);
  });

  it("copies the audio stream", () => {
    const withAudio = join(tmp, "face-audio.mp4");
    expect(spawnSync("ffmpeg", ["-v", "error", "-i", fixture, "-f", "lavfi", "-i", "sine=f=440:d=8", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", withAudio]).status).toBe(0);
    const out = join(tmp, "audio-matte.mp4");
    const r = contained("matte", "--engine", "local-fast", "--in", withAudio, "--from", "1", "--to", "3", "--out", out);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const streams = JSON.parse(probeStreams(out)).streams as { codec_type: string; codec_name: string }[];
    expect(streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["video:h264", "audio:aac"]);
  });

  it("exits with named codes: bad_engine 8, bad_input 6", () => {
    const r = contained("matte", "--engine", "nope", "--in", fixture, "--from", "0", "--to", "1", "--out", join(tmp, "x.mp4"));
    expect(r.status).toBe(8);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: "bad_engine" });
    expect(contained("matte", "--engine", "local-fast", "--in", join(tmp, "missing.mp4"), "--from", "0", "--to", "1", "--out", join(tmp, "y.mp4")).status).toBe(6);
  });
});
