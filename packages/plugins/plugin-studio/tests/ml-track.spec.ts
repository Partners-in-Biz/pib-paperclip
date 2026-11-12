/**
 * Runner `track` mode (PAR-10126 D5b0c). Pure parts and `track()` with a fake decoder and session run in CI. The real
 * runner on the fixture (tests/fixtures/face.mp4, CC BY 4.0) needs a built dist/ml and ffmpeg: CI skips it (PAR-10141),
 * its output is pasted from pib-vps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHILD_BINS, childArgv, type ChildResult, type FfmpegChild } from "../src/ml/io.js";
import { RunnerError } from "../src/ml/errors.js";
import { decodeArgs, decodeYunet, frames, INPUT_SIZE, letterbox, nms, parseProbe, parseTrackArgs, probeArgs, toChw, toSource, track, type Box } from "../src/ml/track.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(pkg, "tests/fixtures/face.mp4");

/** YuNet-shaped outputs, all zero except one anchor on stride 32 (a face centred on cell r,c of size w x h px). */
function yunetOut(face?: { r: number; c: number; w: number; h: number; score?: number }) {
  const out: Record<string, { data: Float32Array }> = {};
  for (const s of [8, 16, 32]) {
    const n = (INPUT_SIZE / s) ** 2;
    out[`cls_${s}`] = { data: new Float32Array(n) };
    out[`obj_${s}`] = { data: new Float32Array(n) };
    out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
  }
  if (face) {
    const idx = face.r * (INPUT_SIZE / 32) + face.c;
    out.cls_32!.data[idx] = face.score ?? 0.9;
    out.obj_32!.data[idx] = face.score ?? 0.9;
    out.bbox_32!.data.set([0.5, 0.5, Math.log(face.w / 32), Math.log(face.h / 32)], idx * 4);
  }
  return out;
}

describe("parseTrackArgs", () => {
  it("reads --in, --from and --to in any order", () => {
    expect(parseTrackArgs(["--to", "12.5", "--in", "/w/src.mp4", "--from", "2"])).toEqual({ input: "/w/src.mp4", from: 2, to: 12.5 });
  });

  it.each([
    [[]],
    [["--in", "/a.mp4", "--from", "1"]],
    [["--in", "/a.mp4", "--from", "-1", "--to", "2"]],
    [["--in", "/a.mp4", "--from", "3", "--to", "2"]],
    [["--in", "-i", "--from", "0", "--to", "2"]],
    [["--in", "/a.mp4", "--from", "0", "--to", "2", "--x", "1"]],
    [["--in", "/a.mp4", "--in", "/b.mp4", "--from", "0", "--to", "2"]],
    [["--in", "/a.mp4", "--from", "0", "--to", "601"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseTrackArgs(argv as string[])).toThrow(expect.objectContaining({ code: "usage" }));
  });
});

describe("probe and decode", () => {
  it("swaps width and height for a 90 or 270 degree rotation", () => {
    expect(parseProbe(JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }))).toEqual({ width: 1920, height: 1080 });
    expect(parseProbe(JSON.stringify({ streams: [{ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }] }))).toEqual({ width: 1080, height: 1920 });
    expect(parseProbe(JSON.stringify({ streams: [{ width: 1920, height: 1080, tags: { rotate: "270" } }] }))).toEqual({ width: 1080, height: 1920 });
    expect(() => parseProbe("{}")).toThrow(expect.objectContaining({ code: "bad_input" }));
    expect(() => parseProbe("not json")).toThrow(RunnerError);
  });

  it("letterboxes into 640x640, top-left", () => {
    expect(letterbox(1920, 1080)).toEqual({ sw: 640, sh: 360 });
    expect(letterbox(1080, 1920)).toEqual({ sw: 360, sh: 640 });
  });

  it("decodes the range at 5 fps to 640x640 BGR on one filter thread (golden argv)", () => {
    expect(decodeArgs({ input: "/w/src.mp4", from: 1.25, to: 61.25 }, { width: 1920, height: 1080 })).toEqual([
      "-nostdin", "-v", "error", "-threads", "4",
      "-ss", "1.25", "-t", "60", "-i", "/w/src.mp4",
      "-an", "-sn", "-dn", "-filter_threads", "1",
      "-vf", "fps=5,scale=640:360:flags=bilinear,pad=640:640:0:0:black",
      "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1",
    ]);
    expect(childArgv(probeArgs("/w/src.mp4"), { tool: "ffprobe" }).slice(0, 6)).toEqual(["/usr/bin/prlimit", "--as=2147483648", "--fsize=209715200", "--", CHILD_BINS.ffprobe, "-hide_banner"]);
  });

  it("splits a raw stream into whole frames and drops a short tail", async () => {
    const chunks = [Buffer.from([1, 2]), Buffer.from([3, 4, 5]), Buffer.from([6, 7])];
    const got: number[][] = [];
    for await (const f of frames(Readable.from(chunks), 3)) got.push([...f]);
    expect(got).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("turns HWC BGR into CHW planes", () => {
    expect([...toChw(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), new Float32Array(12), 2)]).toEqual([1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 12]);
  });
});

describe("YuNet decoding", () => {
  it("decodes one anchor to a box in input pixels", () => {
    const [b, ...rest] = decodeYunet(yunetOut({ r: 5, c: 10, w: 64, h: 80 }));
    expect(rest).toEqual([]);
    expect(b!.x).toBeCloseTo(10.5 * 32 - 32);
    expect(b!.y).toBeCloseTo(5.5 * 32 - 40);
    expect(b!.w).toBeCloseTo(64);
    expect(b!.h).toBeCloseTo(80);
    expect(b!.score).toBeCloseTo(0.9);
  });

  it("drops scores under 0.7 and returns nothing for an empty frame", () => {
    expect(decodeYunet(yunetOut())).toEqual([]);
    expect(decodeYunet(yunetOut({ r: 5, c: 10, w: 64, h: 80, score: 0.6 }))).toEqual([]);
  });

  it("keeps the best of overlapping boxes, best score first", () => {
    const a: Box = { x: 0, y: 0, w: 100, h: 100, score: 0.8 };
    const b: Box = { x: 5, y: 5, w: 100, h: 100, score: 0.95 };
    const c: Box = { x: 300, y: 300, w: 50, h: 50, score: 0.9 };
    expect(nms([a, b, c])).toEqual([b, c]);
  });

  it("maps a letterboxed box to source pixels and clips it to the picture", () => {
    expect(toSource({ x: 100, y: 50, w: 64, h: 80, score: 0.91234 }, { width: 1920, height: 1080 })).toEqual({ x: 300, y: 150, w: 192, h: 240, score: 0.912 });
    expect(toSource({ x: 600, y: 340, w: 80, h: 80, score: 0.9 }, { width: 1920, height: 1080 })).toEqual({ x: 1800, y: 1020, w: 120, h: 60, score: 0.9 });
    expect(toSource({ x: 600, y: 500, w: 40, h: 40, score: 0.9 }, { width: 1920, height: 1080 })).toBeNull();
  });
});

describe("track with a fake decoder and session", () => {
  const ok: ChildResult = { exitCode: 0, signal: null, stderrTail: "" };
  const frame = Buffer.alloc(INPUT_SIZE * INPUT_SIZE * 3);
  function fakeStart(frameCount: number, decodeExit: ChildResult = ok) {
    const calls: string[][] = [];
    const start = (args: string[], opts: { tool?: string }): FfmpegChild => {
      calls.push([opts.tool ?? "ffmpeg", ...args]);
      const probe = opts.tool === "ffprobe";
      const data = probe ? [Buffer.from(JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }))] : Array.from({ length: frameCount }, () => frame);
      return { pid: 1, argv: args, stdin: null, stdout: Readable.from(data), done: Promise.resolve(probe ? ok : decodeExit) };
    };
    return { start, calls };
  }
  const ort = { Tensor: class { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} } } as never;

  it("prints fps, source size and one sample per frame in source pixels", async () => {
    const { start, calls } = fakeStart(3);
    let n = 0;
    const session = { run: async () => (n++ === 1 ? yunetOut() : yunetOut({ r: 5, c: 10, w: 64, h: 80 })) } as never;
    const t = await track({ input: fixture, from: 2, to: 2.6 }, { ort, session, start });
    expect(calls.map((c) => c[0])).toEqual(["ffprobe", "ffmpeg"]);
    expect(t).toMatchObject({ fps: 5, width: 1920, height: 1080 });
    expect(t.samples.map((s) => s.t)).toEqual([2, 2.2, 2.4]);
    expect(t.samples[1]!.boxes).toEqual([]);
    expect(t.samples[0]!.boxes).toEqual([{ x: 912, y: 408, w: 192, h: 240, score: 0.9 }]);
  });

  it("names a failed decode, a missing input and an empty range", async () => {
    const session = { run: async () => yunetOut() } as never;
    await expect(track({ input: fixture, from: 0, to: 1 }, { ort, session, start: fakeStart(1, { exitCode: 1, signal: null, stderrTail: "boom" }).start })).rejects.toMatchObject({ code: "decode_failed" });
    await expect(track({ input: "/nope/missing.mp4", from: 0, to: 1 }, { ort, session, start: fakeStart(1).start })).rejects.toMatchObject({ code: "bad_input" });
    await expect(track({ input: fixture, from: 0, to: 1 }, { ort, session, start: fakeStart(0).start })).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("fixture", () => {
  it("is a small licensed clip", () => {
    expect(statSync(fixture).size).toBeLessThanOrEqual(500 * 1024);
    expect(existsSync(`${fixture}.LICENSE`)).toBe(true);
  });
});

const runner = join(pkg, "dist/ml/runner.mjs");
const real = !process.env.CI && existsSync(runner) && existsSync("/usr/bin/prlimit") && spawnSync("ffmpeg", ["-version"]).status === 0;

// Real process under the production containment line. CI skips it (PAR-10141); pasted from pib-vps.
describe.skipIf(!real)("runner.mjs track (real process, after pnpm build)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "studio-ml-track-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const contained = (...args: string[]) =>
    spawnSync("/usr/bin/timeout", ["-k", "30", "300", "/usr/bin/prlimit", `--as=${6 * 1024 ** 3}`, "--fsize=209715200", "--", "/usr/bin/nice", "-n", "10", process.execPath, runner, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });

  it("finds a face in at least 95% of the fixture's samples", () => {
    const r = contained("track", "--in", fixture, "--from", "0", "--to", "8");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { fps: number; width: number; height: number; samples: { t: number; boxes: Box[] }[] };
    expect(out).toMatchObject({ fps: 5, width: 640, height: 360 });
    expect(out.samples.length).toBeGreaterThanOrEqual(39);
    const hits = out.samples.filter((s) => s.boxes.length > 0).length;
    expect(hits / out.samples.length).toBeGreaterThanOrEqual(0.95);
    for (const b of out.samples.flatMap((s) => s.boxes)) expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= 640 && b.y + b.h <= 360).toBe(true);
    process.stderr.write(`track fixture: ${hits}/${out.samples.length} samples with a face\n`);
  });

  it("prints empty boxes and exits 0 when there is no face", () => {
    const blank = join(tmp, "blank.mp4");
    expect(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=10", "-t", "2", "-pix_fmt", "yuv420p", blank]).status).toBe(0);
    const r = contained("track", "--in", blank, "--from", "0", "--to", "2");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { samples: { boxes: Box[] }[] };
    expect(out.samples.length).toBe(10);
    expect(out.samples.every((s) => s.boxes.length === 0)).toBe(true);
  });

  it("exits with named codes: usage 2, bad_input 6", () => {
    expect(contained("track", "--in", fixture).status).toBe(2);
    const r = contained("track", "--in", join(tmp, "missing.mp4"), "--from", "0", "--to", "1");
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: "bad_input" });
  });
});
