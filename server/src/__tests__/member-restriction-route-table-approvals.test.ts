import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalComments, approvals, authUsers, companies, companyMemberships, createDb, issueApprovals, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13024 (C4d-1): the approval rows of the route table. Spec PAR-12608
 * rev 3, 4.6 and S11: R reads an approval linked to a task he can read and
 * decides none. AC-G3 and AC-G6: R (restricted in Y) asking for an approval
 * linked to O's task gets "not found" or a list without it; with the kill
 * switch `off` the same call reaches it (AC-F8). An approval linked to no
 * task is not his under `enforce` (the new resolver call in
 * `approvalReadSqlCondition`). Scope callers (section 8): R as owner of X, and
 * an instance admin who is no member of Y, get today's answer. AC-X1: a
 * failed restriction read answers 503 and no data. AC-G1: the closed rows
 * classify as closed. No `run` or `by-company` rows.
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
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-approvals.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("approval route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Ids = { companyId: string; issueId: string; approvalId: string };
type Case = {
  row: string;
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
  /** R's answer for an approval linked to O's task, under `enforce`. */
  refused: (res: request.Response, ids: Ids) => void;
  /** Today's answer reaches the approval. */
  reached: (res: request.Response, ids: Ids) => void;
};

const notFound = (error: string) => (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(404);
  expect(res.body).toEqual({ error });
};
const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200);
const listed = (res: request.Response, { approvalId }: Ids) => {
  ok(res);
  expect(res.body.map((row: { id: string }) => row.id)).toContain(approvalId);
};
const unlisted = (res: request.Response, { approvalId }: Ids) => {
  ok(res);
  expect(res.body.map((row: { id: string }) => row.id)).not.toContain(approvalId);
};

const CASES: Case[] = [
  { row: "GET /api/companies/:companyId/approvals",
    send: (c, { companyId }) => c.get(`/api/companies/${companyId}/approvals`), refused: unlisted, reached: listed },
  { row: "GET /api/approvals/:id",
    send: (c, { approvalId }) => c.get(`/api/approvals/${approvalId}`), refused: notFound("Approval not found"),
    reached: (res, { approvalId }) => { ok(res); expect(res.body.id).toBe(approvalId); } },
  { row: "GET /api/approvals/:id/issues",
    send: (c, { approvalId }) => c.get(`/api/approvals/${approvalId}/issues`), refused: notFound("Approval not found"),
    reached: (res, { issueId }) => { ok(res); expect(res.body.map((row: { id: string }) => row.id)).toEqual([issueId]); } },
  { row: "GET /api/approvals/:id/comments",
    send: (c, { approvalId }) => c.get(`/api/approvals/${approvalId}/comments`), refused: notFound("Approval not found"),
    reached: (res) => { ok(res); expect(res.body).toHaveLength(1); } },
  { row: "GET /api/issues/:id/approvals",
    send: (c, { issueId }) => c.get(`/api/issues/${issueId}/approvals`), refused: notFound("Issue not found"), reached: listed },
];

/** The closed rows this ticket wrote (AC-G1; deciding an approval is named there). */
const CLOSED_ROWS = [
  "POST /api/companies/:companyId/approvals",
  "POST /api/approvals/:id/approve",
  "POST /api/approvals/:id/reject",
  "POST /api/approvals/:id/request-revision",
  "POST /api/approvals/:id/resubmit",
  "POST /api/approvals/:id/comments",
  "POST /api/issues/:id/approvals",
  "DELETE /api/issues/:id/approvals/:approvalId",
];

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE
    .filter((entry) => entry.test === THIS_FILE)
    .map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

it("AC-G1: deciding, creating, commenting on, linking and unlinking an approval classify as closed for their real paths", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe("closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry!.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("approval rows of the route table (PAR-12608 4.6, AC-G3, AC-G6)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let root = "";
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";

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
  const task = async (companyId: string, owner: string) => {
    const [row] = await db.insert(issues).values({
      companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo", createdByUserId: O, responsibleUserId: owner,
    }).returning();
    return row!.id;
  };
  const approval = async (companyId: string, issueIds: string[]) => {
    const [row] = await db.insert(approvals).values({
      companyId, type: "request_board_approval", payload: { title: "Owner's request" }, requestedByUserId: O,
    }).returning();
    if (issueIds.length > 0) {
      await db.insert(issueApprovals).values(issueIds.map((issueId) => ({ companyId, issueId, approvalId: row!.id })));
    }
    await db.insert(approvalComments).values({ companyId, approvalId: row!.id, authorUserId: O, body: "Owner's comment" });
    return row!.id;
  };
  /** A task of `owner` and an approval linked to it. */
  const ids = async (companyId: string, owner: string): Promise<Ids> => {
    const issueId = await task(companyId, owner);
    return { companyId, issueId, approvalId: await approval(companyId, [issueId]) };
  };
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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-approvals-");
    db = createDb(tempDb.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "restriction-route-table-approvals-"));
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, storage));
    app.use("/api", approvalRoutes(db));
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
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3 and AC-F8: R (restricted in Y) does not get the approval on O's task; with the kill switch `off`, today's answer", async () => {
      const target = await ids(Y, O);
      const send = async () => entry.send(as(await boardFor(R)), target);
      entry.refused(await send(), target);
      entry.reached(await today(send), target);
    });

    it("AC-G6: R reads the approval linked to his own task in Y", async () => {
      const own = await ids(Y, R);
      entry.reached(await entry.send(as(await boardFor(R)), own), own);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const callAs = async (who: () => Promise<Actor>, target: Promise<Ids>) => {
        const ready = await target;
        return { res: await entry.send(as(await who()), ready), ready };
      };
      const ownX = () => callAs(() => boardFor(R), ids(X, R));
      const ownXNow = await ownX();
      entry.reached(ownXNow.res, ownXNow.ready);
      expect(ownXNow.res.status).toBe((await today(ownX)).res.status);
      const admin = () => callAs(() => boardFor(ADMIN, true), ids(Y, O));
      const adminNow = await admin();
      const adminToday = (await today(admin)).res;
      expect(adminNow.res.status, JSON.stringify(adminNow.res.body)).toBe(adminToday.status);
      expect(adminNow.res.body).toEqual(adminToday.body.error ? adminToday.body : expect.anything());
    });
  });

  it("AC-F8: an approval linked to no task is not R's in Y; with the kill switch `off` he reads it; in X (owner) he reads it", async () => {
    const companyWide = await approval(Y, []);
    const byId = async () => (await as(await boardFor(R))).get(`/api/approvals/${companyWide}`);
    const list = async () => (await as(await boardFor(R))).get(`/api/companies/${Y}/approvals`);
    notFound("Approval not found")(await byId());
    unlisted(await list(), { companyId: Y, issueId: "", approvalId: companyWide });
    ok(await today(byId));
    listed(await today(list), { companyId: Y, issueId: "", approvalId: companyWide });
    const inX = await approval(X, []);
    ok(await (await as(await boardFor(R))).get(`/api/approvals/${inX}`));
  });

  it("an approval linked to R's task and to O's task is \"not found\" for R and left off his task's list", async () => {
    const mine = await task(Y, R);
    const shared = await approval(Y, [mine, await task(Y, O)]);
    notFound("Approval not found")(await (await as(await boardFor(R))).get(`/api/approvals/${shared}`));
    unlisted(await (await as(await boardFor(R))).get(`/api/issues/${mine}/approvals`), { companyId: Y, issueId: mine, approvalId: shared });
    listed(await today(async () => (await as(await boardFor(R))).get(`/api/issues/${mine}/approvals`)),
      { companyId: Y, issueId: mine, approvalId: shared });
  });

  it.each(CASES.map((entry) => [entry.row, entry] as const))(
    "AC-X1: %s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no data when the restriction cannot be read",
    async (_row, entry) => {
      const target = await ids(Y, O);
      const caller = await boardFor(R);
      resolverFails.on = true;
      const res = await entry.send(as(caller), target);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(target.approvalId);
    },
  );
});
