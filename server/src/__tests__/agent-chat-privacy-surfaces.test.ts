import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentTaskSessions,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  issueComments,
  issues,
  mcpEventDeliveries,
  mcpOauthClients,
  mcpOauthGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { logActivity } from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { publishLiveEvent } from "../services/live-events.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createMcpApiDispatch } from "../services/public-mcp/capabilities.js";
import { createPublicMcpEvents } from "../services/public-mcp/events.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12825 (chat privacy CP-3b): every other surface hides a chat (PAR-12774
 * plan 4.4 rows 2, 3, 5, 5a, 6, 7, 9, 10, 14). Tests only (breakdown F6, F7,
 * F8). A's chat with X is seeded `open`, as every live chat is today (plan
 * P6), so only the chat rule protects it. A chat turn runs through the real
 * routes: A's message, X's reply on its run for A, A's upload, X's document.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent chat privacy surfaces database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat privacy on every other surface", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let storageDir = "";

  // A (operator, has the chat), B (operator), O (owner), D (admin), I (owner and instance admin).
  const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
  const D = `d-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [A]: "operator", [B]: "operator", [O]: "owner", [D]: "admin", [I]: "owner" };
  const others = [B, O, D, I];
  const prefix = `V${randomUUID().slice(0, 5).toUpperCase()}`;
  // Every chat title, message, file and document carries this word; so does the open task.
  const WORD = `Zephyr${randomUUID().slice(0, 6)}`;
  const CHAT_TITLE = `Chat with Writer about ${WORD}`;
  let companyId = "", X = "", Y = "", chatId = "", taskId = "", runForA = "";

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: userId === I,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const agent = (agentId: string, runId?: string, onBehalfOfUserId?: string): RequestActor => ({
    type: "agent", agentId, companyId, runId, source: onBehalfOfUserId ? "agent_jwt" : "agent_key", onBehalfOfUserId,
    ...(onBehalfOfUserId ? { onBehalfOfMemberships: [{ companyId, membershipRole: roles[onBehalfOfUserId], status: "active", restricted: false, restrictionMode: "off" }] } : {}),
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(storageDir))));
    app.use("/api", activityRoutes(db));
    app.use("/api", sidebarBadgeRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  };
  const get = async (actor: RequestActor, url: string) => {
    const res = await request(appFor(actor)).get(url);
    expect(res.status, `${actor.userId ?? actor.agentId} GET ${url}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };
  /** Nothing of A's chat: not its id, title, identifier or any text of the turn. */
  const expectNoChat = (body: unknown, label: string) => {
    const text = JSON.stringify(body);
    for (const value of [chatId, `${prefix}-1"`]) expect(text, label).not.toContain(value);
    expect(text, label).not.toMatch(/Chat with Writer|Hello Writer|Reply from Writer|zephyr-notes|Notes on/);
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-privacy-surfaces-");
    db = createDb(tempDb.connectionString);
    storageDir = await mkdtemp(path.join(tmpdir(), "chat-surfaces-storage-"));
    const [company] = await db.insert(companies).values({ name: "Chat surfaces", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    await db.insert(instanceUserRoles).values({ userId: I, role: "instance_admin" });
    const noWake = { heartbeat: { enabled: false, wakeOnDemand: false } };
    const [x, y] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
      { companyId, name: "Editor", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
    ]).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId =>
      ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    const [chat, task] = await db.insert(issues).values([
      { companyId, title: CHAT_TITLE, status: "in_progress", visibility: "open", issueNumber: 1, identifier: `${prefix}-1`,
        conversationAgentId: X, conversationUserId: A, conversationState: "waiting", assigneeAgentId: X,
        createdByUserId: A, responsibleUserId: A },
      { companyId, title: `${WORD} plan`, status: "todo", issueNumber: 2, identifier: `${prefix}-2`, createdByUserId: O, assigneeAgentId: Y },
    ]).returning();
    chatId = chat!.id; taskId = task!.id;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: X, status: "running", responsibleUserId: A,
      scopeKind: "issue", issueId: chatId,
      contextSnapshot: { issueId: chatId, taskId: chatId, conversationSessionGeneration: chat!.conversationSessionGeneration } }).returning();
    runForA = run!.id;
    // Every person touched the chat before it was private (it sat in their inbox), and the open task.
    await db.insert(activityLog).values([...others, A].flatMap(actorId => [chatId, taskId].map(entityId => ({
      companyId, actorType: "user", actorId, action: "issue.inbox_touched", entityType: "issue", entityId,
      createdAt: new Date(now.getTime() - 3_600_000),
    }))));
    // X answers on the open task after that, so it is unread for everyone (the badge test is not empty).
    await db.insert(issueComments).values({ companyId, issueId: taskId, authorAgentId: X, body: `Open ${WORD} note` });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enablePublicMcp: true });
    await chatTurn(1);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  /** One chat turn through the real routes; each step writes its activity row and live event. */
  async function chatTurn(n: number) {
    const asA = appFor(user(A)), asX = appFor(agent(X, runForA, A));
    const steps = [
      await request(asA).post(`/api/issues/${chatId}/comments`).send({ body: `Hello Writer ${n}, ${WORD}`, clientRequestId: randomUUID() }),
      await request(asX).post(`/api/issues/${chatId}/comments`).send({ body: `Reply from Writer ${n}, ${WORD}` }),
      await request(asA).post(`/api/companies/${companyId}/issues/${chatId}/attachments`)
        .attach("file", Buffer.from(`upload ${WORD}`), `zephyr-notes-${n}.txt`),
      await request(asX).put(`/api/issues/${chatId}/documents/notes-${n}`).send({ title: `Notes on ${WORD}`, format: "markdown", body: `Notes ${WORD}` }),
    ];
    for (const res of steps) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: runForA, agentId: X, status: "running" } });
  }

  /** Every list surface of AC-P3, as one person; returns the bodies by name. */
  async function surfaces(actor: RequestActor) {
    const q = encodeURIComponent(WORD);
    return {
      "task list, search text": await get(actor, `/api/companies/${companyId}/issues?q=${q}`),
      "task list, by ids": await get(actor, `/api/companies/${companyId}/issues?ids=${chatId},${taskId}&view=rows`),
      "company search, tasks": await get(actor, `/api/companies/${companyId}/search?q=${q}`),
      inbox: await get(actor, `/api/companies/${companyId}/inbox/mine`),
      "unread badge": await get(actor, `/api/companies/${companyId}/sidebar-badges`),
      "activity feed": await get(actor, `/api/companies/${companyId}/activity?limit=500`),
      "chat list": await get(actor, `/api/companies/${companyId}/chats`),
    };
  }

  it("F6: every activity row of A's chat turn is entity type issue on the chat (send, reply, upload, document)", async () => {
    const rows = await db.select().from(activityLog);
    const turn = rows.filter(row => row.entityId === chatId && row.action !== "issue.inbox_touched").map(row => [row.entityType, row.action]);
    expect(turn).toEqual(expect.arrayContaining([
      ["issue", "issue.comment_added"], ["issue", "issue.attachment_added"], ["issue", "issue.document_created"],
    ]));
    expect(turn.filter(([, action]) => action === "issue.comment_added")).toHaveLength(2);
    expect(new Set(turn.map(([entityType]) => entityType))).toEqual(new Set(["issue"]));
    // No row of the turn under another entity type names the chat or its text.
    expect(JSON.stringify(rows.filter(row => row.entityType !== "issue"))).not.toMatch(new RegExp(`${chatId}|${WORD}`));
  });

  it("A, the chat's person, gets the chat from the lists (the tests below are not empty)", async () => {
    const found = await surfaces(user(A));
    for (const name of ["task list, search text", "task list, by ids", "company search, tasks", "activity feed", "chat list"] as const) {
      expect(JSON.stringify(found[name]), name).toContain(chatId);
    }
  });

  for (const mode of ["enforce", "off"] as const) {
    it(`AC-P3${mode === "off" ? "/AC-P6 (PAPERCLIP_ISSUE_PRIVACY_MODE=off)" : ""}: B, O, D and I get no trace of A's chat from any list`, async () => {
      if (mode === "off") vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      for (const person of others) {
        const found = await surfaces(user(person));
        for (const [name, body] of Object.entries(found)) expectNoChat(body, `${person} ${mode}: ${name}`);
        // The open task beside it stays listed.
        expect(JSON.stringify(found["task list, search text"]), `${person} ${mode}`).toContain(taskId);
        expect(JSON.stringify(found.inbox), `${person} ${mode}`).toContain(taskId);
        expect(found["chat list"]).toEqual([]);
        expect(found["unread badge"].unreadIssueIds, `${person} ${mode}`).toEqual([taskId]);
      }
    });

    it(`AC-P3${mode === "off" ? "/AC-P6 (mode off)" : ""}: the task count (blocked attention, with search text) counts A's chat for A only`, async () => {
      if (mode === "off") vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      const count = async (actor: RequestActor) =>
        (await get(actor, `/api/companies/${companyId}/issues/count?attention=blocked&q=${encodeURIComponent(WORD)}`)).count;
      await db.update(issues).set({ status: "blocked" }).where(inArray(issues.id, [chatId, taskId]));
      try {
        expect(await count(user(A))).toBe(2);
        for (const person of others) expect(await count(user(person)), `${person} ${mode}`).toBe(1);
      } finally {
        await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, chatId));
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, taskId));
      }
    });

    it(`AC-P3${mode === "off" ? "/AC-P6 (mode off)" : ""}: the live socket of B, O, D and I gets no event of A's chat turn; A's gets them`, async () => {
      if (mode === "off") vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      const server = createServer();
      let socketUser = "";
      const wss = setupLiveEventsWebSocketServer(server, db, {
        deploymentMode: "authenticated", resolveCloudActor: async () => ({ userId: socketUser, companyIds: [companyId] }),
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const received = new Map<string, Array<{ type: string; payload: Record<string, unknown> }>>();
      const sockets: WebSocket[] = [];
      try {
        for (const person of [A, ...others]) {
          socketUser = person;
          const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
          const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
          received.set(person, messages);
          socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
          await once(socket, "open");
          sockets.push(socket);
        }
        await chatTurn(mode === "off" ? 3 : 2);
        const barrier = randomUUID();
        publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
        await expect.poll(() => [...received.values()].every(list => list.some(m => m.payload.agentId === barrier))).toBe(true);
        const ofTurn = (person: string) => received.get(person)!.filter(m => m.payload.agentId !== barrier);
        expect(JSON.stringify(ofTurn(A))).toContain(chatId);
        expect(ofTurn(A).some(m => m.type === "heartbeat.run.status")).toBe(true);
        for (const person of others) expectNoChat(ofTurn(person), `${person} socket ${mode}`);
        for (const person of others) expect(JSON.stringify(ofTurn(person)), `${person} socket ${mode}`).not.toContain(runForA);
      } finally {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.close();
      }
    });
  }

  it("row 9: GET /agents/me/inbox-lite and /agents/me/inbox/mine as Y carry no chat; Y still gets its open task", async () => {
    for (const actor of [agent(Y), agent(Y, undefined, A), agent(Y, undefined, B)]) {
      const lite = await get(actor, "/api/agents/me/inbox-lite");
      expectNoChat(lite, "Y inbox-lite");
      expect(JSON.stringify(lite)).toContain(taskId);
      for (const userId of [A, B]) {
        const mine = await get(actor, `/api/agents/me/inbox/mine?userId=${encodeURIComponent(userId)}`);
        expectNoChat(mine, `Y inbox/mine ${userId}`);
        expect(JSON.stringify(mine), `Y inbox/mine ${userId}`).toContain(taskId);
      }
    }
  });

  it("row 9: GET /agents/:id/task-sessions as B, O, D and I during A's chat turn carries no chat title or text", async () => {
    // The session of the running chat turn; its goal holds A's words, as a runner goal does.
    await db.insert(agentTaskSessions).values({ companyId, agentId: X, adapterType: "process", taskKey: chatId,
      sessionDisplayId: "session-1", sessionParamsJson: { sessionId: "session-1" }, lastRunId: runForA,
      goalJson: { objective: `Hello Writer, ${WORD}`, status: "active" }, goalStatus: "active" });
    for (const person of others) {
      const res = await request(appFor(user(person))).get(`/api/agents/${X}/task-sessions`);
      expect([200, 403], `${person}: ${JSON.stringify(res.body)}`).toContain(res.status);
      expect(JSON.stringify(res.body), person).not.toMatch(new RegExp(`Chat with Writer|Hello Writer|Reply from Writer|${WORD}`));
    }
  });

  it("row 14: B's public MCP subscription on A's chat gets no delivery, and B cannot subscribe; A's own subscription does", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
    const clientId = randomUUID();
    await db.insert(mcpOauthClients).values({ id: clientId, name: "Chat surfaces", redirectUris: ["https://receiver.example/oauth"] });
    const oauth = createPublicMcpOAuth(db, config);
    const principal = async (userId: string) => {
      const [grant] = await db.insert(mcpOauthGrants).values({ companyId, userId, clientId, resource: config.resource, purpose: "personal", scopes: ["paperclip:read"] }).returning();
      return oauth.authorizeGrant(grant!.id);
    };
    const [forA, forB] = [await principal(A), await principal(B)];
    const delivered: string[] = [];
    const fetch = async (url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      delivered.push(new URL(String(url)).host);
      return new Response(null, { status: 204 });
    };
    const live = createPublicMcpEvents(db, oauth, createMcpApiDispatch(issueRoutes(db, {} as never)), { fetch });
    // Made before the chat rule: a dispatch that lets every read through.
    const before = createPublicMcpEvents(db, oauth, async () => ({ id: chatId, companyId }), { fetch });
    const input = (host: string) => ({ name: "paperclip.task.comment_created", arguments: { companyId, taskId: chatId },
      delivery: { mode: "webhook", url: `https://${host}/events`, secret: "whsec_" + randomBytes(32).toString("base64") } });
    try {
      await live.subscribe(forA, input("a.example"));
      await expect(live.subscribe(forB, input("b-new.example"))).rejects.toThrow();
      await before.subscribe(forB, input("b.example"));
      await logActivity(db, { companyId, actorType: "agent", actorId: X, agentId: X, runId: runForA, action: "issue.comment_added",
        entityType: "issue", entityId: chatId, details: { commentId: randomUUID() } });
      await live.tick();
      expect(delivered).toEqual(["a.example"]);
      const outcomes = (await db.select().from(mcpEventDeliveries)).map(row => row.outcome);
      expect(outcomes).toEqual(expect.arrayContaining(["delivered", "authority_unavailable"]));
    } finally {
      await live.stop();
      await before.stop();
    }
  });
});
