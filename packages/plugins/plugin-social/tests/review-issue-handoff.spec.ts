/**
 * 0.8.0 (Q1a-2, reviewer round): the post's review issue is the ONLY way the Social agent hears about a post, so nothing may depend on
 * it still being open. Agents close issues after drafting the client's email, and a policy can begin to ask for the client after a post
 * went to review. Closed or missing, the issue is opened again for the same post and carries the note; an ask that left the issue
 * with the owner does not stop the agent being woken; an agent that closes the issue early with work left gets it back.
 */
import { DONE_CHECK_MAX_REOPENS, runDoneCheck } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { sendBackForChanges } from "../src/approval-flow.js";
import { deliverClientAnswers, requestClientApproval } from "../src/client-approval.js";
import { loadSocialConfig } from "../src/config.js";
import { checkReview, SOCIAL_DONE_CHECKS } from "../src/done-checks.js";
import { recordClientApprovalRecord, setApprovalPolicyRecord, transitionPost } from "../src/service.js";
import { approvalWorld, PERSON, postRow, REVIEWER_AGENT, SOCIAL_AGENT, type World } from "./world.js";

const CLIENT_ONLY = { require_owner: false, require_client: true };

async function link(w: World) {
  return requestClientApproval(w.ctx, "co", postRow(w), await loadSocialConfig(w.ctx, "co"), { createdBy: "ag-social", byAgent: true });
}

describe("the client's answer when the review issue is closed or gone", () => {
  it("a request for changes reaches the Social agent through a fresh issue that carries the client's note, and the post is back in draft", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const made = await link(w);
    // The agent drafted the email and closed the issue, as agents do.
    w.setIssueStatus("iss-9", "done");
    w.answer(made.approvalId, "changes_requested", "Sam Jones", "Please use the new logo.");
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 1, changes: 1, failed: 0 });
    expect(w.post.status).toBe("draft");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ title: "[Acme] Fix after requested changes: social post: Spring sale starts Friday. Come and see.", assigneeAgentId: "ag-social", originId: "review:p1", status: "todo" });
    const text = String(w.created[0]!.description);
    expect(text).toContain("The client (Sam Jones) asked for changes");
    expect(text).toContain("> Please use the new logo.");
    expect(text).toContain("`request-review`");
    expect(text).toContain("Post id: `p1`");
    // The agent was woken on the new issue, and the post points at it (so sending it for review again reuses it).
    expect(w.wakeups).toEqual(["iss-1"]);
    expect(w.reviewIssueId()).toBe("iss-1");
    // The closed issue was not touched again.
    expect(w.updates.filter((u) => u.id === "iss-9")).toEqual([]);
  });

  it("the same when the post never had a review issue", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    const made = await link(w);
    expect(w.reviewIssueId()).toBeNull();
    w.answer(made.approvalId, "changes_requested", "Sam Jones", "Shorter, please.");
    await deliverClientAnswers(w.ctx, "co", "UTC");
    expect(w.created).toHaveLength(1);
    expect(String(w.created[0]!.description)).toContain("> Shorter, please.");
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("an open issue is reused, not duplicated", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const made = await link(w);
    w.answer(made.approvalId, "changes_requested", "Sam", "Shorter, please.");
    await deliverClientAnswers(w.ctx, "co", "UTC");
    expect(w.created).toEqual([]);
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } });
    expect(w.wakeups).toEqual(["iss-9"]);
  });

  it("an answer for an older version takes the issue back from the owner (an ask left it there) and wakes the agent", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const made = await link(w);
    w.answer(made.approvalId, "approved", "Sam", null);
    w.post.body = "Edited after the link went out.";
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ stale: 1 });
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } }]);
    expect(w.comments.at(-1)!.body).toContain("changed after the link was made");
    expect(w.wakeups).toEqual(["iss-9"]);
  });

  it("an answer for an older version with a closed issue opens a fresh one that says what to do", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const made = await link(w);
    w.setIssueStatus("iss-9", "done");
    w.answer(made.approvalId, "approved", "Sam", null);
    w.post.body = "Edited after the link went out.";
    await deliverClientAnswers(w.ctx, "co", "UTC");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ title: expect.stringContaining("Get client approval for social post"), assigneeAgentId: "ag-social" });
    expect(String(w.created[0]!.description)).toContain("does not count for the current version");
    expect(String(w.created[0]!.description)).toContain("request-client-approval");
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("a link that ran out opens a fresh issue when the old one is closed, so the agent can make a new link", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    await link(w);
    w.setIssueStatus("iss-9", "done");
    w.links[0]!.expires_at = new Date(Date.now() - 60_000).toISOString();
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ expired: 1 });
    expect(w.created).toHaveLength(1);
    expect(String(w.created[0]!.description)).toContain("ran out with no answer");
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("nothing is opened for a post that has left review: the answer is only kept on record", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const made = await link(w);
    w.setIssueStatus("iss-9", "done");
    w.post.status = "draft";
    w.answer(made.approvalId, "approved", "Sam", null);
    await deliverClientAnswers(w.ctx, "co", "UTC");
    expect(w.created).toEqual([]);
  });

  it("with no linked Social agent the kit's route takes the work (the Operator), so the note is still not lost", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, socialAgent: null });
    await sendBackForChanges(w.ctx, "co", postRow(w), "The client", "Shorter.", true);
    expect(w.post.status).toBe("draft");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ originId: "review:p1", assigneeAgentId: "ag-op" });
    expect(String(w.created[0]!.description)).toContain("> Shorter.");
  });
});

describe("a team member's approval when the client is still needed", () => {
  it("opens the issue for the Social agent when the post was in review with none (the policy came later), and does not open a second", async () => {
    const w = approvalWorld({ policy: { require_client: true } });
    const first = await transitionPost(w.ctx, PERSON, "p1", "approved") as { signoff: { pending: string[]; message: string } };
    expect(first.signoff).toMatchObject({ pending: ["client"], message: "Recorded. Waiting for the client's approval." });
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ title: "[Acme] Get client approval for social post: Spring sale starts Friday. Come and see.", assigneeAgentId: "ag-social", originId: "review:p1" });
    const text = String(w.created[0]!.description);
    expect(text).toContain("Next: the client's approval");
    // The team member's click is already in: the issue does not ask for it again.
    expect(text).not.toContain("and a team member's approval");
    expect(text).toContain("request-client-approval");
    expect(text).toContain("Mailbox DRAFT");
    expect(w.wakeups).toEqual(["iss-1"]);
    expect(w.reviewIssueId()).toBe("iss-1");
    // The same approval again (nothing changed): the open issue is reused and no second one appears.
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.created).toHaveLength(1);
  });

  it("a closed issue is replaced the same way", async () => {
    const w = approvalWorld({ policy: { require_client: true }, reviewIssue: "iss-9" });
    w.setIssueStatus("iss-9", "done");
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.created).toHaveLength(1);
    expect(w.reviewIssueId()).toBe("iss-1");
  });

  it("a person recording the client's approval finishes the post even when the review issue is long closed", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    w.setIssueStatus("iss-9", "done");
    const result = await recordClientApprovalRecord(w.ctx, PERSON, { postId: "p1", note: "Sam at Acme said yes by email on 3 Oct" }) as { signoff: { completed: boolean } };
    expect(result.signoff.completed).toBe(true);
    expect(w.post.status).toBe("approved");
    // Nothing is opened to chase the client for an approval that is already in (the only issue is the one that picks a publish time).
    expect(w.created.map((issue) => issue.originId)).toEqual(["schedule:company:c1:p1"]);
  });
});

describe("saving a policy that now asks for the client", () => {
  it("gives a post already in review its issue, once", async () => {
    const w = approvalWorld({ policy: null });
    const saved = await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", requireOwner: false, requireClient: true });
    expect(saved).toMatchObject({ requireClient: true, approved: 0, routed: 1 });
    expect(w.created).toHaveLength(1);
    expect(String(w.created[0]!.description)).toContain("now asks for the client's approval");
    expect(w.wakeups).toEqual(["iss-1"]);
    // Saving again with the issue open changes nothing.
    expect(await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", linkExpiryDays: 10 })).toMatchObject({ routed: 0 });
    expect(w.created).toHaveLength(1);
  });

  it("does not open another when the client already holds a link for this version", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    await link(w);
    expect(await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", linkExpiryDays: 21 })).toMatchObject({ routed: 0 });
    expect(w.created).toEqual([]);
  });

  it("a post that waits only for a team member is left alone (the Cockpit lists it)", async () => {
    const w = approvalWorld({ policy: null });
    expect(await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", requireReviewer: false, requireOwner: true })).toMatchObject({ routed: 0, approved: 0 });
    expect(w.created).toEqual([]);
  });
});

describe("an agent closing the review issue early", () => {
  /** The review issue as the host holds it after an agent closed it, behind the real done-check runner. */
  function closedBy(w: World, assignee = "ag-social") {
    const issues = (w.ctx as unknown as { issues: { get: (id: string) => Promise<Record<string, unknown> | null> } }).issues;
    const base = issues.get;
    issues.get = async (id: string) => {
      const row = await base(id);
      return id === "iss-9" && row ? { ...row, title: "Review a social post", originKind: "plugin:partnersinbiz.social", originId: "review:p1", assigneeAgentId: assignee, createdAt: new Date().toISOString() } : row;
    };
    w.setIssueStatus("iss-9", "done");
    return { entityId: "iss-9", companyId: "co", actorType: "agent" as const };
  }

  it("is told to make the client's link when none is out, and the issue opens again", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    const event = closedBy(w);
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, event)).toBe("reopened");
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "todo" } });
    expect(w.comments.at(-1)!.body).toContain("Review or approve a social post");
    expect(w.comments.at(-1)!.body).toContain("no link for this version is open");
    expect(w.comments.at(-1)!.body).toContain("request-client-approval");
    expect(w.wakeups).toContain("iss-9");
  });

  it("may close it once the client's link is out: waiting for the client is not unfinished work", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    await link(w);
    const event = closedBy(w);
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, event)).toBe("passed");
    expect(w.updates).toEqual([]);
  });

  it("an edit after the link was made puts the agent back to work: the link no longer counts", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    await link(w);
    w.post.body = "Edited after the link went out.";
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, closedBy(w))).toBe("reopened");
  });

  it("is told to get the Reviewer's verdict when the policy needs it and none is recorded", async () => {
    const w = approvalWorld({ policy: { require_reviewer: true }, reviewer: "rev-1", reviewIssue: "iss-9" });
    const result = await checkReview({ id: "iss-9", companyId: "co", identifier: null, title: "Review", originId: "review:p1", assigneeAgentId: "rev-1", createdAt: null }, w.ctx);
    expect(result.done).toBe(false);
    expect(result.missing?.[0]).toContain("record-review-verdict");
    // After the verdict it passes (a team member's click is a person's step).
    const { recordReviewVerdictRecord } = await import("../src/service.js");
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(await checkReview({ id: "iss-9", companyId: "co", identifier: null, title: "Review", originId: "review:p1", assigneeAgentId: "rev-1", createdAt: null }, w.ctx)).toEqual({ done: true });
  });

  it("passes when only a person's approval is left, when the post left review, and when the post is gone", async () => {
    const w = approvalWorld({ policy: null, reviewIssue: "iss-9" });
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, closedBy(w))).toBe("passed");
    const gone = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    gone.post.status = "approved";
    expect(await runDoneCheck(gone.ctx, SOCIAL_DONE_CHECKS, closedBy(gone))).toBe("passed");
    const drafted = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    drafted.post.status = "draft";
    expect(await checkReview({ id: "iss-9", companyId: "co", identifier: null, title: "Review", originId: "review:p1", assigneeAgentId: null, createdAt: null }, drafted.ctx)).toEqual({ done: true });
  });

  it("a person's close is never checked, and a third early close is handed on", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    // The kit counts early closes in plugin state: give the world a state that remembers them.
    const counts = new Map<string, unknown>();
    const state = w.ctx.state as unknown as { get: (k: { namespace?: string; stateKey: string }) => Promise<unknown>; set: (k: { namespace?: string; stateKey: string }, v: unknown) => Promise<void> };
    const baseGet = state.get;
    state.get = async (k) => (k.namespace === "pib-done-checks" ? counts.get(k.stateKey) ?? 0 : baseGet(k));
    state.set = async (k, v) => void counts.set(k.stateKey, v);
    const event = closedBy(w);
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, { ...event, actorType: "user" })).toBe("skipped");
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      w.setIssueStatus("iss-9", "done");
      expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, event)).toBe("reopened");
    }
    w.setIssueStatus("iss-9", "done");
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, event)).toBe("escalated");
  });

  it("the Social agent is not asked for anything on someone else's issue (another origin) ", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    (w.ctx as unknown as { manifest: { id: string } }).manifest = { id: "partnersinbiz.social" };
    const issues = (w.ctx as unknown as { issues: { get: (id: string) => Promise<Record<string, unknown> | null> } }).issues;
    const base = issues.get;
    issues.get = async (id: string) => ({ ...(await base(id)), status: "done", originKind: "plugin:partnersinbiz.seo", originId: "review:p1" });
    expect(await runDoneCheck(w.ctx, SOCIAL_DONE_CHECKS, { entityId: "iss-9", companyId: "co", actorType: "agent" })).toBe("skipped");
  });
});

describe("the agent that opened a post is the one the issue goes to", () => {
  it("a Social agent that closed its own issue and then drafts again is not stuck: sending the post for review reuses or replaces the issue", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    w.post.status = "draft";
    w.setIssueStatus("iss-9", "done");
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ originId: "review:p1", assigneeAgentId: "ag-social" });
  });
});
