/**
 * Contained ffmpeg/ffprobe runs (PAR-8276 A6). Every run is one args array, never a shell string:
 *
 *   /usr/bin/timeout -k 30 1200 /usr/bin/prlimit --as=<AS> --fsize=209715200 -- /usr/bin/nice -n 10 ffmpeg -threads 4 ...
 *
 * spawned with `detached: true`, so `timeout` leads its own process group and `pgid === pid`. prlimit and nice exec
 * into the tool, so the group is `timeout` + ffmpeg. Cancel kills the group (`-pgid`): SIGTERM, then SIGKILL after
 * 10 s. When the run ends the group gets one more SIGKILL so nothing in it outlives the run. Never kill by name,
 * pattern or port.
 *
 * Tool "node" (PAR-10126 D5b) runs the ML runner the same way: `... nice -n 10 <process.execPath> dist/ml/runner.mjs ...`.
 * The runner starts its own ffmpeg children through `src/ml/io.ts`, not detached, so they stay in this group.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const TIMEOUT_SEC = 1200;
export const KILL_AFTER_SEC = 30;
/** RLIMIT_FSIZE: an output can never pass the 200 MB asset cap (`MAX_ASSET_BYTES`) or fill the disk. */
export const FSIZE_BYTES = 209_715_200;
/** RLIMIT_AS default. A9 sets the final value from the measured peak (+50%); pass `asLimitBytes` to change it. */
export const DEFAULT_AS_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
export const NICE = 10;
/** ffmpeg `-threads` is per file: placed first, it binds to the first input only. Multi-input renders cap every file
 * themselves (`compile-video.ts`, PAR-10432). */
export const THREADS = 4;
export const CANCEL_GRACE_MS = 10_000;
export const STDERR_TAIL_BYTES = 4096;
/** Seconds of stderr silence after which a render counts as stalled (the pipeline passes this as `stallSec`). */
export const STALL_SEC = 60;
/** Longest partial stderr line kept for the live scan. */
export const STDERR_LINE_MAX = 4096;
/** A thread could not be created: ffmpeg goes silent after this and never recovers, so kill it at once. */
const FATAL_STDERR_LINE = /pthread_create failed/;
const STDOUT_MAX_BYTES = 1024 * 1024;

export const BINS = { timeout: "/usr/bin/timeout", prlimit: "/usr/bin/prlimit", nice: "/usr/bin/nice", ffmpeg: "ffmpeg", ffprobe: "ffprobe", node: process.execPath };

/** ok; timeout (the 20-minute wall clock); rlimit (FSIZE, AS or an unexplained kill); nonzero (ffmpeg failed); cancelled (we asked). */
export type RunOutcome = "ok" | "timeout" | "rlimit" | "nonzero" | "cancelled" | "stalled";

/** Env keys a "node" run may get from the caller or the worker env (PAR-10126 D5b). Nothing else, so never a secret. */
export const ML_ENV_KEY = /^PIB_ML_[A-Z0-9_]+$/;

/**
 * `dist/ml/runner.mjs`: beside the built worker (`dist/worker.js`), or the package's `dist/ml` when running from source.
 * Throws when neither exists, so a broken build fails with a clear message.
 */
export function mlRunnerPath(): string {
  for (const url of [new URL("./ml/runner.mjs", import.meta.url), new URL("../../dist/ml/runner.mjs", import.meta.url)]) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new Error("The Studio ML runner is missing: expected dist/ml/runner.mjs beside the worker (check the plugin build).");
}

export interface RunOptions {
  tool?: "ffmpeg" | "ffprobe" | "node";
  /** Tool "node": the script to run (default `mlRunnerPath()`). */
  runnerPath?: string;
  /** Tool "node": extra env, `PIB_ML_*` keys only. */
  env?: Record<string, string>;
  timeoutSec?: number;
  /** No stderr output for this many seconds kills the run with outcome `stalled`. Off when unset. */
  stallSec?: number;
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
  const head =
    tool === "ffmpeg" ? [bins.ffmpeg, "-nostdin", "-hide_banner", "-threads", String(opts.threads ?? THREADS)]
    : tool === "ffprobe" ? [bins.ffprobe, "-hide_banner"]
    : [bins.node, opts.runnerPath ?? mlRunnerPath()];
  return [
    bins.timeout, "-k", String(opts.killAfterSec ?? KILL_AFTER_SEC), String(opts.timeoutSec ?? TIMEOUT_SEC),
    bins.prlimit, `--as=${as}`, `--fsize=${fsize}`, "--",
    bins.nice, "-n", String(NICE),
    ...head, ...toolArgs,
  ];
}

const SIGXFSZ_CODE = 128 + 25;
const RLIMIT_TEXT = /File too large|Cannot allocate memory|Out of memory|bad_alloc|pthread_create failed|Resource temporarily unavailable|malloc of size \d+ failed/i;

export function classifyExit(r: { exitCode: number | null; signal: NodeJS.Signals | null; cancelled: boolean; stderrTail: string; spawnFailed?: boolean; pastDeadline?: boolean; memoryKill?: boolean; stallKill?: boolean }): RunOutcome {
  if (r.cancelled) return "cancelled";
  if (r.memoryKill) return "rlimit";
  if (r.stallKill) return "stalled";
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

/**
 * glibc malloc arenas for ffmpeg/ffprobe. By default a process gets up to 8 per core, each a 64 MiB reservation that
 * `--as` counts though it is mostly untouched: a 180 s, 6-cut graded render (13 inputs, 120 threads) peaked at 5404 MiB
 * with the default and 3026 MiB with 4 (PAR-10432).
 */
export const MALLOC_ARENAS = 4;

/**
 * The child env, an allowlist. ffmpeg/ffprobe: PATH, LC_ALL=C and MALLOC_ARENA_MAX (the worker env is
 * PATH/NODE_PATH/TZ/NODE_ENV only; ffmpeg needs nothing else, and never the worker's secrets). node: PATH, LANG and
 * `PIB_ML_*` (from the worker env, then `opts.env`).
 */
export function containedEnv(opts: Pick<RunOptions, "tool" | "env"> = {}, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = from.PATH || "/usr/bin:/bin";
  if ((opts.tool ?? "ffmpeg") !== "node") {
    if (opts.env && Object.keys(opts.env).length) throw new Error("env is only for tool \"node\"");
    return { PATH: path, LC_ALL: "C", MALLOC_ARENA_MAX: String(MALLOC_ARENAS) };
  }
  const env: Record<string, string> = { PATH: path };
  if (from.LANG) env.LANG = from.LANG;
  for (const [k, v] of Object.entries(from)) if (ML_ENV_KEY.test(k) && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!ML_ENV_KEY.test(k)) throw new Error(`env key ${k} is not allowed (PIB_ML_* only)`);
    env[k] = String(v);
  }
  return env;
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
  let memoryKill = false;
  let stallKill = false;
  let killed = false;
  let exited = false;
  let lastData = Date.now();
  let partial = "";
  let stallTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  const child = spawnImpl(argv[0]!, argv.slice(1), {
    detached: true,
    cwd: opts.cwd,
    stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
    env: containedEnv(opts),
  });
  const pgid = child.pid ?? 0;

  const terminate = () => {
    if (exited || killed) return;
    killed = true;
    if (stallTimer) clearInterval(stallTimer);
    killGroup(kill, pgid, "SIGTERM");
    graceTimer = setTimeout(() => {
      if (!exited) killGroup(kill, pgid, "SIGKILL");
    }, CANCEL_GRACE_MS);
    graceTimer.unref?.();
  };

  child.stderr?.on("data", (c: Buffer) => {
    stderr.push(c);
    lastData = Date.now();
    if (killed) return;
    // Live line scan: split on \n and \r, keep the partial last line (capped).
    const lines = (partial + c.toString("utf8")).split(/[\n\r]/);
    partial = (lines.pop() ?? "").slice(-STDERR_LINE_MAX);
    if (lines.some((l) => FATAL_STDERR_LINE.test(l)) || FATAL_STDERR_LINE.test(partial)) {
      memoryKill = true;
      terminate();
    }
  });
  if (opts.stallSec !== undefined && opts.stallSec > 0) {
    const stallMs = opts.stallSec * 1000;
    stallTimer = setInterval(() => {
      if (!exited && !killed && Date.now() - lastData >= stallMs) {
        stallKill = true;
        terminate();
      }
    }, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))));
    stallTimer.unref?.();
  }
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
      if (stallTimer) clearInterval(stallTimer);
      // Leftovers in the group (timeout itself was SIGKILLed, or a stray child) go with it.
      killGroup(kill, pgid, "SIGKILL");
      if (error) stderr.push(Buffer.from(`\n${error}`));
      const stderrTail = stderr.toString();
      const durationMs = Date.now() - started;
      const pastDeadline = durationMs >= (opts.timeoutSec ?? TIMEOUT_SEC) * 1000;
      resolve({
        outcome: classifyExit({ exitCode, signal, cancelled, stderrTail, spawnFailed: !!error, pastDeadline, memoryKill, stallKill }),
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
      if (killed) return; // our own kill is already under way; the outcome stays cancelled
      terminate();
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

/** True when an argument of `/proc/<pid>/cmdline` is `workdir` or a path inside it (Linux). */
export async function cmdlineHasWorkdir(pid: number, workdir: string, procRoot = "/proc"): Promise<boolean> {
  const dir = workdir.replace(/\/+$/, "");
  const cmd = await readFile(`${procRoot}/${pid}/cmdline`, "utf8").catch(() => "");
  return cmd.split("\0").some((a) => a === dir || a.startsWith(`${dir}/`) || a.includes(`=${dir}/`) || a.endsWith(`=${dir}`));
}

/**
 * Recovery kill for a runner group this worker no longer tracks (PAR-10126 D5b): SIGKILLs `-pid` only when
 * `/proc/<pid>/cmdline` still names `workdir`, so a recycled pid is never hit. Never by name, pattern or port.
 */
export async function killIfOurs(
  pid: number,
  workdir: string,
  opts: { procRoot?: string; killImpl?: (pid: number, signal: NodeJS.Signals) => void } = {},
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (!isAbsolute(workdir) || workdir.replace(/\/+$/, "").length <= 8) return false;
  if (!(await cmdlineHasWorkdir(pid, workdir, opts.procRoot))) return false;
  killGroup(opts.killImpl ?? ((p, sig) => process.kill(p, sig)), pid, "SIGKILL");
  return true;
}
