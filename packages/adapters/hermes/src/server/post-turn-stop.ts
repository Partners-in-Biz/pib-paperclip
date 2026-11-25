/**
 * Stop a Hermes run once its turn has ended (PAR-13539).
 *
 * `hermes chat -Q` does not exit when the agent writes its final answer. It
 * first lingers for `notify_on_complete` background processes (up to
 * `terminal.oneshot_completion_wait_seconds`, 600 s by default) and then replays
 * every queued `[IMPORTANT: Background process ... completed]` notification as a
 * new agent turn, up to 8 rounds. A run that left dev servers or test jobs
 * behind kept burning tokens after its handoff until `timeoutSec` killed it.
 *
 * Hermes writes a turn report to `HERMES_QUIET_TURN_REPORT_FILE` the moment the
 * turn ends, before that linger. This guard watches for the report (inotify via
 * fs.watch, no polling) and, if Hermes is still running `graceSec` later, stops
 * it: SIGTERM to the Hermes process group and to the process groups of its
 * descendants (background jobs run in their own sessions, so a group signal to
 * Hermes alone does not reach them), then SIGKILL after `killGraceSec`.
 *
 * Older Hermes builds ignore the variable: no report, no stop, same behaviour
 * as before.
 */

import { watch, type FSWatcher } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TURN_REPORT_FILE_ENV = "HERMES_QUIET_TURN_REPORT_FILE";
export const DEFAULT_POST_TURN_EXIT_GRACE_SEC = 30;

// Same prefix as the query-file folders, so sweepOldQueries() also removes a
// folder left behind by a server restart.
const DIR_PREFIX = "paperclip-hermes-query-";
const REPORT_NAME = "turn-report.json";

export interface HermesTurnReport {
  exitCode: number;
  error: string;
  reply: string;
}

/** Parse Hermes' `{pid, exit_code, error, reply}` record; null when incomplete or not JSON. */
export function parseTurnReport(text: string): HermesTurnReport | null {
  let record: unknown;
  try {
    record = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  if (typeof r.exit_code !== "number" || !Number.isInteger(r.exit_code)) return null;
  return {
    exitCode: r.exit_code,
    error: typeof r.error === "string" ? r.error : "",
    reply: typeof r.reply === "string" ? r.reply : "",
  };
}

/**
 * Process groups of every live descendant of `rootPid` other than its own
 * group (Linux /proc). Empty when /proc is unavailable.
 */
export async function listDescendantProcessGroups(rootPid: number, procRoot = "/proc"): Promise<number[]> {
  let names: string[];
  try {
    names = await fsp.readdir(procRoot);
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  const groupOf = new Map<number, number>();
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        let stat: string;
        try {
          stat = await fsp.readFile(path.join(procRoot, name, "stat"), "utf8");
        } catch {
          return;
        }
        // "pid (comm) state ppid pgrp ..."; comm can hold spaces and parens.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const pid = Number(name);
        const ppid = Number(fields[1]);
        const pgrp = Number(fields[2]);
        if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return;
        groupOf.set(pid, pgrp);
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
      }),
  );
  const rootGroup = groupOf.get(rootPid);
  const groups = new Set<number>();
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const pgrp = groupOf.get(pid);
    if (pgrp && pgrp > 1 && pgrp !== rootGroup && pgrp !== process.pid) groups.add(pgrp);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...groups];
}

export interface PostTurnStopOutcome {
  /** The last report Hermes wrote (a follow-up turn rewrites it), or null. */
  report: HermesTurnReport | null;
  /** True when the guard signalled Hermes because it outlived the grace. */
  stopped: boolean;
  /** True when SIGTERM was not enough and the guard sent SIGKILL. */
  forceKilled: boolean;
}

export interface PostTurnStopGuard {
  /** Hand to Hermes as HERMES_QUIET_TURN_REPORT_FILE. */
  reportPath: string;
  /** Call once the process has ended: clears timers, removes the folder. */
  finish(): Promise<PostTurnStopOutcome>;
}

export interface PostTurnStopOptions {
  /** Seconds Hermes may keep running after its turn report. */
  graceSec: number;
  /** Seconds between SIGTERM and SIGKILL. */
  killGraceSec: number;
  /** The running Hermes process (its group leader), or null once it has ended. */
  getProcess: () => { pid: number; signal: (signal: NodeJS.Signals) => void } | null;
  onLog: (line: string) => Promise<void>;
  tmpRoot?: string;
  listDescendantGroups?: (rootPid: number) => Promise<number[]>;
}

function signalGroups(groups: number[], signal: NodeJS.Signals) {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch {
      // already gone
    }
  }
}

/** Returns null when the report folder or the watch cannot be set up; the run then behaves as before. */
export async function startPostTurnStopGuard(opts: PostTurnStopOptions): Promise<PostTurnStopGuard | null> {
  let dir: string;
  try {
    dir = await fsp.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), DIR_PREFIX));
  } catch {
    return null;
  }
  const reportPath = path.join(dir, REPORT_NAME);
  const listGroups = opts.listDescendantGroups ?? ((pid: number) => listDescendantProcessGroups(pid));
  let watcher: FSWatcher | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let finished = false;
  let reported = false;
  let stopped = false;
  let forceKilled = false;
  let latest: HermesTurnReport | null = null;
  let logChain: Promise<void> = Promise.resolve();
  const log = (line: string) => {
    logChain = logChain.then(() => opts.onLog(line)).catch(() => undefined);
  };
  const readReport = async () => {
    try {
      return parseTurnReport(await fsp.readFile(reportPath, "utf8"));
    } catch {
      return null;
    }
  };

  const stop = async () => {
    graceTimer = null;
    const running = finished ? null : opts.getProcess();
    if (!running) return;
    const groups = await listGroups(running.pid).catch(() => [] as number[]);
    if (finished) return;
    stopped = true;
    log(
      `[hermes] The turn ended ${opts.graceSec}s ago but Hermes is still running (background-process notifications or exit linger); stopping it and ${groups.length} background process group(s) instead of waiting for timeoutSec.\n`,
    );
    running.signal("SIGTERM");
    signalGroups(groups, "SIGTERM");
    killTimer = setTimeout(() => {
      killTimer = null;
      signalGroups(groups, "SIGKILL");
      const stillRunning = finished ? null : opts.getProcess();
      if (!stillRunning) return;
      forceKilled = true;
      stillRunning.signal("SIGKILL");
    }, Math.max(1, opts.killGraceSec) * 1000);
  };

  const onChange = () => {
    if (reported || finished) return;
    void readReport().then((report) => {
      if (!report || reported || finished) return;
      reported = true;
      latest = report;
      log(`[hermes] Turn finished (exit code ${report.exitCode}); Hermes has ${opts.graceSec}s to exit on its own.\n`);
      graceTimer = setTimeout(() => void stop(), opts.graceSec * 1000);
    });
  };

  try {
    watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (!name || String(name) === REPORT_NAME) onChange();
    });
    watcher.on("error", () => undefined);
  } catch {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  return {
    reportPath,
    async finish() {
      finished = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      watcher?.close();
      const report = (await readReport()) ?? latest;
      // A pending kill timer stays armed: Hermes may exit on SIGTERM while a
      // background group ignores it. It only SIGKILLs those groups now.
      killTimer?.unref();
      await logChain;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return { report, stopped, forceKilled };
    },
  };
}
