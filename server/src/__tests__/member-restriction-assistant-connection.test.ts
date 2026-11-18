import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request } from "express";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRequests,
  museAgentBindings,
} from "@paperclipai/db";
import { museCredentialHash } from "../services/muse-identity.js";
import { museOAuth } from "../services/muse-oauth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { publicMcpManagementRoutes } from "../routes/public-mcp.js";
import { logActivity } from "../services/activity-log.js";
import { authorizationService } from "../services/authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { pluginActingPersonForActor } from "../services/member-restriction/plugin-acting-person.js";
import { memberRestrictionResolver } from "../services/member-restriction/resolver.js";
import { createPublicMcpEvents } from "../services/public-mcp/events.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12738 (C4f): the assistant connection under rules R and H. Spec PAR-12608
 * rev 3, 4.6a rows 3 and 4: AC-M1 to AC-M5, plus this consumer's kill-switch
 * (AC-F8) and failing-read (AC-X1) tests.
 */

// AC-X1: the resolver made to throw.
const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on
        ? Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"))
        : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
const agentConfig = { ...config, resource: config.origin + "/mcp/runner" };
const redirectUri = "https://client.example/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("assistant connection database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("assistant connection under member restriction (4.6a rows 3-4)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let oauth: ReturnType<typeof createPublicMcpOAuth>;
  let agentOAuth: ReturnType<typeof createPublicMcpOAuth>;
  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let privateTaskId = "";
  const clientId = `client-${randomUUID()}`;

  const session = (userId: string): Request["actor"] => ({ type: "board", source: "session", userId });
  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
  const setFlag = (userId: string, restricted: boolean) => db.update(companyMemberships).set({ restricted })
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
  const grantsOf = (userId: string) => db.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.companyId, companyId), eq(mcpOauthGrants.userId, userId)));
  const denials = async () => (await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied"),
  ))).map((row) => row.details as Record<string, unknown>);

  async function requestFor(resource: string, scopes: string[]) {
    const id = `pcmcp_request_${randomUUID()}`;
    await db.insert(mcpOauthRequests).values({
      id, clientId, redirectUri, resource, scopes, challenge, expiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  }
  const approve = async (userId: string, purpose: "personal" | "agent") => {
    const target = purpose === "personal" ? oauth : agentOAuth;
    const id = await requestFor(target.config.resource, purpose === "personal" ? ["paperclip:read"] : ["paperclip:agent"]);
    return target.consent(id, session(userId), { decision: "approve", companyId, allowWrites: false });
  };
  async function agentGrant(userId: string) {
    const [grant] = await db.insert(mcpOauthGrants).values({
      companyId, userId, clientId, agentId, resource: agentConfig.resource, purpose: "agent", scopes: ["paperclip:agent"],
    }).returning();
    return grant!.id;
  }

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-assistant-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true });
    oauth = createPublicMcpOAuth(db, config);
    agentOAuth = createPublicMcpOAuth(db, agentConfig);
    const [company] = await db.insert(companies).values({
      name: "Assistant co", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "Dot", role: "engineer", adapterType: "process" }).returning();
    agentId = agent!.id;
    // O's private task, assigned to the agent: the agent alone reads it, U does not.
    const [task] = await db.insert(issues).values({
      companyId, title: "O's private task", createdByUserId: O, visibility: "private", assigneeAgentId: agentId,
    }).returning();
    privateTaskId = task!.id;
    await db.insert(mcpOauthClients).values({ id: clientId, name: "Assistant", redirectUris: [redirectUri] });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("AC-M1: R under enforce cannot approve a personal or an agent-purpose connection; no grant is written", async () => {
    for (const purpose of ["personal", "agent"] as const) {
      await expect(approve(R, purpose)).rejects.toMatchObject({ code: "access_denied", status: 403 });
    }
    expect(await grantsOf(R)).toEqual([]);
    expect(await denials()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "R-assistant-connection", target: "assistant_connection.approve" }),
    ]));
    // The management route answers the same refusal.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = session(R); next(); });
    app.use(publicMcpManagementRoutes(oauth, agentOAuth));
    app.use(errorHandler);
    const id = await requestFor(config.resource, ["paperclip:read"]);
    const res = await request(app).post(`/mcp/requests/${id}/consent`).set("origin", config.origin)
      .send({ decision: "approve", companyId, allowWrites: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("access_denied");
    expect(await grantsOf(R)).toEqual([]);
  });

  it("AC-M1, row 3: R under enforce cannot pair a Muse agent connection; no grant is written", async () => {
    const [agent] = await db.insert(agents).values({
      companyId, name: "Muse", role: "engineer", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "muse", allowUnmeteredProvider: true, lifecycle: "per_turn" },
    }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member", status: "active" });
    const ticket = randomBytes(32).toString("base64url");
    const [binding] = await db.insert(museAgentBindings).values({
      companyId, agentId: agent!.id, operatorId: R, ticketHash: museCredentialHash(ticket), ticketExpiresAt: new Date(Date.now() + 600_000),
    }).returning();
    await db.update(agents).set({ adapterConfig: { ...agent!.adapterConfig, museBindingId: binding!.id } }).where(eq(agents.id, agent!.id));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableMuse: true });
    const muse = museOAuth(db, config.origin);
    const client = await muse.register({ client_name: "Muse authd", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }, randomUUID());
    await expect(muse.authorize({
      client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: "paperclip:agent offline_access",
      code_challenge: challenge, code_challenge_method: "S256", pairing_ticket: ticket,
    })).rejects.toMatchObject({ code: "access_denied", status: 403 });
    expect(await grantsOf(R)).toEqual([]);
  });

  it("AC-M2: R's personal connection made under off stops with his next call under enforce; O's keeps working; unflagging restores it", async () => {
    await setMode("off");
    const tokensFor = async (userId: string) => {
      const consent = await approve(userId, "personal");
      const code = new URL(consent.redirectUrl).searchParams.get("code")!;
      return oauth.token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, resource: config.resource, code, code_verifier: verifier });
    };
    const forR = await tokensFor(R);
    const forO = await tokensFor(O);
    await expect(oauth.authenticate(forR.access_token)).resolves.toMatchObject({ actor: { userId: R } });
    await setMode("enforce");
    await expect(oauth.authenticate(forR.access_token)).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    const [grantOfR] = await grantsOf(R);
    await expect(oauth.authorizeGrant(grantOfR!.id)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(oauth.authenticate(forO.access_token)).resolves.toMatchObject({ actor: { userId: O } });
    await setFlag(R, false);
    await expect(oauth.authenticate(forR.access_token)).resolves.toMatchObject({ actor: { userId: R } });
    await setFlag(R, true);
  });

  it("AC-M3: U's agent-purpose connection carries U; the read is held to U; a plugin receives U. O's yields today's actor", async () => {
    const { actor } = await agentOAuth.authorizeGrant(await agentGrant(U));
    expect(actor).toMatchObject({ type: "agent", source: "mcp_oauth", agentId, companyId, onBehalfOfUserId: U });
    expect(actor.onBehalfOfMemberships).toEqual([expect.objectContaining({ companyId, restricted: false, restrictionMode: "enforce" })]);
    const read = (who: Request["actor"]) => authorizationService(db).decide({
      actor: who as never, action: "issue:read",
      resource: { type: "issue", companyId, issueId: privateTaskId, projectId: null, parentIssueId: null, assigneeAgentId: agentId, assigneeUserId: null, status: "todo" },
    });
    expect(await read(actor)).toMatchObject({ allowed: false });
    await expect(pluginActingPersonForActor(memberRestrictionResolver(db), actor, companyId))
      .resolves.toEqual({ onBehalfOfUserId: U, onBehalfOfRestricted: false });

    const { actor: ownerActor } = await agentOAuth.authorizeGrant(await agentGrant(O));
    expect(ownerActor).toEqual({ type: "agent", source: "mcp_oauth", agentId, companyId });
    expect(await read(ownerActor)).toMatchObject({ allowed: true });
  });

  it("AC-M3 under off: the agent-purpose actor is unchanged", async () => {
    await setMode("off");
    const { actor } = await agentOAuth.authorizeGrant(await agentGrant(U));
    expect(actor).toEqual({ type: "agent", source: "mcp_oauth", agentId, companyId });
    await setMode("enforce");
  });

  it("AC-M4: U flagged after AC-M3: the next call through his agent-purpose connection is refused", async () => {
    const grantId = await agentGrant(U);
    await expect(agentOAuth.authorizeGrant(grantId)).resolves.toMatchObject({ actor: { onBehalfOfUserId: U } });
    await setFlag(U, true);
    try {
      await expect(agentOAuth.authorizeGrant(grantId)).rejects.toMatchObject({ code: "invalid_grant" });
    } finally {
      await setFlag(U, false);
    }
  });

  it("AC-M5: an event subscription of R's connection on a task delivers nothing after he is flagged", async () => {
    await setFlag(R, false);
    const [grant] = await db.insert(mcpOauthGrants).values({
      companyId, userId: R, clientId, resource: config.resource, purpose: "personal", scopes: ["paperclip:read"],
    }).returning();
    const delivered: string[] = [];
    const fetch = async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      delivered.push(String(body.data?.commentId ?? body.eventId));
      return new Response(null, { status: 204 });
    };
    const events = createPublicMcpEvents(db, oauth, async () => ({ id: privateTaskId, companyId }), { fetch });
    const comment = async () => {
      await logActivity(db, { companyId, actorType: "user", actorId: O, action: "issue.comment_added",
        entityType: "issue", entityId: privateTaskId, details: { commentId: randomUUID() } });
      await events.tick();
    };
    try {
      await events.subscribe(await oauth.authorizeGrant(grant!.id), {
        name: "paperclip.task.comment_created", arguments: { companyId, taskId: privateTaskId },
        delivery: { mode: "webhook", url: "https://r.example/events", secret: "whsec_" + randomBytes(32).toString("base64") },
      });
      await comment();
      expect(delivered).toHaveLength(1);
      await setFlag(R, true);
      await comment();
      expect(delivered).toHaveLength(1);
    } finally {
      await events.stop();
      await setFlag(R, true);
    }
  });

  it("AC-F8: with the kill switch on, R approves a connection and his agent-purpose actor is unchanged", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await expect(approve(R, "personal")).resolves.toMatchObject({ redirectUrl: expect.stringContaining("code=") });
    const { actor } = await agentOAuth.authorizeGrant(await agentGrant(R));
    expect(actor).toEqual({ type: "agent", source: "mcp_oauth", agentId, companyId });
  });

  it("AC-X1: a failed restriction read answers 503 MEMBER_RESTRICTION_UNAVAILABLE; no grant, no actor", async () => {
    const before = (await grantsOf(R)).length;
    const grantId = await agentGrant(R);
    resolverFails.on = true;
    const unavailable = { status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } };
    await expect(approve(R, "personal")).rejects.toMatchObject(unavailable);
    await expect(agentOAuth.authorizeGrant(grantId)).rejects.toMatchObject(unavailable);
    expect((await grantsOf(R)).length).toBe(before + 1);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = session(R); next(); });
    app.use(publicMcpManagementRoutes(oauth, agentOAuth));
    app.use(errorHandler);
    const id = await requestFor(config.resource, ["paperclip:read"]);
    const res = await request(app).post(`/mcp/requests/${id}/consent`).set("origin", config.origin)
      .send({ decision: "approve", companyId, allowWrites: false });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
  });
});
