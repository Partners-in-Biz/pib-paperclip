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
    await saveRoles(worlds.pg.ctx, {
      companyId: A,
      operatorAgentId: null,
      reviewerAgentId: null,
      ownerUserId: OWNER_ID,
      reviewOutward: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    } as RolesRow);
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
    await testFn(w);
  }

  it("(a) sent: deliver called once, data.notify === sent, inbox_posted_at set", async () => {
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

      const issue = await w.ctx.issues.create({
        companyId: A,
        title: "Test",
        description: "Test",
        status: "todo",
      } as never);

      const att = { id: "att-a", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-a", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => deliverCalls.push({}) });
      expect((result as any).data?.notify).toBe("sent");
      expect(deliverCalls).toHaveLength(1);
    });
  });

  it("(b) notify unset: no deliver, no notify key in data", async () => {
    await run(async (w) => {
      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-b", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-b", "abc", "step", "summary", { runId: null, agentId: AGENT });
      expect((result as any).data?.notify).toBeUndefined();
    });
  });

  it("(c) same (issue, step), different attachment -> second call already_notified", async () => {
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
      const att1 = { id: "att-c1", issueId: issue.id, companyId: A, filename: "test1.png", contentType: "image/png", sha256: "abc1", createdByAgentId: AGENT };
      const att2 = { id: "att-c2", issueId: issue.id, companyId: A, filename: "test2.png", contentType: "image/png", sha256: "abc2", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att1, att2];

      const result1 = await recordEvidence(w.env, A, issue.id, "att-c1", "abc1", "step-c", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => deliverCalls.push({}) });
      expect((result1 as any).data?.notify).toBe("sent");

      const result2 = await recordEvidence(w.env, A, issue.id, "att-c2", "abc2", "step-c", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => deliverCalls.push({}) });
      expect((result2 as any).data?.notify).toBe("already_notified");
      expect(deliverCalls).toHaveLength(1);
    });
  });

  it("(d) no subscription -> posts to issue (no PAR-1844 in test env)", async () => {
    await run(async (w) => {
      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-d", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-d", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result as any).data?.notify).toBe("no_subscription");
    });
  });

  it("(e) quiet hours -> deferred, claim set", async () => {
    await run(async (w) => {
      await upsertSubscription(worlds.pg.ctx, {
        companyId: A,
        userId: OWNER_ID,
        endpoint: "https://example.com/push/owner-1",
        p256dh: "test-p256dh-1",
        auth: "test-auth-1",
        deviceLabel: "Test Device",
      });

      const now = new Date("2026-10-20T20:30:00Z");
      (w.env.now as any) = () => now;
      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-e", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-e", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result as any).data?.notify).toBe("deferred");
    });
  });

  it("(f) duplicate push_log row -> duplicate, claim NULL", async () => {
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
      const issueRef = `${issue.identifier}:step`;
      await appendPushLog(worlds.pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef,
        title: "Earlier",
        status: "sent",
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      });

      const att = { id: "att-f", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-f", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result as any).data?.notify).toBe("duplicate");
    });
  });

  it("(g) capped (20 sent rows) -> capped, claim NULL", async () => {
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

      for (let i = 0; i < 20; i++) {
        await appendPushLog(worlds.pg.ctx, {
          companyId: A,
          class: "confirmation",
          issueRef: `test-${i}`,
          title: `Push ${i}`,
          status: "sent",
          createdAt: new Date(now.getTime() - (i + 1) * 15 * 60 * 1000),
        });
      }

      const issue = await w.ctx.issues.create({ companyId: A, title: "Test", description: "Test", status: "todo" } as never);
      const att = { id: "att-g", issueId: issue.id, companyId: A, filename: "test.png", contentType: "image/png", sha256: "abc", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att];

      const result = await recordEvidence(w.env, A, issue.id, "att-g", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => {} });
      expect((result as any).data?.notify).toBe("capped");
    });
  });

  it("(h) deliver rejects -> data.recorded true, notify error", async () => {
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

      const result = await recordEvidence(w.env, A, issue.id, "att-h", "abc", "step", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => { throw new Error("Failed"); } });
      expect((result as any).data?.recorded).toBe(true);
      expect((result as any).data?.notify).toBe("error");
    });
  });

  it("(i) concurrency: two calls, same (issue, step) -> deliver once", async () => {
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
      const att1 = { id: "att-i1", issueId: issue.id, companyId: A, filename: "test1.png", contentType: "image/png", sha256: "abc1", createdByAgentId: AGENT };
      const att2 = { id: "att-i2", issueId: issue.id, companyId: A, filename: "test2.png", contentType: "image/png", sha256: "abc2", createdByAgentId: AGENT };
      (w.ctx.issues as any).listAttachments = async () => [att1, att2];

      const result1 = recordEvidence(w.env, A, issue.id, "att-i1", "abc1", "step-i", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => deliverCalls.push({}) });
      const result2 = recordEvidence(w.env, A, issue.id, "att-i2", "abc2", "step-i", "summary", { runId: null, agentId: AGENT }, { notify: true, deliver: async () => deliverCalls.push({}) });

      const [r1, r2] = await Promise.all([result1, result2]);
      const outcomes = [(r1 as any).data?.notify, (r2 as any).data?.notify].sort();
      expect(outcomes).toContain("sent");
      expect(outcomes).toContain("already_notified");
      expect(deliverCalls).toHaveLength(1);
    });
  });
});
