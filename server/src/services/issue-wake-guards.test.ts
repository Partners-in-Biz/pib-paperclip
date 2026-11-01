import { describe, expect, it } from "vitest";
import {
  evaluateTicketHourlyRunCap,
  isTicketRunCapExempt,
  shouldStartQueuedIssueRun,
  shouldWakeBlockedTicket,
  TICKET_RUNS_PER_HOUR_CAP,
} from "./issue-wake-guards.js";

const assignee = "agent-assignee";

describe("shouldWakeBlockedTicket", () => {
  it("does not wake a blocked ticket for an agent comment", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_commented",
        requestedByActorType: "agent",
      }),
    ).toEqual({ wake: false, reason: "blocked_suppressed" });
  });

  it("wakes a blocked ticket for a human board comment", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_commented",
        requestedByActorType: "user",
      }),
    ).toEqual({ wake: true, reason: "human" });
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_comment_mentioned",
        requestedByActorType: "board",
      }).wake,
    ).toBe(true);
  });

  it("wakes a blocked ticket when the blocker is cleared", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_blockers_resolved",
        requestedByActorType: "system",
      }),
    ).toEqual({ wake: true, reason: "blocker_cleared" });
  });

  it("wakes a blocked ticket for system recovery and continuation", () => {
    for (const wakeReason of [
      "issue_recovery_action_restored",
      "issue_continuation_needed",
      "issue_children_completed",
    ]) {
      expect(
        shouldWakeBlockedTicket({
          issueStatus: "blocked",
          wakeReason,
          requestedByActorType: "system",
        }),
      ).toEqual({ wake: true, reason: "system_recovery" });
    }
  });

  it("does not treat an agent-forged recovery reason as a system wake", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_continuation_needed",
        requestedByActorType: "agent",
      }),
    ).toEqual({ wake: false, reason: "blocked_suppressed" });
  });

  it("does not treat an agent mention on a blocked ticket as a wake", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "blocked",
        wakeReason: "issue_comment_mentioned",
        requestedByActorType: "agent",
      }).wake,
    ).toBe(false);
  });

  it("leaves non-blocked tickets to the other gates", () => {
    expect(
      shouldWakeBlockedTicket({
        issueStatus: "in_progress",
        wakeReason: "issue_commented",
        requestedByActorType: "agent",
      }),
    ).toEqual({ wake: true, reason: "not_blocked" });
  });
});

describe("evaluateTicketHourlyRunCap", () => {
  it("skips and flags the 4th run in the rolling hour", () => {
    expect(
      evaluateTicketHourlyRunCap({
        runsStartedInWindow: TICKET_RUNS_PER_HOUR_CAP,
        alreadyFlaggedInWindow: false,
      }),
    ).toEqual({ allow: false, flag: true, reason: "capped" });
  });

  it("skips again without a second flag", () => {
    expect(
      evaluateTicketHourlyRunCap({
        runsStartedInWindow: 5,
        alreadyFlaggedInWindow: true,
      }),
    ).toEqual({ allow: false, flag: false, reason: "capped" });
  });

  it("still caps after N consecutive failed runs", () => {
    expect(
      evaluateTicketHourlyRunCap({
        runsStartedInWindow: TICKET_RUNS_PER_HOUR_CAP,
        alreadyFlaggedInWindow: false,
      }),
    ).toEqual({ allow: false, flag: true, reason: "capped" });
    expect(
      evaluateTicketHourlyRunCap({
        runsStartedInWindow: TICKET_RUNS_PER_HOUR_CAP + 2,
        alreadyFlaggedInWindow: true,
      }),
    ).toEqual({ allow: false, flag: false, reason: "capped" });
  });

  it("allows the 3rd run", () => {
    expect(
      evaluateTicketHourlyRunCap({
        runsStartedInWindow: 2,
        alreadyFlaggedInWindow: false,
      }).allow,
    ).toBe(true);
  });
});

describe("isTicketRunCapExempt", () => {
  it("exempts a retry handoff and a system continuation, not an agent-forged reason", () => {
    expect(isTicketRunCapExempt({ retryOfRunId: "run-1", wakeReason: "issue_assigned" })).toBe(true);
    expect(
      isTicketRunCapExempt({
        wakeReason: "issue_continuation_needed",
        requestedByActorType: "system",
      }),
    ).toBe(true);
    expect(
      isTicketRunCapExempt({
        wakeReason: "issue_disposition_repair",
        requestedByActorType: "system",
      }),
    ).toBe(true);
    expect(
      isTicketRunCapExempt({
        wakeReason: "issue_continuation_needed",
        requestedByActorType: "agent",
      }),
    ).toBe(false);
    expect(
      isTicketRunCapExempt({
        wakeReason: "issue_commented",
        requestedByActorType: "system",
      }),
    ).toBe(false);
  });
});

describe("shouldStartQueuedIssueRun", () => {
  const base = {
    issueStatus: "in_progress" as const,
    paused: false,
    assigneeAgentId: assignee,
    runAgentId: assignee,
    wakeReason: "issue_commented",
    humanWake: false,
    blockerClearedWake: false,
  };

  it("does not start a paused ticket", () => {
    expect(
      shouldStartQueuedIssueRun({ ...base, paused: true }),
    ).toEqual({ start: false, reason: "paused" });
  });

  it("does not start a ticket that is being reassigned", () => {
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        assigneeAgentId: "agent-next",
      }),
    ).toEqual({ start: false, reason: "reassigning" });
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        assigneeAgentId: null,
      }).reason,
    ).toBe("reassigning");
  });

  it("does not start a cancelled ticket", () => {
    expect(
      shouldStartQueuedIssueRun({ ...base, issueStatus: "cancelled" }).start,
    ).toBe(false);
  });

  it("does not start a blocked ticket for an agent wake", () => {
    expect(
      shouldStartQueuedIssueRun({ ...base, issueStatus: "blocked" }),
    ).toEqual({ start: false, reason: "blocked" });
  });

  it("starts a blocked ticket for a human wake or a cleared blocker", () => {
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        issueStatus: "blocked",
        humanWake: true,
      }).start,
    ).toBe(true);
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        issueStatus: "blocked",
        blockerClearedWake: true,
        wakeReason: "issue_blockers_resolved",
      }).start,
    ).toBe(true);
  });

  it("starts a blocked ticket for a system recovery reason", () => {
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        issueStatus: "blocked",
        wakeReason: "issue_continuation_needed",
        requestedByActorType: "system",
      }).start,
    ).toBe(true);
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        issueStatus: "blocked",
        wakeReason: "issue_continuation_needed",
        requestedByActorType: "agent",
      }).start,
    ).toBe(false);
  });

  it("still starts a mention wake for a non-assignee", () => {
    expect(
      shouldStartQueuedIssueRun({
        ...base,
        runAgentId: "agent-mentioned",
        wakeReason: "issue_comment_mentioned",
      }).start,
    ).toBe(true);
  });
});
