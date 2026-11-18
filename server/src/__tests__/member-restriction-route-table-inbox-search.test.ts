import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, approvals, authUsers, companies, companyMemberships, createDb, heartbeatRuns, inboxDismissals,
  invites, issueComments, issues, joinRequests, principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { inboxDismissalRoutes } from "../routes/inbox-dismissals.js";
import { issueRoutes } from "../routes/issues.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { publishLiveEvent } from "../services/live-events.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13026 (C4d-3): the inbox, search, sidebar-count and inbox-dismissal rows
 * of the route table, the closed attention rows, and the live socket's run
 * events. Spec PAR-12608 rev 3, 4.6 and 4.6a row 17. AC-G3: for every `open`
 * row R (restricted in Y) asks for O's object and gets "not found" or a list
 * without it; a control call reaches it (the kill switch on, or O himself for
 * the per-person dismissal rows). Scope callers (section 8): R as owner of X,
 * and an instance admin who is no member of Y, get today's answer. AC-G7 for
 * the sidebar counts, AC-G1 for the closed rows, AC-G5 / AC-F8 / AC-X1 for
 * the socket and the new resolver caller (the sidebar join-request count).
 */

// AC-X1: the resolver made to throw, for every reader.
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
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-inbox-search.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("inbox, search and sidebar route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Client = ReturnType<typeof request>;
/** The object asked for: O's task in Y, or R's own task in X; `owner` owns the dismissal rows. */
type Target = { company: string; task: string; owner: string };
type Ctx = { client: Client; target: Target; dismiss: (userId: string) => Promise<string>; dismissed: (userId: string, key: string) => Promise<boolean> };
type Case = {
  row: string;
  send: (ctx: Ctx) => Promise<Res>;
  /** Whether the answer holds or touched the target object. */
  reaches: (res: Res, ctx: Ctx) => boolean | Promise<boolean>;
  /** Per-person rows: the control call is the owner himself, in any mode. */
  controlIsOwner?: true;
};

let lastKey = "";
const has = (res: Res, id: string) => JSON.stringify(res.body).includes(id);
const issueCase = (method: "post" | "delete", suffix: string): Case => ({
  row: `${method.toUpperCase()} /api/issues/:id/${suffix}`,
  send: ({ client, target }) => client[method](`/api/issues/${target.task}/${suffix}`).send({}),
  reaches: (res) => res.status < 300,
});

const CASES: Case[] = [
  { row: "GET /api/companies/:companyId/inbox/mine",
    send: ({ client, target }) => client.get(`/api/companies/${target.company}/inbox/mine`), reaches: (res, { target }) => has(res, target.task) },
  { row: "GET /api/companies/:companyId/sidebar-badges",
    send: ({ client, target }) => client.get(`/api/companies/${target.company}/sidebar-badges`),
    reaches: (res, { target }) => res.body.failedRuns > 1 || res.body.approvals > 1 || res.body.joinRequests > 0
      || res.body.unreadIssueIds?.includes(target.task) },
  { row: "GET /api/companies/:companyId/search",
    send: ({ client, target }) => client.get(`/api/companies/${target.company}/search?q=needle`), reaches: (res, { target }) => has(res, target.task) },
  { row: "GET /api/companies/:companyId/search/extract",
    send: ({ client, target }) => client.get(`/api/companies/${target.company}/search/extract?contains=needle`),
    reaches: (res, { target }) => has(res, target.task) },
  issueCase("post", "read"),
  issueCase("delete", "read"),
  issueCase("post", "inbox-archive"),
  issueCase("delete", "inbox-archive"),
  { row: "GET /api/companies/:companyId/inbox-dismissals", controlIsOwner: true,
    send: async ({ client, target, dismiss }) => { lastKey = await dismiss(target.owner); return client.get(`/api/companies/${target.company}/inbox-dismissals`); },
    reaches: (res) => has(res, lastKey) },
  { row: "POST /api/companies/:companyId/inbox-dismissals", controlIsOwner: true,
    send: async ({ client, target, dismiss }) => {
      lastKey = await dismiss(target.owner);
      return client.post(`/api/companies/${target.company}/inbox-dismissals`).send({ itemKey: lastKey });
    },
    reaches: (res, { target }) => res.body.userId === target.owner },
  { row: "DELETE /api/companies/:companyId/inbox-dismissals/:itemKey", controlIsOwner: true,
    send: async ({ client, target, dismiss }) => {
      lastKey = await dismiss(target.owner);
      return client.delete(`/api/companies/${target.company}/inbox-dismissals/${encodeURIComponent(lastKey)}`);
    },
    reaches: async (_res, { target, dismissed }) => !(await dismissed(target.owner, lastKey)) },
];

/** The closed rows this ticket wrote (AC-G1): the company's decision queue. */
const CLOSED_ROWS = [
  "GET /api/companies/:companyId/attention",
  "GET /api/companies/:companyId/attention/summary",
  "GET /api/companies/:companyId/attention/tasks",
  "GET /api/companies/:companyId/attention/history",
];

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE).map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

it("AC-G1: the attention rows classify as closed for their real paths", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe("closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry!.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("inbox, search, sidebar and live socket rows (PAR-12608 4.6, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  const id: Record<string, string> = {};

  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  const ctx = async (who: Actor, target: Target): Promise<Ctx> => ({
    client: (actor = who, request(app)),
    target,
    dismiss: async (userId) => {
      const key = `run:${randomUUID()}`;
      await db.insert(inboxDismissals).values({ companyId: target.company, userId, itemKey: key });
      return key;
    },
    dismissed: async (userId, key) => (await db.select({ id: inboxDismissals.id }).from(inboxDismissals).where(and(
      eq(inboxDismissals.companyId, target.company), eq(inboxDismissals.userId, userId), eq(inboxDismissals.itemKey, key)))).length > 0,
  });
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try { return await send(); } finally { vi.unstubAllEnvs(); }
  };
  const inY = (): Target => ({ company: Y, task: id.otherY, owner: O });
  const inX = (): Target => ({ company: X, task: id.taskX, owner: R });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-inbox-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use("/api", sidebarBadgeRoutes(db));
    app.use("/api", inboxDismissalRoutes(db));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    const members = [
      { companyId: Y, principalId: O, membershipRole: "owner" as const },
      { companyId: Y, principalId: R, membershipRole: "operator" as const, restricted: true },
      { companyId: X, principalId: R, membershipRole: "owner" as const },
    ];
    for (const { restricted, ...member } of members) {
      await db.insert(companyMemberships).values({ ...member, principalType: "user", status: "active", restricted: restricted ?? false });
      await ensureHumanRoleDefaultGrants(db, { ...member, grantedByUserId: null });
    }
    // An explicit join-approval grant, so the sidebar's join count has something to hide (AC-G7).
    await db.insert(principalPermissionGrants).values({ companyId: Y, principalType: "user", principalId: R, permissionKey: "joins:approve" });
    const [invite] = await db.insert(invites).values({ companyId: Y, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 86_400_000) }).returning();
    await db.insert(joinRequests).values({ inviteId: invite!.id, companyId: Y, requestType: "human", requestIp: "127.0.0.1" });

    const [agentY1, agentY2, agentY3] = await db.insert(agents).values([1, 2, 3].map((n) => ({
      companyId: Y, name: `Agent ${n}`, adapterType: "process", status: "active",
    }))).returning();
    id.agentY = agentY3!.id;
    const [mineY, otherY, taskX] = await db.insert(issues).values([
      { companyId: Y, title: "Needle mine", status: "todo", createdByUserId: R, responsibleUserId: R },
      { companyId: Y, title: "Needle other", status: "todo", createdByUserId: O, responsibleUserId: O },
      { companyId: X, title: "Needle x", status: "todo", createdByUserId: R, responsibleUserId: R },
    ]).returning();
    Object.assign(id, { mineY: mineY!.id, otherY: otherY!.id, taskX: taskX!.id });
    // R touched O's task, then O commented: in R's inbox and unread when he may read it.
    await db.insert(activityLog).values({
      companyId: Y, actorType: "user", actorId: R, action: "issue.assigned", entityType: "issue", entityId: id.otherY,
      createdAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(issueComments).values({ companyId: Y, issueId: id.otherY, authorUserId: O, body: "update" });
    await db.insert(heartbeatRuns).values([
      { companyId: Y, agentId: agentY1!.id, scopeKind: "issue", issueId: id.mineY, status: "failed", responsibleUserId: R },
      { companyId: Y, agentId: agentY2!.id, scopeKind: "issue", issueId: id.otherY, status: "failed", responsibleUserId: R },
    ]);
    await db.insert(approvals).values([id.mineY, id.otherY].map((issueId) => ({
      companyId: Y, type: "hire_agent", status: "pending", payload: { issueId },
    })));
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3: R (restricted in Y) asking for O's object gets \"not found\" or an answer without it", async () => {
      const call = async (who: string) => { const c = await ctx(await boardFor(who), inY()); return { res: await entry.send(c), c }; };
      const enforced = await call(R);
      if (enforced.res.status === 404) expect(enforced.res.body).toEqual({ error: "Issue not found" });
      else expect(enforced.res.status, JSON.stringify(enforced.res.body)).toBeLessThan(300);
      expect(await entry.reaches(enforced.res, enforced.c), JSON.stringify(enforced.res.body)).toBe(false);
      // Control: the same call reaches O's object, so the answer above is the restriction.
      const control = entry.controlIsOwner ? await call(O) : await today(() => call(R));
      expect(control.res.status, JSON.stringify(control.res.body)).toBeLessThan(300);
      expect(await entry.reaches(control.res, control.c), JSON.stringify(control.res.body)).toBe(true);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const status = async (who: () => Promise<Actor>, target: Target) => (await entry.send(await ctx(await who(), target))).status;
      const ownX = () => status(() => boardFor(R), inX());
      const ownXNow = await ownX();
      expect(ownXNow).toBeLessThan(300);
      expect(ownXNow).toBe(await today(ownX));
      const admin = () => status(() => boardFor(ADMIN, true), inY());
      expect(await admin()).toBe(await today(admin));
    });
  });

  describe("sidebar counts (AC-G7)", () => {
    const read = async (path: string) => {
      const res = await (await ctx(await boardFor(R), inY())).client.get(path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    const counts = async () => {
      const [badges, inbox] = [await read(`/api/companies/${Y}/sidebar-badges`), await read(`/api/companies/${Y}/inbox/mine`)];
      const inboxIds = (inbox.issues as Array<{ id: string }>).map((row) => row.id);
      expect(badges.unreadIssueIds.every((issueId: string) => inboxIds.includes(issueId))).toBe(true);
      expect(badges.failedRuns).toBe(new Set(inbox.failureIssueIds).size);
      return badges;
    };

    it("each count equals R's matching list, and the join-request count is 0", async () => {
      expect(await counts()).toMatchObject({ approvals: 1, failedRuns: 1, joinRequests: 0 });
    });

    it("AC-F8: with the kill switch `off`, the counts are as in mode off (join requests counted)", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await counts()).toMatchObject({ approvals: 2, failedRuns: 2, joinRequests: 1 });
    });

    it("AC-X1: when the restriction cannot be read, 503 MEMBER_RESTRICTION_UNAVAILABLE and no counts", async () => {
      resolverFails.on = true;
      const res = await (await ctx(await boardFor(R), inY())).client.get(`/api/companies/${Y}/sidebar-badges`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(res.body).not.toHaveProperty("approvals");
    });
  });

  describe("live socket run events (4.6a row 17, AC-G5)", () => {
    const runs: Record<string, string> = {};
    beforeAll(async () => {
      const values = [
        ["hisOnHis", id.mineY, R], ["othersOnHis", id.mineY, O], ["hisOnOthers", id.otherY, R],
      ] as const;
      for (const [name, issueId, responsibleUserId] of values) {
        const [run] = await db.insert(heartbeatRuns).values({
          companyId: Y, agentId: id.agentY, scopeKind: "issue", issueId, status: "running", responsibleUserId,
        }).returning();
        runs[name] = run!.id;
      }
    });

    async function receivedRuns() {
      const server = createServer();
      const wss = setupLiveEventsWebSocketServer(server, db, {
        deploymentMode: "authenticated",
        resolveSessionFromHeaders: async () => ({ user: { id: R } }) as never,
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${Y}/events/ws`);
      const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
      socket.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
      try {
        await once(socket, "open");
        for (const runId of Object.values(runs)) {
          publishLiveEvent({ companyId: Y, type: "heartbeat.run.log", payload: { runId, chunk: "log line" } });
        }
        const barrier = randomUUID();
        publishLiveEvent({ companyId: Y, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
        await expect.poll(() => messages.some((message) => message.payload.agentId === barrier)).toBe(true);
        const names = Object.fromEntries(Object.entries(runs).map(([name, runId]) => [runId, name]));
        return messages.filter((message) => message.type === "heartbeat.run.log").map((message) => names[message.payload.runId as string]);
      } finally {
        socket.terminate();
        wss.close();
        server.close();
      }
    }

    it("delivers R's run on R's task, drops O's run on R's task and R's run on O's task", async () => {
      expect(await receivedRuns()).toEqual(["hisOnHis"]);
    });

    it("AC-F8: with the kill switch `off`, delivers every run as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await receivedRuns()).toEqual(["hisOnHis", "othersOnHis", "hisOnOthers"]);
    });

    it("AC-X1: when the resolver throws, delivers no run event", async () => {
      resolverFails.on = true;
      expect(await receivedRuns()).toEqual([]);
    });
  });
});
