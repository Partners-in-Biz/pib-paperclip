/**
 * Which local files an agent's tool call may send to Drive (PAR-9219 B.1-B.6): only files inside the calling run's
 * workspace (cwd, worktree) or its scratch dir, as the host wrote them on the run row. The check works on the opened
 * handle, not the string: O_NOFOLLOW, then the handle's real path from /proc/self/fd, then fstat. A fixed deny-list
 * keeps dotfiles, keys and credential files on the host. Refusals name the rule, never a path outside the roots.
 */
import { constants } from "node:fs";
import { open, readlink, realpath, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Viewer } from "../domain.js";

export type RunScopeReason =
  | "no_run"
  | "run_not_found"
  | "run_other_company"
  | "run_other_agent"
  | "run_not_running"
  | "remote_run"
  | "no_roots"
  | "dot_dot"
  | "missing"
  | "symlink"
  | "outside_roots"
  | "not_a_file"
  | "hardlink"
  | "secret_file";

export interface RunScopeRefusal {
  ok: false;
  code: "path_not_allowed";
  reason: RunScopeReason;
  hint: string;
}

export type RunRoots = { ok: true; roots: string[] } | RunScopeRefusal;
export type RunFile = { ok: true; fh: FileHandle; realPath: string; root: string; stat: Stats } | RunScopeRefusal;

export const OUTSIDE_HINT = "The file must be inside this run's workspace or its scratch dir ($PAPERCLIP_TMPDIR, not $TMPDIR).";
const NOT_RUNNING_HINT = "Saving or fetching by path works only from a run of yours that is still running.";
const REMOTE_HINT = "Saving or fetching by path works only for runs on this server. This run uses a remote environment, so its files are not reachable from here.";
const SECRET_HINT = "This looks like a secret or settings file, so it is not sent to Drive.";
const HINTS: Record<RunScopeReason, string> = {
  no_run: NOT_RUNNING_HINT,
  run_not_found: NOT_RUNNING_HINT,
  run_other_company: NOT_RUNNING_HINT,
  run_other_agent: NOT_RUNNING_HINT,
  run_not_running: NOT_RUNNING_HINT,
  remote_run: REMOTE_HINT,
  no_roots: "This run has no workspace or scratch dir on this server, so it cannot send files by path.",
  dot_dot: `The path may not contain "..". ${OUTSIDE_HINT}`,
  missing: `No file at that path. ${OUTSIDE_HINT}`,
  symlink: `The path is a symbolic link; give the file itself. ${OUTSIDE_HINT}`,
  outside_roots: OUTSIDE_HINT,
  not_a_file: `The path is not a regular file. ${OUTSIDE_HINT}`,
  hardlink: `The file has more than one hard link, so it is not sent. Copy it to a new file first. ${OUTSIDE_HINT}`,
  secret_file: SECRET_HINT,
};

const refuse = (reason: RunScopeReason): RunScopeRefusal => ({ ok: false, code: "path_not_allowed", reason, hint: HINTS[reason] });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunRow {
  status: string;
  cwd: string | null;
  worktree_path: string | null;
  scratch_dir: string | null;
  environment: { driver?: unknown; remoteCwd?: unknown } | null;
}

/** Local only when the host recorded no environment, or a `local` one without a remote cwd (Q8). */
export function isLocalEnvironment(env: RunRow["environment"]): boolean {
  if (env === null || env === undefined) return true;
  return env.driver === "local" && (env.remoteCwd === undefined || env.remoteCwd === null || env.remoteCwd === "");
}

/** The real paths of the calling run's cwd, worktree and scratch dir, when the run is the viewer's own, running and local. */
export async function resolveRunRoots(ctx: PluginContext, viewer: Viewer): Promise<RunRoots> {
  if (!viewer.runId || !viewer.agentId) return refuse("no_run");
  // The id columns are uuids: anything else would be a query error, not a refusal.
  if (![viewer.runId, viewer.companyId, viewer.agentId].every((id) => UUID.test(id))) return refuse("run_not_found");
  const rows = await ctx.db.query<RunRow>(
    `SELECT status,
            context_snapshot -> 'paperclipWorkspace' ->> 'cwd' AS cwd,
            context_snapshot -> 'paperclipWorkspace' ->> 'worktreePath' AS worktree_path,
            context_snapshot -> 'paperclipScratch' ->> 'dir' AS scratch_dir,
            context_snapshot -> 'paperclipEnvironment' AS environment
       FROM public.heartbeat_runs
      WHERE id = $1 AND company_id = $2 AND agent_id = $3
      LIMIT 1`,
    [viewer.runId, viewer.companyId, viewer.agentId],
  );
  const row = rows[0];
  if (!row) {
    // Only which rule failed is learned here, never another run's data.
    const other = await ctx.db.query<{ same_company: boolean }>(
      `SELECT company_id = $2 AS same_company FROM public.heartbeat_runs WHERE id = $1 LIMIT 1`,
      [viewer.runId, viewer.companyId],
    );
    if (!other[0]) return refuse("run_not_found");
    return refuse(other[0].same_company ? "run_other_agent" : "run_other_company");
  }
  if (row.status !== "running") return refuse("run_not_running");
  if (!isLocalEnvironment(row.environment)) return refuse("remote_run");
  const roots: string[] = [];
  for (const dir of [row.cwd, row.worktree_path, row.scratch_dir]) {
    if (typeof dir !== "string" || !isAbsolute(dir)) continue;
    try {
      const real = await realpath(dir);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // A root that is gone is dropped.
    }
  }
  return roots.length ? { ok: true, roots } : refuse("no_roots");
}

/** The deepest root that holds `real`, or null. */
function rootOf(roots: string[], real: string): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const rel = relative(root, real);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

const SECRET_NAME = /(\.(pem|key|p12|pfx|jks|keystore|env)$)|(^id_(rsa|ecdsa|ed25519))|credential|secret|(^(auth|token|service-account).*\.json$)/i;

/** B.4: a dot segment below the root, or a key/credential/settings file name. `rel` is relative to its root. */
export function isDeniedPath(rel: string): boolean {
  if (rel.split(sep).some((segment) => segment.startsWith("."))) return true;
  return SECRET_NAME.test(basename(rel));
}

/** Opens `path` read-only for the run. On success the caller owns the handle and must close it. */
export async function openRunFile(roots: string[], path: string): Promise<RunFile> {
  if (!roots.length) return refuse("no_roots");
  if (path.split(/[\\/]/).includes("..")) return refuse("dot_dot");
  const target = isAbsolute(path) ? path : resolve(roots[0]!, path);
  let fh: FileHandle;
  try {
    // O_NONBLOCK: a FIFO must not hang the worker; it is refused below as not a file.
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return refuse("symlink");
    if (code === "ENOENT" || code === "ENOTDIR") return refuse("missing");
    return refuse("outside_roots");
  }
  try {
    const realPath = await readlink(`/proc/self/fd/${fh.fd}`);
    const root = rootOf(roots, realPath);
    if (!root) return await closeAnd(fh, "outside_roots");
    const stat = await fh.stat();
    if (!stat.isFile()) return await closeAnd(fh, "not_a_file");
    if (stat.nlink !== 1) return await closeAnd(fh, "hardlink");
    if (isDeniedPath(relative(root, realPath))) return await closeAnd(fh, "secret_file");
    return { ok: true, fh, realPath, root, stat };
  } catch {
    return closeAnd(fh, "outside_roots");
  }
}

async function closeAnd(fh: FileHandle, reason: RunScopeReason): Promise<RunScopeRefusal> {
  await fh.close().catch(() => undefined);
  return refuse(reason);
}
