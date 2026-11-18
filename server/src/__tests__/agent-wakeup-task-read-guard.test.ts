import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { logger } from "../middleware/logger.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13041 (access C4k-8, PAR-12608 spec 4.6, AC-G3): a manual wake on
 * POST /agents/:id/wakeup (no failedRunId) and POST /agents/:id/heartbeat/invoke
 * may name only tasks the caller can read, by issueId, taskId, taskKey or
 * resumeFromRunId. Otherwise 404 "Issue not found" and nothing is written.
 * Board callers are injected session actors; agent Y calls with a real run
 * token (actorMiddleware, `claims.responsible_user_id` = U, O or null).
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

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_WAKEUP_TASK_READ_GUARD_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("a manual wake may name only a task the caller can read", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O owner, U operator, R restricted operator at restrictionMode "off", I instance admin (plain operator of C).
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, R = `r-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator", [R]: "operator", [I]: "operator" };
  const prefix = `W${randomUUID().replace(/[^a-f]/g, "").slice(0, 4).toUpperCase()}`;
  // X the woken agent; Y its manager. P private to O (assignee X), P2 private to O with an agent grant to Y,
  // Q open; runP a finished run of X on P.
  let companyId = "", X = "", Y = "", P = "", P2 = "", Q = "", qIdentifier = "", pIdentifier = "", chatId = "", runP = "";
  const yToken = { U: "", O: "", none: "" };

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
  const tokenApp = () => {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  };
  const path = (route: "wakeup" | "heartbeat/invoke") => `/api/agents/${X}/${route}`;
  const wake = (actor: RequestActor, payload?: Record<string, unknown>, route: "wakeup" | "heartbeat/invoke" = "wakeup") =>
    request(appFor(actor)).post(path(route)).send(payload ? { payload } : {});
  const agentWake = (token: string, payload: Record<string, unknown>, route: "wakeup" | "heartbeat/invoke" = "wakeup") =>
    request(tokenApp()).post(path(route)).set("Authorization", `Bearer ${token}`).send({ payload });

  const total = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  /** Everything a denied wake must not write: X's wake requests, runs, and its session for key P. */
  const writes = async () => ({
    wakes: await total(db.select({ n: count() }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, X))),
    runs: await total(db.select({ n: count() }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, X))),
    session: await db.select({ updatedAt: agentTaskSessions.updatedAt, params: agentTaskSessions.sessionParamsJson })
      .from(agentTaskSessions).where(and(eq(agentTaskSessions.agentId, X), eq(agentTaskSessions.taskKey, P))),
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 300));
  const expectDenied = async (send: () => Promise<request.Response>) => {
    const before = await writes();
    const res = await send();
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    await flush();
    expect(await writes()).toEqual(before);
  };
  /**
   * 202 and the wake lands on `taskId`: a run of X on it (`issueId`, or `taskKey` for a key-only wake), or
   * today's deferral into X's run already on it (`issue_execution_deferred` carries the same `issueId`).
   */
  const expectRunOn = async (send: () => Promise<request.Response>, taskId: string) => {
    const res = await send();
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.issueId ?? res.body.contextSnapshot?.taskKey, JSON.stringify(res.body)).toBe(taskId);
  };

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "wakeup-task-read-guard-secret";
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-task-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    const [company] = await db.insert(companies).values({ name: "Wake guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === R });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true } };
    const [y] = await db.insert(agents).values({ companyId, name: "Lead", role: "engineer", status: "idle", adapterType: "process", runtimeConfig }).returning();
    Y = y!.id;
    const [x] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig, reportsTo: Y }).returning();
    X = x!.id;
    for (const principalId of [X, Y])
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const chat = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    chatId = chat.body.id;
    const create = (title: string, visibility?: "private") => issueService(db).create(companyId, {
      title, ...(visibility ? { visibility } : {}), status: "in_progress", assigneeAgentId: X, createdByUserId: O, responsibleUserId: O,
    });
    const p = await create("Private plan", "private");
    P = p.id; pIdentifier = p.identifier!;
    P2 = (await create("Private plan shared with Lead", "private")).id;
    const q = await create("Open task");
    Q = q.id; qIdentifier = q.identifier!;
    await db.insert(issueAccessGrants).values({ issueId: P2, subjectType: "agent", subjectId: Y, source: "explicit", grantedByUserId: O });
    const [finished] = await db.insert(heartbeatRuns).values({
      companyId, agentId: X, invocationSource: "on_demand", triggerDetail: "manual", status: "succeeded",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), sessionIdBefore: "sess-p", sessionIdAfter: "sess-p",
      contextSnapshot: { issueId: P, taskId: P, taskKey: P },
    }).returning();
    runP = finished!.id;
    await db.insert(agentTaskSessions).values({ companyId, agentId: X, adapterType: "process", taskKey: P,
      sessionParamsJson: { sessionId: "sess-p" }, sessionDisplayId: "sess-p", lastRunId: runP });
    // Y's own runs, one per person it works for, and a run token for each (middleware/auth.ts JWT path).
    for (const [key, person] of [["U", U], ["O", O], ["none", null]] as const) {
      const [yRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: Y, invocationSource: "on_demand",
        triggerDetail: "manual", status: "running", startedAt: new Date(), responsibleUserId: person }).returning();
      yToken[key] = createLocalAgentJwt(Y, companyId, "process", yRun!.id, person)!;
    }
  }, 120_000);

  // Each case starts with X idle, so a reader's wake is not coalesced into the previous case's run.
  afterEach(async () => {
    await Promise.race([heartbeatService(db).drainActiveRunExecutions(), new Promise(resolve => setTimeout(resolve, 2_000))]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, X), inArray(heartbeatRuns.status, ["queued", "running"])));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, X));
    failRead.userId = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await flush();
    await Promise.race([heartbeatService(db).drainActiveRunExecutions(), new Promise(resolve => setTimeout(resolve, 10_000))]);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  // Denials first: no successful wake has run yet, so X's rows and P's session are still.
  it("the fixtures hold: U cannot read P, O can", async () => {
    expect((await request(appFor(user(U))).get(`/api/issues/${P}`)).status).toBe(404);
    expect((await request(appFor(user(O))).get(`/api/issues/${P}`)).status).toBe(200);
  });

  it.each([
    ["{issueId: P}", () => ({ issueId: P })],
    ["{taskId: P}", () => ({ taskId: P })],
    ["{taskKey: P}", () => ({ taskKey: P })],
    ["{issueId: Q, taskKey: P}", () => ({ issueId: Q, taskKey: P })],
    ["{issueId: Q, taskId: P}", () => ({ issueId: Q, taskId: P })],
    ["{resumeFromRunId: run on P}", () => ({ resumeFromRunId: runP })],
    ["{issueId: Q, resumeFromRunId: run on P}", () => ({ issueId: Q, resumeFromRunId: runP })],
    ["{taskKey: P's identifier}", () => ({ taskKey: pIdentifier })],
    ["an unknown UUID", () => ({ issueId: randomUUID() })],
    ["the identifier of readable Q (deliberate change)", () => ({ issueId: qIdentifier })],
    ["a non-UUID string", () => ({ issueId: "not-a-task" })],
    ["O's chat", () => ({ issueId: chatId })],
  ])("U with %s on /wakeup: 404, nothing written", async (_label, payload) => {
    await expectDenied(() => wake(user(U), payload()));
  });

  it("U with {issueId: P} on /heartbeat/invoke: 404, nothing written", async () => {
    await expectDenied(() => wake(user(U), { issueId: P }, "heartbeat/invoke"));
  });

  it.each([
    ["{issueId: P}", "wakeup", () => ({ issueId: P })],
    ["{issueId: Q, taskKey: P}", "wakeup", () => ({ issueId: Q, taskKey: P })],
    ["{resumeFromRunId: run on P}", "wakeup", () => ({ resumeFromRunId: runP })],
    ["{issueId: P}", "heartbeat/invoke", () => ({ issueId: P })],
    ["{issueId: P2} (Y reads P2, U does not)", "wakeup", () => ({ issueId: P2 })],
  ] as const)("agent Y working for U with %s on /%s: 404, nothing written", async (_label, route, payload) => {
    await expectDenied(() => agentWake(yToken.U, payload(), route));
  });

  it("agent Y working for O with {issueId: P}, Y not a member of P: 404 (an agent reads with its own grant and its person's)", async () => {
    await expectDenied(() => agentWake(yToken.O, { issueId: P }));
  });

  it("agent Y with no person on the run, {issueId: P} (private, Y not a member): 404, nothing written", async () => {
    await expectDenied(() => agentWake(yToken.none, { issueId: P }));
  });

  it("every deny leaves one warn line with caller and target agent and no task title", async () => {
    const warn = vi.spyOn(logger, "warn");
    await expectDenied(() => agentWake(yToken.U, { issueId: P }));
    const lines = warn.mock.calls.filter(([, message]) => message === "manual wake refused: payload task not readable");
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({
      callerActorType: "agent", callerAgentId: Y, callerUserId: null, onBehalfOfUserId: U,
      targetAgentId: X, companyId, route: "wakeup", reason: "read_denied",
    });
    expect(JSON.stringify(lines[0])).not.toContain("Private plan");
  });

  it("fails closed when the read decision throws: U with {issueId: P} is non-2xx and nothing is written", async () => {
    failRead.userId = U;
    const before = await writes();
    const res = await wake(user(U), { issueId: P });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    await flush();
    expect(await writes()).toEqual(before);
  });

  // Deviation from the ticket's pin (today's 403 at `off`): the chat rule of `decide()` holds in every
  // privacy mode (`chatReadableBy`, PAR-12774 4.2), so the guard answers the unknown-id 404 here too.
  it("U on O's chat at PAPERCLIP_ISSUE_PRIVACY_MODE=off: 404, the chat rule holds in every mode", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    await expectDenied(() => wake(user(U), { issueId: chatId }));
  });

  it("the failedRunId branch is not this guard's: an unknown failed run keeps C4k-7's 404", async () => {
    const res = await request(appFor(user(U))).post(path("wakeup"))
      .send({ failedRunId: randomUUID(), reason: "retry_failed_run", payload: { issueId: P } });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Failed run not found" });
  });

  // Readers: today's answers.
  it("O with the resume-lost-run shape {issueId, taskId, taskKey} = P: 202 and a run of X on P", async () => {
    await expectRunOn(() => wake(user(O), { issueId: P, taskId: P, taskKey: P }), P);
  });

  it("O with {resumeFromRunId: run on P}: 202 and a run of X on P", async () => {
    await expectRunOn(() => wake(user(O), { resumeFromRunId: runP }), P);
  });

  it("the local board with {issueId, taskId, taskKey} = P: 202 and a run of X on P", async () => {
    await expectRunOn(() => wake(localBoard, { issueId: P, taskId: P, taskKey: P }), P);
  });

  it("the local board with {resumeFromRunId: run on P}: 202 and a run of X on P", async () => {
    await expectRunOn(() => wake(localBoard, { resumeFromRunId: runP }), P);
  });

  it("a session instance admin (plain operator of C) with {issueId: P}: decide() allows, 202", async () => {
    await expectRunOn(() => wake(instanceAdmin(), { issueId: P, taskId: P, taskKey: P }), P);
  });

  it("U with {issueId, taskId, taskKey} = Q: 202; U with no payload: 202", async () => {
    await expectRunOn(() => wake(user(U), { issueId: Q, taskId: Q, taskKey: Q }), Q);
    expect((await wake(user(U))).status).toBe(202);
  });

  it("U with a taskKey that names no task (status-card:<id>): 202 as today", async () => {
    expect((await wake(user(U), { taskKey: `status-card:${randomUUID()}` })).status).toBe(202);
  });

  it("agent Y working for O with {issueId: P2} (both read P2): 202 and a run of X on P2", async () => {
    await expectRunOn(() => agentWake(yToken.O, { issueId: P2 }), P2);
  });

  it("agent Y with no person: {issueId: Q} 202 and {issueId: P2} (Y's grant) 202", async () => {
    await expectRunOn(() => agentWake(yToken.none, { issueId: Q }), Q);
    await expectRunOn(() => agentWake(yToken.none, { issueId: P2 }), P2);
  });

  it("manager Y waking its report X on Q at PAPERCLIP_ISSUE_PRIVACY_MODE=off: 202 (no person and working for O)", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    await expectRunOn(() => agentWake(yToken.none, { issueId: Q }), Q);
    await expectRunOn(() => agentWake(yToken.O, { issueId: Q }), Q);
  });

  it("a restricted member at restrictionMode off with {issueId: Q}: 202 as today", async () => {
    await expectRunOn(() => wake(user(R), { issueId: Q }), Q);
  });

  it("kill switch PAPERCLIP_ISSUE_PRIVACY_MODE=off: U with {issueId: P} and with {taskKey: P} keeps today's 202", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    await expectRunOn(() => wake(user(U), { issueId: P }), P);
    await expectRunOn(() => wake(user(U), { taskKey: P }), P);
  });
});
