import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, authUsers, companies, companyMemberships, createDb, executionWorkspaces, issues, projectAccessMembers,
  projects, projectWorkspaces,
} from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13309 (C4i-b2): read-checked task references and plugin task writes for
 * a restricted member R. A reference to O's task, workspace or project answers
 * today's not-found body and writes nothing; R's own gets today's answer (the
 * same body under mode `off`). Spec PAR-12608 rev 3, 4.5, 4.6, AC-G3, AC-F8, AC-X1.
 */

const support = await getEmbeddedPostgresTestSupport();
afterEach(() => vi.unstubAllEnvs());

describe("task reference database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce" | "kill";

(support.supported ? describe : describe.skip)("task references and plugin task writes (PAR-13309)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const [O, R] = ["owner", "restricted"].map((name) => `${name}-${randomUUID()}`);
  let Y = "";
  const ids = { oTask: "", rTask: "", oProject: "", rProject: "", oPW: "", rPW: "", oEW: "", rEW: "" };
  const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never;
  const host = () => buildHostServices(db, `plugin-${randomUUID()}`, "pib.test", eventBus).issues;
  const forR = { invocationScope: { companyId: "", actingPersonId: R } };

  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode === "kill" ? "enforce" : mode }).where(eq(companies.id, Y));
    if (mode === "kill") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    else vi.unstubAllEnvs();
  };
  const boardR = async (): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId: R, activeOnly: true });
    return { type: "board", userId: R, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  /** R's task with a stored workspace; fresh per call. */
  const rTask = async (executionWorkspaceId: string | null = null) => (await db.insert(issues).values({ companyId: Y,
    title: "R's task", status: "todo", createdByUserId: O, responsibleUserId: R, projectId: ids.rProject,
    executionWorkspaceId }).returning())[0]!;
  const readTask = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const count = async () => JSON.stringify([
    (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, Y))).length,
    (await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, Y),
      sql`${activityLog.action} in ('issue.created', 'issue.updated')`))).length,
  ]);
  const answerOf = (res: request.Response) => res.status < 300 ? String(res.status)
    : `${res.status} ${res.body?.code ?? res.body?.details?.code ?? res.body?.error ?? ""}`.trim();
  /** One route call as R: the answer and whether anything was written. */
  const send = async (route: "create" | "patch", body: Record<string, unknown>, stored: string | null = null) => {
    actor = await boardR();
    const target = route === "patch" ? await rTask(stored) : null;
    const before = await count();
    const res = route === "patch" ? await request(app).patch(`/api/issues/${target!.id}`).send(body)
      : await request(app).post(`/api/companies/${Y}/issues`).send({ title: `New ${randomUUID().slice(0, 8)}`, ...body });
    const unchanged = (await count()) === before
      && (!target || JSON.stringify(await readTask(target.id)) === JSON.stringify(target));
    return { answer: answerOf(res), unchanged };
  };
  /** R's own references: under `enforce` the same answer as today's code (mode `off`). */
  const expectToday = async (route: "create" | "patch", body: Record<string, unknown>, stored: string | null = null) => {
    await setMode("off");
    const today = (await send(route, body, stored)).answer;
    await setMode("enforce");
    expect((await send(route, body, stored)).answer, `${route} ${JSON.stringify(body)}`).toBe(today);
  };
  const pluginRefusal = async (call: () => Promise<unknown>, status: number, detail: Record<string, unknown>) => {
    const before = await count();
    await expect(call()).rejects.toMatchObject({ status, ...detail });
    expect(await count()).toBe(before);
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-task-references-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", memberRestrictionRouteGuard(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    Y = (await db.insert(companies).values({ name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning())[0]!.id;
    forR.invocationScope.companyId = Y;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    [ids.oProject, ids.rProject] = (await db.insert(projects).values(["O's project", "R's project"].map((name) => ({
      companyId: Y, name, status: "backlog" }))).returning()).map((row) => row.id) as [string, string];
    await db.insert(projectAccessMembers).values({ companyId: Y, projectId: ids.rProject, subjectType: "user", subjectId: R });
    [ids.oPW, ids.rPW] = (await db.insert(projectWorkspaces).values([ids.oProject, ids.rProject].map((projectId) => ({
      companyId: Y, projectId, name: "Checkout", cwd: "/tmp/checkout" }))).returning()).map((row) => row.id) as [string, string];
    ids.oTask = (await db.insert(issues).values({ companyId: Y, title: "O's task", status: "todo", createdByUserId: O,
      projectId: ids.oProject }).returning())[0]!.id;
    ids.rTask = (await rTask()).id;
    [ids.oEW, ids.rEW] = (await db.insert(executionWorkspaces).values([[ids.oTask, ids.oProject], [ids.rTask, ids.rProject]]
      .map(([sourceIssueId, projectId]) => ({ companyId: Y, projectId, sourceIssueId, mode: "shared_workspace",
        strategyType: "project_primary", name: "Workspace", cwd: "/tmp/checkout" }))).returning())
      .map((row) => row.id) as [string, string];
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("a reference to O's task, workspace or project: today's not-found body, nothing written", async () => {
    await setMode("enforce");
    const cases: ["create" | "patch", Record<string, unknown>, string][] = [
      ["create", { inheritExecutionWorkspaceFromIssueId: ids.oTask }, "404 Workspace inheritance issue not found"],
      ["create", { executionWorkspaceId: ids.oEW }, "404 Execution workspace not found"],
      ["create", { workspaceSelection: { kind: "existing", workspaceId: ids.oEW } }, "404 Execution workspace not found"],
      ["create", { projectId: ids.rProject, projectWorkspaceId: ids.oPW }, "404 Project workspace not found"],
      ["create", { projectId: ids.rProject, workspaceSelection: { kind: "configured_source", projectWorkspaceId: ids.oPW,
        mode: "shared" } }, "404 Project workspace not found"],
      ["patch", { executionWorkspaceId: ids.oEW }, "404 Execution workspace not found"],
      ["patch", { projectWorkspaceId: ids.oPW }, "404 Project workspace not found"],
    ];
    for (const [route, body, expected] of cases) {
      const { answer, unchanged } = await send(route, body);
      expect(answer, `${route} ${JSON.stringify(body)}`).toBe(expected);
      expect(unchanged, `${route} ${JSON.stringify(body)}`).toBe(true);
    }
  });

  it("R's own references and the stored workspace keep today's answer", async () => {
    await expectToday("create", { inheritExecutionWorkspaceFromIssueId: ids.rTask });
    await expectToday("create", { executionWorkspaceId: ids.rEW });
    await expectToday("create", { workspaceSelection: { kind: "existing", workspaceId: ids.rEW } });
    await expectToday("create", { projectId: ids.rProject, projectWorkspaceId: ids.rPW });
    await expectToday("create", { projectId: ids.rProject,
      workspaceSelection: { kind: "configured_source", projectWorkspaceId: ids.rPW, mode: "shared" } });
    await expectToday("patch", { executionWorkspaceId: ids.rEW });
    await expectToday("patch", { projectWorkspaceId: ids.rPW });
    // O's workspace already stored on R's task: sending it back is today's answer.
    await expectToday("patch", { executionWorkspaceId: ids.oEW }, ids.oEW);
  });

  it("plugin task writes for R: host keys refused, references read-checked, plain fields today's answer", async () => {
    await setMode("enforce");
    const env = { assigneeAdapterOverrides: { adapterConfig: { env: { A: "b" } } } };
    await pluginRefusal(() => host().create({ companyId: Y, title: "Env", ...env } as never, forR), 403,
      { details: { code: MEMBER_RESTRICTED_CODE } });
    await pluginRefusal(() => host().create({ companyId: Y, title: "Inherit",
      inheritExecutionWorkspaceFromIssueId: ids.oTask } as never, forR), 404, { message: "Workspace inheritance issue not found" });
    await pluginRefusal(() => host().create({ companyId: Y, title: "Workspace", executionWorkspaceId: ids.oEW } as never, forR),
      404, { message: "Execution workspace not found" });
    await pluginRefusal(() => host().create({ companyId: Y, title: "Checkout", projectId: ids.rProject,
      projectWorkspaceId: ids.oPW } as never, forR), 404, { message: "Project workspace not found" });
    const made = await host().create({ companyId: Y, title: "Plain", description: "d", priority: "high" } as never, forR);
    expect(made).toMatchObject({ title: "Plain" });
    const task = await rTask();
    await pluginRefusal(() => host().update({ companyId: Y, issueId: task.id, patch: env } as never, forR), 403,
      { details: { code: MEMBER_RESTRICTED_CODE } });
    expect(await readTask(task.id)).toEqual(task);
    expect(await host().update({ companyId: Y, issueId: task.id, patch: { title: "Renamed" } } as never, forR))
      .toMatchObject({ title: "Renamed" });
    // No acting person: today's answer.
    expect(await host().create({ companyId: Y, title: "Job", ...env } as never, { invocationScope: { companyId: Y } }))
      .toMatchObject({ title: "Job" });
  });

  it("AC-F8: the kill switch and mode report run today's plugin code", async () => {
    for (const mode of ["kill", "report"] as const) {
      await setMode(mode);
      const made = await host().create({ companyId: Y, title: `Env ${mode}`,
        assigneeAdapterOverrides: { adapterConfig: { env: { A: "b" } } } } as never, forR);
      expect(made.assigneeAdapterOverrides, mode).toMatchObject({ adapterConfig: { env: { A: "b" } } });
    }
  });

  it("AC-X1: a failed read answers the plugin call 503 and writes nothing", async () => {
    const broken = (value: string) => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = ${value}::jsonb
      where company_id = ${Y} and principal_id = ${R}`);
    const task = await rTask();
    for (const mode of ["report", "enforce"] as const) {
      await setMode(mode);
      await broken("\"broken\"");
      try {
        await pluginRefusal(() => host().create({ companyId: Y, title: "Plain" } as never, forR), 503, {});
        await pluginRefusal(() => host().update({ companyId: Y, issueId: task.id, patch: { title: "T" } } as never, forR), 503, {});
        expect(await readTask(task.id)).toEqual(task);
      } finally {
        await broken("[]");
      }
    }
  });
});
