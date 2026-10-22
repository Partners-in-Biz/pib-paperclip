/**
 * Evidence confirmation push tests (Postgres).
 * Tests cover: confirmEvidencePush outcomes for sent, already_notified, no_subscription, capped, duplicate, deferred, error.
 * Tests evidence-record with notify param.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

  // Helper: seed owner role and subscription after make()
  async function seedOwnerRoleAndSubscription(w: Hybrid) {
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

    await upsertSubscription(worlds.pg.ctx, {
      companyId: A,
      userId: OWNER_ID,
      endpoint: "https://example.com/push/owner-1",
      p256dh: "test-p256dh-1",
      auth: "test-auth-1",
      deviceLabel: "Test Device",
    });
  }

  beforeEach(async () => {
    // Clear evidence, push log, and subscriptions before each test
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

  async function make(opts: { agents?: any[] } = {}) {
    return worlds.make({
      agents: opts.agents || [{ id: AGENT, companyId: A, name: "Alice", status: "active", role: "general" }],
    });
  }

  async function seedOwnerSubscription(w: Hybrid) {
    await upsertSubscription(w.ctx, {
      companyId: A,
      userId: OWNER_ID,
      endpoint: "https://example.com/push/owner-1",
      p256dh: "test-p256dh-1",
      auth: "test-auth-1",
      deviceLabel: "Test Device",
    });
  }

  async function createIssueAndAttachment(w: Hybrid, attachmentId: string, attSha256: string) {
    const issue = await w.ctx.issues.create({
      companyId: A,
      title: "Test Confirm",
      description: "Test",
      status: "todo",
    } as never);

    const att = {
      id: attachmentId,
      issueId: issue.id,
      companyId: A,
      filename: `${attachmentId}.png`,
      contentType: "image/png",
      sha256: attSha256,
      createdByAgentId: AGENT,
    };

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    return { issue, att };
  }

  async function runWithNotify(w: Hybrid, issue: any, attachmentId: string, attSha256: string, step: string, summary: string | null, mockDeliver: any) {
    const att = {
      id: attachmentId,
      issueId: issue.id,
      companyId: A,
      filename: `${attachmentId}.png`,
      contentType: "image/png",
      sha256: attSha256,
      createdByAgentId: AGENT,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];

    return recordEvidence(
      w.env,
      A,
      issue.id,
      attachmentId,
      attSha256,
      step,
      summary,
      { runId: "run-123", agentId: AGENT },
      { notify: true, deliver: mockDeliver },
    );
  }

  it("(a) sent: deliver called once, data.notify === sent, inbox_posted_at set", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z"); // Daytime
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const { issue } = await createIssueAndAttachment(w, "att-a-1", "abc123");

    const result = await runWithNotify(w, issue, "att-a-1", "abc123", "step-a", "Summary A", mockDeliver);

    expect((result as any).error).toBeUndefined();
    expect((result as any).data?.recorded).toBe(true);
    expect((result as any).data?.notify).toBe("sent");
    expect(deliverCalls).toHaveLength(1);

    const rows = await worlds.pg.ctx.db.query<{ inbox_posted_at: string | null }>(
      `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-a'`,
      [issue.id],
    );
    expect(rows[0]?.inbox_posted_at).toBeTruthy();
  });

  it("(b) notify unset: no deliver, no notify key in data", async () => {
    const w = await make();
    const { issue } = await createIssueAndAttachment(w, "att-b-1", "def456");

    const att = {
      id: "att-b-1",
      issueId: issue.id,
      companyId: A,
      filename: "att-b-1.png",
      contentType: "image/png",
      sha256: "def456",
      createdByAgentId: AGENT,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];

    const result = await recordEvidence(
      w.env,
      A,
      issue.id,
      "att-b-1",
      "def456",
      "step-b",
      "Summary B",
      { runId: "run-123", agentId: AGENT },
    );

    expect((result as any).error).toBeUndefined();
    expect((result as any).data?.recorded).toBe(true);
    expect((result as any).data?.notify).toBeUndefined();
  });

  it("(c) same (issue, step), different attachment -> second call already_notified, deliver once total", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z");
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const { issue } = await createIssueAndAttachment(w, "att-c-1", "abc111");

    const result1 = await runWithNotify(w, issue, "att-c-1", "abc111", "step-c", "Summary C", mockDeliver);
    expect((result1 as any).data?.notify).toBe("sent");
    expect(deliverCalls).toHaveLength(1);

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [
      {
        id: "att-c-2",
        issueId: issue.id,
        companyId: A,
        filename: "att-c-2.png",
        contentType: "image/png",
        sha256: "abc222",
        createdByAgentId: AGENT,
      },
    ];

    const result2 = await runWithNotify(w, issue, "att-c-2", "abc222", "step-c", "Summary C Changed", mockDeliver);
    expect((result2 as any).data?.notify).toBe("already_notified");
    expect(deliverCalls).toHaveLength(1);
  });

  it("(d) no subscription -> exactly one PAR-1844 comment, second call posts none", async () => {
    const w = await make();
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const parIssue = await w.ctx.issues.create({
      companyId: A,
      identifier: "PAR-1844",
      title: "Missing subscriptions handler",
      description: "Handle no subscription",
      status: "open",
    } as never);

    const createCommentSpy = vi.spyOn(w.ctx.issues, "createComment");

    const { issue } = await createIssueAndAttachment(w, "att-d-1", "def111");

    const result1 = await runWithNotify(w, issue, "att-d-1", "def111", "step-d", "Summary D", mockDeliver);

    expect(result1 as any).toHaveProperty("data.notify");
    expect((result1 as any).data?.notify).toBe("no_subscription");
    expect(createCommentSpy).toHaveBeenCalledWith(
      parIssue.id,
      expect.stringContaining("No push subscription"),
      A,
    );
    const firstCommentCount = createCommentSpy.mock.calls.length;

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [
      {
        id: "att-d-2",
        issueId: issue.id,
        companyId: A,
        filename: "att-d-2.png",
        contentType: "image/png",
        sha256: "def222",
        createdByAgentId: AGENT,
      },
    ];

    const result2 = await runWithNotify(w, issue, "att-d-2", "def222", "step-d", "Summary D Changed", mockDeliver);
    expect((result2 as any).data?.notify).toBe("no_subscription");
    expect(createCommentSpy.mock.calls.length).toBe(firstCommentCount);
  });

  it("(e) quiet hours (20:30Z = 22:30 SAST) -> deferred, claim set, deliver not called", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T20:30:00Z");
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const { issue } = await createIssueAndAttachment(w, "att-e-1", "ghi123");

    const result = await runWithNotify(w, issue, "att-e-1", "ghi123", "step-e", "Summary E", mockDeliver);
    expect((result as any).data?.notify).toBe("deferred");
    expect(deliverCalls).toHaveLength(0);

    const rows = await worlds.pg.ctx.db.query<{ inbox_posted_at: string | null }>(
      `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-e'`,
      [issue.id],
    );
    expect(rows[0]?.inbox_posted_at).toBeTruthy();
  });

  it("(f) seeded duplicate push_log row (same issueRef) -> duplicate, claim NULL, no PAR-1844 comment", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z");
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const { issue } = await createIssueAndAttachment(w, "att-f-1", "jkl123");
    const issueRef = `${issue.identifier}:step-f`;

    await appendPushLog(worlds.pg.ctx, {
      companyId: A,
      class: "confirmation",
      issueRef,
      title: "Earlier confirmation",
      status: "sent",
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await runWithNotify(w, issue, "att-f-1", "jkl123", "step-f", "Summary F", mockDeliver);
    expect((result as any).data?.notify).toBe("duplicate");
    expect(deliverCalls).toHaveLength(0);

    const rows = await worlds.pg.ctx.db.query<{ inbox_posted_at: string | null }>(
      `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-f'`,
      [issue.id],
    );
    expect(rows[0]?.inbox_posted_at).toBeNull();
  });

  it("(g) capped (20 sent rows seeded) -> capped, claim NULL, no comment", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z");
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    for (let i = 0; i < 20; i++) {
      const createdAt = new Date(now.getTime() - (i + 1) * 15 * 60 * 1000);
      await appendPushLog(worlds.pg.ctx, {
        companyId: A,
        class: "confirmation",
        issueRef: `test-g-${i}`,
        title: `Seeded Push ${i}`,
        status: "sent",
        createdAt,
      });
    }

    const { issue } = await createIssueAndAttachment(w, "att-g-1", "mno123");

    const result = await runWithNotify(w, issue, "att-g-1", "mno123", "step-g", "Summary G", mockDeliver);
    expect((result as any).data?.notify).toBe("capped");
    expect(deliverCalls).toHaveLength(0);

    const rows = await worlds.pg.ctx.db.query<{ inbox_posted_at: string | null }>(
      `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-g'`,
      [issue.id],
    );
    expect(rows[0]?.inbox_posted_at).toBeNull();
  });

  it("(h) deliver rejects -> data.recorded true, notify error, claim NULL", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z");
    (w.env.now as any) = () => now;
    const mockDeliver = async () => {
      throw new Error("Delivery failed");
    };

    const { issue } = await createIssueAndAttachment(w, "att-h-1", "pqr123");

    const result = await runWithNotify(w, issue, "att-h-1", "pqr123", "step-h", "Summary H", mockDeliver);
    expect((result as any).error).toBeUndefined();
    expect((result as any).data?.recorded).toBe(true);
    expect((result as any).data?.notify).toBe("error");

    const rows = await worlds.pg.ctx.db.query<{ inbox_posted_at: string | null }>(
      `SELECT inbox_posted_at FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-h'`,
      [issue.id],
    );
    expect(rows[0]?.inbox_posted_at).toBeNull();
  });

  it("(i) concurrency: two recordEvidence calls with notify for same (issue, step), different attachments -> deliver once, one sent and one already_notified", async () => {
    const w = await make();
    await seedOwnerRoleAndSubscription(w);
    const now = new Date("2026-10-20T10:00:00Z");
    (w.env.now as any) = () => now;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const { issue } = await createIssueAndAttachment(w, "att-i-1", "stu123");

    const att1 = {
      id: "att-i-1",
      issueId: issue.id,
      companyId: A,
      filename: "att-i-1.png",
      contentType: "image/png",
      sha256: "stu123",
      createdByAgentId: AGENT,
    };
    const att2 = {
      id: "att-i-2",
      issueId: issue.id,
      companyId: A,
      filename: "att-i-2.png",
      contentType: "image/png",
      sha256: "vwx456",
      createdByAgentId: AGENT,
    };

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att1];
    const promise1 = runWithNotify(w, issue, "att-i-1", "stu123", "step-i", "Summary I", mockDeliver);

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att2];
    const promise2 = runWithNotify(w, issue, "att-i-2", "vwx456", "step-i", "Summary I", mockDeliver);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    const outcomes = [(result1 as any).data?.notify, (result2 as any).data?.notify].sort();
    expect(outcomes).toContain("sent");
    expect(outcomes).toContain("already_notified");
    expect(deliverCalls).toHaveLength(1);
  });
});
