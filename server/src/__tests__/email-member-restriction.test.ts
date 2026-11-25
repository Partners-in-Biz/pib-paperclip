import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agents, authUsers, chatDeliveries, companies, companyMemberships, createDb,
  emailMessages, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { emailChannelService, type EmailChannelService } from "../services/email-channels.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { agentmailMessageSchema, type AgentmailMessage } from "../services/agentmail-api.js";

/**
 * PAR-12608 4.6a row 10, AC-M8: an inbound mail is mapped to the inbox's
 * sponsor through the shipped AgentMail pipeline (`admit`, then `tick`). Kept
 * out of `email-channels.integration.test.ts` on purpose: the changed-test-files
 * CI step runs each changed file whole under an 8 minute limit.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("email restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("inbound email mapped to a restricted sponsor", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const folder = mkdtempSync(path.join(os.tmpdir(), "paperclip-email-restriction-"));
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const services: EmailChannelService[] = [];

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(folder, "master.key");
    database = await startEmbeddedPostgresTestDatabase("paperclip-email-restriction-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
    const now = new Date();
    await db.insert(authUsers).values({ id: "email-board", name: "Email Board", email: "board@example.test", emailVerified: true, createdAt: now, updatedAt: now });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(folder, { recursive: true, force: true });
  });

  /** A webhook AgentMail inbox sponsored by `email-board`, with a fake AgentMail API. */
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), endpointId = randomUUID();
    const address = `${endpointId}@agentmail.to`;
    await db.insert(companies).values({ id: companyId, name: "Email restriction", issuePrefix: `E${companyId.slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: "email-board", principalType: "user", status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Email agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const messages = new Map<string, AgentmailMessage>();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathname = decodeURIComponent(new URL(String(url)).pathname);
      if (pathname === "/v0/auth/me") return json({ scope_type: "inbox", organization_id: "organization", inbox_id: address });
      if (pathname === `/v0/inboxes/${address}`) return json({ inbox_id: address });
      if (pathname.endsWith("/webhooks")) return json({ webhook_id: "owned-webhook", secret: `whsec_${Buffer.from("test-webhook-secret").toString("base64")}` });
      if (pathname.includes("/threads/")) return json({ messages: [...messages.values()].filter((m) => m.thread_id === pathname.split("/threads/")[1]) });
      if (pathname.endsWith("/messages")) return json({ messages: [...messages.values()].map((m) => ({ message_id: m.message_id })) });
      if (pathname.includes("/messages/")) {
        const m = messages.get(pathname.split("/messages/")[1]!);
        return json(m ?? {}, m ? 200 : 404);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected test request: ${pathname}`);
    }) as unknown as typeof fetch;
    const wakeup = vi.fn().mockResolvedValue(null);
    const service = emailChannelService(db, { heartbeat: { wakeup }, fetch: fetcher, publicBaseUrl: "https://paperclip.example.test" });
    services.push(service);
    await service.setup(companyId, { assignedAgentId: agentId, apiKey: "test-key", inboxId: address, receiveMode: "webhook", idempotencyKey: endpointId },
      { userId: "email-board" });
    const message = (id: string, thread: string) => agentmailMessageSchema.parse({
      inbox_id: address, message_id: id, thread_id: thread, from: "sender@example.test", to: [address],
      subject: "Same subject", text: "Hello", timestamp: new Date(Date.now() + 1000).toISOString(), labels: ["received"],
    });
    async function receive(m: AgentmailMessage) {
      messages.set(m.message_id, m);
      await service.admit(await service.getEndpoint(endpointId), { event_type: "message.received", message: m });
      await service.tick();
    }
    return { companyId, endpointId, service, wakeup, message, receive };
  }

  /** Flags `email-board` in the company under `enforce`; `broken` makes the row unreadable (a real failed read). */
  async function restrictSponsor(companyId: string, broken: boolean) {
    await db.update(companies).set({ memberRestrictionMode: "enforce" }).where(eq(companies.id, companyId));
    await db.update(companyMemberships).set({ restricted: true })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, "email-board")));
    if (broken) {
      await db.execute(sql`UPDATE company_memberships SET restricted_plugin_keys = '"broken"'::jsonb WHERE company_id = ${companyId} AND principal_id = 'email-board'`);
    }
  }

  // A sponsor restricted under `enforce` gets no task, comment or wake. The
  // kill switch makes `enforce` behave as `off`; a failed read processes
  // nothing and leaves the mail to retry.
  it.each(["enforce", "kill switch", "failed read"] as const)("turns no mail into work for a restricted sponsor (%s)", async (variant) => {
    if (variant === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const f = await fixture();
    await restrictSponsor(f.companyId, variant === "failed read");
    await f.receive(f.message("restricted-mail", "restricted-thread"));
    const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId));
    const tasks = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
    if (variant === "kill switch") {
      expect(tasks).toHaveLength(1);
      expect(f.wakeup).toHaveBeenCalled();
      return;
    }
    expect(tasks).toEqual([]);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toEqual([]);
    expect(f.wakeup).not.toHaveBeenCalled();
    if (variant === "enforce") {
      expect(delivery).toMatchObject({ state: "filtered", redactedError: "Inbox sponsor is restricted in this company" });
    } else {
      expect(delivery!.state).not.toMatch(/^(processed|filtered)$/);
    }
  });

  // PAR-14331: the first attempt committed issueId and wakePending, then the
  // wake failed. The retry resumes past the receipt check, so the sponsor is
  // asked again right before the wake: restricted under `enforce` since the
  // first attempt, the agent is not woken; a failed read leaves it to retry.
  it.each(["enforce", "failed read"] as const)("asks the sponsor again before a retried wake after issueId was committed (%s)", async (variant) => {
    const f = await fixture();
    f.wakeup.mockRejectedValueOnce(new Error("Wake service temporarily unavailable"));
    await f.receive(f.message("retry-restricted", "retry-restricted-thread"));
    const [pending] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId));
    expect(pending!.state).toBe("retry");
    expect(pending!.normalizedEvent).toMatchObject({ issueId: expect.any(String), wakePending: true });
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    await restrictSponsor(f.companyId, variant === "failed read");
    await db.update(chatDeliveries).set({ nextAttemptAt: null }).where(eq(chatDeliveries.id, pending!.id));
    await f.service.tick();
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, pending!.id));
    if (variant === "enforce") {
      expect(after).toMatchObject({ state: "filtered", redactedError: "Inbox sponsor is restricted in this company" });
      expect(after!.normalizedEvent).toMatchObject({ wakePending: false });
    } else {
      expect(after!.state).not.toMatch(/^(processed|filtered)$/);
      expect(after!.normalizedEvent).toMatchObject({ wakePending: true });
    }
    // The mail and its task from the first attempt stay; nothing is duplicated.
    expect(await db.select().from(emailMessages).where(eq(emailMessages.endpointId, f.endpointId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(1);
  });
});
