/**
 * Push acceptance journey tests (Postgres).
 * Integration tests covering ask-owner assignment, rapid issue batching,
 * quiet hours, owner-push route, and transport error handling.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";
import { generateP256Keys, decryptPayload } from "./push-test-helpers.js";
import { listRecentPushLog, upsertSubscription, listSubscriptionsForUser } from "../src/push/store.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { sendPush, type PushPayload } from "../src/push/send.js";
import { handleOwnerPush } from "../src/push/owner-push-route.js";
import { onIssueNeedsYou } from "../src/push/triggers-needs-you.js";
import type { Env } from "../src/env.js";

// Mock transport.postPush for scenario d
const t = vi.hoisted(() => ({ postPush: vi.fn() }));
vi.mock("../src/push/transport.js", async (orig) => {
  const module = await orig();
  return { ...(module as any), postPush: t.postPush };
});

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const COMPANY_ID = COMPANY;
const OWNER_ID = "owner-user-1";
const INITIAL_NOW = new Date("2026-10-20T10:30:00Z");

d("Push acceptance journey (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let env: Env;
  let subscriber: ReturnType<typeof generateP256Keys>;
  let clock: { now: Date };
  let posts: Array<{ endpoint: string; headers: Record<string, string>; body: Buffer }> = [];
  let statusFor: Map<string, number> = new Map();

  beforeAll(async () => {
    pg = await startPg();
    subscriber = generateP256Keys();
    clock = { now: new Date(INITIAL_NOW) };

    env = {
      ctx: pg.ctx,
      skills: { ensure: async () => undefined } as any,
      now: () => clock.now,
    };

    // Enable push in config
    pg.config.set(COMPANY_ID, { pushEnabled: true });

    // Seed roles with owner
    await saveRoles(pg.ctx, {
      companyId: COMPANY_ID,
      operatorAgentId: null,
      reviewerAgentId: null,
      ownerUserId: OWNER_ID,
      reviewOutward: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    } as RolesRow);

    // Seed an ok subscription for the owner
    await upsertSubscription(pg.ctx, {
      companyId: COMPANY_ID,
      userId: OWNER_ID,
      endpoint: "https://fcm.googleapis.com/fcm/send/device-owner",
      p256dh: subscriber.p256dh,
      auth: subscriber.auth,
      deviceLabel: "Test Phone",
    });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    clock.now = new Date(INITIAL_NOW);
    // Inject clock into appendPushLog's new Date() calls (only Date, not timers)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.now);

    // Clear logs, rate limits, and seen assignees
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_log WHERE company_id = $1`,
      [COMPANY_ID],
    );
    await pg.ctx.db.execute(`DELETE FROM plugin_cockpit_b8a99e8b16.push_rate`, []);
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_seen_assignee WHERE company_id = $1`,
      [COMPANY_ID],
    );

    // Reset owner subscription to ok state
    await upsertSubscription(pg.ctx, {
      companyId: COMPANY_ID,
      userId: OWNER_ID,
      endpoint: "https://fcm.googleapis.com/fcm/send/device-owner",
      p256dh: subscriber.p256dh,
      auth: subscriber.auth,
      deviceLabel: "Test Phone",
    });

    posts = [];
    statusFor.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fake transport: records posts, returns configured status
  async function fakePost(
    endpoint: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: string; bodyTruncated: boolean }> {
    posts.push({ endpoint, headers, body });
    const status = statusFor.get(endpoint) ?? 201;
    return { status, headers: {}, body: "", bodyTruncated: false };
  }

  // Scenario a: ask-owner assignment -> decrypted push has correct title and link
  it("ask-owner assignment -> decrypted push body has correct title and link", async () => {
    const issueId = "issue-needs-you-1";
    const identifier = "PAR-123";
    const issueTitle = "Needs approval";

    vi.spyOn(pg.ctx.issues, "get").mockResolvedValueOnce({
      id: issueId,
      companyId: COMPANY_ID,
      identifier,
      title: issueTitle,
      assigneeUserId: OWNER_ID,
    } as any);

    const event: PluginEvent = {
      eventId: "test-event-1",
      eventType: "issue.updated",
      occurredAt: clock.now.toISOString(),
      actorId: "test-actor",
      actorType: "system",
      entityId: issueId,
      entityType: "issue",
      companyId: COMPANY_ID,
      payload: {
        identifier,
        _previous: { assigneeUserId: null },
      },
    };

    await onIssueNeedsYou(env, event, {
      deliver: async (ctx, companyId, subs, payload) => {
        await sendPush(ctx, companyId, subs, payload, {
          class: payload.class,
          deps: { postPush: fakePost as any, now: env.now },
        });
      },
    });

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.endpoint).toBe("https://fcm.googleapis.com/fcm/send/device-owner");

    const decrypted = JSON.parse(
      decryptPayload(post.body, subscriber.privateKey, subscriber.auth),
    );
    expect(decrypted.title).toBe(issueTitle);
    expect(decrypted.url).toBe(`https://paperclip.partnersinbiz.online/PAR/issues/${identifier}`);
    expect(decrypted.class).toBe("needs_you");
  });

  // Scenario b: 5 rapid issues -> 3 sends + 1 collapse = 4 transport calls
  it("5 rapid issues -> 3 pushes then collapse notice (4 transport calls total)", async () => {
    clock.now = new Date("2026-10-20T12:00:00Z");
    vi.setSystemTime(clock.now);

    for (let i = 1; i <= 5; i++) {
      const eventTime = new Date(new Date("2026-10-20T12:00:00Z").getTime() + (i - 1) * 60 * 1000);
      clock.now = eventTime;
      vi.setSystemTime(clock.now);

      vi.spyOn(pg.ctx.issues, "get").mockResolvedValueOnce({
        id: `issue-batch-${i}`,
        companyId: COMPANY_ID,
        identifier: `PAR-${100 + i}`,
        title: `Issue ${i}`,
        assigneeUserId: OWNER_ID,
      } as any);

      const event: PluginEvent = {
        eventId: `batch-event-${i}`,
        eventType: "issue.updated",
        occurredAt: clock.now.toISOString(),
        actorId: "test-actor",
        actorType: "system",
        entityId: `issue-batch-${i}`,
        entityType: "issue",
        companyId: COMPANY_ID,
        payload: {
          identifier: `PAR-${100 + i}`,
          _previous: { assigneeUserId: null },
        },
      };

      await onIssueNeedsYou(env, event, {
        deliver: async (ctx, companyId, subs, payload) => {
          await sendPush(ctx, companyId, subs, payload, {
            class: payload.class,
            deps: { postPush: fakePost as any, now: env.now },
          });
        },
      });
    }

    // 3 individual issue pushes + 1 collapse notification = 4 transport calls
    expect(posts.length).toBe(4);

    const decryptions = posts.map((p) =>
      JSON.parse(decryptPayload(p.body, subscriber.privateKey, subscriber.auth)),
    );

    // First 3 are individual needs_you pushes
    expect(decryptions[0]!.class).toBe("needs_you");
    expect(decryptions[0]!.title).toBe("Issue 1");
    expect(decryptions[1]!.class).toBe("needs_you");
    expect(decryptions[1]!.title).toBe("Issue 2");
    expect(decryptions[2]!.class).toBe("needs_you");
    expect(decryptions[2]!.title).toBe("Issue 3");

    // 4th is the collapse notification with n=4
    expect(decryptions[3]!.class).toBe("collapse");
    expect(decryptions[3]!.title).toBe("Issue 4");
    expect(decryptions[3]!.body).toBe("Needs you: PAR-104 (+ 3 more)");
  });

  // Scenario c: quiet hours -> critical sends, others deferred
  it("quiet hours -> critical sends immediately, others deferred", async () => {
    // SAST 23:00 = UTC 21:00 (in quiet hours)
    clock.now = new Date("2026-10-20T21:00:00Z");
    vi.setSystemTime(clock.now);

    // Send normal push during quiet hours (should be deferred)
    vi.spyOn(pg.ctx.issues, "get").mockResolvedValueOnce({
      id: "issue-quiet-1",
      companyId: COMPANY_ID,
      identifier: "PAR-200",
      title: "Normal push",
      assigneeUserId: OWNER_ID,
    } as any);

    const eventNormal: PluginEvent = {
      eventId: "quiet-normal",
      eventType: "issue.updated",
      occurredAt: clock.now.toISOString(),
      actorId: "test-actor",
      actorType: "system",
      entityId: "issue-quiet-1",
      entityType: "issue",
      companyId: COMPANY_ID,
      payload: { identifier: "PAR-200", _previous: { assigneeUserId: null } },
    };

    await onIssueNeedsYou(env, eventNormal, {
      deliver: async (ctx, companyId, subs, payload) => {
        await sendPush(ctx, companyId, subs, payload, {
          class: payload.class,
          deps: { postPush: fakePost as any, now: env.now },
        });
      },
    });

    // Send critical push during quiet hours (should send anyway)
    const postsBefore = posts.length;
    const subs = await listSubscriptionsForUser(pg.ctx, COMPANY_ID, OWNER_ID);
    await sendPush(pg.ctx, COMPANY_ID, subs, {
      title: "Critical alert",
      body: "System down",
      url: "https://paperclip.partnersinbiz.online/cockpit",
      tag: "critical:health",
      class: "critical",
    }, {
      class: "critical",
      deps: { postPush: fakePost as any, now: env.now },
    });

    expect(posts.length).toBe(postsBefore + 1);

    // Decrypt and verify critical push was sent
    const criticalPost = posts[posts.length - 1]!;
    const criticalDecrypted = JSON.parse(
      decryptPayload(criticalPost.body, subscriber.privateKey, subscriber.auth),
    );
    expect(criticalDecrypted.title).toBe("Critical alert");
    expect(criticalDecrypted.body).toBe("System down");
    expect(criticalDecrypted.class).toBe("critical");

    // Verify logs: normal was deferred, critical was sent
    const logs = await listRecentPushLog(pg.ctx, COMPANY_ID, new Date(clock.now.getTime() - 24 * 60 * 60 * 1000));
    const deferredNormal = logs.filter((l) => l.status === "deferred" && l.class === "needs_you");
    const sentCritical = logs.filter((l) => l.status === "sent" && l.class === "critical");
    expect(deferredNormal.length).toBeGreaterThanOrEqual(1);
    expect(sentCritical.length).toBeGreaterThanOrEqual(1);

    // After quiet hours (SAST 06:00 = UTC 04:00), normal push should deliver
    clock.now = new Date("2026-10-21T04:00:00Z");
    vi.setSystemTime(clock.now);
    const postsBefore2 = posts.length;

    vi.spyOn(pg.ctx.issues, "get").mockResolvedValueOnce({
      id: "issue-after-quiet",
      companyId: COMPANY_ID,
      identifier: "PAR-201",
      title: "Morning issue",
      assigneeUserId: OWNER_ID,
    } as any);

    const eventAfter: PluginEvent = {
      eventId: "after-quiet",
      eventType: "issue.updated",
      occurredAt: clock.now.toISOString(),
      actorId: "test-actor",
      actorType: "system",
      entityId: "issue-after-quiet",
      entityType: "issue",
      companyId: COMPANY_ID,
      payload: { identifier: "PAR-201", _previous: { assigneeUserId: null } },
    };

    await onIssueNeedsYou(env, eventAfter, {
      deliver: async (ctx, companyId, subs, payload) => {
        await sendPush(ctx, companyId, subs, payload, {
          class: payload.class,
          deps: { postPush: fakePost as any, now: env.now },
        });
      },
    });

    expect(posts.length).toBeGreaterThan(postsBefore2);

    // Decrypt and verify after-quiet push was sent
    const afterQuietPost = posts[posts.length - 1]!;
    const afterQuietDecrypted = JSON.parse(
      decryptPayload(afterQuietPost.body, subscriber.privateKey, subscriber.auth),
    );
    expect(afterQuietDecrypted.title).toBe("Morning issue");
    expect(afterQuietDecrypted.class).toBe("needs_you");
  });

  // Scenario d: owner-push route -> critical push delivered with correct payload
  it("owner-push route call -> critical push sent to transport with correct payload", async () => {
    // Set up transport mock to use fakePost
    t.postPush.mockImplementation(fakePost);

    const input = {
      routeKey: "owner-push",
      companyId: COMPANY_ID,
      body: {
        companyId: COMPANY_ID,
        class: "critical",
        title: "Owner alert",
        body: "Immediate action required",
        url: "https://paperclip.partnersinbiz.online/cockpit",
      },
    };

    const result = await handleOwnerPush(env, input as any);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ sent: 1, failed: 0 });

    // Transport should have been called exactly once
    expect(t.postPush).toHaveBeenCalledTimes(1);
    const [endpoint, headers, body] = t.postPush.mock.calls[0]!;

    // Verify endpoint
    expect(endpoint).toBe("https://fcm.googleapis.com/fcm/send/device-owner");

    // Decrypt and verify payload
    const decrypted = JSON.parse(
      decryptPayload(body as Buffer, subscriber.privateKey, subscriber.auth),
    );
    expect(decrypted.title).toBe("Owner alert");
    expect(decrypted.body).toBe("Immediate action required");
    expect(decrypted.class).toBe("critical");
    expect(decrypted.tag).toBe("owner-push");
    expect(decrypted.url).toBe("https://paperclip.partnersinbiz.online/cockpit");
  });

  // Scenario e: transport returns 410 -> subscription removed; 403 -> needs_resubscribe
  it("transport 410 -> device subscription removed from company", async () => {
    const endpoint410 = "https://fcm.googleapis.com/fcm/send/device-410";

    // Seed a 410 device
    await upsertSubscription(pg.ctx, {
      companyId: COMPANY_ID,
      userId: OWNER_ID,
      endpoint: endpoint410,
      p256dh: subscriber.p256dh,
      auth: subscriber.auth,
      deviceLabel: "410 Device",
    });

    // Configure transport to return 410
    statusFor.set(endpoint410, 410);

    const subs = await listSubscriptionsForUser(pg.ctx, COMPANY_ID, OWNER_ID);
    const sub410 = subs.find((s) => s.endpoint === endpoint410)!;

    const payload: PushPayload = {
      title: "Test",
      body: "Test",
      url: "/test",
      tag: "TEST-1",
      class: "needs_you",
    };

    await sendPush(pg.ctx, COMPANY_ID, [sub410], payload, {
      class: "needs_you",
      deps: { postPush: fakePost as any, now: env.now },
    });

    const remaining = await listSubscriptionsForUser(pg.ctx, COMPANY_ID, OWNER_ID);
    expect(remaining.filter((s) => s.endpoint === endpoint410)).toHaveLength(0);
  });

  it("transport 403 -> device flagged needs_resubscribe", async () => {
    const endpoint403 = "https://fcm.googleapis.com/fcm/send/device-403";

    await upsertSubscription(pg.ctx, {
      companyId: COMPANY_ID,
      userId: OWNER_ID,
      endpoint: endpoint403,
      p256dh: subscriber.p256dh,
      auth: subscriber.auth,
      deviceLabel: "403 Device",
    });

    statusFor.set(endpoint403, 403);

    const subs = await listSubscriptionsForUser(pg.ctx, COMPANY_ID, OWNER_ID);
    const sub403 = subs.find((s) => s.endpoint === endpoint403)!;

    const payload: PushPayload = {
      title: "Test",
      body: "Test",
      url: "/test",
      tag: "TEST-2",
      class: "needs_you",
    };

    await sendPush(pg.ctx, COMPANY_ID, [sub403], payload, {
      class: "needs_you",
      deps: { postPush: fakePost as any, now: env.now },
    });

    const updated = await listSubscriptionsForUser(pg.ctx, COMPANY_ID, OWNER_ID);
    const device403 = updated.find((s) => s.endpoint === endpoint403);
    expect(device403).toBeTruthy();
    expect(device403!.state).toBe("needs_resubscribe");
  });
});
