import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, createDb, heartbeatRuns, issues,
  projectAccessMembers, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { MEMBER_RESTRICTION_BODY_ALLOWLISTS, assertRestrictedBodyAllowed } from "../services/member-restriction/body-allowlist.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12934 (C4i-a): the body allowlist on `POST /api/companies/:companyId/projects`
 * and `PATCH /api/projects/:id`. Spec PAR-12608 rev 3, 4.5, 4.6, AC-G3, AC-F2,
 * AC-G12, AC-O2, AC-O3, AC-F8, AC-X1. Real routes, the real route-table
 * middleware and the real resolver.
 *
 * BASE (fixture file) holds the answers of `development` at 257905a86, before
 * this change, recorded with `PAR12934_RECORD=1` on that commit. Every cell
 * keeps that answer except a caller bound by R under `enforce`.
 */

const support = await getEmbeddedPostgresTestSupport();
const BASE_FILE = new URL("./fixtures/member-restriction-project-body-base.json", import.meta.url);
const RECORD = process.env.PAR12934_RECORD === "1";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("project body allowlist database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

it("schema tripwire: every key of each classified schema is in its map, and no allowed key is an object", () => {
  const unwrap = (field: z.ZodType): z.ZodType => field instanceof z.ZodOptional || field instanceof z.ZodNullable
    || field instanceof z.ZodDefault ? unwrap(field.unwrap() as z.ZodType) : field;
  for (const [key, { schema, fields }] of Object.entries(MEMBER_RESTRICTION_BODY_ALLOWLISTS)) {
    const classes: Record<string, string> = fields;
    expect(Object.keys(classes).sort(), key).toEqual(Object.keys(schema.shape).sort());
    for (const [name, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      // One level into objects: a key a bound caller may send carries no nested keys.
      const inner = unwrap(field);
      if (classes[name] !== "refused") expect(inner instanceof z.ZodObject || inner instanceof z.ZodRecord, `${key}.${name}`).toBe(false);
    }
  }
});

it("rows: create and patch are open with this file as their AC-G3 test", () => {
  for (const row of ["POST /api/companies/:companyId/projects", "PATCH /api/projects/:id"]) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry, row).toMatchObject({ class: "open", test: "server/src/__tests__/member-restriction-project-body-allowlist.test.ts" });
  }
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce" | "kill";
type Route = "create" | "patch";
/** R: restricted in Y, owner in X. U: member of Y, not restricted. agent: works for nobody. R-in-X: R on X's project. */
type Caller = "R" | "R-run" | "R-key" | "O" | "U" | "agent" | "admin" | "R-in-X";
const MODES: Mode[] = ["off", "report", "enforce", "kill"];
const CALLERS: Caller[] = ["R", "R-run", "R-key", "O", "U", "agent", "admin", "R-in-X"];
const BOUND: readonly Caller[] = ["R", "R-run", "R-key"];
const REFUSED = "403 MEMBER_RESTRICTED";

const iso = "2027-01-15T00:00:00.000Z";
/** label -> [body, refused for a bound caller]. Create bodies add a fresh `name`. */
const BODIES: Record<Route, Record<string, [Record<string, unknown>, boolean]>> = {
  create: {
    "name": [{}, false], "description": [{ description: "d" }, false], "status": [{ status: "planned" }, false],
    "color": [{ color: "#123456" }, false], "icon": [{ icon: "rocket" }, false], "targetDate": [{ targetDate: "2027-02-01" }, false],
    "goalId": [{ goalId: null }, false], "goalIds": [{ goalIds: [] }, false], "visibility": [{ visibility: "open" }, false],
    "archivedAt": [{ archivedAt: iso }, false], "idempotencyKey": [{ idempotencyKey: "KEY" }, false],
    "repositoryIds []": [{ repositoryIds: [] }, false], "repositoryUrls []": [{ repositoryUrls: [] }, false],
    "leadAgentId null": [{ leadAgentId: null }, false],
    "env": [{ env: { LOG_LEVEL: { type: "plain", value: "debug" } } }, true], "env null": [{ env: null }, true],
    "executionWorkspacePolicy": [{ executionWorkspacePolicy: { enabled: false } }, true],
    "workspace": [{ workspace: { name: "W", cwd: "/tmp/par-12934-workspace" } }, true],
    "leadAgentId": [{ leadAgentId: "AGENT" }, true], "repositoryIds [1]": [{ repositoryIds: ["1"] }, true],
    "repositoryUrls [1]": [{ repositoryUrls: ["https://github.com/acme/app"] }, true],
  },
  patch: {
    "name": [{ name: "Renamed" }, false], "description": [{ description: "d" }, false], "status": [{ status: "planned" }, false],
    "color": [{ color: "#123456" }, false], "icon": [{ icon: "rocket" }, false], "targetDate": [{ targetDate: "2027-02-01" }, false],
    "goalId": [{ goalId: null }, false], "goalIds": [{ goalIds: [] }, false], "visibility": [{ visibility: "open" }, false],
    "archivedAt set": [{ archivedAt: iso }, false], "archivedAt cleared": [{ archivedAt: null }, false],
    "leadAgentId null": [{ leadAgentId: null }, false],
    "env": [{ env: { LOG_LEVEL: { type: "plain", value: "debug" } } }, true], "env null": [{ env: null }, true],
    "executionWorkspacePolicy": [{ executionWorkspacePolicy: { enabled: false } }, true],
    "leadAgentId": [{ leadAgentId: "AGENT" }, true],
  },
};
const STORED_ENV = { KEEP: { type: "plain", value: "o" } };
const STORED_POLICY = { enabled: true, defaultMode: "shared_workspace" };

const answerOf = (res: request.Response) => {
  const code = res.body?.code ?? res.body?.details?.code;
  if (res.status < 300) return String(res.status);
  return `${res.status} ${code ?? res.body?.error ?? ""}`.trim();
};

(support.supported ? describe : describe.skip)("project create and patch body allowlist (PAR-12934)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const recorded: Record<string, string[]> = {};
  const base: Record<string, string[]> = RECORD ? {} : JSON.parse(readFileSync(BASE_FILE, "utf8"));

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const U = `member-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  let agentR = "";
  let agentPlain = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const board = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  const agentActor = async (agentId: string, person: string | null, withRun: boolean): Promise<Actor> => {
    const onBehalfOfMemberships = person ? await loadActorMemberships(db, { userId: person, activeOnly: true }) : [];
    if (!withRun) {
      return { type: "agent", agentId, companyId: Y, keyId: randomUUID(), source: "agent_key",
        onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
    }
    const [task] = await db.insert(issues).values({ companyId: Y, title: "Run task", status: "in_progress",
      createdByUserId: person ?? O, responsibleUserId: person, assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId, status: "running",
      responsibleUserId: person, contextSnapshot: { issueId: task!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, task!.id));
    return { type: "agent", agentId, companyId: Y, runId: run!.id, source: "agent_jwt",
      onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
  };
  const callerActor = (caller: Caller): Promise<Actor> => {
    switch (caller) {
      case "R": case "R-in-X": return board(R);
      case "R-run": return agentActor(agentR, R, true);
      case "R-key": return agentActor(agentR, R, false);
      case "O": return board(O);
      case "U": return board(U);
      case "agent": return agentActor(agentPlain, null, true);
      case "admin": return board(ADMIN, true);
    }
  };
  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode === "kill" ? "enforce" : mode });
    if (mode === "kill") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    else vi.unstubAllEnvs();
  };
  /** O's open project with R as access member and stored host configuration; fresh per call. */
  const oProject = async (companyId: string, privacyOwnerUserId = O) => {
    const [row] = await db.insert(projects).values({ companyId, name: `O ${randomUUID().slice(0, 8)}`, status: "backlog",
      privacyOwnerUserId, env: STORED_ENV, executionWorkspacePolicy: STORED_POLICY } as typeof projects.$inferInsert).returning();
    await db.insert(projectAccessMembers).values({ companyId, projectId: row!.id, subjectType: "user", subjectId: R });
    return row!;
  };
  const readProject = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0]!;
  const count = async (companyId: string) => ({
    projects: (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))).length,
    activity: (await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, companyId),
      sql`${activityLog.action} in ('project.created', 'project.updated')`))).length,
    bindings: (await db.select({ id: companySecretBindings.id }).from(companySecretBindings)
      .where(eq(companySecretBindings.companyId, companyId))).length,
  });
  const fill = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body)
    .replace("\"AGENT\"", JSON.stringify(agentPlain)).replace("\"KEY\"", JSON.stringify(randomUUID())));

  /** One call; returns the answer and whether anything was written. */
  const send = async (caller: Caller, route: Route, body: Record<string, unknown>) => {
    const companyId = caller === "R-in-X" ? X : Y;
    const who = await callerActor(caller);
    const target = route === "patch" ? await oProject(companyId) : null;
    const before = await count(companyId);
    if (!target) {
      const res = await as(who).post(`/api/companies/${companyId}/projects`)
        .send({ name: `New ${randomUUID().slice(0, 8)}`, ...fill(body) });
      return { res, answer: answerOf(res), unchanged: JSON.stringify(await count(companyId)) === JSON.stringify(before) };
    }
    const res = await as(who).patch(`/api/projects/${target.id}`).send(fill(body));
    const after = await readProject(target.id);
    return { res, answer: answerOf(res), after,
      unchanged: JSON.stringify(after) === JSON.stringify(target) && JSON.stringify(await count(companyId)) === JSON.stringify(before) };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-project-body-");
    db = createDb(tempDb.connectionString);
    const build = (guard: boolean) => {
      const made = express();
      made.use(express.json());
      made.use((req, _res, next) => { req.actor = actor; next(); });
      if (guard) made.use("/api", memberRestrictionRouteGuard(db));
      made.use("/api", projectRoutes(db));
      made.use("/api", issueRoutes(db, {} as never));
      made.use(errorHandler);
      return made;
    };
    app = build(true);
    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}` },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, U, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: X, principalType: "user", principalId: O, status: "active", membershipRole: "operator" },
    ]);
    const made = await db.insert(agents).values(["Agent of R", "Plain agent"].map((name) => ({
      companyId: Y, name, role: "engineer", adapterType: "process", status: "active",
    }))).returning();
    [agentR, agentPlain] = made.map((row) => row.id);
  }, 120_000);

  afterAll(async () => {
    if (RECORD) {
      const lines = Object.entries(recorded).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
      writeFileSync(BASE_FILE, `{\n${lines.join(",\n")}\n}\n`);
    }
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CALLERS)("caller %s", (caller) => {
    it.each(["create", "patch"] as Route[])("%s: every body in every mode", async (route) => {
      for (const [label, [body, refused]] of Object.entries(BODIES[route])) {
        const answers: string[] = [];
        for (const mode of MODES) {
          await setMode(mode);
          const { answer, unchanged, after } = await send(caller, route, body);
          answers.push(answer);
          if (RECORD) continue;
          const cell = `${caller} ${route} ${label} ${mode}`;
          if (mode === "enforce" && BOUND.includes(caller)) {
            if (refused) {
              expect(answer, cell).toBe(REFUSED);
              expect(unchanged, cell).toBe(true);
            } else {
              // Today's path: the `report` answer and the recorded one (the base row was closed).
              expect(answer, cell).toBe(answers[1]);
            }
            if (after) expect([after.env, after.executionWorkspacePolicy], cell).toEqual([STORED_ENV, STORED_POLICY]);
          } else if (mode === "enforce" && caller === "R-in-X") {
            // Owner in X: today's answer. The base row was closed (403); X is not enforced for him.
            expect(answer, cell).toBe(answers[0]);
          } else {
            expect(answer, cell).toBe(base[`${caller} ${route} ${label}`]?.[MODES.indexOf(mode)]);
          }
        }
        recorded[`${caller} ${route} ${label}`] = answers;
      }
    }, 300_000);
  });

  it("whole-object writes: R cannot erase O's policy or env; ordinary patches keep them", async () => {
    await setMode("enforce");
    for (const body of [{ executionWorkspacePolicy: { enabled: false } }, { env: null }]) {
      const { answer, unchanged } = await send("R", "patch", body);
      expect(answer, JSON.stringify(body)).toBe(REFUSED);
      expect(unchanged).toBe(true);
    }
    // R's own project whose host configuration O set: the UI's ordinary patch bodies.
    const mine = await oProject(Y, R);
    for (const body of [{ name: "N" }, { color: "#000000" }, { icon: "folder" }, { description: "x" },
      { visibility: "private" }, { visibility: "open" }, { archivedAt: iso }, { archivedAt: null }]) {
      const res = await as(await board(R)).patch(`/api/projects/${mine.id}`).send(body);
      expect(res.status, `${JSON.stringify(body)} ${JSON.stringify(res.body)}`).toBe(200);
      const after = await readProject(mine.id);
      expect([after.env, after.executionWorkspacePolicy]).toEqual([STORED_ENV, STORED_POLICY]);
    }
  });

  it("real bodies: NewProjectDialog (no repository: 201, readable to R, O and U; one repository: 403) and onboarding (201)", async () => {
    await setMode("enforce");
    const dialog = { name: `Dialog ${randomUUID().slice(0, 8)}`, color: "#6366f1", status: "planned", repositoryIds: [] };
    const made = await as(await board(R)).post(`/api/companies/${Y}/projects`).send(dialog);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    for (const person of [R, O, U]) {
      expect((await as(await board(person)).get(`/api/projects/${made.body.id}`)).status, person).toBe(200);
    }
    const withRepo = await as(await board(R)).post(`/api/companies/${Y}/projects`).send({ ...dialog, repositoryIds: ["42"] });
    expect(answerOf(withRepo)).toBe(REFUSED);
    const onboarding = await as(await board(R)).post(`/api/companies/${Y}/projects`)
      .send({ name: `Onboarding ${randomUUID().slice(0, 8)}`, status: "planned", goalIds: [] });
    expect(onboarding.status, JSON.stringify(onboarding.body)).toBe(201);
  });

  it("AC-O2 and AC-O3: R, and a run working for R, create a project and a task in it through the middleware", async () => {
    await setMode("enforce");
    const project = await as(await board(R)).post(`/api/companies/${Y}/projects`).send({ name: "AC-O2" });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const task = await as(await board(R)).post(`/api/companies/${Y}/issues`).send({ title: "AC-O2 task", projectId: project.body.id });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    for (const person of [R, O, U]) {
      expect((await as(await board(person)).get(`/api/issues/${task.body.id}`)).status, person).toBe(200);
    }

    const run = await agentActor(agentR, R, true);
    const runProject = await as(run).post(`/api/companies/${Y}/projects`).send({ name: "AC-O3" });
    expect(runProject.status, JSON.stringify(runProject.body)).toBe(201);
    const [runTask] = await db.select().from(issues).where(eq(issues.executionRunId, run.runId!));
    const child = await as(run).post(`/api/issues/${runTask!.id}/children`).send({ title: "AC-O3 child", projectId: runProject.body.id });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.responsibleUserId).toBe(R);
    expect((await as(await board(R)).get(`/api/projects/${runProject.body.id}`)).status).toBe(200);
    expect((await as(await board(R)).get(`/api/issues/${child.body.id}`)).status).toBe(200);
  });

  it.each(["create", "patch"] as Route[])("AC-X1, %s: a failed read answers 503 and writes nothing", async (route) => {
    const broken = (value: string) => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = ${value}::jsonb
      where company_id = ${Y} and principal_id = ${R}`);
    const req = { actor: await board(R), method: "PATCH", originalUrl: "/api/projects/x" } as unknown as express.Request;
    for (const mode of ["report", "enforce"] as const) {
      await setMode(mode);
      await broken("\"broken\"");
      try {
        for (const body of [BODIES[route].name![0], BODIES[route].env![0]]) {
          const { res, unchanged } = await send("R", route, body);
          expect(res.status, `${mode} ${JSON.stringify(res.body)}`).toBe(503);
          expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(unchanged).toBe(true);
        }
        // The guard's own read: a throw is never "not restricted", even for an allowed body.
        const schemaKey = route === "create" ? "createProject" : "updateProject";
        await expect(assertRestrictedBodyAllowed(db, req, Y, schemaKey, { name: "n" })).rejects.toMatchObject({ status: 503 });
      } finally {
        await broken("[]");
      }
    }
  });

  it.each(["create", "patch"] as Route[])("AC-F8, %s: the kill switch runs today's code (env written)", async (route) => {
    await setMode("kill");
    const { answer, unchanged, after } = await send("R", route, BODIES[route].env![0]);
    expect(answer).toBe(route === "create" ? "201" : "200");
    expect(unchanged).toBe(false);
    if (after) expect(after.env).toEqual({ LOG_LEVEL: { type: "plain", value: "debug" } });
  });

  it("report: R's refused body goes through, one denial entry a day, a log line each call", async () => {
    await setMode("report");
    const denials = () => db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, Y), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
      eq(activityLog.responsibleUserId, R), sql`${activityLog.details} ->> 'ruleId' = 'R-body'`));
    await db.delete(activityLog).where(and(eq(activityLog.companyId, Y), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION)));
    const warn = vi.spyOn(logger, "warn");
    const wouldRefuse = () => warn.mock.calls.filter(([detail, message]) => message === "member restriction would refuse"
      && (detail as { memberRestriction?: { ruleId?: string } }).memberRestriction?.ruleId === "R-body").length;
    for (const expected of [1, 2]) {
      const { answer } = await send("R", "patch", { executionWorkspacePolicy: { enabled: false } });
      expect(answer).toBe("200");
      expect(await denials()).toHaveLength(1);
      expect(wouldRefuse()).toBe(expected);
    }
  });
});
