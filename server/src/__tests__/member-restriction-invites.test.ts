import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
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

// The company-mode read of `markForNewInvite` (an unrestricted inviter) is made to fail through this seam.
const modeRead = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionModeFor: async (...args: Parameters<typeof actual.memberRestrictionModeFor>) => {
      if (modeRead.fail) throw new actual.MemberRestrictionReadError("database down");
      return actual.memberRestrictionModeFor(...args);
    },
  };
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
    // The mocked resolver module loads first: importing it alongside the routes lets the routes bind the real one.
    const { memberRestrictionResolver } = await import("../services/member-restriction/resolver.js");
    const [{ accessRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/access.js"),
      import("../middleware/error-handler.js"),
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
    modeRead.fail = false;
    await db.execute(sql`drop trigger if exists fail_insert on company_memberships`);
    await db.execute(sql`drop trigger if exists fail_insert on principal_permission_grants`);
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
  const membershipOf = (companyId: string, principalId: string) => db.select().from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, principalId)))
    .then((rows) => rows[0] ?? null);
  const grantInvite = (companyId: string, principalId: string) => db.insert(principalPermissionGrants)
    .values({ companyId, principalType: "user", principalId, permissionKey: "users:invite" }).onConflictDoNothing();
  async function failInsertsInto(table: "company_memberships" | "principal_permission_grants") {
    await db.execute(sql.raw(`create or replace function fail_insert() returns trigger language plpgsql as
      $$ begin raise exception 'insert made to fail'; end $$`));
    await db.execute(sql.raw(`create trigger fail_insert before insert on ${table} for each row execute function fail_insert()`));
  }

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

  it("AC-I1/AC-I8: a person who joins through a marked invite in an enforce company is restricted from his first request; the invite list returns the mark", async () => {
    const { company, member } = await setup("enforce");
    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    const created = await createInvite(company.id, { restriction: { restricted: true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.defaultsPayload.memberRestriction).toEqual({ restricted: true, pluginKeys: [], agentIds: [] });

    const list = await request(app).get(`/api/companies/${company.id}/invites`);
    expect(list.body.invites[0].memberRestriction).toEqual({ restricted: true, pluginKeys: [], agentIds: [] });

    const joiner = `joiner-${randomUUID()}`;
    as(joiner);
    const accepted = await request(app).post(`/api/invites/${created.body.token}/accept`).send({ requestType: "human" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(await membershipOf(company.id, joiner)).toMatchObject({ status: "active", restricted: true });

    // What his very first request is decided by: every loader and the resolver answer "restricted".
    const { memberRestrictionFor, loadActorMemberships } = await import("../services/member-restriction/index.js");
    expect(await memberRestrictionFor(db, joiner, company.id)).toEqual({ restricted: true, mode: "enforce", pluginKeys: [], agentIds: [] });
    expect(await loadActorMemberships(db, { userId: joiner, activeOnly: true }))
      .toEqual([expect.objectContaining({ companyId: company.id, restricted: true, restrictionMode: "enforce" })]);
  });

  it("AC-I2/AC-I8: a join request approved by an owner reads the mark from its invite; the join-request list returns it", async () => {
    const { company, member } = await setup("enforce");
    const owner = await member("owner");
    const [helper] = await db.insert(agents)
      .values({ companyId: company.id, name: "Helper", role: "worker", adapterType: "process", adapterConfig: {} }).returning();
    as(owner.principalId, [company.id]);
    const created = await createInvite(company.id, { restriction: { restricted: true, pluginKeys: ["crm"], agentIds: [helper!.id] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const requester = `requester-${randomUUID()}`;
    const [pending] = await db.insert(joinRequests).values({
      inviteId: created.body.id, companyId: company.id, requestType: "human", status: "pending_approval",
      requestIp: "127.0.0.1", requestingUserId: requester,
    }).returning();

    const listed = await request(app).get(`/api/companies/${company.id}/join-requests`);
    expect(listed.body[0].invite.memberRestriction).toEqual({ restricted: true, pluginKeys: ["crm"], agentIds: [helper!.id] });

    const approved = await request(app).post(`/api/companies/${company.id}/join-requests/${pending!.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await membershipOf(company.id, requester))
      .toMatchObject({ restricted: true, restrictedPluginKeys: ["crm"], restrictedAgentIds: [helper!.id] });
  });

  it("AC-I3: no path leaves an active unflagged row for a marked invite", async () => {
    const { company, member } = await setup("enforce");
    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    const first = await createInvite(company.id, { restriction: { restricted: true } });
    const second = await createInvite(company.id, { restriction: { restricted: true } });

    // The membership insert fails after the mark is computed: no row.
    const one = `one-${randomUUID()}`;
    as(one);
    await failInsertsInto("company_memberships");
    expect((await request(app).post(`/api/invites/${first.body.token}/accept`).send({ requestType: "human" })).status).toBe(500);
    expect(await membershipOf(company.id, one)).toBeNull();
    await db.execute(sql`drop trigger if exists fail_insert on company_memberships`);

    // The route fails after the insert (granting fails): the row that exists is flagged.
    const two = `two-${randomUUID()}`;
    as(two);
    await failInsertsInto("principal_permission_grants");
    expect((await request(app).post(`/api/invites/${second.body.token}/accept`).send({ requestType: "human" })).status).toBe(500);
    expect(await membershipOf(company.id, two)).toMatchObject({ restricted: true });
  });

  it("AC-I4: an invite never lowers a flag; a flagged member cannot join as admin", async () => {
    const { access, company, member } = await setup("enforce");
    const owner = await member("owner");
    const flagged = await member("operator", { status: "archived", restricted: true, restrictedPluginKeys: ["crm"] });
    as(owner.principalId, [company.id]);
    const unmarked = await createInvite(company.id, { restriction: { restricted: false } });
    const asAdmin = await createInvite(company.id, { humanRole: "admin", restriction: { restricted: false } });

    as(flagged.principalId);
    expect((await request(app).post(`/api/invites/${unmarked.body.token}/accept`).send({ requestType: "human" })).status).toBe(202);
    expect(await membershipOf(company.id, flagged.principalId))
      .toMatchObject({ status: "active", restricted: true, restrictedPluginKeys: ["crm"], restrictedAgentIds: [] });

    await db.update(companyMemberships).set({ status: "archived" }).where(eq(companyMemberships.id, flagged.id));
    const res = await request(app).post(`/api/invites/${asAdmin.body.token}/accept`).send({ requestType: "human" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTED_ROLE" });

    // A mark raises the flag only on a row that is not yet active.
    const mark = { restricted: true as const, pluginKeys: [], agentIds: [] };
    const active = await member("operator");
    await access.ensureMembership(company.id, "user", active.principalId, "operator", "active", mark);
    expect(await membershipOf(company.id, active.principalId)).toMatchObject({ restricted: false });
    const pending = await member("operator", { status: "pending" });
    await access.ensureMembership(company.id, "user", pending.principalId, "operator", "active", mark);
    expect(await membershipOf(company.id, pending.principalId)).toMatchObject({ status: "active", restricted: true });
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
    // No typed field under `off`: the key is absent. A typed `restricted: false` is stored
    // exactly as the recorded choice (PAR-13096), never the free payload's value.
    const notRestricted = { restricted: false, pluginKeys: [], agentIds: [] };
    for (const [body, expected] of [
      [{ defaultsPayload: sneaky }, undefined],
      [{ defaultsPayload: sneaky, restriction: { restricted: false } }, notRestricted],
    ] as const) {
      const res = await createInvite(company.id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [stored] = await db.select().from(invites).where(eq(invites.id, res.body.id));
      expect(stored!.defaultsPayload).toMatchObject({ note: "kept" });
      expect((stored!.defaultsPayload as Record<string, unknown>).memberRestriction).toEqual(expected);
      expect(res.body.defaultsPayload.memberRestriction).toEqual(expected);
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

  it("AC-I8: restricted in X, an unmarked invite to Y leaves him unflagged in Y and flagged in X", async () => {
    const { company: x, newCompany, member } = await setup("enforce");
    const y = await newCompany("enforce");
    const person = await member("operator", { restricted: true });
    const ownerY = await member("owner", {}, y.id);
    as(ownerY.principalId, [y.id]);
    const invite = await createInvite(y.id, { restriction: { restricted: false } });
    as(person.principalId, [x.id]);
    expect((await request(app).post(`/api/invites/${invite.body.token}/accept`).send({ requestType: "human" })).status).toBe(202);
    expect(await membershipOf(y.id, person.principalId)).toMatchObject({ status: "active", restricted: false });
    expect(await membershipOf(x.id, person.principalId)).toMatchObject({ restricted: true });
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

  it("AC-X1 (invite path, mode read): an unrestricted owner gets 503 and no invite when the company mode cannot be read", async () => {
    const { company, member } = await setup("enforce");
    const owner = await member("owner");
    as(owner.principalId, [company.id]);
    modeRead.fail = true;
    const res = await createInvite(company.id, {});
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(res.body).not.toHaveProperty("token");
    expect(await db.select().from(invites)).toHaveLength(0);
  });
});
