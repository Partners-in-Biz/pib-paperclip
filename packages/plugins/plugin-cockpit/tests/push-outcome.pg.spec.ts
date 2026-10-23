/**
 * Push notification outcome tests (Postgres).
 * Tests cover: notifyOwner return outcomes for sent, no_subscription, deferred, duplicate, capped, and critical.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifyOwner } from "../src/push/notify.js";
import { appendPushLog, listRecentPushLog, upsertSubscription } from "../src/push/store.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OWNER_ID = "owner-user-1";

d("Push notification outcomes (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;

  beforeAll(async () => {
    pg = await startPg();

    // Seed roles with owner
    await saveRoles(pg.ctx, {
      companyId: A,
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
      companyId: A,
      userId: OWNER_ID,
      endpoint: "https://example.com/push/owner-1",
      p256dh: "test-p256dh-1",
      auth: "test-auth-1",
      deviceLabel: "Test Device",
    });
  }, 120_000);

  beforeEach(async () => {
    // Clear push log before each test
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_log WHERE company_id = $1`,
      [A],
    );
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it("a) daytime (now = 2026-10-20T10:00:00Z, SAST 12:00), class confirmation, one ok subscription seeded -> outcome sent, deliver called once", async () => {
    const now = new Date("2026-10-20T10:00:00Z"); // UTC 08:00 = SAST 12:00 (daytime)
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push",
        body: "Test body",
        issueRef: "test-a-1",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("sent");
    expect(deliverCalls).toHaveLength(1);
  });

  it("b) same but no subscription for ownerUserId -> outcome no_subscription, deliver not called", async () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push",
        body: "Test body",
        issueRef: "test-b-1",
        ownerUserId: "non-existent-user",
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("no_subscription");
    expect(deliverCalls).toHaveLength(0);
  });

  it("c) now = 2026-10-20T21:30:00Z (SAST 23:30), class confirmation -> outcome deferred, deliver not called, push_log has a row status deferred", async () => {
    const now = new Date("2026-10-20T21:30:00Z"); // UTC 21:30 = SAST 23:30 (quiet hours)
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Quiet",
        body: "Test body quiet",
        issueRef: "test-c-1",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("deferred");
    expect(deliverCalls).toHaveLength(0);

    const logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const deferredLogs = logs.filter((l) => l.status === "deferred" && l.issueRef === "test-c-1");
    expect(deferredLogs).toHaveLength(1);
  });

  it("d) a sent row with the same issueRef seeded via appendPushLog within 6h -> outcome duplicate", async () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    // Seed a sent row within 6h
    const issueRef = "test-d-1";
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "confirmation",
      issueRef,
      title: "Earlier Push",
      status: "sent",
      createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000), // 3h ago
    });

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Duplicate",
        body: "Test body dup",
        issueRef,
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("duplicate");
    expect(deliverCalls).toHaveLength(0);
  });

  it("e) 20 sent non-critical rows today seeded via appendPushLog (spread more than 10 minutes back so the window rule does not trigger, all in the same SAST day as now) and then a call with a fresh issueRef -> outcome capped", async () => {
    const now = new Date("2026-10-20T10:00:00Z"); // SAST 12:00
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    // Seed 20 sent rows, spread more than 10 minutes apart
    for (let i = 0; i < 20; i++) {
      const createdAt = new Date(now.getTime() - (i + 1) * 15 * 60 * 1000); // 15 minutes apart
      await appendPushLog(pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef: `test-e-seed-${i}`,
        title: `Seeded Push ${i}`,
        status: "sent",
        createdAt,
      });
    }

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Over Cap",
        body: "Test body capped",
        issueRef: "test-e-fresh",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("capped");
    expect(deliverCalls).toHaveLength(0);
  });

  it("f) class critical at quiet hours still -> outcome sent (existing behaviour unchanged)", async () => {
    const now = new Date("2026-10-20T21:30:00Z"); // UTC 21:30 = SAST 23:30 (quiet hours)
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "critical",
        title: "Critical Alert",
        body: "Critical issue",
        issueRef: "test-f-critical",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("sent");
    expect(deliverCalls).toHaveLength(1);
  });

  it("g) collapse decision with notify true and a seeded ok subscription -> outcome collapsed, deliver called once with class collapse", async () => {
    const now = new Date("2026-10-20T10:00:00Z"); // SAST 12:00
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    // Seed 3 sent rows within 10min window to trigger collapse
    for (let i = 0; i < 3; i++) {
      const createdAt = new Date(now.getTime() - (i + 1) * 2 * 60 * 1000); // 2, 4, 6 minutes ago
      await appendPushLog(pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef: `test-g-seed-${i}`,
        title: `Seeded Push ${i}`,
        status: "sent",
        createdAt,
      });
    }

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Collapse",
        body: "Test body collapse",
        issueRef: "test-g-fresh",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("collapsed");
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0].payload.class).toBe("collapse");
  });

  it("h) collapse with notify true and no subscription -> outcome no_subscription, deliver not called", async () => {
    const now = new Date("2026-10-20T10:00:00Z"); // SAST 12:00
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    // Seed 3 sent rows within 10min window to trigger collapse
    for (let i = 0; i < 3; i++) {
      const createdAt = new Date(now.getTime() - (i + 1) * 2 * 60 * 1000);
      await appendPushLog(pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef: `test-h-seed-${i}`,
        title: `Seeded Push ${i}`,
        status: "sent",
        createdAt,
      });
    }

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Collapse No Sub",
        body: "Test body collapse no sub",
        issueRef: "test-h-fresh",
        ownerUserId: "non-existent-user",
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("no_subscription");
    expect(deliverCalls).toHaveLength(0);
  });

  it("i) silent collapse (notify false) -> outcome capped, deliver not called", async () => {
    const now = new Date("2026-10-20T10:00:00Z"); // SAST 12:00
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    // Seed 3 sent rows and 1 collapse notification within 10min window
    // This makes notify=false because a collapse was already sent
    for (let i = 0; i < 3; i++) {
      const createdAt = new Date(now.getTime() - (i + 1) * 2 * 60 * 1000);
      await appendPushLog(pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef: `test-i-seed-${i}`,
        title: `Seeded Push ${i}`,
        status: "sent",
        createdAt,
      });
    }
    // Seed a collapse notification to make notify=false
    await appendPushLog(pg.ctx, {
      companyId: A,
      class: "collapse",
      issueRef: "test-i-collapse",
      title: "Collapse notification",
      status: "sent",
      createdAt: new Date(now.getTime() - 5 * 60 * 1000), // 5 minutes ago
    });

    const result = await notifyOwner(
      pg.ctx,
      {
        companyId: A,
        class: "confirmation",
        title: "Test Push Silent Collapse",
        body: "Test body silent collapse",
        issueRef: "test-i-fresh",
        ownerUserId: OWNER_ID,
        url: "https://example.com/test",
      },
      { deliver: mockDeliver, now: () => now },
    );

    expect(result.outcome).toBe("capped");
    expect(deliverCalls).toHaveLength(0);
  });
});
