import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import {
  agentSpendAlarmService,
  readSpendAlarmConfig,
  SPEND_ALARM_TRIPPED_ACTION,
} from "../services/agent-spend-alarm.ts";
import { budgetService } from "../services/budgets.ts";
import { costService } from "../services/costs.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("readSpendAlarmConfig", () => {
  it("uses the defaults when unset or invalid and lets 0 disable a cap", () => {
    expect(readSpendAlarmConfig({})).toEqual({ maxRunsPerHour: 60, maxListCentsPerHour: 5000 });
    expect(
      readSpendAlarmConfig({
        PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR: "abc",
        PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR: "-5",
      }),
    ).toEqual({ maxRunsPerHour: 60, maxListCentsPerHour: 5000 });
    expect(
      readSpendAlarmConfig({
        PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR: " 0 ",
        PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR: "12.5",
      }),
    ).toEqual({ maxRunsPerHour: 0, maxListCentsPerHour: 5000 });
    expect(
      readSpendAlarmConfig({
        PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR: "15",
        PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR: "0",
      }),
    ).toEqual({ maxRunsPerHour: 15, maxListCentsPerHour: 0 });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres spend alarm tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent spend alarm", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-spend-alarm-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(budgetPolicies);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Loop Agent",
      role: "engineer",
      status,
      pauseReason: status === "paused" ? "budget" : null,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function seedRuns(
    scope: { companyId: string; agentId: string },
    count: number,
    opts: {
      createdAt?: Date;
      finishedAt?: Date | null;
      status?: string;
      issueId?: string;
      retryOfRunId?: string;
      usageJson?: Record<string, unknown> | null;
    } = {},
  ) {
    if (count === 0) return [];
    const createdAt = opts.createdAt ?? minutesAgo(10);
    return db
      .insert(heartbeatRuns)
      .values(
        Array.from({ length: count }, () => ({
          companyId: scope.companyId,
          agentId: scope.agentId,
          status: opts.status ?? "succeeded",
          createdAt,
          startedAt: createdAt,
          finishedAt: opts.finishedAt === undefined ? createdAt : opts.finishedAt,
          retryOfRunId: opts.retryOfRunId ?? null,
          contextSnapshot: opts.issueId ? { issueId: opts.issueId } : {},
          usageJson: opts.usageJson ?? null,
        })),
      )
      .returning({ id: heartbeatRuns.id });
  }

  function recordRunCost(
    costs: ReturnType<typeof costService>,
    scope: { companyId: string; agentId: string },
  ) {
    // A subscription run: 0 billed cents, so only heartbeat_runs carries list cost.
    return costs.createEvent(scope.companyId, {
      agentId: scope.agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      costStatus: "reported",
      model: "claude",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 10,
      costCents: 0,
      occurredAt: new Date(),
    });
  }

  async function getAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row!;
  }

  async function tripActivities(agentId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, SPEND_ALARM_TRIPPED_ACTION)));
  }

  function makeHooks() {
    return {
      cancelQueuedWorkForAgent: vi.fn(async () => undefined),
      postOpsAlert: vi.fn(async () => undefined),
    };
  }

  it("pauses on 60 non-retry runs in 60 min, logs both counters and alerts once", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 60);
    const hooks = makeHooks();
    const costs = costService(db, hooks);

    await recordRunCost(costs, scope);

    const agent = await getAgent(scope.agentId);
    expect(agent.status).toBe("paused");
    expect(agent.pauseReason).toBe("system");
    const trips = await tripActivities(scope.agentId);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.actorType).toBe("system");
    expect(trips[0]!.details).toMatchObject({
      runsStarted: 60,
      listCents: 0,
      maxRunsPerHour: 60,
      maxListCentsPerHour: 5000,
      trippedBy: ["runs"],
    });
    expect(hooks.cancelQueuedWorkForAgent).toHaveBeenCalledTimes(1);
    expect(hooks.cancelQueuedWorkForAgent).toHaveBeenCalledWith(scope.agentId, expect.any(String));
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
    expect(hooks.postOpsAlert.mock.calls[0]![0]).toMatchObject({
      companyId: scope.companyId,
      body: expect.stringContaining("Spend alarm: Loop Agent started 60 runs"),
    });

    // Already paused: the next cost event does nothing.
    await recordRunCost(costs, scope);
    expect(await tripActivities(scope.agentId)).toHaveLength(1);
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("does not count retries, runs older than 60 min, or runs on the ops-alert issue", async () => {
    const opsAlertIssueId = randomUUID();
    vi.stubEnv("PAPERCLIP_OPS_ALERT_ISSUE_ID", opsAlertIssueId);
    const scope = await seedAgent();
    const [first] = await seedRuns(scope, 50);
    await seedRuns(scope, 9, { issueId: randomUUID() });
    await seedRuns(scope, 20, { retryOfRunId: first!.id });
    await seedRuns(scope, 20, { issueId: opsAlertIssueId });
    await seedRuns(scope, 20, { createdAt: minutesAgo(61) });
    const alarm = agentSpendAlarmService(db, makeHooks());

    const result = await alarm.evaluateAgent(scope.companyId, scope.agentId);

    expect(result).toMatchObject({ kind: "pass", runsStarted: 59 });
    expect((await getAgent(scope.agentId)).status).toBe("idle");
  });

  it("pauses on 5000 list cents finished in 60 min from subscription runs with 0 billed cents", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 2, { usageJson: { costUsd: 20, billingType: "subscription_included" } });
    // Cache-adjusted wins over costUsd, as in resolveCacheAdjustedCostUsd.
    await seedRuns(scope, 1, { usageJson: { costUsd: 99, cacheAdjustedCostUsd: 10.5 } });
    // Started before the window, finished inside it: counts for cost, not runs.
    await seedRuns(scope, 1, { createdAt: minutesAgo(90), finishedAt: minutesAgo(5), usageJson: { costUsd: 0.5 } });
    // Finished before the window: ignored.
    await seedRuns(scope, 1, { createdAt: minutesAgo(120), finishedAt: minutesAgo(70), usageJson: { costUsd: 500 } });
    const hooks = makeHooks();

    await recordRunCost(costService(db, hooks), scope);

    const agent = await getAgent(scope.agentId);
    expect(agent.pauseReason).toBe("system");
    const [trip] = await tripActivities(scope.agentId);
    expect(trip!.details).toMatchObject({ runsStarted: 3, listCents: 5100, trippedBy: ["list_cost"] });
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
    expect(hooks.postOpsAlert.mock.calls[0]![0].body).toContain("used $51.00 list");
  });

  it("does nothing for an agent that is already paused", async () => {
    const scope = await seedAgent("paused");
    await seedRuns(scope, 80);
    const hooks = makeHooks();

    await recordRunCost(costService(db, hooks), scope);

    const agent = await getAgent(scope.agentId);
    expect(agent.pauseReason).toBe("budget");
    expect(await tripActivities(scope.agentId)).toHaveLength(0);
    expect(hooks.postOpsAlert).not.toHaveBeenCalled();
    expect(hooks.cancelQueuedWorkForAgent).not.toHaveBeenCalled();
  });

  it("trips once when two evaluations race", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 70);
    const hooks = makeHooks();
    const alarm = agentSpendAlarmService(db, hooks);

    const results = await Promise.all([
      alarm.evaluateAgent(scope.companyId, scope.agentId),
      alarm.evaluateAgent(scope.companyId, scope.agentId),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already_paused", "tripped"]);
    expect(await tripActivities(scope.agentId)).toHaveLength(1);
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("ignores runs and cost from before the trip after a resume", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 60, { usageJson: { costUsd: 1 } });
    const hooks = makeHooks();
    const costs = costService(db, hooks);
    await recordRunCost(costs, scope);
    expect((await getAgent(scope.agentId)).pauseReason).toBe("system");

    await agentService(db).resume(scope.agentId);
    await seedRuns(scope, 2, { createdAt: new Date(), usageJson: { costUsd: 3 } });
    const alarm = agentSpendAlarmService(db, hooks);
    const result = await alarm.evaluateAgent(scope.companyId, scope.agentId);

    expect(result).toMatchObject({ kind: "pass", runsStarted: 2, listCents: 600 });
    expect((await getAgent(scope.agentId)).status).toBe("idle");
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("reads the caps per evaluation: 0 disables one cap, both 0 disable the alarm", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 100, { usageJson: { costUsd: 0.1 } });
    const hooks = makeHooks();
    const alarm = agentSpendAlarmService(db, hooks);

    vi.stubEnv("PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR", "0");
    vi.stubEnv("PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR", "0");
    expect(await alarm.evaluateAgent(scope.companyId, scope.agentId)).toEqual({ kind: "disabled" });

    vi.stubEnv("PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR", "5000");
    expect(await alarm.evaluateAgent(scope.companyId, scope.agentId)).toMatchObject({
      kind: "pass",
      runsStarted: 100,
      listCents: 1000,
    });

    vi.stubEnv("PAPERCLIP_SPEND_ALARM_MAX_LIST_CENTS_PER_HOUR", "1000");
    expect(await alarm.evaluateAgent(scope.companyId, scope.agentId)).toMatchObject({ kind: "tripped" });
    expect(hooks.postOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("a budget policy edit does not clear a system pause", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 60);
    await recordRunCost(costService(db, makeHooks()), scope);
    expect((await getAgent(scope.agentId)).pauseReason).toBe("system");

    await budgetService(db).upsertPolicy(
      scope.companyId,
      { scopeType: "agent", scopeId: scope.agentId, amount: 1_000_000 },
      null,
    );

    const agent = await getAgent(scope.agentId);
    expect(agent.status).toBe("paused");
    expect(agent.pauseReason).toBe("system");
  });

  it("cancels queued runs and wakes through the heartbeat hook and leaves the running run alone", async () => {
    const scope = await seedAgent();
    await seedRuns(scope, 59);
    const [runningRun] = await seedRuns(scope, 1, { status: "running", createdAt: new Date(), finishedAt: null });
    const [queuedRun] = await seedRuns(scope, 1, { status: "queued", createdAt: new Date(), finishedAt: null });
    const [queuedWake] = await db
      .insert(agentWakeupRequests)
      .values({ companyId: scope.companyId, agentId: scope.agentId, source: "automation", status: "queued" })
      .returning();
    const heartbeat = heartbeatService(db);
    const postOpsAlert = vi.fn(async () => undefined);
    const costs = costService(db, {
      cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
      cancelQueuedWorkForAgent: heartbeat.cancelQueuedWorkForAgent,
      postOpsAlert,
    });

    await recordRunCost(costs, scope);

    expect((await getAgent(scope.agentId)).pauseReason).toBe("system");
    const runStatus = async (id: string) =>
      (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!.status;
    expect(await runStatus(runningRun!.id)).toBe("running");
    expect(await runStatus(queuedRun!.id)).toBe("cancelled");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queuedWake!.id));
    expect(wake!.status).toBe("cancelled");
    expect(wake!.error).toBe("Cancelled by the spend alarm");
    expect(postOpsAlert).toHaveBeenCalledTimes(1);
  });
});
