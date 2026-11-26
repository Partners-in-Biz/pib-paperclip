import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRequests,
  mcpOauthTokens,
  museAgentBindings,
  principalPermissionGrants,
} from "@paperclipai/db";
import { museCredentialHash } from "../services/muse-identity.js";
import { museOAuth } from "../services/muse-oauth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../routes/public-mcp.js";
import { logActivity } from "../services/activity-log.js";
import { canActorReadAssetContent } from "../services/asset-content-access.js";
import { authorizationService } from "../services/authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { pluginActingPersonForActor } from "../services/member-restriction/plugin-acting-person.js";
import { memberRestrictionResolver } from "../services/member-restriction/resolver.js";
import { createPublicMcpEvents } from "../services/public-mcp/events.js";
import { createPublicMcpTransfers } from "../services/public-mcp/file-transfers.js";
import { createPublicMcpOAuth, hashMcpSecret } from "../services/public-mcp/oauth.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12738 (C4f): the assistant connection under rules R and H. Spec PAR-12608
 * rev 3, 4.6a rows 3 and 4: AC-M1 to AC-M5, plus this consumer's kill-switch
 * (AC-F8) and failing-read (AC-X1) tests.
 */

// AC-X1: the resolver made to throw (after `skip` good reads, so one call site fails on its own).
const resolverFails = vi.hoisted(() => ({ on: false, skip: 0 }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on && resolverFails.skip-- <= 0
        ? Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"))
        : actual.memberRestrictionFor(db, personId, companyId),
  };
});

// PAR-14330: runs inside each refusal record, before it is written, so a test
// can check no caller transaction still holds its row locks at that moment.
const denialRecordHook = vi.hoisted(() => ({ before: null as null | ((denial: { personId: string }) => Promise<void>) }));
vi.mock("../services/member-restriction/admin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/admin.js")>();
  return {
    ...actual,
    recordMemberRestrictionDenial: async (...args: Parameters<typeof actual.recordMemberRestrictionDenial>) => {
      await denialRecordHook.before?.(args[1]);
      return actual.recordMemberRestrictionDenial(...args);
    },
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
  denialRecordHook.before = null;
  resolverFails.on = false;
  resolverFails.skip = 0;
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
  async function agentGrant(userId: string, inCompany = companyId, forAgent = agentId) {
    const [grant] = await db.insert(mcpOauthGrants).values({
      companyId: inCompany, userId, clientId, agentId: forAgent, resource: agentConfig.resource, purpose: "agent", scopes: ["paperclip:agent"],
    }).returning();
    return grant!.id;
  }
  async function member(membershipRole: "owner" | "operator", restricted: boolean) {
    const id = `person-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole, restricted });
    return id;
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

  async function musePairing(operatorId: string) {
    const [agent] = await db.insert(agents).values({
      companyId, name: "Muse", role: "engineer", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "muse", allowUnmeteredProvider: true, lifecycle: "per_turn" },
    }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member", status: "active" });
    const ticket = randomBytes(32).toString("base64url");
    const [binding] = await db.insert(museAgentBindings).values({
      companyId, agentId: agent!.id, operatorId, ticketHash: museCredentialHash(ticket), ticketExpiresAt: new Date(Date.now() + 600_000),
    }).returning();
    await db.update(agents).set({ adapterConfig: { ...agent!.adapterConfig, museBindingId: binding!.id } }).where(eq(agents.id, agent!.id));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableMuse: true });
    const muse = museOAuth(db, config.origin);
    const client = await muse.register({ client_name: "Muse authd", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }, randomUUID());
    return () => muse.authorize({
      client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: "paperclip:agent offline_access",
      code_challenge: challenge, code_challenge_method: "S256", pairing_ticket: ticket,
    });
  }

  it("AC-M1 under report: a flagged person approves; the grant is written and the refusal is only recorded", async () => {
    const P = await member("operator", true);
    await setMode("report");
    try {
      await expect(approve(P, "personal")).resolves.toMatchObject({ redirectUrl: expect.stringContaining("code=") });
      expect(await grantsOf(P)).toHaveLength(1);
      expect(await denials()).toEqual(expect.arrayContaining([expect.objectContaining({
        personId: P, ruleId: "R-assistant-connection", target: "assistant_connection.approve", mode: "report",
      })]));
    } finally {
      await setMode("enforce");
    }
  });

  it("AC-M1, row 3: R under enforce cannot pair a Muse agent connection; no grant is written", async () => {
    await expect((await musePairing(R))()).rejects.toMatchObject({ code: "access_denied", status: 403 });
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

  // PAR-12931: the caller types rule group H does not bind keep today's actor.
  it("AC-M3 caller types: an instance admin who is an operator here keeps today's agent-purpose actor", async () => {
    const A = await member("operator", false);
    await db.insert(instanceUserRoles).values({ userId: A, role: "instance_admin" });
    const today = { type: "agent", source: "mcp_oauth", agentId, companyId };
    expect((await agentOAuth.authorizeGrant(await agentGrant(A))).actor).toEqual(today);
    // Flagged under report: the call is let through (recorded) and he is still not bound.
    await setFlag(A, true);
    await setMode("report");
    try {
      expect((await agentOAuth.authorizeGrant(await agentGrant(A))).actor).toEqual(today);
    } finally {
      await setMode("enforce");
    }
  });

  it("AC-M3 caller types: the owner of company X restricted in company Y; each grant reads its own company's membership", async () => {
    const P = await member("operator", true);
    const [x] = await db.insert(companies).values({
      name: "Owner co", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    await db.insert(companyMemberships).values({ companyId: x!.id, principalType: "user", principalId: P, status: "active", membershipRole: "owner" });
    const [xAgent] = await db.insert(agents).values({ companyId: x!.id, name: "Dot X", role: "engineer", adapterType: "process" }).returning();
    const { actor } = await agentOAuth.authorizeGrant(await agentGrant(P, x!.id, xAgent!.id));
    expect(actor).toEqual({ type: "agent", source: "mcp_oauth", agentId: xAgent!.id, companyId: x!.id });
    await expect(agentOAuth.authorizeGrant(await agentGrant(P))).rejects.toMatchObject({ code: "invalid_grant" });
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

  // PAR-13141: every call site fails closed on its own, not only the first one reached.
  it("AC-X1 per call site: the call check, the agent-purpose person and the Muse pairing each answer 503", async () => {
    const unavailable = { status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } };
    const [personal] = await db.insert(mcpOauthGrants).values({
      companyId, userId: R, clientId, resource: config.resource, purpose: "personal", scopes: ["paperclip:read"],
    }).returning();
    const agentGrantId = await agentGrant(R);
    const pair = await musePairing(R);
    resolverFails.on = true;
    await expect(oauth.authorizeGrant(personal!.id)).rejects.toMatchObject(unavailable);
    await expect(pair()).rejects.toMatchObject(unavailable);
    // Under report the call check reads and lets R through; the person read alone fails.
    await setMode("report");
    try {
      resolverFails.skip = 1;
      await expect(agentOAuth.authorizeGrant(agentGrantId)).rejects.toMatchObject(unavailable);
    } finally {
      await setMode("enforce");
    }
  });

  // PAR-13141: the bearer path. A failed read is 503, never 401 invalid_token (a reconnect prompt).
  it("AC-X1 per call site: bearer authenticate and the /mcp and /mcp/runner ingress answer 503", async () => {
    const unavailable = { status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } };
    const [personal] = await db.insert(mcpOauthGrants).values({
      companyId, userId: R, clientId, resource: config.resource, purpose: "personal", scopes: ["paperclip:read"],
    }).returning();
    const bearerFor = async (grantId: string) => {
      const token = `pcmcp_at_${randomBytes(24).toString("base64url")}`;
      await db.insert(mcpOauthTokens).values({ grantId, tokenHash: hashMcpSecret(token), kind: "access", expiresAt: new Date(Date.now() + 60_000) });
      return token;
    };
    const personalToken = await bearerFor(personal!.id);
    const agentToken = await bearerFor(await agentGrant(R));
    const ingress = (target: typeof oauth) => {
      const app = express();
      app.use(express.json());
      app.use(publicMcpIngressRoutes(target, vi.fn()));
      app.use(errorHandler);
      return app;
    };
    const call = (target: typeof oauth, token: string) => request(ingress(target)).post(new URL(target.config.resource).pathname)
      .set("authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    resolverFails.on = true;
    await expect(oauth.authenticate(personalToken)).rejects.toMatchObject(unavailable);
    await expect(agentOAuth.authenticate(agentToken)).rejects.toMatchObject(unavailable);
    for (const [target, token] of [[oauth, personalToken], [agentOAuth, agentToken]] as const) {
      // Both MCP paths are secret-sensitive (http-log-policy), so the error handler
      // redacts every 5xx body; the 503 and the missing reconnect challenge are the signal.
      const res = await call(target, token);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Internal server error" });
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
    // With the read working, R (flagged, enforce) gets today's 401 invalid_token.
    resolverFails.on = false;
    const refused = await call(oauth, personalToken);
    expect(refused.status).toBe(401);
    expect(refused.headers["www-authenticate"]).toContain("invalid_token");
  });
  // PAR-14330: rule group H only narrows. The person on an assistant
  // connection never widens these two actions; they stay denied as on development.
  describe("PAR-14330: the person on an assistant connection does not widen inbox:manage or agent_instructions:update", () => {
    // An agent that is an active company member, so the decisions below reach
    // the inbox and instruction branches instead of the membership check.
    let memberAgentId = "";
    beforeAll(async () => {
      const [agent] = await db.insert(agents).values({ companyId, name: "Member agent", role: "engineer", status: "active", adapterType: "process" }).returning();
      memberAgentId = agent!.id;
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: memberAgentId, membershipRole: "member", status: "active" });
      // O may edit agents, so the positive control below passes the responsible-user intersection.
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: O, permissionKey: "agents:configure" });
    });
    const company = () => ({ type: "company" as const, companyId });
    const ownAgent = () => ({ type: "agent" as const, companyId, agentId: memberAgentId });
    const connectionActor = async () => {
      const { actor } = await agentOAuth.authorizeGrant(await agentGrant(U, companyId, memberAgentId));
      expect(actor).toMatchObject({ source: "mcp_oauth", agentId: memberAgentId, onBehalfOfUserId: U });
      return actor;
    };
    const decide = (actor: Request["actor"], action: "inbox:manage" | "agent_instructions:update", resource: { type: "company"; companyId: string } | { type: "agent"; companyId: string; agentId: string }, scope?: Record<string, unknown>) =>
      authorizationService(db).decide({ actor: actor as never, action, resource, scope });

    for (const mode of ["report", "enforce"] as const) {
      it(`under ${mode}: inbox:manage with no target user is denied inbox_target_user_unresolved`, async () => {
        await setMode(mode);
        try {
          const actor = await connectionActor();
          expect(await decide(actor, "inbox:manage", company())).toMatchObject({ allowed: false, reason: "inbox_target_user_unresolved" });
        } finally {
          await setMode("enforce");
        }
      });

      it(`under ${mode}: agent_instructions:update on its own agent is denied`, async () => {
        await setMode(mode);
        try {
          const actor = await connectionActor();
          expect(await decide(actor, "agent_instructions:update", ownAgent())).toMatchObject({ allowed: false, reason: "deny_missing_membership" });
        } finally {
          await setMode("enforce");
        }
      });
    }

    it("inbox:manage on the approver's own inbox (explicit scope.userId), no saved policy and no grant: denied as before", async () => {
      const actor = await connectionActor();
      expect(await decide(actor, "inbox:manage", company(), { userId: U })).toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    });

    // Instruction edits are still intersected with the responsible user's own
    // edit rights (agents:configure), so the control uses O, who holds it.
    it("positive control: a run actor (agent_jwt) with a responsible user still gets allow_self for both", async () => {
      const runActor: Request["actor"] = { type: "agent", source: "agent_jwt", agentId: memberAgentId, companyId, onBehalfOfUserId: O };
      expect(await decide(runActor, "inbox:manage", company())).toMatchObject({ allowed: true, reason: "allow_self" });
      expect(await decide(runActor, "agent_instructions:update", ownAgent())).toMatchObject({ allowed: true, reason: "allow_self" });
    });
  });

  // PAR-14559: the same rule for connection management and asset ownership.
  // On development an assistant connection carried no person, so both stayed
  // denied; the person it now carries must not turn either into an allow.
  describe("PAR-14559: the person on an assistant connection does not widen connection management or asset ownership", () => {
    let toolAgentId = "";
    beforeAll(async () => {
      const [agent] = await db.insert(agents).values({ companyId, name: "Tool agent", role: "engineer", status: "active", adapterType: "process" }).returning();
      toolAgentId = agent!.id;
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: toolAgentId, membershipRole: "member", status: "active" });
      // The agent and U both hold the permission, so only the actor source decides.
      await db.insert(principalPermissionGrants).values([
        { companyId, principalType: "agent", principalId: toolAgentId, permissionKey: "tools:manage_connections" },
        { companyId, principalType: "user", principalId: U, permissionKey: "tools:manage_connections" },
      ]);
    });
    const connectionActor = async () => {
      const { actor } = await agentOAuth.authorizeGrant(await agentGrant(U, companyId, toolAgentId));
      expect(actor).toMatchObject({ source: "mcp_oauth", agentId: toolAgentId, onBehalfOfUserId: U });
      return actor;
    };
    const runActor = (): Request["actor"] => ({ type: "agent", source: "agent_jwt", agentId: toolAgentId, companyId, onBehalfOfUserId: U });
    const configure = (actor: Request["actor"]) => authorizationService(db).decide({
      actor: actor as never, action: "connections:configure",
      resource: { type: "connection_management", companyId, purpose: "tool", operation: "create" },
    });
    const draft = async () => {
      const [asset] = await db.insert(assets).values({
        companyId, provider: "local_disk", objectKey: `${companyId}/assets/issues/drafts/${randomUUID()}.png`,
        contentType: "image/png", byteSize: 1, sha256: "0".repeat(64), createdByAgentId: toolAgentId, createdByUserId: U,
      }).returning();
      return asset!;
    };

    for (const mode of ["report", "enforce"] as const) {
      it(`under ${mode}: connections:configure is denied RESPONSIBLE_USER_UNAVAILABLE`, async () => {
        await setMode(mode);
        try {
          expect(await configure(await connectionActor())).toMatchObject({ allowed: false, code: "RESPONSIBLE_USER_UNAVAILABLE" });
        } finally {
          await setMode("enforce");
        }
      });

      it(`under ${mode}: it does not read its agent's draft made for its person`, async () => {
        await setMode(mode);
        try {
          expect(await canActorReadAssetContent(db, await connectionActor(), await draft())).toBe(false);
        } finally {
          await setMode("enforce");
        }
      });
    }

    it("positive control: a run actor (agent_jwt) for the same agent and person is allowed both", async () => {
      expect(await configure(runActor())).toMatchObject({ allowed: true });
      expect(await canActorReadAssetContent(db, runActor() as never, await draft())).toBe(true);
    });
  });

  it("PAR-14330: a refused Muse pairing is recorded after its transaction rolls back, not while it holds the binding lock", async () => {
    const P = await member("operator", true);
    const pair = await musePairing(P);
    const lockedAtRecord: boolean[] = [];
    denialRecordHook.before = async (denial) => {
      if (denial.personId !== P) return;
      // NOWAIT fails at once if the pairing transaction still holds the row.
      const free = await db.transaction(async (tx) => {
        await tx.execute(sql`select id from muse_agent_bindings where operator_id = ${P} for update nowait`);
        return true;
      }).catch(() => false);
      lockedAtRecord.push(!free);
    };
    await expect(pair()).rejects.toMatchObject({ code: "access_denied", status: 403 });
    expect(lockedAtRecord).toEqual([false]);
    expect(await grantsOf(P)).toEqual([]);
    expect(await denials()).toEqual(expect.arrayContaining([expect.objectContaining({
      personId: P, ruleId: "R-assistant-connection", target: "assistant_connection.approve", mode: "enforce",
    })]));
  });
  it.each(["off", "report", "enforce"] as const)("PAR-14565: a file-transfer upload's refusal is recorded after its transaction ends, not while it holds the grant lock (%s)", async (mode) => {
    const P = await member("operator", false);
    const consent = await oauth.consent(await requestFor(config.resource, ["paperclip:read", "paperclip:write"]), session(P), { decision: "approve", companyId, allowWrites: true });
    expect(consent.redirectUrl).toContain("code=");
    const [grant] = await grantsOf(P);
    const [task] = await db.insert(issues).values({ companyId, title: "Upload target", createdByUserId: P }).returning();
    const storageDir = await mkdtemp(join(tmpdir(), "restriction-transfer-"));
    const storage = createStorageService(createLocalDiskStorageProvider(storageDir));
    // The personal ticket check reads the task through the API dispatch; the in-transaction check reads it directly.
    const transfers = createPublicMcpTransfers(db, oauth, async () => task!, storage);
    const bytes = Buffer.from("restriction transfer");
    const prepared = await transfers.getUploadUrl(await oauth.authorizeGrant(grant!.id), {
      companyId, taskId: task!.id, requestId: randomUUID(), filename: "note.txt", contentType: "text/plain",
      byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    // P is flagged while the upload transaction runs: the ticket checks before
    // it pass, the check inside it (holding the grant row FOR UPDATE) refuses.
    const putFile = storage.putFile.bind(storage);
    const putSpy = vi.spyOn(storage, "putFile").mockImplementationOnce(async (input) => {
      const stored = await putFile(input);
      await setFlag(P, true);
      return stored;
    });
    const lockedAtRecord: boolean[] = [];
    denialRecordHook.before = async (denial) => {
      if (denial.personId !== P) return;
      // NOWAIT fails at once if the upload transaction still holds the grant row.
      const free = await db.transaction(async (tx) => {
        await tx.execute(sql`select id from mcp_oauth_grants where id = ${grant!.id} for update nowait`);
        return true;
      }).catch(() => false);
      lockedAtRecord.push(!free);
    };
    await setMode(mode);
    try {
      const app = express(); app.use(transfers.router);
      const url = new URL(prepared.url);
      const res = await request(app).put(url.pathname + url.search).set("Content-Type", "text/plain").send(bytes);
      expect(putSpy).toHaveBeenCalledTimes(1);
      if (mode === "enforce") expect(res.status).not.toBe(200);
      else expect(res.body).toMatchObject({ attachment: { originalFilename: "note.txt" } });
      if (mode === "off") {
        // Off: nothing is refused and nothing is recorded.
        expect(lockedAtRecord).toEqual([]);
        expect((await denials()).filter((row) => row.personId === P)).toEqual([]);
        return;
      }
      expect(lockedAtRecord).toEqual([false]);
      expect(await denials()).toEqual(expect.arrayContaining([expect.objectContaining({
        personId: P, ruleId: "R-assistant-connection", target: "assistant_connection.call", mode,
      })]));
    } finally {
      putSpy.mockRestore();
      await setMode("enforce");
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
