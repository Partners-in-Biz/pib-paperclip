/**
 * PAR-9561 T6: `return-post-as-delegate`. The delegated approver sends a post in review back to draft with notes: the
 * same caller checks as the approval (1 to 6), notes required (8), one owner/changes/delegate row, review_returns untouched.
 */
import { describe, expect, it } from "vitest";
import { returnPostAsDelegateRecord } from "../src/service.js";
import { returnPostByDelegate } from "../src/approval-flow.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import manifest from "../src/manifest.js";
import { postRow, PERSON, REVIEWER_AGENT, SOCIAL_AGENT } from "./world.js";
import { delegateWorld, OTHER, RHEA } from "./delegate-world.js";

const NOTES = "Price is wrong.\nAlt text missing.";

describe("the delegated approver returns a post with notes", () => {
  it("draft, one owner/changes/delegate row with the notes, review_returns unchanged, notes on the Social agent's issue", async () => {
    const w = delegateWorld();
    w.pass();
    const result = (await returnPostAsDelegateRecord(w.ctx, RHEA, { postId: "p1", notes: NOTES })) as { returned: boolean };
    expect(result.returned).toBe(true);
    expect(w.post.status).toBe("draft");
    expect(w.post.review_returns).toBe(0);
    expect(w.ownerRows()).toHaveLength(1);
    expect(w.ownerRows()[0]).toMatchObject({ stage: "owner", outcome: "changes", via: "delegate", actor_agent_id: "ag-rhea", actor_user_id: null, note: NOTES });
    const text = [...w.comments.map((c) => c.body), ...w.created.map((c) => String(c.description ?? ""))].join("\n");
    expect(text).toContain("The delegated approver asked for changes");
    expect(text).toContain("> Price is wrong.");
    expect(text).toContain("> Alt text missing.");
  });

  it("works before any Reviewer pass (a return needs no pass)", async () => {
    const w = delegateWorld();
    await returnPostByDelegate(w.ctx, RHEA, postRow(w), NOTES);
    expect(w.post.status).toBe("draft");
  });
});

describe("refused, with the post left in review and no row", () => {
  async function refused(w: ReturnType<typeof delegateWorld>, caller: { companyId: string; agentId: string | null; isAgent: boolean }, message: string, notes: string | null = NOTES) {
    await expect(returnPostByDelegate(w.ctx, caller, postRow(w), notes)).rejects.toThrow(message);
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  }

  it("no notes, empty or blank", async () => {
    const w = delegateWorld();
    await refused(w, RHEA, "Say what has to change", null);
    await refused(w, RHEA, "Say what has to change", "  \n ");
  });

  it("the policy read throws", async () => {
    const w = delegateWorld();
    w.io.policyThrows = true;
    await refused(w, RHEA, "The approval policy could not be read");
  });

  it("the delegate store read throws", async () => {
    const w = delegateWorld();
    w.io.stateThrows = true;
    await refused(w, RHEA, "No delegated approver is set");
  });

  it("the scope asks for the client, or not for the owner", async () => {
    await refused(delegateWorld({ policy: { require_client: true } }), RHEA, "cannot stand in for the client");
    await refused(delegateWorld({ policy: { require_owner: false } }), RHEA, "does not ask for a team member");
  });

  it("any other agent, the Social agent and the Reviewer", async () => {
    const w = delegateWorld();
    await refused(w, OTHER, "You are not the delegated approver");
    await refused(w, SOCIAL_AGENT, "You are not the delegated approver");
    await refused(w, REVIEWER_AGENT, "You are not the delegated approver");
  });

  it("the Reviewer, when it is the stored delegate", async () => {
    await refused(delegateWorld({ delegate: "rev-1" }), REVIEWER_AGENT, "cannot also approve it");
  });

  it("a post it created, a personal post, a post not in review", async () => {
    const a = delegateWorld();
    a.post.created_by_agent_id = "ag-rhea";
    await refused(a, RHEA, "You created this post");
    const b = delegateWorld();
    b.post.scope = "personal";
    await refused(b, RHEA, "A personal post has no delegated approver");
    const c = delegateWorld();
    c.post.status = "draft";
    await expect(returnPostByDelegate(c.ctx, RHEA, postRow(c), NOTES)).rejects.toThrow("not in review");
    expect(c.ownerRows()).toEqual([]);
  });

  it("a person, or an agent with no id, through the tool", async () => {
    const w = delegateWorld();
    await expect(returnPostAsDelegateRecord(w.ctx, PERSON, { postId: "p1", notes: NOTES })).rejects.toThrow("Only the delegated approver agent");
    await refused(w, { companyId: "co", agentId: null, isAgent: true }, "Only the delegated approver agent");
  });

  it("a failed or lost ledger write leaves the post in review", async () => {
    for (const mode of ["throws", "lost"] as const) {
      const w = delegateWorld();
      w.io.outcomeInsert = mode;
      await refused(w, RHEA, "could not be recorded");
    }
  });
});

describe("the tool", () => {
  it("is in SOCIAL_TOOLS and the manifest, notes required", () => {
    const tool = SOCIAL_TOOLS.find((t) => t.name === "return-post-as-delegate")!;
    expect(tool.parametersSchema).toMatchObject({ required: ["postId", "notes"] });
    expect((manifest.tools ?? []).map((t) => t.name)).toContain("return-post-as-delegate");
  });
});
