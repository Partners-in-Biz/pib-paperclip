import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, assets, authUsers, companies, companyMemberships, createDb, instanceUserRoles, issueAttachments,
  issues, projectAccessMembers, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { authorizationService, type AuthorizationAction, type AuthorizationActor, type AuthorizationResource } from "../services/authorization.js";
import { canActorReadAssetContent } from "../services/asset-content-access.js";
import { MEMBER_RESTRICTION_ACTION_LIST } from "../services/member-restriction/action-list.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12923 (stage C4a-3): the action list in the restriction step of
 * `decide()`. Spec PAR-12608 rev 3, 4.6 "The action list" and 4.3 place 2:
 * AC-G8 (every denied action is `deny_member_restricted` for R and for a run
 * working for R, the usual answer for U and O; the compile half is in
 * services/member-restriction/action-list.test.ts), the strict check repeated
 * for `tasks:assign` and `project:write_workspace`, plus this consumer's
 * kill-switch (AC-F8) and failing-read (AC-X1) tests and the scope callers (AC-G12).
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("action list database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const DENIED = (Object.keys(MEMBER_RESTRICTION_ACTION_LIST) as AuthorizationAction[])
  .filter((action) => MEMBER_RESTRICTION_ACTION_LIST[action] === "denied");

(support.supported ? describe : describe.skip)("member restriction action list in decide()", () => {
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
  const agentFor = (userId: string): AuthorizationActor =>
    ({ type: "agent", agentId, companyId, source: "agent_jwt", onBehalfOfUserId: userId });
  /** A resource of the shape each action's callers pass. */
  const resourceFor = (action: AuthorizationAction, company = companyId): AuthorizationResource => {
    if (action.startsWith("connections:")) return { type: "connection_management", companyId: company, operation: "list" };
    if (action.startsWith("agent") || action === "skill_config:update") return { type: "agent", companyId: company, agentId };
    return { type: "company", companyId: company };
  };
  const decide = (actor: AuthorizationActor, action: AuthorizationAction, resource = resourceFor(action)) =>
    authorizationService(db).decide({ actor, action, resource });
  const assign = (actor: AuthorizationActor, target: { issueId?: string; parentIssueId?: string; projectId?: string }) =>
    decide(actor, "tasks:assign", {
      type: "issue", companyId, issueId: target.issueId ?? null, parentIssueId: target.parentIssueId ?? null,
      projectId: target.projectId ?? null, assigneeAgentId: agentId, assigneeUserId: null,
    });
  const writeWorkspace = (actor: AuthorizationActor, projectId: string) =>
    decide(actor, "project:write_workspace", { type: "issue", companyId, projectId, assigneeAgentId: null });
  const setMode = (mode: "off" | "report" | "enforce", company = companyId) =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, company));
  const brief = (decision: { allowed: boolean; reason: string }) => ({ allowed: decision.allowed, reason: decision.reason });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-actions-");
    db = createDb(tempDb.connectionString);
    const [company, control] = await db.insert(companies).values([
      { name: "Restricted co", issuePrefix: `A${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Control co", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
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
    const [ownerOpen, createdByR] = await db.insert(issues).values([
      { companyId, title: "ownerOpen", createdByUserId: O },
      { companyId, title: "createdByR", createdByUserId: R },
    ]).returning();
    t.ownerOpen = ownerOpen!.id;
    t.createdByR = createdByR!.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("denied actions (AC-G8)", () => {
    it.each(DENIED)("%s is deny_member_restricted for R and for a run working for R", async (action) => {
      expect(await decide(board(R), action), "R").toMatchObject({ allowed: false, reason: "deny_member_restricted" });
      expect(await decide(agentFor(R), action), "run for R").toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    });

    it("gives U, O and a run working for O their usual answer for every denied action", async () => {
      const callers = [board(O), board(U), agentFor(O)];
      const enforced = [];
      for (const action of DENIED) for (const actor of callers) enforced.push(brief(await decide(actor, action)));
      await setMode("off");
      try {
        const usual = [];
        for (const action of DENIED) for (const actor of callers) usual.push(brief(await decide(actor, action)));
        expect(enforced).toEqual(usual);
        expect(enforced.some((decision) => decision.reason === "deny_member_restricted")).toBe(false);
        // The owner keeps the company-wide read.
        expect((await decide(board(O), "company_scope:read")).allowed).toBe(true);
      } finally {
        await setMode("enforce");
      }
    });

    it("does not refuse a run for R creating a top-level task, whose write asks company_scope:read inside decideBase", async () => {
      const decision = await decide(agentFor(R), "issue:mutate", {
        type: "issue", companyId, issueId: null, projectId: null, parentIssueId: null, assigneeAgentId: null, assigneeUserId: null,
      });
      expect(decision.allowed).toBe(true);
    });
  });

  describe("allowed actions that name a task or project (4.3 place 2)", () => {
    it("tasks:assign repeats the strict check on the task, the parent, or the project of a new top-level task", async () => {
      for (const actor of [board(R), agentFor(R)]) {
        expect(await assign(actor, { issueId: t.ownerOpen }), "other's task").toMatchObject({ allowed: false, reason: "deny_member_restricted" });
        expect(await assign(actor, { parentIssueId: t.ownerOpen }), "under other's task").toMatchObject({ reason: "deny_member_restricted" });
        expect(await assign(actor, { projectId: p.others }), "other's project").toMatchObject({ reason: "deny_member_restricted" });
        expect((await assign(actor, { issueId: t.createdByR })).allowed, "own task").toBe(true);
        expect((await assign(actor, { parentIssueId: t.createdByR })).allowed, "under own task").toBe(true);
        expect((await assign(actor, { projectId: p.mine })).allowed, "own project").toBe(true);
        expect((await assign(actor, {})).allowed, "no project").toBe(true);
      }
      for (const actor of [board(O), board(U)]) {
        expect((await assign(actor, { issueId: t.ownerOpen })).allowed).toBe(true);
        expect((await assign(actor, { projectId: p.others })).allowed).toBe(true);
      }
    });

    it("project:write_workspace repeats the strict check on the project", async () => {
      expect(await writeWorkspace(board(R), p.others!)).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
      expect((await writeWorkspace(board(R), p.mine!)).allowed).toBe(true);
      expect((await writeWorkspace(board(U), p.others!)).allowed).toBe(true);
    });
  });

  describe("asset content, a consumer of company_scope:read", () => {
    it("R reads an asset on his own task, not one on O's task or one tied to nothing", async () => {
      const asset = (name: string) => ({ companyId, provider: "local_disk", objectKey: `${companyId}/misc/${name}-${randomUUID()}`,
        contentType: "text/plain", byteSize: 1, sha256: "x", createdByUserId: O });
      const [onMine, onOthers, loose] = await db.insert(assets).values([asset("mine"), asset("others"), asset("loose")]).returning();
      await db.insert(issueAttachments).values([
        { companyId, issueId: t.createdByR!, assetId: onMine!.id },
        { companyId, issueId: t.ownerOpen!, assetId: onOthers!.id },
      ]);
      expect(await canActorReadAssetContent(db, board(R), onMine!)).toBe(true);
      expect(await canActorReadAssetContent(db, board(R), onOthers!)).toBe(false);
      expect(await canActorReadAssetContent(db, board(R), loose!)).toBe(false);
      for (const row of [onMine!, onOthers!, loose!]) expect(await canActorReadAssetContent(db, board(U), row)).toBe(true);
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await canActorReadAssetContent(db, board(R), loose!)).toBe(true);
    });
  });

  describe("scope callers (AC-G12)", () => {
    it("does not bind an instance admin who is not a member", async () => {
      expect(await decide(board(ADMIN), "company_scope:read")).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
    });

    it("binds R where he is restricted and not where he is owner", async () => {
      expect((await decide(board(R), "company_scope:read", resourceFor("company_scope:read", controlId))).allowed).toBe(true);
      expect((await decide(board(R), "users:invite", resourceFor("users:invite", controlId))).reason).not.toBe("deny_member_restricted");
      expect((await decide(board(R), "company_scope:read")).allowed).toBe(false);
    });
  });

  describe("report mode", () => {
    it("lets the call through and records one would-refuse entry for an action that would have passed", async () => {
      const R2 = `restricted-report-${randomUUID()}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: R2, status: "active", membershipRole: "operator", restricted: true });
      await setMode("report");
      try {
        expect((await decide(board(R2), "company_scope:read")).allowed).toBe(true);
        expect((await decide(board(R2), "company_scope:read")).allowed).toBe(true);
        expect((await assign(board(R2), { issueId: t.ownerOpen })).allowed).toBe(true);
        // A call refused anyway (no grant) records nothing for the action list.
        expect((await decide(board(R2), "users:invite")).reason).not.toBe("deny_member_restricted");
        const entries = (await db.select().from(activityLog).where(and(
          eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied"),
          eq(activityLog.responsibleUserId, R2),
        ))).map((row) => row.details as Record<string, unknown>);
        expect(entries.filter((entry) => entry.ruleId === "R-action")).toEqual([
          expect.objectContaining({ target: "company_scope:read", mode: "report" }),
        ]);
        expect(entries.filter((entry) => entry.ruleId === "R-read")).toEqual([
          expect.objectContaining({ target: "tasks:assign", objectId: t.ownerOpen, mode: "report" }),
        ]);
      } finally {
        await setMode("enforce");
      }
    });
  });

  describe("kill switch (AC-F8)", () => {
    it("with the variable exactly `off` and the column on enforce, behaves as mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect((await decide(board(R), "company_scope:read")).allowed).toBe(true);
      expect((await decide(agentFor(R), "company_scope:read")).allowed).toBe(true);
      expect((await assign(board(R), { issueId: t.ownerOpen })).allowed).toBe(true);
      expect((await writeWorkspace(board(R), p.others!)).allowed).toBe(true);
      expect((await decide(board(R), "agents:create")).reason).not.toBe("deny_member_restricted");
    });

    it.each(["false", "OFF "])("with the variable set to %j enforcement stays on", async (value) => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      expect(await decide(board(R), "company_scope:read")).toMatchObject({ reason: "deny_member_restricted" });
      expect(await assign(board(R), { issueId: t.ownerOpen })).toMatchObject({ reason: "deny_member_restricted" });
    });
  });

  describe("failing read (AC-X1)", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no data when the resolver throws", async () => {
      // A malformed list makes the resolver throw for R in this company.
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
        where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      try {
        const app = express();
        const route = (path: string, run: () => Promise<unknown>) => app.get(path, async (_req, res, next) => {
          try {
            res.json({ decision: await run(), secrets: ["secret"] });
          } catch (error) {
            next(error);
          }
        });
        route("/scope", () => decide(board(R), "company_scope:read"));
        route("/run-scope", () => decide(agentFor(R), "secrets:read"));
        route("/assign", () => assign(board(R), { issueId: t.ownerOpen }));
        app.use(errorHandler);
        for (const path of ["/scope", "/run-scope", "/assign"]) {
          const res = await request(app).get(path);
          expect(res.status, path).toBe(503);
          expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(res.body).not.toHaveProperty("secrets");
        }
        // An unflagged member is not affected.
        expect((await decide(board(U), "company_scope:read")).allowed).toBe(true);
      } finally {
        await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
          where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      }
    });
  });
});
