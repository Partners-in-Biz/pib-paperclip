import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  activityLog, authUsers, companies, companyMemberships, companySecretBindings, createDb, projectAccessMembers, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { projectRoutes } from "../routes/projects.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { MEMBER_RESTRICTION_BODY_ALLOWLISTS, assertRestrictedBodyAllowed } from "../services/member-restriction/body-allowlist.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12934 (C4i-a): the body allowlist on `POST /api/companies/:companyId/projects`
 * and `PATCH /api/projects/:id`. Spec PAR-12608 rev 3, 4.5, 4.6, AC-F8, AC-X1.
 * Real routes and the real resolver.
 *
 * 1/2: the allowlist and its guard in both handlers. The rows stay `closed`
 * until 2/2, so this app mounts the routes without the route-table middleware.
 */

const support = await getEmbeddedPostgresTestSupport();

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

type Actor = Express.Request["actor"];
type Mode = "report" | "enforce" | "kill";
type Route = "create" | "patch";
const REFUSED = "403 MEMBER_RESTRICTED";

const iso = "2027-01-15T00:00:00.000Z";
const ENV_BODY = { env: { LOG_LEVEL: { type: "plain", value: "debug" } } };
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

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const U = `member-${randomUUID()}`;
  let Y = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const board = async (userId: string): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
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

  /** One call; returns the answer and whether anything was written. */
  const send = async (route: Route, body: Record<string, unknown>) => {
    const companyId = Y;
    const who = await board(R);
    const target = route === "patch" ? await oProject(companyId) : null;
    const before = await count(companyId);
    if (!target) {
      const res = await as(who).post(`/api/companies/${companyId}/projects`)
        .send({ name: `New ${randomUUID().slice(0, 8)}`, ...body });
      return { res, answer: answerOf(res), unchanged: JSON.stringify(await count(companyId)) === JSON.stringify(before) };
    }
    const res = await as(who).patch(`/api/projects/${target.id}`).send(body);
    const after = await readProject(target.id);
    return { res, answer: answerOf(res), after,
      unchanged: JSON.stringify(after) === JSON.stringify(target) && JSON.stringify(await count(companyId)) === JSON.stringify(before) };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-project-body-");
    db = createDb(tempDb.connectionString);
    const build = () => {
      const made = express();
      made.use(express.json());
      made.use((req, _res, next) => { req.actor = actor; next(); });
      made.use("/api", projectRoutes(db));
      made.use(errorHandler);
      return made;
    };
    app = build();
    const [y] = await db.insert(companies).values({ name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, U].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("whole-object writes: R cannot erase O's policy or env; ordinary patches keep them", async () => {
    await setMode("enforce");
    for (const body of [{ executionWorkspacePolicy: { enabled: false } }, { env: null }]) {
      const { answer, unchanged } = await send("patch", body);
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

  it.each(["create", "patch"] as Route[])("AC-X1, %s: a failed read answers 503 and writes nothing", async (route) => {
    const broken = (value: string) => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = ${value}::jsonb
      where company_id = ${Y} and principal_id = ${R}`);
    const req = { actor: await board(R), method: "PATCH", originalUrl: "/api/projects/x" } as unknown as express.Request;
    for (const mode of ["report", "enforce"] as const) {
      await setMode(mode);
      await broken("\"broken\"");
      try {
        for (const body of [{ name: "n" }, ENV_BODY]) {
          const { res, unchanged } = await send(route, body);
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
    const { answer, unchanged, after } = await send(route, ENV_BODY);
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
      const { answer } = await send("patch", { executionWorkspacePolicy: { enabled: false } });
      expect(answer).toBe("200");
      expect(await denials()).toHaveLength(1);
      expect(wouldRefuse()).toBe(expected);
    }
  });
});
