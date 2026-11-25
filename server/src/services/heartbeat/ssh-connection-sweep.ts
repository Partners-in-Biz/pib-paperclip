import { inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { sweepStaleSshControlDirs } from "@paperclipai/adapter-utils/ssh";

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
