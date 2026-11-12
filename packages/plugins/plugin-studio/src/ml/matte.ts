/**
 * Runner mode `matte` (PAR-10126 D5b0d): a person matte for a source range, the input to the cut-out composite.
 *
 *   node dist/ml/runner.mjs matte --engine local-fast --in <file> --from <s> --to <s> --out <file.mp4>
 *
 * `--out` gets one H.264 MP4 twice the source height: the colour picture on top, the grey matte below (white = person),
 * audio copied (re-encoded to AAC only when MP4 cannot carry the source codec). Storage takes MP4/MOV only and H.264 has
 * no alpha, hence the stacked file. Three children through `io.ts` (own prlimit, same process group): ffprobe; a decoder
 * that writes 256x256 RGB frames to the runner, which runs MediaPipe selfie segmentation (`selfie-segmentation.onnx`)
 * per frame; and an encoder that reads the source itself for colour and audio and the masks from stdin. Both video
 * chains use the same `fps` filter, so frame N of the matte belongs to frame N of the colour. stdout is one JSON line:
 *
 *   {"ok":true,"engine":"local-fast","width":1920,"height":1080,"fps":"30/1","frames":1800,"out":"/w/matte.mp4","bytes":51234567}
 */
import { existsSync, statSync } from "node:fs";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import type { Writable } from "node:stream";
import { RunnerError } from "./errors.js";
import { startFfmpeg, type ChildOptions, type FfmpegChild } from "./io.js";
import { childFailed, frames, parseProbe, parseTrackArgs, readAll, type TrackArgs } from "./track.js";

/** Matting engines this runner knows; anything else exits `bad_engine`. */
export const ENGINES = ["local-fast"] as const;
export type Engine = (typeof ENGINES)[number];
export const MASK_SIZE = 256;
/** Highest frame rate kept; a faster source is resampled (both chains alike). */
export const MAX_FPS = 60;
/** Audio codecs the MP4 muxer takes as they are. */
const MP4_AUDIO = new Set(["aac", "mp3", "opus", "ac3", "eac3", "alac", "flac"]);

export interface MatteArgs extends TrackArgs {
  engine: Engine;
  out: string;
}

/** `--engine <e> --in <file> --from <s> --to <s> --out <file.mp4>` in any order. */
export function parseMatteArgs(argv: string[]): MatteArgs {
  const rest: string[] = [];
  let engine: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i]!, argv[i + 1]];
    if ((key === "--engine" || key === "--out") && value !== undefined) {
      if ((key === "--engine" ? engine : out) !== undefined) throw new RunnerError("usage", `bad argument ${key}`);
      if (key === "--engine") engine = value;
      else out = value;
    } else rest.push(key, ...(value === undefined ? [] : [value]));
  }
  const range = parseTrackArgs(rest);
  if (!out || out.startsWith("-") || !out.endsWith(".mp4")) throw new RunnerError("usage", "--out <file.mp4> is required");
  if (engine === undefined) throw new RunnerError("usage", "--engine is required");
  if (!(ENGINES as readonly string[]).includes(engine)) throw new RunnerError("bad_engine", `unknown engine ${engine.slice(0, 40)}`);
  return { ...range, engine: engine as Engine, out };
}

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate", "-of", "json", input];
}

export interface MatteProbe {
  width: number;
  height: number;
  /** A rational `fps` filter value, e.g. "30000/1001". */
  fps: string;
  /** null: no audio stream. */
  audio: "copy" | "aac" | null;
}

/** First video stream (displayed size, rate) and first audio stream from ffprobe JSON. */
export function parseMatteProbe(text: string): MatteProbe {
  let streams: Array<Record<string, unknown>> = [];
  try {
    streams = (JSON.parse(text) as { streams?: typeof streams }).streams ?? [];
  } catch {
    // parseProbe names it below.
  }
  const video = streams.find((s) => s.codec_type === "video");
  const { width, height } = parseProbe(JSON.stringify({ streams: video ? [video] : [] }));
  const rate = (s: unknown) => {
    const m = typeof s === "string" ? /^(\d{1,6})\/(\d{1,6})$/.exec(s) : null;
    return m && Number(m[2]) > 0 && Number(m[1]) / Number(m[2]) >= 1 ? { text: s as string, value: Number(m[1]) / Number(m[2]) } : null;
  };
  const r = rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate);
  if (!r) throw new RunnerError("bad_input", "no usable frame rate");
  const audio = streams.find((s) => s.codec_type === "audio");
  return { width, height, fps: r.value > MAX_FPS ? `${MAX_FPS}/1` : r.text, audio: audio ? (MP4_AUDIO.has(String(audio.codec_name)) ? "copy" : "aac") : null };
}

const sec = (n: number) => String(Math.round(n * 1000) / 1000);
const range = (a: TrackArgs) => ["-ss", sec(a.from), "-t", sec(a.to - a.from), "-i", a.input];

/** Range at the source rate, stretched to 256x256 RGB (the model's preprocessing: bilinear resize, no pad). */
export function decodeArgs(a: TrackArgs, p: MatteProbe): string[] {
  return [
    "-nostdin", "-v", "error", "-threads", "4", ...range(a),
    "-an", "-sn", "-dn", "-filter_threads", "1",
    "-vf", `fps=${p.fps},scale=${MASK_SIZE}:${MASK_SIZE}:flags=bilinear`,
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ];
}

/** Colour and audio from the source, masks from stdin, scaled up and stacked below. Bitrate capped for the 200 MB limit. */
export function encodeArgs(a: MatteArgs, p: MatteProbe): string[] {
  const audio = p.audio === null ? [] : ["-map", "0:a:0", ...(p.audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"])];
  return [
    "-nostdin", "-v", "error", "-y", "-threads", "4", ...range(a),
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${MASK_SIZE}x${MASK_SIZE}`, "-framerate", p.fps, "-i", "pipe:0",
    "-filter_threads", "1",
    "-filter_complex",
    `[0:v:0]fps=${p.fps},format=yuv420p[c];[1:v]scale=${p.width}:${p.height}:flags=bilinear,format=yuv420p[m];[c][m]vstack=inputs=2:shortest=1[v]`,
    "-map", "[v]", ...audio,
    // Output `-threads`: the input one only limits the decoder. x264's default (1.5 per core) ran out of the child's
    // 2 GiB address space at 1920x2160 on a 16-core host ("malloc ... failed").
    "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", a.out,
  ];
}

/** HWC RGB bytes to CHW float32 in 0..1 (`do_rescale`, no normalise). */
export function toChw01(frame: Uint8Array, out: Float32Array, size = MASK_SIZE): Float32Array {
  const plane = size * size;
  for (let i = 0, p = 0; p < plane; p++, i += 3) {
    out[p] = frame[i]! / 255;
    out[plane + p] = frame[i + 1]! / 255;
    out[2 * plane + p] = frame[i + 2]! / 255;
  }
  return out;
}

/** Model alphas (0..1) to a fresh grey frame; fresh because the encoder's stdin may still hold the previous one. */
export function toGrey(alphas: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(alphas.length);
  for (let i = 0; i < alphas.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, alphas[i]!)) * 255);
  return out;
}

/** Writes with back-pressure; resolves false when the encoder has gone (its exit code names the failure). */
function write(stdin: Writable, buf: Buffer): Promise<boolean> {
  if (stdin.destroyed || stdin.writableEnded) return Promise.resolve(false);
  if (stdin.write(buf)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => () => {
      stdin.off("drain", onDrain).off("close", onClose);
      resolve(ok);
    };
    const onDrain = done(true);
    const onClose = done(false);
    stdin.once("drain", onDrain).once("close", onClose);
  });
}

export interface MatteDeps {
  ort: { Tensor: typeof Tensor };
  session: Pick<InferenceSession, "run">;
  /** Tests only. */
  start?: (args: string[], opts: ChildOptions) => FfmpegChild;
}

export async function matte(a: MatteArgs, deps: MatteDeps) {
  const start = deps.start ?? startFfmpeg;
  if (!existsSync(a.input)) throw new RunnerError("bad_input", `${a.input} does not exist`);
  const probe = start(probeArgs(a.input), { stdout: true, tool: "ffprobe" });
  const [text, probed] = await Promise.all([readAll(probe.stdout!), probe.done]);
  if (probed.exitCode !== 0) throw new RunnerError("bad_input", childFailed("ffprobe", probed));
  const p = parseMatteProbe(text);

  const encoder = start(encodeArgs(a, p), { stdin: true });
  const decoder = start(decodeArgs(a, p), { stdout: true });
  const chw = new Float32Array(3 * MASK_SIZE * MASK_SIZE);
  let count = 0;
  let encoderGone = false;
  try {
    for await (const frame of frames(decoder.stdout!, MASK_SIZE * MASK_SIZE * 3)) {
      const pixel_values = new deps.ort.Tensor("float32", toChw01(frame, chw), [1, 3, MASK_SIZE, MASK_SIZE]);
      const out = (await deps.session.run({ pixel_values })) as Record<string, { data: unknown }>;
      const alphas = out.alphas?.data;
      if (!(alphas instanceof Float32Array) || alphas.length !== MASK_SIZE * MASK_SIZE) throw new RunnerError("model_bad", "selfie segmentation returned no 256x256 alphas");
      count++;
      // The encoder stops at the shorter of its two inputs; a mask past that end is not needed.
      if (!(await write(encoder.stdin!, toGrey(alphas)))) {
        encoderGone = true;
        break;
      }
    }
  } finally {
    decoder.stdout?.destroy();
    encoder.stdin?.end();
  }
  const [decoded, encoded] = await Promise.all([decoder.done, encoder.done]);
  // An encoder failure ends the decoder through its broken pipe, so the encoder is the one to name.
  if (encoded.exitCode !== 0) throw new RunnerError("encode_failed", childFailed("ffmpeg encode", encoded));
  if (decoded.exitCode !== 0 && !encoderGone) throw new RunnerError("decode_failed", childFailed("ffmpeg decode", decoded));
  if (count === 0) throw new RunnerError("bad_input", `no frames between ${a.from} s and ${a.to} s`);
  return { ok: true as const, engine: a.engine, width: p.width, height: p.height, fps: p.fps, frames: count, out: a.out, bytes: statSync(a.out).size };
}
