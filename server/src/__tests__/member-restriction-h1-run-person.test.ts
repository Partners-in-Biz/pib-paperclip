import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { issueService } from "../services/issues.ts";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import {
  WAKE_CAUSING_ACTOR_CONTEXT_KEY,
  stampWakeCausingActor,
  wakeCausingActorFromStoredWake,
  type WakeCausingActor,
} from "../services/heartbeat/causing-actor.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";

/**
 * H1 (PAR-12608 4.10, AC-H1, AC-H9): a run works for the person who caused
 * its start when rule group H binds that person. One test per writer of "who a
 * run works for": assignment, comment wake by a run, retry, a person H does not
 * bind, a timer; plus the kill switch (AC-F8) and a failing read (AC-X1).
 */

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "H1 test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("H1 stamp on stored wakes and failed reads", () => {
  it("keeps a causing run's id when a stored wake is replayed, and ignores a stamp naming another actor", () => {
    const stamped = { [WAKE_CAUSING_ACTOR_CONTEXT_KEY]: { type: "agent", agentId: "agent-1", runId: "run-1" } };
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: "agent", requestedByActorId: "agent-1" }, stamped))
      .toEqual({ type: "agent", agentId: "agent-1", runId: "run-1" });
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: "agent", requestedByActorId: "agent-2" }, stamped))
      .toEqual({ type: "agent", agentId: "agent-2", runId: null });
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: "system" }, stamped)).toBe("system");
  });

  it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no person when the restriction read fails (AC-X1)", async () => {
    const failing = { select: vi.fn(() => { throw new Error("connection lost"); }) } as unknown as Db;
    const contextSnapshot = { [WAKE_CAUSING_ACTOR_CONTEXT_KEY]: { type: "user", userId: "user-u" } };
    const seed = createHeartbeatRunPreparation(failing).resolveResponsibleUserIdForRunSeed({
      companyId: "company-1", contextSnapshot, issueContext: null,
      routineEnvContext: { routineId: null, env: null, responsibleUserId: null },
    });
    await expect(seed).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    await expect(stampWakeCausingActor(failing, "company-1", [{}], { type: "user", userId: "user-u" }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("reads nothing with the kill switch `off` (AC-F8)", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const select = vi.fn();
    const context: Record<string, unknown> = { [WAKE_CAUSING_ACTOR_CONTEXT_KEY]: "forged" };
    await stampWakeCausingActor({ select } as unknown as Db, "company-1", [context], { type: "agent", agentId: "a", runId: "r" });
    expect(select).not.toHaveBeenCalled();
    expect(context).toEqual({});
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("H1 database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("H1: a run works for the person who caused it", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-h1-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const baseExecute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementation(async (...args: unknown[]) => {
      const context = (args[0] as { context?: Record<string, unknown> } | undefined)?.context;
      if (context?.wakeReason === "issue_disposition_repair" && typeof context.issueId === "string") {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, context.issueId));
      }
      return baseExecute();
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function person(companyId: string, role: string, label: string) {
    const id = `${label}-${randomUUID()}`;
    await db.insert(authUsers).values({ id, name: label, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, membershipRole: role, status: "active" });
    return id;
  }

  async function agent(companyId: string, name: string) {
    const [row] = await db.insert(agents).values({
      companyId, name, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    }).returning();
    return row!.id;
  }

  /** Owner P; operators O (the task's person) and U; agents X (assignee) and Y; O's open task. */
  async function seed(mode: "off" | "report" | "enforce") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: `H1 ${mode}`, issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      memberRestrictionMode: mode,
    });
    const ownerId = await person(companyId, "owner", "owner");
    const taskPersonId = await person(companyId, "operator", "o");
    const userId = await person(companyId, "operator", "u");
    const agentX = await agent(companyId, "X");
    const agentY = await agent(companyId, "Y");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "O's open task", status: "todo",
      assigneeAgentId: agentX, responsibleUserId: taskPersonId, createdByUserId: taskPersonId });
    return { companyId, ownerId, taskPersonId, userId, agentX, agentY, issueId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  async function finishedRun(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  }

  async function priorRun(s: Seed, agentId: string, responsibleUserId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId, status: "failed",
      invocationSource: "on_demand", responsibleUserId, contextSnapshot: { issueId: s.issueId } }).returning();
    return run!.id;
  }

  const userWake = (userId: string): Pick<WakeupOptions, "causingActor" | "requestedByActorType" | "requestedByActorId"> =>
    ({ causingActor: { type: "user", userId }, requestedByActorType: "user", requestedByActorId: userId });

  /** The wakes of AC-H1, as their writers send them. */
  const writers = {
    "U assigns O's task to X": async (s: Seed) => ({
      ...userWake(s.userId), source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, wakeReason: "issue_assigned" },
    }),
    "U changes the status of O's task": async (s: Seed) => ({
      ...userWake(s.userId), source: "automation", triggerDetail: "system", reason: "issue_status_changed",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, wakeReason: "issue_status_changed" },
    }),
    "U answers X's question on O's task": async (s: Seed) => ({
      ...userWake(s.userId), source: "automation", triggerDetail: "system", reason: "issue_thread_interaction_answered",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId },
    }),
    "a run working for U comments on O's task and wakes X": async (s: Seed) => {
      const runId = await priorRun(s, s.agentY, s.userId);
      return {
        causingActor: { type: "agent", agentId: s.agentY, runId } satisfies WakeCausingActor,
        requestedByActorType: "agent", requestedByActorId: s.agentY, source: "automation", triggerDetail: "system",
        reason: "issue_commented", payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId },
      };
    },
    "U retries a run that worked for O": async (s: Seed) => ({
      ...userWake(s.userId), source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
      payload: { issueId: s.issueId },
      contextSnapshot: { issueId: s.issueId, retryOfRunId: await priorRun(s, s.agentX, s.taskPersonId) },
    }),
  } satisfies Record<string, (s: Seed) => Promise<WakeupOptions>>;

  async function runFor(s: Seed, options: WakeupOptions) {
    const run = await heartbeat.wakeup(s.agentX, options);
    expect(run).toBeTruthy();
    const finished = await finishedRun(run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return finished!;
  }

  async function h1Entries(companyId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "member_restriction.denied"),
      sql`${activityLog.details} ->> 'ruleId' = 'H1'`,
    ));
  }

  it.each(Object.keys(writers) as Array<keyof typeof writers>)("enforce: %s, the run works for U (AC-H1)", async (writer) => {
    const s = await seed("enforce");
    const run = await runFor(s, await writers[writer](s));
    expect(run.responsibleUserId).toBe(s.userId);
    expect(await h1Entries(s.companyId)).toEqual([]);
  });

  it.each(Object.keys(writers) as Array<keyof typeof writers>)("report: %s, the run keeps O and one entry is recorded (AC-H1)", async (writer) => {
    const s = await seed("report");
    const run = await runFor(s, await writers[writer](s));
    expect(run.responsibleUserId).toBe(s.taskPersonId);
    const entries = await h1Entries(s.companyId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({ personId: s.userId, ruleId: "H1", mode: "report", target: "heartbeat.run_person" });
  });

  it.each(["off", "kill switch"] as const)("%s: U assigns O's task, the run keeps O and the context is today's (AC-F8)", async (variant) => {
    const s = await seed(variant === "off" ? "off" : "enforce");
    if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const run = await runFor(s, await writers["U assigns O's task to X"](s));
    expect(run.responsibleUserId).toBe(s.taskPersonId);
    expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
    expect(await h1Entries(s.companyId)).toEqual([]);
  });

  const systemWake = (s: Seed, contextSnapshot: Record<string, unknown> = {}): WakeupOptions => ({
    causingActor: "system", source: "automation", triggerDetail: "system", requestedByActorType: "system",
    payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, ...contextSnapshot },
  });

  it.each(["O", "the owner", "nobody (a system wake)"] as const)("enforce: %s starts the run, it works for O", async (who) => {
    const s = await seed("enforce");
    const options = who === "nobody (a system wake)" ? systemWake(s) : {
      ...userWake(who === "O" ? s.taskPersonId : s.ownerId), source: "assignment" as const, triggerDetail: "system" as const,
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId },
    };
    const run = await runFor(s, options);
    expect(run.responsibleUserId).toBe(s.taskPersonId);
    if (who !== "O") expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
  });

  it("enforce: a stamp a caller puts in the wake context is replaced, never trusted", async () => {
    const s = await seed("enforce");
    const run = await runFor(s, systemWake(s, { [WAKE_CAUSING_ACTOR_CONTEXT_KEY]: { type: "user", userId: s.userId } }));
    expect(run.responsibleUserId).toBe(s.taskPersonId);
    expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
  });

  it("enforce: a failed restriction read refuses the wake with 503 and starts no run (AC-X1)", async () => {
    const s = await seed("enforce");
    await db.execute(sql`UPDATE company_memberships SET restricted = true, restricted_plugin_keys = '{"broken": true}'::jsonb
      WHERE company_id = ${s.companyId} AND principal_id = ${s.userId}`);
    await expect(heartbeat.wakeup(s.agentX, await writers["U assigns O's task to X"](s)))
      .rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toEqual([]);
  });

  it("a task created by a run that works for U names U (AC-H9)", async () => {
    const s = await seed("enforce");
    const runId = await priorRun(s, s.agentX, s.userId);
    const task = await issueService(db).create(s.companyId, {
      title: "Made by U's run", status: "todo", createdByAgentId: s.agentX, actorRunId: runId,
    });
    expect(task.responsibleUserId).toBe(s.userId);
  });
});
