// PAR-9390 AC 3-5: a board-set unblock owner (agent M) on a blocked issue X
// assigned to A gets a run that reaches `running`, against real Postgres.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  environmentLeases,
  environments,
  executionWorkspaces,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { deliverAgentUnblockNotification } from "../services/routable-blocked.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async (_ctx: unknown) => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Unblock owner wake test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const ACTION = "Grant the deploy key to the CI runner";

describeEmbeddedPostgres("unblock-owner wake reaches its owner and starts (PAR-9390)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unblock-owner-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Unblock owner wake test run.", provider: "test", model: "test-model",
    }));
    for (let attempt = 0; ; attempt += 1) {
      try {
        for (const table of [environmentLeases, issueRelations, issueComments, issues, heartbeatRunEvents,
          activityLog, costEvents, heartbeatRuns, agentWakeupRequests, agentRuntimeState, agents, environments,
          executionWorkspaces, companySkills, companyMemberships, companies]) {
          await db.delete(table);
        }
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const ownerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user",
      email: "unblock-owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    for (const [id, name] of [[assigneeId, "Assignee A"], [ownerId, "Owner M"]] as const) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    }
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocked on a grant", status: "blocked",
      priority: "medium", assigneeAgentId: assigneeId, responsibleUserId: "responsible-user",
      unblockDescriptor: { owner: { agentId: ownerId }, action: ACTION },
      blockedTransitionAt: new Date() });
    return { companyId, assigneeId, ownerId, issueId };
  }

  // The production path: routes/issues.ts calls this with heartbeat.wakeup.
  async function notifyOwner(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    let notifiedAt: Date | null = null;
    let run: Awaited<ReturnType<typeof heartbeat.wakeup>> = null;
    const delivered = await deliverAgentUnblockNotification({
      issue: issue!,
      wakeup: async (agentId, options) => (run = await heartbeat.wakeup(agentId, options)),
      markNotified: async (at) => { notifiedAt = at; },
    });
    return { delivered, notifiedAt, run: run as Awaited<ReturnType<typeof heartbeat.wakeup>> };
  }

  function gateNextExecution() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "owner run", provider: "test", model: "test-model" };
    });
    return release;
  }

  async function settled(runId: string | undefined) {
    if (!runId) return null;
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(["succeeded", "failed", "cancelled"]).toContain(run?.status);
    }, { timeout: 15_000 });
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  }

  // AC 3. On the old code the admission guard fails first: the wake is stored
  // as skipped with issue_blocked_no_wake and no run row exists.
  it("starts a run for the owner that reaches running, and records the owner as notified", async () => {
    const ids = await seed();
    const release = gateNextExecution();
    const { delivered, notifiedAt, run } = await notifyOwner(ids.issueId);
    expect(run?.agentId).toBe(ids.ownerId);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(row?.status).toBe("running");
    }, { timeout: 15_000 });
    expect(delivered).toBe(true);
    expect(notifiedAt).toBeInstanceOf(Date);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ids.ownerId));
    expect(wake).toMatchObject({ reason: "issue_unblock_requested", requestedByActorType: "system",
      requestedByActorId: "routable_blocked" });

    // AC 4: M's run does not take the issue execution lock (the assignee owns it).
    const [issueWhileRunning] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
    expect(issueWhileRunning?.executionRunId).toBeNull();

    release();
    expect((await settled(run?.id))?.status).toBe("succeeded");
  });

  // AC 4: a later wake for the assignee on X is not deferred behind M.
  it("does not defer a later assignee wake behind the owner's run", async () => {
    const ids = await seed();
    const release = gateNextExecution();
    const { run: ownerRun } = await notifyOwner(ids.issueId);
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 15_000 });

    const assigneeRun = await heartbeat.wakeup(ids.assigneeId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: ids.issueId },
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId, wakeReason: "issue_commented" },
    });
    expect(assigneeRun?.agentId).toBe(ids.assigneeId);
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(2), { timeout: 15_000 });
    const assigneeWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, ids.assigneeId));
    expect(assigneeWakes.map((row) => row.status)).not.toContain("deferred_issue_execution");

    release();
    await settled(ownerRun?.id);
    await settled(assigneeRun?.id);
  });

  // AC 5: the end of M's run causes no disposition-repair wake for A or M, and
  // no further run for M.
  it("leaves no disposition repair and no continuation run after the owner's run ends", async () => {
    const ids = await seed();
    const { run } = await notifyOwner(ids.issueId);
    expect((await settled(run?.id))?.status).toBe("succeeded");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const repairs = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, ids.companyId),
      eq(agentWakeupRequests.reason, "issue_disposition_repair"),
    ));
    expect(repairs).toHaveLength(0);
    const ownerWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, ids.ownerId));
    expect(ownerWakes.map((row) => row.reason)).toEqual(["issue_unblock_requested"]);
    const ownerRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.ownerId));
    expect(ownerRuns).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.assigneeId))).toHaveLength(0);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not record the owner as notified when the wake is skipped", async () => {
    const ids = await seed();
    // Owner equals assignee: no exemption, so the blocked guard skips the wake.
    await db.update(issues).set({ assigneeAgentId: ids.ownerId }).where(eq(issues.id, ids.issueId));
    const { delivered, notifiedAt, run } = await notifyOwner(ids.issueId);
    expect(run).toBeNull();
    expect(delivered).toBe(false);
    expect(notifiedAt).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ids.ownerId));
    expect(wake).toMatchObject({ status: "skipped", reason: "issue_blocked_no_wake" });
  });
});
