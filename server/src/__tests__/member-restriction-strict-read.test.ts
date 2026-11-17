import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issueAccessGrants,
  issues,
  projectAccessMembers,
  projects,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import {
  issueReadSqlCondition,
  projectReadSqlCondition,
  type AuthorizationActor,
} from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12717 (stage C3-1): the strict read condition in the task and project
 * list builders. Spec PAR-12608 rev 3, section 4.3: AC-L1, AC-L7, AC-L9,
 * AC-L10, AC-L13, AC-X4, plus this consumer's kill-switch and failing-read
 * tests (AC-F8, AC-X1).
 */

const board = (userId: string): AuthorizationActor => ({ type: "board", userId, authorizingUserId: userId });
/** A board actor without an authorizing person, so the privacy mode decides (AC-L10). */
const boardWithoutAuthorizer = (userId: string): AuthorizationActor => ({ type: "board", userId });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("list builders when the restriction cannot be read", () => {
  const failingDb = {
    select: () => {
      throw new Error("connection reset");
    },
  } as unknown as Db;

  it.each([
    ["issueReadSqlCondition", issueReadSqlCondition],
    ["projectReadSqlCondition", projectReadSqlCondition],
  ] as const)("%s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no data", async (_name, builder) => {
    const app = express();
    app.get("/list", async (_req, res, next) => {
      try {
        await builder(failingDb, board("user-r"));
        res.json({ rows: ["secret"] });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);

    const res = await request(app).get("/list");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(res.body).not.toHaveProperty("rows");
  });

  it("with the kill switch exactly `off` does not read the restriction at all", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await expect(issueReadSqlCondition(failingDb, board("user-r"))).resolves.toBeDefined();
    await expect(projectReadSqlCondition(failingDb, board("user-r"))).resolves.toBeDefined();
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("strict read database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("strict read condition against the database", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let controlId = "";
  let agentId = "";
  const t: Record<string, string> = {};
  const p: Record<string, string> = {};
  let expectedForR: string[] = [];
  let controlTasks: string[] = [];

  async function addTask(
    name: string,
    values: Partial<typeof issues.$inferInsert> & { parent?: string },
    company = companyId,
  ) {
    const { parent, ...rest } = values;
    const parentId = parent ? t[parent]! : null;
    const [row] = await db.insert(issues).values({
      companyId: company,
      title: name,
      createdByUserId: O,
      parentId,
      privacyParentIssueId: parentId,
      ...rest,
    }).returning();
    t[name] = row!.id;
  }

  const listTasks = async (condition: SQL<boolean>, company = companyId) =>
    (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, company), condition)))
      .map((row) => row.id).sort();
  const listProjects = async (condition: SQL<boolean>, company = companyId) =>
    (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, company), condition)))
      .map((row) => row.id).sort();
  const sqlText = (condition: SQL<boolean>) => {
    const query = db.select({ id: issues.id }).from(issues).where(condition).toSQL();
    return { sql: query.sql, params: query.params };
  };
  const ids = (...names: string[]) => names.map((name) => t[name]!).sort();
  /** What R lists with the restriction out of the way (today's rule alone). */
  const todayForR = async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await listTasks(await issueReadSqlCondition(db, board(R)));
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-strict-read-");
    db = createDb(tempDb.connectionString);

    const [company, control] = await db.insert(companies).values([
      { name: "Restricted co", issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Control co", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    companyId = company!.id;
    controlId = control!.id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: controlId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: controlId, principalType: "user", principalId: R, status: "active", membershipRole: "operator" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "Shared agent", adapterType: "process" }).returning();
    agentId = agent!.id;

    const [mine, others] = await db.insert(projects).values([
      { companyId, name: "Open project with R as access member", visibility: "open" },
      { companyId, name: "Open project without R", visibility: "open" },
    ]).returning();
    p.mine = mine!.id;
    p.others = others!.id;
    await db.insert(projectAccessMembers).values({ companyId, projectId: p.mine, subjectType: "user", subjectId: R });
    const [controlProject] = await db.insert(projects).values({ companyId: controlId, name: "Control", visibility: "open" }).returning();
    p.control = controlProject!.id;

    // Not R's: open tasks of O and U, and a task in a project R is not on.
    await addTask("ownerOpen", {});
    await addTask("operatorOpen", { createdByUserId: U });
    await addTask("othersProjectTask", { projectId: p.others });
    await addTask("revokedGrant", {});
    // R's by AC-L1.
    await addTask("createdByR", { createdByUserId: R });
    await addTask("responsibleR", { responsibleUserId: R });
    await addTask("assignParent", {});
    await addTask("assignedToR", { assigneeUserId: R, parent: "assignParent" });
    await addTask("assignSibling", { parent: "assignParent" });
    await addTask("assignedChild", { parent: "assignedToR" });
    await addTask("granted", {});
    await addTask("myProjectTask", { projectId: p.mine });
    await addTask("myProjectChild", { parent: "myProjectTask" });
    // AC-L13: five deep, mixed visibility, R's grant only on the private root.
    // (A private node under an open one would need its own grant under the
    // existing rule, and the restriction never widens that.)
    await addTask("chain1", { visibility: "private" });
    await addTask("chain2", { visibility: "private", parent: "chain1" });
    await addTask("chain3", { visibility: "open", parent: "chain2" });
    await addTask("chain4", { visibility: "open", parent: "chain3" });
    await addTask("chain5", { visibility: "open", parent: "chain4" });
    // The same chain without any link to R: none of it, open nodes included.
    await addTask("foreign1", { visibility: "private" });
    await addTask("foreign2", { visibility: "open", parent: "foreign1" });
    await addTask("foreign3", { visibility: "private", parent: "foreign2" });
    await addTask("foreign4", { visibility: "open", parent: "foreign3" });
    await addTask("foreign5", { visibility: "open", parent: "foreign4" });
    // The climb follows parent_id: this child has no privacy parent set.
    await addTask("parentOnlyChild", { parent: "granted", privacyParentIssueId: null });
    // Agent-only task for AC-L7.
    await addTask("assignedToAgent", { assigneeAgentId: agentId });

    await db.insert(issueAccessGrants).values([
      { issueId: t.granted!, subjectType: "user", subjectId: R, source: "explicit" },
      { issueId: t.chain1!, subjectType: "user", subjectId: R, source: "explicit" },
      { issueId: t.revokedGrant!, subjectType: "user", subjectId: R, source: "explicit", revokedAt: new Date() },
    ]);

    await addTask("controlOpen", {}, controlId);
    await addTask("controlOperatorOpen", { createdByUserId: U }, controlId);

    expectedForR = ids(
      "createdByR", "responsibleR", "assignedToR", "assignedChild", "granted", "parentOnlyChild",
      "myProjectTask", "myProjectChild", "chain1", "chain2", "chain3", "chain4", "chain5",
    );
    controlTasks = ids("controlOpen", "controlOperatorOpen");
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  it("AC-L1, AC-L13: R lists exactly his tasks and their descendants, through a five-deep mixed chain", async () => {
    expect(await listTasks(await issueReadSqlCondition(db, board(R)))).toEqual(expectedForR);
    expect(await listProjects(await projectReadSqlCondition(db, board(R)))).toEqual([p.mine]);
  });

  it("AC-L9: O and U keep their lists and the SQL text of their queries; R in the control company sees every open task", async () => {
    for (const person of [O, U]) {
      const enforced = await issueReadSqlCondition(db, board(person));
      const enforcedProjects = await projectReadSqlCondition(db, board(person));
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const baseline = await issueReadSqlCondition(db, board(person));
      const baselineProjects = await projectReadSqlCondition(db, board(person));
      vi.unstubAllEnvs();
      expect(sqlText(enforced)).toEqual(sqlText(baseline));
      expect(db.select().from(projects).where(enforcedProjects).toSQL())
        .toEqual(db.select().from(projects).where(baselineProjects).toSQL());
      expect(await listTasks(enforced)).toEqual(await listTasks(baseline));
      expect(await listTasks(enforced)).toEqual(expect.arrayContaining(ids("ownerOpen", "operatorOpen", "othersProjectTask")));
    }
    const forR = await issueReadSqlCondition(db, board(R));
    expect(await listTasks(forR, controlId)).toEqual(controlTasks);
    expect(await listProjects(await projectReadSqlCondition(db, board(R)), controlId)).toEqual([p.control]);
  });

  it("AC-L10: with PAPERCLIP_ISSUE_PRIVACY_MODE=off the strict part still holds", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    for (const actor of [board(R), boardWithoutAuthorizer(R)]) {
      expect(await listTasks(await issueReadSqlCondition(db, actor))).toEqual(expectedForR);
      expect(await listProjects(await projectReadSqlCondition(db, actor))).toEqual([p.mine]);
    }
    // An unflagged person in that mode still gets "all rows", as today.
    expect(sqlText(await issueReadSqlCondition(db, boardWithoutAuthorizer(U))).sql).toMatch(/where true$/);
  });

  it("AC-L7: an agent run for R lists a subset of R's tasks; the same agent for O sees what it sees today", async () => {
    const forR: AuthorizationActor = { type: "agent", agentId, onBehalfOfUserId: R, authorizingUserId: R };
    const listedForR = await listTasks(await issueReadSqlCondition(db, forR));
    expect(listedForR.length).toBeGreaterThan(0);
    expect(listedForR.every((id) => expectedForR.includes(id))).toBe(true);
    expect(listedForR).not.toContain(t.assignedToAgent);

    const forO: AuthorizationActor = { type: "agent", agentId, onBehalfOfUserId: O, authorizingUserId: O };
    const enforced = await issueReadSqlCondition(db, forO);
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const baseline = await issueReadSqlCondition(db, forO);
    vi.unstubAllEnvs();
    expect(sqlText(enforced)).toEqual(sqlText(baseline));
    expect(await listTasks(enforced)).toEqual(await listTasks(baseline));
  });

  it("kill switch: variable `off` with the column on `enforce` behaves as mode `off`", async () => {
    await db.update(companies).set({ memberRestrictionMode: "off" }).where(eq(companies.id, companyId));
    const modeOffCondition = await issueReadSqlCondition(db, board(R));
    const modeOff = sqlText(modeOffCondition);
    const modeOffRows = await listTasks(modeOffCondition);
    await db.update(companies).set({ memberRestrictionMode: "enforce" }).where(eq(companies.id, companyId));
    expect(modeOffRows).toEqual(expect.arrayContaining(ids("ownerOpen", "operatorOpen", "othersProjectTask")));

    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const condition = await issueReadSqlCondition(db, board(R));
    expect(sqlText(condition)).toEqual(modeOff);
    expect(sqlText(condition).sql).not.toMatch(/strict_chain/);
    expect(await listTasks(condition)).toEqual(modeOffRows);
    expect(await listProjects(await projectReadSqlCondition(db, board(R)))).toEqual([p.mine, p.others].sort());
  });

  it.each(["false", "OFF "])("kill switch: variable %j is not `off`, so enforcement stays on", async (value) => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
    expect(await listTasks(await issueReadSqlCondition(db, board(R)))).toEqual(expectedForR);
    expect(await listProjects(await projectReadSqlCondition(db, board(R)))).toEqual([p.mine]);
  });

  it("report mode lists unfiltered", async () => {
    await db.update(companies).set({ memberRestrictionMode: "report" }).where(eq(companies.id, companyId));
    try {
      const condition = await issueReadSqlCondition(db, board(R));
      expect(sqlText(condition).sql).not.toMatch(/strict_chain/);
      expect(await listTasks(condition)).toEqual(await todayForR());
      expect(await listTasks(condition)).toContain(t.ownerOpen);
    } finally {
      await db.update(companies).set({ memberRestrictionMode: "enforce" }).where(eq(companies.id, companyId));
    }
  });

  it("AC-X4, AC-L13: a flagged member whose row is suspended lists nothing in that company", async () => {
    const where = and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, R));
    await db.update(companyMemberships).set({ status: "suspended" }).where(where);
    try {
      expect(await listTasks(await issueReadSqlCondition(db, board(R)))).toEqual([]);
      expect(await listProjects(await projectReadSqlCondition(db, board(R)))).toEqual([]);
      expect(await listTasks(await issueReadSqlCondition(db, board(R)), controlId)).toEqual(controlTasks);
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(where);
    }
  });
});
