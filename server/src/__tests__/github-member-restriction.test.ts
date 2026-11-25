import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Author, Message, Thread } from "chat";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, activityLog, agentWakeupRequests, agents, authUsers, chatActions, chatDeliveries, chatEndpoints,
  chatConversations, chatExternalPrincipals, chatIdentityLinks, companies, companyMemberships, createDb, instanceUserRoles, issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { chatChannelService, type ChatChannelService, type ChatChannelServiceOptions } from "../services/chat-channels.js";
import { githubChatManagementService } from "../services/chat-github-management.js";
import type { ChatSdkRuntime, CreateChatSdkEndpointRuntimeOptions } from "../services/chat-sdk-runtime.js";

/**
 * PAR-14560 (PAR-12608 4.6a row 11): GitHub work mapped to a restricted
 * member, through the shipped webhook and message handlers of a configured
 * GitHub review bot. Kept out of `chat-channels.integration.test.ts` on
 * purpose: the changed-test-files CI step runs each changed file whole under
 * an 8 minute limit, and that file is 85k lines. The provider is faked at its
 * HTTP and Chat SDK runtime edges only.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("GitHub restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

/** The Chat SDK endpoint runtime: keeps the service's callbacks; GitHub replies and reactions are accepted. */
class FakeEndpointRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  constructor(private readonly options: CreateChatSdkEndpointRuntimeOptions) {}
  get provider() { return this.options.providerConfig.provider; }
  async handleWebhook() { return new Response("accepted", { status: 202 }); }
  acceptsProviderScope() { return true; }
  async applyGitHubReceiptReaction(input: { githubReceipt?: unknown }, assertCurrent: () => Promise<void>) {
    await assertCurrent();
    return input.githubReceipt ?? { botUserId: "9001", reactionId: "880012" };
  }
  async resolveGitHubAttachmentComment() { return null; }
  thread(threadId: string) {
    const channelId = threadId.split(":")[1] ?? threadId;
    return {
      id: threadId, channelId, isDM: false, channel: { id: channelId, name: channelId },
      adapter: { addReaction: async () => undefined, removeReaction: async () => undefined,
        editMessage: async (id: string, messageId: string) => ({ id: messageId, threadId: id }) },
      startTyping: async () => undefined, subscribe: async () => undefined,
      post: async () => ({ id: `outbound-${randomUUID()}`, threadId }),
    };
  }
}

class FakeChatSdkRuntime {
  readonly endpoints = new Map<string, FakeEndpointRuntime>();
  readonly configurations = new Map<string, CreateChatSdkEndpointRuntimeOptions>();
  get(endpointId: string) { return this.endpoints.get(endpointId) ?? null; }
  hasUnsettledLifecycle() { return false; }
  async replaceEndpoint(options: CreateChatSdkEndpointRuntimeOptions) {
    this.configurations.set(options.endpointId, options);
    const endpoint = new FakeEndpointRuntime(options);
    this.endpoints.set(options.endpointId, endpoint);
    return endpoint;
  }
  async removeEndpoint(endpointId: string) {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return false;
    this.endpoints.delete(endpointId);
    await endpoint.shutdown();
    return true;
  }
  async shutdown() {
    await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.shutdown()));
    this.endpoints.clear();
  }
}

function signedGitHubRequest(input: { event: string; delivery: string; payload: unknown; webhookSecret: string; publicId: string }) {
  const body = JSON.stringify(input.payload);
  const signature = createHmac("sha256", input.webhookSecret).update(body).digest("hex");
  return new Request(`https://paperclip.example/api/chat-webhooks/${input.publicId}/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": input.event, "x-github-delivery": input.delivery,
      "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

function makeThread(id: string) {
  return { id, channelId: "paperclipai/paperclip", isDM: false, channel: { id: "paperclipai/paperclip", name: "Guest review" },
    adapter: { addReaction: vi.fn(async () => undefined) }, startTyping: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined), post: vi.fn(async () => ({ id: `thread-post-${randomUUID()}`, threadId: id })),
    postEphemeral: vi.fn(async () => ({ id: `thread-ephemeral-${randomUUID()}`, threadId: id, usedFallback: false })),
  } as unknown as Thread;
}

function makeMessage(input: { id: string; text: string; userId: string; userName: string }) {
  return {
    id: input.id, raw: undefined, text: input.text, isMention: true, attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    author: { userId: input.userId, userName: input.userName, fullName: input.userName, isBot: false, isMe: false, isSystem: false } satisfies Author,
  } as unknown as Message;
}

(support.supported ? describe : describe.skip)("GitHub work mapped to a restricted member", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsDir = path.join(os.tmpdir(), `paperclip-github-restriction-${randomUUID()}`);
  const services = new Set<ChatChannelService>();

  beforeAll(async () => {
    mkdirSync(secretsDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-restriction-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({ id: "owner-user", name: "Owner User", email: "owner-user@example.com", emailVerified: true, createdAt: now, updatedAt: now });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await Promise.all([...services].map((service) => service.shutdown()));
    services.clear();
    // Services scan the shared database; retire this case's endpoints.
    await db.update(chatEndpoints).set({ status: "paused" });
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  /** Mirrors the shipped heartbeat: the durable wake request is written only after its authorization passes. */
  function receiptBackedWakeup(wakeup: ChatChannelServiceOptions["heartbeat"]["wakeup"]): ChatChannelServiceOptions["heartbeat"]["wakeup"] {
    return async (agentId, opts) => {
      const result = await wakeup(agentId, opts);
      const request = opts.durableChatRequest;
      if (request && result !== null && result !== undefined) {
        await db.transaction(async (tx) => {
          await request.authorize(tx as unknown as Parameters<typeof request.authorize>[0]);
          await tx.insert(agentWakeupRequests).values({
            id: request.id, companyId: request.companyId, agentId, source: opts.source ?? "assignment",
            triggerDetail: opts.triggerDetail, reason: opts.reason, payload: opts.payload,
            requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId,
            idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt, status: "queued",
          }).onConflictDoNothing();
        });
      }
      return result;
    };
  }

  /**
   * A configured GitHub review bot for repository paperclipai/paperclip (installation 2468), its
   * webhook verified, owned by `owner-user`, with GitHub user 42 (octocat) linked to `owner-user`.
   */
  async function reviewBotFixture() {
    const companyId = randomUUID(), assignedAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `GitHub restriction ${companyId.slice(0, 8)}`,
      issuePrefix: `G${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "owner-user",
      permissionKey: "tools:manage_connections", scope: null, grantedByUserId: "owner-user" });
    await db.insert(agents).values({ id: assignedAgentId, companyId, name: "Maya", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const appId = Number.parseInt(companyId.replaceAll("-", "").slice(0, 8), 16);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const permissions = { contents: "read", checks: "write", issues: "write", metadata: "read", pull_requests: "write" };
    const repositories = [{ id: 97531, full_name: "paperclipai/paperclip", html_url: "https://github.com/paperclipai/paperclip",
      owner: { id: 1357, login: "paperclipai" }, private: false }];
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (/\/repos\/paperclipai\/paperclip\/(issues|pulls)\/[1-9][0-9]*\/comments(?:\?.*)?$/.test(url)) {
        if (init?.method === "POST") return Response.json({ id: Date.now(), body: "", user: { login: "maya[bot]" } }, { status: 201 });
        return Response.json([]);
      }
      if (url === "https://api.github.com/app/hook/config") return Response.json(JSON.parse(String(init?.body)));
      if (url === "https://api.github.com/app") return Response.json({ id: appId, slug: `maya-${companyId.slice(0, 8)}`, name: "Maya Paperclip",
        owner: { login: "paperclipai" }, permissions, events: ["pull_request", "github_app_authorization", "installation",
          "installation_repositories", "issue_comment", "pull_request_review_comment"] });
      if (url === "https://api.github.com/app/installations/2468") return Response.json({ permissions, suspended_at: null });
      if (url === "https://api.github.com/app/installations?per_page=100") return Response.json([{ id: 2468,
        account: { id: 1357, login: "paperclipai", type: "Organization" }, permissions, suspended_at: null }]);
      if (url === "https://api.github.com/app/installations/2468/access_tokens") return Response.json({ token: "installation-token" }, { status: 201 });
      if (url === "https://api.github.com/installation/repositories?per_page=100&page=1") return Response.json({ repositories });
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;
    const runtime = new FakeChatSdkRuntime();
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(async () => ({ accepted: true }) as never);
    const service = chatChannelService(db, {
      fetch: providerFetch, publicBaseUrl: "https://paperclip.example", runtime: runtime as unknown as ChatSdkRuntime,
      heartbeat: { cancelRun: vi.fn(async () => ({ status: "cancelled" }) as never), wakeup: receiptBackedWakeup(wakeup) },
    });
    services.add(service);
    const created = await service.create(companyId, { provider: "github", assignedAgentId, name: "Maya in GitHub" }, "owner-user");
    const { webhookSecret } = await service.generateSetupSecret(created.id, "owner-user");
    // The setup ping verifies the webhook, as in the shipped wizard.
    const ping = `github-setup-ping-${randomUUID()}`;
    expect([200, 202]).toContain((await service.handleWebhook(created.publicId, "github", signedGitHubRequest({
      event: "ping", delivery: ping, payload: { zen: "Keep it logically awesome." }, webhookSecret, publicId: created.publicId,
    }))).status);
    const [pingAction] = await db.select({ id: chatActions.id }).from(chatActions)
      .where(and(eq(chatActions.endpointId, created.id), eq(chatActions.providerActionId, `github_webhook_ingress:${ping}`)));
    if (pingAction) await service.processPendingGitHubWebhookIngress(1, pingAction.id);
    await vi.waitFor(async () => {
      const [row] = await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, created.id));
      expect(row?.setup).toMatchObject({ webhookVerifiedAt: expect.any(String) });
    });
    await service.configure(created.id, { action: "configure", credentials: { appId: String(appId), privateKey } }, "owner-user");
    const resources = await service.listResources(created.id);
    await service.replaceResources(created.id, [{ id: resources[0]!.id, enabled: true }]);
    const callbacks = runtime.configurations.get(created.id)?.callbacks;
    if (!callbacks) throw new Error("Fake runtime did not receive GitHub callbacks");
    const endpoint = await service.get(created.id);
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "github", providerAccountId: endpoint.providerAccountId!,
      externalId: "42", kind: "user", displayName: "Octocat", handle: "octocat", isBot: false }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint.id, principalId: principal!.id, paperclipUserId: "owner-user",
      status: "linked", confirmedAt: new Date() });
    const management = githubChatManagementService(db, providerFetch);
    const initial = await management.configuration(endpoint.id, "owner-user");
    await management.saveConfiguration(endpoint.id, { expectedRevision: initial.revision,
      configuration: { ...initial.configuration, toolsEnabled: true } }, "owner-user");
    await service.update(endpoint.id, { allowGroupChats: true }, "owner-user");
    return { companyId, service, endpoint, principal: principal!, management, callbacks, webhookSecret, wakeup };
  }

  type Fixture = Awaited<ReturnType<typeof reviewBotFixture>>;
  /** Flags `owner-user` in the company; `broken` makes his row unreadable (a real failed read: the plugin list is not a list). */
  async function restrictOwner(f: Fixture, mode: "report" | "enforce", broken: boolean) {
    await db.update(companyMemberships).set({ restricted: true }).where(and(eq(companyMemberships.companyId, f.companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, "owner-user")));
    if (broken) {
      await db.execute(sql`UPDATE company_memberships SET restricted_plugin_keys = '"broken"'::jsonb WHERE company_id = ${f.companyId} AND principal_id = 'owner-user'`);
    }
    await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, f.companyId));
  }
  const denied = (companyId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied")))
    .then((rows) => rows.map((row) => row.details));
  const conversations = (endpointId: string) => db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpointId));
  const deliveries = (endpointId: string) => db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, endpointId));
  async function expectNothingCreated(f: Fixture) {
    expect(await conversations(f.endpoint.id)).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    expect(f.wakeup).not.toHaveBeenCalled();
  }

  // Automatic GitHub work is created for, and wakes the agent for, the
  // configuration's responsible user, not the author. The author here is
  // linked to an unrestricted member; the responsible user (owner-user) is
  // flagged. Under `enforce` the shipped webhook handler creates no
  // conversation, task or wake; `report` records a would-refuse and admits; a
  // failed read leaves the ingress to retry; a flagged instance admin is not bound.
  it.each(["enforce", "report", "failed read", "instance admin"] as const)("maps automatic GitHub work to its restricted responsible user through the webhook handler (%s)", async (variant) => {
    const f = await reviewBotFixture();
    const saved = await f.management.configuration(f.endpoint.id, "owner-user");
    await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision,
      configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, issueOpened: true } } }, "owner-user");
    const author = `github-author-${randomUUID()}`, now = new Date();
    await db.insert(authUsers).values({ id: author, name: "Author", email: `${author}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: author, status: "active", membershipRole: "operator" });
    await db.update(chatIdentityLinks).set({ paperclipUserId: author }).where(eq(chatIdentityLinks.principalId, f.principal.id));
    await restrictOwner(f, variant === "report" ? "report" : "enforce", variant === "failed read");
    if (variant === "instance admin") {
      const [role] = await db.insert(instanceUserRoles).values({ userId: "owner-user", role: "instance_admin" }).returning();
      onTestFinished(async () => { await db.delete(instanceUserRoles).where(eq(instanceUserRoles.id, role!.id)); });
    }
    const delivery = randomUUID();
    const sent = f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubRequest({
      event: "issues", delivery, webhookSecret: f.webhookSecret, publicId: f.endpoint.publicId,
      payload: {
        action: "opened", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        issue: { number: 91, title: "Automatic work", body: "", user: { id: 42, login: "octocat", type: "User" }, labels: [] },
      },
    }));
    if (variant === "failed read") await expect(sent).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    else expect((await sent).status).toBeLessThan(300);
    if (variant === "report" || variant === "instance admin") {
      await expect.poll(async () => (await conversations(f.endpoint.id)).length, { timeout: 10_000 }).toBe(1);
      const [conversation] = await conversations(f.endpoint.id);
      expect((await db.select().from(issues).where(eq(issues.id, conversation!.issueId!)))[0]).toMatchObject({ responsibleUserId: "owner-user" });
      expect(await denied(f.companyId)).toEqual(variant === "report"
        ? [expect.objectContaining({ personId: "owner-user", target: "inbound.chat", mode: "report" })]
        : []);
      return;
    }
    if (variant === "failed read") {
      // 503 MEMBER_RESTRICTION_UNAVAILABLE: the durable ingress is kept for a retry, nothing is admitted.
      await expect.poll(async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.providerActionId, `github_webhook_ingress:${delivery}`))))[0], { timeout: 10_000 })
        .toMatchObject({ status: "failed", result: expect.objectContaining({ retryable: true }) });
      expect(await deliveries(f.endpoint.id)).toEqual([]);
    } else {
      await expect.poll(async () => (await deliveries(f.endpoint.id)).map((row) => [row.state, row.redactedError]), { timeout: 10_000 })
        .toEqual([["filtered", "GitHub issue opened ignored. The member responsible for automatic tasks is restricted in this company."]]);
      expect(await denied(f.companyId)).toEqual([expect.objectContaining({ personId: "owner-user", target: "inbound.chat", mode: "enforce" })]);
    }
    await expectNothingCreated(f);
  });

  // A GitHub guest's mention is work for the guest's sponsor. A sponsor
  // restricted under `enforce` admits no guest through the shipped message
  // handler; `report` records a would-refuse and admits; a failed read creates
  // nothing and leaves the delivery to retry.
  it.each(["enforce", "report", "failed read"] as const)("maps a GitHub guest's mention to its restricted sponsor through the message handler (%s)", async (variant) => {
    const f = await reviewBotFixture();
    const initial = await f.management.configuration(f.endpoint.id, "owner-user");
    await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: initial.revision,
      configuration: { ...initial.configuration, people: [{ kind: "guest", githubUserId: "84", login: "contributor",
        sponsorUserId: "owner-user", permissionProfile: "restricted", automaticReviews: false }] } }, "owner-user");
    await restrictOwner(f, variant === "report" ? "report" : "enforce", variant === "failed read");
    const delivered = f.callbacks.onMessage({ endpointId: f.endpoint.id, provider: "github", trigger: "mention",
      thread: makeThread("github:paperclipai/paperclip:95"),
      message: makeMessage({ id: "guest-restricted-sponsor", text: "Please review this PR", userId: "84", userName: "contributor" }) });
    if (variant === "failed read") await expect(delivered).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
    else await delivered;
    const rows = (await deliveries(f.endpoint.id)).map((row) => [row.eventKind, row.state, row.redactedError]);
    if (variant === "report") {
      expect(rows).toEqual([["mention", "processed", null]]);
      expect(await conversations(f.endpoint.id)).toHaveLength(1);
      expect(await denied(f.companyId)).toEqual([expect.objectContaining({ personId: "owner-user", target: "inbound.chat", mode: "report" })]);
      return;
    }
    expect(rows).toEqual([variant === "enforce"
      ? ["mention", "filtered", "Endpoint sponsor can no longer authorize external guests"]
      : ["mention", "retry", "Member restriction could not be read"]]);
    expect(await denied(f.companyId)).toEqual(variant === "enforce" ? [expect.objectContaining({ personId: "owner-user", target: "inbound.chat", mode: "enforce" })] : []);
    await expectNothingCreated(f);
  });
});
