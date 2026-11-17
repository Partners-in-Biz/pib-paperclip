import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  plugins,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

type Db = ReturnType<typeof createDb>;
type Role = "owner" | "admin" | "operator" | "viewer";

const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction routes database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("member-restriction routes (PAR-12608 4.2)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let app: express.Express;
  let actor: Express.Request["actor"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-routes-");
    db = createDb(tempDb.connectionString);
    const [{ accessRoutes }, { companyRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/access.js"),
      import("../routes/companies.js"),
      import("../middleware/error-handler.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
    }));
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup() {
    const { accessService } = await import("../services/access.js");
    const access = accessService(db);
    const [company] = await db.insert(companies)
      .values({ name: "Restriction routes", issuePrefix: `MR${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [other] = await db.insert(companies)
      .values({ name: "Other", issuePrefix: `MO${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const member = async (role: Role, extra: Partial<typeof companyMemberships.$inferInsert> = {}) => {
      const principalId = `${role}-${randomUUID()}`;
      const [row] = await db.insert(companyMemberships).values({
        companyId: company!.id, principalType: "user", principalId, status: "active", membershipRole: role, ...extra,
      }).returning();
      await access.ensureRoleDefaultGrants(company!.id, principalId, role, null);
      return row!;
    };
    const agent = async (companyId: string, role = "worker") => (await db.insert(agents)
      .values({ companyId, name: `Agent ${randomUUID()}`, role, adapterType: "process", adapterConfig: {} })
      .returning())[0]!;
    await db.insert(plugins).values({ pluginKey: "crm", packageName: "@test/crm", version: "1.0.0", status: "ready",
      manifestJson: {} as never });
    return { access, company: company!, other: other!, member, agent };
  }

  function as(row: { principalId: string; membershipRole: string | null; companyId: string }, source: "session" | "mcp_oauth" = "session") {
    actor = {
      type: "board", userId: row.principalId, source, isInstanceAdmin: false, companyIds: [row.companyId],
      memberships: [{ companyId: row.companyId, membershipRole: row.membershipRole, status: "active" }],
    };
  }

  const restrictionPath = (companyId: string, memberId: string) => `/api/companies/${companyId}/members/${memberId}/restriction`;
  const entries = (action: string) => db.select().from(activityLog).where(eq(activityLog.action, action));

  it("AC-F3/AC-F5: an owner sets the flag and lists; one entry with old and new values; the members list returns them", async () => {
    const { company, member, agent } = await setup();
    const owner = await member("owner");
    const target = await member("operator");
    const helper = await agent(company.id);
    as(owner);

    const res = await request(app).put(restrictionPath(company.id, target.id))
      .send({ restricted: true, pluginKeys: ["crm"], agentIds: [helper.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restricted: true, restrictedPluginKeys: ["crm"], restrictedAgentIds: [helper.id] });

    const logged = await entries("company_member.restriction_changed");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({
      old: { restricted: false, pluginKeys: [], agentIds: [] },
      new: { restricted: true, pluginKeys: ["crm"], agentIds: [helper.id] },
    });

    const list = await request(app).get(`/api/companies/${company.id}/members`);
    expect(list.status).toBe(200);
    expect(list.body.members.find((entry: { id: string }) => entry.id === target.id))
      .toMatchObject({ restricted: true, restrictedPluginKeys: ["crm"], restrictedAgentIds: [helper.id] });
  });

  it("AC-F3: refuses (403) an operator, an admin without users:manage_permissions, an agent, an assistant connection and the person himself", async () => {
    const { company, member, agent } = await setup();
    const owner = await member("owner");
    const target = await member("operator");
    const body = { restricted: true, pluginKeys: [], agentIds: [] };

    as(await member("operator"));
    expect((await request(app).put(restrictionPath(company.id, target.id)).send(body)).status).toBe(403);
    as(await member("admin"));
    expect((await request(app).put(restrictionPath(company.id, target.id)).send(body)).status).toBe(403);
    const ceo = await agent(company.id, "ceo");
    actor = { type: "agent", agentId: ceo.id, companyId: company.id, source: "agent_key" };
    expect((await request(app).put(restrictionPath(company.id, target.id)).send(body)).status).toBe(403);
    as(owner, "mcp_oauth");
    expect((await request(app).put(restrictionPath(company.id, target.id)).send(body)).status).toBe(403);

    const selfManager = await member("admin");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: selfManager.principalId, permissionKey: "users:manage_permissions",
    });
    as(selfManager);
    expect((await request(app).put(restrictionPath(company.id, selfManager.id)).send({ ...body, restricted: false })).status).toBe(403);
    expect((await request(app).put(restrictionPath(company.id, target.id)).send(body)).status).toBe(200);
    expect(await entries("company_member.restriction_changed")).toHaveLength(1);
  });

  it("AC-F3: refuses (422) a flag on an owner or admin, an unknown plugin key and an agent of another company", async () => {
    const { company, other, member, agent } = await setup();
    as(await member("owner"));
    const otherOwner = await member("owner");
    const admin = await member("admin");
    const target = await member("operator");
    const foreign = await agent(other.id);

    for (const [memberId, body] of [
      [otherOwner.id, { restricted: true }],
      [admin.id, { restricted: true }],
      [target.id, { restricted: true, pluginKeys: ["not-installed"] }],
      [target.id, { restricted: true, agentIds: [foreign.id] }],
    ] as const) {
      const res = await request(app).put(restrictionPath(company.id, memberId)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    const rows = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, company.id));
    expect(rows.every((row) => row.restricted === false)).toBe(true);
    expect(await entries("company_member.restriction_changed")).toHaveLength(0);
  });

  it("AC-F4: making a flagged member owner or admin is refused (422, names the flag) in every place that changes a role", async () => {
    const { access, company, member } = await setup();
    as(await member("owner"));
    const flagged = await member("operator", { restricted: true });
    const base = `/api/companies/${company.id}/members/${flagged.id}`;

    for (const res of [
      await request(app).patch(base).send({ membershipRole: "admin" }),
      await request(app).patch(`${base}/role-and-grants`).send({ membershipRole: "owner", grants: [] }),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTED_ROLE" });
      expect(res.body.error).toMatch(/restrict/i);
    }
    // Invite acceptance by a person who is already a member.
    await expect(access.ensureMembership(company.id, "user", flagged.principalId, "admin", "active"))
      .rejects.toMatchObject({ status: 422 });
    // The instance admin's company-access route reactivating a flagged admin row (drifted data).
    const drifted = await member("admin", { restricted: true, status: "archived" });
    await expect(access.setUserCompanyAccess(drifted.principalId, [company.id])).rejects.toMatchObject({ status: 422 });
    // The /permissions route changes grants only, never the role.
    expect((await request(app).patch(`${base}/permissions`).send({ grants: [] })).status).toBe(200);

    const after = await db.select().from(companyMemberships).where(eq(companyMemberships.id, flagged.id));
    expect(after[0]).toMatchObject({ membershipRole: "operator", restricted: true });
    expect((await request(app).patch(base).send({ membershipRole: "viewer" })).status).toBe(200);
  });

  it("AC-F5/AC-F6: an owner changes the mode with the 7-day count; operator, admin and the CEO agent are refused; PATCH ignores the field", async () => {
    const { company, member, agent } = await setup();
    const owner = await member("owner");
    const modePath = `/api/companies/${company.id}/member-restriction-mode`;
    const denied = { companyId: company.id, actorType: "system", actorId: "member-restriction", action: "member_restriction.denied",
      entityType: "company", entityId: company.id };
    await db.insert(activityLog).values([
      { ...denied, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      { ...denied, createdAt: new Date(Date.now() - 60_000) },
      { ...denied, createdAt: new Date(Date.now() - 8 * 86_400_000) },
    ]);

    as(await member("operator"));
    expect((await request(app).put(modePath).send({ mode: "report" })).status).toBe(403);
    as(await member("admin"));
    expect((await request(app).put(modePath).send({ mode: "report" })).status).toBe(403);
    const ceo = await agent(company.id, "ceo");
    actor = { type: "agent", agentId: ceo.id, companyId: company.id, source: "agent_key" };
    expect((await request(app).put(modePath).send({ mode: "report" })).status).toBe(403);

    as(owner);
    const patched = await request(app).patch(`/api/companies/${company.id}`).send({ description: "x", memberRestrictionMode: "enforce" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const read = async () => (await db.select().from(companies).where(eq(companies.id, company.id)))[0]!.memberRestrictionMode;
    expect(await read()).toBe("off");

    const res = await request(app).put(modePath).send({ mode: "report" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ mode: "report", deniedLast7Days: 2 });
    expect(await read()).toBe("report");
    expect((await request(app).put(modePath).send({ mode: "report" })).status).toBe(200);
    const logged = await entries("company.member_restriction_mode_changed");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ oldMode: "off", newMode: "report", deniedLast7Days: 2 });
    expect((await request(app).put(modePath).send({ mode: "audit" })).status).toBe(400);
  });

  it("AC-F7: a denial writes a log line each time and one entry per person, rule and day, also under concurrency", async () => {
    const { company } = await setup();
    const { recordMemberRestrictionDenial } = await import("../services/member-restriction/index.js");
    const log = { warn: vi.fn(), error: vi.fn() };
    const denial = { companyId: company.id, personId: "user-flagged", ruleId: "R-read", target: "GET /issues/:id",
      objectId: "issue-1", mode: "report" as const };
    const count = async (ruleId: string) => (await entries("member_restriction.denied"))
      .filter((entry) => (entry.details as { ruleId?: string }).ruleId === ruleId).length;

    expect(await recordMemberRestrictionDenial(db, denial, { log })).toEqual({ recorded: true });
    expect(await recordMemberRestrictionDenial(db, { ...denial, objectId: "issue-2" }, { log })).toEqual({ recorded: false });
    expect(await count("R-read")).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0]![1]).toMatch(/would refuse/);

    await Promise.all(Array.from({ length: 5 }, () =>
      recordMemberRestrictionDenial(db, { ...denial, ruleId: "R-wake", mode: "enforce" }, { log })));
    expect(await count("R-wake")).toBe(1);

    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.action, "member_restriction.denied"), eq(activityLog.responsibleUserId, "user-flagged")));
    expect(entry!.details).toMatchObject({ personId: "user-flagged", target: "GET /issues/:id", mode: "report" });
    await db.update(activityLog).set({ createdAt: new Date(Date.now() - 86_400_000) });
    expect(await recordMemberRestrictionDenial(db, denial, { log })).toEqual({ recorded: true });
    expect(log.error).not.toHaveBeenCalled();
  });
});
