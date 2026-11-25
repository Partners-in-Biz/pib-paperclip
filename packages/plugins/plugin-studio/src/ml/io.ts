/**
 * The ML runner's own ffmpeg children (PAR-10126 D5b): a decoder that writes raw frames to the runner and an encoder that
 * reads them back. `prlimit --as` is per process, so each child gets its own limit:
 *
 *   /usr/bin/prlimit --as=2147483648 --fsize=209715200 -- ffmpeg -hide_banner ...
 *
 * Never detached: the children stay in the runner's process group, which `timeout` leads (`runContained` tool "node"), so
 * one `-pgid` kill from the worker ends the runner and both children. They inherit the runner's env, already an allowlist.
 * Runs inside `dist/ml/runner.mjs` only; the worker never imports this file.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { FSIZE_BYTES, STDERR_TAIL_BYTES, Tail } from "../video-edit/ffmpeg.js";

/** RLIMIT_AS for one runner-side ffmpeg. The measured peak was 1.4 GB for the runner and both children together. */
export const CHILD_AS_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const CHILD_FSIZE_BYTES = FSIZE_BYTES;
export const CHILD_BINS = { prlimit: "/usr/bin/prlimit", ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

export interface ChildOptions {
  /** Default "ffmpeg"; "ffprobe" for the runner's input probe (same prlimit). */
  tool?: "ffmpeg" | "ffprobe";
  /** Pipe stdin (an encoder reading frames); else ignored. */
  stdin?: boolean;
  /** Pipe stdout (a decoder writing frames); else ignored. */
  stdout?: boolean;
  asLimitBytes?: number;
  fsizeBytes?: number;
  bins?: Partial<typeof CHILD_BINS>;
  /** Tests only. */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  error?: string;
}

export interface FfmpegChild {
  readonly pid: number;
  readonly argv: string[];
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly done: Promise<ChildResult>;
}

/** The full child argv, `prlimit` first. */
export function childArgv(ffmpegArgs: string[], opts: Pick<ChildOptions, "tool" | "asLimitBytes" | "fsizeBytes" | "bins"> = {}): string[] {
  const bins = { ...CHILD_BINS, ...opts.bins };
  const as = opts.asLimitBytes ?? CHILD_AS_LIMIT_BYTES;
  const fsize = opts.fsizeBytes ?? CHILD_FSIZE_BYTES;
  for (const [name, n] of [["asLimitBytes", as], ["fsizeBytes", fsize]] as const) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return [bins.prlimit, `--as=${as}`, `--fsize=${fsize}`, "--", bins[opts.tool ?? "ffmpeg"], "-hide_banner", ...ffmpegArgs];
}

export function startFfmpeg(ffmpegArgs: string[], opts: ChildOptions = {}): FfmpegChild {
  const argv = childArgv(ffmpegArgs, opts);
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const stderr = new Tail(STDERR_TAIL_BYTES);
  const child = spawnImpl(argv[0]!, argv.slice(1), {
    // Not detached: the child must stay in the group the worker kills.
    detached: false,
    stdio: [opts.stdin ? "pipe" : "ignore", opts.stdout ? "pipe" : "ignore", "pipe"],
  });
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  // A child that exits early turns our writes into EPIPE; the exit code tells the story, not an unhandled error.
  child.stdin?.on("error", () => {});
  const done = new Promise<ChildResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stderrTail: stderr.toString(), error });
    };
    child.once("error", (e) => finish(null, null, `spawn failed: ${e.message}`));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
  });
  return { pid: child.pid ?? 0, argv, stdin: child.stdin ?? null, stdout: child.stdout ?? null, done };
}
