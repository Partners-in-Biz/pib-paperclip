import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, boardApiKeys, companies, companyMemberships, createDb, documents, issueDocuments, issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { authRoutes } from "../routes/auth.js";
import { companyRoutes } from "../routes/companies.js";
import { sidebarPreferenceRoutes } from "../routes/sidebar-preferences.js";
import { workspacePreferenceRoutes } from "../routes/workspace-preferences.js";
import { boardAuthService } from "../services/board-auth.js";
import { sidebarPreferenceService } from "../services/sidebar-preferences.js";
import { workspacePreferenceService } from "../services/workspace-preferences.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12733 (C4e-1): the account, session and company-record rows of the
 * route table. Spec PAR-12608 rev 3, 4.6. AC-G3: for every `open` row, R
 * (restricted in Y) asks through that route for O's object (O's key, O's
 * challenge, O's preferences, O's artifact) and gets "not found" or only his
 * own data. Scope callers (section 8): R as owner of X, and an instance admin
 * who is no member of Y, get today's answer. The company record is reduced in
 * Y; it has a kill-switch (AC-F8) and a failing-read (AC-X1) test. AC-G1 for
 * the closed rows is the classifier's answer. No `run` or `by-company` rows.
 */

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
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-account.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("account route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ctx = { R: string; O: string; Y: string; X: string; oKeyId: string; oChallengeId: string; oDocId: string; oTaskId: string; rTaskId: string };
type Case = { row: string; send: (c: ReturnType<typeof request>, ctx: Ctx) => request.Test; mine: (res: Res, ctx: Ctx) => void };

const WRONG_TOKEN = "wrong-token-0123456789abcdef";
/** O's saved sidebar orders: R's answers must never hold them. */
const O_ORDER = [randomUUID(), randomUUID()];
const notFound = (res: Res) => expect(res.status, JSON.stringify(res.body)).toBe(404);
const ok = (res: Res) => expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
const noO = (res: Res, { O, oKeyId }: Ctx) => {
  ok(res);
  expect(JSON.stringify(res.body)).not.toContain(O);
  expect(JSON.stringify(res.body)).not.toContain(oKeyId);
};
const reducedY = (company: Record<string, unknown>) => expect(Object.keys(company).sort()).toEqual(
  ["id", "issuePrefix", "logoAssetId", "logoUrl", "name"],
);

const CASES: Case[] = [
  { row: "GET /api/auth/get-session", send: (c) => c.get("/api/auth/get-session"),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.user.id).toBe(ctx.R); expect(res.body.boardBootstrap).toBeUndefined(); } },
  { row: "GET /api/auth/profile", send: (c) => c.get("/api/auth/profile"), mine: (res, ctx) => { noO(res, ctx); expect(res.body.id).toBe(ctx.R); } },
  { row: "PATCH /api/auth/profile", send: (c) => c.patch("/api/auth/profile").send({ name: "Renamed" }),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.id).toBe(ctx.R); } },
  { row: "POST /api/cli-auth/challenges", send: (c) => c.post("/api/cli-auth/challenges").send({ command: "paperclipai login" }),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.id).not.toBe(ctx.oChallengeId); } },
  { row: "GET /api/cli-auth/challenges/:id", send: (c, ctx) => c.get(`/api/cli-auth/challenges/${ctx.oChallengeId}?token=${WRONG_TOKEN}`), mine: notFound },
  { row: "POST /api/cli-auth/challenges/:id/approve",
    send: (c, ctx) => c.post(`/api/cli-auth/challenges/${ctx.oChallengeId}/approve`).send({ token: WRONG_TOKEN }), mine: notFound },
  { row: "POST /api/cli-auth/challenges/:id/cancel",
    send: (c, ctx) => c.post(`/api/cli-auth/challenges/${ctx.oChallengeId}/cancel`).send({ token: WRONG_TOKEN }), mine: notFound },
  { row: "GET /api/cli-auth/me", send: (c) => c.get("/api/cli-auth/me"), mine: (res, ctx) => { noO(res, ctx); expect(res.body.userId).toBe(ctx.R); } },
  // R's actor names O's key as its own: the key is looked up for R, so "not found".
  { row: "POST /api/cli-auth/revoke-current", send: (c) => c.post("/api/cli-auth/revoke-current").send({}), mine: notFound },
  { row: "GET /api/board-api-keys", send: (c) => c.get("/api/board-api-keys"), mine: noO },
  { row: "POST /api/board-api-keys", send: (c, ctx) => c.post("/api/board-api-keys").send({ name: "cli", requestedCompanyId: ctx.Y }), mine: noO },
  { row: "DELETE /api/board-api-keys/:keyId", send: (c, ctx) => c.delete(`/api/board-api-keys/${ctx.oKeyId}`), mine: notFound },
  { row: "GET /api/sidebar-preferences/me", send: (c) => c.get("/api/sidebar-preferences/me"),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.orderedIds).not.toContain(O_ORDER[0]); } },
  { row: "PUT /api/sidebar-preferences/me", send: (c, ctx) => c.put("/api/sidebar-preferences/me").send({ orderedIds: [ctx.X] }), mine: noO },
  { row: "GET /api/companies/:companyId/sidebar-preferences/me", send: (c, ctx) => c.get(`/api/companies/${ctx.Y}/sidebar-preferences/me`),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.orderedIds).not.toContain(O_ORDER[1]); } },
  { row: "PUT /api/companies/:companyId/sidebar-preferences/me",
    send: (c, ctx) => c.put(`/api/companies/${ctx.Y}/sidebar-preferences/me`).send({ orderedIds: [ctx.X] }), mine: noO },
  { row: "GET /api/workspace-preferences/me", send: (c) => c.get("/api/workspace-preferences/me"),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.userId).toBe(ctx.R); } },
  { row: "PUT /api/companies/:companyId/workspace-preferences/me",
    send: (c, ctx) => c.put(`/api/companies/${ctx.Y}/workspace-preferences/me`).send({ coordinatorWorkspaceEnabled: true }),
    mine: (res, ctx) => { noO(res, ctx); expect(res.body.userId).toBe(ctx.R); } },
  { row: "GET /api/companies", send: (c) => c.get("/api/companies"),
    mine: (res, ctx) => { ok(res); reducedY(res.body.find((row: { id: string }) => row.id === ctx.Y)); } },
  { row: "GET /api/companies/:companyId", send: (c, ctx) => c.get(`/api/companies/${ctx.Y}`), mine: (res) => { ok(res); reducedY(res.body); } },
  { row: "GET /api/companies/:companyId/artifacts", send: (c, ctx) => c.get(`/api/companies/${ctx.Y}/artifacts`),
    mine: (res, ctx) => { ok(res); expect(JSON.stringify(res.body)).not.toContain(ctx.oDocId); } },
];

const CLOSED_ROWS = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.class === "closed" && entry.path.startsWith("/api/companies")
  && !/\/(issues|labels|projects|project-repositories)/.test(entry.path));

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE).map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

it("AC-G1: the closed company rows (changing the company, stats, timeline, export, import) classify as closed", async () => {
  const classify = createRouteClassifier();
  expect(CLOSED_ROWS.map((entry) => `${entry.method} ${entry.path}`)).toEqual(expect.arrayContaining([
    "PATCH /api/companies/:companyId", "GET /api/companies/stats", "GET /api/companies/:companyId/timeline",
  ]));
  for (const entry of CLOSED_ROWS) {
    const sample = entry.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("account, session and company-record rows of the route table (PAR-12608 4.6, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const ctx = { R: `restricted-${randomUUID()}`, O: `owner-${randomUUID()}` } as Ctx;
  const ADMIN = `instance-admin-${randomUUID()}`;

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  // For `revoke-current` the actor claims O's key as its current key.
  const callerFor = async (row: string, userId: string, admin = false) => {
    const who = await boardFor(userId, admin);
    return row === "POST /api/cli-auth/revoke-current" ? { ...who, source: "board_key", keyId: ctx.oKeyId } as Actor : who;
  };
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-account-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api/auth", authRoutes(db));
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", sidebarPreferenceRoutes(db), workspacePreferenceRoutes(db));
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
    }));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce", budgetMonthlyCents: 5000 },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    ctx.Y = y!.id;
    ctx.X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([ctx.O, ctx.R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: ctx.Y, principalType: "user", principalId: ctx.O, status: "active", membershipRole: "owner" },
      { companyId: ctx.Y, principalType: "user", principalId: ctx.R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: ctx.X, principalType: "user", principalId: ctx.R, status: "active", membershipRole: "owner" },
    ]);
    // O's own account data and an artifact on O's task in Y.
    const boardAuth = boardAuthService(db);
    ctx.oKeyId = (await boardAuth.createNamedBoardApiKey({ userId: ctx.O, name: "O's key" })).id;
    ctx.oChallengeId = (await boardAuth.createCliAuthChallenge({ command: "login", requestedAccess: "board" })).challenge.id;
    await sidebarPreferenceService(db).upsertCompanyOrder(ctx.O, [O_ORDER[0]!]);
    await sidebarPreferenceService(db).upsertProjectOrder(ctx.Y, ctx.O, [O_ORDER[1]!]);
    await workspacePreferenceService(db).set(ctx.Y, ctx.O, false);
    const [agent] = await db.insert(agents).values({ companyId: ctx.Y, name: "Agent", adapterType: "process", status: "active" }).returning();
    const [task] = await db.insert(issues).values({
      companyId: ctx.Y, title: "O's task", status: "todo", createdByUserId: ctx.O, responsibleUserId: ctx.O,
    }).returning();
    const [doc] = await db.insert(documents).values({
      companyId: ctx.Y, title: "O's report", latestBody: "o", format: "markdown", createdByAgentId: agent!.id,
    }).returning();
    ctx.oDocId = doc!.id;
    ctx.oTaskId = task!.id;
    // R's readable child under O's unreadable task, with its own artifact: the grouping must not climb to O's task.
    const [child] = await db.insert(issues).values({
      companyId: ctx.Y, parentId: task!.id, title: "R's subtask", status: "todo", createdByUserId: ctx.O, assigneeUserId: ctx.R,
    }).returning();
    ctx.rTaskId = child!.id;
    const [rDoc] = await db.insert(documents).values({
      companyId: ctx.Y, title: "R's notes", latestBody: "r", format: "markdown", createdByAgentId: agent!.id,
    }).returning();
    await db.insert(issueDocuments).values([
      { companyId: ctx.Y, issueId: task!.id, documentId: doc!.id, key: "report" },
      { companyId: ctx.Y, issueId: child!.id, documentId: rDoc!.id, key: "notes" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3: R (restricted in Y) asking for O's object gets \"not found\" or only his own data", async () => {
      entry.mine(await entry.send(as(await callerFor(entry.row, ctx.R)), ctx), ctx);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      for (const [userId, admin] of [[ctx.R, false], [ADMIN, true]] as const) {
        const target = { ...ctx, Y: admin ? ctx.Y : ctx.X };
        const send = async () => entry.send(as(await callerFor(entry.row, userId, admin)), target);
        const now = await send();
        expect(now.status, JSON.stringify(now.body)).toBe((await today(send)).status);
      }
    });
  });

  it("AC-G3: artifacts grouped by task never name O's unreadable parent task, and its id is \"not found\"", async () => {
    const leaks = (res: Res) => {
      ok(res);
      expect(JSON.stringify(res.body)).not.toContain(ctx.oTaskId);
      expect(JSON.stringify(res.body)).not.toContain("O's task");
    };
    const caller = await boardFor(ctx.R);
    const grouped = await as(caller).get(`/api/companies/${ctx.Y}/artifacts?groupBy=parent_task`);
    leaks(grouped);
    expect(grouped.body.groups.map((group: { issue: { id: string } }) => group.issue.id)).toEqual([ctx.rTaskId]);
    for (const groupBy of ["task", "parent_task"]) {
      const selected = await as(caller).get(`/api/companies/${ctx.Y}/artifacts?groupBy=${groupBy}&groupIssueId=${ctx.oTaskId}`);
      leaks(selected);
      expect(selected.body.selectedGroup).toBeNull();
    }
    // Today's answer: with the switch `off` the parent is the group.
    const off = await today(async () => as(caller).get(`/api/companies/${ctx.Y}/artifacts?groupBy=parent_task`));
    expect(off.body.groups.map((group: { issue: { id: string } }) => group.issue.id)).toEqual([ctx.oTaskId]);
  });

  it("the company record in X, and for the admin, is the full record; in Y it is reduced", async () => {
    const own = await as(await boardFor(ctx.R)).get(`/api/companies/${ctx.X}`);
    expect(own.body.budgetMonthlyCents).toBe(0);
    const admin = await as(await boardFor(ADMIN, true)).get("/api/companies");
    expect(admin.body.find((row: { id: string }) => row.id === ctx.Y).budgetMonthlyCents).toBe(5000);
    const list = await as(await boardFor(ctx.R)).get("/api/companies");
    expect(list.body.find((row: { id: string }) => row.id === ctx.X).budgetMonthlyCents).toBe(0);
  });

  it("AC-F8: with the kill switch `off`, R reads Y's full record and the session carries the bootstrap", async () => {
    const [one, list, session] = await today(async () => [
      await as(await boardFor(ctx.R)).get(`/api/companies/${ctx.Y}`),
      await as(await boardFor(ctx.R)).get("/api/companies"),
      await as(await boardFor(ctx.R)).get("/api/auth/get-session"),
    ]);
    expect(one.body.budgetMonthlyCents).toBe(5000);
    expect(list.body.find((row: { id: string }) => row.id === ctx.Y).budgetMonthlyCents).toBe(5000);
    expect(session.body.boardBootstrap?.userId).toBe(ctx.R);
  });

  it.each([["/api/companies"], ["/api/companies/:companyId"]])(
    "AC-X1: %s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no company when the restriction cannot be read",
    async (route) => {
      const caller = await boardFor(ctx.R);
      resolverFails.on = true;
      const res = await as(caller).get(route.replace(":companyId", ctx.Y));
      expect(res.status).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(ctx.Y);
    },
  );
});
