// PAR-8960 T1 queue tests 4, 6, 7, 8 and 10: a review-verdict wake through the
// enqueue gate, the hourly cap and the claim gate, against real Postgres.
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
import { readTicketRunsPerHourCap } from "../services/issue-wake-guards.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Review verdict wake test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("review verdict wake through the blocked gates (PAR-8960)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-verdict-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
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
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user",
      email: "review-verdict@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocked on review", status: "blocked",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    return { companyId, agentId, issueId };
  }

  async function seedRuns(input: { companyId: string; agentId: string; issueId: string }, count: number) {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - (10 + i) * 60_000);
      await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: input.agentId,
        invocationSource: "assignment", status: "succeeded", responsibleUserId: "responsible-user",
        createdAt: at, startedAt: at, finishedAt: at, contextSnapshot: { issueId: input.issueId } });
    }
  }

  async function verdictWake(agentId: string, issueId: string, commentId = randomUUID()) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.insert(issueComments).values({ id: commentId, companyId: issue!.companyId, issueId, body: "PASS: ok" });
    // The exact request the comment routes send (literal, so this file runs on
    // a tree without the route helper and fails on behaviour, not on import).
    return heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_review_verdict",
      requestedByActorType: "system", requestedByActorId: "issue_review_verdict_relay",
      idempotencyKey: `review-verdict:${issueId}:${commentId}`,
      payload: { issueId, commentId, mutation: "comment", reviewVerdict: true },
      contextSnapshot: { issueId, taskId: issueId, commentId, wakeCommentId: commentId,
        source: "issue.comment.review_verdict", wakeReason: "issue_review_verdict" },
    });
  }

  async function wakeRows(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
  }

  async function settled(runId: string | undefined) {
    if (!runId) return null;
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(["succeeded", "failed", "cancelled"]).toContain(run?.status);
    }, { timeout: 15_000 });
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  }

  it("starts a verified verdict wake on a blocked issue", async () => {
    const ids = await seed();
    const run = await verdictWake(ids.agentId, ids.issueId);
    expect((await settled(run?.id))?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  // Test 4: the agent route sends the agent's own actor; all four plugin paths
  // (issues.requestWakeup, batch wakeups, agents.invoke, session send) send
  // requestedByActorType "system" with the plugin's UUID as the actor id.
  it.each([
    ["agent route", { requestedByActorType: "agent" as const, source: "on_demand" as const, contextSource: "issue.comment.review_verdict" }],
    ["plugin issues.requestWakeup", { requestedByActorType: "system" as const, source: "assignment" as const, contextSource: "issue.comment.review_verdict" }],
    ["plugin batch wakeups", { requestedByActorType: "system" as const, source: "assignment" as const, contextSource: "issue.comment.review_verdict" }],
    ["plugin agents.invoke", { requestedByActorType: "system" as const, source: "automation" as const, contextSource: "plugin_invoke" }],
    ["plugin session send", { requestedByActorType: "system" as const, source: "automation" as const, contextSource: "plugin_session" }],
  ])("refuses a forged verdict wake from the %s (test 4)", async (_path, forged) => {
    const ids = await seed();
    const run = await heartbeat.wakeup(ids.agentId, {
      source: forged.source, triggerDetail: "system", reason: "issue_review_verdict",
      payload: { issueId: ids.issueId },
      contextSnapshot: { issueId: ids.issueId, wakeReason: "issue_review_verdict", source: forged.contextSource,
        reviewVerdictCapExempt: true },
      requestedByActorType: forged.requestedByActorType, requestedByActorId: randomUUID(),
    });
    expect(run).toBeNull();
    const [row] = await wakeRows(ids.agentId);
    expect(row).toMatchObject({ status: "skipped", reason: "issue_blocked_no_wake" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.agentId))).toHaveLength(0);
  });

  it("exempts only the first verdict wake in the hour from the cap (test 6)", async () => {
    const ids = await seed();
    await seedRuns(ids, readTicketRunsPerHourCap());
    const first = await verdictWake(ids.agentId, ids.issueId);
    expect(first?.contextSnapshot).toMatchObject({ reviewVerdictCapExempt: true });
    expect((await settled(first?.id))?.status).toBe("succeeded");

    expect(await verdictWake(ids.agentId, ids.issueId)).toBeNull();
    const rows = await wakeRows(ids.agentId);
    expect(rows.at(-1)).toMatchObject({ status: "skipped", reason: "issue_run_cap" });
  });

  it("does not exempt a forged wake that carries reviewVerdictCapExempt (test 6)", async () => {
    const ids = await seed();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, ids.issueId));
    await seedRuns(ids, readTicketRunsPerHourCap());
    const run = await heartbeat.wakeup(ids.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: ids.issueId },
      contextSnapshot: { issueId: ids.issueId, wakeReason: "issue_commented", reviewVerdictCapExempt: true },
      requestedByActorType: "system", requestedByActorId: randomUUID(),
    });
    expect(run).toBeNull();
    expect((await wakeRows(ids.agentId)).at(-1)).toMatchObject({ status: "skipped", reason: "issue_run_cap" });
  });

  it("keeps the verdict marker through deferred promotion and starts it (test 7)", async () => {
    const ids = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "first", provider: "test", model: "test-model" };
    });
    const first = await verdictWake(ids.agentId, ids.issueId);
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 15_000 });

    const commentId = randomUUID();
    await verdictWake(ids.agentId, ids.issueId, commentId);
    const pending = (await wakeRows(ids.agentId)).find((row) => row.idempotencyKey === `review-verdict:${ids.issueId}:${commentId}`);
    expect(pending?.requestedByActorId).toBe("issue_review_verdict_relay");

    release();
    await settled(first?.id);
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(2), { timeout: 15_000 });
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending!.id));
    expect(promoted).toMatchObject({ requestedByActorType: "system", requestedByActorId: "issue_review_verdict_relay" });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.agentId));
    const second = runs.find((run) => run.id !== first?.id);
    expect(second?.contextSnapshot).toMatchObject({ wakeReason: "issue_review_verdict" });
    expect((await settled(second?.id))?.status).toBe("succeeded");
  });

  it("bounds a review bounce loop by the hourly cap and flags it (test 8)", async () => {
    const ids = await seed();
    const cap = readTicketRunsPerHourCap();
    for (let i = 0; i < cap + 2; i += 1) {
      const run = await verdictWake(ids.agentId, ids.issueId);
      await settled(run?.id);
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, ids.issueId));
    }
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.agentId));
    expect(runs.length).toBeLessThanOrEqual(cap + 1);
    expect((await wakeRows(ids.agentId)).at(-1)).toMatchObject({ status: "skipped", reason: "issue_run_cap" });
    const flags = await db.select().from(activityLog).where(and(eq(activityLog.entityId, ids.issueId),
      eq(activityLog.action, "issue.wake_loop_guard")));
    expect(flags.length).toBe(1);
  });

  it("is still stopped by the dependency gate when a linked blocker is open (test 10)", async () => {
    const ids = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: ids.companyId, title: "Open blocker", status: "todo",
      priority: "medium", responsibleUserId: "responsible-user" });
    await db.insert(issueRelations).values({ companyId: ids.companyId, issueId: blockerId, relatedIssueId: ids.issueId, type: "blocks" });
    // The enqueue-side dependency gate admits only human interaction wakes, so
    // the verdict wake is skipped there with the existing reason; no run starts.
    expect(await verdictWake(ids.agentId, ids.issueId)).toBeNull();
    expect((await wakeRows(ids.agentId)).at(-1)).toMatchObject({ status: "skipped", reason: "issue_dependencies_blocked" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ids.agentId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
