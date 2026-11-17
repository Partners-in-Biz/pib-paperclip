import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies, companyMemberships, createDb, projectAccessMembers, projects, type Db,
} from "@paperclipai/db";
import { deriveProjectUrlKey } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { projectReadSqlCondition } from "../services/authorization.js";
import { projectService } from "../services/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12719 (stage C3-2a-2): the project list functions take a required read
 * scope. Spec PAR-12608 rev 3, 4.3 (C28) and 7 (X5): for each route caller in
 * `routes/projects.ts` a filter test, a kill-switch test (AC-F8) and a
 * failing-read test (AC-X1). The issue-detail and skills callers are covered in
 * issues-goal-context-routes.test.ts and company-skills-routes.test.ts; AC-L14
 * in services/project-list-read-scope.test.ts.
 */

type Actor = Express.Request["actor"];

const sessionActor = (userId: string, companyId: string): Actor => ({
  type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
});

function appFor(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

/** A db whose restriction read (`company_memberships`) fails; every other read answers no rows. */
const failingRestrictionDb = {
  select: () => ({
    from: (table: unknown) => {
      const rows = table === companyMemberships
        ? () => Promise.reject(new Error("connection reset"))
        : async () => [];
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        innerJoin: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
        then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => rows().then(resolve, reject),
      });
      return chain;
    },
  }),
} as unknown as Db;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("project routes when the restriction cannot be read (AC-X1)", () => {
  it.each([
    ["/api/companies/company-1/projects"],
    ["/api/companies/company-1/projects?view=summary"],
    ["/api/projects/some-project?companyId=company-1"],
  ])("%s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no projects", async (path) => {
    const res = await request(appFor(failingRestrictionDb, sessionActor("user-r", "company-1"))).get(path);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.projects).toBeUndefined();
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("project list callers database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("project list callers pass the caller's read condition", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let projectOfR = "";
  let projectOfO = "";
  let projectOfOKey = "";
  const sorted = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-list-callers-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({
      name: "Restricted co", issuePrefix: `P${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const rows = await db.insert(projects).values([
      { companyId, name: "R project", visibility: "open" },
      { companyId, name: "O open project", visibility: "open" },
    ]).returning();
    projectOfR = rows[0]!.id;
    projectOfO = rows[1]!.id;
    projectOfOKey = deriveProjectUrlKey(rows[1]!.name, projectOfO)!;
    await db.insert(projectAccessMembers).values({ companyId, projectId: projectOfR, subjectType: "user", subjectId: R });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  const listed = async (path: string, userId: string) => {
    const res = await request(appFor(db, sessionActor(userId, companyId))).get(path);
    expect(res.status).toBe(200);
    const rows = (Array.isArray(res.body) ? res.body : res.body.projects) as Array<{ id: string }>;
    return rows.map((row) => row.id).sort();
  };

  describe.each([
    ["GET /companies/:companyId/projects", () => `/api/companies/${companyId}/projects`],
    ["GET /companies/:companyId/projects?view=summary", () => `/api/companies/${companyId}/projects?view=summary`],
  ])("%s", (_name, path) => {
    it("R lists only his project; O lists both", async () => {
      expect(await listed(path(), R)).toEqual([projectOfR]);
      expect(await listed(path(), O)).toEqual(sorted(projectOfR, projectOfO));
    });

    it("AC-F8: with the kill switch `off` R lists as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await listed(path(), R)).toEqual(sorted(projectOfR, projectOfO));
    });
  });

  describe("GET /projects/:shortname (reference lookup)", () => {
    const fetch = (userId: string, key = projectOfOKey) =>
      request(appFor(db, sessionActor(userId, companyId))).get(`/api/projects/${key}?companyId=${companyId}`);

    it("R cannot resolve O's project by shortname (same answer as a missing one); O can", async () => {
      const denied = await fetch(R);
      const missing = await fetch(R, "no-such-project");
      expect(denied.body.id).toBeUndefined();
      expect([denied.status, denied.body]).toEqual([missing.status, missing.body]);
      const own = await fetch(O);
      expect(own.status).toBe(200);
      expect(own.body.id).toBe(projectOfO);
    });

    it("AC-F8: with the kill switch `off` R resolves it as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect((await fetch(R)).body.id).toBe(projectOfO);
    });
  });

  it("the list functions themselves filter on the condition they are given", async () => {
    const svc = projectService(db);
    const readCondition = await projectReadSqlCondition(db, sessionActor(R, companyId));
    expect((await svc.list(companyId, { readCondition })).map((p) => p.id)).toEqual([projectOfR]);
    expect((await svc.listByIds(companyId, [projectOfR, projectOfO], { readCondition })).map((p) => p.id)).toEqual([projectOfR]);
    expect((await svc.listSummaries(companyId, { limit: 10, includeArchived: true, candidateIds: null, readCondition }))
      .map((p) => p.id)).toEqual([projectOfR]);
    expect((await svc.list(companyId, { readCondition: "system" })).map((p) => p.id).sort()).toEqual(sorted(projectOfR, projectOfO));
  });
});
