import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issueRelations, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  createRouteClassifier,
} from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12730 (C4b-1a): the task rows of the route table. Spec PAR-12608 rev 3,
 * 4.6. AC-G3: for every `open` and `run` row, R asks for O's task through that
 * route and gets "not found" or a list without it. Scope callers (section 8):
 * an instance admin who is not a member, and R, who is owner in company X and
 * restricted in company Y, both get today's answer (the answer with the kill
 * switch on). AC-G1 for the closed rows is the classifier's answer here; the
 * 403 body is the middleware's (PAR-12922, AC-G2).
 */

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-tasks.test.ts";

/** PAR-13135: fails only the agent-list read (`agent-read.ts`), so the follow-up guard's read is failed on its own. */
const listFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => listFails.on
        ? Promise.reject(new actual.MemberRestrictionReadError("fixture: agent list unreadable"))
        : actual.memberRestrictionFor(db, personId, companyId),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  listFails.on = false;
});

describe("task route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ids = { companyId: string; issueId: string; agentId: string };

/** One request per row. `hidden` says R did not get the task (not found, or absent from the list). */
type Case = {
  row: string;
  caller: "board" | "run";
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
  hidden: (res: Res, ids: Ids) => boolean;
};

const notFound = (res: Res) => res.status === 404;
const listedIds = (res: Res) => (Array.isArray(res.body) ? res.body : (res.body?.issues ?? res.body?.items ?? []))
  .map((row: { id: string }) => row.id);

const CASES: Case[] = [
  { row: "GET /api/companies/:companyId/issues", caller: "board",
    send: (c, { companyId }) => c.get(`/api/companies/${companyId}/issues`),
    hidden: (res, { issueId }) => res.status === 200 && !listedIds(res).includes(issueId) },
  { row: "GET /api/companies/:companyId/issues/summaries", caller: "board",
    send: (c, { companyId, issueId }) => c.get(`/api/companies/${companyId}/issues/summaries?ids=${issueId}`),
    hidden: (res, { issueId }) => res.status === 200 && !listedIds(res).includes(issueId) },
  { row: "GET /api/companies/:companyId/issues/count", caller: "board",
    send: (c, { companyId, issueId }) => c.get(`/api/companies/${companyId}/issues/count?attention=blocked&parentId=${issueId}`),
    hidden: (res) => res.status === 200 && res.body.count === 0 },
  { row: "POST /api/companies/:companyId/issues", caller: "board",
    send: (c, { companyId, issueId }) => c.post(`/api/companies/${companyId}/issues`).send({ title: "Under O", parentId: issueId }),
    hidden: notFound },
  { row: "GET /api/issues/:id", caller: "board", send: (c, { issueId }) => c.get(`/api/issues/${issueId}`), hidden: notFound },
  { row: "PATCH /api/issues/:id", caller: "board",
    send: (c, { issueId }) => c.patch(`/api/issues/${issueId}`).send({ description: "changed" }), hidden: notFound },
  { row: "POST /api/issues/:id/children", caller: "board",
    send: (c, { issueId }) => c.post(`/api/issues/${issueId}/children`).send({ title: "Child" }), hidden: notFound },
  // PAR-12929: the full caller table is in member-restriction-title-route.test.ts.
  { row: "PUT /api/issues/:id/title", caller: "board",
    send: (c, { issueId }) => c.put(`/api/issues/${issueId}/title`).send({ title: "Renamed" }), hidden: notFound },
  { row: "GET /api/issues/:id/external-objects", caller: "board",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/external-objects`), hidden: notFound },
  { row: "GET /api/issues/:id/external-object-summary", caller: "board",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/external-object-summary`), hidden: notFound },
  { row: "GET /api/issues/:id/heartbeat-context", caller: "run",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/heartbeat-context`), hidden: notFound },
  { row: "GET /api/issues/:id/runner-goal", caller: "run",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/runner-goal`), hidden: notFound },
  { row: "POST /api/issues/:id/checkout", caller: "run",
    send: (c, { issueId, agentId }) => c.post(`/api/issues/${issueId}/checkout`).send({ agentId, expectedStatuses: ["todo"] }),
    hidden: notFound },
  { row: "POST /api/issues/:id/release", caller: "run",
    send: (c, { issueId }) => c.post(`/api/issues/${issueId}/release`), hidden: notFound },
];

it("every open and run row of this file has exactly one case, and each case is a row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE
    .filter((entry) => entry.test === THIS_FILE)
    .map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    const row = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!;
    expect(row.class, entry.row).toBe(entry.caller === "run" ? "run" : "open");
  }
});

it("AC-G1: the closed task rows classify as closed for their real paths", async () => {
  const classify = createRouteClassifier();
  const closed = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.class === "closed");
  expect(closed.length).toBeGreaterThan(0);
  for (const entry of closed) {
    const sample = entry.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("task rows of the route table (PAR-12608 4.6, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  let agentY = "";
  let agentX = "";

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
  const runFor = async (userId: string, companyId: string, agentId: string): Promise<Actor> => ({
    type: "agent", companyId, agentId, source: "agent_key", onBehalfOfUserId: userId,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId, activeOnly: true }),
  }) as Actor;
  /** A fresh task per request, so a write that goes through cannot change the next case. */
  const freshTask = async (companyId: string, owner: string) => {
    const [task] = await db.insert(issues).values({
      companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo", createdByUserId: owner, responsibleUserId: owner,
    }).returning();
    const [child] = await db.insert(issues).values({
      companyId, title: "Blocked child", status: "blocked", parentId: task!.id, createdByUserId: owner, responsibleUserId: owner,
    }).returning();
    return { issueId: task!.id, childId: child!.id };
  };
  const callerFor = async (entry: Case, userId: string, companyId: string, agentId: string, isInstanceAdmin = false) =>
    entry.caller === "run" ? runFor(userId, companyId, agentId) : boardFor(userId, isInstanceAdmin);
  /** The same request with the kill switch on: today's answer. */
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-tasks-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
    const [a, b] = await db.insert(agents).values([
      { companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "active" },
      { companyId: X, name: "Agent X", role: "engineer", adapterType: "process", status: "active" },
    ]).returning();
    agentY = a!.id;
    agentX = b!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const ids = async (companyId: string, agentId: string, owner: string): Promise<Ids> =>
    ({ companyId, agentId, issueId: (await freshTask(companyId, owner)).issueId });
  const call = async (entry: Case, who: Actor, target: Ids) => entry.send(as(who), target);

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3: R (restricted in Y) asking for O's task gets \"not found\" or a list without it", async () => {
      const send = async () => {
        const target = await ids(Y, agentY, O);
        return { ids: target, res: await call(entry, await callerFor(entry, R, Y, agentY), target) };
      };
      const enforced = await send();
      expect(entry.hidden(enforced.res, enforced.ids), JSON.stringify(enforced.res.body)).toBe(true);
      // Control: with the kill switch on the same call reaches O's task, so the
      // answer above is the restriction and not a broken request.
      const open = await today(send);
      expect(entry.hidden(open.res, open.ids), JSON.stringify(open.res.body)).toBe(false);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const ownX = async () => call(entry, await callerFor(entry, R, X, agentX), await ids(X, agentX, R));
      const ownXNow = await ownX();
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBe((await today(ownX)).status);
      expect(ownXNow.status).not.toBe(404);

      const admin = async () => call(entry, await callerFor(entry, ADMIN, Y, agentY, true), await ids(Y, agentY, O));
      const adminNow = await admin();
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe((await today(admin)).status);
    });
  });

  it("PAR-13135: R resuming his task blocked by O's task gets the 409 with no blocker id; with the kill switch `off` the id is listed; a failed list read is 503", async () => {
    const { issueId: blocker } = await freshTask(Y, O);
    const [mine] = await db.insert(issues).values({ companyId: Y, title: "R's blocked task", status: "blocked",
      createdByUserId: R, responsibleUserId: R }).returning();
    await db.insert(issueRelations).values({ companyId: Y, issueId: blocker, relatedIssueId: mine!.id, type: "blocks" });
    const resume = async () => as(await boardFor(R)).patch(`/api/issues/${mine!.id}`).send({ resume: true, comment: "Go on" });
    for (const [res, listed] of [[await resume(), []], [await today(resume), [blocker]]] as const) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toEqual({ error: "Issue follow-up blocked by unresolved blockers",
        details: { issueId: mine!.id, unresolvedBlockerIssueIds: listed } });
    }
    listFails.on = true;
    const failed = await resume();
    expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    expect(failed.body.code ?? failed.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(JSON.stringify(failed.body)).not.toContain(blocker);
  });
});
