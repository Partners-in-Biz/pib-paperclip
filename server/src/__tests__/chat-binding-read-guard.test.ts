import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  authUsers,
  chatConversations,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  principalPermissionGrants,
  projects,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import { issueRoutes } from "../routes/issues.js";
import { accessService } from "../services/access.js";
import { chatChannelService, type ChatChannelService } from "../services/chat-channels.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13051 (access C4k-10, PAR-12608 spec 4.6, AC-G3): GET
 * /issues/:issueId/chat-binding reads the task first, and GET
 * /chat-endpoints/:endpointId/conversations omits rows of tasks the caller
 * cannot read. A denied binding read answers the guard's own 404 for an
 * unknown task id; readers keep today's answers.
 */

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_CHAT_BINDING_READ_GUARD_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

const NOT_FOUND = { error: "Connection management resource not found" };

(support.supported ? describe : describe.skip)("task chat binding and endpoint conversations read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let service: ChatChannelService;

  // O owner, A admin (not on P), U operator, V viewer, I instance admin (plain
  // operator of C), M restricted operator at restrictionMode "off".
  const O = `o-${randomUUID()}`, A = `a-${randomUUID()}`, U = `u-${randomUUID()}`;
  const V = `v-${randomUUID()}`, I = `i-${randomUUID()}`, M = `m-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [A]: "admin", [U]: "operator", [V]: "viewer", [I]: "operator", [M]: "operator" };
  let companyId = "", otherCompanyId = "", E = "", X = "", Z = "", N = "";
  let P = "", Q = "", unbound = "", R = "";
  const pUrl = `https://discord.com/channels/guild-1/p-${randomUUID()}`;
  const pConversation = randomUUID(), qConversation = randomUUID();

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: userId === M, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({ ...user(I), isInstanceAdmin: true });
  const localBoard: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  const agent = (agentId: string, onBehalfOfUserId: string | null): RequestActor => ({
    type: "agent", agentId, companyId, source: "agent_jwt", onBehalfOfUserId,
    onBehalfOfMemberships: onBehalfOfUserId ? [{ companyId, membershipRole: roles[onBehalfOfUserId], status: "active" }] : [],
  });
  const appFor = (actor: RequestActor, access?: ReturnType<typeof accessService>) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", chatChannelRoutes(db, { heartbeat: { wakeup: async () => undefined }, service, ...(access ? { access } : {}) }));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };
  const binding = (actor: RequestActor, issueId: string, query = "") =>
    request(appFor(actor)).get(`/api/issues/${issueId}/chat-binding${query}`);
  const conversations = (actor: RequestActor) => request(appFor(actor)).get(`/api/chat-endpoints/${E}/conversations`);
  /** A real accessService whose issue:read decision throws for U only. */
  const failingAccess = () => {
    const real = accessService(db);
    return {
      ...real,
      decide: async (input: Parameters<typeof real.decide>[0]) => {
        if (input.action === "issue:read" && (input.actor as { userId?: string }).userId === U) throw new Error("access decision store unavailable");
        return real.decide(input);
      },
    };
  };
  const ids = (body: Array<{ id: string }>) => body.map(row => row.id);
  let unknownBody: unknown;

  async function endpointFor(company: string, agentId: string) {
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: company, applicationKey: `chat:discord:${endpointId}`, name: "Discord", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: company, applicationId, name: "Discord", uid: `chat-discord-${endpointId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: company, connectionId, provider: "discord", publicId: randomUUID(),
      assignedAgentId: agentId, status: "active", providerAccountId: "guild-1", allowUnlinkedPeople: false });
    return endpointId;
  }

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-binding-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    service = chatChannelService(db, { heartbeat: { wakeup: async () => undefined } });
    const [company] = await db.insert(companies).values({ name: "Binding guard", issuePrefix: `B${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning();
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: `K${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id; otherCompanyId = other!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === M });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const newAgent = async (company: string, name: string) => {
      const [row] = await db.insert(agents).values({ companyId: company, name, role: "engineer", status: "idle", adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
      await db.insert(companyMemberships).values({ companyId: company, principalType: "agent", principalId: row!.id, status: "active", membershipRole: "member" });
      return row!.id;
    };
    X = await newAgent(companyId, "Endpoint agent");
    Z = await newAgent(companyId, "U's agent");
    N = await newAgent(companyId, "Unowned agent");
    const otherAgent = await newAgent(otherCompanyId, "Other agent");
    E = await endpointFor(companyId, X);
    const otherEndpoint = await endpointFor(otherCompanyId, otherAgent);

    // Agents with connection management on C. P sits in an open project and is
    // assigned to X, so the agent path reaches the route's own read check.
    await db.insert(principalPermissionGrants).values([X, Z].map(principalId => ({ companyId, principalType: "agent", principalId, permissionKey: "tools:manage_connections" })));
    const [project] = await db.insert(projects).values({ companyId, name: "Open project", visibility: "open" }).returning();
    const issues = issueService(db);
    P = (await issues.create(companyId, { title: "Private plan", visibility: "private", status: "todo", projectId: project!.id, assigneeAgentId: X, createdByUserId: O, responsibleUserId: O })).id;
    Q = (await issues.create(companyId, { title: "Open task", status: "todo", createdByUserId: O, responsibleUserId: O })).id;
    unbound = (await issues.create(companyId, { title: "No channel", status: "todo", createdByUserId: O, responsibleUserId: O })).id;
    R = (await issues.create(otherCompanyId, { title: "Other company task", status: "todo" })).id;
    await db.insert(chatConversations).values([
      { id: pConversation, companyId, endpointId: E, issueId: P, externalConversationId: "p-channel", externalThreadId: "p-thread", externalLabel: "P thread", providerUrl: pUrl, state: "active" },
      { id: qConversation, companyId, endpointId: E, issueId: Q, externalConversationId: "q-channel", externalThreadId: "q-thread", externalLabel: "Q thread", providerUrl: "https://discord.com/channels/guild-1/q", state: "active" },
      { companyId: otherCompanyId, endpointId: otherEndpoint, issueId: R, externalConversationId: "r-channel", externalLabel: "R thread", state: "active" },
    ]);
  }, 120_000);

  beforeEach(() => { vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  afterAll(async () => {
    await service?.shutdown();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("the fixtures hold: U cannot read P, O can", async () => {
    expect((await request(appFor(user(U))).get(`/api/issues/${P}`)).status).toBe(404);
    expect((await request(appFor(user(O))).get(`/api/issues/${P}`)).status).toBe(200);
  });

  describe("GET /issues/:issueId/chat-binding", () => {
    it("U on an unknown task id gets the guard's 404", async () => {
      const res = await binding(user(U), randomUUID());
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      unknownBody = res.text;
    });

    it.each([["U", U], ["V", V]])("%s on O's private task P gets the same 404, with no binding data", async (_label, userId) => {
      const res = await binding(user(userId), P);
      expect(res.status, res.text).toBe(404);
      expect(res.text).toBe(unknownBody);
      for (const secret of [E, pConversation, pUrl]) expect(res.text).not.toContain(secret);
    });

    it("U on R, a task of another company, gets the same 404", async () => {
      const res = await binding(user(U), R);
      expect(res.status, res.text).toBe(404);
      expect(res.text).toBe(unknownBody);
    });

    it.each([["O", () => user(O)], ["the local board", () => localBoard]])("%s on P gets the binding", async (_label, actor) => {
      const res = await binding(actor(), P);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ endpointId: E, conversationId: pConversation, externalUrl: pUrl });
    });

    it("I, a session instance admin and plain operator of C, on P: pinned 200", async () => {
      const res = await binding(instanceAdmin(), P);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ conversationId: pConversation });
    });

    it("U on the public task Q gets the binding; U on a task with no binding gets null", async () => {
      const q = await binding(user(U), Q);
      expect(q.status, q.text).toBe(200);
      expect(q.body).toMatchObject({ endpointId: E, conversationId: qConversation });
      const none = await binding(user(U), unbound);
      expect(none.status, none.text).toBe(200);
      expect(none.text).toBe("null");
    });

    it("A on P with ?breakGlass=true gets the same 404, with no break-glass activity and no comment", async () => {
      const glass = () => db.select({ n: count() }).from(activityLog).where(and(eq(activityLog.action, "issue.break_glass_read"), eq(activityLog.entityId, P)));
      const comments = () => db.select({ n: count() }).from(issueComments).where(eq(issueComments.issueId, P));
      const before = { glass: (await glass())[0]!.n, comments: (await comments())[0]!.n };
      const res = await binding(user(A), P, "?breakGlass=true");
      expect(res.status, res.text).toBe(404);
      expect(res.text).toBe(unknownBody);
      expect({ glass: (await glass())[0]!.n, comments: (await comments())[0]!.n }).toEqual(before);
    });

    it("agent X (responsible user O, the endpoint's agent) on P: pinned 200", async () => {
      const res = await binding(agent(X, O), P);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ conversationId: pConversation });
    });

    // Observed: the connection guard's own task-privacy check refuses Z before
    // the route's read runs (ticket expected 404; raised with Ada on PAR-13051).
    it("agent Z (responsible user U) on P: the guard's 403, no binding data", async () => {
      const res = await binding(agent(Z, U), P);
      expect(res.status, res.text).toBe(403);
      expect(res.body).toEqual({ error: "Task is unavailable to this delegated principal" });
      for (const secret of [E, pConversation, pUrl]) expect(res.text).not.toContain(secret);
    });

    it.each([["P", () => P], ["an unknown id", () => randomUUID()]])("agent N with no responsible user on %s keeps today's 403", async (_label, id) => {
      const res = await binding(agent(N, null), id());
      expect(res.status, res.text).toBe(403);
      expect(res.body).toEqual({ error: "Connection management requires a responsible user" });
    });

    it("fails closed when the read decision throws: U on P is non-2xx with no binding data", async () => {
      const res = await request(appFor(user(U), failingAccess())).get(`/api/issues/${P}/chat-binding`);
      expect(res.status, res.text).toBe(500);
      for (const secret of [E, pConversation, pUrl]) expect(res.text).not.toContain(secret);
    });
  });

  describe("GET /chat-endpoints/:endpointId/conversations", () => {
    // chat_conversations.issue_id is NOT NULL, so every row names a task.
    it.each([["U", U], ["V", V]])("%s sees Q's row and nothing of P", async (_label, userId) => {
      const res = await conversations(user(userId));
      expect(res.status, res.text).toBe(200);
      expect(ids(res.body)).toEqual([qConversation]);
      for (const secret of [P, pConversation, pUrl, "Private plan", "P thread", "p-channel", "p-thread"]) expect(res.text).not.toContain(secret);
    });

    it.each([["O", () => user(O)], ["the local board", () => localBoard]])("%s sees P's row", async (_label, actor) => {
      const res = await conversations(actor());
      expect(res.status, res.text).toBe(200);
      expect(ids(res.body)).toContain(pConversation);
      expect(res.body.find((row: { id: string }) => row.id === pConversation)).toMatchObject({ issueId: P, issueTitle: "Private plan", externalUrl: pUrl });
    });

    // Observed: Z may not manage X's endpoint, so the guard refuses the whole list.
    it("agent Z (responsible user U) on X's endpoint: the guard's 403, no rows", async () => {
      const res = await conversations(agent(Z, U));
      expect(res.status, res.text).toBe(403);
      expect(res.body).toEqual({ error: "Missing permission: agents:configure or agents:suggest-changes." });
      for (const secret of [P, pConversation, pUrl]) expect(res.text).not.toContain(secret);
    });

    it("agent X (responsible user O): pinned, P's row present", async () => {
      const res = await conversations(agent(X, O));
      expect(res.status, res.text).toBe(200);
      expect(ids(res.body)).toContain(pConversation);
    });

    it("fails closed when a read decision throws: U gets non-2xx and no rows", async () => {
      const res = await request(appFor(user(U), failingAccess())).get(`/api/chat-endpoints/${E}/conversations`);
      expect(res.status, res.text).toBe(500);
      for (const secret of [pConversation, qConversation, pUrl]) expect(res.text).not.toContain(secret);
    });
  });

  describe("today's answers stay", () => {
    it("with PAPERCLIP_ISSUE_PRIVACY_MODE=off U reads P's binding and P's conversation row (kill switch)", async () => {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      const res = await binding(user(U), P);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ conversationId: pConversation, externalUrl: pUrl });
      const list = await conversations(user(U));
      expect(list.status, list.text).toBe(200);
      expect(ids(list.body)).toContain(pConversation);
    });

    it("a restricted member at restrictionMode off on Q: today's answers", async () => {
      const res = await binding(user(M), Q);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({ conversationId: qConversation });
      const list = await conversations(user(M));
      expect(list.status, list.text).toBe(200);
      expect(ids(list.body)).toContain(qConversation);
    });
  });
});
