import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, agentRuntimeState, agentWakeupRequests, agents, authUsers, companies,
  companyMemberships, companySkills, costEvents, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { runPersonMayUseAgent } from "../services/heartbeat/member-agent-list.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";

/**
 * Invariant A (PAR-12608 4.7, C4c-2a): a run of an agent works for a person
 * restricted under `enforce` only when that agent is on his list, checked where
 * the run is created and again at claim (AC-A9). Plus the queue half of AC-A3
 * and AC-A5, the kill switch (AC-F8) and a failing read (AC-X1).
 */

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Agent list test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent list check without a database", () => {
  it("reads nothing with the kill switch `off` (AC-F8)", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const select = vi.fn();
    await expect(runPersonMayUseAgent({ select } as unknown as Db, {
      companyId: "company-1", agentId: "agent-y", personId: "user-r", target: "heartbeat.run_create",
    })).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE when the read fails (AC-X1)", async () => {
    const failing = { select: vi.fn(() => { throw new Error("connection lost"); }) } as unknown as Db;
    await expect(runPersonMayUseAgent(failing, {
      companyId: "company-1", agentId: "agent-y", personId: "user-r", target: "heartbeat.run_create",
    })).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("agent list database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("invariant A: the wake queue checks the agent list", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-agent-list-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const table of [issueComments, activityLog, heartbeatRunEvents, costEvents, heartbeatRuns, agentWakeupRequests,
      agentRuntimeState, issues, agents, companySkills, companyMemberships, companies, authUsers]) await db.delete(table);
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

  async function setRestriction(companyId: string, personId: string, restricted: boolean, agentIds: string[]) {
    await db.update(companyMemberships).set({ restricted, restrictedAgentIds: agentIds })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, personId)));
  }

  /** Owner O; R flagged with X on his list; R's task assigned to unlisted Y. */
  async function seed(mode: "off" | "report" | "enforce") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: `Agent list ${mode}`, issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      memberRestrictionMode: mode,
    });
    const ownerId = await person(companyId, "owner", "o");
    const restrictedId = await person(companyId, "operator", "r");
    const agentX = await agent(companyId, "X");
    const agentY = await agent(companyId, "Y");
    await setRestriction(companyId, restrictedId, true, [agentX]);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "R's task", status: "todo",
      assigneeAgentId: agentY, responsibleUserId: restrictedId, createdByUserId: restrictedId });
    return { companyId, ownerId, restrictedId, agentX, agentY, issueId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  /** A saved comment of `userId` on R's task, and the wake the comment route sends its assignee. */
  async function commentWake(s: Seed, userId: string): Promise<WakeupOptions> {
    const [comment] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, authorUserId: userId, body: "Please continue.",
    }).returning();
    const wake = wakeBy(s, userId, "issue_commented");
    return { ...wake, payload: { ...wake.payload, commentId: comment!.id },
      contextSnapshot: { ...wake.contextSnapshot, wakeCommentId: comment!.id, commentId: comment!.id } };
  }

  const wakeBy = (s: Seed, userId: string, reason = "issue_assigned"): WakeupOptions => ({
    causingActor: { type: "user", userId }, requestedByActorType: "user", requestedByActorId: userId,
    source: "assignment", triggerDetail: "system", reason,
    payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, wakeReason: reason },
  });
  const systemWake = (s: Seed): WakeupOptions => ({
    causingActor: "system", requestedByActorType: "system", source: "automation", triggerDetail: "system",
    payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId },
  });

  const runsOf = (agentId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  const skips = (agentId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "member_restricted_agent_not_listed")));
  const denials = (companyId: string) => db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied"),
    sql`${activityLog.details} ->> 'ruleId' = 'R-wake'`));

  async function finishedRun(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  }

  it.each([
    ["R wakes unlisted Y on his task", (s: Seed) => wakeBy(s, s.restrictedId)],
    ["R's comment on his task wakes its assignee Y (AC-A5)", (s: Seed) => commentWake(s, s.restrictedId)],
    ["a system wake of Y on R's task", (s: Seed) => systemWake(s)],
  ] as const)("enforce: %s; no run, the wake is skipped and one entry is written", async (_label, options) => {
    const s = await seed("enforce");
    expect(await heartbeat.wakeup(s.agentY, await options(s))).toBeNull();
    expect(await runsOf(s.agentY)).toEqual([]);
    expect(await skips(s.agentY)).toEqual([expect.objectContaining({ status: "skipped" })]);
    const entries = await denials(s.companyId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({
      personId: s.restrictedId, mode: "enforce", target: "heartbeat.run_create", objectId: s.agentY,
    });
  });

  it("enforce: R wakes listed X, the run starts and works for R (AC-A2, queue half)", async () => {
    const s = await seed("enforce");
    const run = await heartbeat.wakeup(s.agentX, wakeBy(s, s.restrictedId));
    expect(run).toBeTruthy();
    expect((await finishedRun(run!.id)).responsibleUserId).toBe(s.restrictedId);
    expect(await denials(s.companyId)).toEqual([]);
  });

  it("enforce: O's comment on R's task starts Y's run, which works for O (AC-A5)", async () => {
    const s = await seed("enforce");
    const run = await heartbeat.wakeup(s.agentY, await commentWake(s, s.ownerId));
    expect(run).toBeTruthy();
    expect((await finishedRun(run!.id)).responsibleUserId).toBe(s.ownerId);
  });

  it.each(["restricted", "owner"] as const)("a mention by the %s starts no run (AC-A3)", async (who) => {
    const s = await seed("enforce");
    const by = who === "owner" ? s.ownerId : s.restrictedId;
    expect(await heartbeat.wakeup(s.agentY, wakeBy(s, by, "issue_comment_mentioned"))).toBeNull();
    expect(await runsOf(s.agentY)).toEqual([]);
  });

  it("report: R wakes unlisted Y; the run starts and a would-refuse is recorded", async () => {
    const s = await seed("report");
    const run = await heartbeat.wakeup(s.agentY, wakeBy(s, s.restrictedId));
    expect(run).toBeTruthy();
    await finishedRun(run!.id);
    expect(await skips(s.agentY)).toEqual([]);
    expect((await denials(s.companyId)).map((entry) => entry.details)).toEqual([
      expect.objectContaining({ personId: s.restrictedId, mode: "report", target: "heartbeat.run_create" }),
    ]);
  });

  it.each(["off", "kill switch"] as const)("%s: R wakes unlisted Y; the run starts and nothing is recorded (AC-F8)", async (variant) => {
    const s = await seed(variant === "off" ? "off" : "enforce");
    if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const run = await heartbeat.wakeup(s.agentY, wakeBy(s, s.restrictedId));
    expect(run).toBeTruthy();
    await finishedRun(run!.id);
    expect(await denials(s.companyId)).toEqual([]);
  });

  it("enforce: a failed restriction read answers 503 and starts no run (AC-X1)", async () => {
    const s = await seed("enforce");
    await db.execute(sql`UPDATE company_memberships SET restricted_agent_ids = '{"broken": true}'::jsonb
      WHERE company_id = ${s.companyId} AND principal_id = ${s.restrictedId}`);
    await expect(heartbeat.wakeup(s.agentY, systemWake(s)))
      .rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    expect(await runsOf(s.agentY)).toEqual([]);
  });

  /** A run of `agentId` for R, queued while it was allowed (inserted as the queue writes it). */
  async function queuedRunFor(s: Seed, agentId: string) {
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, s.issueId));
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.issueId }, status: "queued", requestedByActorType: "user", requestedByActorId: s.restrictedId,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId, scopeKind: "issue", issueId: s.issueId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued", responsibleUserId: s.restrictedId, wakeupRequestId: wake!.id,
      contextSnapshot: { issueId: s.issueId, wakeReason: "issue_assigned" },
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    return run!;
  }

  it.each([
    ["O takes X off R's list", (s: Seed) => setRestriction(s.companyId, s.restrictedId, true, [])],
    ["R is flagged after the wake was queued", async (s: Seed) => {
      await setRestriction(s.companyId, s.restrictedId, false, []);
      return setRestriction(s.companyId, s.restrictedId, true, []);
    }],
  ] as const)("enforce: %s before claim; the queued run of X is cancelled at claim (AC-A9)", async (_label, change) => {
    const s = await seed("enforce");
    const queued = await queuedRunFor(s, s.agentX);
    await change(s);
    await heartbeat.resumeQueuedRunsForAgent(s.companyId, s.agentX);
    const run = await finishedRun(queued.id);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "member_restricted_agent_not_listed" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId!));
    expect(wake!.status).toBe("skipped");
    expect((await denials(s.companyId))[0]!.details).toMatchObject({ target: "heartbeat.run_claim", objectId: s.agentX });
  });

  it("enforce: a queued run of listed X for R still starts at claim", async () => {
    const s = await seed("enforce");
    const queued = await queuedRunFor(s, s.agentX);
    await heartbeat.resumeQueuedRunsForAgent(s.companyId, s.agentX);
    expect((await finishedRun(queued.id)).status).toBe("succeeded");
  });

  it("enforce: a failed restriction read at claim leaves the run queued and unstarted (AC-X1)", async () => {
    const s = await seed("enforce");
    const queued = await queuedRunFor(s, s.agentY);
    await db.execute(sql`UPDATE company_memberships SET restricted_agent_ids = '{"broken": true}'::jsonb
      WHERE company_id = ${s.companyId} AND principal_id = ${s.restrictedId}`);
    await heartbeat.resumeQueuedRunsForAgent(s.companyId, s.agentY);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(run!.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId!));
    expect(wake!.status).not.toBe("skipped");
  });

  it("kill switch: a queued run of unlisted Y starts at claim and nothing is recorded (AC-F8)", async () => {
    const s = await seed("enforce");
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const queued = await queuedRunFor(s, s.agentY);
    await heartbeat.resumeQueuedRunsForAgent(s.companyId, s.agentY);
    expect((await finishedRun(queued.id)).status).toBe("succeeded");
    expect(await denials(s.companyId)).toEqual([]);
  });

  it.each(["terminated", "paused"] as const)("enforce: listed X, then %s, never passes the check (AC-A9)", async (status) => {
    const s = await seed("enforce");
    await db.update(agents).set({ status }).where(eq(agents.id, s.agentX));
    await expect(runPersonMayUseAgent(db, {
      companyId: s.companyId, agentId: s.agentX, personId: s.restrictedId, target: "heartbeat.run_create",
    })).resolves.toBe(false);
    await expect(heartbeat.wakeup(s.agentX, wakeBy(s, s.restrictedId))).rejects.toBeTruthy();
    expect(await runsOf(s.agentX)).toEqual([]);
  });

  it("enforce: a listed id of another company's agent never passes the check (AC-A9)", async () => {
    const s = await seed("enforce");
    const other = await seed("off");
    await setRestriction(s.companyId, s.restrictedId, true, [s.agentX, other.agentY]);
    await expect(runPersonMayUseAgent(db, {
      companyId: s.companyId, agentId: other.agentY, personId: s.restrictedId, target: "heartbeat.run_create",
    })).resolves.toBe(false);
  });
});
