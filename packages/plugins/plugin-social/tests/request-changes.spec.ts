/**
 * A person's "Ask for changes" on the Social page: the note reaches the Social agent, the post ends as a draft, and the
 * ledger keeps the note (owner / changes / ui).
 */
import { describe, expect, it } from "vitest";
import { changeNotesFor, requestChangesByPerson } from "../src/approval-flow.js";
import { requestChangesRecord } from "../src/service.js";
import { approvalWorld, PERSON, postRow, SOCIAL_AGENT } from "./world.js";

const NOTE = "Lead with the price.\nDrop the last hashtag.";
const told = (w: ReturnType<typeof approvalWorld>) => [...w.comments.map((c) => c.body), ...w.created.map((c) => String(c.description ?? ""))].join("\n");

describe("a person asks for changes on a post", () => {
  it("in review: back to draft, counted as a return, the note on the agent's issue and in the ledger", async () => {
    const w = approvalWorld({ reviewIssue: "iss-9" });
    const result = await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE);
    expect(result).toMatchObject({ from: "review", handed: true });
    expect(w.post.status).toBe("draft");
    expect(w.post.review_returns).toBe(1);
    expect(w.outcomes).toHaveLength(1);
    expect(w.outcomes[0]).toMatchObject({ stage: "owner", outcome: "changes", via: "ui", actor_user_id: "owner-1", note: NOTE });
    expect(told(w)).toContain("A team member asked for changes");
    expect(told(w)).toContain("> Lead with the price.");
    expect(told(w)).toContain("> Drop the last hashtag.");
  });

  it("a draft stays a draft and the agent gets a task with the note", async () => {
    const w = approvalWorld();
    w.post.status = "draft";
    const result = await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE);
    expect(result).toMatchObject({ from: "draft", handed: true });
    expect(w.post.status).toBe("draft");
    expect(w.post.review_returns).toBe(0);
    expect(w.created).toHaveLength(1);
    expect(String(w.created[0]!.description)).toContain("> Lead with the price.");
    expect(w.created[0]).toMatchObject({ assigneeAgentId: "ag-social" });
  });

  it.each(["approved", "scheduled"])("a %s post goes back to draft so it cannot publish unchanged", async (status) => {
    const w = approvalWorld();
    w.post.status = status;
    const result = await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE);
    expect(result.from).toBe(status);
    expect(w.post.status).toBe("draft");
    expect(told(w)).toContain(`The post was ${status} and is back in draft`);
  });

  it("'also do this on later posts' tells the agent to propose a playbook rule", async () => {
    const w = approvalWorld({ reviewIssue: "iss-9" });
    await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE, { remember: true });
    expect(told(w)).toContain("propose-playbook-change");
    const plain = approvalWorld({ reviewIssue: "iss-9" });
    await requestChangesByPerson(plain.ctx, PERSON, postRow(plain), NOTE);
    expect(told(plain)).not.toContain("propose-playbook-change");
  });

  it("says so when nobody could be given the note", async () => {
    const w = approvalWorld({ socialAgent: null });
    w.post.status = "draft";
    const result = await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE);
    if (!result.handed) expect(result.next).toContain("no Social agent");
    expect(w.outcomes).toHaveLength(1);
  });

  it("lists the post's change requests for the page", async () => {
    const w = approvalWorld({ reviewIssue: "iss-9" });
    await requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE);
    expect(await changeNotesFor(w.ctx, "co", "p1")).toEqual([expect.objectContaining({ stage: "owner", by: "A team member", note: NOTE })]);
  });
});

describe("refused, with the post left as it was", () => {
  async function refused(w: ReturnType<typeof approvalWorld>, run: () => Promise<unknown>, message: string) {
    const before = w.post.status;
    await expect(run()).rejects.toThrow(message);
    expect(w.post.status).toBe(before);
    expect(w.outcomes).toEqual([]);
    expect(w.created).toEqual([]);
  }

  it("no note", async () => {
    const w = approvalWorld();
    await refused(w, () => requestChangesByPerson(w.ctx, PERSON, postRow(w), "  \n "), "Say what has to change");
  });

  it("a note that is too long", async () => {
    const w = approvalWorld();
    await refused(w, () => requestChangesByPerson(w.ctx, PERSON, postRow(w), "x".repeat(2001)), "under 2000");
  });

  it("an agent (the page action is for people)", async () => {
    const w = approvalWorld();
    await refused(w, () => requestChangesRecord(w.ctx, SOCIAL_AGENT, { postId: "p1", notes: NOTE }), "A person must");
  });

  it("a published post", async () => {
    const w = approvalWorld();
    w.post.status = "published";
    await refused(w, () => requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE), "cannot be sent back");
  });

  it("a My Social post", async () => {
    const w = approvalWorld();
    w.post.scope = "personal";
    await refused(w, () => requestChangesByPerson(w.ctx, PERSON, postRow(w), NOTE), "yours alone");
  });
});
