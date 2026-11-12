import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const checkRemoteRun = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => ({ remoteCwd: config.remoteWorkspacePath }),
  checkRemoteRun,
}));

import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { sshRemoteRunDirFor } from "@paperclipai/adapter-utils/ssh";
import { markSshRunSpawnStarted, nextSshCheckAt } from "../services/ssh-run-lease.js";

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

  async function acquireSshLease() {
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
    return { companyId, runId, environment, runtime, lease };
  }

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
