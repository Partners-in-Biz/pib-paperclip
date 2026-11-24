import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// PAR-14337: the run's shared ssh connection closes at every terminal end,
// outside the native-ownership gates and after any earlier teardown failure.
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  cleanupSshConnectionReuse: vi.fn(async (_input: { runId: string }) => undefined),
  holdNativeOwnership: false,
  failFinalizationWrite: false,
}));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>()),
  cleanupSshConnectionReuse: mocks.cleanupSshConnectionReuse,
}));

// Stands in for ownership latched during execution (e.g. an unverified runner):
// the teardown then skips every native-gated release.
vi.mock("../services/native-runtime/native-runner-ownership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-runner-ownership.js")>();
  return {
    ...actual,
    isNativeRunnerOwnershipHeld: (run: Parameters<typeof actual.isNativeRunnerOwnershipHeld>[0]) =>
      mocks.holdNativeOwnership || actual.isNativeRunnerOwnershipHeld(run),
  };
});

vi.mock("../services/execution-control-notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/execution-control-notifications.js")>();
  return {
    ...actual,
    writeExecutionControl: ((...args: Parameters<typeof actual.writeExecutionControl>) => {
      if (mocks.failFinalizationWrite && args[1] === "execution-finalization") {
        return Promise.reject(new Error("finalization write failed"));
      }
      return actual.writeExecutionControl(...args);
    }) as typeof actual.writeExecutionControl,
  };
});

const TERMINAL = /^(succeeded|failed|cancelled|timed_out)$/;

describe.skipIf(!recoveryPostgresSupport.supported)("heartbeat closes the run's shared ssh connection", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "heartbeat-ssh-cleanup-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "01234567890123456789012345678901");
    temporary = await startRecoveryPostgres("heartbeat-ssh-cleanup-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    mocks.holdNativeOwnership = false;
    mocks.failFinalizationWrite = false;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mocks.execute.mockReset();
    mocks.cleanupSshConnectionReuse.mockClear();
  });

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function startRun() {
    const companyId = randomUUID(), userId = randomUUID(), agentId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Ssh cleanup", issuePrefix: `S${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {} });
    const [issue] = await db.insert(issues).values({ companyId, title: "Task", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId }).returning();
    const run = await heartbeat.wakeup(agentId, { causingActor: "system", source: "on_demand", triggerDetail: "manual",
      contextSnapshot: { issueId: issue!.id } });
    expect(run).not.toBeNull();
    return run!.id;
  }

  async function expectCleanedAfterTerminal(runId: string, status: string | RegExp) {
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(runId))?.status).toMatch(TERMINAL);
      expect(mocks.cleanupSshConnectionReuse).toHaveBeenCalledWith({ runId });
    }, { timeout: 30_000 });
    expect((await heartbeat.getRun(runId))?.status).toMatch(status);
    expect(mocks.cleanupSshConnectionReuse.mock.calls.filter(([input]) => input.runId === runId)).toHaveLength(1);
  }

  it("on success", async () => {
    mocks.execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false });
    await expectCleanedAfterTerminal(await startRun(), "succeeded");
  }, 60_000);

  it("on adapter error", async () => {
    mocks.execute.mockRejectedValue(new Error("adapter crashed"));
    await expectCleanedAfterTerminal(await startRun(), "failed");
  }, 60_000);

  it("on cancel", async () => {
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    mocks.execute.mockImplementation((input: { signal?: AbortSignal }) => new Promise((resolve) => {
      started();
      const settle = () => resolve({ exitCode: null, signal: "SIGTERM", timedOut: false });
      if (input.signal?.aborted) settle();
      input.signal?.addEventListener("abort", settle, { once: true });
    }));
    const runId = await startRun();
    await executing;
    await heartbeat.cancelRun(runId, "Operator stopped this work");
    await expectCleanedAfterTerminal(runId, "cancelled");
  }, 60_000);

  it("while native ownership is held", async () => {
    mocks.execute.mockImplementation(async () => {
      mocks.holdNativeOwnership = true;
      return { exitCode: 0, signal: null, timedOut: false };
    });
    await expectCleanedAfterTerminal(await startRun(), "succeeded");
  }, 60_000);

  it("when an earlier teardown step throws", async () => {
    mocks.execute.mockImplementation(async () => {
      mocks.failFinalizationWrite = true;
      return { exitCode: 0, signal: null, timedOut: false };
    });
    // The failed write can also fail the run; any terminal end must close it.
    await expectCleanedAfterTerminal(await startRun(), TERMINAL);
  }, 60_000);
});
