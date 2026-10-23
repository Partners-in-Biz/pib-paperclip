import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

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
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
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
    const wakeup = vi.fn(async () => undefined);
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

  it("does not wake or mark notified when the acting agent names itself", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({ issue: blockedIssue(), actorAgentId: agentId, wakeup, markNotified }))
      .resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("still wakes when a different actor names the agent", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({ issue: blockedIssue(), actorAgentId: null, wakeup, markNotified }))
      .resolves.toBe(true);
    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue(),
      actorAgentId: "00000000-0000-4000-8000-000000000009",
      wakeup,
      markNotified,
    })).resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("restores the self-wake when PAPERCLIP_SKIP_SELF_OWNED_UNBLOCK_WAKE=0", async () => {
    vi.stubEnv("PAPERCLIP_SKIP_SELF_OWNED_UNBLOCK_WAKE", "0");
    try {
      const wakeup = vi.fn(async () => undefined);
      await expect(deliverAgentUnblockNotification({
        issue: blockedIssue(),
        actorAgentId: agentId,
        wakeup,
        markNotified: async () => undefined,
      })).resolves.toBe(true);
      expect(wakeup).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
