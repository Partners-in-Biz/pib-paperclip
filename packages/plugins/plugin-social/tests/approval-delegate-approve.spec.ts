/**
 * PAR-9561 T5: `approve-post-as-delegate`. The agent a person named for a scope approves a post in review after the
 * Reviewer's scored pass of THIS version. Every check refuses on its own sentence; every unreadable input refuses; the
 * ledger row is required; a lost status race is not an approval. Nothing else lets an agent approve.
 */
import { describe, expect, it } from "vitest";
import { requireUser, approvePostAsDelegateRecord, recordReviewVerdictRecord, transitionPost } from "../src/service.js";
import { approvePostByDelegate } from "../src/approval-flow.js";
import { contentHashOf } from "../src/content-hash.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import manifest from "../src/manifest.js";
import { PERSON, postRow, REVIEWER_AGENT, SOCIAL_AGENT } from "./world.js";
const HOUR = 3_600_000;
import { delegateWorld, OTHER, RHEA } from "./delegate-world.js";

describe("the delegated approver approves after the Reviewer's pass", () => {
  it("post approved, one owner/delegate row with its agent id, review issue closed", async () => {
    const w = delegateWorld();
    w.pass();
    const result = (await approvePostAsDelegateRecord(w.ctx, RHEA, { postId: "p1" })) as { status: string; signoff: { completed: boolean } };
    expect(result).toMatchObject({ status: "approved", signoff: { completed: true } });
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toHaveLength(1);
    expect(w.ownerRows()[0]).toMatchObject({ stage: "owner", outcome: "approved", via: "delegate", actor_agent_id: "ag-rhea", actor_user_id: null, content_hash: w.hash() });
    expect(w.updates).toContainEqual({ id: "iss-9", patch: { status: "done" } });
    expect(w.reviewIssueId()).toBeNull();
  });

  it("end to end after the Reviewer's real pass, on a post created after the delegate was named", async () => {
    const w = delegateWorld({ setAt: new Date(Date.now() - 1000).toISOString() });
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(w.post.status).toBe("review");
    await approvePostByDelegate(w.ctx, RHEA, postRow(w));
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toMatchObject([{ via: "delegate", actor_agent_id: "ag-rhea" }]);
  });
});

describe("refused, each on its own sentence, with the post left in review and no owner row", () => {
  async function refused(w: ReturnType<typeof delegateWorld>, caller: { companyId: string; agentId: string | null; isAgent: boolean }, message: RegExp | string) {
    await expect(approvePostByDelegate(w.ctx, caller, postRow(w))).rejects.toThrow(message);
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  }

  it("no Reviewer pass", async () => refused(delegateWorld(), RHEA, "The Reviewer has not passed this post yet"));

  it("the Reviewer asked for changes last", async () => {
    const w = delegateWorld();
    w.pass();
    w.pass({ outcome: "changes" });
    await refused(w, RHEA, "The Reviewer asked for changes");
  });

  it("a stale pass (an older version)", async () => {
    const w = delegateWorld();
    w.pass({ content_hash: "0".repeat(64) });
    await refused(w, RHEA, "passed an older version");
  });

  it("an unscored pass (D1)", async () => {
    const w = delegateWorld();
    w.pass({ via: "unscored" });
    await refused(w, RHEA, "scored nothing");
  });

  it("the post was created before the delegate was set (D3)", async () => {
    const w = delegateWorld({ setAt: new Date(Date.now() + HOUR).toISOString() });
    w.pass();
    await refused(w, RHEA, "created before you were named the delegated approver");
  });

  it("the scope asks for the client", async () => {
    const w = delegateWorld({ policy: { require_client: true } });
    w.pass();
    await refused(w, RHEA, "a delegated approver cannot stand in for the client");
  });

  it("the policy read throws", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.policyThrows = true;
    await refused(w, RHEA, "The approval policy could not be read");
  });

  it("the delegate store read throws: no delegate", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.stateThrows = true;
    await refused(w, RHEA, "No delegated approver is set");
  });

  it("a post it created", async () => {
    const w = delegateWorld();
    w.post.created_by_agent_id = "ag-rhea";
    w.pass();
    await refused(w, RHEA, "You created this post");
  });

  it("any other agent, the Social agent and the Reviewer", async () => {
    const w = delegateWorld();
    w.pass();
    await refused(w, OTHER, "You are not the delegated approver");
    await refused(w, SOCIAL_AGENT, "You are not the delegated approver");
    await refused(w, REVIEWER_AGENT, "You are not the delegated approver");
  });

  it("the Reviewer, when it is (still) the stored delegate", async () => {
    const w = delegateWorld({ delegate: "rev-1" });
    w.pass({ actor_agent_id: "rev-2" });
    await refused(w, REVIEWER_AGENT, "The Reviewer checks the post; it cannot also approve it");
  });

  it("the caller recorded the pass (the Reviewer role moved to it after the pass)", async () => {
    const w = delegateWorld();
    w.pass({ actor_agent_id: "ag-rhea" });
    await refused(w, RHEA, "You recorded the Reviewer's pass");
  });

  it("a personal post", async () => {
    const w = delegateWorld();
    w.post.scope = "personal";
    w.pass();
    await refused(w, RHEA, "A personal post has no delegated approver");
  });

  it("a post not in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.post.status = "draft";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("not in review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("no delegate set", async () => {
    const w = delegateWorld({ delegate: null });
    w.pass();
    await refused(w, RHEA, "No delegated approver is set");
  });

  it("the scope is off the allowlist", async () => {
    const w = delegateWorld({ allowlist: [] });
    w.pass();
    await refused(w, RHEA, "not on the delegatable scopes list");
  });

  it("a person (or an agent with no id) through the tool", async () => {
    const w = delegateWorld();
    w.pass();
    await expect(approvePostAsDelegateRecord(w.ctx, PERSON, { postId: "p1" })).rejects.toThrow("Only the delegated approver agent");
    await refused(w, { companyId: "co", agentId: null, isAgent: true }, "Only the delegated approver agent");
  });
});

describe("the write must land, and a lost race is not an approval", () => {
  it("a failed insert leaves the post in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.outcomeInsert = "throws";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("could not be recorded");
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("a lost round race (recorded: false) leaves the post in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.outcomeInsert = "lost";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("could not be recorded");
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("the post leaves review between the checks and the approval: reported as not approved", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.raceOnInsert = true;
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("The post was not approved");
    expect(w.post.status).toBe("draft");
  });
});

describe("nothing else lets the delegate approve, and a person still can", () => {
  it("set-post-status approved and social.approve's guard refuse the delegate", async () => {
    const w = delegateWorld();
    w.pass();
    await expect(transitionPost(w.ctx, RHEA, "p1", "approved")).rejects.toThrow();
    expect(() => requireUser(RHEA, "approve a post")).toThrow("A person must approve a post");
    expect(w.post.status).toBe("review");
  });

  it("a person approves in a delegated scope", async () => {
    const w = delegateWorld();
    w.pass();
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toMatchObject([{ via: "ui", actor_user_id: "owner-1" }]);
  });

  it("is an agent tool in SOCIAL_TOOLS and the manifest; the setting stays a page action", () => {
    expect(SOCIAL_TOOLS.map((t) => t.name)).toContain("approve-post-as-delegate");
    expect((manifest.tools ?? []).map((t) => t.name)).toContain("approve-post-as-delegate");
    expect((manifest.tools ?? []).map((t) => t.name)).not.toContain("set-approval-delegate");
    const tool = SOCIAL_TOOLS.find((t) => t.name === "approve-post-as-delegate")!;
    expect(tool.description).toContain("Delegated approver only");
    expect(tool.description).toContain("return-post-as-delegate");
  });
});
