// PAR-9390 AC 7: the unblock action travels from the wake payload into the run
// context, and survives a coalesced merge.
import { describe, expect, it } from "vitest";
import {
  enrichWakeContextSnapshot,
  mergeCoalescedContextSnapshot,
  UNBLOCK_ACTION_CONTEXT_KEY,
} from "./run-preparation.js";

const ACTION = "Grant the deploy key to the CI runner";

function enrich(reason: string, payload: Record<string, unknown>, contextSnapshot: Record<string, unknown> = {}) {
  return enrichWakeContextSnapshot({
    contextSnapshot,
    reason,
    source: "automation",
    triggerDetail: "system",
    payload,
  }).contextSnapshot;
}

describe("unblock owner action in the run context", () => {
  it("copies the action of an unblock wake into the context", () => {
    const context = enrich("issue_unblock_requested", { issueId: "issue-x", action: ACTION });
    expect(context[UNBLOCK_ACTION_CONTEXT_KEY]).toBe(ACTION);
  });

  it("ignores an action on any other wake and drops a caller-supplied context value", () => {
    const context = enrich("issue_commented", { issueId: "issue-x", action: ACTION },
      { [UNBLOCK_ACTION_CONTEXT_KEY]: "forged" });
    expect(context[UNBLOCK_ACTION_CONTEXT_KEY]).toBeUndefined();
  });

  it("keeps the action when a later wake coalesces into the queued run", () => {
    const existing = enrich("issue_unblock_requested", { issueId: "issue-x", action: ACTION });
    const incoming = enrich("issue_commented", { issueId: "issue-x" }, { issueId: "issue-x" });
    const merged = mergeCoalescedContextSnapshot(existing, incoming);
    expect(merged[UNBLOCK_ACTION_CONTEXT_KEY]).toBe(ACTION);
  });
});
