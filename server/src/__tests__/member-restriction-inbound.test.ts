import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, authUsers, chatEndpoints, chatExternalPrincipals, chatGitHubConfigurations, chatIdentityLinks,
  chatVoiceSessions, companies, companyMemberships, createDb, instanceUserRoles, toolApplications, toolConnections, agents,
} from "@paperclipai/db";
import type { GitHubChatConfiguration } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { voiceSessionStore } from "../services/voice/voice-session-store.js";
import { createChatInboundAuthority } from "../services/chat-channels/inbound/authorization.js";
import { INBOUND_MEMBER_RESTRICTION_RULE_ID } from "../services/member-restriction/inbound.js";

/**
 * PAR-12608 4.6a rows 6 and 11, AC-M8: an inbound call or chat message is
 * mapped to its person at one point each (`voiceSessionStore.authorizeCaller`,
 * the chat inbound authority). A member restricted under `enforce` is refused
 * there, before anything is written. Per new consumer (AC-F8, AC-X1): the
 * kill switch `off` makes `enforce` behave as `off`, and a failed read is 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`. The failed read is a real one: a flagged
 * row whose plugin list is not a list makes the resolver throw. The full
 * webhook paths (reply, no task, no wake) are in
 * `github-member-restriction.test.ts`, `email-member-restriction.test.ts` and
 * `slack-cloud-owner-work.test.ts`.
 */

type Mode = "off" | "report" | "enforce";
const support = await getEmbeddedPostgresTestSupport();

describe("inbound restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("inbound voice and chat mapped to a restricted member", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-inbound-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await tempDb?.cleanup(); });

  /** A company on `mode` with R, a flagged operator; `broken` makes his row unreadable. */
  async function setup(mode: Mode, options: { broken?: boolean } = {}) {
    const companyId = randomUUID();
    const R = `restricted-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Inbound", issuePrefix: `I${companyId.slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode });
    const now = new Date();
    await db.insert(authUsers).values({ id: R, name: "R", email: `${R}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true });
    if (options.broken) {
      await db.execute(sql`UPDATE company_memberships SET restricted_plugin_keys = '"broken"'::jsonb WHERE company_id = ${companyId} AND principal_id = ${R}`);
    }
    return { companyId, R };
  }
  const denials = (companyId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied")))
    .then((rows) => rows.map((row) => row.details as Record<string, unknown>));

  describe("row 6: voice", () => {
    /** A voice reservation by R: the inbound call's first step. The session is written only after the person check. */
    async function reserve(companyId: string, R: string, authority: "member" | "instance_admin" = "member") {
      const prepareBinding = vi.fn(async () => ({ issueId: randomUUID(), conversationId: randomUUID() }));
      const result = voiceSessionStore(db, { allowLocalBoard: false }).reserve({
        companyId, endpointId: randomUUID(), caller: { id: R, authority }, idempotencyKey: randomUUID(),
        requestFingerprint: "fingerprint", maxDurationSeconds: 60, mode: "browser", prepareBinding,
      });
      return { result, prepareBinding };
    }
    const sessions = (companyId: string) => db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, companyId));

    it("AC-M8 row 6: a call mapped to R under enforce is refused; nothing is created and no run starts", async () => {
      const { companyId, R } = await setup("enforce");
      const { result, prepareBinding } = await reserve(companyId, R);
      await expect(result).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/restricted/) });
      expect(prepareBinding).not.toHaveBeenCalled();
      expect(await sessions(companyId)).toEqual([]);
      expect(await denials(companyId)).toEqual([expect.objectContaining({ ruleId: INBOUND_MEMBER_RESTRICTION_RULE_ID, target: "inbound.voice", mode: "enforce" })]);
    });

    it.each(["report", "kill switch"] as const)("under %s, R's call passes the person check", async (variant) => {
      if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const { companyId, R } = await setup(variant === "report" ? "report" : "enforce");
      // Past the person check the store looks up the line; this one has none.
      await expect((await reserve(companyId, R)).result).rejects.toMatchObject({ status: 404, message: "Voice connection not found" });
      expect(await denials(companyId)).toHaveLength(variant === "report" ? 1 : 0);
    });

    it("a failed restriction read is 503 MEMBER_RESTRICTION_UNAVAILABLE and creates nothing", async () => {
      const { companyId, R } = await setup("enforce", { broken: true });
      const { result, prepareBinding } = await reserve(companyId, R);
      await expect(result).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
      expect(prepareBinding).not.toHaveBeenCalled();
      expect(await sessions(companyId)).toEqual([]);
    });

    // PAR-14331: out of scope on purpose. PAR-12608 sections 2 and 4.1 never
    // bind an instance admin (the route guard and plugin gate skip him too), so
    // a flagged member who is also an instance admin and calls with that
    // authority passes the person check under `enforce` and records nothing.
    it("a flagged member calling as instance_admin under enforce is not bound (instance admins are out of scope)", async () => {
      const { companyId, R } = await setup("enforce");
      await db.insert(instanceUserRoles).values({ userId: R, role: "instance_admin" });
      try {
        await expect((await reserve(companyId, R, "instance_admin")).result).rejects.toMatchObject({ status: 404, message: "Voice connection not found" });
        expect(await denials(companyId)).toEqual([]);
      } finally {
        await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, R));
      }
    });

    it("instance_admin authority without an instance_user_roles row is refused before the person check", async () => {
      const { companyId, R } = await setup("enforce");
      await expect((await reserve(companyId, R, "instance_admin")).result).rejects.toMatchObject({ status: 403, message: "Voice access is no longer available" });
      expect(await denials(companyId)).toEqual([]);
    });
  });

  describe("row 11: guest under a sponsor mapped to R", () => {
    /** A Slack endpoint sponsored by R that admits unlinked people; the sender has no link. */
    async function guestEndpoint(companyId: string, R: string) {
      const [agent] = await db.insert(agents).values({ companyId, name: "Guest agent", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
      const [application] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "slack", providerAccountId: "T1",
        publicId: randomUUID(), assignedAgentId: agent!.id, status: "active", sponsorUserId: R, allowUnlinkedPeople: true }).returning();
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "T1", externalId: `U${randomUUID().slice(0, 8)}` }).returning();
      const authority = createChatInboundAuthority(db, { voiceStore: { authorizePrincipal: vi.fn() }, runtimeCallbackEndpoint: vi.fn() });
      return { endpoint: endpoint!, principal: principal!, authority };
    }

    it("under enforce a restricted sponsor admits no guest, at receipt and at the task write", async () => {
      const { companyId, R } = await setup("enforce");
      const { endpoint, principal, authority } = await guestEndpoint(companyId, R);
      await expect(authority.sponsorAllowsGuest(endpoint)).resolves.toBe(false);
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .resolves.toMatchObject({ allowed: false, userId: null });
      expect(await denials(companyId)).toEqual([expect.objectContaining({ ruleId: INBOUND_MEMBER_RESTRICTION_RULE_ID, target: "inbound.chat", mode: "enforce" })]);
    });

    it.each(["report", "kill switch"] as const)("under %s the sponsor admits the guest", async (variant) => {
      if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const { companyId, R } = await setup(variant === "report" ? "report" : "enforce");
      const { endpoint, principal, authority } = await guestEndpoint(companyId, R);
      await expect(authority.sponsorAllowsGuest(endpoint)).resolves.toBe(true);
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .resolves.toMatchObject({ allowed: true, userId: null });
    });

    it("a failed restriction read of the sponsor is 503 MEMBER_RESTRICTION_UNAVAILABLE, never an admitted guest", async () => {
      const { companyId, R } = await setup("enforce", { broken: true });
      const { endpoint, principal, authority } = await guestEndpoint(companyId, R);
      await expect(authority.sponsorAllowsGuest(endpoint)).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .rejects.toMatchObject({ status: 503 });
    });
  });

  describe("row 11: chat identity mapped to R", () => {
    /** A Slack endpoint with R's Slack identity linked to him. */
    async function linkedEndpoint(companyId: string, R: string) {
      const [agent] = await db.insert(agents).values({ companyId, name: "Chat agent", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
      const [application] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "slack", providerAccountId: "T1",
        publicId: randomUUID(), assignedAgentId: agent!.id, status: "active" }).returning();
      const externalId = `U${randomUUID().slice(0, 8)}`;
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "T1", externalId }).returning();
      await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint!.id, principalId: principal!.id, paperclipUserId: R, status: "linked", confirmedAt: new Date() });
      const authority = createChatInboundAuthority(db, { voiceStore: { authorizePrincipal: vi.fn() }, runtimeCallbackEndpoint: vi.fn() });
      const author = { userId: externalId, userName: "r", fullName: "R", isBot: false, isMe: false, isSystem: false } as const;
      return { endpoint: endpoint!, principal: principal!, authority, author };
    }

    it("AC-M8 row 11: under enforce his identity is mapped to no person and marked restricted, at receipt and at the task write", async () => {
      const { companyId, R } = await setup("enforce");
      const { endpoint, principal, authority, author } = await linkedEndpoint(companyId, R);
      await expect(authority.ensurePrincipal(endpoint, author)).resolves.toMatchObject({ userId: null, linkedDenied: true, restricted: true });
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .resolves.toMatchObject({ allowed: false, linkedDenied: true, userId: null });
    });

    it.each(["report", "kill switch"] as const)("under %s his identity maps to him", async (variant) => {
      if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const { companyId, R } = await setup(variant === "report" ? "report" : "enforce");
      const { endpoint, principal, authority, author } = await linkedEndpoint(companyId, R);
      await expect(authority.ensurePrincipal(endpoint, author)).resolves.toMatchObject({ userId: R, linkedDenied: false });
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .resolves.toMatchObject({ allowed: true, userId: R });
    });

    it("a failed restriction read is 503 MEMBER_RESTRICTION_UNAVAILABLE, never a mapped person", async () => {
      const { companyId, R } = await setup("enforce", { broken: true });
      const { endpoint, principal, authority, author } = await linkedEndpoint(companyId, R);
      await expect(authority.ensurePrincipal(endpoint, author)).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
      await expect(db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)))
        .rejects.toMatchObject({ status: 503 });
    });
  });

  describe("row 11: GitHub identity mapped to R", () => {
    /**
     * A GitHub endpoint with a saved configuration, so the task-write lock takes
     * its GitHub branch (`githubChatPrincipalAccess`), with R's GitHub identity linked to him.
     */
    async function githubLinkedEndpoint(companyId: string, R: string, as: "linked" | "guest" = "linked") {
      const [agent] = await db.insert(agents).values({ companyId, name: "GitHub agent", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
      const [application] = await db.insert(toolApplications).values({ companyId, name: "GitHub", type: "chat" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "GitHub", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "github", providerAccountId: "1001",
        publicId: randomUUID(), assignedAgentId: agent!.id, status: "active", allowUnlinkedPeople: as === "guest" }).returning();
      const githubUserId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      // Only `people` and `memberAccess` are read on this path. A guest is
      // listed with R as his sponsor and has no link of his own.
      const people = as === "guest" ? [{ githubUserId, login: "guest", kind: "guest", sponsorUserId: R, permissionProfile: "restricted" }] : [];
      const configuration = { version: 1, toolsEnabled: true, responsibleUserId: R, memberAccess: "all_linked", people } as unknown as GitHubChatConfiguration;
      await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: endpoint!.id, configuration, updatedByUserId: R });
      const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "github", providerAccountId: "1001", externalId: githubUserId }).returning();
      if (as === "linked") {
        await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint!.id, principalId: principal!.id, paperclipUserId: R, status: "linked", confirmedAt: new Date() });
      }
      const authority = createChatInboundAuthority(db, { voiceStore: { authorizePrincipal: vi.fn() }, runtimeCallbackEndpoint: vi.fn() });
      const lock = () => db.transaction((tx) => authority.lockCurrentPrincipalAuthorization(tx, endpoint!, principal!.id));
      return { lock };
    }

    it("AC-M8 row 11: under enforce the GitHub branch maps his identity to no person", async () => {
      const { companyId, R } = await setup("enforce");
      const { lock } = await githubLinkedEndpoint(companyId, R);
      await expect(lock()).resolves.toMatchObject({ allowed: false, linkedDenied: true, userId: null });
      expect(await denials(companyId)).toEqual([expect.objectContaining({ ruleId: INBOUND_MEMBER_RESTRICTION_RULE_ID, target: "inbound.chat", mode: "enforce" })]);
    });

    it.each(["report", "kill switch"] as const)("under %s the GitHub branch maps his identity to him", async (variant) => {
      if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const { companyId, R } = await setup(variant === "report" ? "report" : "enforce");
      const { lock } = await githubLinkedEndpoint(companyId, R);
      await expect(lock()).resolves.toMatchObject({ allowed: true, linkedDenied: false, userId: R });
    });

    it("a failed restriction read on the GitHub branch is 503 MEMBER_RESTRICTION_UNAVAILABLE", async () => {
      const { companyId, R } = await setup("enforce", { broken: true });
      const { lock } = await githubLinkedEndpoint(companyId, R);
      await expect(lock()).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    });

    // PAR-14331: a GitHub guest carries his own sponsor in the configuration.
    it("under enforce a GitHub guest whose sponsor is R is not admitted", async () => {
      const { companyId, R } = await setup("enforce");
      const { lock } = await githubLinkedEndpoint(companyId, R, "guest");
      await expect(lock()).resolves.toMatchObject({ allowed: false, userId: null, sponsorUserId: null });
      expect(await denials(companyId)).toEqual([expect.objectContaining({ ruleId: INBOUND_MEMBER_RESTRICTION_RULE_ID, target: "inbound.chat", mode: "enforce" })]);
    });

    it.each(["report", "kill switch"] as const)("under %s a GitHub guest whose sponsor is R is admitted under R", async (variant) => {
      if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const { companyId, R } = await setup(variant === "report" ? "report" : "enforce");
      const { lock } = await githubLinkedEndpoint(companyId, R, "guest");
      await expect(lock()).resolves.toMatchObject({ allowed: true, userId: null, sponsorUserId: R });
    });

    it("a failed restriction read of a GitHub guest's sponsor is 503 MEMBER_RESTRICTION_UNAVAILABLE", async () => {
      const { companyId, R } = await setup("enforce", { broken: true });
      const { lock } = await githubLinkedEndpoint(companyId, R, "guest");
      await expect(lock()).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    });
  });
});
