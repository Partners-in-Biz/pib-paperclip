import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const checkRemoteRun = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn(async () => ({ stdout: "removed\n", stderr: "" })));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => ({ remoteCwd: config.remoteWorkspacePath }),
  checkRemoteRun,
  runSshCommand,
}));

import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { sshRemoteRunDirFor } from "@paperclipai/adapter-utils/ssh";
import { markSshRunSpawnStarted, nextSshCheckAt } from "../services/ssh-run-lease.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("nextSshCheckAt", () => {
  it("waits 30 s after the first attempt, doubles, and caps at 30 min", () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 50].map(n => (nextSshCheckAt(n, now).getTime() - now.getTime()) / 1000);
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
  });
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("ssh run lease facts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-run-lease-");
      db = createDb(tempDb.connectionString);
    }
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function acquireSshLease(runStatus = "running") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), environmentId = randomUUID();
    const config = { host: "mac.test", port: 22, username: "max", remoteWorkspacePath: "/Users/max/ws/",
      privateKey: null, knownHosts: null, strictHostKeyChecking: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", issuePrefix: `S${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Max", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `ssh-${environmentId}`, driver: "ssh", status: "active", config });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    const environment = (await environmentService(db).getById(environmentId))!;
    const runtime = environmentRuntimeService(db);
    const { lease } = await runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: runId,
      persistedExecutionWorkspace: null });
    if (runStatus !== "running") {
      await db.update(heartbeatRuns).set({ status: runStatus, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    }
    return { companyId, agentId, runId, environment, runtime, lease };
  }

  const row = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const gone = { result: "gone", basis: "group_empty", pgid: 4242, leaderStart: "Thu Nov 12 09:00:00 2026", checkedAt: "2026-11-12T10:00:00.000Z" };
  const unknown = { result: "unknown", basis: "check_failed", checkedAt: "2026-11-12T10:00:00.000Z" };
  const removals = () => runSshCommand.mock.calls.filter(call => String(call[1]).includes("rm -rf"));

  describe("release (PAR-9961)", () => {
    beforeEach(() => { checkRemoteRun.mockReset(); runSshCommand.mockClear(); });

    it("a gone check writes a receipt with its evidence, then removes the run dir; a later release keeps it", async () => {
      const { runtime, runId, lease } = await acquireSshLease("cancelled");
      checkRemoteRun.mockResolvedValueOnce(gone);
      await runtime.releaseRunLeases(runId, "expired");
      const released = await row(lease.id);
      expect(hasRemoteTerminationReceipt(released)).toBe(true);
      expect(released).toMatchObject({ status: "expired", cleanupStatus: "success" });
      expect(released.metadata!.remoteExecutionTermination).toMatchObject({ state: "stopped",
        evidence: { basis: "group_empty", pgid: 4242, checkedAt: gone.checkedAt } });
      expect(removals()).toHaveLength(1);
      expect(removals()[0]![1]).toContain(String(lease.metadata!.remoteRunDir));
      await environmentService(db).releaseLease(lease.id, "expired");
      expect(hasRemoteTerminationReceipt(await row(lease.id))).toBe(true);
    });

    it.each(["released", "failed"] as const)("a %s run that stays unknown is released without receipt and keeps its dir", async status => {
      const { runtime, runId, lease } = await acquireSshLease(status === "failed" ? "failed" : "succeeded");
      checkRemoteRun.mockResolvedValueOnce(unknown);
      await runtime.releaseRunLeases(runId, status);
      const released = await row(lease.id);
      expect(released.status).toBe(status);
      expect(released.metadata).not.toHaveProperty("remoteExecutionTermination");
      expect(removals()).toHaveLength(0);
    });

    it("an unconfirmed cancelled run stays active with its next check; not due makes no ssh call", async () => {
      const { runtime, runId, lease } = await acquireSshLease("cancelled");
      checkRemoteRun.mockResolvedValueOnce({ ...unknown, basis: "leader_live", result: "alive" });
      expect(await runtime.releaseRunLeases(runId, "expired")).toEqual([]);
      const kept = await row(lease.id);
      expect(kept).toMatchObject({ status: "active", releasedAt: null });
      expect(kept.metadata).toMatchObject({ sshCheckAttempts: 1, sshLastCheckBasis: "leader_live" });
      expect(Date.parse(String(kept.metadata!.sshNextCheckAt))).toBeGreaterThan(Date.now());
      expect(await runtime.releaseRunLeases(runId, "expired")).toEqual([]);
      expect(checkRemoteRun).toHaveBeenCalledTimes(1);
      expect(removals()).toHaveLength(0);
    });

    it("Quinn: the pause loop re-checks an unconfirmed lease and stops once it is gone", async () => {
      const { agentId, lease } = await acquireSshLease("cancelled");
      const heartbeat = heartbeatService(db);
      checkRemoteRun.mockResolvedValueOnce(unknown);
      expect(await heartbeat.stopInvocationsForAgents([agentId], "Agent lifecycle stop requested")).toBe(false);
      expect((await row(lease.id)).status).toBe("active");
      await db.update(environmentLeases).set({ metadata: { ...(await row(lease.id)).metadata,
        sshNextCheckAt: new Date(Date.now() - 1000).toISOString() } }).where(eq(environmentLeases.id, lease.id));
      checkRemoteRun.mockResolvedValueOnce(gone);
      expect(await heartbeat.stopInvocationsForAgents([agentId], "Agent lifecycle stop requested")).toBe(true);
      expect(checkRemoteRun).toHaveBeenCalledTimes(2);
      expect(hasRemoteTerminationReceipt(await row(lease.id))).toBe(true);
    });

    it("the orphan sweep checks due leases without a pause; two unknown leases do not hold up a gone one", async () => {
      const leases = [await acquireSshLease("cancelled"), await acquireSshLease("cancelled"), await acquireSshLease("cancelled")];
      const goneDir = leases[2]!.lease.metadata!.remoteRunDir;
      checkRemoteRun.mockImplementation(async (_config, metadata: { remoteRunDir: string }) =>
        metadata.remoteRunDir === goneDir ? gone : unknown);
      const notDue = await acquireSshLease("cancelled");
      const later = new Date(Date.now() + 60_000).toISOString();
      await db.update(environmentLeases).set({ metadata: { ...notDue.lease.metadata, sshNextCheckAt: later } })
        .where(eq(environmentLeases.id, notDue.lease.id));
      const deadlines: number[] = [];
      for (const { lease } of [...leases, notDue]) {
        await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 0, leaseId: lease.id, onDeferredDeadline: at => deadlines.push(at) });
      }
      expect(checkRemoteRun).toHaveBeenCalledTimes(3);
      for (const { lease } of leases.slice(0, 2)) {
        // The owner-proof settle skipped them (ssh_remote_check_owned_by_driver).
        expect(await row(lease.id)).toMatchObject({ status: "active", metadata: expect.objectContaining({ sshCheckAttempts: 1 }) });
      }
      expect(hasRemoteTerminationReceipt(await row(leases[2]!.lease.id))).toBe(true);
      expect((await row(notDue.lease.id)).status).toBe("active");
      expect(deadlines).toContain(Date.parse(later));
    });

    it("a lease without remoteRunDir (before PAR-9917) is released by the orphan sweep as today", async () => {
      const { lease } = await acquireSshLease("cancelled");
      const { remoteRunDir: _dropped, ...legacy } = lease.metadata!;
      await db.update(environmentLeases).set({ metadata: legacy }).where(eq(environmentLeases.id, lease.id));
      await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 0, leaseId: lease.id });
      expect(checkRemoteRun).not.toHaveBeenCalled();
      expect(await row(lease.id)).toMatchObject({ status: "released", failureReason: "orphaned_ssh_lease_released" });
    });
  });

  it("acquire records the run dir the ssh spawn writes its record into", async () => {
    const { runId, lease } = await acquireSshLease();
    expect(lease.metadata).toMatchObject({ remoteCwd: "/Users/max/ws/", remoteRunDir: `/Users/max/ws/.paperclip-runs/${runId}` });
    // runChildProcess names the record dir with sshRemoteRunDirFor(remoteWorkspacePath, runId).
    expect(lease.metadata!.remoteRunDir).toBe(sshRemoteRunDirFor("/Users/max/ws/", runId));
    expect(lease.metadata).not.toHaveProperty("remoteSpawnStartedAt");
  });

  it("the spawn marker merges into the metadata and survives a stale metadata write", async () => {
    const { lease } = await acquireSshLease();
    await markSshRunSpawnStarted(db, { kind: "remote", transport: "ssh", leaseId: lease.id }, new Date("2026-11-12T10:00:00.000Z"));
    await markSshRunSpawnStarted(db, { kind: "remote", transport: "sandbox", leaseId: lease.id }, new Date("2030-01-01T00:00:00.000Z"));
    await environmentService(db).updateLeaseMetadata(lease.id, { ...lease.metadata, remoteRunDir: undefined, extra: 1 });
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(row!.metadata).toMatchObject({ remoteCwd: "/Users/max/ws/", extra: 1, remoteRunDir: lease.metadata!.remoteRunDir,
      remoteSpawnStartedAt: "2026-11-12T10:00:00.000Z" });
  });

  it("checkSshRunLease runs the check with the recorded facts and never throws", async () => {
    const { runtime, lease } = await acquireSshLease();
    checkRemoteRun.mockResolvedValueOnce({ result: "gone", basis: "never_spawned", checkedAt: "t" });
    expect(await runtime.checkSshRunLease(lease.id)).toEqual({ result: "gone", basis: "never_spawned", checkedAt: "t" });
    expect(checkRemoteRun).toHaveBeenCalledWith(expect.objectContaining({ host: "mac.test", remoteWorkspacePath: "/Users/max/ws/" }),
      expect.objectContaining({ remoteRunDir: lease.metadata!.remoteRunDir }));
    checkRemoteRun.mockRejectedValueOnce(new Error("boom"));
    expect(await runtime.checkSshRunLease(lease.id)).toMatchObject({ result: "unknown", basis: "check_failed" });
    expect(await runtime.checkSshRunLease(randomUUID())).toMatchObject({ result: "unknown", basis: "check_failed" });
  });
});
