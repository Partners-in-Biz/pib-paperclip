import { inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { cleanupSshConnectionReuse, sweepStaleSshControlDirs } from "@paperclipai/adapter-utils/ssh";
import { logger } from "../../middleware/logger.js";

// Mirrors HEARTBEAT_RUN_TERMINAL_STATUSES (recovery.ts) without its import graph.
// A status missing here only keeps a directory until the next start.
const TERMINAL_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server start: remove the ssh control directories a restart left behind in
 * mid-run (PAR-9403). A directory is kept only while its run is not terminal;
 * an unknown run id is stale.
 */
export async function sweepStaleSshConnectionDirsAtStartup(
  db: Pick<Db, "select">,
  options: { baseDir?: string } = {},
): Promise<{ removed: string[]; kept: string[] }> {
  return await sweepStaleSshControlDirs({
    baseDir: options.baseDir,
    activeRunIds: async (candidateRunIds) => {
      const ids = candidateRunIds.filter((id) => UUID_RE.test(id));
      if (ids.length === 0) return new Set<string>();
      const rows = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, ids));
      return new Set(rows.filter((row) => !TERMINAL_STATUSES.has(row.status)).map((row) => row.id));
    },
  });
}

/**
 * Closes the run's shared ssh master (`ssh -O exit`) once no holder may still
 * multiplex over it, such as a native owner's Paperclip bridge (PAR-14564).
 * Never on a terminal status alone: while `ownershipHeld` the master survives,
 * and the lease release that follows the ownership clearing closes it.
 * Idempotent; returns whether the close ran.
 */
export async function closeRunSshConnectionWhenReleased(input: {
  runId: string;
  status: string | null | undefined;
  ownershipHeld: boolean;
  baseDir?: string;
}): Promise<boolean> {
  if (input.ownershipHeld || !input.status || !TERMINAL_STATUSES.has(input.status)) return false;
  await cleanupSshConnectionReuse({ runId: input.runId, baseDir: input.baseDir }).catch((err) => {
    logger.warn({ err, runId: input.runId }, "failed to close the run's shared ssh connection");
  });
  return true;
}
