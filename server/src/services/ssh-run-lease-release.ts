import { and, eq, isNull, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease, EnvironmentLeaseStatus } from "@paperclipai/shared";
import {
  buildSshRunDirCleanupScript, checkRemoteRun, runSshCommand, sshRunDirIsConfined,
  type SshConnectionConfig, type SshRunCheck,
} from "@paperclipai/adapter-utils/ssh";
import { logger } from "../middleware/logger.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { remoteTerminationReceipt, type RemoteTerminationEvidence } from "./remote-execution-termination.js";
import { nextSshCheckAt } from "./ssh-run-lease.js";

// Release of an ssh run lease (PAR-9961, plan 13.9 findings 1, 3, 5, 6). The
// driver gets the lease status: a cancelled run arrives as "expired".

const failedCheck = (): SshRunCheck => ({ result: "unknown", basis: "check_failed", checkedAt: new Date().toISOString() });

/** The ssh config with the workspace path recorded at acquire (the run dir was derived from it). */
async function sshLeaseConfig(db: Db, lease: EnvironmentLease, environment: Environment | null): Promise<SshConnectionConfig | null> {
  const parsed = environment?.driver === "ssh"
    ? await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment) : null;
  if (parsed?.driver !== "ssh") return null;
  const recorded = lease.metadata?.remoteWorkspacePath;
  return { ...parsed.config, remoteWorkspacePath: typeof recorded === "string" ? recorded : parsed.config.remoteWorkspacePath };
}

/** Read-only remote check of an ssh lease's run (PAR-9917). Never throws. */
export async function checkSshLease(db: Db, lease: EnvironmentLease, environment: Environment | null): Promise<SshRunCheck> {
  try {
    const config = await sshLeaseConfig(db, lease, environment);
    return config ? await checkRemoteRun(config, lease.metadata ?? null) : failedCheck();
  } catch {
    return failedCheck();
  }
}

/** True when the release of this ssh lease is decided by the remote check. A
 * lease written before PAR-9917 has no run dir and keeps the old release. */
export function sshLeaseHasRemoteRunDir(lease: { metadata: Record<string, unknown> | null }): boolean {
  const runDir = lease.metadata?.remoteRunDir;
  return typeof runDir === "string" && runDir.length > 0;
}

/** When the next check of an unconfirmed lease is due; null: due now. */
export function sshNextCheckDueAt(lease: { metadata: Record<string, unknown> | null }): number | null {
  const at = Date.parse(String(lease.metadata?.sshNextCheckAt ?? ""));
  return Number.isFinite(at) ? at : null;
}

export async function releaseSshRunLease(db: Db, input: {
  environment: Environment | null;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
  remoteCheck?: SshRunCheck;
}, now: Date = new Date()): Promise<EnvironmentLease | null> {
  const environmentsSvc = environmentService(db);
  const { lease, status } = input;
  if (lease.status !== "active" || !sshLeaseHasRemoteRunDir(lease)) {
    return await environmentsSvc.releaseLease(lease.id, status);
  }
  const dueAt = sshNextCheckDueAt(lease);
  // Not due yet: no ssh call; the lease stays active and is not reported released.
  if (!input.remoteCheck && dueAt !== null && dueAt > now.getTime()) return null;
  const check = input.remoteCheck ?? await checkSshLease(db, lease, input.environment);

  if (check.result === "gone") {
    const evidence: RemoteTerminationEvidence = {
      basis: check.basis, ...(check.pgid !== undefined ? { pgid: check.pgid } : {}),
      ...(check.leaderStart ? { leaderStart: check.leaderStart } : {}), checkedAt: check.checkedAt,
      coverage: "process group only; detached sessions (setsid) not covered",
    };
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }, evidence);
    const released = await environmentsSvc.releaseLease(lease.id, status,
      receipt ? { cleanupStatus: "success", remoteExecutionTermination: receipt } : undefined);
    await removeSshRunDir(db, lease, input.environment);
    return released;
  }
  if (status === "expired") {
    // A cancelled run that may still be live: keep the lease active so the
    // issue, workspace and pause stay held; the orphan sweep checks it again.
    const attempts = Number(lease.metadata?.sshCheckAttempts ?? 0) + 1;
    await db.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
        sshCheckAttempts: attempts, sshNextCheckAt: nextSshCheckAt(attempts, now).toISOString(),
        sshLastCheckResult: check.result, sshLastCheckBasis: check.basis,
      })}::jsonb`,
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.status, "active")));
    return null;
  }
  // A finished run (released/failed) that the check cannot confirm: release as
  // before, without receipt, and keep the run dir.
  return await environmentsSvc.releaseLease(lease.id, status);
}

/** Remove `remoteRunDir` after a gone check (13.9 decision 2), then sweep
 * leftover sibling run dirs older than 7 days (PAR-9962). Best effort. */
async function removeSshRunDir(db: Db, lease: EnvironmentLease, environment: Environment | null) {
  try {
    const config = await sshLeaseConfig(db, lease, environment);
    const runDir = String(lease.metadata?.remoteRunDir);
    if (!config || !sshRunDirIsConfined(config.remoteWorkspacePath, runDir)) return;
    await runSshCommand(config, buildSshRunDirCleanupScript(config.remoteWorkspacePath, runDir), { timeoutMs: 10_000 });
  } catch {
    logger.warn({ leaseId: lease.id }, "ssh run dir removal failed after a gone check");
  }
}

const clock = (value: unknown) => {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(11, 16)} UTC` : "due now";
};

/** One line per unconfirmed ssh run, for the pause status (PAR-9962, 13.9 finding 5). */
export function sshPauseWaitText(lease: { heartbeatRunId: string | null; metadata: Record<string, unknown> | null }, host: string | null): string {
  const meta = lease.metadata ?? {};
  const last = typeof meta.sshLastCheckBasis === "string"
    ? `${typeof meta.sshLastCheckResult === "string" ? meta.sshLastCheckResult : "unknown"}/${meta.sshLastCheckBasis}` : "none yet";
  return `Waiting for proof that run ${lease.heartbeatRunId} on ${host ?? "an unknown host"} has stopped `
    + `(last check: ${last}, next ${clock(meta.sshNextCheckAt)}).`;
}

/** The pause status while a cancelled run's ssh lease is kept active by
 * `releaseSshRunLease`; null when no such lease is left. */
export async function sshPauseWaitDetail(db: Db, agentId: string): Promise<string | null> {
  const rows = await db.select({ lease: environmentLeases, config: environments.config }).from(environmentLeases)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "cancelled"), eq(environmentLeases.provider, "ssh"),
      eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt)));
  const lines = rows.filter(row => sshLeaseHasRemoteRunDir(row.lease)).map(row => {
    const host = (row.config as Record<string, unknown> | null)?.host;
    return sshPauseWaitText(row.lease, typeof host === "string" ? host : null);
  });
  return lines.length ? lines.join(" ") : null;
}
