import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
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
import { createHostClientHandlers, type PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12728 (stage C3-6): what a restricted member creates is his, and he
 * creates or moves a task only where he can read. Spec PAR-12608 rev 3,
 * section 4.5: AC-O1 to AC-O7, plus this consumer's kill-switch (AC-F8) and
 * failing-read (AC-X1) tests. O = owner, U = unflagged operator, R = flagged
 * operator, all in one company on `enforce`.
 */

const support = await getEmbeddedPostgresTestSupport();
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PLUGIN_WORKER = path.join(FIXTURES_DIR, "plugin-worker-invocation-scope.cjs");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("creator-owned projects and tasks database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];

(support.supported ? describe : describe.skip)("creator-owned projects and tasks, moving a task (PAR-12608 4.5)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let ownerProject = "";
  let ownerTask = "";

  const board = (userId: string): Actor =>
    ({ type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false }) as Actor;
  const agentFor = async (personId: string): Promise<Actor> => ({
    type: "agent", companyId, agentId, source: "agent_key", onBehalfOfUserId: personId,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId: personId, activeOnly: true }),
  }) as Actor;
  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const createTask = (who: Actor, body: Record<string, unknown>) =>
    as(who).post(`/api/companies/${companyId}/issues`).send({ title: `Task ${randomUUID().slice(0, 8)}`, ...body });
  const createProject = (who: Actor, body: Record<string, unknown> = {}) =>
    as(who).post(`/api/companies/${companyId}/projects`).send({ name: `Project ${randomUUID().slice(0, 8)}`, ...body });
  const listedIds = async (who: Actor) => {
    const res = await as(who).get(`/api/companies/${companyId}/issues`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ id: string }>).map((row) => row.id);
  };
  const reads = async (who: Actor, kind: "issues" | "projects", id: string) =>
    (await as(who).get(`/api/${kind}/${id}`)).status;
  const stored = async (id: string) =>
    (await db.select({ projectId: issues.projectId, parentId: issues.parentId }).from(issues).where(eq(issues.id, id)))[0];
  const accessRows = async (projectId: string) =>
    (await db.select({ subjectType: projectAccessMembers.subjectType, subjectId: projectAccessMembers.subjectId })
      .from(projectAccessMembers).where(eq(projectAccessMembers.projectId, projectId)))
      .map((row) => `${row.subjectType}:${row.subjectId}`).sort();
  const breakResolverFor = (personId: string) => db.execute(sql`update ${companyMemberships}
    set restricted_plugin_keys = '"broken"'::jsonb
    where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${personId}`);
  const repairResolverFor = (personId: string) => db.execute(sql`update ${companyMemberships}
    set restricted_plugin_keys = '[]'::jsonb
    where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${personId}`);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-creator-owned-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const [company] = await db.insert(companies).values({
      name: "Creator-owned co", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
      requireBoardApprovalForNewAgents: false,
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Shared agent", role: "engineer", adapterType: "process", status: "active",
    }).returning();
    agentId = agent!.id;

    const [project] = await db.insert(projects).values({
      companyId, name: "O's project", visibility: "open", privacyOwnerUserId: O,
    }).returning();
    ownerProject = project!.id;
    const [task] = await db.insert(issues).values({
      companyId, title: "O's task", projectId: ownerProject, createdByUserId: O, responsibleUserId: O,
    }).returning();
    ownerTask = task!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("AC-O1: R creates a task without a project; it is in his list and in O's", async () => {
    const created = await createTask(board(R), {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.createdByUserId).toBe(R);
    expect(await listedIds(board(R))).toContain(created.body.id);
    expect(await listedIds(board(R))).not.toContain(ownerTask);
    expect(await listedIds(board(O))).toContain(created.body.id);
  });

  it("AC-O2: R creates an open project and a task in it; both are readable to R, O and U", async () => {
    const project = await createProject(board(R));
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    expect(project.body.visibility).toBe("open");
    expect(await accessRows(project.body.id)).toEqual([`user:${R}`]);
    const task = await createTask(board(R), { projectId: project.body.id });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    for (const who of [R, O, U]) {
      expect(await reads(board(who), "projects", project.body.id), who).toBe(200);
      expect(await reads(board(who), "issues", task.body.id), who).toBe(200);
    }
  });

  it("an unflagged creator of an open project gets no access row (today's result)", async () => {
    const project = await createProject(board(U));
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    expect(await accessRows(project.body.id)).toEqual([]);
  });

  it("AC-O3: an agent run working for R creates a project and a child task; R reads both and is responsible", async () => {
    const runForR = await agentFor(R);
    const project = await createProject(runForR);
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    expect(await accessRows(project.body.id)).toEqual([`agent:${agentId}`, `user:${R}`].sort());
    const parent = await createTask(runForR, { projectId: project.body.id });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    const child = await as(runForR).post(`/api/issues/${parent.body.id}/children`).send({ title: "Child" });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.responsibleUserId).toBe(R);
    expect(await reads(board(R), "projects", project.body.id)).toBe(200);
    expect(await reads(board(R), "issues", child.body.id)).toBe(200);
  });

  it("AC-O4: R creating a task in O's project or under O's task gets the same \"not found\" as a missing one", async () => {
    const before = (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length;
    const missingProject = await createTask(board(R), { projectId: randomUUID() });
    const inOwnersProject = await createTask(board(R), { projectId: ownerProject });
    expect(inOwnersProject.status).toBe(404);
    expect(inOwnersProject.body).toEqual(missingProject.body);

    const missingParent = await createTask(board(R), { parentId: randomUUID() });
    const underOwnersTask = await createTask(board(R), { parentId: ownerTask });
    expect(underOwnersTask.status).toBe(404);
    expect(underOwnersTask.body).toEqual(missingParent.body);

    const missingChildParent = await as(board(R)).post(`/api/issues/${randomUUID()}/children`).send({ title: "Child" });
    const childOfOwners = await as(board(R)).post(`/api/issues/${ownerTask}/children`).send({ title: "Child" });
    expect(childOfOwners.status).toBe(404);
    expect(childOfOwners.body).toEqual(missingChildParent.body);
    const own = await createTask(board(R), {});
    const before2 = before + 1;
    const childIntoOwners = await as(board(R)).post(`/api/issues/${own.body.id}/children`).send({ title: "Child", projectId: ownerProject });
    expect(childIntoOwners.status).toBe(404);
    expect(childIntoOwners.body).toEqual(missingProject.body);
    expect((await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length).toBe(before2);
  });

  it("AC-O5: O removes R from R's project; R loses the project and O's tasks in it, keeps his own", async () => {
    const project = await createProject(board(R));
    const mine = await createTask(board(R), { projectId: project.body.id });
    const owners = await createTask(board(O), { projectId: project.body.id });
    expect(await reads(board(R), "issues", owners.body.id)).toBe(200);

    const [row] = await db.select({ id: projectAccessMembers.id }).from(projectAccessMembers)
      .where(and(eq(projectAccessMembers.projectId, project.body.id), eq(projectAccessMembers.subjectId, R)));
    // R himself cannot drop his own owner row; O can.
    expect((await as(board(R)).delete(`/api/projects/${project.body.id}/access-members/${row!.id}`)).status).toBe(422);
    const removed = await as(board(O)).delete(`/api/projects/${project.body.id}/access-members/${row!.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    expect(await reads(board(R), "projects", project.body.id)).toBe(404);
    expect(await reads(board(R), "issues", owners.body.id)).toBe(404);
    expect(await reads(board(R), "issues", mine.body.id)).toBe(200);
    expect(await listedIds(board(R))).toContain(mine.body.id);
    expect(await listedIds(board(R))).not.toContain(owners.body.id);
  });

  it("an unflagged privacy owner's row stays unremovable (today's result)", async () => {
    const project = await createProject(board(O), { visibility: "private" });
    const [row] = await db.select({ id: projectAccessMembers.id }).from(projectAccessMembers)
      .where(and(eq(projectAccessMembers.projectId, project.body.id), eq(projectAccessMembers.subjectId, O)));
    const res = await as(board(O)).delete(`/api/projects/${project.body.id}/access-members/${row!.id}`);
    expect(res.status).toBe(422);
  });

  it("AC-O6: R moving his task into O's project or under O's task is refused, single and bulk; into his own project it succeeds", async () => {
    const first = await createTask(board(R), {});
    const second = await createTask(board(R), {});
    const missingProject = await as(board(R)).patch(`/api/issues/${first.body.id}`).send({ projectId: randomUUID() });
    const missingParent = await as(board(R)).patch(`/api/issues/${first.body.id}`).send({ parentId: randomUUID() });

    const single = await as(board(R)).patch(`/api/issues/${first.body.id}`).send({ projectId: ownerProject });
    expect(single.status).toBe(404);
    expect(single.body).toEqual(missingProject.body);
    const under = await as(board(R)).patch(`/api/issues/${first.body.id}`).send({ parentId: ownerTask });
    expect(under.status).toBe(404);
    expect(under.body).toEqual(missingParent.body);

    // Core has no bulk task update route: a bulk move is one update per task (the board and plugins do so).
    for (const patch of [{ projectId: ownerProject }, { parentId: ownerTask }, { projectId: ownerProject, parentId: ownerTask }]) {
      const results = await Promise.all([first, second].map((task) =>
        as(board(R)).patch(`/api/issues/${task.body.id}`).send(patch)));
      for (const res of results) expect(res.status, JSON.stringify(patch)).toBe(404);
    }
    for (const task of [first, second]) expect(await stored(task.body.id)).toEqual({ projectId: null, parentId: null });

    const own = await createProject(board(R));
    const moved = await as(board(R)).patch(`/api/issues/${first.body.id}`).send({ projectId: own.body.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await stored(first.body.id))!.projectId).toBe(own.body.id);
  });

  it("AC-O7: a plugin action R triggers creates a task that is his and readable to O", async () => {
    const pluginKey = "pib.test-creator-owned";
    const pluginId = `plugin-${randomUUID()}`;
    const services = buildHostServices(db, pluginId, pluginKey, createPluginEventBus());
    const manifest: PaperclipPluginManifestV1 = {
      id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Test plugin", description: "Test plugin",
      author: "Paperclip", categories: ["automation"], capabilities: ["issues.create"], entrypoints: { worker: "dist/worker.js" },
    };
    const handle = createPluginWorkerHandle(pluginKey, {
      entrypointPath: PLUGIN_WORKER,
      manifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: createHostClientHandlers({ pluginId, capabilities: manifest.capabilities, services }) as never,
    });
    try {
      await handle.start();
      // The plugin names O as the person; under rule H6 core uses the acting person.
      const created = await handle.call("performAction", {
        key: "create-task",
        params: {
          mode: "echo", hostMethod: "issues.create",
          nestedParams: { companyId, title: "From plugin", responsibleUserId: O, actorUserId: O },
        },
        actorContext: { type: "user", userId: R, agentId: null, runId: null, companyId },
        renderEnvironment: null,
      } as never) as { id: string };
      const [row] = await db.select({ createdByUserId: issues.createdByUserId, responsibleUserId: issues.responsibleUserId })
        .from(issues).where(eq(issues.id, created.id));
      expect(row).toEqual({ createdByUserId: R, responsibleUserId: R });
      expect(await listedIds(board(R))).toContain(created.id);
      expect(await reads(board(O), "issues", created.id)).toBe(200);
    } finally {
      await handle.stop().catch(() => undefined);
      services.dispose();
    }
  });

  describe("kill switch (AC-F8)", () => {
    it("with the variable exactly `off` and the column on enforce, create and move behave as mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const project = await createProject(board(R));
      expect(project.status).toBe(201);
      expect(await accessRows(project.body.id)).toEqual([]);
      expect((await createTask(board(R), { projectId: ownerProject })).status).toBe(201);
      const task = await createTask(board(R), {});
      expect((await as(board(R)).patch(`/api/issues/${task.body.id}`).send({ projectId: ownerProject, parentId: ownerTask })).status).toBe(200);

      await db.insert(projectAccessMembers).values({ companyId, projectId: project.body.id, subjectType: "user", subjectId: R });
      const [row] = await db.select({ id: projectAccessMembers.id }).from(projectAccessMembers)
        .where(eq(projectAccessMembers.projectId, project.body.id));
      expect((await as(board(O)).delete(`/api/projects/${project.body.id}/access-members/${row!.id}`)).status).toBe(422);
    });

    it.each(["false", "OFF "])("with the variable set to %j enforcement stays on", async (value) => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      expect((await createTask(board(R), { projectId: ownerProject })).status).toBe(404);
    });
  });

  describe("failing read (AC-X1)", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE and writes nothing when the resolver throws", async () => {
      const task = await createTask(board(R), {});
      const project = await createProject(board(R));
      const [row] = await db.select({ id: projectAccessMembers.id }).from(projectAccessMembers)
        .where(eq(projectAccessMembers.projectId, project.body.id));
      const projectCount = async () => (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))).length;
      const before = await projectCount();
      await breakResolverFor(R);
      try {
        const responses = [
          await createProject(board(R)),
          await createTask(board(R), { projectId: ownerProject }),
          await as(board(R)).patch(`/api/issues/${task.body.id}`).send({ projectId: ownerProject }),
          await as(board(O)).delete(`/api/projects/${project.body.id}/access-members/${row!.id}`),
        ];
        responses.forEach((res, index) => {
          expect(res.status, `request ${index}: ${JSON.stringify(res.body)}`).toBe(503);
          expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(res.body).not.toHaveProperty("id");
        });
        expect(await projectCount()).toBe(before);
        expect(await stored(task.body.id)).toEqual({ projectId: null, parentId: null });
        expect(await accessRows(project.body.id)).toEqual([`user:${R}`]);
      } finally {
        await repairResolverFor(R);
      }
    });
  });
});
