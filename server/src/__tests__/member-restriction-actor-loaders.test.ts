import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  mcpOauthClients,
  mcpOauthGrants,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { authRoutes } from "../routes/auth.js";
import { authorizationService } from "../services/authorization.js";
import { boardAuthService } from "../services/board-auth.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import {
  memberRestrictionForActor,
  memberRestrictionForMembership,
  memberRestrictionResolver,
} from "../services/member-restriction/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12706 (C1-3): every actor loader carries `restricted` and
// `restrictionMode` (AC-X2), a membership without them is read from the
// database (AC-X3), and a suspended flagged member carries no membership (AC-X4).

const COMPANY = "11111111-1111-4111-8111-111111111111";
const flaggedRow = { restricted: true, mode: "enforce" as const, pluginKeys: ["crm"], agentIds: [] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memberRestrictionForMembership", () => {
  it("answers a known unflagged membership without a read", async () => {
    const resolve = vi.fn();
    await expect(memberRestrictionForMembership(resolve, "u", COMPANY, {
      companyId: COMPANY, restricted: false, restrictionMode: "enforce",
    })).resolves.toEqual({ restricted: false, mode: "enforce", pluginKeys: [], agentIds: [] });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads the database for a flagged member, for a membership of another company, and when the fields are missing (AC-X3)", async () => {
    const resolve = vi.fn(async () => flaggedRow);
    for (const membership of [
      { companyId: COMPANY, restricted: true, restrictionMode: "enforce" as const },
      { companyId: "other", restricted: false, restrictionMode: "off" as const },
      { companyId: COMPANY, membershipRole: "operator", status: "active" },
      { companyId: COMPANY, restricted: "no", restrictionMode: "strict" } as never,
      null,
    ]) {
      await expect(memberRestrictionForMembership(resolve, "u", COMPANY, membership)).resolves.toEqual(flaggedRow);
    }
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE when that read fails, and with the kill switch on reads nothing", async () => {
    const failing = vi.fn(async () => { throw new Error("database down"); });
    await expect(memberRestrictionForMembership(failing, "u", COMPANY, { companyId: COMPANY }))
      .rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await expect(memberRestrictionForMembership(failing, "u", COMPANY, { companyId: COMPANY }))
      .resolves.toMatchObject({ restricted: false, mode: "off" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("finds the person an actor works for: a board user, an agent's person, or nobody", async () => {
    const resolve = vi.fn(async () => flaggedRow);
    const membership = { companyId: COMPANY, restricted: true, restrictionMode: "enforce" as const };
    await expect(memberRestrictionForActor(resolve, { type: "board", userId: "r", memberships: [membership] }, COMPANY))
      .resolves.toMatchObject({ personId: "r", restricted: true });
    await expect(memberRestrictionForActor(resolve, {
      type: "agent", onBehalfOfUserId: "r", onBehalfOfMemberships: [membership],
    }, COMPANY)).resolves.toMatchObject({ personId: "r", restricted: true });
    await expect(memberRestrictionForActor(resolve, { type: "agent" }, COMPANY)).resolves.toBeNull();
    expect(resolve).toHaveBeenNthCalledWith(1, "r", COMPANY);
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("member-restriction actor loader database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("actor loaders carry the restriction fields", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let sessionUserId: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-actors-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(status: "active" | "suspended" = "active") {
    const [company] = await db.insert(companies).values({
      name: "Restricted actors", issuePrefix: `A${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    const person = `restricted-${randomUUID()}`;
    const owner = `owner-${randomUUID()}`;
    for (const id of [person, owner]) {
      await db.insert(authUsers).values({
        id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await db.insert(companyMemberships).values([
      { companyId: company!.id, principalType: "user", principalId: person, status, membershipRole: "operator", restricted: true },
      { companyId: company!.id, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker" }).returning();
    return { companyId: company!.id, person, owner, agentId: agent!.id };
  }

  function app() {
    const server = express();
    server.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => sessionUserId
        ? { session: { id: `session-${sessionUserId}`, userId: sessionUserId }, user: { id: sessionUserId, name: "R", email: null } } as never
        : null,
    }));
    server.get("/actor", (req, res) => { res.json(req.actor); });
    server.use("/api/auth", authRoutes(db));
    server.use(errorHandler);
    return server;
  }

  async function actorWith(headers: Record<string, string>) {
    const res = await request(app()).get("/actor").set(headers);
    expect(res.status).toBe(200);
    return res.body as Express.Request["actor"];
  }

  async function bearerFor(table: "board" | "agent", input: { userId: string; companyId: string; agentId: string }) {
    const token = `pcp_${randomUUID()}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    if (table === "board") await db.insert(boardApiKeys).values({ userId: input.userId, name: "test", keyHash });
    else await db.insert(agentApiKeys).values({
      companyId: input.companyId, agentId: input.agentId, responsibleUserId: input.userId, name: "test", keyHash,
    });
    return { authorization: `Bearer ${token}` };
  }

  async function expectRestricted(actor: Parameters<typeof memberRestrictionForActor>[1], companyId: string) {
    await expect(memberRestrictionForActor(memberRestrictionResolver(db), actor, companyId))
      .resolves.toMatchObject({ restricted: true, mode: "enforce" });
  }

  const enforced = (companyId: string) => expect.objectContaining({ companyId, restricted: true, restrictionMode: "enforce" });

  it("session: the flagged member's membership carries both fields; the owner's says not restricted", async () => {
    const f = await fixture();
    sessionUserId = f.person;
    const actor = await actorWith({});
    expect(actor.memberships).toEqual([enforced(f.companyId)]);
    await expectRestricted(actor, f.companyId);

    sessionUserId = f.owner;
    const owner = await actorWith({});
    expect(owner.memberships).toEqual([expect.objectContaining({ restricted: false, restrictionMode: "enforce" })]);
    const resolve = vi.fn(memberRestrictionResolver(db));
    await expect(memberRestrictionForActor(resolve, owner, f.companyId)).resolves.toMatchObject({ restricted: false });
    expect(resolve).not.toHaveBeenCalled();
    sessionUserId = null;
  });

  it("session data: get-session returns the person's own restriction and the company's mode", async () => {
    const f = await fixture();
    sessionUserId = f.person;
    const res = await request(app()).get("/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(res.body.memberRestrictions).toEqual([{ companyId: f.companyId, restricted: true, mode: "enforce" }]);
    sessionUserId = null;
  });

  it("board key", async () => {
    const f = await fixture();
    const actor = await actorWith(await bearerFor("board", { userId: f.person, companyId: f.companyId, agentId: f.agentId }));
    expect(actor.source).toBe("board_key");
    expect(actor.memberships).toEqual([enforced(f.companyId)]);
    await expectRestricted(actor, f.companyId);
  });

  it("personal assistant connection: the grant's board actor carries both fields", async () => {
    const f = await fixture();
    const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
    const clientId = `client-${randomUUID()}`;
    await db.insert(mcpOauthClients).values({ id: clientId, name: "Assistant", redirectUris: ["https://client.example/cb"] });
    const [grant] = await db.insert(mcpOauthGrants).values({
      companyId: f.companyId, userId: f.person, clientId, resource: config.resource, purpose: "personal", scopes: ["paperclip:read"],
    }).returning();
    const { actor } = await createPublicMcpOAuth(db, config).authorizeGrant(grant!.id);
    expect(actor).toMatchObject({ type: "board", source: "mcp_oauth", userId: f.person });
    expect(actor.memberships).toEqual([enforced(f.companyId)]);
    await expectRestricted(actor, f.companyId);
  });

  it("agent-purpose assistant connection: resolveBoardAccess, which approves it, carries both fields", async () => {
    // The agent-purpose actor gains its approving person in C4f (spec 4.6a row 4,
    // X7); until then the membership it is checked against carries the fields.
    const f = await fixture();
    const access = await boardAuthService(db).resolveBoardAccess(f.person);
    expect(access.memberships).toEqual([enforced(f.companyId)]);
    await expectRestricted({ type: "agent", onBehalfOfUserId: f.person, onBehalfOfMemberships: access.memberships }, f.companyId);
  });

  it("long-lived agent key: the key's person carries both fields", async () => {
    const f = await fixture();
    const actor = await actorWith(await bearerFor("agent", { userId: f.person, companyId: f.companyId, agentId: f.agentId }));
    expect(actor).toMatchObject({ source: "agent_key", onBehalfOfUserId: f.person });
    expect(actor.onBehalfOfMemberships).toEqual([enforced(f.companyId)]);
    await expectRestricted(actor, f.companyId);
  });

  it("signed run token: the run's person carries both fields", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "member-restriction-actor-loaders");
    const f = await fixture();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "process", randomUUID(), f.person);
    const actor = await actorWith({ authorization: `Bearer ${token}` });
    expect(actor).toMatchObject({ source: "agent_jwt", onBehalfOfUserId: f.person });
    expect(actor.onBehalfOfMemberships).toEqual([enforced(f.companyId)]);
    await expectRestricted(actor, f.companyId);
  });

  it("snapshot: the responsible-user snapshot's activeMembership carries both fields", async () => {
    const f = await fixture();
    const snapshot = await authorizationService(db).loadResponsibleUserSnapshot(f.companyId, f.person);
    expect(snapshot.activeMembership).toEqual(enforced(f.companyId));
  });

  it("kill switch `off`: every loader says not restricted, mode off", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const f = await fixture();
    sessionUserId = f.person;
    expect((await actorWith({})).memberships).toEqual([
      expect.objectContaining({ restricted: false, restrictionMode: "off" }),
    ]);
    sessionUserId = null;
  });

  it("an actor built by hand without the fields is resolved from the database and restricted (AC-X3)", async () => {
    const f = await fixture();
    const resolve = vi.fn(memberRestrictionResolver(db));
    const handBuilt = { type: "board", userId: f.person, memberships: [{ companyId: f.companyId, status: "active" }] };
    await expect(memberRestrictionForActor(resolve, handBuilt, f.companyId))
      .resolves.toMatchObject({ restricted: true, mode: "enforce" });
    expect(resolve).toHaveBeenCalledWith(f.person, f.companyId);
  });

  it("a suspended flagged member carries no membership in that company through any loader (AC-X4)", async () => {
    const f = await fixture("suspended");
    sessionUserId = f.person;
    const session = await actorWith({});
    expect(session.companyIds).not.toContain(f.companyId);
    expect(session.memberships).toEqual([]);
    sessionUserId = null;
    const keyActor = await actorWith(await bearerFor("agent", { userId: f.person, companyId: f.companyId, agentId: f.agentId }));
    expect(keyActor.onBehalfOfMemberships).toEqual([]);
    expect((await boardAuthService(db).resolveBoardAccess(f.person)).memberships).toEqual([]);
    expect((await authorizationService(db).loadResponsibleUserSnapshot(f.companyId, f.person)).activeMembership).toBeNull();
    // Still restricted here: whatever a consumer asks, the resolver answers restricted.
    await expectRestricted({ type: "board", userId: f.person, memberships: [] }, f.companyId);
  });
});
