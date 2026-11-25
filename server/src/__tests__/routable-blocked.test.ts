import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  isRunBackedWakeResult,
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

  // PAR-10086 AC 3: the owner counts as notified only when a run exists for the wake.
  it.each([
    ["a returned run", true, queuedRun],
    ["a receipt with a runId", true, { status: "coalesced", runId: queuedRun.id }],
    ["a deferred receipt with no runId", false, { status: "deferred_issue_execution", runId: null }],
    ["a skipped receipt", false, { status: "skipped", runId: null }],
    ["no run and no receipt", false, null],
  ] as const)("treats %s as notified=%s", async (_name, notified, result) => {
    expect(isRunBackedWakeResult(result)).toBe(notified);
    const issue = blockedIssue();
    const markNotified = vi.fn(async (at: Date) => { issue.blockedOwnerNotifiedAt = at as never; });
    await expect(deliverAgentUnblockNotification({
      issue,
      wakeup: vi.fn(async () => result),
      markNotified,
    })).resolves.toBe(notified);
    expect(markNotified).toHaveBeenCalledTimes(notified ? 1 : 0);
    expect(issue.blockedOwnerNotifiedAt === null).toBe(!notified);
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
