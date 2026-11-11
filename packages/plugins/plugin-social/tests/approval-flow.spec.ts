/**
 * 0.8.0 (Q1a-2): a post becomes approved when every sign-off its scope's policy asks for is in for its CURRENT version.
 * The Reviewer's pass is a check, the client's answer or a person's click is the approval, and no agent ever approves.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { afterSignoff, approvePostByPerson, recordClientApprovalByPerson, recordReviewerVerdict, signoffState } from "../src/approval-flow.js";
import { approvePostAsDelegateRecord, recordClientApprovalRecord, recordReviewVerdictRecord, setApprovalDelegateRecord, setApprovalPolicyRecord, transitionPost } from "../src/service.js";
import { BRAND, delegateWorld, RHEA } from "./delegate-world.js";
import { approvalWorld, PERSON, postRow, REVIEWER_AGENT, SOCIAL_AGENT, T } from "./world.js";

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
    // The person's sign-off goes on their weekly issue; the post's own issue is finished.
    expect(w.updates).toEqual([{ id: "iss-9", patch: { status: "done" } }]);
    expect(w.created[0]).toMatchObject({ title: expect.stringContaining("Review social posts: week of "), assigneeUserId: "owner-1", originId: expect.stringContaining("review-week:owner-1:") });
    expect(String(w.created[0]!.description)).toContain("- [ ] ");
    // The person's approval now completes it.
    await approvePostByPerson(w.ctx, ACTOR, postRow(w));
    expect(w.post.status).toBe("approved");
  });

  it("a post with no rubric destination: the Reviewer's unscored pass unblocks the person's approval", async () => {
    const w = approvalWorld({ reviewer: "rev-1", policy, destinations: [] });
    await expect(approvePostByPerson(w.ctx, ACTOR, postRow(w))).rejects.toThrow("The Reviewer has not passed this version yet");
    const result = await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(result).toMatchObject({ recorded: true, verdict: "pass" });
    expect(w.outcomes).toMatchObject([{ stage: "reviewer", outcome: "approved", via: "unscored" }]);
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

describe("PAR-9561 T7a: a passed post goes to the scope's delegated approver", () => {
  const HOUR = 3_600_000;
  const weekly = (w: { created: Array<Record<string, unknown>> }) => w.created.filter((c) => String(c.originId).includes("review-week:"));

  /** After the Reviewer's pass (in the ledger), what is left is routed as `recordReviewerVerdict` does. */
  async function route(w: ReturnType<typeof delegateWorld>) {
    const state = await signoffState(w.ctx, "co", postRow(w));
    return afterSignoff(w.ctx, { companyId: "co", userId: null, isAgent: true }, postRow(w), state, "A person");
  }

  /** The person got it, as without a delegate: the weekly issue, the post's own issue finished, the delegate never woken. */
  function toPerson(w: ReturnType<typeof delegateWorld>) {
    expect(w.updates.some((u) => u.patch.assigneeAgentId === "ag-rhea")).toBe(false);
    expect(weekly(w)).toHaveLength(1);
    expect(w.updates).toContainEqual({ id: "iss-9", patch: { status: "done" } });
    expect(w.wakeups).toEqual([]);
    expect(w.post.status).toBe("review");
  }

  it("after the Reviewer's real pass the review issue goes to the delegate and wakes it; never the weekly issue", async () => {
    const w = delegateWorld();
    const result = await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(result).toMatchObject({ recorded: true, next: expect.stringContaining("delegated approver (agent `ag-rhea`)") });
    expect(w.updates).toContainEqual({ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-rhea", assigneeUserId: null } });
    expect(w.comments.find((c) => c.id === "iss-9")?.body).toContain("`approve-post-as-delegate`");
    expect(w.wakeups).toEqual(["iss-9"]);
    expect(weekly(w)).toEqual([]);
    expect(w.reviewIssueId()).toBe("iss-9");
    expect(w.post.status).toBe("review");
  });

  it("the delegate is inactive (paused): the person gets it", async () => {
    const w = delegateWorld();
    w.pass();
    const agents = w.ctx.agents as unknown as { get: (id: string) => Promise<unknown> };
    const base = agents.get;
    agents.get = async (id: string) => (id === "ag-rhea" ? { id, companyId: "co", name: id, status: "paused" } : base(id));
    await route(w);
    toPerson(w);
  });

  it("the delegate created the post: the person gets it", async () => {
    const w = delegateWorld();
    w.post.created_by_agent_id = "ag-rhea";
    w.pass();
    await route(w);
    toPerson(w);
  });

  it("the pass is unscored (D1): the person gets it", async () => {
    const w = delegateWorld();
    w.pass({ via: "unscored" });
    await route(w);
    toPerson(w);
  });

  it("the delegate recorded the pass: the person gets it", async () => {
    const w = delegateWorld();
    w.pass({ actor_agent_id: "ag-rhea" });
    await route(w);
    toPerson(w);
  });

  it("the post was created before the delegate was set (D3): the person gets it", async () => {
    const w = delegateWorld({ setAt: new Date(Date.now() + HOUR).toISOString() });
    w.pass();
    await route(w);
    toPerson(w);
  });

  it("the hand-off fails: the person gets it", async () => {
    const w = delegateWorld();
    w.pass();
    const issues = w.ctx.issues as unknown as { update: (id: string, patch: Record<string, unknown>) => Promise<unknown> };
    const base = issues.update;
    issues.update = async (id, patch) => {
      if (patch.assigneeAgentId === "ag-rhea") throw new Error("host refused");
      return base(id, patch);
    };
    const progress = await route(w);
    expect(progress.delegateAgentId).toBeUndefined();
    toPerson(w);
  });

  it("fails closed: the delegate store or the sign-off ledger cannot be read, so the person gets it", async () => {
    const store = delegateWorld();
    store.pass();
    store.io.stateThrows = true;
    await route(store);
    toPerson(store);

    const ledger = delegateWorld();
    ledger.pass();
    const state = await signoffState(ledger.ctx, "co", postRow(ledger));
    const db = ledger.ctx.db as unknown as { query: (sql: string, params: unknown[]) => Promise<unknown[]> };
    const base = db.query;
    db.query = async (sql, params) => {
      if (sql.includes(`FROM ${T("review_outcomes")}`)) throw new Error("db down");
      return base(sql, params);
    };
    await afterSignoff(ledger.ctx, { companyId: "co", userId: null, isAgent: true }, postRow(ledger), state, "A person");
    toPerson(ledger);
  });

  it("the client still has to approve: the delegate is not involved", async () => {
    const w = delegateWorld({ policy: { require_client: true } });
    w.pass();
    await route(w);
    expect(w.updates.some((u) => u.patch.assigneeAgentId === "ag-rhea")).toBe(false);
  });
});

describe("PAR-9561 T7b: clearing the delegate hands its work back; the re-check loop is hardened", () => {
  const HOUR = 3_600_000;
  const weekly = (w: { created: Array<Record<string, unknown>> }) => w.created.filter((c) => String(c.originId).includes("review-week:"));

  /** The fake host remembers who holds each issue (the shared world always answers "nobody"). */
  function trackAssignees(w: ReturnType<typeof delegateWorld>, initial: Record<string, string | null> = {}) {
    const holder: Record<string, string | null> = { ...initial };
    const issues = w.ctx.issues as unknown as { get: (id: string, co: string) => Promise<Record<string, unknown> | null>; update: (id: string, patch: Record<string, unknown>, co: string) => Promise<unknown> };
    const get = issues.get;
    const update = issues.update;
    issues.update = async (id, patch, co) => {
      if ("assigneeAgentId" in patch) holder[id] = (patch.assigneeAgentId as string | null) ?? null;
      return update(id, patch, co);
    };
    issues.get = async (id, co) => {
      const issue = await get(id, co);
      return issue ? { ...issue, assigneeAgentId: holder[id] ?? null } : issue;
    };
    return holder;
  }

  function warnings(w: ReturnType<typeof delegateWorld>) {
    const seen: Array<{ message: string; meta: Record<string, unknown> }> = [];
    (w.ctx.logger as unknown as { warn: (m: string, meta: Record<string, unknown>) => void }).warn = (message, meta) => void seen.push({ message, meta });
    return seen;
  }

  it("clear hands the delegate's review issue back to the person, and the delegate's later call is refused", async () => {
    const w = delegateWorld();
    const holder = trackAssignees(w);
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(holder["iss-9"]).toBe("ag-rhea");
    const cleared = await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: null });
    expect(cleared).toMatchObject({ delegate: null, handedBack: 1, failed: 0 });
    expect(weekly(w)).toHaveLength(1);
    expect(weekly(w)[0]).toMatchObject({ assigneeUserId: "owner-1" });
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "done" } });
    expect(w.comments.at(-1)!.body).toContain("moved to the weekly review issue");
    await expect(approvePostAsDelegateRecord(w.ctx, RHEA, { postId: "p1" })).rejects.toThrow();
    expect(w.post.status).toBe("review");
  });

  it("clear leaves the agent's other issues alone: a changes-requested draft, a stale pass, an issue held by someone else", async () => {
    // Changes requested: the post is back in draft and the same agent holds its issue to fix it.
    const draft = delegateWorld();
    trackAssignees(draft, { "iss-9": "ag-rhea" });
    draft.post.status = "draft";
    expect(await setApprovalDelegateRecord(draft.ctx, PERSON, { client: BRAND, agentId: null })).toMatchObject({ handedBack: 0, failed: 0 });
    expect(draft.updates).toEqual([]);
    expect(weekly(draft)).toEqual([]);

    // The pass is for an older version: the issue is not the delegate's approval work.
    const stale = delegateWorld();
    trackAssignees(stale, { "iss-9": "ag-rhea" });
    stale.pass();
    stale.post.body = "Edited after the pass.";
    expect(await setApprovalDelegateRecord(stale.ctx, PERSON, { client: BRAND, agentId: null })).toMatchObject({ handedBack: 0 });
    expect(stale.updates.some((u) => u.id === "iss-9" && u.patch.status === "done")).toBe(false);

    // Passed and waiting on the owner, but another agent holds the issue.
    const other = delegateWorld();
    trackAssignees(other, { "iss-9": "ag-other" });
    other.pass();
    expect(await setApprovalDelegateRecord(other.ctx, PERSON, { client: BRAND, agentId: null })).toMatchObject({ handedBack: 0 });
    expect(other.updates).toEqual([]);
  });

  it("a hand-back that cannot be read or written is counted as failed; the delegate is still cleared", async () => {
    const w = delegateWorld();
    trackAssignees(w, { "iss-9": "ag-rhea" });
    w.pass();
    const seen = warnings(w);
    (w.ctx.issues as unknown as { get: () => Promise<unknown> }).get = async () => {
      throw new Error("host down");
    };
    const cleared = await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: null });
    expect(cleared).toMatchObject({ delegate: null, handedBack: 0, failed: 1 });
    expect(w.store.get("delegates")).toEqual({});
    expect(seen).toMatchObject([{ message: "Social policy re-check failed for a post", meta: { postId: "p1", error: "host down" } }]);
  });

  it("set re-routes nothing: a post already in review stays with the person (check 9)", async () => {
    const w = delegateWorld({ delegate: null });
    trackAssignees(w);
    w.pass();
    const set = await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" });
    expect(set).toMatchObject({ delegate: { agentId: "ag-rhea" } });
    expect(w.updates).toEqual([]);
    expect(w.created).toEqual([]);
    expect(w.wakeups).toEqual([]);
  });

  it("a person's weekly item still lets the person approve first; the delegate's later call is refused (not in review)", async () => {
    // Created before the delegate was set: the pass goes to the person's weekly issue (check 9).
    const w = delegateWorld({ setAt: new Date(Date.now() + HOUR).toISOString() });
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(weekly(w)).toHaveLength(1);
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.post.status).toBe("approved");
    await expect(approvePostAsDelegateRecord(w.ctx, RHEA, { postId: "p1" })).rejects.toThrow("not in review");
  });

  it("re-checks all 51 posts in review; one that throws is counted in failed and does not stop the others", async () => {
    const w = delegateWorld({ policy: { require_client: true } });
    const seen = warnings(w);
    const rows = Array.from({ length: 51 }, (_, i) => ({ ...w.post, id: `p${i + 1}`, tags: [], review_issue_id: null }));
    const checked = new Set<string>();
    const db = w.ctx.db as unknown as { query: (sql: string, params: unknown[]) => Promise<unknown[]> };
    const base = db.query;
    let limit: unknown = null;
    db.query = async (sql, params) => {
      if (sql.includes(`FROM ${T("posts")} WHERE company_id = $1 AND status = $2`)) {
        limit = params.at(-1);
        return rows;
      }
      if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) {
        checked.add(String(params[0]));
        if (params[0] === "p13") throw new Error("row broken");
      }
      return base(sql, params);
    };
    const saved = await setApprovalPolicyRecord(w.ctx, PERSON, { client: BRAND, requireClient: false, requireReviewer: true });
    expect(limit).toBe(1000);
    expect(checked.size).toBe(51);
    expect(saved).toMatchObject({ failed: 1 });
    expect(seen).toEqual([{ message: "Social policy re-check failed for a post", meta: expect.objectContaining({ postId: "p13", error: "row broken" }) }]);
  });

  it("the list itself cannot be read: the save stands, failed is 1 and it is logged at warn", async () => {
    const w = delegateWorld();
    const seen = warnings(w);
    const db = w.ctx.db as unknown as { query: (sql: string, params: unknown[]) => Promise<unknown[]> };
    const base = db.query;
    db.query = async (sql, params) => {
      if (sql.includes(`FROM ${T("posts")} WHERE company_id = $1 AND status = $2`)) throw new Error("db down");
      return base(sql, params);
    };
    expect(await setApprovalPolicyRecord(w.ctx, PERSON, { client: BRAND, requireReviewer: true })).toMatchObject({ approved: 0, failed: 1 });
    expect(seen.map((s) => s.message)).toEqual(["Social policy re-check could not list posts in review"]);
  });

  it("the page shows only the failure count, after a policy save and after a delegate save or clear", () => {
    const card = readFileSync(new URL("../src/ui/approvals.tsx", import.meta.url), "utf8");
    expect(card).toContain('return typeof failed === "number" && failed > 0 ? failed : 0;');
    expect(card.match(/setFailed\(recheckFailed\(result\)\)/g)).toHaveLength(2);
    expect(card.match(/<RecheckNote failed=\{failed\} \/>/g)).toHaveLength(2);
    expect(card).toContain("could not be re-checked");
  });
});
