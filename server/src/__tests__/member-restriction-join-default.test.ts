import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, authUsers, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, companyMemberships,
  createDb, invites, issues, joinRequests, plugins, principalPermissionGrants, toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-13096 (decision PAR-13091): a join with no recorded choice gets the restricted
// default in a company on `report` or `enforce`; a recorded `restricted: false` is kept.

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

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
type Mode = "off" | "report" | "enforce";
const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction join default database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("restricted default at the join (PAR-13096)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let app: express.Express;
  let actor: Express.Request["actor"];
  let hostServices: ReturnType<typeof import("../services/plugin-host-services.js").buildHostServices>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-join-default-");
    db = createDb(tempDb.connectionString);
    const [{ accessRoutes }, { errorHandler }, { buildHostServices }] = await Promise.all([
      import("../routes/access.js"), import("../middleware/error-handler.js"), import("../services/plugin-host-services.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
    app.use(errorHandler);
    hostServices = buildHostServices(db, "plugin-record-id", "permissions-extension", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as never);
  }, 60_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    modeRead.fail = false;
    await db.delete(activityLog); await db.delete(chatIdentityLinks); await db.delete(chatExternalPrincipals);
    await db.delete(chatEndpoints); await db.delete(toolConnections); await db.delete(toolApplications);
    await db.delete(joinRequests); await db.delete(invites); await db.delete(issues); await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships); await db.delete(agents); await db.delete(plugins);
    await db.delete(authUsers); await db.delete(companies);
  });

  afterAll(async () => {
    hostServices?.dispose();
    await tempDb?.cleanup();
  });

  async function setup(mode: Mode) {
    const { accessService } = await import("../services/access.js");
    const [company] = await db.insert(companies).values({
      name: "Join default", issuePrefix: `JD${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const owner = await member(company!.id, "owner");
    await accessService(db).ensureRoleDefaultGrants(company!.id, owner, "owner", null);
    await db.insert(plugins).values({ pluginKey: "crm", packageName: "@test/crm", version: "1.0.0", status: "ready", manifestJson: {} as never });
    return { companyId: company!.id, owner };
  }
  async function user() {
    const id = `person-${randomUUID()}`;
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    return id;
  }
  async function member(companyId: string, role: string, extra: Partial<typeof companyMemberships.$inferInsert> = {}) {
    const id = await user();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: role, ...extra });
    return id;
  }
  function as(userId: string, companyIds: string[] = []) {
    actor = { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds,
      memberships: companyIds.map((companyId) => ({ companyId, status: "active" })) as never };
  }
  const setMode = (companyId: string, mode: Mode) =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
  const createInvite = (companyId: string, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/companies/${companyId}/invites`).send({ allowedJoinTypes: "human", humanRole: "operator", ...body });
  const accept = (token: string) => request(app).post(`/api/invites/${token}/accept`).send({ requestType: "human" });
  const approve = (companyId: string, requestId: string) =>
    request(app).post(`/api/companies/${companyId}/join-requests/${requestId}/approve`).send({});
  const membershipOf = (companyId: string, principalId: string) => db.select().from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, principalId)))
    .then((rows) => rows[0] ?? null);
  const grantsOf = (companyId: string, principalId: string) => db.select().from(principalPermissionGrants)
    .where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, principalId)));
  const inviteRow = (id: string) => db.select().from(invites).where(eq(invites.id, id)).then((rows) => rows[0]!);
  const pendingRequest = (companyId: string, inviteId: string, requestingUserId: string) => db.insert(joinRequests).values({
    inviteId, companyId, requestType: "human", status: "pending_approval", requestIp: "127.0.0.1", requestingUserId,
    requestEmailSnapshot: `${requestingUserId}@example.test`,
  }).returning().then((rows) => rows[0]!);
  const activity = (action: string) => db.select().from(activityLog).where(eq(activityLog.action, action))
    .then((rows) => rows.map((row) => row.details as Record<string, unknown>));
  const flagged = { status: "active", restricted: true, restrictedPluginKeys: [], restrictedAgentIds: [] };

  /** A no-choice invite: made under `off` (the field is then optional), before the company moves on. */
  async function inviteFromOff(companyId: string, owner: string, body: Record<string, unknown> = {}) {
    as(owner, [companyId]);
    const [current] = await db.select().from(companies).where(eq(companies.id, companyId));
    await setMode(companyId, "off");
    const res = await createInvite(companyId, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await setMode(companyId, current!.memberRestrictionMode as Mode);
    return res.body as { id: string; token: string; defaultsPayload: Record<string, unknown> };
  }

  /** The Slack identity-link producer, driven as shipped; it stores no choice. */
  async function slackRequest(companyId: string, userId: string) {
    const { createSlackIdentityLinks } = await import("../services/chat-channels/slack/identity-links.js");
    const token = randomUUID(); const endpointId = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId, name: "Chat agent", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId: connection!.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent!.id, status: "active" });
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "team", externalId: randomUUID() }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal!.id,
      confirmationTokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 600_000) });
    const links = createSlackIdentityLinks(db, {
      previewIdentityLink: async () => ({ selfService: true, canConfirm: false, companyId, endpointId }),
      stageProviderEffect: vi.fn(async () => null),
    });
    expect(await links.requestIdentityAccess(token, userId, "127.0.0.1")).toEqual({ status: "pending_approval" });
    return db.select().from(joinRequests).where(eq(joinRequests.requestingUserId, userId)).then((rows) => rows[0]!);
  }

  it.each([["enforce", true], ["report", true], ["off", false]] as const)(
    "T1-T3: a Slack identity-link request approved under %s joins restricted=%s",
    async (mode, restricted) => {
      const { companyId, owner } = await setup(mode);
      const person = await user();
      const pending = await slackRequest(companyId, person);
      as(owner, [companyId]);
      const res = await approve(companyId, pending.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await membershipOf(companyId, person)).toMatchObject(restricted ? flagged : { status: "active", restricted: false });
      expect(await activity("join.approved")).toEqual([expect.objectContaining({ memberRestrictionIsDefault: restricted })]);
      if (mode !== "enforce") return;
      const [task] = await db.insert(issues).values({ companyId, title: "Owner's open task", createdByUserId: owner }).returning();
      const { authorizationService } = await import("../services/authorization.js");
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: person, source: "session" }, action: "issue:read",
        resource: { type: "issue", companyId, issueId: task!.id, projectId: null, parentIssueId: null, assigneeAgentId: null, assigneeUserId: null, status: "todo" },
      });
      expect(decision).toMatchObject({ allowed: false, reason: "deny_member_restricted" });
    },
  );

  it("T4: with the kill switch on, an enforce company gives no default at accept or at approve", async () => {
    const { companyId, owner } = await setup("enforce");
    const invite = await inviteFromOff(companyId, owner);
    const slackPerson = await user();
    const pending = await slackRequest(companyId, slackPerson);
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const joiner = await user();
    as(joiner);
    expect((await accept(invite.token)).status).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject({ status: "active", restricted: false });
    as(owner, [companyId]);
    expect((await approve(companyId, pending.id)).status).toBe(200);
    expect(await membershipOf(companyId, slackPerson)).toMatchObject({ status: "active", restricted: false });
  });

  it("T5: an invite made under off and accepted after the company moved to enforce joins restricted", async () => {
    const { companyId, owner } = await setup("off");
    const invite = await inviteFromOff(companyId, owner);
    expect(invite.defaultsPayload).not.toHaveProperty("memberRestriction");
    await setMode(companyId, "enforce");
    const joiner = await user();
    as(joiner);
    const res = await accept(invite.token);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject(flagged);
  });

  it("T6: a join request pending since off and approved under enforce joins restricted", async () => {
    const { companyId, owner } = await setup("off");
    const invite = await inviteFromOff(companyId, owner);
    const person = await user();
    const pending = await pendingRequest(companyId, invite.id, person);
    await setMode(companyId, "enforce");
    as(owner, [companyId]);
    expect((await approve(companyId, pending.id)).status).toBe(200);
    expect(await membershipOf(companyId, person)).toMatchObject(flagged);
  });

  it("T7: a recorded `restricted: false` is stored, echoed, audited and kept at the join under enforce", async () => {
    const { companyId, owner } = await setup("enforce");
    as(owner, [companyId]);
    const created = await createInvite(companyId, { restriction: { restricted: false } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const notRestricted = { restricted: false, pluginKeys: [], agentIds: [] };
    expect((await inviteRow(created.body.id)).defaultsPayload).toMatchObject({ memberRestriction: notRestricted });
    expect(created.body.defaultsPayload.memberRestriction).toEqual(notRestricted);
    expect(await activity("invite.created")).toEqual([expect.objectContaining({ restrictionChoice: "not_restricted", memberRestriction: null })]);
    const joiner = await user();
    as(joiner);
    expect((await accept(created.body.token)).status).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject({ status: "active", restricted: false });
    expect(await activity("join.approved")).toEqual([expect.objectContaining({ memberRestrictionIsDefault: false })]);
  });

  it("T8: a marked invite with a plugin list joins with that list", async () => {
    const { companyId, owner } = await setup("enforce");
    as(owner, [companyId]);
    const created = await createInvite(companyId, { restriction: { restricted: true, pluginKeys: ["crm"] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await activity("invite.created")).toEqual([expect.objectContaining({ restrictionChoice: "restricted" })]);
    const joiner = await user();
    as(joiner);
    expect((await accept(created.body.token)).status).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject({ ...flagged, restrictedPluginKeys: ["crm"] });
  });

  it("T9: a failed mode read at the approve route is 503 and writes nothing", async () => {
    const { companyId, owner } = await setup("enforce");
    const person = await user();
    const pending = await slackRequest(companyId, person);
    as(owner, [companyId]);
    modeRead.fail = true;
    const res = await approve(companyId, pending.id);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(await membershipOf(companyId, person)).toBeNull();
    expect(await grantsOf(companyId, person)).toEqual([]);
    expect((await db.select().from(joinRequests).where(eq(joinRequests.id, pending.id)))[0]!.status).toBe("pending_approval");
  });

  it.each(["fresh", "reuse", "replay"] as const)("T9b: a failed mode read at accept (%s) is 503, writes nothing, and the retry joins", async (path) => {
    const { companyId, owner } = await setup("enforce");
    const invite = await inviteFromOff(companyId, owner);
    const joiner = await user();
    if (path === "reuse") await pendingRequest(companyId, (await inviteFromOff(companyId, owner)).id, joiner);
    if (path === "replay") {
      await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
      await pendingRequest(companyId, invite.id, joiner);
    }
    const before = (await db.select().from(joinRequests)).length;
    as(joiner);
    modeRead.fail = true;
    const res = await accept(invite.token);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(await membershipOf(companyId, joiner)).toBeNull();
    expect(await grantsOf(companyId, joiner)).toEqual([]);
    expect(await db.select().from(joinRequests)).toHaveLength(before);
    if (path !== "replay") expect((await inviteRow(invite.id)).acceptedAt).toBeNull();
    modeRead.fail = false;
    const retry = await accept(invite.token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject(flagged);
  });

  it("T9c: on reuse, accept applies the mark of the invite in hand", async () => {
    const { companyId, owner } = await setup("enforce");
    // A pending Slack request (no choice) plus an accepted `restricted: false` invite: not restricted.
    const first = await user();
    await slackRequest(companyId, first);
    as(owner, [companyId]);
    const chosen = await createInvite(companyId, { restriction: { restricted: false } });
    as(first);
    expect((await accept(chosen.body.token)).status).toBe(202);
    expect(await membershipOf(companyId, first)).toMatchObject({ status: "active", restricted: false });
    // A request from a `restricted: false` invite plus an accepted no-choice invite: restricted.
    const second = await user();
    as(owner, [companyId]);
    const other = await createInvite(companyId, { restriction: { restricted: false } });
    await pendingRequest(companyId, other.body.id, second);
    const noChoice = await inviteFromOff(companyId, owner);
    as(second);
    expect((await accept(noChoice.token)).status).toBe(202);
    expect(await membershipOf(companyId, second)).toMatchObject(flagged);
  });

  it("T10: a free-payload `memberRestriction` is not stored by the route or the plugin host; the join gets the default", async () => {
    const { companyId, owner } = await setup("off");
    const sneaky = { memberRestriction: { restricted: false, pluginKeys: [], agentIds: [] }, note: "kept" };
    const viaRoute = await inviteFromOff(companyId, owner, { defaultsPayload: sneaky });
    const viaPlugin = await hostServices.access.createInvite({ companyId, allowedJoinTypes: "human", defaultsPayload: sneaky });
    for (const id of [viaRoute.id, viaPlugin.id as string]) {
      expect((await inviteRow(id)).defaultsPayload).not.toHaveProperty("memberRestriction");
    }
    await setMode(companyId, "enforce");
    for (const token of [viaRoute.token, viaPlugin.token as string]) {
      const joiner = await user();
      as(joiner);
      expect((await accept(token)).status).toBe(202);
      expect(await membershipOf(companyId, joiner)).toMatchObject(flagged);
    }
  });

  it("T11: an owner-role invite with no recorded choice joins unrestricted as owner", async () => {
    const { companyId, owner } = await setup("enforce");
    const invite = await inviteFromOff(companyId, owner, { humanRole: "owner" });
    const joiner = await user();
    as(joiner);
    expect((await accept(invite.token)).status).toBe(202);
    expect(await membershipOf(companyId, joiner)).toMatchObject({ status: "active", restricted: false, membershipRole: "owner" });
  });

  it("T12: an active unflagged member approved again under enforce is unchanged", async () => {
    const { companyId, owner } = await setup("enforce");
    const person = await member(companyId, "operator");
    const pending = await pendingRequest(companyId, (await inviteFromOff(companyId, owner)).id, person);
    as(owner, [companyId]);
    expect((await approve(companyId, pending.id)).status).toBe(200);
    expect(await membershipOf(companyId, person)).toMatchObject({ status: "active", restricted: false, membershipRole: "operator" });
  });
});
