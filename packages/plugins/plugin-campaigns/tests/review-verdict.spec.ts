import { describe, expect, it } from "vitest";
import { approvalWaiting } from "../src/cockpit.js";
import { boot, campaign, CO, seed, setRoles, step, type Harness } from "./helpers/harness.js";

const REVIEWER = "agent-reviewer";

function ownStore(extra: Record<string, unknown> = {}) {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet", ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  return store;
}

async function withReviewer(store: ReturnType<typeof seed>) {
  const booted = await boot({ store, agents: [{ id: "agent-camp", status: "idle" }, { id: REVIEWER, status: "idle" }] });
  await setRoles(booted.harness, { reviewerAgentId: REVIEWER, reviewerStatus: "idle", reviewOutward: true, ownerUserId: "user-owner" });
  const asked = await booted.harness.executeTool<{ data?: Record<string, unknown>; error?: string }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
  if (!asked.data) throw new Error(`request-campaign-approval failed: ${asked.error}`);
  const issueId = String(asked.data.approvalIssueId);
  expect((await booted.harness.ctx.issues.get(issueId, CO))?.assigneeAgentId).toBe(REVIEWER);
  return { ...booted, issueId };
}

function verdict(harness: Harness, agentId: string | null, params: Record<string, unknown>) {
  return harness.executeTool<{ data?: Record<string, unknown>; error?: string }>(
    "review-campaign-approval",
    { campaignId: "camp-1", ...params },
    { companyId: CO, ...(agentId ? { agentId } : {}) } as never,
  );
}

describe("review-campaign-approval (the Reviewer's verdict)", () => {
  it("refuses an agent that is not the Reviewer, and leaves the approval as it was", async () => {
    const store = ownStore();
    const { harness, issueId } = await withReviewer(store);
    const refused = await verdict(harness, "agent-camp", { verdict: "pass", note: "Looks fine" });
    expect(refused.error).toMatch(/Only the company's Reviewer agent/);
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ assigneeAgentId: REVIEWER, status: "todo" });
    expect(store.campaigns![0]!.status).toBe("draft");
  });

  it("refuses every agent when the company has no Reviewer", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const refused = await verdict(harness, REVIEWER, { verdict: "pass", note: "Fine" });
    expect(refused.error).toMatch(/Only the company's Reviewer agent/);
  });

  it("pass: comments the note, the person holds the issue with no agent, and it waits on the person at once", async () => {
    const store = ownStore();
    const { harness, comments, issueId } = await withReviewer(store);
    expect((await verdict(harness, REVIEWER, { verdict: "pass" })).error).toMatch(/Add a note/);
    const result = await verdict(harness, REVIEWER, { verdict: "pass", note: "Copy, links and audience checked." });
    expect(result.data).toMatchObject({ verdict: "pass", assignedToUserId: "user-owner" });
    const issue = await harness.ctx.issues.get(issueId, CO);
    expect(issue).toMatchObject({ assigneeAgentId: null, assigneeUserId: "user-owner" });
    expect(issue!.status).not.toBe("done");
    expect(comments.mock.calls.some(([id, body]) => id === issueId && String(body).startsWith("Reviewer pass: Copy, links and audience checked."))).toBe(true);
    expect(store.campaigns![0]!.status).toBe("draft");
    // The Cockpit's existing row: no agent on the issue, created a minute ago, so it shows now (not after 24 h).
    const now = Date.now();
    const waiting = approvalWaiting([{
      id: "camp-1", name: "Spring", client_name: null, client_ref: null, approval_issue_id: issueId, launch_error: null,
      issue_status: issue!.status, issue_agent_id: issue!.assigneeAgentId ?? null, created_at: new Date(now - 60_000).toISOString(), updated_at: null,
    }], now);
    expect(waiting.map((item) => item.key)).toEqual([`approval:${issueId}`]);
    // A second verdict: the approval is no longer with the Reviewer.
    expect((await verdict(harness, REVIEWER, { verdict: "changes", note: "Wait" })).error).toMatch(/not with you any more/);
  });

  it("pass on a campaign that reaches a current client goes to the company owner (Q7)", async () => {
    const store = ownStore({ owner_user_id: "user-member" });
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness, issueId } = await withReviewer(store);
    await verdict(harness, REVIEWER, { verdict: "pass", note: "OK" });
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ assigneeAgentId: null, assigneeUserId: "user-owner" });
  });

  it("changes: cancels the approval issue and opens the Revise issue, as Send back does", async () => {
    const store = ownStore();
    const { harness, comments, issueId } = await withReviewer(store);
    const result = await verdict(harness, REVIEWER, { verdict: "changes", note: "Step 1 has no unsubscribe line." });
    expect(result.data).toMatchObject({ verdict: "changes", sentBack: true, approvalIssueId: issueId });
    expect((await harness.ctx.issues.get(issueId, CO))?.status).toBe("cancelled");
    expect(comments.mock.calls.some(([id, body]) => id === issueId && String(body).includes("Step 1 has no unsubscribe line."))).toBe(true);
    const revise = (await harness.ctx.issues.list({ companyId: CO })).filter((row) => row.title.startsWith("Revise campaign"));
    expect(revise).toHaveLength(1);
    expect(revise[0]).toMatchObject({ assigneeAgentId: "agent-camp" });
    expect(store.campaigns![0]!.status).toBe("draft");
  });
});
