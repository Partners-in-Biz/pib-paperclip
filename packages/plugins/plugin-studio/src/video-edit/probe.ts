/**
 * ffprobe through the contained runner (PAR-8276 A6). Input is an absolute local path or an https signed URL; the
 * protocol whitelist stops a crafted file (an HLS/concat list) from making ffprobe open other files or hosts.
 */
import { isAbsolute } from "node:path";
import { StudioError } from "../errors.js";
import { runContained, type RunOptions } from "./ffmpeg.js";

export const PROBE_TIMEOUT_SEC = 60;

export interface ProbeResult {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName: string | null;
  sizeBytes: number | null;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function rate(v: string | undefined): number | null {
  if (!v) return null;
  const [a, b] = v.split("/").map(Number);
  if (!Number.isFinite(a) || !a) return null;
  const r = b === undefined ? a : Number.isFinite(b) && b ? a / b : NaN;
  return Number.isFinite(r) && r > 0 ? Math.round(r * 1000) / 1000 : null;
}

export function parseProbe(json: string): ProbeResult {
  let data: { streams?: FfStream[]; format?: { duration?: string; format_name?: string; size?: string } };
  try {
    data = JSON.parse(json);
  } catch {
    throw new StudioError("ffprobe returned no readable data", "probe_failed");
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  // A cover image in an audio file is a "video" stream with attached_pic; it is not video.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const durations = [num(data.format?.duration), ...streams.map((s) => num(s.duration))].filter((d): d is number => d !== null && d > 0);
  const durationSec = num(data.format?.duration) ?? (durations.length ? Math.max(...durations) : null);
  if (durationSec === null || !(video || audio)) throw new StudioError("That file has no playable video or audio", "probe_failed");
  return {
    durationSec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: video ? (rate(video.avg_frame_rate) ?? rate(video.r_frame_rate)) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: !!video,
    hasAudio: !!audio,
    formatName: data.format?.format_name ?? null,
    sizeBytes: num(data.format?.size),
  };
}

export function probeArgs(input: string): string[] {
  let target: string;
  let protocols: string;
  if (input.startsWith("https://")) {
    target = input;
    protocols = "https,tls,tcp";
  } else if (isAbsolute(input) && !input.includes("\0")) {
    target = `file:${input}`;
    protocols = "file";
  } else {
    throw new StudioError("ffprobe takes an absolute file path or an https link", "probe_failed");
  }
  return ["-v", "error", "-protocol_whitelist", protocols, "-print_format", "json", "-show_format", "-show_streams", "-i", target];
}

export async function probeMedia(input: string, opts: Omit<RunOptions, "tool" | "captureStdout"> = {}): Promise<ProbeResult> {
  const run = runContained(probeArgs(input), { timeoutSec: PROBE_TIMEOUT_SEC, killAfterSec: 5, ...opts, tool: "ffprobe", captureStdout: true });
  const res = await run.done;
  if (res.outcome !== "ok") {
    // Never echo the input: a signed URL carries a signature.
    throw new StudioError(`ffprobe failed (${res.outcome}): ${res.stderrTail.replaceAll(input, "<input>").slice(-500)}`, "probe_failed");
  }
  return parseProbe(res.stdout);
}
