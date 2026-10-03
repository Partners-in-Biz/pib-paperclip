/**
 * 0.8.0 (Q1a-2): a post becomes approved when every sign-off its scope's policy asks for is in for its CURRENT version.
 * The Reviewer's pass is a check, the client's answer or a person's click is the approval, and no agent ever approves.
 */
import { describe, expect, it } from "vitest";
import { approvePostByPerson, recordClientApprovalByPerson, recordReviewerVerdict, signoffState } from "../src/approval-flow.js";
import { recordClientApprovalRecord, recordReviewVerdictRecord, setApprovalPolicyRecord, transitionPost } from "../src/service.js";
import { approvalWorld, PERSON, postRow, REVIEWER_AGENT, SOCIAL_AGENT } from "./world.js";

const ACTOR = { companyId: "co", userId: "owner-1", isAgent: false };

describe("the default policy (a team member approves) is unchanged", () => {
  it("a person's approval is recorded as an input for the autonomy numbers, and approves at once", async () => {
    const w = approvalWorld({ client: null, reviewIssue: "iss-9" });
    const result = await transitionPost(w.ctx, PERSON, "p1", "approved") as { status: string; signoff: { completed: boolean } };
    expect(result.signoff).toMatchObject({ completed: true, pending: [] });
    expect(w.post.status).toBe("approved");
    expect(w.outcomes).toHaveLength(1);
    expect(w.outcomes[0]).toMatchObject({ stage: "owner", outcome: "approved", round: 1, via: "ui", actor_user_id: "owner-1", post_type: "original:text" });
    expect(String(w.outcomes[0]!.content_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approval does not depend on the ledger: if the outcome cannot be written the post is still approved", async () => {
    const w = approvalWorld({ client: null });
    const failing = { ...w.ctx, db: { ...w.ctx.db, execute: async (sql: string, params: unknown[]) => { if (sql.includes("review_outcomes")) throw new Error("disk full"); return w.ctx.db.execute(sql, params); } } } as typeof w.ctx;
    await transitionPost(failing, PERSON, "p1", "approved");
    expect(w.post.status).toBe("approved");
    expect(w.logs).toContain("Social review outcome not recorded");
  });

  it("sending a post back to draft is the owner asking for changes (and still counts as a return)", async () => {
    const w = approvalWorld({ client: null });
    await transitionPost(w.ctx, PERSON, "p1", "draft");
    expect(w.post.status).toBe("draft");
    expect(w.outcomes).toMatchObject([{ stage: "owner", outcome: "changes", via: "ui" }]);
  });

  it("an agent withdrawing its own post from review records nothing", async () => {
    const w = approvalWorld({ client: null });
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "draft");
    expect(w.outcomes).toEqual([]);
  });
});

describe("the Reviewer's pass comes first when the policy says so", () => {
  const policy = { require_reviewer: true };

  it("a team member cannot approve before the Reviewer passed this version", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy });
    await expect(approvePostByPerson(w.ctx, ACTOR, postRow(w))).rejects.toThrow("The Reviewer has not passed this version yet");
    expect(w.post.status).toBe("review");
  });

  it("only the company's Reviewer can record a verdict", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy });
    await expect(recordReviewVerdictRecord(w.ctx, SOCIAL_AGENT, { postId: "p1", verdict: "pass" })).rejects.toThrow("Only the Reviewer records a review verdict");
    await expect(recordReviewVerdictRecord(w.ctx, PERSON, { postId: "p1", verdict: "pass" })).rejects.toThrow("Only the Reviewer agent");
    await expect(recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "approve" })).rejects.toThrow('verdict must be "pass" or "changes"');
    const none = approvalWorld({ policy: null });
    await expect(recordReviewVerdictRecord(none.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" })).rejects.toThrow("no Reviewer set");
    expect(w.outcomes).toEqual([]);
  });

  it("a pass is a check, never an approval: the post stays in review and the issue goes to the person who approves", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy, reviewIssue: "iss-9" });
    const result = await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass", notes: "Reads well." });
    expect(result).toMatchObject({ recorded: true, verdict: "pass" });
    expect(w.post.status).toBe("review");
    expect(w.outcomes).toMatchObject([{ stage: "reviewer", outcome: "approved", via: "tool", actor_agent_id: "rev-1", note: "Reads well." }]);
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: null, assigneeUserId: "owner-1" } }]);
    expect(w.comments[0]!.body).toContain("Next: a team member's approval");
    // The person's approval now completes it.
    await approvePostByPerson(w.ctx, ACTOR, postRow(w));
    expect(w.post.status).toBe("approved");
  });

  it("changes need notes, send the post back to draft and give the Social agent the review issue (kept open, not closed)", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy, reviewIssue: "iss-9" });
    await expect(recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "changes", notes: " " })).rejects.toThrow("Say what has to change");
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "changes", notes: "The price is wrong.\nNo alt text." });
    expect(result.next).toContain("back in draft");
    expect(w.post.status).toBe("draft");
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } }]);
    expect(w.comments[0]!.body).toContain("The Reviewer asked for changes");
    expect(w.comments[0]!.body).toContain("> The price is wrong.\n> No alt text.");
    expect(w.wakeups).toEqual(["iss-9"]);
    expect(w.reviewIssueId()).toBe("iss-9");
    expect(w.post.review_returns).toBe(0);
    expect(w.outcomes).toMatchObject([{ stage: "reviewer", outcome: "changes" }]);
  });

  it("editing the post after the pass makes the pass stale", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy });
    await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect((await signoffState(w.ctx, "co", postRow(w))).signoffs.reviewer).toBe("approved");
    w.post.body = "Spring sale starts Saturday instead.";
    expect((await signoffState(w.ctx, "co", postRow(w))).signoffs.reviewer).toBe("stale");
    await expect(approvePostByPerson(w.ctx, ACTOR, postRow(w))).rejects.toThrow("has not passed this version yet");
  });

  it("a post that is not in review has nothing to check", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy });
    w.post.status = "draft";
    await expect(recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null })).rejects.toThrow("not in review");
  });
});

describe("a client scope where the client approves", () => {
  it("sent for review with no Reviewer: the Social agent gets the issue, to send the client their link", async () => {
    const w = approvalWorld({ policy: { require_owner: false, require_client: true } });
    w.post.status = "draft";
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ title: "[Acme] Get client approval for social post: Spring sale starts Friday. Come and see.", assigneeAgentId: "ag-social", originId: "review:p1", status: "todo" });
    const text = String(w.created[0]!.description);
    expect(text).toContain("partnersinbiz.social:request-client-approval");
    expect(text).toContain("Mailbox DRAFT");
    expect(text).toContain("Never send it yourself");
    expect(text).toContain("the client approves");
    expect(w.reviewIssueId()).toBe("iss-1");
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("with the default policy and no Reviewer nothing opens (as before)", async () => {
    const w = approvalWorld({ policy: null });
    w.post.status = "draft";
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
    expect(w.created).toEqual([]);
  });

  it("a team member has no Approve here: the client approves, or a person records that they did", async () => {
    const w = approvalWorld({ policy: { require_owner: false, require_client: true } });
    await expect(transitionPost(w.ctx, PERSON, "p1", "approved")).rejects.toThrow("the client approves, not a team member");
    expect(w.post.status).toBe("review");
    expect(w.outcomes).toEqual([]);
  });

  it("a person records the client's approval with a note saying how, and that approves the post", async () => {
    const w = approvalWorld({ policy: { require_owner: false, require_client: true }, reviewIssue: "iss-9" });
    await expect(recordClientApprovalRecord(w.ctx, PERSON, { postId: "p1", note: "ok" })).rejects.toThrow("Say how the client approved");
    const result = await recordClientApprovalRecord(w.ctx, PERSON, { postId: "p1", note: "Sam at Acme said yes by email on 3 Oct", by: "Sam" }) as { signoff: { completed: boolean } };
    expect(result.signoff.completed).toBe(true);
    expect(w.post.status).toBe("approved");
    expect(w.outcomes).toMatchObject([{ stage: "client", outcome: "approved", via: "recorded", actor_name: "Sam", note: "Sam at Acme said yes by email on 3 Oct" }]);
    expect(w.comments.at(-1)!.body).toContain("A person, recording the client's approval, approved the post");
    expect(w.comments.at(-1)!.body).toContain("Record: Sam at Acme said yes by email");
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "done" } });
  });

  it("only a person can record it, and only on a client scope that asks for it", async () => {
    const w = approvalWorld({ policy: { require_owner: false, require_client: true } });
    await expect(recordClientApprovalRecord(w.ctx, SOCIAL_AGENT, { postId: "p1", note: "The client said yes on the phone" })).rejects.toThrow("A person must record the client's approval");
    const owner = approvalWorld({ policy: null });
    await expect(recordClientApprovalByPerson(owner.ctx, ACTOR, postRow(owner), "The client said yes on the phone")).rejects.toThrow("does not ask for the client's approval");
  });
});

describe("a team member and the client both approve", () => {
  const policy = { require_client: true };

  it("the team member's approval is recorded, the post waits for the client, and the Social agent is handed the issue", async () => {
    const w = approvalWorld({ policy, reviewIssue: "iss-9" });
    const result = await transitionPost(w.ctx, PERSON, "p1", "approved") as { signoff: { completed: boolean; pending: string[]; message: string }; approval?: unknown };
    expect(result.signoff).toMatchObject({ completed: false, pending: ["client"], message: "Recorded. Waiting for the client's approval." });
    expect(result.approval).toBeUndefined();
    expect(w.post.status).toBe("review");
    expect(w.outcomes).toMatchObject([{ stage: "owner", outcome: "approved" }]);
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } }]);
    expect(w.comments[0]!.body).toContain("Get the client's approval with `request-client-approval`");
    // The review issue stays open: nothing closed it, and nothing was scheduled.
    expect(w.created).toEqual([]);
  });

  it("when the client already holds a link for this version, the Social agent is not sent to make a second one", async () => {
    const w = approvalWorld({ policy, reviewIssue: "iss-9" });
    const { requestClientApproval } = await import("../src/client-approval.js");
    const { loadSocialConfig } = await import("../src/config.js");
    await requestClientApproval(w.ctx, "co", postRow(w), await loadSocialConfig(w.ctx, "co"), { createdBy: "ag-social", byAgent: true });
    const result = await transitionPost(w.ctx, PERSON, "p1", "approved") as { signoff: { pending: string[] } };
    expect(result.signoff.pending).toEqual(["client"]);
    expect(w.updates).toEqual([]);
    expect(w.comments).toEqual([]);
    // The post changed since: the old link and the old sign-off no longer count, so the agent is handed the issue again for a new link.
    w.post.body = "Spring sale starts Saturday instead.";
    const again = await transitionPost(w.ctx, PERSON, "p1", "approved") as { signoff: { pending: string[] } };
    expect(again.signoff.pending).toEqual(["client"]);
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } }]);
    expect(w.comments[0]!.body).toContain("Get the client's approval with `request-client-approval`");
  });

  it("the client's recorded approval completes it, and both sign-offs are on the record", async () => {
    const w = approvalWorld({ policy, reviewIssue: "iss-9" });
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    const result = await recordClientApprovalRecord(w.ctx, PERSON, { postId: "p1", note: "Sam at Acme approved on the phone, 3 Oct" }) as { signoff: { completed: boolean } };
    expect(result.signoff.completed).toBe(true);
    expect(w.post.status).toBe("approved");
    expect(w.outcomes.map((o) => o.stage)).toEqual(["owner", "client"]);
  });

  it("an edit between the two sign-offs voids the earlier one", async () => {
    const w = approvalWorld({ policy });
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    w.post.first_comment = "Added after the team member approved.";
    const result = await recordClientApprovalRecord(w.ctx, PERSON, { postId: "p1", note: "Sam at Acme approved on the phone, 3 Oct" }) as { signoff: { completed: boolean; pending: string[] } };
    expect(result.signoff).toMatchObject({ completed: false, pending: ["owner"] });
    expect(w.post.status).toBe("review");
  });
});

describe("loosening a policy approves posts whose sign-offs are already in", () => {
  it("a post waiting only for the client is approved when the owner removes the client requirement", async () => {
    const w = approvalWorld({ policy: { require_client: true } });
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.post.status).toBe("review");
    const saved = await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", requireClient: false });
    expect(saved).toMatchObject({ requireClient: false, approved: 1 });
    expect(w.post.status).toBe("approved");
  });
});
