/**
 * Helpers for running Hermes on a remote execution target (ssh environment,
 * for example the Mac build host) instead of on the Paperclip server.
 *
 * Everything here goes through `runAdapterExecutionTargetProcess`, the same
 * path claude_local uses, so the ssh driver, key handling and env sanitising
 * stay in adapter-utils. Nothing in this file runs for a local agent.
 *
 * - The prompt is written to a private (0700 dir, 0600 file) temp path on the
 *   remote host through stdin, never through argv or the command line log.
 * - The remote command is started through a tiny `sh` wrapper that records its
 *   pid, so cancel / timeout can kill the remote process tree (killing the
 *   local ssh client alone leaves the remote process running).
 * - Session rows (resume baseline, token metering) are read from the remote
 *   Hermes state.db with a read-only python3 script run over ssh.
 */

import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

import type { SessionRow, RemoteSessionReader } from "./session-metering.js";

export type RemoteRun = (
  command: string,
  args: string[],
  options?: { stdin?: string; timeoutSec?: number },
) => Promise<RunProcessResult>;

const QUERY_MARK = "PCQ:";
const SESSION_MARK = "PCSESS:";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;

/** Create a private dir on the remote host and write the prompt into it. */
const STAGE_SCRIPT = [
  "umask 077",
  'd=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-hermes-query-XXXXXX") || exit 1',
  'cat > "$d/query.txt" || { rm -rf "$d"; exit 1; }',
  `printf '${QUERY_MARK}%s\\n' "$d"`,
].join("\n");

/** Kill the recorded pid and all its descendants (TERM, grace, KILL). Portable sh: works on macOS and Linux. */
const KILL_SCRIPT = [
  'pf="$1"; grace="$2"',
  '[ -f "$pf" ] || exit 0',
  'p=$(cat "$pf" 2>/dev/null)',
  'case "$p" in ""|*[!0-9]*) exit 0;; esac',
  'tree() { for c in $(ps -A -o pid=,ppid= | awk -v p="$1" \'$2==p{print $1}\'); do tree "$c"; done; echo "$1"; }',
  'pids=$(tree "$p")',
  'kill -TERM $pids 2>/dev/null',
  'sleep "$grace"',
  'kill -KILL $pids 2>/dev/null',
  "exit 0",
].join("\n");

/** Wrapper that records its pid then becomes the real command (same pid). */
const PID_WRAPPER = 'echo $$ > "$1"; shift; exec "$@"';

const SESSION_SCRIPT = `
import json, os, sqlite3, sys
home, sid, stop = sys.argv[1], sys.argv[2], sys.argv[3]
MARK = "${SESSION_MARK}"
def out(value):
    print(MARK + json.dumps(value))
try:
    home = os.path.expanduser(home) if home else os.path.join(os.path.expanduser("~"), ".hermes")
    path = os.path.join(home, "state.db")
    if not os.path.exists(path):
        out(None); sys.exit(0)
    db = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=1)
    have = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
    if not {"id", "input_tokens", "output_tokens"} <= have:
        out(None); sys.exit(0)
    wanted = ["parent_session_id", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "estimated_cost_usd", "actual_cost_usd"]
    cols = ["id"] + [c for c in wanted if c in have]
    rows, seen, cur = [], set(), sid
    while cur and cur not in seen and len(rows) < 8:
        seen.add(cur)
        r = db.execute("SELECT " + ", ".join(cols) + " FROM sessions WHERE id = ?", (cur,)).fetchone()
        if not r:
            break
        row = dict(zip(cols, r))
        rows.append(row)
        if cur == stop:
            break
        cur = row.get("parent_session_id") or None
    out(rows)
except SystemExit:
    raise
except Exception:
    out(None)
`;

function lastMarked(stdout: string, mark: string): string | null {
  let found: string | null = null;
  for (const line of (stdout || "").split(/\r?\n/)) {
    if (line.startsWith(mark)) found = line.slice(mark.length);
  }
  return found;
}

export interface StagedRemoteQuery {
  dir: string;
  queryFile: string;
  pidFile: string;
  bytes: number;
}

/** Write the prompt to a private remote temp dir. Throws when the host refuses. */
export async function stageRemoteQuery(run: RemoteRun, prompt: string): Promise<StagedRemoteQuery> {
  const result = await run("sh", ["-c", STAGE_SCRIPT], { stdin: prompt, timeoutSec: 60 });
  const dir = lastMarked(result.stdout, QUERY_MARK)?.trim() ?? "";
  if ((result.exitCode ?? 1) !== 0 || !dir.startsWith("/") || /[\s\0]/.test(dir)) {
    throw new Error(
      `Cannot start Hermes: the prompt could not be written to a private temp file on the remote host (exit ${result.exitCode ?? "null"}).`,
    );
  }
  return {
    dir,
    queryFile: `${dir}/query.txt`,
    pidFile: `${dir}/pid`,
    bytes: Buffer.byteLength(prompt, "utf8"),
  };
}

/** Command and args that run `command args` on the remote host and record its pid. */
export function wrapWithPidFile(
  pidFile: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", PID_WRAPPER, "sh", pidFile, command, ...args] };
}

/** Kill the process tree recorded in the pid file. Best effort; never throws. */
export async function killRemoteTree(run: RemoteRun, pidFile: string, graceSec: number): Promise<void> {
  try {
    await run("sh", ["-c", KILL_SCRIPT, "sh", pidFile, String(Math.max(0, Math.floor(graceSec)))], {
      timeoutSec: Math.max(10, graceSec + 15),
    });
  } catch {
    // best effort
  }
}

/** Delete the staged dir (query file and pid file). Best effort; never throws. */
export async function removeRemoteDir(run: RemoteRun, dir: string): Promise<void> {
  if (!dir.startsWith("/") || /[\s\0]/.test(dir) || !dir.includes("paperclip-hermes-query-")) return;
  try {
    await run("rm", ["-rf", dir], { timeoutSec: 30 });
  } catch {
    // best effort
  }
}

/** Reads Hermes session rows from the remote state.db. null = store unreadable. */
export function createRemoteSessionReader(run: RemoteRun): RemoteSessionReader {
  return async (home: string, sessionId: string, stopAtId?: string): Promise<SessionRow[] | null> => {
    if (!SESSION_ID.test(sessionId)) return null;
    if (stopAtId && !SESSION_ID.test(stopAtId)) return null;
    try {
      const result = await run("python3", ["-c", SESSION_SCRIPT, home, sessionId, stopAtId ?? ""], {
        timeoutSec: 30,
      });
      if ((result.exitCode ?? 1) !== 0) return null;
      const payload = lastMarked(result.stdout, SESSION_MARK);
      if (payload === null) return null;
      const parsed: unknown = JSON.parse(payload);
      return Array.isArray(parsed) ? (parsed as SessionRow[]) : null;
    } catch {
      return null;
    }
  };
}
