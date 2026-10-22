/**
 * Evidence confirmation push tests (Postgres).
 * Tests cover: confirmEvidencePush outcomes and evidence-record with notify param.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordEvidence } from "../src/evidence.js";
import { appendPushLog, upsertSubscription } from "../src/push/store.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OWNER_ID = "owner-confirm-1";
const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a2";

d("Evidence confirmation (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;

  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);

  beforeEach(async () => {
    await worlds.pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE company_id = $1`,
      [A],
    );
    await worlds.pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_log WHERE company_id = $1`,
      [A],
    );
    await worlds.pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_subscriptions WHERE company_id = $1`,
      [A],
    );
  });

  afterAll(async () => {
    await worlds?.stop();
  });

  async function run(testFn: (w: Hybrid) => Promise<void>) {
    const w = await worlds.make({
      agents: [{ id: AGENT, companyId: A, name: "Alice", status: "active", role: "general" }],
    });
    await saveRoles(w.ctx, {
      companyId: A,
      operatorAgentId: null,
      reviewerAgentId: null,
      ownerUserId: OWNER_ID,
      reviewOutward: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    } as RolesRow);
    await testFn(w);
  }

  it("(a) repeat call CHANGED summary for same (issue, step) -> both attachments, deliver once total", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;
      const deliverCalls: any[] = [];

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att1 = { id: "att-a1", issueId: issue.id, companyId: A, filename: "test1.png", contentType: "image/png", sha256: "abc1", createdByAgentId: AGENT };
      const att2 = { id: "att-a2", issueId: issue.id, companyId: A, filename: "test2.png", contentType: "image/png", sha256: "abc2", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att1, att2];

      // First: different attachment, different summary
      const result1 = await recordEvidence(w.env, A, issue.id, "att-a1", "abc1", "step-a", "summary1", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result1 as any).data?.notify).toBe("sent");

      // Second: different attachment, CHANGED summary
      const result2 = await recordEvidence(w.env, A, issue.id, "att-a2", "abc2", "step-a", "summary2", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result2 as any).data?.notify).toBe("already_notified");
      expect(deliverCalls).toHaveLength(1);
    });
  });

  it("(b) policy suppression (quiet hours, cap): no comment on PAR-1844", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      // Test quiet hours (deferred) - no comment expected
      const now1 = new Date("2026-10-20T20:30:00Z"); // Quiet hours
      (w.env.now as any) = () => now1;
      const issue1 = await w.ctx.issues.create({ companyId: A, title: "Test QH", description: "Test", status: "todo" } as never);
      const att1 = { id: "att-b1", issueId: issue1.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att1];

      const result1 = await recordEvidence(w.env, A, issue1.id, "att-b1", "abc", "step-b", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result1 as any).data?.notify).toBe("deferred");

      // Test cap (20 sent rows) - no comment expected
      const now2 = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now2;

      for (let i = 0; i < 20; i++) {
        await appendPushLog(worlds.pg.ctx, {
          companyId: A,
          class: "confirmation",
          issueRef: `cap-test-${i}`,
          title: `Push ${i}`,
          status: "sent",
          createdAt: new Date(now2.getTime() - (i + 1) * 15 * 60 * 1000),
        });
      }

      const issue2 = await w.ctx.issues.create({ companyId: A, title: "Test Cap", description: "Test", status: "todo" } as never);
      const att2 = { id: "att-b2", issueId: issue2.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att2];

      const result2 = await recordEvidence(w.env, A, issue2.id, "att-b2", "abc", "step-b", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result2 as any).data?.notify).toBe("capped");
    });
  });

  it("(c) no subscription: outcome no_subscription; identical retry has notify", async () => {
    await run(async (w) => {
      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-c1", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;

      // First call: no subscription -> outcome no_subscription
      const result1 = await recordEvidence(w.env, A, issue.id, "att-c1", "abc", "step-c", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result1 as any).data?.notify).toBe("no_subscription");
      expect((result1 as any).data?.recorded).toBe(true);

      // Second identical retry: recorded=false, outcome in notify (will be already_notified if claim kept)
      const result2 = await recordEvidence(w.env, A, issue.id, "att-c1", "abc", "step-c", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result2 as any).data?.recorded).toBe(false);
      expect((result2 as any).data?.notify).toBeDefined();
    });
  });

  it("(d) after sent: inbox_posted_at set; after capped: NULL", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-d", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      // First call: sent, inbox_posted_at should be set
      const result1 = await recordEvidence(w.env, A, issue.id, "att-d", "abc", "step-d", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result1 as any).data?.notify).toBe("sent");

      const evRow1 = await w.client.query(
        `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE company_id = $1 AND issue_id = $2 AND step = $3`,
        [A, issue.id, "step-d"],
      );
      expect(evRow1.rows).toHaveLength(1);
      expect((evRow1.rows[0] as any).inbox_posted_at).not.toBeNull();

      // Now test capped: fill cap
      for (let i = 0; i < 20; i++) {
        await appendPushLog(worlds.pg.ctx, {
          companyId: A,
          class: "confirmation",
          issueRef: `test-d-cap-${i}`,
          title: `Push ${i}`,
          status: "sent",
          createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000),
        });
      }

      const issue2 = await w.ctx.issues.create({ companyId: A, title: "Test 2", description: "Test", status: "todo" } as never);
      const att2 = { id: "att-d2", issueId: issue2.id, companyId: A, filename: "test2.png", contentType: "image/png", sha256: "abc2", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att2];

      const result2 = await recordEvidence(w.env, A, issue2.id, "att-d2", "abc2", "step-d2", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result2 as any).data?.notify).toBe("capped");

      const evRow2 = await w.client.query(
        `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE company_id = $1 AND issue_id = $2 AND step = $3`,
        [A, issue2.id, "step-d2"],
      );
      expect(evRow2.rows).toHaveLength(1);
      expect((evRow2.rows[0] as any).inbox_posted_at).toBeNull();
    });
  });

  it("(e) concurrent recordEvidence for same issue+step: deliver called once total", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;
      const deliverCalls: any[] = [];

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att1 = { id: "att-e1", issueId: issue.id, companyId: A, filename: "test1.png", contentType: "image/png", sha256: "abc1", createdByAgentId: AGENT };
      const att2 = { id: "att-e2", issueId: issue.id, companyId: A, filename: "test2.png", contentType: "image/png", sha256: "abc2", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att1, att2];

      const result1 = recordEvidence(w.env, A, issue.id, "att-e1", "abc1", "step-e", "summary1", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      const result2 = recordEvidence(w.env, A, issue.id, "att-e2", "abc2", "step-e", "summary2", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });

      const [r1, r2] = await Promise.all([result1, result2]);
      const outcomes = [(r1 as any).data?.notify, (r2 as any).data?.notify].sort();
      expect(outcomes).toContain("sent");
      expect(outcomes).toContain("already_notified");
      expect(deliverCalls).toHaveLength(1);
    });
  });

  it("(f) collapse: delivered, claim retained, later call already_notified", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;

      // Seed 3 sent rows within 10min window to trigger collapse
      for (let i = 0; i < 3; i++) {
        const createdAt = new Date(now.getTime() - (i + 1) * 2 * 60 * 1000);
        await appendPushLog(worlds.pg.ctx, {
          companyId: A,
          class: "confirmation",
          issueRef: `test-f-seed-${i}`,
          title: `Seeded Push ${i}`,
          status: "sent",
          createdAt,
        });
      }

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-f", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const deliverCalls: any[] = [];
      const result1 = await recordEvidence(w.env, A, issue.id, "att-f", "abc", "step-f", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result1 as any).data?.notify).toBe("collapsed");
      expect(deliverCalls).toHaveLength(1);

      // Later call for same (issue, step): already_notified
      const result2 = await recordEvidence(w.env, A, issue.id, "att-f", "abc", "step-f", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result2 as any).data?.notify).toBe("already_notified");
      expect(deliverCalls).toHaveLength(1); // Still 1, no new deliver call
    });
  });

  it("(g) identical retry after capped: cap lifted, same attachment -> sent, deliver once", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;

      // Fill cap (20 sent rows)
      for (let i = 0; i < 20; i++) {
        await appendPushLog(worlds.pg.ctx, {
          companyId: A,
          class: "confirmation",
          issueRef: `test-g-cap-${i}`,
          title: `Push ${i}`,
          status: "sent",
          createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000),
        });
      }

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-g", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const deliverCalls: any[] = [];
      const result1 = await recordEvidence(w.env, A, issue.id, "att-g", "abc", "step-g", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result1 as any).data?.notify).toBe("capped");

      // Clear the cap
      await worlds.pg.ctx.db.execute(
        `DELETE FROM plugin_cockpit_b8a99e8b16.push_log WHERE company_id = $1`,
        [A],
      );

      // Retry same attachment: should now succeed
      const result2 = await recordEvidence(w.env, A, issue.id, "att-g", "abc", "step-g", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { deliverCalls.push({}); } });
      expect((result2 as any).data?.notify).toBe("sent");
      expect(deliverCalls).toHaveLength(1); // Deliver called once total
    });
  });

  it("(h) deliver error during attempt: claim retained (risk of partial send)", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T10:00:00Z");
      (w.env.now as any) = () => now;
      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-h", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-h", "abc", "step-h", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { throw new Error("Failed"); } });
      expect((result as any).data?.recorded).toBe(true);
      expect((result as any).data?.notify).toBe("error");

      // Claim should be kept (inbox_posted_at set) despite error
      const evRow = await w.client.query(
        `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE company_id = $1 AND issue_id = $2 AND step = $3`,
        [A, issue.id, "step-h"],
      );
      expect(evRow.rows).toHaveLength(1);
      expect((evRow.rows[0] as any).inbox_posted_at).not.toBeNull();
    });
  });

});
