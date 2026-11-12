import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isDeliberateShortPause, PAUSED_AGENT_RECOVERY_GRACE_MS } from "../services/recovery/service.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping paused agent grace tests: ${recoveryPostgresSupport.reason}`);

const HOUR = 60 * 60 * 1000;

describe("isDeliberateShortPause", () => {
  const now = new Date("2026-11-12T08:00:00.000Z");
  const base = { status: "paused", companyId: "c1", pauseReason: "manual", pausedAt: new Date(now.getTime() - HOUR),
    updatedAt: new Date(now.getTime() - 48 * HOUR) };
  it("is true for a recent manual or system pause in the same company", () => {
    expect(isDeliberateShortPause(base, "c1", now)).toBe(true);
    expect(isDeliberateShortPause({ ...base, pauseReason: "system" }, "c1", now)).toBe(true);
  });
  it("is false for other reasons, statuses, companies or an old pause", () => {
    expect(isDeliberateShortPause({ ...base, pauseReason: "budget" }, "c1", now)).toBe(false);
    expect(isDeliberateShortPause({ ...base, pauseReason: null }, "c1", now)).toBe(false);
    expect(isDeliberateShortPause({ ...base, status: "idle" }, "c1", now)).toBe(false);
    expect(isDeliberateShortPause(base, "c2", now)).toBe(false);
    expect(isDeliberateShortPause({ ...base, pausedAt: new Date(now.getTime() - PAUSED_AGENT_RECOVERY_GRACE_MS) }, "c1", now))
      .toBe(false);
    expect(isDeliberateShortPause(null, "c1", now)).toBe(false);
  });
  it("falls back to updatedAt when pausedAt is null", () => {
    expect(isDeliberateShortPause({ ...base, pausedAt: null, updatedAt: new Date(now.getTime() - HOUR) }, "c1", now)).toBe(true);
    expect(isDeliberateShortPause({ ...base, pausedAt: null, updatedAt: new Date(now.getTime() - 25 * HOUR) }, "c1", now))
      .toBe(false);
  });
});

/**
 * A deliberate (manual or system) pause is usually short, e.g. a release
 * restart. Stranded-work recovery must not move the paused agent's tasks to
 * `blocked` during the first 24 hours; nothing puts them back on resume.
 */
describePostgres("stranded-work recovery for a recently paused agent", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("paused-agent-grace-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-paused-grace-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }),
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(input: { status: "todo" | "in_progress" | "in_review" }) {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID();
    const userId = `grace-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Grace user", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paused agent fixture", issuePrefix: `G${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active",
      membershipRole: "member" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Paused worker", adapterType, status: "idle", adapterConfig: {} },
      { id: authorId, companyId, name: "Author", adapterType, status: "idle", adapterConfig: {} },
    ]);
    const review = input.status === "in_review";
    await db.insert(issues).values({
      id: issueId, companyId, title: "Task of a paused agent", status: input.status, priority: "medium",
      assigneeAgentId: review ? authorId : agentId, responsibleUserId: userId, issueNumber: 1,
      executionState: review ? {
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId, userId: null },
        returnAssignee: { type: "agent", agentId: authorId, userId: null },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } : null,
    });
    return { companyId, agentId, issueId };
  }

  async function seedEndedRun(f: { companyId: string; agentId: string; issueId: string },
    status: "failed" | "succeeded", runtimeMode: "legacy" | "native") {
    const finishedAt = new Date(Date.now() - 10 * 60 * 1000);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment",
      triggerDetail: "system", status, runtimeMode, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 60_000), contextSnapshot: { issueId: f.issueId } });
  }

  const pause = (agentId: string) => createAgentLifecycle(db).pauseAgent(agentId, "manual");
  const issueRow = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
  const recoveryActions = (issueId: string) =>
    db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  async function expectSkipped(f: { companyId: string; issueId: string }, status: string) {
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect(result.escalated).toBe(0);
    expect((await issueRow(f.issueId)).status).toBe(status);
    expect(await recoveryActions(f.issueId)).toHaveLength(0);
  }

  async function expectEscalated(f: { companyId: string; agentId: string; issueId: string }) {
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect(result.escalated).toBe(1);
    expect(await issueRow(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId });
    expect(await recoveryActions(f.issueId)).toEqual([expect.objectContaining({ ownerType: "board" })]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.some(comment => comment.body.includes("original assignee is not invokable"))).toBe(true);
  }

  it("1: skips a todo task with no run while the assignee is manually paused", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    await expectSkipped(f, "todo");
  }, 60_000);

  it("reports the end of the grace window as the next deadline", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    const pausedAt = new Date(Date.now() - HOUR);
    await db.update(agents).set({ pausedAt }).where(eq(agents.id, f.agentId));
    const deadlines: number[] = [];
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
      onDeferredDeadline: at => deadlines.push(at) });
    expect(deadlines).toEqual([pausedAt.getTime() + PAUSED_AGENT_RECOVERY_GRACE_MS]);
  }, 60_000);

  it("notifies stranded-work recovery when the paused agent becomes invokable again", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.strandedAssignments, (event, hints) => {
      if (event === "settled") events.push(...(hints ?? ["<no hint>"]));
    });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete",
      runPlugin: async () => "complete" });
    try {
      await worker.process(f.agentId);
      events.length = 0;
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].status).toBe("idle");
      // beforeStatusChange -> notifyRunDispatch -> notifyIssueRecovery (company scope).
      expect(events).toContain(JSON.stringify({ companyId: f.companyId }));
    } finally { unsubscribe(); await worker.stop(); }
  }, 60_000);

  it.each([
    ["2a: failed", "failed", "legacy"],
    ["2b: native succeeded", "succeeded", "native"],
  ] as const)("%s run ended before the pause: in_progress task is skipped", async (_label, runStatus, runtimeMode) => {
    const f = await seed({ status: "in_progress" });
    await seedEndedRun(f, runStatus, runtimeMode);
    await pause(f.agentId);
    await expectSkipped(f, "in_progress");
  }, 60_000);

  it("3: skips an in_review task whose current reviewer is manually paused", async () => {
    const f = await seed({ status: "in_review" });
    await pause(f.agentId);
    await expectSkipped(f, "in_review");
  }, 60_000);

  it("4: escalates as before once the pause is older than 24 hours", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    await db.update(agents).set({ pausedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(agents.id, f.agentId));
    await expectEscalated(f);
  }, 60_000);

  it("5: escalates as before for a budget pause", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    await db.update(agents).set({ pauseReason: "budget" }).where(eq(agents.id, f.agentId));
    await expectEscalated(f);
  }, 60_000);

  it.each([
    ["1 hour ago: skipped", 1, false],
    ["25 hours ago: escalated", 25, true],
  ] as const)("6: pausedAt null uses updatedAt (%s)", async (_label, hoursAgo, escalated) => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    await db.update(agents).set({ pausedAt: null, updatedAt: new Date(Date.now() - hoursAgo * HOUR) })
      .where(eq(agents.id, f.agentId));
    if (escalated) await expectEscalated(f);
    else await expectSkipped(f, "todo");
  }, 60_000);

  it("7: dispatches the todo task in the same pass after resume", async () => {
    const f = await seed({ status: "todo" });
    await pause(f.agentId);
    await expectSkipped(f, "todo");
    await db.update(agents).set({ status: "idle", lifecycleState: "ready", lifecycleHolds: [], lifecycleOperation: null,
      pauseReason: null, pausedAt: null }).where(eq(agents.id, f.agentId));
    const result = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect(result.assignmentDispatched).toBe(1);
    expect(result.escalated).toBe(0);
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.agentId)));
    expect(wakes).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 60_000);
});
