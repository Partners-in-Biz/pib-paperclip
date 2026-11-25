import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  issueAccessGrants,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { authorizationService, canActorReadChat, type AuthorizationActor } from "../services/authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12841 (chat privacy CP-2a-2): the chat rule in single reads, writes and
 * the snapshot path (PAR-12774 plan 4.2, places 2 and 3). A's chat with X is
 * seeded `open`, as every live chat is today (plan P6), so only the chat rule
 * protects it. AC-P2, AC-P4, AC-P5, AC-P6 (single reads), AC-P8 (seeded grant).
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent chat rule in single reads database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat rule in single reads, writes and the snapshot path", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // A (operator, has the chat), B (operator), O (owner), D (admin), I (owner and instance admin).
  const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
  const D = `d-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [A]: "operator", [B]: "operator", [O]: "owner", [D]: "admin", [I]: "owner" };
  const prefix = `P${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "";
  let X = "", Y = "";
  let chatId = "";
  let taskId = "";
  const runs: Record<"xForA" | "xForB" | "yForA", string> = { xForA: "", xForB: "", yForA: "" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-rule-reads-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Chat reads", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    await db.insert(instanceUserRoles).values({ userId: I, role: "instance_admin" });
    // No wake on demand: the chat message route queues no real run here.
    const noWake = { heartbeat: { enabled: false, wakeOnDemand: false } };
    const [x, y] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
      { companyId, name: "Editor", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
    ]).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId =>
      ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    const [chat, task] = await db.insert(issues).values([
      { companyId, title: "Chat with Writer", status: "in_progress", visibility: "open", issueNumber: 1, identifier: `${prefix}-1`,
        conversationAgentId: X, conversationUserId: A, conversationState: "waiting", assigneeAgentId: X,
        createdByUserId: A, responsibleUserId: A },
      { companyId, title: "Open task", status: "todo", issueNumber: 2, identifier: `${prefix}-2`, createdByUserId: O },
    ]).returning();
    chatId = chat!.id; taskId = task!.id;
    await db.insert(issueComments).values({ companyId, issueId: chatId, authorUserId: A, body: "First message" });
    const runRow = (agentId: string, responsibleUserId: string) =>
      ({ companyId, agentId, status: "running", responsibleUserId,
        contextSnapshot: { issueId: chatId, taskId: chatId, conversationSessionGeneration: chat!.conversationSessionGeneration } });
    const [r1, r2, r3] = await db.insert(heartbeatRuns).values([runRow(X, A), runRow(X, B), runRow(Y, A)]).returning();
    runs.xForA = r1!.id; runs.xForB = r2!.id; runs.yForA = r3!.id;
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: userId === I,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const agent = (agentId: string, runId: string, onBehalfOfUserId: string): RequestActor =>
    ({ type: "agent", agentId, companyId, runId, source: "agent_jwt", onBehalfOfUserId,
      onBehalfOfMemberships: [{ companyId, membershipRole: roles[onBehalfOfUserId], status: "active", restricted: false, restrictionMode: "off" }] });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", activityRoutes(db));
    app.use(errorHandler);
    return app;
  };
  const others = () => [B, O, D, I];
  const readPaths = () => [
    `/api/issues/${chatId}`, `/api/issues/${prefix}-1`, `/api/issues/${chatId}/comments`,
    `/api/issues/${chatId}/documents`, `/api/issues/${chatId}/attachments`, `/api/issues/${chatId}/runs`,
  ];
  const expectNoRead = async (actor: RequestActor) => {
    for (const path of readPaths()) {
      const res = await request(appFor(actor)).get(path);
      expect(res.status, `${actor.userId ?? actor.agentId} GET ${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
  };
  const chatRow = () => db.select().from(issues).where(eq(issues.id, chatId)).then(rows => rows[0]!);
  const commentCount = () => db.select({ id: issueComments.id }).from(issueComments)
    .where(eq(issueComments.issueId, chatId)).then(rows => rows.length);
  const expectNoWrite = async (actor: RequestActor) => {
    const app = appFor(actor);
    const before = await commentCount();
    const who = actor.userId ?? actor.agentId;
    const comment = await request(app).post(`/api/issues/${chatId}/comments`).send({ body: "Let me in", clientRequestId: randomUUID() });
    expect(comment.status, `${who} comment`).toBeGreaterThanOrEqual(400);
    const change = await request(app).patch(`/api/issues/${chatId}`).send({ title: "Renamed" });
    expect(change.status, `${who} change`).toBeGreaterThanOrEqual(400);
    const checkout = await request(app).post(`/api/issues/${chatId}/checkout`).send({ agentId: X, expectedStatuses: ["in_progress"] });
    expect(checkout.status, `${who} checkout: ${JSON.stringify(checkout.body)}`).toBe(404);
    expect(await commentCount()).toBe(before);
    expect(await chatRow()).toMatchObject({ title: "Chat with Writer", checkoutRunId: null });
  };
  const decideRead = (actor: AuthorizationActor, issueId = chatId) =>
    authorizationService(db).decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId } });

  it("AC-P2: B, O, D and I get not found for A's chat by id, number, messages, documents, attachments and runs", async () => {
    for (const person of others()) await expectNoRead(user(person));
    // The open task beside it stays readable.
    expect((await request(appFor(user(B))).get(`/api/issues/${taskId}`)).status).toBe(200);
  });

  it("AC-P2: none of B, O, D and I can comment on A's chat, change it or check it out", async () => {
    for (const person of others()) await expectNoWrite(user(person));
  });

  it("the denial is deny_issue_private for the owner and the instance admin, so break-glass still applies", async () => {
    for (const person of [O, D, I]) {
      expect(await decideRead({ type: "board", userId: person, source: "session" })).toMatchObject({ allowed: false, reason: "deny_issue_private" });
    }
    expect(await decideRead({ type: "board", userId: I, source: "session", isInstanceAdmin: true }))
      .toMatchObject({ allowed: false, reason: "deny_issue_private" });
  });

  it("AC-P4: A reads the chat, sends a message, X's run replies in it, A sees the reply", async () => {
    const app = appFor(user(A));
    expect((await request(app).get(`/api/issues/${chatId}`)).status).toBe(200);
    const sent = await request(app).post(`/api/issues/${chatId}/comments`).send({ body: "Hello Writer", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const reply = await request(appFor(agent(X, runs.xForA, A))).post(`/api/issues/${chatId}/comments`).send({ body: "Hello A" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const thread = await request(app).get(`/api/issues/${chatId}/comments`);
    expect(thread.status).toBe(200);
    const bodies = (Array.isArray(thread.body) ? thread.body : thread.body.comments).map((c: { body: string }) => c.body);
    expect(bodies).toEqual(expect.arrayContaining(["Hello Writer", "Hello A"]));
  });

  it("AC-P5: Y gets not found by id; X on a run that works for B gets not found", async () => {
    expect((await request(appFor(agent(Y, runs.yForA, A))).get(`/api/issues/${chatId}`)).status).toBe(404);
    expect((await request(appFor(agent(X, runs.xForB, B))).get(`/api/issues/${chatId}`)).status).toBe(404);
    await expectNoWrite(agent(X, runs.xForB, B));
    expect(await decideRead({ type: "agent", agentId: X, companyId, onBehalfOfUserId: A, authorizingUserId: B }))
      .toMatchObject({ allowed: false });
  });

  it("AC-P5: a plugin host read returns nothing for the chat, in either mode", async () => {
    const host = buildHostServices(db, "chat-rule-plugin", "chat-rule", createPluginEventBus());
    try {
      expect(await host.issues.get({ companyId, issueId: chatId })).toBeNull();
      expect(await host.issues.get({ companyId, issueId: taskId })).toMatchObject({ id: taskId });
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      expect(await host.issues.get({ companyId, issueId: chatId })).toBeNull();
    } finally {
      host.dispose();
    }
  });

  it("AC-P6: with PAPERCLIP_ISSUE_PRIVACY_MODE=off (and shadow), AC-P2 still holds", async () => {
    for (const mode of ["off", "shadow"]) {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", mode);
      for (const person of others()) await expectNoRead(user(person));
      for (const person of others()) await expectNoWrite(user(person));
      expect((await request(appFor(user(A))).get(`/api/issues/${chatId}`)).status).toBe(200);
    }
  });

  it("AC-P8: a seeded grant on A's chat for B does not let B read it by id, in either mode", async () => {
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: chatId, subjectType: "user", subjectId: B, source: "explicit" }).returning();
    try {
      expect((await request(appFor(user(B))).get(`/api/issues/${chatId}`)).status).toBe(404);
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      expect((await request(appFor(user(B))).get(`/api/issues/${chatId}`)).status).toBe(404);
    } finally {
      await db.delete(issueAccessGrants).where(and(eq(issueAccessGrants.id, grant!.id)));
    }
  });

  it("decideReads: readable is false for a chat the actor may not read, true for its person and its agent", async () => {
    const resource = { type: "issue" as const, companyId, issueId: chatId };
    const svc = authorizationService(db);
    const [[forA], [forB], [forI], [forX], [forXB]] = await svc.decideReadsForActors([
      { type: "board", userId: A, source: "session" },
      { type: "board", userId: B, source: "session" },
      { type: "board", userId: I, source: "session", isInstanceAdmin: true },
      { type: "agent", agentId: X, companyId, onBehalfOfUserId: A },
      { type: "agent", agentId: X, companyId, onBehalfOfUserId: B },
    ], [resource]);
    expect(forA).toMatchObject({ allowed: true });
    expect(forB).toMatchObject({ allowed: false, reason: "deny_issue_private" });
    expect(forI).toMatchObject({ allowed: false, reason: "deny_issue_private" });
    expect(forX).toMatchObject({ allowed: true });
    expect(forXB).toMatchObject({ allowed: false, reason: "deny_issue_private" });
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    expect((await svc.decideReads({ type: "board", userId: O, source: "session" }, [resource]))[0]).toMatchObject({ allowed: false });
  });

  it("the local board reads and changes the chat as before", async () => {
    const local: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
    expect((await request(appFor(local)).get(`/api/issues/${chatId}`)).status).toBe(200);
    expect(await decideRead({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }))
      .toMatchObject({ allowed: true, reason: "allow_local_board" });
  });

  it("canActorReadChat follows the 4.2 table", async () => {
    const chat = { id: chatId, companyId };
    const cases: [AuthorizationActor, boolean][] = [
      [{ type: "board", userId: A, source: "session" }, true],
      [{ type: "board", userId: I, source: "session", isInstanceAdmin: true }, false],
      [{ type: "board", userId: "local-board", source: "local_implicit" }, true],
      [{ type: "agent", agentId: X, companyId }, true],
      [{ type: "agent", agentId: X, companyId, onBehalfOfUserId: A, authorizingUserId: A }, true],
      [{ type: "agent", agentId: X, companyId, onBehalfOfUserId: A, authorizingUserId: B }, false],
      [{ type: "agent", agentId: Y, companyId, onBehalfOfUserId: A }, false],
      [{ type: "none" }, false],
    ];
    for (const [actor, expected] of cases) expect(await canActorReadChat(db, actor, chat), JSON.stringify(actor)).toBe(expected);
    expect(await canActorReadChat(db, { type: "none" }, { id: taskId, companyId })).toBe(true);
  });
});
