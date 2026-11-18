import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13016 (access C4k-6, PAR-12608 spec 4.6, AC-G3): context/compact and
 * PUT title read the task first for board callers. A board caller who cannot
 * read the task gets 404 "Issue not found" and nothing is written (no
 * activity row, no compaction wake, no title change). On title, a board caller
 * who can read but is denied issue:mutate (a viewer) gets 403. The agent title
 * path is unchanged.
 *
 * O owner (session, not the local board) has private task P (assignee X) and
 * a chat with X. Q is an open task (assignee X). U operator, V viewer, R a
 * restricted operator at restrictionMode "off", I an instance admin who is a
 * plain operator of C, L the local board. X is a compaction-capable agent.
 */

// Failing-read switch (PAR-12718, PAR-12931): the issue:read decision throws for one user.
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

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_COMPACT_TITLE_READ_GUARD_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("context/compact and PUT title read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const wake = vi.fn(async () => ({ id: randomUUID() }));

  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, V = `v-${randomUUID()}`, R = `r-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator", [V]: "viewer", [R]: "operator", [I]: "operator" };
  const prefix = `T${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", Y = "", P = "", Q = "", chatId = "";

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: userId === R, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({ ...user(I), isInstanceAdmin: true } as RequestActor);
  const localBoard: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  const agent = (agentId: string, runId: string): RequestActor => ({ type: "agent", agentId, companyId, runId, source: "agent_jwt" });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never, { contextCompactionWakeup: wake as never }));
    app.use(errorHandler);
    return app;
  };

  const compact = (actor: RequestActor, issueId: string) => request(appFor(actor)).post(`/api/issues/${issueId}/context/compact`).send({});
  const rename = (actor: RequestActor, issueId: string, title: string) => request(appFor(actor)).put(`/api/issues/${issueId}/title`).send({ title });
  const titleOf = (issueId: string) => db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]!.title);
  const activity = (actorId: string, action: string, issueId: string) => db.select({ id: activityLog.id }).from(activityLog)
    .where(and(eq(activityLog.actorId, actorId), eq(activityLog.action, action), eq(activityLog.entityId, issueId)));
  const flush = () => new Promise(resolve => setTimeout(resolve, 200));

  /** A denied call: 404 "Issue not found", no compaction row, no wake, no title change, no title row. */
  async function expectNothingWritten(res: request.Response, actorId: string, issueId: string, title: string, status = 404) {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (status === 404) expect(res.body).toEqual({ error: "Issue not found" });
    expect(await titleOf(issueId)).toBe(title);
    expect(await activity(actorId, "issue.context_compaction_requested", issueId)).toEqual([]);
    expect(await activity(actorId, "issue.updated", issueId)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    await flush();
    expect(wake).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-compact-title-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    const [company] = await db.insert(companies).values({ name: "Compact title guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === R });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole, grantedByUserId: null });
    }
    const [x, y] = await db.insert(agents).values(["Writer", "Bystander"].map(name => ({
      companyId, name, role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {},
    }))).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId => ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    const opened = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ visibility: "private", conversationUserId: O, conversationAgentId: X });
    chatId = opened.body.id as string;

    const [p, q] = await db.insert(issues).values([
      { companyId, title: "P", status: "in_progress", priority: "medium", visibility: "private", createdByUserId: O,
        responsibleUserId: O, assigneeAgentId: X, issueNumber: 101, identifier: `${prefix}-101` },
      { companyId, title: "Q", status: "in_progress", priority: "medium", createdByUserId: O,
        assigneeAgentId: X, issueNumber: 102, identifier: `${prefix}-102` },
    ]).returning();
    P = p!.id; Q = q!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });
  beforeEach(() => { wake.mockClear(); });
  afterEach(() => { failRead.userId = null; vi.unstubAllEnvs(); });

  it("fixtures hold: U cannot read P or O's chat, O can", async () => {
    for (const issueId of [P, chatId]) {
      expect((await request(appFor(user(U))).get(`/api/issues/${issueId}`)).status).toBe(404);
      expect((await request(appFor(user(O))).get(`/api/issues/${issueId}`)).status).toBe(200);
    }
  });

  it.each(["task", "chat"] as const)("compact: U on O's %s answers 404 and writes nothing", async (on) => {
    const issueId = on === "chat" ? chatId : P;
    const title = await titleOf(issueId);
    await expectNothingWritten(await compact(user(U), issueId), U, issueId, title);
  });

  it.each(["task", "chat"] as const)("title: U on O's %s answers 404 and the title stays", async (on) => {
    const issueId = on === "chat" ? chatId : P;
    const title = await titleOf(issueId);
    await expectNothingWritten(await rename(user(U), issueId, `U renamed ${on}`), U, issueId, title);
  });

  it("title: viewer V on open Q gets 403", async () => {
    await expectNothingWritten(await rename(user(V), Q, "V renamed Q"), V, Q, "Q", 403);
  });

  it("title: viewer V on private P gets 404", async () => {
    await expectNothingWritten(await rename(user(V), P, "V renamed P"), V, P, "P");
  });

  it.each(["compact", "title"] as const)("failing read: U's %s on P answers non-2xx and writes nothing", async (route) => {
    failRead.userId = U;
    const res = route === "compact" ? await compact(user(U), P) : await rename(user(U), P, "U renamed P");
    {
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(await titleOf(P)).toBe("P");
      expect(await activity(U, "issue.context_compaction_requested", P)).toEqual([]);
      expect(await activity(U, "issue.updated", P)).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    }
  });

  it.each([
    { who: "O (owner)", actor: () => user(O), actorId: () => O },
    { who: "L (local board)", actor: () => localBoard, actorId: () => "local-board" },
    { who: "I (instance admin, not the local board)", actor: instanceAdmin, actorId: () => I },
  ])("$who on P: compact 202 with a wake for X, title 200", async ({ who, actor, actorId }) => {
    const res = await compact(actor(), P);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ requestId: expect.any(String), runId: expect.any(String) });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(X, expect.objectContaining({ reason: "context_compaction" }));
    expect(await activity(actorId(), "issue.context_compaction_requested", P)).toHaveLength(1);

    const title = `P renamed by ${who}`;
    const renamed = await rename(actor(), P, title);
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ id: P, title, changed: true });
    expect(await titleOf(P)).toBe(title);
  });

  it("kill switch: with PAPERCLIP_ISSUE_PRIVACY_MODE=off U on P gets today's answers", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    expect((await compact(user(U), P)).status).toBe(202);
    expect(wake).toHaveBeenCalledTimes(1);
    const res = await rename(user(U), P, "U renamed P at off");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await titleOf(P)).toBe("U renamed P at off");
  });

  it("a restricted member at restrictionMode off on open Q gets today's answers", async () => {
    expect((await compact(user(R), Q)).status).toBe(202);
    const res = await rename(user(R), Q, "R renamed Q");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await titleOf(Q)).toBe("R renamed Q");
  });

  it("agent title path is unchanged: X with its own running run 200, Y 403", async () => {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: X, invocationSource: "assignment", triggerDetail: "read guard test", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId: P },
    }).returning();
    try {
      const res = await rename(agent(X, run!.id), P, "X renamed P");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await titleOf(P)).toBe("X renamed P");
      const denied = await rename(agent(Y, run!.id), P, "Y renamed P");
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body).toMatchObject({ error: "Setting a task title requires its assigned agent's active run" });
      expect(await titleOf(P)).toBe("X renamed P");
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    }
  });
});
