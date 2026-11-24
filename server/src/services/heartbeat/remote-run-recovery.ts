import { and, eq, inArray } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import type { SshRunCheck } from "@paperclipai/adapter-utils/ssh";
import { isSshLease } from "../environment-run-lease-settlement.js";
import { legacyControllerBootId, legacyControllerProvenGone } from "../legacy-controller-lease.js";
import { sshLeaseHasRemoteRunDir } from "../ssh-run-lease-release.js";

/** All remote checks of one recovery pass share this cap (PAR-9919). */
export const SSH_RECOVERY_CHECK_TOTAL_MS = 15_000;

type Run = typeof heartbeatRuns.$inferSelect;
/** Gone checks of a run's ssh leases, by lease id. */
export type SshRunGoneChecks = ReadonlyMap<string, SshRunCheck>;

const timedOut = (): SshRunCheck => ({ result: "unknown", basis: "check_failed", checkedAt: new Date().toISOString() });

/**
 * Restart recovery of a legacy ssh run (PAR-9919, plan 13.4 with 13.9 decision 3,
 * findings 3 and 4). Check-only: the remote is never signalled.
 *
 * A legacy run whose controller (an earlier boot) is proven gone and whose
 * only active leases are ssh leases with a run dir gets one read-only remote
 * check per lease. All checks start at once, outside any transaction, and
 * share one total cap; a check still pending at the cap counts as `unknown`.
 * `remoteGone` returns the checks when every lease of the run is `gone`
 * (`never_spawned` is `gone`), else null: the run then stays detached and the
 * next pass checks again. The caller settles the run through the lost-run
 * path and passes these checks to the release, which makes no check of its own.
 */
export function startSshRunRecoveryChecks(db: Db,
  runtime: { checkSshRunLease(leaseId: string): Promise<SshRunCheck> },
  runs: Run[], options: { skipRunId?: (runId: string) => boolean; totalMs?: number } = {},
): { remoteGone(runId: string): Promise<SshRunGoneChecks | null> } {
  const byRun = (async () => {
    const results = new Map<string, Promise<SshRunGoneChecks | null>>();
    const candidates: Run[] = [];
    for (const run of runs) {
      if (run.runtimeMode !== "legacy" || run.controllerBootId === legacyControllerBootId
        || (run.processPid == null && run.processGroupId == null) || options.skipRunId?.(run.id)) continue;
      if (await legacyControllerProvenGone(run)) candidates.push(run);
    }
    if (candidates.length === 0) return results;
    const leases = await db.select().from(environmentLeases).where(and(
      inArray(environmentLeases.heartbeatRunId, candidates.map(run => run.id)), eq(environmentLeases.status, "active")));
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<SshRunCheck>(resolve => {
      timer = setTimeout(() => resolve(timedOut()), options.totalMs ?? SSH_RECOVERY_CHECK_TOTAL_MS);
      timer.unref?.();
    });
    const pending: Promise<unknown>[] = [];
    for (const run of candidates) {
      const own = leases.filter(lease => lease.heartbeatRunId === run.id && lease.companyId === run.companyId);
      // A lease written before PAR-9917 (no run dir) or a non-ssh lease keeps
      // today's behaviour: the run stays detached.
      if (own.length === 0 || !own.every(lease => isSshLease(lease) && sshLeaseHasRemoteRunDir(lease))) continue;
      const checks = Promise.all(own.map(async lease => [lease.id, await Promise.race([
        runtime.checkSshRunLease(lease.id).catch(timedOut), cap])] as const));
      pending.push(checks);
      results.set(run.id, checks.then(entries =>
        entries.every(([, check]) => check.result === "gone") ? new Map(entries) : null));
    }
    void Promise.allSettled(pending).then(() => clearTimeout(timer));
    return results;
  })().catch(() => new Map<string, Promise<SshRunGoneChecks | null>>());
  return {
    async remoteGone(runId) {
      return (await (await byRun).get(runId)?.catch(() => null)) ?? null;
    },
  };
}
