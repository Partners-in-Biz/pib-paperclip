import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  feedbackExports,
  feedbackVotes,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12958 (access C4k-3, AC-G3): read state, inbox archive, feedback votes
 * and feedback traces read the task first. A task the caller cannot read
 * answers "not found" and nothing is written or returned; the company traces
 * list drops every trace of such a task.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !embeddedPostgresSupport.supported) throw new Error("embedded Postgres required on CI");

(embeddedPostgresSupport.supported ? describe : describe.skip)("read state, inbox archive and feedback read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O (owner, a session that is not the local board), U (operator), agents X (O's chat) and Y.
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  const prefix = `R${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", Y = "", chatId = "", privateId = "", openId = "";
  const commentOn: Record<string, string> = {};
  const traceOn: Record<string, string> = {};

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const localBoard = (): RequestActor => ({
    type: "board", userId: "local-board", source: "local_implicit", companyIds: [companyId], isInstanceAdmin: true,
  } as RequestActor);
  const agent = (agentId: string): RequestActor => ({ type: "agent", agentId, companyId, source: "agent_key" });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };
  const vote = (issueId: string) => ({ targetType: "issue_comment", targetId: commentOn[issueId], vote: "up" });

  beforeAll(async () => {
    // Task privacy in its default mode, whatever the shell sets.
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-read-inbox-feedback-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Read guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([...Object.keys(roles), "local-board"].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const noWake = { heartbeat: { enabled: false, wakeOnDemand: false } };
    const [x, y] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
      { companyId, name: "Editor", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
    ]).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId =>
      ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    // O's chat with X through the real chat route, so it is private.
    const opened = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    chatId = opened.body.id;
    expect((await db.select().from(issues).where(eq(issues.id, chatId)))[0]).toMatchObject({ visibility: "private", conversationUserId: O });
    const svc = issueService(db);
    privateId = (await svc.create(companyId, {
      title: "O's private plan", visibility: "private", status: "todo", createdByUserId: O, responsibleUserId: O,
    })).id;
    openId = (await svc.create(companyId, { title: "Open task", status: "todo", assigneeAgentId: X, createdByUserId: O })).id;
    const [openComment] = await db.insert(issueComments).values({ companyId, issueId: openId, authorAgentId: X, body: "Open reply" }).returning();
    commentOn[openId] = openComment!.id;

    // A comment by X on the chat and on P, O's vote on each, so a trace exists.
    for (const issueId of [chatId, privateId]) {
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorAgentId: X, body: "Reply from Writer" }).returning();
      commentOn[issueId] = comment!.id;
      const voted = await request(appFor(user(O))).post(`/api/issues/${issueId}/feedback-votes`).send(vote(issueId));
      expect(voted.status, JSON.stringify(voted.body)).toBe(201);
      const [trace] = await db.select().from(feedbackExports).where(eq(feedbackExports.issueId, issueId));
      traceOn[issueId] = trace!.id;
    }
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const writesBy = async (who: string) => ({
    readStates: await db.select().from(issueReadStates).where(eq(issueReadStates.userId, who)),
    archives: await db.select().from(issueInboxArchives).where(eq(issueInboxArchives.userId, who)),
    votes: await db.select().from(feedbackVotes).where(eq(feedbackVotes.authorUserId, who)),
    exports: await db.select().from(feedbackExports).where(eq(feedbackExports.authorUserId, who)),
    activity: await db.select().from(activityLog).where(eq(activityLog.actorId, who)),
  });
  const nothingWritten = { readStates: [], archives: [], votes: [], exports: [], activity: [] };
  const writeCalls = (issueId: string) => [
    ["post", `/api/issues/${issueId}/read`, {}],
    ["delete", `/api/issues/${issueId}/read`, {}],
    ["post", `/api/issues/${issueId}/inbox-archive`, {}],
    ["delete", `/api/issues/${issueId}/inbox-archive`, {}],
    ["post", `/api/issues/${issueId}/feedback-votes`, vote(issueId)],
  ] as const;
  const readCalls = (issueId: string) => [
    `/api/issues/${issueId}/feedback-votes`,
    `/api/issues/${issueId}/feedback-traces?includePayload=true`,
  ];
  const traceIds = (body: Array<{ id: string }>) => body.map(trace => trace.id);

  describe("U, who cannot read O's chat or P", () => {
    it("AC-G3: read, inbox-archive and vote writes answer 404 and write nothing", async () => {
      const app = appFor(user(U));
      for (const issueId of [chatId, privateId]) {
        for (const [method, url, body] of writeCalls(issueId)) {
          const res = await request(app)[method](url).send(body);
          expect(res.status, `${method} ${url}`).toBe(404);
          expect(res.body).toEqual({ error: "Issue not found" });
        }
      }
      expect(await writesBy(U)).toEqual(nothingWritten);
    });

    it("AC-G3: feedback votes and traces of the task answer 404", async () => {
      const app = appFor(user(U));
      for (const issueId of [chatId, privateId]) {
        for (const url of readCalls(issueId)) {
          const res = await request(app).get(url);
          expect(res.status, url).toBe(404);
          expect(res.body).toEqual({ error: "Issue not found" });
        }
      }
    });

    it("AC-G3: a trace by id and its bundle answer 404 Feedback trace not found", async () => {
      const app = appFor(user(U));
      for (const traceId of Object.values(traceOn)) {
        for (const url of [`/api/feedback-traces/${traceId}`, `/api/feedback-traces/${traceId}/bundle`]) {
          const res = await request(app).get(url);
          expect(res.status, url).toBe(404);
          expect(res.body).toEqual({ error: "Feedback trace not found" });
        }
      }
    });

    it("AC-G3: the company traces list returns no trace of a task U cannot read", async () => {
      const app = appFor(user(U));
      const all = await request(app).get(`/api/companies/${companyId}/feedback-traces?includePayload=true`);
      expect(all.status).toBe(200);
      for (const traceId of Object.values(traceOn)) expect(traceIds(all.body)).not.toContain(traceId);
      expect(JSON.stringify(all.body)).not.toContain("O's private plan");
      const one = await request(app).get(`/api/companies/${companyId}/feedback-traces?issueId=${privateId}`);
      expect(one.status).toBe(200);
      expect(one.body).toEqual([]);
    });
  });

  describe("callers who can read keep today's answers", () => {
    it("O on his own chat and P: every route answers as before", async () => {
      const app = appFor(user(O));
      for (const issueId of [chatId, privateId]) {
        for (const [method, url, body] of writeCalls(issueId)) {
          const res = await request(app)[method](url).send(body);
          expect(res.status, `${method} ${url}: ${JSON.stringify(res.body)}`).toBe(url.endsWith("feedback-votes") ? 201 : 200);
        }
        const votes = await request(app).get(`/api/issues/${issueId}/feedback-votes`);
        expect(votes.status).toBe(200);
        expect(votes.body).toHaveLength(1);
        const traces = await request(app).get(`/api/issues/${issueId}/feedback-traces?includePayload=true`);
        expect(traces.status).toBe(200);
        expect(traceIds(traces.body)).toEqual([traceOn[issueId]]);
        expect((await request(app).get(`/api/feedback-traces/${traceOn[issueId]}`)).status).toBe(200);
        expect((await request(app).get(`/api/feedback-traces/${traceOn[issueId]}/bundle`)).status).toBe(200);
      }
      const all = await request(app).get(`/api/companies/${companyId}/feedback-traces?includePayload=true`);
      expect(all.status).toBe(200);
      expect(traceIds(all.body)).toEqual(expect.arrayContaining(Object.values(traceOn)));
      const one = await request(app).get(`/api/companies/${companyId}/feedback-traces?issueId=${privateId}`);
      expect(traceIds(one.body)).toEqual([traceOn[privateId]]);
    });

    it("the local board on P: every route answers as before", async () => {
      const app = appFor(localBoard());
      for (const [method, url, body] of writeCalls(privateId)) {
        const res = await request(app)[method](url).send(body);
        expect(res.status, `${method} ${url}: ${JSON.stringify(res.body)}`).toBe(url.endsWith("feedback-votes") ? 201 : 200);
      }
      for (const url of readCalls(privateId)) expect((await request(app).get(url)).status, url).toBe(200);
      expect((await request(app).get(`/api/feedback-traces/${traceOn[privateId]}`)).status).toBe(200);
      expect((await request(app).get(`/api/feedback-traces/${traceOn[privateId]}/bundle`)).status).toBe(200);
      const all = await request(app).get(`/api/companies/${companyId}/feedback-traces`);
      expect(traceIds(all.body)).toEqual(expect.arrayContaining([traceOn[privateId]]));
    });
  });

  describe("agents", () => {
    it("AC-G3: an agent that is not X gets 404 on inbox-archive for O's chat", async () => {
      const app = appFor(agent(Y));
      for (const method of ["post", "delete"] as const) {
        const res = await request(app)[method](`/api/issues/${chatId}/inbox-archive`).send({});
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Issue not found" });
      }
      const archived = await db.select().from(issueInboxArchives).where(and(
        eq(issueInboxArchives.issueId, chatId), inArray(issueInboxArchives.archivedByAgentId, [Y]),
      ));
      expect(archived).toEqual([]);
    });

    it("X on an open task it can read: the board-only routes still answer 403", async () => {
      const app = appFor(agent(X));
      for (const [method, url, body] of writeCalls(openId).filter(([, url]) => !url.endsWith("inbox-archive"))) {
        expect((await request(app)[method](url).send(body)).status, `${method} ${url}`).toBe(403);
      }
      for (const url of readCalls(openId)) expect((await request(app).get(url)).status, url).toBe(403);
    });

    it("X on an open task it can read: inbox-archive keeps its target answer", async () => {
      const res = await request(appFor(agent(X))).post(`/api/issues/${openId}/inbox-archive`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ code: "inbox_target_user_unresolved" });
    });
  });
});
