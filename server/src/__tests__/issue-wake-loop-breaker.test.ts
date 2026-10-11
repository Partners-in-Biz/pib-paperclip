import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  WAKE_LOOP_BREAKER_CAUSE,
  WAKE_LOOP_BREAKER_DEFAULTS,
  WAKE_LOOP_DESCRIPTOR_ACTION,
  WAKE_LOOP_TRIPPED_ACTIVITY,
  WAKE_LOOP_TRIPPED_REASON,
  buildWakeLoopAlertBody,
  formatSastTime,
  readWakeLoopBreakerConfig,
  shouldEvaluateWakeLoopBreaker,
} from "../services/issue-wake-loop-breaker.ts";
import { readOpsAlertIssueId } from "../services/ops-alerts.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake loop breaker test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

describe("wake loop breaker config", () => {
  it("reads defaults, honours 0 as disabled, and falls back on invalid values", () => {
    expect(readWakeLoopBreakerConfig({})).toEqual({
      maxRuns: WAKE_LOOP_BREAKER_DEFAULTS.maxRuns,
      windowMinutes: WAKE_LOOP_BREAKER_DEFAULTS.windowMinutes,
    });
    expect(WAKE_LOOP_BREAKER_DEFAULTS).toEqual({ maxRuns: 10, windowMinutes: 60 });
    expect(
      readWakeLoopBreakerConfig({
        PAPERCLIP_WAKE_LOOP_MAX_RUNS: "0",
        PAPERCLIP_WAKE_LOOP_WINDOW_MINUTES: "30",
      }),
    ).toEqual({ maxRuns: 0, windowMinutes: 30 });
    for (const invalid of ["abc", "-3", "2.5", " ", "1e3"]) {
      expect(
        readWakeLoopBreakerConfig({
          PAPERCLIP_WAKE_LOOP_MAX_RUNS: invalid,
          PAPERCLIP_WAKE_LOOP_WINDOW_MINUTES: invalid,
        }),
      ).toEqual({ maxRuns: 10, windowMinutes: 60 });
    }
    // A zero window would make the breaker meaningless; it means default.
    expect(
      readWakeLoopBreakerConfig({ PAPERCLIP_WAKE_LOOP_WINDOW_MINUTES: "0" }).windowMinutes,
    ).toBe(60);
  });

  it("never evaluates user wakes, the ops-alert issue, or a disabled breaker", () => {
    const alertIssueId = randomUUID();
    const env = { PAPERCLIP_OPS_ALERT_ISSUE_ID: alertIssueId };
    const config = { maxRuns: 10, windowMinutes: 60 };
    const issueId = randomUUID();
    expect(shouldEvaluateWakeLoopBreaker({ config, issueId, requestedByActorType: "system", env })).toBe(true);
    expect(shouldEvaluateWakeLoopBreaker({ config, issueId, requestedByActorType: "agent", env })).toBe(true);
    expect(shouldEvaluateWakeLoopBreaker({ config, issueId, requestedByActorType: "user", env })).toBe(false);
    expect(
      shouldEvaluateWakeLoopBreaker({ config, issueId: alertIssueId.toUpperCase(), requestedByActorType: "system", env }),
    ).toBe(false);
    expect(
      shouldEvaluateWakeLoopBreaker({ config: { ...config, maxRuns: 0 }, issueId, requestedByActorType: "system", env }),
    ).toBe(false);
    expect(readOpsAlertIssueId({ PAPERCLIP_OPS_ALERT_ISSUE_ID: "not-a-uuid" })).toBeNull();
  });

  it("builds the one-line alert in SAST", () => {
    const firstRunAt = new Date("2026-10-09T16:03:00.000Z");
    expect(formatSastTime(firstRunAt)).toBe("18:03 SAST");
    const body = buildWakeLoopAlertBody({
      agentName: "Developer",
      issue: { id: randomUUID(), identifier: "PAR-1711" },
      runsInWindow: 10,
      firstRunAt,
      now: new Date("2026-10-09T16:09:00.000Z"),
    });
    expect(body).toBe(
      "Loop breaker: Developer ran 10 times on [PAR-1711](/PAR/issues/PAR-1711) in 6 min (since 18:03 SAST). " +
        "Automation wakes for that pair are refused and the issue is parked (owner: board). " +
        "[PAR-1711](/PAR/issues/PAR-1711). Need: resolve the recovery action on [PAR-1711](/PAR/issues/PAR-1711) " +
        "or comment there to re-arm.",
    );
    expect(body).not.toContain("\n");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake loop breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue wake loop breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-wake-loop-breaker-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueRecoveryActions);
        await db.delete(issueRelations);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
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

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seed(options: { maxRuns?: string; alert?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const alertAgentId = randomUUID();
    const issueId = randomUUID();
    const doneBlockerId = randomUUID();
    const alertIssueId = randomUUID();
    const prefix = `L${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [[agentId, "Developer"], [alertAgentId, "Elon"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: `${prefix}-1711`,
        title: "Looping issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: doneBlockerId,
        companyId,
        identifier: `${prefix}-1710`,
        title: "Finished blocker",
        status: "done",
        priority: "medium",
        responsibleUserId: "responsible-user",
      },
      {
        id: alertIssueId,
        companyId,
        identifier: `${prefix}-1844`,
        title: "Peet notifications inbox",
        status: "todo",
        priority: "medium",
        assigneeAgentId: alertAgentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: doneBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    vi.stubEnv("PAPERCLIP_WAKE_LOOP_MAX_RUNS", options.maxRuns ?? "3");
    vi.stubEnv("PAPERCLIP_WAKE_LOOP_WINDOW_MINUTES", "60");
    vi.stubEnv("PAPERCLIP_OPS_ALERT_ISSUE_ID", options.alert === false ? "" : alertIssueId);

    return { companyId, agentId, alertAgentId, issueId, doneBlockerId, alertIssueId, prefix };
  }

  async function seedRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    minutesAgo?: number;
    retryOfRunId?: string | null;
  }) {
    const ids: string[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const id = randomUUID();
      const createdAt = new Date(Date.now() - ((input.minutesAgo ?? 5) * 60_000) + index * 1000);
      await db.insert(heartbeatRuns).values({
        id,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "automation",
        status: "succeeded",
        responsibleUserId: "responsible-user",
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 500),
        retryOfRunId: input.retryOfRunId ?? null,
        contextSnapshot: { issueId: input.issueId, wakeReason: "issue_unblock_requested" },
      });
      ids.push(id);
    }
    return ids;
  }

  function systemWake(agentId: string, issueId: string) {
    // The PAR-1711 loop's wake: event-shaped, so the rewake throttle ignores it.
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_unblock_requested" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  function userWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
  }

  async function trippedWakeRows(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, WAKE_LOOP_TRIPPED_REASON)))
      .orderBy(desc(agentWakeupRequests.requestedAt));
  }

  async function breakerActions(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, WAKE_LOOP_BREAKER_CAUSE)));
  }

  async function systemComments(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
  }

  async function alertWakes(alertAgentId: string, alertIssueId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, alertAgentId),
          eq(agentWakeupRequests.reason, "issue_commented"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${alertIssueId}`,
        ),
      );
  }

  async function getIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  it("trips at the cap: skipped wake, parked issue, one action, one comment, one alert", async () => {
    const fx = await seed();
    const runIds = await seedRuns({ ...fx, count: 3 });

    expect(await systemWake(fx.agentId, fx.issueId)).toBeNull();

    const [skipped] = await trippedWakeRows(fx.agentId);
    expect(skipped).toMatchObject({ status: "skipped", reason: WAKE_LOOP_TRIPPED_REASON });
    const heartbeatSkip = (skipped!.payload as Record<string, any>).heartbeatSkip;
    expect(heartbeatSkip).toMatchObject({
      reason: WAKE_LOOP_TRIPPED_REASON,
      requestedReason: "issue_unblock_requested",
      runsInWindow: 3,
      maxRuns: 3,
      windowMinutes: 60,
    });

    const actions = await breakerActions(fx.issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "active",
      ownerType: "board",
      fingerprint: fx.agentId,
      cause: WAKE_LOOP_BREAKER_CAUSE,
    });
    expect(heartbeatSkip.recoveryActionId).toBe(actions[0]!.id);
    expect(actions[0]!.evidence.wakeLoopBreaker).toMatchObject({
      runsInWindow: 3,
      maxRuns: 3,
      windowMinutes: 60,
      previousStatus: "in_progress",
      previousBlockerIds: [fx.doneBlockerId],
      prunedBlockerIds: [fx.doneBlockerId],
    });
    expect(new Set((actions[0]!.evidence.wakeLoopBreaker as any).runIds)).toEqual(new Set(runIds));

    const parked = await getIssue(fx.issueId);
    expect(parked.status).toBe("blocked");
    expect(parked.unblockDescriptor).toEqual({ owner: "board", action: WAKE_LOOP_DESCRIPTOR_ACTION });
    expect(
      await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, fx.issueId)),
    ).toHaveLength(0);

    const issueSystemComments = await systemComments(fx.issueId);
    expect(issueSystemComments).toHaveLength(1);
    expect(issueSystemComments[0]!.body).toContain("wake loop breaker");

    const tripActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, fx.issueId), eq(activityLog.action, WAKE_LOOP_TRIPPED_ACTIVITY)));
    expect(tripActivity).toHaveLength(1);

    const alertComments = await systemComments(fx.alertIssueId);
    expect(alertComments).toHaveLength(1);
    expect(alertComments[0]!.body).toContain(`Loop breaker: Developer ran 3 times on [${fx.prefix}-1711]`);
    expect(await alertWakes(fx.alertAgentId, fx.alertIssueId)).toHaveLength(1);

    // No run was started for the looping pair.
    const pairRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, fx.agentId)));
    expect(pairRuns).toHaveLength(3);
  });

  it("refuses further wakes silently while the action is active", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 3 });
    await systemWake(fx.agentId, fx.issueId);

    expect(await systemWake(fx.agentId, fx.issueId)).toBeNull();
    expect(await systemWake(fx.agentId, fx.issueId)).toBeNull();

    expect(await trippedWakeRows(fx.agentId)).toHaveLength(3);
    expect(await breakerActions(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.alertIssueId)).toHaveLength(1);
    expect(await alertWakes(fx.alertAgentId, fx.alertIssueId)).toHaveLength(1);
  });

  it("re-arms on a user wake: restores the previous status and restarts the count", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 3 });
    await systemWake(fx.agentId, fx.issueId);
    expect((await getIssue(fx.issueId)).status).toBe("blocked");

    const userRun = await userWake(fx.agentId, fx.issueId);
    expect(userRun).not.toBeNull();

    const [action] = await breakerActions(fx.issueId);
    expect(action).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(action!.resolvedAt).toBeTruthy();
    const [rearmed] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, fx.issueId), eq(activityLog.action, "issue.wake_loop_breaker_rearmed")));
    expect(rearmed!.details).toMatchObject({ source: "user_wake", restoredStatus: "in_progress" });

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const trippedBefore = (await trippedWakeRows(fx.agentId)).length;
    // The three seeded runs predate the re-arm, so the count starts again.
    await systemWake(fx.agentId, fx.issueId);
    expect((await trippedWakeRows(fx.agentId)).length).toBe(trippedBefore);
    expect((await breakerActions(fx.issueId)).filter((row) => row.status === "active")).toHaveLength(0);
  });

  it("re-arms through the recovery-actions route and restores the previous status", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 3 });
    await systemWake(fx.agentId, fx.issueId);
    const [action] = await breakerActions(fx.issueId);

    const app = createApp();
    const resolved = await request(app)
      .post(`/api/issues/${fx.issueId}/recovery-actions/resolve`)
      .send({ actionId: action!.id, outcome: "restored" })
      .expect(200);
    expect(resolved.body.issue.status).toBe("in_progress");
    expect(resolved.body.recoveryAction).toMatchObject({ id: action!.id, status: "resolved", outcome: "restored" });
    expect((await getIssue(fx.issueId)).unblockDescriptor).toBeNull();

    const trippedBefore = (await trippedWakeRows(fx.agentId)).length;
    await systemWake(fx.agentId, fx.issueId);
    expect((await trippedWakeRows(fx.agentId)).length).toBe(trippedBefore);
  });

  it("still requires sourceIssueStatus for other recovery actions", async () => {
    const fx = await seed();
    const [other] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: fx.companyId,
        sourceIssueId: fx.issueId,
        kind: "stranded_assigned_issue",
        ownerType: "board",
        cause: "stranded_assigned_issue",
        fingerprint: "other",
        nextAction: "Choose the next step.",
      })
      .returning();
    await request(createApp())
      .post(`/api/issues/${fx.issueId}/recovery-actions/resolve`)
      .send({ actionId: other!.id, outcome: "restored" })
      .expect(422);
  });

  it("does not count retry runs", async () => {
    const fx = await seed();
    const [parentRunId] = await seedRuns({ ...fx, count: 2 });
    await seedRuns({ ...fx, count: 5, retryOfRunId: parentRunId });

    await systemWake(fx.agentId, fx.issueId);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(0);
    expect(await breakerActions(fx.issueId)).toHaveLength(0);
  });

  it("does not count runs cancelled before they started", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 2 });
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId: fx.companyId,
        agentId: fx.agentId,
        invocationSource: "automation",
        status: "cancelled",
        errorCode: "execution_reconciliation_required",
        responsibleUserId: "responsible-user",
        createdAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
        contextSnapshot: { issueId: fx.issueId },
      })),
    );

    await systemWake(fx.agentId, fx.issueId);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(0);
    expect(await breakerActions(fx.issueId)).toHaveLength(0);
  });

  it("never trips on the ops-alert issue", async () => {
    const fx = await seed();
    await seedRuns({ companyId: fx.companyId, agentId: fx.alertAgentId, issueId: fx.alertIssueId, count: 6 });

    await systemWake(fx.alertAgentId, fx.alertIssueId);
    expect(await trippedWakeRows(fx.alertAgentId)).toHaveLength(0);
    expect(await breakerActions(fx.alertIssueId)).toHaveLength(0);
  });

  it("is disabled by MAX_RUNS=0 and uses the default cap for invalid values", async () => {
    const fx = await seed({ maxRuns: "0" });
    await seedRuns({ ...fx, count: 6 });
    await systemWake(fx.agentId, fx.issueId);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(0);

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Invalid means the default of 10; only a handful of runs exist.
    vi.stubEnv("PAPERCLIP_WAKE_LOOP_MAX_RUNS", "lots");
    await systemWake(fx.agentId, fx.issueId);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(0);
    expect(await breakerActions(fx.issueId)).toHaveLength(0);
  });

  it("logs only when no alert issue is configured", async () => {
    const fx = await seed({ alert: false });
    await seedRuns({ ...fx, count: 3 });

    await systemWake(fx.agentId, fx.issueId);
    expect(await breakerActions(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.alertIssueId)).toHaveLength(0);
    expect(await alertWakes(fx.alertAgentId, fx.alertIssueId)).toHaveLength(0);
  });

  it("lets two concurrent admissions at N-1 through", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 2 });

    const results = await Promise.allSettled([
      systemWake(fx.agentId, fx.issueId),
      systemWake(fx.agentId, fx.issueId),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(0);
    expect(await breakerActions(fx.issueId)).toHaveLength(0);
  });

  it("trips once for two concurrent admissions at N", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 3 });

    const results = await Promise.allSettled([
      systemWake(fx.agentId, fx.issueId),
      systemWake(fx.agentId, fx.issueId),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: null },
      { status: "fulfilled", value: null },
    ]);
    expect(await trippedWakeRows(fx.agentId)).toHaveLength(2);
    expect(await breakerActions(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.issueId)).toHaveLength(1);
    expect(await systemComments(fx.alertIssueId)).toHaveLength(1);
    expect(await alertWakes(fx.alertAgentId, fx.alertIssueId)).toHaveLength(1);
  });

  it("keeps the parked issue out of the stranded sweeper and the dependency backstop", async () => {
    const fx = await seed();
    await seedRuns({ ...fx, count: 3 });
    await systemWake(fx.agentId, fx.issueId);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileResolvedDependencyWakes();

    const [action] = await breakerActions(fx.issueId);
    expect(action!.status).toBe("active");
    expect((await getIssue(fx.issueId)).status).toBe("blocked");
    const pairWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, fx.agentId), sql`${agentWakeupRequests.status} <> 'skipped'`));
    expect(pairWakes).toHaveLength(0);
    expect(await systemComments(fx.alertIssueId)).toHaveLength(1);
  });
});
