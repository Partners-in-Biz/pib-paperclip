import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const queuedRun = { id: "00000000-0000-4000-8000-000000000003", status: "queued" };

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent as the system actor and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => queuedRun);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      requestedByActorType: "system",
      requestedByActorId: "routable_blocked",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("records delivery for a deferred (admitted, not skipped) receipt", async () => {
    const markNotified = vi.fn(async () => undefined);
    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      wakeup: vi.fn(async () => ({ status: "deferred_issue_execution" })),
      markNotified,
    })).resolves.toBe(true);
    expect(markNotified).toHaveBeenCalledTimes(1);
  });

  // PAR-9390 AC 1: a skipped wake reached nobody, so blockedOwnerNotifiedAt stays null.
  it.each([
    ["a skipped receipt", { status: "skipped" }],
    ["no run and no receipt", null],
  ])("leaves the owner unnotified after %s", async (_name, result) => {
    const issue = blockedIssue();
    const markNotified = vi.fn(async (at: Date) => { issue.blockedOwnerNotifiedAt = at as never; });
    await expect(deliverAgentUnblockNotification({
      issue,
      wakeup: vi.fn(async () => result),
      markNotified,
    })).resolves.toBe(false);
    expect(markNotified).not.toHaveBeenCalled();
    expect(issue.blockedOwnerNotifiedAt).toBeNull();
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => queuedRun);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async (_agentId: string, _options: unknown) => queuedRun);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });
});
