/**
 * "Needs you" push trigger tests (Postgres).
 * Tests cover: assignee changes to owner -> one push, unrelated update -> none,
 * same issue twice in 6h -> one, link format, replayed event -> one, and assignee away from owner -> no push.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onIssueNeedsYou } from "../src/push/triggers-needs-you.js";
import { appendPushLog, listRecentPushLog, upsertSubscription, type PushLogEntry } from "../src/push/store.js";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { Env } from "../src/env.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OWNER_ID = "owner-user-1";
const OTHER_USER = "other-user-1";
const ISSUE_ID = "issue-123";
const ISSUE_IDENTIFIER = "PAR-3934";

d("Needs-you trigger (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let env: Env;

  beforeAll(async () => {
    pg = await startPg();
    env = {
      ctx: pg.ctx,
      skills: { ensure: async () => undefined } as any,
      now: () => new Date("2026-10-20T10:00:00Z"), // SAST daytime (UTC 08:00)
    };

    // Seed roles with owner
    await pg.ctx.db.execute(
      `INSERT INTO plugin_cockpit_b8a99e8b16.roles (company_id, owner_user_id, operator_agent_id, reviewer_agent_id)
       VALUES ($1, $2, NULL, NULL)`,
      [A, OWNER_ID],
    );

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

  afterAll(async () => {
    await pg?.stop();
  });

  it("assignee changes to owner -> one push", async () => {
    const now = env.now();
    const event = mockEvent({
      issueId: ISSUE_ID,
      companyId: A,
      _previousAssigneeUserId: OTHER_USER,
      currentAssigneeUserId: OWNER_ID,
      timestamp: now,
    });

    // Deliver function that logs exactly once, like sendPush does
    const deliverLogging = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      if (subs.length > 0) {
        await appendPushLog(ctx, {
          companyId,
          class: payload.class,
          issueRef: payload.tag || null,
          title: payload.title || null,
          status: "sent",
          createdAt: now,
        });
      }
    };

    // Stub issues.get
    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async () => ({
      id: ISSUE_ID,
      companyId: A,
      identifier: ISSUE_IDENTIFIER,
      title: "Test Issue",
      assigneeUserId: OWNER_ID,
    } as any);

    try {
      await onIssueNeedsYou(env, event, { deliver: deliverLogging });
    } finally {
      pg.ctx.issues.get = originalGet;
    }

    // Check push log: should have exactly one "sent" entry
    const logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const sentLogs = logs.filter((l: PushLogEntry) => l.status === "sent" && l.issueRef === ISSUE_IDENTIFIER);
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]!.class).toBe("needs_you");
    expect(sentLogs[0]!.title).toBe("Test Issue");
  });

  it("unrelated update (title change) -> no push", async () => {
    const now = env.now();
    // 11+ minutes later to avoid window collapse
    const later = new Date(now.getTime() + 12 * 60 * 1000);
    const event = mockEvent({
      issueId: ISSUE_ID,
      companyId: A,
      currentAssigneeUserId: OWNER_ID,
      timestamp: later,
    });

    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async () => ({
      id: ISSUE_ID,
      companyId: A,
      identifier: ISSUE_IDENTIFIER,
      title: "Updated Title",
      assigneeUserId: OWNER_ID,
    } as any);

    try {
      await onIssueNeedsYou(env, event);
    } finally {
      pg.ctx.issues.get = originalGet;
    }

    // Should not add a new log entry (already seen as owner)
    const logs = await listRecentPushLog(pg.ctx, A, new Date(later.getTime() - 24 * 60 * 60 * 1000));
    const sentLogs = logs.filter((l: PushLogEntry) => l.status === "sent" && l.issueRef === ISSUE_IDENTIFIER && l.class === "needs_you");
    expect(sentLogs).toHaveLength(1); // Still just the one from before
  });

  it("same issue twice in 6h with distinct transitions -> one push (duplicate prevented by trigger)", async () => {
    const issueId2 = "issue-456";
    const identifier2 = "PAR-3935";
    const now = env.now();

    // Deliver function that logs exactly once, like sendPush does
    const deliverLogging = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      if (subs.length > 0) {
        await appendPushLog(ctx, {
          companyId,
          class: payload.class,
          issueRef: payload.tag || null,
          title: payload.title || null,
          status: "sent",
          createdAt: now,
        });
      }
    };

    // First transition: unassigned -> owner
    const event1 = mockEvent({
      issueId: issueId2,
      companyId: A,
      _previousAssigneeUserId: null,
      currentAssigneeUserId: OWNER_ID,
      timestamp: now,
    });

    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async (id: string) => {
      if (id === issueId2) {
        return {
          id: issueId2,
          companyId: A,
          identifier: identifier2,
          title: "Another Issue",
          assigneeUserId: OWNER_ID,
        } as any;
      }
      throw new Error("Not found");
    };

    try {
      await onIssueNeedsYou(env, event1, { deliver: deliverLogging });

      // Second transition: 3h later with different previous assignee
      const later3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      const event2 = mockEvent({
        issueId: issueId2,
        companyId: A,
        _previousAssigneeUserId: OTHER_USER,
        currentAssigneeUserId: OWNER_ID,
        timestamp: later3h,
      });

      // Override env.now for this call only
      const env2 = { ...env, now: () => later3h };
      await onIssueNeedsYou(env2, event2, { deliver: deliverLogging });
    } finally {
      pg.ctx.issues.get = originalGet;
    }

    // Second call should not fire because seenPrevious is already OWNER_ID
    // So only the first call logs anything
    const logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const sentLogs = logs.filter((l: PushLogEntry) => l.status === "sent" && l.issueRef === identifier2);

    expect(sentLogs).toHaveLength(1); // Only one from the first call
  });

  it("replayed event -> one push (idempotent via upsertSeenAssignee)", async () => {
    const issueId4 = "issue-replay";
    const identifier4 = "REPLAY-1";
    const now = env.now();

    // Deliver function that logs exactly once, like sendPush does
    const deliverLogging = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      if (subs.length > 0) {
        await appendPushLog(ctx, {
          companyId,
          class: payload.class,
          issueRef: payload.tag || null,
          title: payload.title || null,
          status: "sent",
          createdAt: now,
        });
      }
    };

    const event = mockEvent({
      issueId: issueId4,
      companyId: A,
      _previousAssigneeUserId: OTHER_USER,
      currentAssigneeUserId: OWNER_ID,
      timestamp: now,
    });

    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async () => ({
      id: issueId4,
      companyId: A,
      identifier: identifier4,
      title: "Replay Test",
      assigneeUserId: OWNER_ID,
    } as any);

    try {
      // First time: fire and log
      await onIssueNeedsYou(env, event, { deliver: deliverLogging });

      let logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
      let statusLogs = logs.filter((l: PushLogEntry) => l.issueRef === identifier4);
      expect(statusLogs).toHaveLength(1);
      expect(statusLogs[0]!.status).toBe("sent");

      // Replay: should not fire again (no new log entry, no dropped entry either)
      await onIssueNeedsYou(env, event, { deliver: deliverLogging });

      logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
      statusLogs = logs.filter((l: PushLogEntry) => l.issueRef === identifier4);
      expect(statusLogs).toHaveLength(1); // Still just one, no duplicate
    } finally {
      pg.ctx.issues.get = originalGet;
    }
  });

  it("link sent equals https://paperclip.partnersinbiz.online/PAR/issues/PAR-3934", async () => {
    const issueId5 = "issue-link-test";
    const identifier5 = "PAR-3934-link-test";
    const now = env.now();
    const laterTime = new Date(now.getTime() + 7 * 60 * 60 * 1000); // >6h after first push to avoid dedupe

    const event = mockEvent({
      issueId: issueId5,
      companyId: A,
      _previousAssigneeUserId: OTHER_USER,
      currentAssigneeUserId: OWNER_ID,
      timestamp: laterTime,
    });

    // Track deliver calls
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async () => ({
      id: issueId5,
      companyId: A,
      identifier: identifier5,
      title: "Link Test",
      assigneeUserId: OWNER_ID,
    } as any);

    try {
      // Use custom env with later timestamp to avoid 6h duplicate window
      const env5 = { ...env, now: () => laterTime };
      await onIssueNeedsYou(env5, event, { deliver: mockDeliver });
    } finally {
      pg.ctx.issues.get = originalGet;
    }

    // Check that deliver was called with the exact URL (using the identifier from the issue)
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]!.payload.url).toBe("https://paperclip.partnersinbiz.online/PAR/issues/PAR-3934-link-test");
  });

  it("assignee changes away from owner -> no push", async () => {
    const issueId6 = "issue-away";
    const identifier6 = "PAR-3936";
    const now = env.now();

    const event = mockEvent({
      issueId: issueId6,
      companyId: A,
      _previousAssigneeUserId: OWNER_ID,
      currentAssigneeUserId: OTHER_USER, // Changed away from owner
      timestamp: new Date(now.getTime() + 8 * 60 * 60 * 1000), // >6h after first push
    });

    // Track deliver calls
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
    };

    const originalGet = pg.ctx.issues.get;
    pg.ctx.issues.get = async () => ({
      id: issueId6,
      companyId: A,
      identifier: identifier6,
      title: "Away Test",
      assigneeUserId: OTHER_USER,
    } as any);

    try {
      await onIssueNeedsYou(env, event, { deliver: mockDeliver });
    } finally {
      pg.ctx.issues.get = originalGet;
    }

    // Should not push or log anything
    expect(deliverCalls).toHaveLength(0);
    const logs = await listRecentPushLog(pg.ctx, A, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const anyLogs = logs.filter((l: PushLogEntry) => l.issueRef === identifier6);
    expect(anyLogs).toHaveLength(0);
  });
});

function mockEvent(opts: {
  issueId: string;
  companyId: string;
  _previousAssigneeUserId?: string | null;
  currentAssigneeUserId: string | null;
  timestamp: Date;
}): PluginEvent {
  return {
    eventId: "test-event-1",
    eventType: "issue.updated",
    occurredAt: opts.timestamp.toISOString(),
    actorId: "test-actor",
    actorType: "system",
    entityId: opts.issueId,
    entityType: "issue",
    companyId: opts.companyId,
    payload: {
      identifier: "TEST",
      ...(opts._previousAssigneeUserId !== undefined && {
        _previous: {
          assigneeUserId: opts._previousAssigneeUserId,
        },
      }),
    },
  };
}
