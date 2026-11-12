/**
 * Where a campaign stands in plain words, and what needs a person: one function
 * feeds the list, the "Needs attention" strip and the campaign screen.
 */
import { describe, expect, it } from "vitest";
import { campaignState, failedByCampaign, placeholderText, type CampaignFacts } from "../src/attention.js";

const NOW = new Date("2026-11-12T12:00:00Z");

function facts(over: Partial<CampaignFacts> = {}): CampaignFacts {
  return {
    status: "draft", stepCount: 2, approvalIssueId: null, approvalStatus: null, approvalWithAgent: false, launchError: null,
    stats: { enrolled: 0, running: 0, done: 0 }, sent: 0, tasks: null, failedSends: 0, placeholders: [], reviseOpen: false, ...over,
  };
}

describe("drafts", () => {
  it("a draft without emails says so and asks nothing of a person", () => {
    expect(campaignState(facts({ stepCount: 0 }), NOW)).toMatchObject({ key: "no-emails", label: "Draft", detail: "No emails written yet.", attention: null });
  });

  it("a draft that was never sent for approval is a plain draft", () => {
    expect(campaignState(facts(), NOW)).toMatchObject({ key: "draft", attention: null });
  });

  it("a draft a person sent back shows as sent back while its revise task is open", () => {
    expect(campaignState(facts({ reviseOpen: true }), NOW)).toMatchObject({ key: "sent-back", label: "Sent back", attention: null });
  });

  it("a new approval request wins over an old revise task", () => {
    expect(campaignState(facts({ reviseOpen: true, approvalIssueId: "i-1", approvalStatus: "todo" }), NOW).key).toBe("waiting-approval");
  });

  it("an approval still with the Reviewer does not ask for the person yet", () => {
    expect(campaignState(facts({ approvalIssueId: "i-1", approvalStatus: "in_progress", approvalWithAgent: true }), NOW)).toMatchObject({ key: "with-reviewer", attention: null });
  });

  it("an approval with a person needs attention", () => {
    const state = campaignState(facts({ approvalIssueId: "i-1", approvalStatus: "todo" }), NOW);
    expect(state).toMatchObject({ key: "waiting-approval", label: "Needs your approval", tone: "warn" });
    expect(state.attention).toBe("Waiting for your approval");
  });

  it("an approval whose task could not be read is still shown as waiting, never as approved", () => {
    expect(campaignState(facts({ approvalIssueId: "i-1", approvalStatus: null }), NOW).key).toBe("waiting-approval");
  });

  it("approved but could not launch is bad, with the reason, and wins over the done approval", () => {
    const state = campaignState(facts({ approvalIssueId: "i-1", approvalStatus: "done", launchError: "The audience changed since you looked (12, now 15). Look again." }), NOW);
    expect(state).toMatchObject({ key: "could-not-launch", tone: "bad" });
    expect(state.attention).toContain("The audience changed");
  });

  it("approved and about to launch", () => {
    expect(campaignState(facts({ approvalIssueId: "i-1", approvalStatus: "done" }), NOW)).toMatchObject({ key: "launching", attention: null });
  });
});

describe("running campaigns", () => {
  const running = (over: Partial<CampaignFacts> = {}) => facts({ status: "active", stats: { enrolled: 10, running: 10, done: 0 }, ...over });

  it("blocked step tasks make it stuck, with how many and for how long", () => {
    const state = campaignState(running({ tasks: { waiting: 10, blocked: 10, oldestAt: "2026-11-11T05:39:00Z" } }), NOW);
    expect(state).toMatchObject({ key: "stuck", label: "Stuck", tone: "bad" });
    expect(state.detail).toBe("10 emails held for 1 day: their tasks are blocked.");
    expect(state.attention).toBe(state.detail);
  });

  it("one blocked task reads in the singular and names no age under a day", () => {
    const state = campaignState(running({ tasks: { waiting: 3, blocked: 1, oldestAt: "2026-11-12T09:00:00Z" } }), NOW);
    expect(state.detail).toBe("1 email held: its task is blocked.");
  });

  it("names the placeholder that was never filled in, with the email's number", () => {
    const state = campaignState(running({ tasks: { waiting: 10, blocked: 10, oldestAt: "2026-11-11T05:39:00Z" }, placeholders: [{ number: 1, items: ["NOT-ISSUED-YET"] }] }), NOW);
    expect(state.detail).toBe("10 emails held for 1 day: their tasks are blocked. Email 1 still says NOT-ISSUED-YET.");
  });

  it("a placeholder alone makes a campaign stuck only before anything was sent", () => {
    const placeholders = [{ number: 2, items: ["TBC"] }];
    expect(campaignState(running({ placeholders }), NOW).key).toBe("stuck");
    expect(campaignState(running({ placeholders, sent: 4 }), NOW).key).toBe("running");
  });

  it("tasks waiting on the agent for under a day are normal; over a day is stuck", () => {
    expect(campaignState(running({ tasks: { waiting: 4, blocked: 0, oldestAt: "2026-11-12T02:00:00Z" } }), NOW)).toMatchObject({ key: "running" });
    const old = campaignState(running({ tasks: { waiting: 4, blocked: 0, oldestAt: "2026-11-10T02:00:00Z" } }), NOW);
    expect(old).toMatchObject({ key: "stuck" });
    expect(old.detail).toBe("4 emails waiting on the agent for 2 days.");
  });

  it("a failed send is stuck", () => {
    expect(campaignState(running({ failedSends: 2, sent: 5 }), NOW).detail).toBe("2 emails could not be sent.");
  });

  it("a healthy campaign says how far it is", () => {
    const state = campaignState(running({ sent: 12, stats: { enrolled: 10, running: 7, done: 3 }, tasks: { waiting: 2, blocked: 0, oldestAt: "2026-11-12T10:00:00Z" } }), NOW);
    expect(state).toMatchObject({ key: "running", label: "Running", tone: "ok", attention: null });
    expect(state.detail).toBe("12 emails sent to 10 people, 3 finished, 2 waiting on the agent.");
  });

  it("an active campaign with nobody in it says so", () => {
    expect(campaignState(running({ stats: { enrolled: 0, running: 0, done: 0 } }), NOW).detail).toBe("Nobody is enrolled.");
  });
});

describe("other states", () => {
  it("paused, scheduled and finished ask nothing", () => {
    expect(campaignState(facts({ status: "paused", stats: { enrolled: 5, running: 5, done: 0 } }), NOW)).toMatchObject({ key: "paused", attention: null });
    expect(campaignState(facts({ status: "scheduled" }), NOW)).toMatchObject({ key: "scheduled", attention: null });
    expect(campaignState(facts({ status: "completed", sent: 6, stats: { enrolled: 3, running: 0, done: 3 } }), NOW)).toMatchObject({ key: "finished", detail: "6 emails sent to 3 people." });
  });

  it("a paused campaign with blocked tasks is paused, not stuck", () => {
    expect(campaignState(facts({ status: "paused", tasks: { waiting: 3, blocked: 3, oldestAt: "2026-11-01T00:00:00Z" } }), NOW).key).toBe("paused");
  });
});

describe("helpers", () => {
  it("placeholderText names the first email and counts the others", () => {
    expect(placeholderText([])).toBeNull();
    expect(placeholderText([{ number: 2, items: ["{{code}}", "TBC", "TODO"] }])).toBe("Email 2 still says {{code}} and TBC");
    expect(placeholderText([{ number: 1, items: ["TBC"] }, { number: 3, items: ["TODO"] }])).toBe("Email 1 still says TBC (and 1 other email too)");
  });

  it("failedByCampaign counts rows per campaign", () => {
    expect([...failedByCampaign([{ campaignId: "a" }, { campaignId: "b" }, { campaignId: "a" }])]).toEqual([["a", 2], ["b", 1]]);
  });
});
