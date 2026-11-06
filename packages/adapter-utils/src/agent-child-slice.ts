import { execFile } from "node:child_process";

/**
 * Optional systemd slice for local agent children (PAR-7678).
 *
 * When the server env sets `PAPERCLIP_AGENT_CHILD_SLICE` (for example
 * `pib-agent-devtools.slice`), local agent processes are started through
 * `systemd-run --scope --slice=<slice>`. A scope execs the command in place,
 * so the child keeps its PID, process group, stdio pipes and environment; only
 * its cgroup changes. Every dev-tool grandchild (lint, build, test) inherits
 * that cgroup and so falls under the slice's memory settings.
 *
 * The wrapper is used only after a one-time probe proves the server user may
 * create a scope in that slice (polkit grant or root). When the probe fails,
 * Paperclip logs one warning and spawns children directly, as before.
 */

export const AGENT_CHILD_SLICE_ENV = "PAPERCLIP_AGENT_CHILD_SLICE";

const SLICE_NAME_RE = /^[A-Za-z0-9:_.-]+\.slice$/;
const PROBE_TIMEOUT_MS = 5_000;

export function resolveAgentChildSliceName(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[AGENT_CHILD_SLICE_ENV]?.trim();
  if (!raw) return null;
  if (!SLICE_NAME_RE.test(raw)) {
    console.warn(
      `[paperclip] ignoring ${AGENT_CHILD_SLICE_ENV}="${raw}": not a valid systemd slice name`,
    );
    return null;
  }
  return raw;
}

export function buildSliceScopeArgs(slice: string): string[] {
  return ["--scope", "--quiet", "--collect", `--slice=${slice}`, "--"];
}

export type SliceProbe = (slice: string) => Promise<boolean>;

export const probeSystemdRunSlice: SliceProbe = (slice) =>
  new Promise((resolve) => {
    if (process.platform !== "linux") {
      resolve(false);
      return;
    }
    execFile(
      "systemd-run",
      [...buildSliceScopeArgs(slice), "true"],
      { timeout: PROBE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          console.warn(
            `[paperclip] ${AGENT_CHILD_SLICE_ENV}=${slice} set, but systemd-run cannot start a scope in it; agent children stay in the server cgroup. ${String(stderr || err.message).trim()}`,
          );
          resolve(false);
          return;
        }
        resolve(true);
      },
    );
  });

const probeCache = new Map<string, Promise<boolean>>();

/**
 * Returns the slice to use for local agent children, or null when none is
 * configured or the probe failed. The probe runs once per slice per process.
 */
export async function resolveUsableAgentChildSlice(
  env: NodeJS.ProcessEnv = process.env,
  probe: SliceProbe = probeSystemdRunSlice,
): Promise<string | null> {
  const slice = resolveAgentChildSliceName(env);
  if (!slice) return null;
  let cached = probeCache.get(slice);
  if (!cached) {
    cached = probe(slice).catch(() => false);
    probeCache.set(slice, cached);
  }
  return (await cached) ? slice : null;
}

export function resetAgentChildSliceProbeCacheForTests(): void {
  probeCache.clear();
}

/** Wraps an argv-style spawn target in `systemd-run --scope --slice=...`. */
export function wrapSpawnInSlice(
  slice: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return {
    command: "systemd-run",
    args: [...buildSliceScopeArgs(slice), command, ...args],
  };
}

/** Prefixes a shell-style command string (acpx agent override). */
export function wrapCommandStringInSlice(slice: string, commandLine: string): string {
  return `systemd-run ${buildSliceScopeArgs(slice).join(" ")} ${commandLine}`;
}
