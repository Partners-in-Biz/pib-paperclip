/**
 * Hand the Hermes prompt over in a private file instead of argv.
 *
 * Linux refuses to start a process when ONE argv or environment string is
 * longer than 131072 bytes (MAX_ARG_STRLEN, spawn E2BIG). A task history can
 * push the prompt past that, so the prompt goes to a 0600 file that Hermes
 * reads with `hermes chat --query-file`. Nothing is cut.
 *
 * Ported from the pib-ops host patch hermes-e2big ([query-file]).
 * Upstream: paperclipai/paperclip#14495.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Linux MAX_ARG_STRLEN with 4 KiB pages: longest single argv or env string, NUL included. */
export const KERNEL_STRING_LIMIT = 131072;

const QUERY_DIR_PREFIX = "paperclip-hermes-query-";
const QUERY_DIR_PATTERN = /^paperclip-hermes-query-[A-Za-z0-9]{6}$/;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PreparedQuery {
  /** Args that follow `chat`. */
  args: string[];
  bytes: number;
  via: "--query-file" | "-q";
  cleanup: () => Promise<void>;
}

let swept = false;

/**
 * Remove query folders left behind by a run that was killed (a server restart
 * ends runs without their cleanup). Own folders only, older than a day.
 */
export async function sweepOldQueries(force = false, tmpRoot: string = os.tmpdir()): Promise<void> {
  if (swept && !force) return;
  swept = true;
  try {
    const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
    for (const name of await fsp.readdir(tmpRoot)) {
      if (!QUERY_DIR_PATTERN.test(name)) continue;
      const full = path.join(tmpRoot, name);
      const info = await fsp.lstat(full);
      if (
        info.isDirectory() &&
        info.mtimeMs < cutoff &&
        (typeof process.getuid !== "function" || info.uid === process.getuid())
      ) {
        await fsp.rm(full, { recursive: true, force: true });
      }
    }
  } catch {
    // best effort
  }
}

/**
 * Write the prompt to a private file for --query-file. Falls back to `-q` only
 * when the file cannot be written and the prompt is small enough for argv.
 */
export async function prepareQuery(prompt: string, tmpRoot: string = os.tmpdir()): Promise<PreparedQuery> {
  const bytes = Buffer.byteLength(prompt, "utf8");
  let dir: string | null = null;
  await sweepOldQueries(false, tmpRoot);
  try {
    dir = await fsp.mkdtemp(path.join(tmpRoot, QUERY_DIR_PREFIX));
    const file = path.join(dir, "query.txt");
    await fsp.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
    const made = dir;
    return {
      args: ["--query-file", file],
      bytes,
      via: "--query-file",
      cleanup: async () => {
        await fsp.rm(made, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (bytes + 16 >= KERNEL_STRING_LIMIT) {
      throw new Error(
        `Cannot start Hermes: the ${bytes}-byte prompt is too large for one command-line argument and the query file could not be written (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    return { args: ["-q", prompt], bytes, via: "-q", cleanup: async () => undefined };
  }
}

/** Remove environment strings the kernel would refuse (spawn E2BIG). Returns what was removed. */
export function guardEnvStrings(env: Record<string, string | undefined>): Array<{ key: string; bytes: number }> {
  const dropped: Array<{ key: string; bytes: number }> = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const bytes = Buffer.byteLength(key, "utf8") + 1 + Buffer.byteLength(value, "utf8") + 1;
    if (bytes > KERNEL_STRING_LIMIT) {
      dropped.push({ key, bytes });
      delete env[key];
    }
  }
  return dropped;
}
