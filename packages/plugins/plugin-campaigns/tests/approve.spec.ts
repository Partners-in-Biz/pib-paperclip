import { describe, expect, it } from "vitest";
import { boot, campaign, CO, contact, issueUpdated, seed, setIssueStatus, setRoles, step, type Harness } from "./helpers/harness.js";

const OWNER = { type: "user" as const, userId: "user-owner" };
const MEMBER = { type: "user" as const, userId: "user-member" };
const AGENT = { type: "agent" as const, agentId: "agent-camp" };

type Store = ReturnType<typeof seed>;

function ownStore(extra: Record<string, unknown> = {}) {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet", ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  return store;
}

function clientStore() {
  const store = ownStore({ audience_tags: [], audience_mode: "client_contacts", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" });
  store.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: null, whatsapp_from: null }];
  return store;
}

async function requestApproval(harness: Harness, store: Store) {
  const result = await harness.executeTool<{ data?: Record<string, unknown>; error?: string }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
  if (!result.data) throw new Error(`request-campaign-approval failed: ${result.error}`);
  const issueId = String(result.data.approvalIssueId);
  const issue = await harness.ctx.issues.get(issueId, CO);
  (store.issues ??= []).push({ id: issueId, status: issue!.status, assignee_agent_id: issue!.assigneeAgentId ?? null, assignee_user_id: issue!.assigneeUserId ?? null, created_at: new Date().toISOString() });
  return { issueId, hash: String(store.campaigns![0]!.approval_audience_hash) };
}

function approve(harness: Harness, actor: Record<string, unknown>, params: Record<string, unknown>) {
  return harness.performAction<Record<string, unknown>>("campaigns.approve", { campaignId: "camp-1", ...params }, { companyId: CO, actor: actor as never });
}

function sendBack(harness: Harness, actor: Record<string, unknown>, note: string) {
  return harness.performAction<Record<string, unknown>>("campaigns.send-back", { campaignId: "camp-1", note }, { companyId: CO, actor: actor as never });
}

describe("campaigns.approve and campaigns.send-back: who may act", () => {
  it("refuses an agent, and a call with no signed-in person", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, AGENT, { audienceHash: hash })).rejects.toThrow(/Only a person/);
    await expect(sendBack(harness, AGENT, "No")).rejects.toThrow(/Only a person/);
    await expect(approve(harness, { type: "user", userId: null }, { audienceHash: hash })).rejects.toThrow(/Sign in as a person/);
    expect(store.campaigns![0]!.status).toBe("draft");
  });

  it("an own campaign: any board member approves (Q5a) and it launches once, as that person", async () => {
    const store = ownStore();
    const { harness, comments } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const { issueId, hash } = await requestApproval(harness, store);
    const result = await approve(harness, MEMBER, { audienceHash: hash });
    expect(result).toMatchObject({ approved: true, launched: true, status: "active", enrolled: 3 });
    expect(store.campaigns![0]).toMatchObject({ status: "active", approved_by_user_id: "user-member" });
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ status: "done", assigneeAgentId: null, assigneeUserId: "user-member" });
    // The plugin's own done update (as the host would emit it) launches nothing more (F3).
    await issueUpdated(harness, issueId, { type: "plugin", id: "partnersinbiz.campaigns" });
    expect(store.campaign_enrollments).toHaveLength(3);
    expect(comments.mock.calls.filter(([id, body]) => id === issueId && String(body).startsWith("Launched"))).toHaveLength(1);
  });

  it("an own campaign that reaches a current client: only the owner (Q7)", async () => {
    const store = ownStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow(/reaches 1 current client, so only the company owner/);
    await expect(sendBack(harness, MEMBER, "No")).rejects.toThrow(/only the company owner/);
    expect(store.campaigns![0]!.status).toBe("draft");
    await expect(approve(harness, OWNER, { audienceHash: hash })).resolves.toMatchObject({ launched: true });
  });

  it("a client campaign: a non-owner is refused, no known owner is refused with the reason", async () => {
    const store = clientStore();
    const { harness } = await boot({ store });
    const { hash } = await requestApproval(harness, store);
    const yes = { audienceHash: hash, clientYesRef: "https://mail.example/thread/1", clientYesSeen: true };
    await expect(approve(harness, MEMBER, yes)).rejects.toThrow(/no company owner is known/);
    await setRoles(harness, { ownerUserId: "user-owner" });
    await expect(approve(harness, MEMBER, yes)).rejects.toThrow(/a client's campaign, so only the company owner/);
    expect(store.campaigns![0]!.status).toBe("draft");
  });

  it("a client campaign: the owner records the client's yes, then it launches", async () => {
    const store = clientStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, OWNER, { audienceHash: hash, clientYesRef: "https://mail.example/thread/1" })).rejects.toThrow(/Record the client's yes/);
    await expect(approve(harness, OWNER, { audienceHash: hash, clientYesSeen: true })).rejects.toThrow(/Record the client's yes/);
    expect(store.campaigns![0]!.status).toBe("draft");
    await expect(approve(harness, OWNER, { audienceHash: hash, clientYesRef: "https://mail.example/thread/1", clientYesSeen: true })).resolves.toMatchObject({ launched: true });
    expect(store.campaigns![0]).toMatchObject({ status: "active", client_yes_ref: "https://mail.example/thread/1", client_yes_by: "user-owner" });
  });
});

describe("campaigns.approve: the issue's state and the audience", () => {
  it("launches when the approval issue is blocked and held by an agent (PAR-5821)", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true, ownerUserId: "user-owner" });
    const { issueId, hash } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "blocked", { assigneeAgentId: "agent-reviewer", assigneeUserId: null });
    await expect(approve(harness, OWNER, { audienceHash: hash })).resolves.toMatchObject({ launched: true });
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ status: "done", assigneeAgentId: null, assigneeUserId: "user-owner" });
  });

  it("refuses a stale hash with both counts, and launches with the hash of what the screen shows now", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    const { hash } = await requestApproval(harness, store);
    store.crm_contacts!.push(contact("dan", "Dan New", ["dan@new.test"], { tags: ["vip"] }));
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow("The audience changed since you looked (3, now 4). Look again.");
    expect(store.campaigns![0]!.status).toBe("draft");
    await expect(approve(harness, MEMBER, { audienceHash: "0".repeat(64), audienceCount: 12 })).rejects.toThrow("(12, now 4)");
    // The screen reloads and shows the new audience: approving that one launches to all four.
    const { approvalAudience } = await import("../src/approval-audience.js");
    const { getCampaign, listSteps } = await import("../src/db.js");
    const now = await approvalAudience(harness.ctx, CO, (await getCampaign(harness.ctx, "camp-1"))!, await listSteps(harness.ctx, "camp-1"));
    await expect(approve(harness, MEMBER, { audienceHash: now.hash })).resolves.toMatchObject({ launched: true, enrolled: 4 });
  });

  it("an issue marked done by hand after the audience grew does not launch, and says why", async () => {
    const store = ownStore();
    const { harness, comments } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    store.crm_contacts!.push(contact("dan", "Dan New", ["dan@new.test"], { tags: ["vip"] }));
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, { type: "user", id: "user-peet" });
    expect(store.campaigns![0]).toMatchObject({ status: "draft", launch_error: "The audience changed since you looked (3, now 4). Look again." });
    expect(store.campaign_enrollments).toHaveLength(0);
    expect(String(comments.mock.calls.at(-1)?.[1])).toContain("The audience changed since you looked (3, now 4)");
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ status: "todo", assigneeUserId: "user-peet" });
  });

  it("an approval opened before the audience columns (no stored hash) still launches when marked done", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    store.campaigns![0]!.approval_audience_hash = null;
    store.campaigns![0]!.approval_audience_count = null;
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, { type: "user", id: "user-peet" });
    expect(store.campaigns![0]!.status).toBe("active");
  });

  it("does not launch twice: two calls in a row, and two at once", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    const { hash } = await requestApproval(harness, store);
    await approve(harness, MEMBER, { audienceHash: hash });
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow(/is active, not a draft/);
    expect(store.campaign_enrollments).toHaveLength(3);

    const second = ownStore();
    const booted = await boot({ store: second });
    const req = await requestApproval(booted.harness, second);
    const results = await Promise.allSettled([approve(booted.harness, MEMBER, { audienceHash: req.hash }), approve(booted.harness, OWNER, { audienceHash: req.hash })]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.launched === true)).toHaveLength(1);
    expect(second.campaign_enrollments).toHaveLength(3);
  });
});

describe("campaigns.send-back", () => {
  it("needs a note; then comments it, cancels the issue and opens the Revise issue", async () => {
    const store = ownStore();
    const { harness, comments } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    await expect(sendBack(harness, MEMBER, "  ")).rejects.toThrow(/a note is required/);
    const result = await sendBack(harness, MEMBER, "Drop the discount line.");
    expect(result).toMatchObject({ sentBack: true, approvalIssueId: issueId });
    expect(comments.mock.calls.some(([id, body]) => id === issueId && body === "Sent back: Drop the discount line.")).toBe(true);
    expect((await harness.ctx.issues.get(issueId, CO))!.status).toBe("cancelled");
    expect(store.campaigns![0]).toMatchObject({ status: "draft", approval_issue_id: null });
    const revise = (await harness.ctx.issues.list({ companyId: CO })).filter((row) => row.title.startsWith("Revise campaign"));
    expect(revise).toHaveLength(1);
    expect(revise[0]).toMatchObject({ assigneeAgentId: "agent-camp", originId: `campaigns:revise:camp-1:${issueId}` });
    // Nothing left to approve or send back.
    await expect(sendBack(harness, MEMBER, "Again")).rejects.toThrow(/No approval is open/);
  });
});
