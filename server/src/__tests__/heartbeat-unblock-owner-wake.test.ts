// PAR-9390 AC 3-5: a board-set unblock owner (agent M) on a blocked issue X
// assigned to A gets a run that reaches `running`, against real Postgres.
import { randomUUID } from "node:crypto";
import { and, eq, like, or } from "drizzle-orm";
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
import { createUnblockOwnerWakeup } from "../services/unblock-owner-wakeup.ts";

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
const OK_RESULT = { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Unblock owner wake test run.", provider: "test", model: "test-model" };
// PAR-10086: execution gates keyed by agent and issue, so a run stays running
// (and that agent's next run stays queued) until the test releases it.
const holds = new Map<string, () => void>();

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
    for (const release of holds.values()) release();
    holds.clear();
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

    // AC 7: the action reaches the run context and its wake payload.
    const [running] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(running?.contextSnapshot).toMatchObject({ unblockAction: ACTION });

    release();
    expect((await settled(run?.id))?.status).toBe("succeeded");
    const executeContext = (mockAdapterExecute.mock.calls[0]?.[0] as { context?: Record<string, unknown> })?.context;
    expect(executeContext?.paperclipWake).toMatchObject({ reason: "issue_unblock_requested", unblockOwnerAction: ACTION });
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
  // ---- PAR-10086: the owner wake does not wait behind another agent's holder ----

  function installHolds() {
    mockAdapterExecute.mockImplementation(async (ctx: unknown) => {
      const c = ctx as { agent?: { id?: string }; context?: { issueId?: unknown } };
      const key = `${c.agent?.id}:${String(c.context?.issueId)}`;
      if (holds.has(key)) await new Promise<void>((resolve) => {
        const previous = holds.get(key)!;
        holds.set(key, () => { previous(); resolve(); });
      });
      return OK_RESULT;
    });
  }

  function hold(agentId: string, issueId: string) {
    holds.set(`${agentId}:${issueId}`, () => undefined);
    return () => { const release = holds.get(`${agentId}:${issueId}`); holds.delete(`${agentId}:${issueId}`); release?.(); };
  }

  async function runStatus(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]?.status);
  }

  // A claim backs off (FOR UPDATE NOWAIT on the issue row) while another run
  // writes that row; the scheduler tick then starts it. Play that tick here.
  async function waitStatus(runId: string, status: string) {
    await vi.waitFor(async () => {
      if (status === "running") await heartbeat.resumeQueuedRuns();
      expect(await runStatus(runId)).toBe(status);
    }, { timeout: 15_000 });
  }

  function userWake(issueId: string, reason = "issue_commented", wakeReason = reason) {
    return { source: "automation" as const, triggerDetail: "system" as const, reason,
      requestedByActorType: "user" as const, requestedByActorId: "responsible-user",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason } };
  }

  // Keeps `agentId` busy with a held run on a separate issue (maxConcurrentRuns is 1).
  async function busy(companyId: string, agentId: string) {
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId, title: "Other work", status: "todo",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    const release = hold(agentId, otherIssueId);
    const run = await heartbeat.wakeup(agentId, userWake(otherIssueId));
    await waitStatus(run!.id, "running");
    return release;
  }

  // The assignee's queued run on X holds executionRunId and cannot start (PAR-10015 shape).
  async function queuedHolder(ids: Awaited<ReturnType<typeof seed>>) {
    const holder = await heartbeat.wakeup(ids.assigneeId, userWake(ids.issueId));
    expect(await runStatus(holder!.id)).toBe("queued");
    await db.update(issues).set({ executionRunId: holder!.id, executionAgentNameKey: "assignee a",
      executionLockedAt: new Date() }).where(eq(issues.id, ids.issueId));
    return holder!;
  }

  // The production path: routes/issues.ts passes createUnblockOwnerWakeup as the wakeup.
  async function notifyThroughHelper(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    let notifiedAt: Date | null = null;
    const delivered = await deliverAgentUnblockNotification({
      issue: issue!,
      wakeup: createUnblockOwnerWakeup({ db, heartbeat, companyId: issue!.companyId }),
      markNotified: async (at) => { notifiedAt = at; },
    });
    return { delivered, notifiedAt: notifiedAt as Date | null };
  }

  async function agentRunsOn(agentId: string, issueId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => (row.contextSnapshot as { issueId?: unknown } | null)?.issueId === issueId);
  }

  async function executionRunId(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.executionRunId);
  }

  // AC 1. Before the fix the wake is parked as deferred_issue_execution and no owner run exists.
  it("starts the owner's run while the assignee's queued run holds the issue", async () => {
    const ids = await seed();
    installHolds();
    await busy(ids.companyId, ids.assigneeId);
    const holder = await queuedHolder(ids);
    hold(ids.ownerId, ids.issueId);

    const { delivered, notifiedAt } = await notifyThroughHelper(ids.issueId);
    const [ownerRun] = await agentRunsOn(ids.ownerId, ids.issueId);
    expect(ownerRun).toBeDefined();
    await waitStatus(ownerRun!.id, "running");
    expect(await runStatus(holder.id)).toBe("queued");
    expect(await executionRunId(ids.issueId)).toBe(holder.id);
    expect(delivered).toBe(true);
    expect(notifiedAt).toBeInstanceOf(Date);
  }, 45_000);

  // AC 2.
  it("starts the owner's run while the assignee's running run holds the issue", async () => {
    const ids = await seed();
    installHolds();
    hold(ids.assigneeId, ids.issueId);
    const holder = await heartbeat.wakeup(ids.assigneeId, userWake(ids.issueId));
    await waitStatus(holder!.id, "running");
    expect(await executionRunId(ids.issueId)).toBe(holder!.id);
    hold(ids.ownerId, ids.issueId);

    const { delivered, notifiedAt } = await notifyThroughHelper(ids.issueId);
    const [ownerRun] = await agentRunsOn(ids.ownerId, ids.issueId);
    expect(ownerRun).toBeDefined();
    await waitStatus(ownerRun!.id, "running");
    expect(await runStatus(holder!.id)).toBe("running");
    expect(await executionRunId(ids.issueId)).toBe(holder!.id);
    expect(delivered).toBe(true);
    expect(notifiedAt).toBeInstanceOf(Date);
  }, 45_000);

  // AC 4 (a)-(c): no exemption where none is due; each wake still waits behind the queued holder.
  it.each([
    ["owner is the assignee", "assignee-owner", null, "skipped"],
    ["agent actor", "owner", { requestedByActorType: "agent", reason: "issue_unblock_requested" }, "skipped"],
    ["user actor", "owner", { requestedByActorType: "user", reason: "issue_unblock_requested" }, "deferred_issue_execution"],
    ["system actor outside the allowlist", "owner",
      { requestedByActorType: "system", requestedByActorId: "some_other_system", reason: "issue_unblock_requested" }, "skipped"],
    ["caller-supplied context wakeReason (user actor)", "owner",
      { requestedByActorType: "user", reason: "issue_commented" }, "deferred_issue_execution"],
    ["caller-supplied context wakeReason (routable_blocked actor)", "owner",
      { requestedByActorType: "system", requestedByActorId: "routable_blocked", reason: "issue_commented" }, "skipped"],
  ] as const)("gives no holder exemption to %s", async (_name, target, wake, expectedStatus) => {
    const ids = await seed();
    installHolds();
    await busy(ids.companyId, ids.assigneeId);
    const holder = await queuedHolder(ids);
    let woken: string = ids.ownerId;
    if (target === "assignee-owner") {
      woken = ids.assigneeId;
      await db.update(issues).set({ unblockDescriptor: { owner: { agentId: ids.assigneeId }, action: ACTION } })
        .where(eq(issues.id, ids.issueId));
      const { delivered, notifiedAt } = await notifyThroughHelper(ids.issueId);
      expect(delivered).toBe(false);
      expect(notifiedAt).toBeNull();
    } else {
      const run = await heartbeat.wakeup(ids.ownerId, {
        source: "automation", triggerDetail: "system", reason: wake!.reason,
        requestedByActorType: wake!.requestedByActorType,
        requestedByActorId: "requestedByActorId" in wake! ? wake!.requestedByActorId
          : wake!.requestedByActorType === "agent" ? ids.assigneeId : "responsible-user",
        idempotencyKey: `forged:${ids.issueId}`,
        payload: { issueId: ids.issueId },
        contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId, wakeReason: "issue_unblock_requested" },
      });
      expect(run).toBeNull();
    }
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, woken),
      or(like(agentWakeupRequests.idempotencyKey, "issue-unblock:%"), like(agentWakeupRequests.idempotencyKey, "forged:%"))));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).toBe(expectedStatus);
    expect(wakes[0]!.runId).toBeNull();
    expect(await agentRunsOn(ids.ownerId, ids.issueId)).toHaveLength(0);
    expect(await agentRunsOn(ids.assigneeId, ids.issueId)).toHaveLength(1);
    expect(await runStatus(holder.id)).toBe("queued");
    expect(await executionRunId(ids.issueId)).toBe(holder.id);
  }, 45_000);

  // AC 4 (d): the holder is the owner agent's own run (the owner is not the assignee).
  it("keeps today's admission when the owner agent holds the issue", async () => {
    const ids = await seed();
    installHolds();
    await db.update(issues).set({ status: "todo", assigneeAgentId: ids.ownerId, unblockDescriptor: null })
      .where(eq(issues.id, ids.issueId));
    hold(ids.ownerId, ids.issueId);
    const holder = await heartbeat.wakeup(ids.ownerId, userWake(ids.issueId));
    await waitStatus(holder!.id, "running");
    expect(await executionRunId(ids.issueId)).toBe(holder!.id);
    await db.update(issues).set({ status: "blocked", assigneeAgentId: ids.assigneeId,
      unblockDescriptor: { owner: { agentId: ids.ownerId }, action: ACTION }, blockedTransitionAt: new Date() })
      .where(eq(issues.id, ids.issueId));

    const { delivered } = await notifyThroughHelper(ids.issueId);
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, ids.ownerId), eq(agentWakeupRequests.idempotencyKey,
        `issue-unblock:${ids.issueId}:${(await db.select().from(issues).where(eq(issues.id, ids.issueId)))[0]!.blockedTransitionAt!.toISOString()}`)));
    // Same agent: the wake merges into its running run, so a run exists for it.
    expect(receipt).toMatchObject({ status: "coalesced", runId: holder!.id });
    expect(delivered).toBe(true);
    expect(await agentRunsOn(ids.ownerId, ids.issueId)).toHaveLength(1);
    expect(await executionRunId(ids.issueId)).toBe(holder!.id);
  }, 45_000);

  // AC 3 through the helper: only a receipt with a run counts as notified.
  it("does not record the owner as notified when the wake waits with no run", async () => {
    const ids = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: ids.companyId, title: "Open blocker", status: "todo",
      priority: "medium", responsibleUserId: "responsible-user" });
    await db.insert(issueRelations).values({ companyId: ids.companyId, issueId: blockerId,
      relatedIssueId: ids.issueId, type: "blocks" });
    const { delivered, notifiedAt } = await notifyThroughHelper(ids.issueId);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ids.ownerId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).toBeNull();
    expect(delivered).toBe(false);
    expect(notifiedAt).toBeNull();
    expect(await agentRunsOn(ids.ownerId, ids.issueId)).toHaveLength(0);
  });

  it.each([
    ["a deferred receipt with no runId", false, false],
    ["a receipt with a runId", true, true],
  ] as const)("reads %s from the receipt and records notified=%s", async (_name, withRun, notified) => {
    const ids = await seed();
    const runId = randomUUID();
    if (withRun) await db.insert(heartbeatRuns).values({ id: runId, companyId: ids.companyId, agentId: ids.ownerId,
      invocationSource: "automation", status: "succeeded", contextSnapshot: {} });
    const stub = { wakeup: async (agentId: string, options: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId: ids.companyId, agentId, source: "automation",
        reason: "issue_unblock_requested", status: withRun ? "coalesced" : "deferred_issue_execution",
        runId: withRun ? runId : null, idempotencyKey: options.idempotencyKey,
        requestedByActorType: "system", requestedByActorId: "routable_blocked" });
      return null;
    } };
    const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
    let notifiedAt: Date | null = null;
    const delivered = await deliverAgentUnblockNotification({ issue: issue!,
      wakeup: createUnblockOwnerWakeup({ db, heartbeat: stub, companyId: ids.companyId }),
      markNotified: async (at) => { notifiedAt = at; } });
    expect(delivered).toBe(notified);
    expect(notifiedAt !== null).toBe(notified);
  });

  // AC 5: the issue changes after the owner's run is queued (owner busy elsewhere).
  async function queuedOwnerRun(ids: Awaited<ReturnType<typeof seed>>) {
    installHolds();
    await busy(ids.companyId, ids.assigneeId);
    const holder = await queuedHolder(ids);
    const releaseOwner = await busy(ids.companyId, ids.ownerId);
    const { delivered } = await notifyThroughHelper(ids.issueId);
    expect(delivered).toBe(true);
    const [ownerRun] = await agentRunsOn(ids.ownerId, ids.issueId);
    expect(await runStatus(ownerRun!.id)).toBe("queued");
    return { holder, ownerRun: ownerRun!, releaseOwner };
  }

  function executedRunIds() {
    return mockAdapterExecute.mock.calls.map((call) => (call[0] as { runId?: string }).runId);
  }

  it.each([
    ["the descriptor owner changes", { unblockDescriptor: { owner: { agentId: "00000000-0000-4000-8000-0000000000aa" }, action: ACTION } }],
    ["the issue leaves blocked", { status: "todo", unblockDescriptor: null }],
  ] as const)("stops the queued owner run at start when %s", async (_name, change) => {
    const ids = await seed();
    const { holder, ownerRun, releaseOwner } = await queuedOwnerRun(ids);
    await db.update(issues).set(change as never).where(eq(issues.id, ids.issueId));
    releaseOwner();
    await waitStatus(ownerRun.id, "cancelled");
    expect(executedRunIds()).not.toContain(ownerRun.id);
    expect(await runStatus(holder.id)).toBe("queued");
  }, 45_000);

  it("starts exactly one owner run across an unblock and re-block with the same owner", async () => {
    const ids = await seed();
    const { ownerRun, releaseOwner } = await queuedOwnerRun(ids);
    await db.update(issues).set({ status: "todo", unblockDescriptor: null }).where(eq(issues.id, ids.issueId));
    await db.update(issues).set({ status: "blocked", unblockDescriptor: { owner: { agentId: ids.ownerId }, action: ACTION },
      blockedTransitionAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, ids.issueId));
    const cycle2 = await notifyThroughHelper(ids.issueId);
    expect(cycle2.delivered).toBe(true);
    // The cycle-2 wake merges into the owner's queued cycle-1 run on X.
    expect((await agentRunsOn(ids.ownerId, ids.issueId)).map((run) => run.id)).toEqual([ownerRun.id]);
    releaseOwner();
    await vi.waitFor(async () => {
      const runs = await agentRunsOn(ids.ownerId, ids.issueId);
      expect(runs.every((run) => ["succeeded", "failed", "cancelled"].includes(run.status))).toBe(true);
    }, { timeout: 15_000 });
    const started = (await agentRunsOn(ids.ownerId, ids.issueId)).filter((run) => executedRunIds().includes(run.id));
    expect(started).toHaveLength(1);
    expect(started[0]!.status).toBe("succeeded");
    // The cycle-1 run is either the one that ran or did not run at all.
    expect(started[0]!.id === ownerRun.id || !executedRunIds().includes(ownerRun.id)).toBe(true);
  }, 45_000);
});

