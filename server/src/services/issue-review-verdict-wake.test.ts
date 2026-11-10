// PAR-8960 T1 tests 3 and 11: review-verdict wake guards. Route cases (1, 2, 5, 9)
// live in issue-comment-reopen-routes.test.ts; queue cases in heartbeat-review-verdict-wake.test.ts.
import { describe, expect, it } from "vitest";
import * as guards from "./issue-wake-guards.js";

const { shouldStartQueuedIssueRun, shouldWakeBlockedTicket } = guards;
const REASON = "issue_review_verdict";
const ACTOR_ID = "issue_review_verdict_relay";
const verdict = { wakeReason: REASON, requestedByActorType: "system", requestedByActorId: ACTOR_ID };

describe("isReviewVerdictWake (test 3)", () => {
  it("exports the fixed reason and actor id", () => {
    expect(guards.ISSUE_REVIEW_VERDICT_WAKE_REASON).toBe(REASON);
    expect(guards.REVIEW_VERDICT_WAKE_ACTOR_ID).toBe(ACTOR_ID);
  });

  it("is true only for the full triple", () => {
    expect(guards.isReviewVerdictWake(verdict)).toBe(true);
    for (const variant of [
      { ...verdict, requestedByActorType: "agent" },
      { ...verdict, requestedByActorId: null },
      { ...verdict, requestedByActorId: "6f1d3c1e-1b9f-4a3e-9d55-0c7d2f0e9a11" },
      { ...verdict, wakeReason: "issue_commented" },
    ]) {
      expect(guards.isReviewVerdictWake(variant)).toBe(false);
    }
  });

  it("admits a blocked ticket at the enqueue and claim gates only for the triple", () => {
    expect(shouldWakeBlockedTicket({ issueStatus: "blocked", ...verdict })).toEqual({
      wake: true,
      reason: "review_verdict",
    });
    const base = {
      issueStatus: "blocked",
      paused: false,
      assigneeAgentId: "agent-x",
      runAgentId: "agent-x",
      humanWake: false,
      blockerClearedWake: false,
    };
    expect(shouldStartQueuedIssueRun({ ...base, ...verdict })).toEqual({ start: true, reason: "ok" });
    for (const forged of [
      { ...verdict, requestedByActorType: "agent" },
      { ...verdict, requestedByActorId: null },
      { ...verdict, requestedByActorId: "plugin-uuid" },
      { ...verdict, wakeReason: "issue_commented" },
    ]) {
      expect(shouldWakeBlockedTicket({ issueStatus: "blocked", ...forged }).wake).toBe(false);
      expect(shouldStartQueuedIssueRun({ ...base, ...forged })).toEqual({ start: false, reason: "blocked" });
    }
  });
});

describe("isReviewVerdictComment (test 11)", () => {
  it.each(["PASS", "**PASS**: x", "FAIL - y", "CHANGES NEEDED", "DOGFOOD: PASS", "DOGFOOD:FAIL", "\n  PASS: ok\nmore"])(
    "matches %j",
    (body) => expect(guards.isReviewVerdictComment(body)).toBe(true),
  );
  it.each(["Passing to Vera", "pass", "Not a PASS yet", "PASSED", "", "Looking at it now"])(
    "does not match %j",
    (body) => expect(guards.isReviewVerdictComment(body)).toBe(false),
  );
});
