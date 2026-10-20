/**
 * Push notification store (Postgres): subscriptions, rate limiting, and VAPID keys.
 * Tests cover idempotency, scoping, rate limiting, and spike key import.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendPushLog, countPushLog, createKeyIfAbsent, deleteSubscription, getKey, getSeenAssignee, importSpikeKey, listSubscriptionsForUser, markSubscriptionOk, setSubscriptionState, takeRateSlot, upsertSeenAssignee, upsertSubscription } from "../src/push/store.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = OTHER_COMPANY;

d("Push store (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("upsert subscription: idempotent on endpoint (calling twice gives 1 row, updated p256dh)", async () => {
    const first = await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user1",
      endpoint: "https://example.com/push/1",
      p256dh: "test-p256dh-1",
      auth: "test-auth-1",
      deviceLabel: "iPhone",
    });
    expect(first.id).toBeDefined();
    expect(first.state).toBe("ok");

    const second = await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user1",
      endpoint: "https://example.com/push/1",
      p256dh: "test-p256dh-2",
      auth: "test-auth-2",
      deviceLabel: "iPhone Updated",
    });

    // Same endpoint, so same ID if we check the DB
    const list = await listSubscriptionsForUser(pg.ctx, A, "user1");
    expect(list).toHaveLength(1);
    expect(list[0]!.p256dh).toBe("test-p256dh-2");
    expect(list[0]!.auth).toBe("test-auth-2");
    expect(list[0]!.deviceLabel).toBe("iPhone Updated");
  });

  it("rebind: same endpoint upserted by another company/user moves the row", async () => {
    const endpoint = "https://example.com/push/rebind";
    const sub1 = await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user-rebind-1",
      endpoint,
      p256dh: "p256dh-1",
      auth: "auth-1",
    });
    expect(sub1.companyId).toBe(A);
    expect(sub1.userId).toBe("user-rebind-1");

    // Same endpoint, different user/company
    const sub2 = await upsertSubscription(pg.ctx, {
      companyId: B,
      userId: "user-rebind-b",
      endpoint,
      p256dh: "p256dh-2",
      auth: "auth-2",
    });

    // Now user-rebind-1 should have 0 subscriptions, user-rebind-b in company B should have 1
    const list1 = await listSubscriptionsForUser(pg.ctx, A, "user-rebind-1");
    expect(list1).toHaveLength(0);

    const listB = await listSubscriptionsForUser(pg.ctx, B, "user-rebind-b");
    expect(listB).toHaveLength(1);
    expect(listB[0]!.endpoint).toBe(endpoint);
    expect(listB[0]!.companyId).toBe(B);
    expect(listB[0]!.userId).toBe("user-rebind-b");
  });

  it("deleteSubscription scoped by company AND user", async () => {
    const endpoint = "https://example.com/push/delete-test";
    await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user-delete-1",
      endpoint,
      p256dh: "p256dh",
      auth: "auth",
    });

    // Wrong user (same company)
    const wrongUser = await deleteSubscription(pg.ctx, A, "user-delete-2", endpoint);
    expect(wrongUser).toBe(false);

    // Row should still be there
    const list = await listSubscriptionsForUser(pg.ctx, A, "user-delete-1");
    expect(list).toHaveLength(1);

    // Correct user and company
    const success = await deleteSubscription(pg.ctx, A, "user-delete-1", endpoint);
    expect(success).toBe(true);

    const listAfter = await listSubscriptionsForUser(pg.ctx, A, "user-delete-1");
    expect(listAfter).toHaveLength(0);
  });

  it("setSubscriptionState validates and persists", async () => {
    const endpoint = "https://example.com/push/state-test";
    await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user-state-1",
      endpoint,
      p256dh: "p256dh",
      auth: "auth",
    });

    await setSubscriptionState(pg.ctx, endpoint, "muted", "User muted notifications");
    let list = await listSubscriptionsForUser(pg.ctx, A, "user-state-1");
    expect(list[0]!.state).toBe("muted");
    expect(list[0]!.lastError).toBe("User muted notifications");

    await setSubscriptionState(pg.ctx, endpoint, "needs_resubscribe");
    list = await listSubscriptionsForUser(pg.ctx, A, "user-state-1");
    expect(list[0]!.state).toBe("needs_resubscribe");
    expect(list[0]!.lastError).toBeNull();

    // Invalid state should throw
    await expect(setSubscriptionState(pg.ctx, endpoint, "invalid" as any)).rejects.toThrow("Invalid state");
  });

  it("appendPushLog + countPushLog by status and since", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);

    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "issue_change",
      issueRef: "PAR-1",
      title: "Issue updated",
      status: "sent",
    });
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "issue_change",
      issueRef: "PAR-2",
      title: "Issue updated",
      status: "sent",
    });
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "issue_change",
      issueRef: "PAR-3",
      title: "Issue updated",
      status: "dropped",
    });

    const sentCount = await countPushLog(pg.ctx, A, "sent", oneHourAgo);
    expect(sentCount).toBe(2);

    const droppedCount = await countPushLog(pg.ctx, A, "dropped", oneHourAgo);
    expect(droppedCount).toBe(1);

    // Different company should not count
    const countB = await countPushLog(pg.ctx, B, "sent", oneHourAgo);
    expect(countB).toBe(0);
  });

  it("10 parallel takeRateSlot with cap 5 => exactly 5 true; different window_start gets a fresh budget", async () => {
    const window = new Date("2026-10-20T12:00:00.000Z");
    const slots: Promise<boolean>[] = [];
    for (let i = 0; i < 10; i++) {
      slots.push(takeRateSlot(pg.ctx, "test-key", window, 5));
    }
    const results = await Promise.all(slots);
    const trueCount = results.filter((r) => r).length;
    expect(trueCount).toBe(5);

    // Different window should get its own budget
    const nextWindow = new Date("2026-10-20T13:00:00.000Z");
    const nextSlots = [];
    for (let i = 0; i < 3; i++) {
      nextSlots.push(takeRateSlot(pg.ctx, "test-key", nextWindow, 5));
    }
    const nextResults = await Promise.all(nextSlots);
    expect(nextResults.filter((r) => r)).toHaveLength(3);
  });

  it("createKeyIfAbsent keeps the first key on second call", async () => {
    const pubKey1 = "test-public-1";
    const privKey1 = "test-private-1";
    const pubKey2 = "test-public-2";
    const privKey2 = "test-private-2";

    const first = await createKeyIfAbsent(pg.ctx, { publicKey: pubKey1, privateKey: privKey1 });
    expect(first.publicKey).toBe(pubKey1);
    expect(first.privateKey).toBe(privKey1);
    expect(first.created).toBe(true);

    // Second call with different keys should keep the first
    const second = await createKeyIfAbsent(pg.ctx, { publicKey: pubKey2, privateKey: privKey2 });
    expect(second.publicKey).toBe(pubKey1);
    expect(second.privateKey).toBe(privKey1);
    expect(second.created).toBe(false);

    // Third call with the SAME key as the first should report created: false
    const third = await createKeyIfAbsent(pg.ctx, { publicKey: pubKey1, privateKey: privKey1 });
    expect(third.publicKey).toBe(pubKey1);
    expect(third.privateKey).toBe(privKey1);
    expect(third.created).toBe(false);
  });

  it("importSpikeKey: with spike key put in ctx.state imports it, second import does not overwrite, returns imported:false when no spike key", async () => {
    // Clean up any existing key
    await pg.client.query("DELETE FROM plugin_cockpit_b8a99e8b16.push_keys WHERE id = 'vapid'");

    // Test 1: No spike key in state
    let result = await importSpikeKey(pg.ctx);
    expect(result.imported).toBe(false);

    // Test 2: Add spike key to state and import
    const spikePublic = "spike-public-key";
    const spikePrivate = "spike-private-key";
    await pg.ctx.state.set(
      {
        scopeKind: "instance",
        namespace: "pib-push-spike",
        stateKey: "vapid-key",
      },
      { publicKey: spikePublic, privateKey: spikePrivate },
    );

    result = await importSpikeKey(pg.ctx);
    expect(result.imported).toBe(true);

    // Verify it was stored
    const stored = await getKey(pg.ctx);
    expect(stored?.publicKey).toBe(spikePublic);
    expect(stored?.privateKey).toBe(spikePrivate);

    // Test 3: Second import with different spike key should not overwrite
    const newSpikePublic = "new-spike-public";
    const newSpikePrivate = "new-spike-private";
    await pg.ctx.state.set(
      {
        scopeKind: "instance",
        namespace: "pib-push-spike",
        stateKey: "vapid-key",
      },
      { publicKey: newSpikePublic, privateKey: newSpikePrivate },
    );

    result = await importSpikeKey(pg.ctx);
    expect(result.imported).toBe(false);

    // Original key should still be there
    const stillStored = await getKey(pg.ctx);
    expect(stillStored?.publicKey).toBe(spikePublic);
    expect(stillStored?.privateKey).toBe(spikePrivate);
  });

  it("upsertSeenAssignee returns previous assignee", async () => {
    const companyId = A;
    const issueId = "issue-123";

    // First time: no previous assignee
    let prev = await upsertSeenAssignee(pg.ctx, companyId, issueId, "user1");
    expect(prev).toBeNull();

    // Second time: returns previous assignee
    prev = await upsertSeenAssignee(pg.ctx, companyId, issueId, "user2");
    expect(prev).toBe("user1");

    // Third time: different company/issue is separate
    prev = await upsertSeenAssignee(pg.ctx, B, issueId, "user-b");
    expect(prev).toBeNull();

    // Check current values
    let current = await getSeenAssignee(pg.ctx, companyId, issueId);
    expect(current).toBe("user2");

    current = await getSeenAssignee(pg.ctx, B, issueId);
    expect(current).toBe("user-b");
  });
});
