import { describe, expect, it } from "vitest";
import { CLIENT_YES_MISSING } from "../src/approval-audience.js";
import { approveMissing, firstName, namesLine, showApprovalBar } from "../src/detail.js";
import { boot, campaign, CO, issueUpdated, seed, setIssueStatus, setRoles, step, type Harness } from "./helpers/harness.js";

// Plan PAR-9192 rev 2, section 5.1: the approval bar and the client's-yes launch check, one test per remaining state-table row.

const OWNER = { type: "user" as const, userId: "user-owner" };
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
  return issueId;
}

function detail(harness: Harness) {
  return harness.performAction<Record<string, any>>("campaigns.detail", { campaignId: "camp-1" }, { companyId: CO, actor: OWNER });
}

function approve(harness: Harness, params: Record<string, unknown>) {
  return harness.performAction<Record<string, any>>("campaigns.approve", { campaignId: "camp-1", ...params }, { companyId: CO, actor: OWNER });
}

describe("approval bar wording", () => {
  it("Approve is grey on a client campaign until the link and the tick are both filled, and says what is missing", () => {
    const base = { isClient: true, audienceHash: "h", checkErrors: 0 };
    expect(approveMissing({ ...base, yesRef: "", yesSeen: false })).toEqual(["the link to where the client said yes", "the tick that you have seen the client's written yes"]);
    expect(approveMissing({ ...base, yesRef: "https://mail.example/t/1", yesSeen: false })).toEqual(["the tick that you have seen the client's written yes"]);
    expect(approveMissing({ ...base, yesRef: "   ", yesSeen: true })).toEqual(["the link to where the client said yes"]);
    expect(approveMissing({ ...base, yesRef: "https://mail.example/t/1", yesSeen: true })).toEqual([]);
    // An own campaign needs no yes; a check error or an unread audience still stops it.
    expect(approveMissing({ isClient: false, yesRef: "", yesSeen: false, audienceHash: "h", checkErrors: 0 })).toEqual([]);
    expect(approveMissing({ isClient: false, yesRef: "", yesSeen: false, audienceHash: null, checkErrors: 2 })).toEqual(["an audience that can be read (reload the campaign)", "a fix for the 2 check errors"]);
  });

  it("names the first few people and counts the rest", () => {
    expect(firstName("  Anna van der Berg ")).toBe("Anna");
    expect(namesLine(["Anna", "Bob", "Carl"], 500)).toBe("Anna, Bob, Carl and 497 more");
    expect(namesLine(["Anna", "Bob"], 2)).toBe("Anna and Bob");
    expect(namesLine([], 0)).toBe("");
  });
});

describe("approval bar: who can move it, in every state", () => {
  it("draft with no approval: no bar, and Approve is refused", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    const data = await detail(harness);
    expect(showApprovalBar(data.campaign, data.approval)).toBe(false);
    expect(data.audience.willGet).toBe(3);
    expect([...data.audience.firstNames].sort()).toEqual(["Ada", "Bob", "Uma"]);
    await expect(approve(harness, { audienceHash: data.audience.hash })).rejects.toThrow(/No approval is open/);
  });

  it("approval open: the bar has the audience count, first names, current clients and the hash Approve accepts", async () => {
    const store = ownStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await requestApproval(harness, store);
    const data = await detail(harness);
    expect(showApprovalBar(data.campaign, data.approval)).toBe(true);
    expect(data.audience).toMatchObject({ willGet: 3, customers: 1, hash: store.campaigns![0]!.approval_audience_hash });
    expect(data.audience.firstNames).toHaveLength(3);
    expect(data.preflight).toMatchObject({ errors: [] });
    await expect(approve(harness, { audienceHash: data.audience.hash, audienceCount: data.audience.willGet })).resolves.toMatchObject({ launched: true });
  });

  it("client campaign with no yes: the issue marked done by hand does not launch, and the reason shows on the campaign", async () => {
    const store = clientStore();
    const { harness, comments } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const issueId = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, { type: "user", id: "user-owner" });
    expect(store.campaigns![0]).toMatchObject({ status: "draft", launch_error: CLIENT_YES_MISSING });
    expect(store.campaign_enrollments).toHaveLength(0);
    expect(String(comments.mock.calls.at(-1)?.[1])).toMatch(/Marking this issue done does not launch a client's campaign/);
    // The issue is back with a person, and the campaign screen shows the bar with the reason.
    const data = await detail(harness);
    expect(data.campaign.launchError).toBe(CLIENT_YES_MISSING);
    expect(data.campaign.clientYes).toBeNull();
    expect(showApprovalBar(data.campaign, data.approval)).toBe(true);
    // The tool path refuses it too: the one launch path checks the columns.
    const tool = await harness.executeTool<{ error?: string }>("launch-campaign", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(tool.error).toMatch(/approved|Record the client's yes/);
    // Recording the yes on the screen launches it.
    await expect(approve(harness, { audienceHash: data.audience.hash, clientYesRef: "https://mail.example/t/1", clientYesSeen: true })).resolves.toMatchObject({ launched: true });
    expect(store.campaigns![0]).toMatchObject({ status: "active", launch_error: null });
  });

  it("approved, launch failed: the error shows on the campaign, and Launch from the bar launches once it is fixed", async () => {
    const store = ownStore();
    const { harness } = await boot({ store });
    await requestApproval(harness, store);
    const shown = await detail(harness);
    const steps = store.campaign_steps!.splice(0);
    const failed = await approve(harness, { audienceHash: shown.audience.hash });
    expect(failed).toMatchObject({ approved: true, launched: false, error: expect.stringMatching(/at least one step/) });
    const data = await detail(harness);
    expect(data.campaign.launchError).toMatch(/at least one step/);
    expect(showApprovalBar(data.campaign, data.approval)).toBe(true);
    store.campaign_steps!.push(...steps);
    await expect(approve(harness, { audienceHash: data.audience.hash })).resolves.toMatchObject({ launched: true, enrolled: 3 });
    expect(store.campaigns![0]).toMatchObject({ status: "active", launch_error: null });
  });

  it("draft edited after approval: the approval and the client's yes are reset, and the bar goes away", async () => {
    const store = clientStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await requestApproval(harness, store);
    Object.assign(store.campaigns![0]!, { client_yes_ref: "https://mail.example/t/1", client_yes_by: "user-owner", client_yes_at: "2026-11-11T10:00:00Z" });
    expect((await detail(harness)).campaign.clientYes).toMatchObject({ ref: "https://mail.example/t/1", by: "user-owner" });
    await harness.executeTool("add-campaign-step", { campaignId: "camp-1", subject: "Follow up", body: "Any thoughts? Reply STOP to stop these emails.", delayDays: 3 }, { companyId: CO, agentId: "agent-camp" });
    const data = await detail(harness);
    expect(data.campaign).toMatchObject({ approvalIssueId: null, clientYes: null });
    expect(showApprovalBar(data.campaign, data.approval)).toBe(false);
  });
});
