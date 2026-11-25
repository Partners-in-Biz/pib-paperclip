import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  issueAccessGrants,
  issues,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12725 (stage C3-3): the strict check in the `issue:read` / `project:read`
 * path of the base decision, the task writes that reach it, and the snapshot
 * path (`decideReads`). Spec PAR-12608 rev 3, section 4.3 places 2 and 3:
 * AC-L2, AC-L3 (decision half; the checkout route is tested by name in
 * `issue-closed-workspace-routes.test.ts`), AC-L6, AC-L8, plus this
 * consumer's kill-switch (AC-F8) and failing-read (AC-X1) tests and the scope
 * callers (AC-G12).
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("base decision database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("member restriction in the base decision", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let companyId = "";
  let controlId = "";
  let agentId = "";
  const t: Record<string, string> = {};
  const p: Record<string, string> = {};

  const board = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session" });
  const agentFor = (userId: string, extra: Partial<AuthorizationActor> = {}): AuthorizationActor =>
    ({ type: "agent", agentId, companyId, source: "agent_jwt", onBehalfOfUserId: userId, ...extra });
  const taskResource = (name: string, company = companyId) => ({
    type: "issue" as const, companyId: company, issueId: t[name]!, projectId: null as string | null,
    parentIssueId: null, assigneeAgentId: null, assigneeUserId: null, status: "todo",
  });
  const projectResource = (name: string) => ({ type: "project" as const, companyId, projectId: p[name]! });
  const decide = (actor: AuthorizationActor, action: "issue:read" | "issue:comment" | "issue:mutate", name: string) =>
    authorizationService(db).decide({ actor, action, resource: taskResource(name) });
  const readProject = (actor: AuthorizationActor, name: string) =>
    authorizationService(db).decide({ actor, action: "project:read", resource: projectResource(name) });
  const setMode = (mode: "off" | "report" | "enforce", company = companyId) =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, company));
  const denials = async () => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied"),
  ))).map((row) => row.details as Record<string, unknown>);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-base-");
    db = createDb(tempDb.connectionString);
    const [company, control] = await db.insert(companies).values([
      { name: "Restricted co", issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Control co", issuePrefix: `K${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    companyId = company!.id;
    controlId = control!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    // R is restricted here and owner of the control company (AC-G12).
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: controlId, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: controlId, principalType: "user", principalId: O, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(instanceUserRoles).values({ userId: ADMIN, role: "instance_admin" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Shared agent", role: "engineer", adapterType: "process" }).returning();
    agentId = agent!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member" });

    const [mine, others] = await db.insert(projects).values([
      { companyId, name: "Open project with R", visibility: "open" },
      { companyId, name: "Open project without R", visibility: "open" },
    ]).returning();
    p.mine = mine!.id;
    p.others = others!.id;
    await db.insert(projectAccessMembers).values({ companyId, projectId: p.mine, subjectType: "user", subjectId: R });

    const insertTask = async (name: string, values: Partial<typeof issues.$inferInsert>, company = companyId) => {
      const [row] = await db.insert(issues).values({ companyId: company, title: name, createdByUserId: O, ...values }).returning();
      t[name] = row!.id;
    };
    await insertTask("ownerOpen", {});
    await insertTask("ownerInOthersProject", { projectId: p.others });
    await insertTask("createdByR", { createdByUserId: R });
    // AC-L6: in R's open project (strict: his), but private and with no
    // implicit role or grant for R, so today's private rule refuses it.
    await insertTask("privateInMyProject", { projectId: p.mine, visibility: "private" });
    // AC-L6: R's own task that an owner made private stays readable.
    await insertTask("myPrivate", { createdByUserId: R, visibility: "private" });
    await insertTask("granted", {});
    await db.insert(issueAccessGrants).values({ issueId: t.granted!, subjectType: "user", subjectId: R, source: "explicit" });
    await insertTask("controlOpen", {}, controlId);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("single reads (AC-L2)", () => {
    it("denies R another person's open task and an open project he is not on, with deny_member_restricted", async () => {
      const task = await decide(board(R), "issue:read", "ownerOpen");
      expect(task).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
      const project = await readProject(board(R), "others");
      expect(project).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });

    it("allows R his own tasks and the open project he is an access member of", async () => {
      for (const name of ["createdByR", "granted", "myPrivate"]) {
        expect((await decide(board(R), "issue:read", name)).allowed, name).toBe(true);
      }
      expect((await readProject(board(R), "mine")).allowed).toBe(true);
    });

    it("leaves the owner and the unflagged operator as today", async () => {
      for (const actor of [board(O), board(U)]) {
        expect((await decide(actor, "issue:read", "ownerOpen")).allowed).toBe(true);
        expect((await readProject(actor, "others")).allowed).toBe(true);
      }
    });

    it("binds an agent run that works for R, through the base decision itself", async () => {
      const decision = await decide(agentFor(R), "issue:read", "ownerOpen");
      expect(decision).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });

    it("is governed by member_restriction_mode only, not PAPERCLIP_ISSUE_PRIVACY_MODE", async () => {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
      expect(await decide(board(R), "issue:read", "ownerOpen")).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });

    it("never widens the existing private rule (AC-L6)", async () => {
      const decision = await decide(board(R), "issue:read", "privateInMyProject");
      expect(decision).toMatchObject({ allowed: false, reason: "deny_issue_private" });
    });
  });

  describe("scope callers (AC-G12)", () => {
    it("does not bind an instance admin who is not a member", async () => {
      expect(await decide(board(ADMIN), "issue:read", "ownerOpen")).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
    });

    it("binds R where he is restricted and not where he is owner", async () => {
      const control = await authorizationService(db).decide({
        actor: board(R), action: "issue:read", resource: taskResource("controlOpen", controlId),
      });
      expect(control.allowed).toBe(true);
      expect((await decide(board(R), "issue:read", "ownerOpen")).allowed).toBe(false);
    });
  });

  describe("task writes (AC-L3)", () => {
    it.each(["issue:comment", "issue:mutate"] as const)("refuses R's board %s on another person's open task", async (action) => {
      expect(await decide(board(R), action, "ownerOpen")).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
      expect((await decide(board(U), action, "ownerOpen")).allowed).toBe(true);
    });

    it("refuses a standard agent run that works for R through its issue:read step", async () => {
      expect(await decide(agentFor(R), "issue:comment", "ownerOpen")).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });

    it.each(["issue:comment", "issue:mutate"] as const)("reaches the low-trust %s branch, which never asks issue:read", async (action) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, contextSnapshot: { executionPolicy: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [p.others] } },
      } } });
      const resource = { ...taskResource("ownerInOthersProject"), projectId: p.others! };
      const service = authorizationService(db);
      // The same run working for the unflagged operator is inside the boundary.
      const control = await service.decide({ actor: agentFor(U, { runId }), action: "issue:read", resource });
      expect(control).toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
      const decision = await service.decide({ actor: agentFor(R, { runId }), action, resource });
      expect(decision).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });
  });

  describe("snapshot path (AC-L8)", () => {
    it("decideReads returns not readable for R on O's open task and project, from one precomputed read", async () => {
      const resources = [
        taskResource("ownerOpen"), taskResource("createdByR"), projectResource("others"), projectResource("mine"),
      ];
      const forR = await authorizationService(db).decideReads(board(R), resources);
      expect(forR.map((decision) => [decision.allowed, decision.reason])).toEqual([
        [false, "deny_member_restricted"], [true, expect.any(String)], [false, "deny_member_restricted"], [true, expect.any(String)],
      ]);
      const forOwner = await authorizationService(db).decideReads(board(O), resources);
      expect(forOwner.every((decision) => decision.allowed)).toBe(true);
      const [forRAgain, forU] = await authorizationService(db).decideReadsForActors([board(R), board(U)], resources);
      expect(forRAgain!.map((decision) => decision.allowed)).toEqual([false, true, false, true]);
      expect(forU!.every((decision) => decision.allowed)).toBe(true);
    });
  });

  describe("report mode", () => {
    it("allows a restricted member and records one would-refuse entry", async () => {
      const R2 = `restricted-report-${randomUUID()}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: R2, status: "active", membershipRole: "operator", restricted: true });
      await setMode("report");
      try {
        expect((await decide(board(R2), "issue:read", "ownerOpen")).allowed).toBe(true);
        expect((await decide(board(R2), "issue:mutate", "ownerOpen")).allowed).toBe(true);
        const entries = (await denials()).filter((entry) => entry.personId === R2);
        expect(entries).toEqual([expect.objectContaining({ ruleId: "R-read", target: "issue:read", objectId: t.ownerOpen, mode: "report" })]);
      } finally {
        await setMode("enforce");
      }
    });
  });

  describe("kill switch (AC-F8)", () => {
    it("with the variable exactly `off` and the column on enforce, behaves as mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect((await decide(board(R), "issue:read", "ownerOpen")).allowed).toBe(true);
      expect((await decide(board(R), "issue:comment", "ownerOpen")).allowed).toBe(true);
      expect((await readProject(board(R), "others")).allowed).toBe(true);
      const reads = await authorizationService(db).decideReads(board(R), [taskResource("ownerOpen")]);
      expect(reads[0]!.allowed).toBe(true);
    });

    it.each(["false", "OFF "])("with the variable set to %j enforcement stays on", async (value) => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      expect((await decide(board(R), "issue:read", "ownerOpen")).allowed).toBe(false);
    });
  });

  describe("failing read (AC-X1)", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no data when the resolver throws", async () => {
      // A malformed list makes the resolver throw for R in this company.
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
        where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      try {
        const app = express();
        app.get("/task", async (_req, res, next) => {
          try {
            const decision = await decide(board(R), "issue:read", "ownerOpen");
            res.json({ decision, title: "secret" });
          } catch (error) {
            next(error);
          }
        });
        app.get("/reads", async (_req, res, next) => {
          try {
            res.json({ decisions: await authorizationService(db).decideReads(board(R), [taskResource("ownerOpen")]) });
          } catch (error) {
            next(error);
          }
        });
        app.use(errorHandler);
        for (const path of ["/task", "/reads"]) {
          const res = await request(app).get(path);
          expect(res.status, path).toBe(503);
          expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(res.body).not.toHaveProperty("title");
          expect(res.body).not.toHaveProperty("decisions");
        }
        // An unflagged member is not affected.
        expect((await decide(board(U), "issue:read", "ownerOpen")).allowed).toBe(true);
      } finally {
        await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
          where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      }
    });
  });
});
