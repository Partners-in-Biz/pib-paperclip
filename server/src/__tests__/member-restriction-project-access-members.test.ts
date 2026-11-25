import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import {
  authorizationService,
  issueReadSqlCondition,
  projectReadSqlCondition,
  type AuthorizationActor,
} from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12727 (stage C3-5): `project_access_members` on open projects and the
 * `/projects/:id/access-members` routes for a restricted member. Spec PAR-12608
 * rev 3, section 4.4: AC-L4 (= AC-P1), AC-P2, AC-P3, plus this consumer's
 * kill-switch (AC-F8) and failing-read (AC-X1) tests. The routes are unchanged
 * (C16); the restriction reaches them through `project:read` in the base
 * decision.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("project access members database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("access members on open projects (PAR-12608 4.4)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actorUserId = "";

  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  const t: Record<string, string> = {};
  const p: Record<string, string> = {};

  const board = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session", companyIds: [companyId] });
  const as = (userId: string) => {
    actorUserId = userId;
    return request(app);
  };
  const listTasks = async (userId: string) => {
    const condition: SQL<boolean> = await issueReadSqlCondition(db, board(userId));
    return (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), condition)))
      .map((row) => row.id).sort();
  };
  const listProjects = async (userId: string) => {
    const condition: SQL<boolean> = await projectReadSqlCondition(db, board(userId));
    return (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), condition)))
      .map((row) => row.id).sort();
  };
  const readsTask = async (userId: string, name: string) =>
    (await authorizationService(db).decide({
      actor: board(userId),
      action: "issue:read",
      resource: { type: "issue", companyId, issueId: t[name]!, projectId: null, parentIssueId: null, assigneeAgentId: null, assigneeUserId: null, status: "todo" },
    })).allowed;
  const memberRows = (project: string) =>
    db.select().from(projectAccessMembers).where(eq(projectAccessMembers.projectId, p[project]!));
  const ids = (...names: string[]) => names.map((name) => t[name]!).sort();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-project-members-");
    db = createDb(tempDb.connectionString);
    const [{ projectRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/projects.js"),
      import("../middleware/index.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: actorUserId, source: "session", companyIds: [companyId], isInstanceAdmin: false } as Express.Request["actor"];
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const [company] = await db.insert(companies).values({
      name: "Restricted co", issuePrefix: `M${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "Shared agent", role: "engineer", adapterType: "process" }).returning();
    agentId = agent!.id;

    const [clientProject, otherProject, rProject] = await db.insert(projects).values([
      { companyId, name: "Client project", visibility: "open", privacyOwnerUserId: O },
      { companyId, name: "Other project", visibility: "open", privacyOwnerUserId: O },
      // R's own open project: he is its privacy owner and on its list (C3-6 adds that row on create).
      { companyId, name: "R's project", visibility: "open", privacyOwnerUserId: R },
    ]).returning();
    p.client = clientProject!.id;
    p.other = otherProject!.id;
    p.mine = rProject!.id;
    await db.insert(projectAccessMembers).values({ companyId, projectId: p.mine, subjectType: "user", subjectId: R });

    const insertTask = async (name: string, values: Partial<typeof issues.$inferInsert>) => {
      const [row] = await db.insert(issues).values({ companyId, title: name, createdByUserId: O, ...values }).returning();
      t[name] = row!.id;
    };
    await insertTask("clientA", { projectId: p.client });
    await insertTask("clientB", { projectId: p.client });
    await insertTask("clientChild", { projectId: p.client });
    await db.update(issues).set({ parentId: t.clientA!, privacyParentIssueId: t.clientA! }).where(eq(issues.id, t.clientChild!));
    await insertTask("clientByR", { projectId: p.client, createdByUserId: R });
    await insertTask("otherTask", { projectId: p.other });
    await insertTask("noProject", {});
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("AC-L4 / AC-P1: O adds R to an open project, R reads it and every task in it; removed, only his own task stays", async () => {
    expect((await as(R).get(`/api/projects/${p.client}`)).status).toBe(404);
    expect(await listTasks(R)).toEqual(ids("clientByR"));

    const added = await as(O).post(`/api/projects/${p.client}/access-members`).send({ subjectType: "user", subjectId: R });
    expect(added.status).toBe(201);

    expect((await as(R).get(`/api/projects/${p.client}`)).status).toBe(200);
    expect(await listProjects(R)).toEqual([p.client, p.mine].sort());
    expect(await listTasks(R)).toEqual(ids("clientA", "clientB", "clientChild", "clientByR"));
    for (const name of ["clientA", "clientB", "clientChild"]) expect(await readsTask(R, name), name).toBe(true);
    expect(await readsTask(R, "otherTask")).toBe(false);

    const removed = await as(O).delete(`/api/projects/${p.client}/access-members/${added.body.id}`);
    expect(removed.status).toBe(200);

    expect((await as(R).get(`/api/projects/${p.client}`)).status).toBe(404);
    expect(await listProjects(R)).toEqual([p.mine]);
    expect(await listTasks(R)).toEqual(ids("clientByR"));
    for (const name of ["clientA", "clientB", "clientChild"]) expect(await readsTask(R, name), name).toBe(false);
    expect(await readsTask(R, "clientByR")).toBe(true);
  });

  it("AC-P2: a row for an unflagged member on an open project changes nothing for him", async () => {
    const everyTask = Object.values(t).sort();
    const everyProject = Object.values(p).sort();
    expect(await listTasks(U)).toEqual(everyTask);
    expect(await listProjects(U)).toEqual(everyProject);

    const added = await as(O).post(`/api/projects/${p.client}/access-members`).send({ subjectType: "user", subjectId: U });
    expect(added.status).toBe(201);
    expect(await listTasks(U)).toEqual(everyTask);
    expect(await listProjects(U)).toEqual(everyProject);
    expect(await readsTask(U, "otherTask")).toBe(true);

    expect((await as(O).delete(`/api/projects/${p.client}/access-members/${added.body.id}`)).status).toBe(200);
    expect(await listTasks(U)).toEqual(everyTask);
    expect(await listProjects(U)).toEqual(everyProject);
    expect(await readsTask(U, "clientA")).toBe(true);
  });

  it("AC-P3: R, privacy owner of a project he created, adds and removes its access members", async () => {
    const listed = await as(R).get(`/api/projects/${p.mine}/access-members`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((row: { subjectId: string }) => row.subjectId)).toEqual([R]);

    const person = await as(R).post(`/api/projects/${p.mine}/access-members`).send({ subjectType: "user", subjectId: U });
    expect(person.status).toBe(201);
    const agent = await as(R).post(`/api/projects/${p.mine}/access-members`).send({ subjectType: "agent", subjectId: agentId });
    expect(agent.status).toBe(201);
    expect((await memberRows("mine")).map((row) => row.subjectId).sort()).toEqual([R, U, agentId].sort());

    expect((await as(R).delete(`/api/projects/${p.mine}/access-members/${person.body.id}`)).status).toBe(200);
    expect((await as(R).delete(`/api/projects/${p.mine}/access-members/${agent.body.id}`)).status).toBe(200);
    expect((await memberRows("mine")).map((row) => row.subjectId)).toEqual([R]);
  });

  it("AC-P3: R, privacy owner of a private project he created through the route, manages its members", async () => {
    const created = await as(R).post(`/api/companies/${companyId}/projects`).send({ name: "R's private project", visibility: "private" });
    expect(created.status).toBe(201);
    expect(created.body.privacyOwnerUserId).toBe(R);
    const projectId = created.body.id as string;

    const added = await as(R).post(`/api/projects/${projectId}/access-members`).send({ subjectType: "user", subjectId: O });
    expect(added.status).toBe(201);
    expect((await as(R).get(`/api/projects/${projectId}/access-members`)).body.map((row: { subjectId: string }) => row.subjectId).sort())
      .toEqual([O, R].sort());
    expect((await as(R).delete(`/api/projects/${projectId}/access-members/${added.body.id}`)).status).toBe(200);
  });

  it("AC-P3: R cannot read or change the access members of a project he is not on (same \"not found\")", async () => {
    const [ownerRow] = await memberRows("mine");
    const [otherRow] = await db.insert(projectAccessMembers)
      .values({ companyId, projectId: p.other, subjectType: "user", subjectId: O }).returning();
    try {
      const missing = randomUUID();
      const absent = [
        await as(R).get(`/api/projects/${missing}/access-members`),
        await as(R).post(`/api/projects/${missing}/access-members`).send({ subjectType: "user", subjectId: R }),
        await as(R).delete(`/api/projects/${missing}/access-members/${ownerRow!.id}`),
      ];
      const notHis = [
        await as(R).get(`/api/projects/${p.other}/access-members`),
        await as(R).post(`/api/projects/${p.other}/access-members`).send({ subjectType: "user", subjectId: R }),
        await as(R).delete(`/api/projects/${p.other}/access-members/${otherRow!.id}`),
      ];
      notHis.forEach((res, index) => {
        expect(res.status, `request ${index}`).toBe(404);
        expect(res.body).toEqual(absent[index]!.body);
      });
      expect(notHis[0]!.body).toEqual({ error: "Project not found" });
      expect((await memberRows("other")).map((row) => row.subjectId)).toEqual([O]);
    } finally {
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id, otherRow!.id));
    }
  });

  describe("kill switch (AC-F8)", () => {
    it("with the variable exactly `off` and the column on enforce, the routes behave as mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const res = await as(R).get(`/api/projects/${p.other}/access-members`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect((await as(R).get(`/api/projects/${p.client}`)).status).toBe(200);
    });

    it.each(["false", "OFF "])("with the variable set to %j enforcement stays on", async (value) => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      expect((await as(R).get(`/api/projects/${p.other}/access-members`)).status).toBe(404);
    });
  });

  describe("failing read (AC-X1)", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE, returns no data and writes nothing when the resolver throws", async () => {
      // A malformed list makes the resolver throw for R in this company.
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
        where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      try {
        const [ownerRow] = await memberRows("mine");
        const responses = [
          await as(R).get(`/api/projects/${p.mine}/access-members`),
          await as(R).post(`/api/projects/${p.mine}/access-members`).send({ subjectType: "user", subjectId: U }),
          await as(R).delete(`/api/projects/${p.mine}/access-members/${ownerRow!.id}`),
        ];
        responses.forEach((res, index) => {
          expect(res.status, `request ${index}`).toBe(503);
          expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(Array.isArray(res.body)).toBe(false);
          expect(res.body).not.toHaveProperty("subjectId");
        });
        expect((await memberRows("mine")).map((row) => row.subjectId)).toEqual([R]);
        // An unflagged member is not affected.
        expect((await as(U).get(`/api/projects/${p.mine}/access-members`)).status).toBe(200);
      } finally {
        await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
          where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      }
    });
  });
});
