/**
 * Runner mode `track` (PAR-10126 D5b0c): face boxes for a source range, the input to reframe (`reframe-path.ts`).
 *
 *   node dist/ml/runner.mjs track --in <file> --from <s> --to <s>
 *
 * One ffprobe reads the picture size, one ffmpeg decodes the range at `SAMPLE_FPS` frames per second, letterboxed to
 * 640x640 BGR (top-left, black pad), and YuNet (`yunet.onnx`, OpenCV 2023mar) runs on each frame. stdout is one JSON line:
 *
 *   {"fps":5,"width":1920,"height":1080,"samples":[{"t":12.4,"boxes":[{"x":812.3,"y":201.5,"w":240.1,"h":301.7,"score":0.93}]}]}
 *
 * `fps` is the sample rate, `width`/`height` the displayed source size (rotation applied), `t` source seconds, and every
 * box is in source pixels, best score first. No face in a sample: `boxes: []`, still exit 0.
 * Both children start through `io.ts` (own prlimit, same process group). Runs inside `dist/ml/runner.mjs` only.
 */
import { existsSync } from "node:fs";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { startFfmpeg, type ChildResult, type FfmpegChild, type ChildOptions } from "./io.js";
import { RunnerError } from "./errors.js";

export const SAMPLE_FPS = 5;
export const INPUT_SIZE = 640;
/** Lowest YuNet score kept (OpenCV's demo uses 0.9; 0.7 keeps turned heads, still no hit on a plain test card). */
export const SCORE_MIN = 0.7;
export const NMS_IOU = 0.3;
export const MAX_BOXES = 20;
/** Longest range one call may ask for (the longest clip is 180 s; a guard against a runaway output). */
export const MAX_RANGE_SEC = 600;
const STRIDES = [8, 16, 32] as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}
export interface Sample {
  t: number;
  boxes: Box[];
}
export interface Track {
  fps: number;
  width: number;
  height: number;
  samples: Sample[];
}
export interface TrackArgs {
  input: string;
  from: number;
  to: number;
}

/** `--in <file> --from <s> --to <s>` in any order; anything else is a usage error. */
export function parseTrackArgs(argv: string[]): TrackArgs {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!["--in", "--from", "--to"].includes(key) || value === undefined || key in got) throw new RunnerError("usage", `bad argument ${key}`);
    got[key] = value;
  }
  const input = got["--in"];
  if (!input || input.startsWith("-")) throw new RunnerError("usage", "--in <file> is required");
  const num = (k: string) => {
    const s = got[k];
    const n = s !== undefined && /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    if (!Number.isFinite(n)) throw new RunnerError("usage", `${k} <seconds> is required`);
    return n;
  };
  const from = num("--from");
  const to = num("--to");
  if (to <= from) throw new RunnerError("usage", "--to must be after --from");
  if (to - from > MAX_RANGE_SEC) throw new RunnerError("usage", `range over ${MAX_RANGE_SEC} s`);
  return { input, from, to };
}

/** The scaled size inside the 640x640 letterbox; the picture sits top-left, so a box maps back by `width / sw`. */
export function letterbox(width: number, height: number): { sw: number; sh: number } {
  const r = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  return { sw: Math.min(INPUT_SIZE, Math.max(1, Math.round(width * r))), sh: Math.min(INPUT_SIZE, Math.max(1, Math.round(height * r))) };
}

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:stream_tags=rotate", "-of", "json", input];
}

/** Displayed width and height from ffprobe JSON: a 90/270 degree rotation swaps them, as ffmpeg's autorotate does. */
export function parseProbe(text: string): { width: number; height: number } {
  let stream: { width?: number; height?: number; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } } | undefined;
  try {
    stream = (JSON.parse(text) as { streams?: (typeof stream)[] }).streams?.[0];
  } catch {
    stream = undefined;
  }
  const { width, height } = stream ?? {};
  if (!stream || !Number.isInteger(width) || !Number.isInteger(height) || width! < 1 || height! < 1) throw new RunnerError("bad_input", "no video stream");
  const rotation = Number(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return quarter ? { width: height!, height: width! } : { width: width!, height: height! };
}

const sec = (n: number) => String(Math.round(n * 1000) / 1000);

export function decodeArgs(a: TrackArgs, size: { width: number; height: number }): string[] {
  const { sw, sh } = letterbox(size.width, size.height);
  return [
    "-nostdin", "-v", "error", "-threads", "4",
    "-ss", sec(a.from), "-t", sec(a.to - a.from), "-i", a.input,
    "-an", "-sn", "-dn",
    // One filter thread: with the default (one per core) a reader slower than the decoder ran the child out of its 2 GiB
    // address space on a 16-core host ("Failed to allocate packet"). The filters are cheap at 5 frames per second.
    "-filter_threads", "1",
    "-vf", `fps=${SAMPLE_FPS},scale=${sw}:${sh}:flags=bilinear,pad=${INPUT_SIZE}:${INPUT_SIZE}:0:0:black`,
    "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1",
  ];
}

/** HWC BGR bytes to the CHW float32 YuNet expects (0..255, no mean, no swap: OpenCV's `blobFromImage` defaults). */
export function toChw(frame: Uint8Array, out: Float32Array, size = INPUT_SIZE): Float32Array {
  const plane = size * size;
  for (let i = 0, p = 0; p < plane; p++, i += 3) {
    out[p] = frame[i]!;
    out[plane + p] = frame[i + 1]!;
    out[2 * plane + p] = frame[i + 2]!;
  }
  return out;
}

type Outputs = Record<string, { data: unknown }>;

/** YuNet 2023mar heads to boxes in input pixels (OpenCV `FaceDetectorYN::postProcess`), then NMS. */
export function decodeYunet(out: Outputs, size = INPUT_SIZE, scoreMin = SCORE_MIN): Box[] {
  const found: Box[] = [];
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  for (const stride of STRIDES) {
    const cls = out[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = out[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = out[`bbox_${stride}`]?.data as Float32Array | undefined;
    if (!cls || !obj || !bbox) throw new RunnerError("model_bad", `yunet output for stride ${stride} is missing`);
    const cols = size / stride;
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(clamp01(cls[idx]!) * clamp01(obj[idx]!));
      if (score < scoreMin) continue;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const cx = (c + bbox[idx * 4]!) * stride;
      const cy = (r + bbox[idx * 4 + 1]!) * stride;
      const w = Math.exp(bbox[idx * 4 + 2]!) * stride;
      const h = Math.exp(bbox[idx * 4 + 3]!) * stride;
      found.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
    }
  }
  return nms(found);
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS, best score first, at most `max` boxes. */
export function nms(boxes: Box[], threshold = NMS_IOU, max = MAX_BOXES): Box[] {
  const kept: Box[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    if (kept.length >= max) break;
    if (kept.every((k) => iou(k, b) <= threshold)) kept.push(b);
  }
  return kept;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A letterboxed box back to source pixels, clipped to the picture; null when nothing is left. */
export function toSource(b: Box, size: { width: number; height: number }): Box | null {
  const { sw, sh } = letterbox(size.width, size.height);
  const fx = size.width / sw;
  const fy = size.height / sh;
  const x0 = Math.max(0, b.x * fx);
  const y0 = Math.max(0, b.y * fy);
  const x1 = Math.min(size.width, (b.x + b.w) * fx);
  const y1 = Math.min(size.height, (b.y + b.h) * fy);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0), score: Math.round(b.score * 1000) / 1000 };
}

/** Yields whole frames of `frameBytes` from a raw stream; a short tail is dropped. */
export async function* frames(stream: AsyncIterable<Buffer>, frameBytes: number): AsyncGenerator<Buffer> {
  const buf = Buffer.alloc(frameBytes);
  let filled = 0;
  for await (const chunk of stream) {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameBytes - filled, chunk.length - off);
      chunk.copy(buf, filled, off, off + n);
      filled += n;
      off += n;
      if (filled === frameBytes) {
        yield buf;
        filled = 0;
      }
    }
  }
}

async function readAll(stream: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts).toString("utf8");
}

function childFailed(what: string, r: ChildResult): string {
  return `${what} failed (${r.error ?? (r.signal ? `signal ${r.signal}` : `exit ${r.exitCode}`)}): ${r.stderrTail.trim().slice(-500)}`;
}

export interface TrackDeps {
  ort: { Tensor: typeof Tensor };
  session: Pick<InferenceSession, "run">;
  /** Tests only. */
  start?: (args: string[], opts: ChildOptions) => FfmpegChild;
}

export async function track(a: TrackArgs, deps: TrackDeps): Promise<Track> {
  const start = deps.start ?? startFfmpeg;
  if (!existsSync(a.input)) throw new RunnerError("bad_input", `${a.input} does not exist`);
  const probe = start(probeArgs(a.input), { stdout: true, tool: "ffprobe" });
  const [text, probed] = await Promise.all([readAll(probe.stdout!), probe.done]);
  if (probed.exitCode !== 0) throw new RunnerError("bad_input", childFailed("ffprobe", probed));
  const size = parseProbe(text);

  const decoder = start(decodeArgs(a, size), { stdout: true });
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const samples: Sample[] = [];
  try {
    for await (const frame of frames(decoder.stdout!, INPUT_SIZE * INPUT_SIZE * 3)) {
      const input = new deps.ort.Tensor("float32", toChw(frame, chw), [1, 3, INPUT_SIZE, INPUT_SIZE]);
      const out = (await deps.session.run({ input })) as Outputs;
      const boxes = decodeYunet(out).map((b) => toSource(b, size)).filter((b): b is Box => b !== null);
      samples.push({ t: Math.round((a.from + samples.length / SAMPLE_FPS) * 1000) / 1000, boxes });
    }
  } finally {
    decoder.stdout?.destroy();
  }
  const decoded = await decoder.done;
  if (decoded.exitCode !== 0) throw new RunnerError("decode_failed", childFailed("ffmpeg decode", decoded));
  if (samples.length === 0) throw new RunnerError("bad_input", `no frames between ${a.from} s and ${a.to} s`);
  return { fps: SAMPLE_FPS, width: size.width, height: size.height, samples };
}
