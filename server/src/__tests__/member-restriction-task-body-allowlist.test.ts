import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, createDb, environments, heartbeatRuns,
  issues, projectAccessMembers, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS, restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12950 (C4i-b) 2/2: the body allowlist on task create, `/children` and patch.
 * The maps, the tripwire and the merge rules: member-restriction-task-body-keys.test.ts (1/2).
 * Spec PAR-12608 rev 3, 4.5, 4.6, AC-G3, AC-F2, AC-G12, AC-O3, AC-F8, AC-X1.
 * Real routes, the real route-table middleware and the real resolver. BASE
 * holds `development`'s answers before this change (`PAR12950_RECORD=1` with
 * the three route calls removed); every cell keeps them except a caller bound
 * by R under `enforce`.
 */

const support = await getEmbeddedPostgresTestSupport();
const BASE_FILE = new URL("./fixtures/member-restriction-task-body-base.json", import.meta.url);
const RECORD = process.env.PAR12950_RECORD === "1";
afterEach(() => vi.unstubAllEnvs());

describe("task body allowlist database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce" | "kill";
type Route = "create" | "children" | "patch";
type Caller = "R" | "R-run" | "R-key" | "O" | "U" | "agent" | "admin" | "R-in-X";
const MODES: Mode[] = ["off", "report", "enforce", "kill"];
const CALLERS: Caller[] = ["R", "R-run", "R-key", "O", "U", "agent", "admin", "R-in-X"];
const BOUND: readonly Caller[] = ["R", "R-run", "R-key"];
const REFUSED = "403 MEMBER_RESTRICTED";
const ROUTE_SCHEMA = { create: "createIssue", children: "createChildIssue", patch: "updateIssue" } as const;

const STORED_SETTINGS = { mode: "shared_workspace", environmentId: "@ENV", networkEgress: { allowFqdns: ["o.example"] },
  workspaceStrategy: { type: "git_worktree", provisionCommand: "make o" } };
const STORED_OVERRIDES = { adapterConfig: { model: "o-model", chrome: true } };
const STORED_POLICY = { mode: "normal", commentRequired: true, stages: [], authorizationPolicy: { trustPreset: "standard" } };
const settings = (extra: Record<string, unknown>) => ({ executionWorkspaceSettings: { mode: "shared_workspace", ...extra } });
const adapter = (adapterConfig: Record<string, unknown>) => ({ assigneeAdapterOverrides: { adapterConfig } });
/** label -> [body, refused for a bound caller]. Create bodies add a fresh title. */
const CREATE_BODIES: Record<string, [Record<string, unknown>, boolean]> = {
  "title": [{}, false], "plain": [{ description: "d", priority: "high", status: "todo" }, false],
  "model override": [adapter({ model: "m", effort: "high" }), false], "mode": [settings({}), false],
  "assignee self": [{ assigneeUserId: "@R" }, false],
  "chrome": [adapter({ chrome: true }), true], "env": [adapter({ env: { A: "b" } }), true],
  "environmentId": [settings({ environmentId: "@ENV" }), true],
  "egress": [settings({ networkEgress: { allowFqdns: ["r.example"] } }), true],
  "worktreeParentDir": [settings({ workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/tmp/r" } }), true],
  "authorizationPolicy": [{ executionPolicy: { authorizationPolicy: { trustPreset: "low_trust_review" } } }, true],
  "harnessKind": [{ harnessKind: "skill_test" }, true], "onboardingFirstTask": [{ onboardingFirstTask: true }, true],
  "executionWorkspaceId": [{ executionWorkspaceId: "@WS" }, false], "blockedByIssueIds": [{ blockedByIssueIds: ["@TASK"] }, true],
  "assignee O": [{ assigneeUserId: "@O" }, true],
};
const BODIES: Record<Route, Record<string, [Record<string, unknown>, boolean]>> = {
  create: CREATE_BODIES,
  children: CREATE_BODIES,
  patch: {
    "title": [{ title: "T" }, false], "mode only": [settings({}), false],
    "picker": [{ executionWorkspacePreference: "shared_workspace", executionWorkspaceId: null, ...settings({ environmentId: null }) }, false],
    "model override": [adapter({ model: "m" }), false],
    "settings null": [{ executionWorkspaceSettings: null }, true], "overrides null": [{ assigneeAdapterOverrides: null }, true],
    "policy null": [{ executionPolicy: null }, true], "chrome": [adapter({ chrome: false }), true],
    "env": [adapter({ env: { A: "b" } }), true], "egress": [settings({ networkEgress: { allowFqdns: ["r.example"] } }), true],
    "authorizationPolicy": [{ executionPolicy: { ...STORED_POLICY, authorizationPolicy: { trustPreset: "low_trust_review" } } }, true],
    "resume": [{ resume: true, comment: "go" }, false], "blockedByIssueIds": [{ blockedByIssueIds: ["@TASK"] }, true],
    "assignee O": [{ assigneeAgentId: null, assigneeUserId: "@O" }, true],
  },
};

const answerOf = (res: request.Response) => res.status < 300 ? String(res.status)
  : `${res.status} ${res.body?.code ?? res.body?.details?.code ?? res.body?.error ?? ""}`.trim();

(support.supported ? describe : describe.skip)("task create, children and patch body allowlist (PAR-12950)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const recorded: Record<string, string[]> = {};
  const base: Record<string, string[]> = RECORD ? {} : JSON.parse(readFileSync(BASE_FILE, "utf8"));
  const [O, R, U, ADMIN] = ["owner", "restricted", "member", "instance-admin"].map((name) => `${name}-${randomUUID()}`);
  let Y = "", X = "", agentR = "", agentPlain = "", envId = "", oTask = "";

  const as = (who: Actor) => { actor = who; return request(app); };
  const board = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  const agentActor = async (agentId: string, person: string | null, withRun: boolean): Promise<Actor> => {
    const onBehalfOfMemberships = person ? await loadActorMemberships(db, { userId: person, activeOnly: true }) : [];
    if (!withRun) return { type: "agent", agentId, companyId: Y, keyId: randomUUID(), source: "agent_key",
      onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
    const [task] = await db.insert(issues).values({ companyId: Y, title: "Run task", status: "in_progress",
      createdByUserId: person ?? O, responsibleUserId: person, assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId, status: "running",
      responsibleUserId: person, contextSnapshot: { issueId: task!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, task!.id));
    return { type: "agent", agentId, companyId: Y, runId: run!.id, source: "agent_jwt",
      onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
  };
  const callerActor = (caller: Caller): Promise<Actor> => ({
    "R": () => board(R), "R-in-X": () => board(R), "R-run": () => agentActor(agentR, R, true),
    "R-key": () => agentActor(agentR, R, false), "O": () => board(O), "U": () => board(U),
    "agent": () => agentActor(agentPlain, null, true), "admin": () => board(ADMIN, true),
  })[caller]();
  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode === "kill" ? "enforce" : mode });
    if (mode === "kill") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    else vi.unstubAllEnvs();
  };
  const fill = <T,>(body: T): T => JSON.parse(JSON.stringify(body).replaceAll("\"@ENV\"", JSON.stringify(envId))
    .replaceAll("\"@WS\"", JSON.stringify(randomUUID())).replaceAll("\"@TASK\"", JSON.stringify(oTask))
    .replaceAll("\"@O\"", JSON.stringify(O)).replaceAll("\"@R\"", JSON.stringify(R)));
  /** R's task (he is responsible, his agent is assigned) with O's stored host keys; fresh per call. */
  const rTask = async (companyId: string) => (await db.insert(issues).values({ companyId, title: "R's task", status: "todo",
    createdByUserId: O, responsibleUserId: R, assigneeAgentId: companyId === Y ? agentR : null,
    executionWorkspaceSettings: fill(STORED_SETTINGS), assigneeAdapterOverrides: STORED_OVERRIDES, executionPolicy: STORED_POLICY,
  } as typeof issues.$inferInsert).returning())[0]!;
  const readTask = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  /** An agent's target is a run's own task (an agent reads only its run's tree), with the same stored keys. */
  const targetTask = async (companyId: string, who: Actor) => {
    if (who.type !== "agent") return rTask(companyId);
    const runId = who.runId ?? (await agentActor(who.agentId!, who.onBehalfOfUserId ?? null, true)).runId!;
    const [task] = await db.update(issues).set({ executionWorkspaceSettings: fill(STORED_SETTINGS),
      assigneeAdapterOverrides: STORED_OVERRIDES, executionPolicy: STORED_POLICY } as Partial<typeof issues.$inferInsert>)
      .where(eq(issues.executionRunId, runId)).returning();
    return task!;
  };
  const count = async (companyId: string) => JSON.stringify([
    (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length,
    (await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, companyId),
      sql`${activityLog.action} in ('issue.created', 'issue.updated')`))).length,
    (await db.select({ id: companySecretBindings.id }).from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).length,
  ]);

  /** One call: the answer, whether anything was written, and the task after a patch. */
  const send = async (caller: Caller, route: Route, body: Record<string, unknown>, who?: Actor) => {
    const companyId = caller === "R-in-X" ? X : Y;
    const callerIs = who ?? await callerActor(caller);
    const target = route === "create" ? null : await targetTask(companyId, callerIs);
    const before = await count(companyId);
    const res = route === "patch" ? await as(callerIs).patch(`/api/issues/${target!.id}`).send(fill(body))
      : await as(callerIs).post(route === "create" ? `/api/companies/${companyId}/issues` : `/api/issues/${target!.id}/children`)
        .send({ title: `New ${randomUUID().slice(0, 8)}`, ...fill(body) });
    const after = target ? await readTask(target.id) : null;
    const unchanged = (await count(companyId)) === before && JSON.stringify(after) === JSON.stringify(target);
    return { res, answer: answerOf(res), unchanged, after };
  };
  const expectStoredKept = (after: typeof issues.$inferSelect | null, cell: string) => {
    if (!after) return;
    // Not `environmentId`: today's patch drops it for every caller (`services/issues.ts`, parse without
    // `includeEnvironmentId`); R setting another one is refused above.
    expect(after.executionWorkspaceSettings, cell).toMatchObject({ networkEgress: { allowFqdns: ["o.example"] },
      workspaceStrategy: { type: "git_worktree", provisionCommand: "make o" } });
    expect(after.assigneeAdapterOverrides, cell).toMatchObject({ adapterConfig: { chrome: true } });
    expect(after.executionPolicy, cell).toMatchObject({ authorizationPolicy: STORED_POLICY.authorizationPolicy });
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-task-body-");
    db = createDb(tempDb.connectionString);
    // Without it the service drops every workspace key and the whole-object cases prove nothing.
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", memberRestrictionRouteGuard(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const [y, x] = await db.insert(companies).values(["Y", "X"].map((name) => ({
      name, issuePrefix: `${name}${randomUUID().slice(0, 6).toUpperCase()}` }))).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, U, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: X, principalType: "user", principalId: O, status: "active", membershipRole: "operator" },
    ]);
    [agentR, agentPlain] = (await db.insert(agents).values(["Agent of R", "Plain agent"].map((name) => ({
      companyId: Y, name, role: "engineer", adapterType: "process", status: "active" }))).returning()).map((row) => row.id);
    envId = (await db.insert(environments).values({ name: "O's box", driver: "ssh", status: "active",
      config: { host: "o.example", username: "o" } }).returning())[0]!.id;
    oTask = (await db.insert(issues).values({ companyId: Y, title: "O's task", status: "todo", createdByUserId: O })
      .returning())[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (RECORD) writeFileSync(BASE_FILE, `{\n${Object.entries(recorded).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n}\n`);
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CALLERS)("caller %s", (caller) => {
    it.each(["create", "children", "patch"] as Route[])("%s: every body in every mode", async (route) => {
      const fields = MEMBER_RESTRICTION_TASK_BODY_ALLOWLISTS[ROUTE_SCHEMA[route]].fields;
      for (const [label, [body, refusedKey]] of Object.entries(BODIES[route])) {
        // A key the route's schema strips (a create-only key on `/children`) never reaches the guard.
        const refused = refusedKey && Object.keys(body).every((key) => key in fields);
        const answers: string[] = [];
        for (const mode of MODES) {
          await setMode(mode);
          const { answer, unchanged, after } = await send(caller, route, body);
          answers.push(answer);
          if (RECORD) continue;
          const cell = `${caller} ${route} ${label} ${mode}`;
          if (mode === "enforce" && BOUND.includes(caller)) {
            if (refused) {
              // An earlier check that already refuses today keeps its answer; nothing is written either way.
              const today = base[`${caller} ${route} ${label}`]?.[0] ?? "";
              if (/^2/.test(today)) expect(answer, cell).toBe(REFUSED);
              else expect([REFUSED, today], cell).toContain(answer);
              expect(unchanged, cell).toBe(true);
            } else expect(answer, cell).toBe(answers[1]);
            if (answer === "200") expectStoredKept(after, cell);
          } else expect(answer, cell).toBe(base[`${caller} ${route} ${label}`]?.[MODES.indexOf(mode)]);
        }
        recorded[`${caller} ${route} ${label}`] = answers;
      }
    }, 600_000);
  });

  it("whole objects: the picker, mode-only, monitor-cancel and overrides bodies keep O's stored keys", async () => {
    await setMode("enforce");
    const r = await board(R);
    // A strategy without its `type` would parse to no strategy and drop O's command (Vera, PAR-12950).
    for (const body of [BODIES.patch.picker![0], BODIES.patch["mode only"]![0], adapter({ model: "r-model" }),
      settings({ workspaceStrategy: { baseRef: "x" } }), settings({ workspaceStrategy: null })]) {
      const { answer, after } = await send("R", "patch", body, r);
      expect(answer, JSON.stringify(body)).toBe("200");
      expectStoredKept(after, JSON.stringify(body));
    }
    // IssueDetail.tsx:4930 after a read without `authorizationPolicy` (C4i-c).
    const { authorizationPolicy: _hidden, ...stripped } = STORED_POLICY;
    const cancel = await send("R", "patch", { expectedExecutionPolicy: stripped, executionPolicy: { ...stripped, mode: "normal" } }, r);
    expect(cancel.answer, JSON.stringify(cancel.res.body)).toBe("200");
    expect(cancel.after!.executionPolicy).toMatchObject({ authorizationPolicy: STORED_POLICY.authorizationPolicy });
    expect(cancel.after!.assigneeAdapterOverrides).toEqual(STORED_OVERRIDES);
  });

  it("real bodies: NewIssueDialog (201; chrome 403), the re-issue body (201), AC-O3 children of a run for R", async () => {
    await setMode("enforce");
    const dialog = { title: "Dialog", description: "d", status: "todo", priority: "medium", idempotencyKey: randomUUID(),
      executionWorkspacePreference: "shared_workspace", ...settings({}), ...adapter({ model: "claude-x", effort: "high" }) };
    expect(answerOf(await as(await board(R)).post(`/api/companies/${Y}/issues`).send(dialog))).toBe("201");
    const chrome = { ...dialog, idempotencyKey: randomUUID(), ...adapter({ model: "claude-x", chrome: true }) };
    expect(answerOf(await as(await board(R)).post(`/api/companies/${Y}/issues`).send(chrome))).toBe(REFUSED);
    // A worktree needs a project (today's 422 without one): R's own project.
    const [project] = await db.insert(projects).values({ companyId: Y, name: "R's project", status: "backlog" }).returning();
    await db.insert(projectAccessMembers).values({ companyId: Y, projectId: project!.id, subjectType: "user", subjectId: R });
    const reissue = { title: "Re-issue (isolated): T", description: "d", priority: "medium", projectId: project!.id, parentId: null,
      assigneeAgentId: null, executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", baseRef: "main" } } };
    const made = await as(await board(R)).post(`/api/companies/${Y}/issues`).send(reissue);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const run = await agentActor(agentR, R, true);
    const [runTask] = await db.select().from(issues).where(eq(issues.executionRunId, run.runId!));
    const child = await as(run).post(`/api/issues/${runTask!.id}/children`).send({ title: "AC-O3 child" });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    const viaCreate = await as(run).post(`/api/companies/${Y}/issues`).send({ title: "AC-O3 create", parentId: runTask!.id });
    expect(viaCreate.status, JSON.stringify(viaCreate.body)).toBe(201);
  });

  it("checked elsewhere: each key keeps the answer of the check that already binds R", async () => {
    await setMode("enforce");
    const [oProject] = await db.insert(projects).values({ companyId: Y, name: "O's project", status: "backlog" }).returning();
    const cases: [Route, Record<string, unknown>, string][] = [
      ["create", { projectId: oProject!.id }, "404 Project not found"],
      ["create", { parentId: oTask }, "404 Parent issue not found"],
      ["create", { assigneeAgentId: agentPlain }, "403 agent_not_listed"],
      ["create", { responsibleUserId: O }, "422 RESPONSIBLE_PERSON_NOT_SELF"],
      ["create", { createdByUserId: O }, "201"],
      ["children", { blockParentUntilDone: true }, "201"],
      ["patch", { onBehalfOfUserId: O, comment: "c" }, "200"],
      ["patch", { attachmentIds: [randomUUID()], comment: "c" }, "422 Comment attachments must belong to the same task and company"],
      ["patch", { executionPolicy: { ...STORED_POLICY, stages: [{ type: "review", participants: [{ type: "user", userId: O }] }] } },
        REFUSED],
    ];
    for (const [route, body, expected] of cases) {
      const { answer, res } = await send("R", route, body, await board(R));
      expect(answer, `${route} ${JSON.stringify(body)} ${JSON.stringify(res.body)}`).toBe(expected);
      if (route === "create" && answer === "201") expect(res.body.createdByUserId).toBe(R);
    }
  });

  it.each(["create", "children", "patch"] as Route[])("AC-X1, %s: a failed read answers 503 and writes nothing", async (route) => {
    const broken = (value: string) => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = ${value}::jsonb
      where company_id = ${Y} and principal_id = ${R}`);
    const req = { actor: await board(R), method: "PATCH", originalUrl: "/api/issues/x" } as unknown as express.Request;
    for (const mode of ["report", "enforce"] as const) {
      await setMode(mode);
      await broken("\"broken\"");
      try {
        const { res, unchanged } = await send("R", route, BODIES[route].title![0]);
        expect(res.status, `${mode} ${JSON.stringify(res.body)}`).toBe(503);
        expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
        expect(unchanged).toBe(true);
        await expect(restrictedTaskBody(db, req, Y, "updateIssue", { title: "t" }, null)).rejects.toMatchObject({ status: 503 });
      } finally {
        await broken("[]");
      }
    }
  });

  it.each(["create", "children", "patch"] as Route[])("AC-F8, %s: the kill switch runs today's code", async (route) => {
    await setMode("kill");
    const { answer, unchanged } = await send("R", route, BODIES[route].env![0]);
    expect(answer).toBe(route === "patch" ? "200" : "201");
    expect(unchanged).toBe(false);
  });
});
