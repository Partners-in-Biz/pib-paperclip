/**
 * The render runner (PAR-8276 A7a): claim, heartbeat, recovery and the failure policy around one render at a time.
 *
 * The `process-renders` job calls `tick()` once a minute. A tick only looks and starts; it never waits for a render
 * (the job RPC times out after 5 minutes and is not killed), so the render itself runs on in the worker as a promise:
 *  1. recover: active rows whose heartbeat is stale and that this worker does not run. Their process group is killed
 *     only when `/proc/<pid>/cmdline` still names the row's work folder (never by name, pattern or port); then the
 *     row goes through the failure policy as an infra error.
 *  2. claim the oldest queued job (the database allows one active render per host) and start the executor.
 * While a render runs, a 15 s timer heartbeats it. A heartbeat that returns false means the claim is gone (cancelled or
 * recovered elsewhere): the runner aborts the executor and kills its process group.
 *
 * Failure policy: deterministic errors (bad input probe, unsupported codec or feature, compile error, ffmpeg non-zero
 * exit, output fails verification) end the job as `failed` at once. Infra errors (stale heartbeat or worker death,
 * `disk_low`, timeout, rlimit, anything unexpected) re-queue it while `attempts < MAX_ATTEMPTS`, then `failed`.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { errorText } from "../errors.js";
import type { RunResult } from "./ffmpeg.js";
import {
  claimNextRender,
  finishRender,
  heartbeatRender,
  listStaleRenders,
  requeueRender,
  type ClaimedRender,
  type RenderErrorKind,
} from "./render-queue.js";

export const HEARTBEAT_MS = 15_000;
/** Four missed heartbeats. */
export const STALE_AFTER_SEC = 60;
/** Attempts are counted at claim: the first infra failure re-queues, the second ends the job. */
export const MAX_ATTEMPTS = 2;
export const KILL_GRACE_MS = 10_000;

/** A classified render error. Executors throw this; anything else is classified by its `code`, or as infra. */
export class RenderFailure extends Error {
  constructor(
    message: string,
    readonly kind: RenderErrorKind,
    readonly code: string,
    readonly stderrTail: string | null = null,
  ) {
    super(message);
    this.name = "RenderFailure";
  }
}

const DETERMINISTIC = new Set(["probe_failed", "unsupported_codec", "unsupported_feature", "compile_error", "ffmpeg_failed", "stalled", "verify_failed", "too_large", "unsafe_key", "forbidden_key", "missing_input", "bad_input_path", "bad_render", "bad_edit", "unknown_asset"]);
const INFRA = new Set(["disk_low", "timeout", "rlimit", "stale_heartbeat", "cancelled"]);

export interface ClassifiedFailure {
  kind: RenderErrorKind;
  code: string;
  error: string;
  stderrTail: string | null;
}

export function classifyRenderError(error: unknown): ClassifiedFailure {
  if (error instanceof RenderFailure) return { kind: error.kind, code: error.code, error: error.message, stderrTail: error.stderrTail };
  const raw = (error as { code?: unknown } | null)?.code;
  // `unsupported_feature:<name>` keeps its detail in the code.
  const code = typeof raw === "string" && raw ? raw : "unexpected";
  const base = code.split(":")[0]!;
  const kind: RenderErrorKind = DETERMINISTIC.has(base) ? "deterministic" : "infra";
  return { kind, code, error: errorText(error), stderrTail: null };
}

/** The failure for a finished ffmpeg run, or null when it ran fine. */
export function failureFromRun(result: RunResult): RenderFailure | null {
  switch (result.outcome) {
    case "ok":
      return null;
    case "timeout":
      return new RenderFailure("The render took longer than the time limit.", "infra", "timeout", result.stderrTail);
    case "rlimit":
      return new RenderFailure("The render hit a memory or file size limit.", "infra", "rlimit", result.stderrTail);
    case "stalled":
      return new RenderFailure("The render stopped making progress (likely out of memory). Try a shorter or simpler edit.", "deterministic", "stalled", result.stderrTail);
    case "cancelled":
      return new RenderFailure("The render was stopped.", "infra", "cancelled", result.stderrTail);
    default:
      return new RenderFailure(`ffmpeg failed (exit ${result.exitCode ?? result.signal ?? "unknown"}).`, "deterministic", "ffmpeg_failed", result.stderrTail);
  }
}

/** What an executor gets besides the job. */
export interface RenderControl {
  /** Aborted when the claim is gone: stop the ffmpeg run (`handle.cancel()`) and throw. */
  signal: AbortSignal;
  /** Call once ffmpeg is spawned: records pid (= pgid) and work folder for recovery. False = the claim is gone. */
  started(info: { pgid: number; workdir: string }): Promise<boolean>;
  /** ffmpeg is done and the output is being stored. False = the claim is gone. */
  uploading(): Promise<boolean>;
}

export interface RenderSuccess {
  assetId: string;
  previewR2Key?: string | null;
}

/** Does the real work (A7b: download, compile, run, verify, upload). Resolves with the asset or throws a failure. */
export type RenderExecutor = (ctx: PluginContext, job: ClaimedRender, control: RenderControl) => Promise<RenderSuccess>;

export interface RunnerOptions {
  /** Without one the runner only recovers stale rows and never claims (A7b supplies the pipeline). */
  executor?: RenderExecutor;
  heartbeatMs?: number;
  staleAfterSec?: number;
  killGraceMs?: number;
  procRoot?: string;
  /** Tests only. */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface Running {
  id: string;
  token: string;
  pgid: number | null;
  workdir: string | null;
}

export interface TickResult {
  recovered: number;
  claimed: string | null;
  running: string | null;
}

interface Active extends Running {
  abort: AbortController;
  timer: NodeJS.Timeout;
  done: Promise<void>;
}

export interface RenderRunner {
  tick(): Promise<TickResult>;
  recover(): Promise<number>;
  /** The renders this worker runs now (render id -> pgid and work folder). */
  running(): Running[];
  /** Resolves when every render this worker started has ended. Tests and shutdown. */
  settled(): Promise<void>;
}

/** True when the process `pid` names `workdir` in its command line (Linux `/proc`). */
export async function cmdlineNames(pid: number, workdir: string, procRoot = "/proc"): Promise<boolean> {
  const cmd = await readFile(`${procRoot}/${pid}/cmdline`, "utf8").catch(() => "");
  return cmd.replaceAll("\0", " ").includes(workdir);
}

export function createRenderRunner(ctx: PluginContext, opts: RunnerOptions = {}): RenderRunner {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const staleAfterSec = opts.staleAfterSec ?? STALE_AFTER_SEC;
  const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const procRoot = opts.procRoot ?? "/proc";
  const kill = opts.killImpl ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const active = new Map<string, Active>();
  let ticking: Promise<TickResult> | null = null;

  const killGroup = (pgid: number | null, signal: NodeJS.Signals) => {
    // 0 or 1 would hit our own group or init; our own pid would kill the worker.
    if (!pgid || !Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return;
    try {
      kill(-pgid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") ctx.logger.warn("Studio render kill failed", { pgid, error: errorText(e) });
    }
  };

  /** The failure policy, for a job this runner (or recovery) holds the token of. */
  async function fail(job: { id: string; attempts: number }, token: string, f: ClassifiedFailure): Promise<"failed" | "requeued" | "lost"> {
    if (f.kind === "infra" && job.attempts < MAX_ATTEMPTS) {
      return (await requeueRender(ctx, job.id, token, { error: f.error, stderrTail: f.stderrTail })) ? "requeued" : "lost";
    }
    const ok = await finishRender(ctx, job.id, token, { status: "failed", errorKind: f.kind, error: f.error, stderrTail: f.stderrTail });
    return ok ? "failed" : "lost";
  }

  async function recover(): Promise<number> {
    const stale = await listStaleRenders(ctx, staleAfterSec);
    let n = 0;
    for (const row of stale) {
      // Ours and alive here: a slow heartbeat write, not a dead worker.
      if (active.has(row.id) || !row.claimToken) continue;
      const workdir = row.workdir;
      if (row.pid && workdir && isAbsolute(workdir) && workdir.length > 8 && (await cmdlineNames(row.pid, workdir, procRoot))) {
        killGroup(row.pid, "SIGKILL");
      }
      const outcome = await fail(row, row.claimToken, { kind: "infra", code: "stale_heartbeat", error: "The render stopped reporting (worker restarted or hung).", stderrTail: null });
      if (outcome !== "lost") n += 1;
      ctx.logger.warn("Studio render recovered", { renderId: row.id, attempts: row.attempts, outcome });
    }
    return n;
  }

  function start(job: ClaimedRender, executor: RenderExecutor): void {
    const abort = new AbortController();
    const entry = { id: job.id, token: job.claimToken, pgid: null, workdir: null, abort } as unknown as Active;
    const lost = () => {
      if (abort.signal.aborted) return;
      abort.abort(new RenderFailure("The render claim was lost.", "infra", "cancelled"));
      killGroup(entry.pgid, "SIGTERM");
      const pgid = entry.pgid;
      setTimeout(() => {
        if (active.get(job.id) === entry) killGroup(pgid, "SIGKILL");
      }, graceMs).unref?.();
    };
    const beat = async (patch: Parameters<typeof heartbeatRender>[3] = {}) => {
      const ok = await heartbeatRender(ctx, job.id, job.claimToken, patch);
      if (!ok) lost();
      return ok;
    };
    entry.timer = setInterval(() => {
      beat().catch((e) => ctx.logger.warn("Studio render heartbeat failed", { renderId: job.id, error: errorText(e) }));
    }, heartbeatMs);
    entry.timer.unref?.();
    const control: RenderControl = {
      signal: abort.signal,
      async started(info) {
        entry.pgid = info.pgid;
        entry.workdir = info.workdir;
        return beat({ pid: info.pgid, workdir: info.workdir });
      },
      uploading: () => beat({ stage: "uploading" }),
    };
    active.set(job.id, entry);
    entry.done = (async () => {
      try {
        const out = await executor(ctx, job, control);
        if (abort.signal.aborted) return;
        await finishRender(ctx, job.id, job.claimToken, { status: "succeeded", assetId: out.assetId, previewR2Key: out.previewR2Key ?? null });
      } catch (error) {
        if (abort.signal.aborted) return;
        const f = classifyRenderError(error);
        const outcome = await fail(job, job.claimToken, f);
        ctx.logger.info("Studio render failed", { renderId: job.id, kind: f.kind, code: f.code, attempts: job.attempts, outcome });
      } finally {
        clearInterval(entry.timer);
        active.delete(job.id);
      }
    })().catch((e) => ctx.logger.warn("Studio render end not saved", { renderId: job.id, error: errorText(e) }));
  }

  async function tickOnce(): Promise<TickResult> {
    let recovered = 0;
    try {
      recovered = await recover();
    } catch (e) {
      ctx.logger.warn("Studio render recovery failed", { error: errorText(e) });
    }
    const current = active.keys().next().value ?? null;
    if (current || !opts.executor) return { recovered, claimed: null, running: current };
    const job = await claimNextRender(ctx);
    if (!job) return { recovered, claimed: null, running: null };
    start(job, opts.executor);
    return { recovered, claimed: job.id, running: job.id };
  }

  return {
    tick() {
      // Overlapping ticks in one worker share one pass, so they can never claim twice.
      ticking ??= tickOnce().finally(() => {
        ticking = null;
      });
      return ticking;
    },
    recover,
    running: () => [...active.values()].map(({ id, token, pgid, workdir }) => ({ id, token, pgid, workdir })),
    async settled() {
      while (active.size) await Promise.all([...active.values()].map((a) => a.done));
    },
  };
}
