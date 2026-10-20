/**
 * Overnight push digest job (Postgres): idempotent send of "N items waited overnight"
 * when deferred rows exist since the 22:00 SAST window, marking them collapsed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPushDigestForCompany, runPushDigest } from "../src/push/digest.js";
import { appendPushLog, listDeferredSince, upsertSubscription, type PushSubscription } from "../src/push/store.js";
import { getOvernightWindow } from "../src/push/policy.js";
import { saveRoles } from "../src/db.js";
import * as sendModule from "../src/push/send.js";
import type { SendResult } from "../src/push/send.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = OTHER_COMPANY;

// Test time: 2026-10-20T04:30:00Z (06:30 SAST, after the 22:00 window start from previous day)
const NOW = new Date("2026-10-20T04:30:00Z");

d("Push digest job (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("no deferred rows -> no push", async () => {
    // No deferred rows for company A
    const result = await runPushDigestForCompany(pg.ctx, A, { deps: { now: () => NOW } });
    expect(result).toBe(false);
  });

  it("3 deferred rows -> exactly one push with '3 items waited overnight', rows become collapsed", async () => {
    // Add a subscription for company A
    await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: "user-digest-1",
      endpoint: "https://fcm.googleapis.com/fcm/send/device-digest-1",
      p256dh: "test-p256dh",
      auth: "test-auth",
      deviceLabel: "Test Phone",
    });

    // Add 3 deferred log entries within the window
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "needs_you",
      status: "deferred",
      title: "Item 1",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    });
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "needs_you",
      status: "deferred",
      title: "Item 2",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    });
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "needs_you",
      status: "deferred",
      title: "Item 3",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    });

    let capturedPayload: { title: string; body: string; url: string; tag: string } | undefined;

    // Mock sendPush to verify behavior
    const mockSendPush = vi.spyOn(sendModule, "sendPush").mockImplementation(async (ctx, companyId, subs: PushSubscription[], payload, opts) => {
      capturedPayload = payload;
      // Return success with devices
      return {
        disabled: false,
        capped: false,
        devices: subs.map((s) => ({
          endpoint: s.endpoint,
          label: s.deviceLabel,
          outcome: "sent" as const,
        })),
      } as SendResult;
    });

    try {
      // Run the digest job (sendPush is mocked)
      const sent = await runPushDigestForCompany(pg.ctx, A, {
        deps: {
          now: () => NOW,
        },
      });

      expect(sent).toBe(true);
      expect(mockSendPush).toHaveBeenCalledTimes(1);
      expect(capturedPayload?.title).toBe("3 items waited overnight");
      expect(capturedPayload?.body).toBe("Items waiting for you to review");
      expect(capturedPayload?.url).toBe("/cockpit");
      expect(capturedPayload?.tag).toBe("digest");

      // Verify the deferred rows are now collapsed
      const deferredAfter = await listDeferredSince(pg.ctx, A, getOvernightWindow(NOW));
      expect(deferredAfter).toHaveLength(0);
    } finally {
      mockSendPush.mockRestore();
    }
  });

  it("run twice -> one push total (idempotent)", async () => {
    // Add a subscription for company B
    await upsertSubscription(pg.ctx, {
      companyId: B,
      userId: "user-digest-b",
      endpoint: "https://fcm.googleapis.com/fcm/send/device-digest-b",
      p256dh: "test-p256dh-b",
      auth: "test-auth-b",
      deviceLabel: "Test Phone B",
    });

    // Add 2 new deferred rows within the window for company B
    await appendPushLog(pg.ctx, {
      companyId: B,
      class: "needs_you",
      status: "deferred",
      title: "Item A",
    });
    await appendPushLog(pg.ctx, {
      companyId: B,
      class: "needs_you",
      status: "deferred",
      title: "Item B",
    });

    const mockSendPush = vi.spyOn(sendModule, "sendPush").mockResolvedValue({
      disabled: false,
      capped: false,
      devices: [{ endpoint: "https://example.com", label: null, outcome: "sent" as const }],
    } as SendResult);

    try {
      // First run
      const sent1 = await runPushDigestForCompany(pg.ctx, B, {
        deps: {
          now: () => NOW,
        },
      });
      expect(sent1).toBe(true);
      expect(mockSendPush).toHaveBeenCalledTimes(1);

      // Second run (no deferred rows left)
      const sent2 = await runPushDigestForCompany(pg.ctx, B, {
        deps: {
          now: () => NOW,
        },
      });
      expect(sent2).toBe(false);
      expect(mockSendPush).toHaveBeenCalledTimes(1); // Still 1, not 2
    } finally {
      mockSendPush.mockRestore();
    }
  });

  it("rows before 22:00 window not counted", async () => {
    // Create a deferred row BEFORE the 22:00 SAST window
    const windowStart = getOvernightWindow(NOW);
    const beforeWindow = new Date(windowStart.getTime() - 1 * 60 * 1000); // 1 minute before window

    // Insert a deferred row with explicit created_at before the window
    await pg.ctx.db.execute(
      `INSERT INTO plugin_cockpit_b8a99e8b16.push_log (id, company_id, class, status, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["digest-test-old", A, "needs_you", "deferred", beforeWindow.toISOString()],
    );

    // The digest should not count this row
    const deferred = await listDeferredSince(pg.ctx, A, windowStart);
    expect(deferred.some((r) => r.id === "digest-test-old")).toBe(false);

    // And running the digest should not send
    const sent = await runPushDigestForCompany(pg.ctx, A, {
      deps: { now: () => NOW },
    });
    expect(sent).toBe(false);
  });
});
