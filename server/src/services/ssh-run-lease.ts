import { eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { sshRemoteRunDirFor } from "@paperclipai/adapter-utils/ssh";

// Facts an ssh lease keeps about its remote run (PAR-9917, plan 13.9). Nothing
// acts on them yet; the release (PAR-9961) and recovery (PAR-9919) read them.
// Retry keys of the check: `sshCheckAttempts`, `sshNextCheckAt` (see nextSshCheckAt).
const SSH_RUN_LEASE_FACT_KEYS = ["remoteRunDir", "remoteSpawnStartedAt"] as const;

/** Host-chosen remote run directory, fixed at lease acquire (13.9 decision 1).
 * The same function the ssh spawn uses for its record, so both name one path. */
export function sshRemoteRunDir(remoteWorkspacePath: string, heartbeatRunId: string): string | null {
  return sshRemoteRunDirFor(remoteWorkspacePath, heartbeatRunId);
}

/** Keep the ssh run facts when a writer replaces lease metadata from an older copy. */
export function preserveSshRunLeaseFacts(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const kept = SSH_RUN_LEASE_FACT_KEYS.filter(key => previous?.[key] !== undefined && next?.[key] === undefined);
  if (kept.length === 0) return next;
  return { ...(next ?? {}), ...Object.fromEntries(kept.map(key => [key, previous![key]])) };
}

/** Spawn marker (13.9 finding 4): written before the ssh child of this lease is
 * spawned. One atomic jsonb merge, so no other metadata write is lost. */
export async function markSshRunSpawnStarted(
  db: Db,
  target: { kind: string; transport?: string; leaseId?: string | null } | null | undefined,
  now: Date = new Date(),
): Promise<void> {
  if (target?.kind !== "remote" || target.transport !== "ssh" || !target.leaseId) return;
  await db.update(environmentLeases)
    .set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ remoteSpawnStartedAt: now.toISOString() })}::jsonb` })
    .where(eq(environmentLeases.id, target.leaseId));
}

const SSH_CHECK_FIRST_DELAY_MS = 30_000;
const SSH_CHECK_MAX_DELAY_MS = 30 * 60_000;

/** Retry schedule (13.9 finding 5): 30 s after the first failed check, doubling, capped at 30 min. */
export function nextSshCheckAt(attempts: number, now: Date): Date {
  const step = Math.max(0, Math.floor(Number.isFinite(attempts) ? attempts : 0) - 1);
  const delay = Math.min(SSH_CHECK_MAX_DELAY_MS, SSH_CHECK_FIRST_DELAY_MS * 2 ** Math.min(step, 16));
  return new Date(now.getTime() + delay);
}
