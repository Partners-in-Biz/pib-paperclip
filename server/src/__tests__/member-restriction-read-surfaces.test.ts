import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { publishLiveEvent } from "../services/live-events.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12720 (stage C3-2b): the read filter in search, the inbox, the
 * conversation list, sidebar counts and the live-event socket. Spec PAR-12608
 * rev 3, section 4.3: AC-L11 (one test each), plus each consumer's kill-switch
 * (AC-F8) and failing-read (AC-X1) tests.
 */

// AC-X1: the resolver made to throw. Both readers fail: the one the list
// builders use and the one the single-read decision uses.
const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionEnforcedCompanyIds: (...args: Parameters<typeof actual.memberRestrictionEnforcedCompanyIds>) =>
      resolverFails.on ? fail() : actual.memberRestrictionEnforcedCompanyIds(...args),
  };
});

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("read surfaces database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("member restriction on search, inbox, chats, sidebar and live socket", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let chatCompanyId = "";
  const id: Record<string, string> = {};

  const actorR = (): Express.Request["actor"] => ({
    type: "board", source: "session", userId: R, companyIds: [companyId, chatCompanyId], isInstanceAdmin: false,
    memberships: [companyId, chatCompanyId].map((company) => ({
      companyId: company, membershipRole: "operator", status: "active", restricted: true, restrictionMode: "enforce" as const,
    })),
  });
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actorR(); next(); });
    server.use("/api/companies", companyRoutes(db));
    server.use("/api", issueRoutes(db, {} as never, {}));
    server.use("/api", sidebarBadgeRoutes(db));
    server.use(errorHandler);
    return server;
  };
  const get = async (path: string) => {
    const res = await request(app()).get(path);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-surfaces-");
    db = createDb(tempDb.connectionString);
    const [company, chatCompany] = await db.insert(companies).values([
      { name: "Restricted co", issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Chat co", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    companyId = company!.id;
    chatCompanyId = chatCompany!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((user) => ({ id: user, name: user, email: `${user}@example.test`, createdAt: now, updatedAt: now })));
    for (const company of [companyId, chatCompanyId]) {
      await db.insert(companyMemberships).values([
        { companyId: company, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
        { companyId: company, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      ]);
      await ensureHumanRoleDefaultGrants(db, { companyId: company, principalId: O, membershipRole: "owner", grantedByUserId: null });
      await ensureHumanRoleDefaultGrants(db, { companyId: company, principalId: R, membershipRole: "operator", grantedByUserId: null });
    }
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const agentRows = await db.insert(agents).values([1, 2].map((n) => ({
      companyId, name: `Agent ${n}`, adapterType: "process", status: "active",
    }))).returning();
    const chatAgents = await db.insert(agents).values([1, 2].map((n) => ({
      companyId: chatCompanyId, name: `Chat agent ${n}`, adapterType: "process", status: "active",
    }))).returning();

    // R's own task and O's task, both open and both matching "needle".
    const [mine, others] = await db.insert(issues).values([
      { companyId, title: "Needle mine", status: "todo", createdByUserId: R },
      { companyId, title: "Needle other", status: "todo", createdByUserId: O },
    ]).returning();
    id.mine = mine!.id;
    id.others = others!.id;
    // R touched O's task, then O commented on it: in R's inbox and unread.
    await db.insert(activityLog).values({
      companyId, actorType: "user", actorId: R, action: "issue.assigned", entityType: "issue", entityId: id.others,
      createdAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(issueComments).values({ companyId, issueId: id.others, authorUserId: O, body: "update" });
    // One agent-written document on each task (search artifacts).
    const [docMine, docOthers] = await db.insert(documents).values([
      { companyId, title: "Needle report mine", latestBody: "needle", format: "markdown", createdByAgentId: agentRows[0]!.id },
      { companyId, title: "Needle report other", latestBody: "needle", format: "markdown", createdByAgentId: agentRows[0]!.id },
    ]).returning();
    id.docMine = docMine!.id;
    id.docOthers = docOthers!.id;
    await db.insert(issueDocuments).values([
      { companyId, issueId: id.mine, documentId: id.docMine, key: "report" },
      { companyId, issueId: id.others, documentId: id.docOthers, key: "report" },
    ]);
    // One failed run for R on each task, one pending approval on each task (sidebar counts).
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agentRows[0]!.id, issueId: id.mine, status: "failed", responsibleUserId: R, contextSnapshot: { issueId: id.mine } },
      { companyId, agentId: agentRows[1]!.id, issueId: id.others, status: "failed", responsibleUserId: R, contextSnapshot: { issueId: id.others } },
    ]);
    await db.insert(approvals).values([
      { companyId, type: "hire_agent", status: "pending", payload: { issueId: id.mine } },
      { companyId, type: "hire_agent", status: "pending", payload: { issueId: id.others } },
    ]);
    // Two chats of R: one he opened, one a plugin opened for him under O.
    const [chatMine, chatOthers] = await db.insert(issues).values([
      { companyId: chatCompanyId, title: "Chat mine", status: "in_review", createdByUserId: R, conversationState: "waiting",
        assigneeAgentId: chatAgents[0]!.id, conversationAgentId: chatAgents[0]!.id, conversationUserId: R },
      { companyId: chatCompanyId, title: "Chat other", status: "in_review", createdByUserId: O, conversationState: "waiting",
        assigneeAgentId: chatAgents[1]!.id, conversationAgentId: chatAgents[1]!.id, conversationUserId: R },
    ]).returning();
    id.chatMine = chatMine!.id;
    id.chatOthers = chatOthers!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const search = async () => JSON.stringify(await get(`/api/companies/${companyId}/search?q=needle`));
  const artifacts = async () => JSON.stringify(await get(`/api/companies/${companyId}/artifacts?q=needle`));
  const inbox = async () => {
    const body = await get(`/api/companies/${companyId}/inbox/mine`);
    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
    return { issues: ids(body.issues), context: ids(body.contextIssues), failureIssueIds: body.failureIssueIds as string[] };
  };
  const chats = async () => (await get(`/api/companies/${chatCompanyId}/chats`) as Array<{ id: string }>).map((row) => row.id).sort();
  const badges = async () => get(`/api/companies/${companyId}/sidebar-badges`) as Promise<{
    approvals: number; failedRuns: number; unreadIssueIds: string[];
  }>;

  describe("search (AC-L11)", () => {
    it("R finds his task and its artifact, not O's", async () => {
      for (const body of [await search(), await artifacts()]) {
        expect(body).toContain(id.docMine);
        expect(body).not.toContain(id.others);
        expect(body).not.toContain(id.docOthers);
        expect(body).not.toContain("Needle report other");
      }
      expect(await search()).toContain(id.mine);
    });

    it("AC-F8: with the kill switch `off`, R finds both as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const body = await search();
      for (const value of [id.mine, id.others, id.docMine, id.docOthers]) expect(body).toContain(value);
      expect(await artifacts()).toContain(id.docOthers);
    });
  });

  describe("inbox (AC-L11)", () => {
    it("R's Mine inbox holds his task and his failure, not O's", async () => {
      const result = await inbox();
      expect(result.issues).toContain(id.mine);
      expect([...result.issues, ...result.context, ...result.failureIssueIds]).not.toContain(id.others);
    });

    it("AC-F8: with the kill switch `off`, R's inbox is as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const result = await inbox();
      expect(result.issues).toEqual(expect.arrayContaining([id.mine, id.others]));
      expect(result.failureIssueIds).toContain(id.others);
    });
  });

  describe("conversation list (AC-L11)", () => {
    it("R lists only the chat that is his", async () => {
      expect(await chats()).toEqual([id.chatMine]);
    });

    it("AC-F8: with the kill switch `off`, R lists both chats", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await chats()).toEqual([id.chatMine, id.chatOthers].sort());
    });
  });

  describe("sidebar counts (AC-L11)", () => {
    it("count only R's approval, failed run and unread task", async () => {
      const result = await badges();
      expect(result.approvals).toBe(1);
      expect(result.failedRuns).toBe(1);
      expect(result.unreadIssueIds).not.toContain(id.others);
    });

    it("AC-F8: with the kill switch `off`, count as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const result = await badges();
      expect(result.approvals).toBe(2);
      expect(result.failedRuns).toBe(2);
      expect(result.unreadIssueIds).toContain(id.others);
    });
  });

  describe("failing read (AC-X1)", () => {
    it.each([
      ["search", () => `/api/companies/${companyId}/search?q=needle`],
      ["artifacts", () => `/api/companies/${companyId}/artifacts?q=needle`],
      ["inbox", () => `/api/companies/${companyId}/inbox/mine`],
      ["conversation list", () => `/api/companies/${chatCompanyId}/chats`],
      ["sidebar counts", () => `/api/companies/${companyId}/sidebar-badges`],
    ])("%s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no data", async (_name, path) => {
      resolverFails.on = true;
      const res = await request(app()).get(path());
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toMatch(/Needle|Chat (mine|other)/);
    });
  });

  describe("live socket (AC-L11)", () => {
    async function received() {
      const server = createServer();
      const wss = setupLiveEventsWebSocketServer(server, db, {
        deploymentMode: "authenticated",
        resolveCloudActor: async () => ({ userId: R, companyIds: [companyId] }),
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
      const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
      socket.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
      try {
        await once(socket, "open");
        for (const issueId of [id.mine, id.others]) {
          publishLiveEvent({ companyId, type: "activity.logged", payload: {
            action: "issue.updated", entityType: "issue", entityId: issueId, actorType: "user", actorId: O,
          } });
        }
        const barrier = randomUUID();
        publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
        await expect.poll(() => messages.some((message) => message.payload.agentId === barrier)).toBe(true);
        return messages.filter((message) => message.type === "activity.logged").map((message) => message.payload.entityId);
      } finally {
        socket.terminate();
        wss.close();
        server.close();
      }
    }

    it("delivers to R only the events of tasks R can read", async () => {
      expect(await received()).toEqual([id.mine]);
    });

    it("AC-F8: with the kill switch `off`, delivers both as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await received()).toEqual([id.mine, id.others]);
    });

    it("AC-X1: when the resolver throws, delivers no task event", async () => {
      resolverFails.on = true;
      expect(await received()).toEqual([]);
    });
  });
});
