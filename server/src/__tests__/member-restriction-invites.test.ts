import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  invites,
  joinRequests,
  plugins,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { MemberRestrictionResolver } from "../services/member-restriction/resolver.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

type Db = ReturnType<typeof createDb>;
type Role = "owner" | "admin" | "operator" | "viewer";
type Mode = "off" | "report" | "enforce";

const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction invites database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("restricted invites and join requests (PAR-12608 4.2a)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let app: express.Express;
  let actor: Express.Request["actor"];
  let failingResolver: MemberRestrictionResolver | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-invites-");
    db = createDb(tempDb.connectionString);
    const [{ accessRoutes }, { errorHandler }, { memberRestrictionResolver }] = await Promise.all([
      import("../routes/access.js"),
      import("../middleware/error-handler.js"),
      import("../services/member-restriction/resolver.js"),
    ]);
    const real = memberRestrictionResolver(db);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
      memberRestrictionResolver: (personId, companyId) => (failingResolver ?? real)(personId, companyId),
    }));
    app.use(errorHandler);
  }, 60_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    failingResolver = null;
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(mode: Mode = "enforce") {
    const { accessService } = await import("../services/access.js");
    const access = accessService(db);
    const company = async (companyMode: Mode) => (await db.insert(companies).values({
      name: "Invites", issuePrefix: `MI${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: companyMode,
    }).returning())[0]!;
    const main = await company(mode);
    const member = async (role: Role, extra: Partial<typeof companyMemberships.$inferInsert> = {}, companyId = main.id) => {
      const principalId = extra.principalId ?? `${role}-${randomUUID()}`;
      const [row] = await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId, status: "active", membershipRole: role, ...extra,
      }).returning();
      await access.ensureRoleDefaultGrants(companyId, principalId, role, null);
      return row!;
    };
    await db.insert(plugins).values({ pluginKey: "crm", packageName: "@test/crm", version: "1.0.0", status: "ready",
      manifestJson: {} as never });
    return { access, company: main, newCompany: company, member };
  }

  /** Signed-in person; memberships built by hand without the restriction fields, so the resolver reads the database. */
  function as(userId: string, companyIds: string[] = []) {
    actor = {
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds,
      memberships: companyIds.map((companyId) => ({ companyId, status: "active" })) as never,
    };
  }

  const createInvite = (companyId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/companies/${companyId}/invites`).send({ allowedJoinTypes: "human", humanRole: "operator", ...body });
  const grantInvite = (companyId: string, principalId: string) => db.insert(principalPermissionGrants)
    .values({ companyId, principalType: "user", principalId, permissionKey: "users:invite" }).onConflictDoNothing();

  it("AC-I8 (lists): the invite list and the join-request list return the mark", async () => {
    const { company, member } = await setup("enforce");
    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    const marked = await createInvite(company.id, { restriction: { restricted: true, pluginKeys: ["crm"] } });
    expect(marked.status, JSON.stringify(marked.body)).toBe(201);
    const unmarked = await createInvite(company.id, { restriction: { restricted: false } });
    await db.insert(joinRequests).values({
      inviteId: marked.body.id, companyId: company.id, requestType: "human", status: "pending_approval",
      requestIp: "127.0.0.1", requestingUserId: `requester-${randomUUID()}`,
    });

    const mark = { restricted: true, pluginKeys: ["crm"], agentIds: [] };
    const list = await request(app).get(`/api/companies/${company.id}/invites`);
    const byId = new Map(list.body.invites.map((invite: { id: string }) => [invite.id, invite]));
    expect(byId.get(marked.body.id)).toMatchObject({ memberRestriction: mark });
    expect(byId.get(unmarked.body.id)).toMatchObject({ memberRestriction: null });
    const joins = await request(app).get(`/api/companies/${company.id}/join-requests`);
    expect(joins.body[0].invite.memberRestriction).toEqual(mark);
  });

  it("AC-I5: who may mark, and a restricted person may not invite", async () => {
    const { company, member } = await setup("enforce");
    const operator = await member("operator");
    await grantInvite(company.id, operator.principalId);
    as(operator.principalId, [company.id]);
    const ok = await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const lists = await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: true, pluginKeys: ["crm"] } });
    expect(lists.status, JSON.stringify(lists.body)).toBe(403);

    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    for (const humanRole of ["owner", "admin"]) {
      const res = await createInvite(company.id, { humanRole, restriction: { restricted: true } });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTED_ROLE" });
    }
    expect((await createInvite(company.id, { restriction: { restricted: true, pluginKeys: ["not-installed"] } })).status).toBe(422);

    const flagged = await member("operator", { restricted: true });
    await grantInvite(company.id, flagged.principalId);
    as(flagged.principalId, [company.id]);
    const refused = await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: false } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "MEMBER_RESTRICTED" });
    await db.update(companies).set({ memberRestrictionMode: "report" }).where(eq(companies.id, company.id));
    expect((await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: false } })).status).toBe(201);
    // The refusal and the later "would refuse" leave one entry for the day (rule R-invite).
    // Under `report` the action list also records `users:invite` (rule R-action), not counted here.
    const denied = (await db.select().from(activityLog).where(eq(activityLog.action, "member_restriction.denied")))
      .filter((row) => (row.details as { ruleId?: string } | null)?.ruleId === "R-invite");
    expect(denied).toEqual([expect.objectContaining({ responsibleUserId: flagged.principalId,
      details: expect.objectContaining({ ruleId: "R-invite", mode: "enforce" }) })]);
  });

  it("AC-I6: defaultsPayload.memberRestriction sent directly is not stored", async () => {
    const { company, member } = await setup("off");
    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    const sneaky = { memberRestriction: { restricted: true, pluginKeys: ["crm"], agentIds: [] }, note: "kept" };
    for (const body of [{ defaultsPayload: sneaky }, { defaultsPayload: sneaky, restriction: { restricted: false } }]) {
      const res = await createInvite(company.id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [stored] = await db.select().from(invites).where(eq(invites.id, res.body.id));
      expect(stored!.defaultsPayload).toMatchObject({ note: "kept" });
      expect(stored!.defaultsPayload).not.toHaveProperty("memberRestriction");
    }
    // A marked invite stores the field's value, not the payload's lists.
    const marked = await createInvite(company.id, { defaultsPayload: sneaky, restriction: { restricted: true } });
    expect(marked.body.defaultsPayload.memberRestriction).toEqual({ restricted: true, pluginKeys: [], agentIds: [] });
  });

  it("AC-I7: the choice is required for a human invite unless the company is off", async () => {
    const { company, newCompany, member } = await setup("report");
    const enforce = await newCompany("enforce");
    const off = await newCompany("off");
    const owner = await member("owner");
    await member("owner", { principalId: owner.principalId }, enforce.id);
    await member("owner", { principalId: owner.principalId }, off.id);
    as(owner.principalId, [company.id, enforce.id, off.id]);

    for (const companyId of [company.id, enforce.id]) {
      const res = await createInvite(companyId, {});
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_REQUIRED" });
      expect((await createInvite(companyId, { allowedJoinTypes: "agent" })).status).toBe(201);
    }
    const unmarked = await createInvite(off.id, {});
    expect(unmarked.status).toBe(201);
    expect(unmarked.body.defaultsPayload).not.toHaveProperty("memberRestriction");
  });

  it("AC-F8 (invite path): with the kill switch `off` an enforce company behaves as mode off; any other value is ignored", async () => {
    const { company, member } = await setup("enforce");
    const flagged = await member("operator", { restricted: true });
    await grantInvite(company.id, flagged.principalId);
    as(flagged.principalId, [company.id]);

    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const res = await createInvite(company.id, { humanRole: "viewer" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.defaultsPayload).not.toHaveProperty("memberRestriction");

    for (const value of ["false", "OFF "]) {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      const refused = await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: false } });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "MEMBER_RESTRICTED" });
    }
  });

  it("AC-X1 (invite path): when the restriction read fails the call answers 503 and creates nothing", async () => {
    const { company, member } = await setup("enforce");
    const flagged = await member("operator", { restricted: true });
    await grantInvite(company.id, flagged.principalId);
    as(flagged.principalId, [company.id]);
    failingResolver = async () => { throw new Error("database down"); };
    const res = await createInvite(company.id, { humanRole: "viewer", restriction: { restricted: false } });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(res.body).not.toHaveProperty("token");
    expect(await db.select().from(invites)).toHaveLength(0);
  });
});
