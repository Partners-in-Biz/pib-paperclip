/**
 * Contained ffmpeg/ffprobe runs (PAR-8276 A6). Every run is one args array, never a shell string:
 *
 *   /usr/bin/timeout -k 30 1200 /usr/bin/prlimit --as=<AS> --fsize=209715200 -- /usr/bin/nice -n 10 ffmpeg -threads 4 ...
 *
 * spawned with `detached: true`, so `timeout` leads its own process group and `pgid === pid`. prlimit and nice exec
 * into the tool, so the group is `timeout` + ffmpeg. Cancel kills the group (`-pgid`): SIGTERM, then SIGKILL after
 * 10 s. When the run ends the group gets one more SIGKILL so nothing in it outlives the run. Never kill by name,
 * pattern or port.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

export const TIMEOUT_SEC = 1200;
export const KILL_AFTER_SEC = 30;
/** RLIMIT_FSIZE: an output can never pass the 200 MB asset cap (`MAX_ASSET_BYTES`) or fill the disk. */
export const FSIZE_BYTES = 209_715_200;
/** RLIMIT_AS default. A9 sets the final value from the measured peak (+50%); pass `asLimitBytes` to change it. */
export const DEFAULT_AS_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
export const NICE = 10;
export const THREADS = 4;
export const CANCEL_GRACE_MS = 10_000;
export const STDERR_TAIL_BYTES = 4096;
const STDOUT_MAX_BYTES = 1024 * 1024;

export const BINS = { timeout: "/usr/bin/timeout", prlimit: "/usr/bin/prlimit", nice: "/usr/bin/nice", ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

/** ok; timeout (the 20-minute wall clock); rlimit (FSIZE, AS or an unexplained kill); nonzero (ffmpeg failed); cancelled (we asked). */
export type RunOutcome = "ok" | "timeout" | "rlimit" | "nonzero" | "cancelled";

export interface RunOptions {
  tool?: "ffmpeg" | "ffprobe";
  timeoutSec?: number;
  killAfterSec?: number;
  asLimitBytes?: number;
  fsizeBytes?: number;
  threads?: number;
  captureStdout?: boolean;
  cwd?: string;
  bins?: Partial<typeof BINS>;
  /** Tests only. */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface RunResult {
  outcome: RunOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  stdout: string;
  durationMs: number;
  error?: string;
}

export interface RunHandle {
  /** pid of `timeout`, which is also the process group id. 0 if the spawn failed. */
  readonly pgid: number;
  readonly argv: string[];
  readonly done: Promise<RunResult>;
  cancel(): void;
}

/** The full argv, `timeout` first. `toolArgs` must not hold user text that starts with `-` (the compiler builds them). */
export function containedArgv(toolArgs: string[], opts: RunOptions = {}): string[] {
  const bins = { ...BINS, ...opts.bins };
  const tool = opts.tool ?? "ffmpeg";
  const as = opts.asLimitBytes ?? DEFAULT_AS_LIMIT_BYTES;
  const fsize = opts.fsizeBytes ?? FSIZE_BYTES;
  for (const [name, n] of [["asLimitBytes", as], ["fsizeBytes", fsize]] as const) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const head = tool === "ffmpeg" ? [bins.ffmpeg, "-nostdin", "-hide_banner", "-threads", String(opts.threads ?? THREADS)] : [bins.ffprobe, "-hide_banner"];
  return [
    bins.timeout, "-k", String(opts.killAfterSec ?? KILL_AFTER_SEC), String(opts.timeoutSec ?? TIMEOUT_SEC),
    bins.prlimit, `--as=${as}`, `--fsize=${fsize}`, "--",
    bins.nice, "-n", String(NICE),
    ...head, ...toolArgs,
  ];
}

const SIGXFSZ_CODE = 128 + 25;
const RLIMIT_TEXT = /File too large|Cannot allocate memory|Out of memory|bad_alloc/i;

export function classifyExit(r: { exitCode: number | null; signal: NodeJS.Signals | null; cancelled: boolean; stderrTail: string; spawnFailed?: boolean; pastDeadline?: boolean }): RunOutcome {
  if (r.cancelled) return "cancelled";
  if (r.spawnFailed) return "nonzero";
  if (r.exitCode === 0) return "ok";
  // timeout(1) exits 124 after SIGTERM; after -k it SIGKILLs the whole group, itself included.
  if (r.exitCode === 124) return "timeout";
  if (r.signal === "SIGXFSZ" || r.exitCode === SIGXFSZ_CODE) return "rlimit";
  if (RLIMIT_TEXT.test(r.stderrTail)) return "rlimit";
  // A SIGKILL we did not send: timeout's -k step if the clock ran out, else the kernel (memory).
  if (r.signal === "SIGKILL" || r.exitCode === 137) return r.pastDeadline ? "timeout" : "rlimit";
  return "nonzero";
}

/** Keeps only the last `max` bytes of a stream. */
export class Tail {
  private buf = Buffer.alloc(0);
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.max) this.buf = this.buf.subarray(this.buf.length - this.max);
  }
  get bytes(): number {
    return this.buf.length;
  }
  toString(): string {
    return this.buf.toString("utf8").replace(/^\uFFFD+/, "");
  }
}

function killGroup(kill: (pid: number, signal: NodeJS.Signals) => void, pgid: number, signal: NodeJS.Signals): void {
  // A pgid of 0 or 1 would hit our own group or init: never.
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    kill(-pgid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

export function runContained(toolArgs: string[], opts: RunOptions = {}): RunHandle {
  const argv = containedArgv(toolArgs, opts);
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const kill = opts.killImpl ?? ((pid, signal) => process.kill(pid, signal));
  const started = Date.now();
  const stderr = new Tail(STDERR_TAIL_BYTES);
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let cancelled = false;
  let exited = false;
  let graceTimer: NodeJS.Timeout | undefined;

  const child = spawnImpl(argv[0]!, argv.slice(1), {
    detached: true,
    cwd: opts.cwd,
    stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
    // The worker env is PATH/NODE_PATH/TZ/NODE_ENV only; ffmpeg needs nothing else, and never the worker's secrets.
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C" },
  });
  const pgid = child.pid ?? 0;

  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  child.stdout?.on("data", (c: Buffer) => {
    if (stdoutBytes >= STDOUT_MAX_BYTES) return;
    stdoutChunks.push(c);
    stdoutBytes += c.length;
  });

  const done = new Promise<RunResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (exited) return;
      exited = true;
      if (graceTimer) clearTimeout(graceTimer);
      // Leftovers in the group (timeout itself was SIGKILLed, or a stray child) go with it.
      killGroup(kill, pgid, "SIGKILL");
      if (error) stderr.push(Buffer.from(`\n${error}`));
      const stderrTail = stderr.toString();
      const durationMs = Date.now() - started;
      const pastDeadline = durationMs >= (opts.timeoutSec ?? TIMEOUT_SEC) * 1000;
      resolve({
        outcome: classifyExit({ exitCode, signal, cancelled, stderrTail, spawnFailed: !!error, pastDeadline }),
        exitCode,
        signal,
        stderrTail,
        stdout: Buffer.concat(stdoutChunks).subarray(0, STDOUT_MAX_BYTES).toString("utf8"),
        durationMs,
        error,
      });
    };
    child.once("error", (e) => finish(null, null, `spawn failed: ${e.message}`));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
  });

  return {
    pgid,
    argv,
    done,
    cancel() {
      if (exited || cancelled) return;
      cancelled = true;
      killGroup(kill, pgid, "SIGTERM");
      graceTimer = setTimeout(() => {
        if (!exited) killGroup(kill, pgid, "SIGKILL");
      }, CANCEL_GRACE_MS);
      graceTimer.unref?.();
    },
  };
}

/** Process ids whose process group is `pgid`, read from `/proc/<pid>/stat` (Linux). For tests and recovery checks. */
export async function pidsInGroup(pgid: number, procRoot = "/proc"): Promise<number[]> {
  const out: number[] = [];
  for (const name of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`${procRoot}/${name}/stat`, "utf8").catch(() => "");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // rest: state ppid pgrp ...; a zombie (Z) holds no resources and is reaped by its parent.
    if (rest[2] === String(pgid) && rest[0] !== "Z") out.push(Number(name));
  }
  return out;
}
