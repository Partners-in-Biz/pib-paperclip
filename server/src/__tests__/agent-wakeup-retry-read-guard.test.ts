import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13017 (access C4k-7, PAR-12608 spec 4.6, AC-G3): the exact failed-run
 * retry on POST /agents/:id/wakeup reads the run's task first for board
 * callers. The task is the run's `issueId`, else its `taskId` (the heartbeat
 * rule). A caller who cannot read it gets 404 "Failed run not found", the same
 * body as an unknown run id, before any 409, and nothing is written. Readers
 * keep today's answers.
 */

// The wake must not spawn a real adapter process.
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok" })),
    })),
  };
});

// Failing-read switch (PAR-12718): makes the issue:read decision throw for one user.
const failRead = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: (db: Parameters<typeof actual.accessService>[0]) => {
      const svc = actual.accessService(db);
      return {
        ...svc,
        decide: async (input: Parameters<typeof svc.decide>[0]) => {
          const actor = input.actor as { userId?: string };
          if (input.action === "issue:read" && failRead.userId && actor.userId === failRead.userId)
            throw new Error("access decision store unavailable");
          return svc.decide(input);
        },
      };
    },
  };
});

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_WAKEUP_RETRY_READ_GUARD_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("exact failed-run retry reads the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O owner, U operator, G operator with an issue grant on P, R restricted
  // operator at restrictionMode "off", I instance admin (plain operator of C).
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, G = `g-${randomUUID()}`;
  const R = `r-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator", [G]: "operator", [R]: "operator", [I]: "operator" };
  const prefix = `W${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", P = "", Q = "", chatId = "";
  const run = { a: "", b: "", c: "", d: "", e: "", f: "", chat: "" };

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: userId === R, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({ ...user(I), isInstanceAdmin: true });
  const localBoard: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };
  const retry = (actor: RequestActor, failedRunId: string) =>
    request(appFor(actor)).post(`/api/agents/${X}/wakeup`).send({ failedRunId, reason: "retry_failed_run" });

  async function insertRun(values: Partial<typeof heartbeatRuns.$inferInsert>) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId, agentId: X, invocationSource: "on_demand", triggerDetail: "manual", status: "failed",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), ...values,
    }).returning();
    return row!.id;
  }
  const failedOn = (issueId: string) => insertRun({ contextSnapshot: { issueId, taskId: issueId, taskKey: issueId } });

  const total = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  /** Everything a denied retry must not write. */
  const writes = async () => ({
    wakes: await total(db.select({ n: count() }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, X))),
    runs: await total(db.select({ n: count() }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, X))),
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 300));
  /** A wake row for X on `taskId` requested by `userId` (the run's issueId or, for a taskId-only run, its taskId). */
  const waitForWake = async (userId: string, taskId: string) => {
    for (let i = 0; i < 20; i += 1) {
      const [row] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, X), eq(agentWakeupRequests.requestedByActorId, userId),
        sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId') = ${taskId}`,
      )).limit(1);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined;
  };
  let unknownBody: unknown;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-retry-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    const [company] = await db.insert(companies).values({ name: "Retry guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === R });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const [x] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    X = x!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: X, status: "active", membershipRole: "member" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    // O's chat with X, through the real chat route, so it is private.
    const chat = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    chatId = chat.body.id;
    P = (await issueService(db).create(companyId, {
      title: "Private plan", visibility: "private", status: "in_progress", assigneeAgentId: X,
      createdByUserId: O, responsibleUserId: O,
    })).id;
    Q = (await issueService(db).create(companyId, {
      title: "Open task", status: "in_progress", assigneeAgentId: X, createdByUserId: O, responsibleUserId: O,
    })).id;
    const F = (await issueService(db).create(companyId, {
      title: "Deleted later", status: "in_progress", assigneeAgentId: X, createdByUserId: O, responsibleUserId: O,
    })).id;
    await db.insert(issueAccessGrants).values({ issueId: P, subjectType: "user", subjectId: G, source: "explicit", grantedByUserId: O });

    run.a = await failedOn(P);
    run.b = await insertRun({ contextSnapshot: { taskId: P, taskKey: P } });
    // A provider cancellation canRetryStoppedRun accepts; it does not own P's recovery hold.
    run.c = await insertRun({ status: "cancelled", contextSnapshot: { issueId: P, taskId: P }, resultJson: {
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" }, reason: "Provider cancelled execution", recordedAt: now.toISOString() },
      acpToolInventoryComplete: true, acpPendingToolCount: 0,
    } });
    run.d = await insertRun({ runtimeMode: "native", errorCode: "native_session_cleanup_quarantined", contextSnapshot: { issueId: P, taskId: P } });
    run.e = await failedOn(Q);
    run.f = await failedOn(F);
    await db.delete(issues).where(eq(issues.id, F));
    run.chat = await insertRun({ contextSnapshot: { issueId: chatId, taskId: chatId, taskKey: chatId } });
  }, 120_000);

  afterEach(() => {
    failRead.userId = null;
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await flush();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  // Denials first: no successful wake has run yet, so X's row counts are still.
  it("the fixtures hold: U cannot read P, O can", async () => {
    expect((await request(appFor(user(U))).get(`/api/issues/${P}`)).status).toBe(404);
    expect((await request(appFor(user(O))).get(`/api/issues/${P}`)).status).toBe(200);
  });

  it("an unknown failedRunId answers 404 Failed run not found", async () => {
    const res = await retry(user(U), randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    unknownBody = res.body;
    expect(unknownBody).toEqual({ error: "Failed run not found" });
  });

  it.each([
    ["(a) issueId on P", "a"],
    ["(b) taskId only on P", "b"],
    ["(c) cancelled on P", "c"],
    ["(d) quarantined native on P", "d"],
    ["the run on O's chat", "chat"],
  ] as const)("U's retry of %s answers the unknown-run 404 and writes nothing", async (_label, key) => {
    const before = await writes();
    const res = await retry(user(U), run[key]);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Failed run not found" });
    expect(res.body).toEqual(unknownBody);
    expect(await writes()).toEqual(before);
    await flush();
    expect(await writes()).toEqual(before);
  });

  it("fails closed when the read decision throws: U on (a) is non-2xx and nothing is written", async () => {
    failRead.userId = U;
    const before = await writes();
    const res = await retry(user(U), run.a);
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    await flush();
    expect(await writes()).toEqual(before);
  });

  it("an agent caller with failedRunId keeps today's 403 and writes nothing", async () => {
    const before = await writes();
    const res = await request((() => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "agent", agentId: X, companyId, runId: run.a, source: "agent_jwt" }; next(); });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    })()).post(`/api/agents/${X}/wakeup`).send({ failedRunId: run.a, reason: "retry_failed_run" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await writes()).toEqual(before);
  });

  it("O on (c) and (d) gets today's 409 bodies", async () => {
    const before = await writes();
    const cancelled = await retry(user(O), run.c);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(409);
    expect(cancelled.body).toEqual({ error: "The stopped run no longer owns this task's recovery hold." });
    const quarantined = await retry(user(O), run.d);
    expect(quarantined.status, JSON.stringify(quarantined.body)).toBe(409);
    expect(quarantined.body).toEqual({
      error: "The stopped native session requires cleanup and reconciliation before a new attempt.",
      code: "native_session_cleanup_quarantined",
      details: { code: "native_session_cleanup_quarantined" },
    });
    expect(await writes()).toEqual(before);
  });

  it("O on (b), a taskId-only run, gets today's 409 from the heartbeat retry check and writes nothing", async () => {
    // heartbeat.wakeup matches a failed run to its task by `contextSnapshot.issueId`
    // only, so a taskId-only run cannot be retried today; this ticket keeps that.
    const before = await writes();
    const res = await retry(user(O), run.b);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({ error: "The selected failed run cannot be retried for this task." });
    expect(await writes()).toEqual(before);
  });

  it("O on (f), a run whose task was deleted, gets today's 404 Task not found", async () => {
    const res = await retry(user(O), run.f);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Task not found" });
  });

  it("O retries (a): 202 and a wake row for X on P", async () => {
    const res = await retry(user(O), run.a);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await waitForWake(O, P), "O's wake on P").toBeDefined();
  });

  it("the local board retries (a): 202", async () => {
    const res = await retry(localBoard, await failedOn(P));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
  });

  it("a session instance admin (plain operator of C, not the local board) retries (a): decide() allows, 202", async () => {
    const res = await retry(instanceAdmin(), await failedOn(P));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
  });

  it("G, an operator with an issue grant on P, retries (a): 202", async () => {
    expect((await request(appFor(user(G))).get(`/api/issues/${P}`)).status).toBe(200);
    const res = await retry(user(G), await failedOn(P));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
  });

  it("U retries (e) on the public task Q: 202", async () => {
    const res = await retry(user(U), run.e);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await waitForWake(U, Q), "U's wake on Q").toBeDefined();
  });

  it("a restricted member at restrictionMode off retries a run on Q: 202 as today", async () => {
    const res = await retry(user(R), await failedOn(Q));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
  });

  it("with PAPERCLIP_ISSUE_PRIVACY_MODE=off U's retry of (a) keeps today's 202 (kill switch)", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    const res = await retry(user(U), await failedOn(P));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
  });
});
