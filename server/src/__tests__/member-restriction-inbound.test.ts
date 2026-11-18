import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, authUsers, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatVoiceSessions, companies, companyMemberships, createDb, toolApplications, toolConnections, agents,
} from "@paperclipai/db";
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
 * webhook paths (reply, no task, no wake) are in the chat and email
 * integration files.
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
    async function reserve(companyId: string, R: string) {
      const prepareBinding = vi.fn(async () => ({ issueId: randomUUID(), conversationId: randomUUID() }));
      const result = voiceSessionStore(db, { allowLocalBoard: false }).reserve({
        companyId, endpointId: randomUUID(), caller: { id: R, authority: "member" }, idempotencyKey: randomUUID(),
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
});
