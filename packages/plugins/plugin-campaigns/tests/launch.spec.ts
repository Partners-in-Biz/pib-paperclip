import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { ALL_CONTACTS_MARK, audienceLine, enrollmentStart, isEveryContact } from "../src/domain.js";
import { approvalWaiting, AGENT_HOLD_MS } from "../src/cockpit.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";
import { boot, campaign, CO, enrollment, issueUpdated, PAST, seed, seedIssue, setIssueStatus, setRoles, step } from "./helpers/harness.js";

const PERSON = { type: "user" as const, id: "user-peet" };
const REVIEWER = { type: "agent" as const, id: "agent-reviewer" };

function draftStore(extra: Record<string, unknown> = {}) {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet", ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  return store;
}

async function requestApproval(harness: Awaited<ReturnType<typeof boot>>["harness"], store: ReturnType<typeof seed>) {
  const result = await harness.executeTool<{ data: Record<string, any> }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
  const issueId = String(result.data.approvalIssueId);
  const issue = await harness.ctx.issues.get(issueId, CO);
  (store.issues ??= []).push({ id: issueId, status: issue!.status, assignee_agent_id: issue!.assigneeAgentId ?? null, assignee_user_id: issue!.assigneeUserId ?? null, created_at: new Date().toISOString() });
  return { result: result.data, issueId, issue: issue! };
}

describe("campaigns 011 migration", () => {
  const sql = readFileSync(new URL("../migrations/011_campaigns.sql", import.meta.url), "utf8");
  it("passes the host migration guard and has no quotes in comments", () => {
    for (const statement of splitSqlStatements(sql)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).toContain("CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual'))");
    expect(sql).toContain("ADD COLUMN launch_error text");
    expect(sql).not.toMatch(/\bdelete\b/i);
  });
});

describe("audience wording", () => {
  it("names every audience with its count and marks all contacts", () => {
    const base = { audienceMode: "tags" as const, audienceTags: [] as string[], clientKind: null, clientRef: null, clientName: null };
    expect(audienceLine(base, 42)).toBe(`${ALL_CONTACTS_MARK}42)`);
    expect(isEveryContact(base)).toBe(true);
    expect(isEveryContact(base, ["ada"])).toBe(false);
    expect(audienceLine({ ...base, audienceTags: ["vip"] }, 3)).toBe("Contacts tagged `vip` (3)");
    expect(isEveryContact({ ...base, audienceTags: ["vip"] })).toBe(false);
    const client = { ...base, audienceMode: "client_contacts" as const, clientKind: "company" as const, clientRef: "acme", clientName: "Acme" };
    expect(audienceLine(client, 5)).toBe("Contacts at Acme (5)");
    expect(audienceLine({ ...base, audienceMode: "client_contact" as const, clientKind: "contact" as const, clientRef: "ada", clientName: "Ada" }, 1)).toBe("Ada only (1)");
  });

  it("never starts before the start date", () => {
    const now = new Date("2026-09-27T10:00:00Z");
    expect(enrollmentStart(now, null)).toBe(now);
    expect(enrollmentStart(now, "2026-09-01T00:00:00Z")).toBe(now);
    expect(enrollmentStart(now, "2026-10-01T08:00:00Z").toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });
});

describe("approval request", () => {
  it("states the audience with its count, the rules and the steps, and goes to the approver without a Reviewer", async () => {
    const store = draftStore();
    store.suppressions!.push({ company_id: CO, email: "uma@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.crm", contact_id: null, campaign_id: null });
    const { harness } = await boot({ store });
    const { result, issue } = await requestApproval(harness, store);
    expect(result).toMatchObject({ audience: "Contacts tagged `vip` (3)", willGet: 2, leftOut: 1, routedTo: "approver" });
    expect(issue.assigneeUserId).toBe("user-peet");
    expect(issue.assigneeAgentId ?? null).toBeNull();
    expect(issue.description).toContain("launches by itself");
    expect(issue.description).toContain("1 unsubscribed or bounced address is left out, so 2 get it");
    expect(issue.description).toContain("how to opt out");
    expect(issue.description).toContain("Hi {{first_name|there}}");
    // The approver can open the detail view: every email, who gets it and when.
    expect(issue.description).toContain("[camp-1](/PIB/campaigns?campaign=camp-1)");
  });

  it("says All contacts (N) when there are no tags, and refuses a campaign without steps", async () => {
    const store = draftStore({ audience_tags: [] });
    const { harness } = await boot({ store });
    const { issue } = await requestApproval(harness, store);
    expect(issue.description).toContain(`**Audience:** ${ALL_CONTACTS_MARK}4)`);

    store.campaigns!.push(campaign("camp-empty", { status: "draft" }));
    const empty = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-empty" }, { companyId: CO, agentId: "agent-camp" });
    expect(empty.error).toMatch(/at least one step/);
  });

  it("editing the draft after asking cancels that approval; asking again opens a new one", async () => {
    const store = draftStore();
    const { harness, comments } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    const added = await harness.executeTool<{ data: Record<string, any> }>("add-campaign-step", { campaignId: "camp-1", subject: "Follow up", body: "Any thoughts?", delayDays: 3 }, { companyId: CO, agentId: "agent-camp" });
    expect(added.data.approvalReset).toBe(true);
    expect((await harness.ctx.issues.get(issueId, CO))!.status).toBe("cancelled");
    expect(comments.mock.calls.some(([id, body]) => id === issueId && /step 2 was added/.test(String(body)))).toBe(true);
    expect(store.campaigns![0]!.approval_issue_id).toBeNull();

    // A change that does not touch what the approver saw keeps the new approval.
    const { issueId: second } = await requestApproval(harness, store);
    const renamed = await harness.executeTool<{ data: Record<string, any> }>("update-campaign", { campaignId: "camp-1", description: "internal note" }, { companyId: CO, agentId: "agent-camp" });
    expect(renamed.data.approvalReset).toBe(false);
    const retagged = await harness.executeTool<{ data: Record<string, any> }>("update-campaign", { campaignId: "camp-1", audienceTags: [] }, { companyId: CO, agentId: "agent-camp" });
    expect(retagged.data.approvalReset).toBe(true);
    expect((await harness.ctx.issues.get(second, CO))!.status).toBe("cancelled");
  });
});

describe("launch on approval", () => {
  it("a person marking the approval done launches it, leaves out suppressed addresses and comments the result", async () => {
    const store = draftStore();
    store.suppressions!.push({ company_id: CO, email: "uma@x.test", reason: "bounce", scope: "all", source: "partnersinbiz.mailbox", contact_id: null, campaign_id: null });
    const { harness, comments } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, PERSON);
    expect(store.campaigns![0]).toMatchObject({ status: "active", approved_by_user_id: "user-peet", launch_error: null });
    expect(store.campaign_enrollments!.map((row) => row.contact_id).sort()).toEqual(["ada", "bob"]);
    expect(comments.mock.calls.find(([id]) => id === issueId)?.[1]).toBe("Launched: 2 contacts enrolled (1 left out (unsubscribed or bounced)).");
    // The event arriving twice launches once.
    await issueUpdated(harness, issueId, PERSON);
    expect(store.campaign_enrollments).toHaveLength(2);
  });

  it("an approval closed by an agent goes back to a person and does not launch", async () => {
    const store = draftStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true, ownerUserId: "user-owner" });
    const { issueId, issue } = await requestApproval(harness, store);
    expect(issue.assigneeAgentId).toBe("agent-reviewer");
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, REVIEWER);
    expect(store.campaigns![0]!.status).toBe("draft");
    // The company owner (roles) decides; the creating person is only the fallback.
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-owner" });
  });

  it("a person approving while the Reviewer still holds the issue still launches", async () => {
    const store = draftStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewOutward: true });
    const { issueId } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, PERSON);
    expect(store.campaigns![0]!.status).toBe("active");
  });

  it("when it cannot launch, the approval goes back to the person with the reason", async () => {
    const store = draftStore({ audience_tags: [], audience_mode: "client_contact", client_kind: "contact", client_ref: "ghost", client_name: "Ghost Person" });
    // A client's email needs its own sender before anything else is checked.
    store.sender_identities = [{ company_id: CO, sender_key: "contact:ghost", from_address: "ghost@client.test", from_name: "Ghost Person", reply_to: null, sms_from: null, whatsapp_from: null }];
    const { harness, comments } = await boot({ store });
    const issueId = "appr-x";
    seedIssue(harness, store, { id: issueId, status: "todo", assigneeUserId: "user-peet", description: "approve" });
    store.campaigns![0]!.approval_issue_id = issueId;
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, PERSON);
    expect(store.campaigns![0]).toMatchObject({ status: "draft" });
    expect(store.campaigns![0]!.launch_error).toMatch(/not in the Campaigns contact list yet/);
    expect(await harness.ctx.issues.get(issueId, CO)).toMatchObject({ status: "todo", assigneeUserId: "user-peet" });
    expect(String(comments.mock.calls.at(-1)?.[1])).toMatch(/^Approved, but the campaign could not launch/);
  });

  it("every contact launches only when the approval said All contacts (N)", async () => {
    const store = draftStore({ audience_tags: [] });
    const { harness } = await boot({ store });
    seedIssue(harness, store, { id: "appr-old", status: "done", description: "Audience: contacts tagged `vip` (3)" });
    store.campaigns![0]!.approval_issue_id = "appr-old";
    await issueUpdated(harness, "appr-old", PERSON);
    expect(store.campaigns![0]!.status).toBe("draft");
    expect(store.campaigns![0]!.launch_error).toMatch(/would email every CRM contact \(4\)/);
  });

  it("a person cancelling refuses it: the draft is free again and its agent gets a revise task", async () => {
    const store = draftStore();
    const { harness } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "cancelled");
    await issueUpdated(harness, issueId, PERSON);
    expect(store.campaigns![0]!.approval_issue_id).toBeNull();
    const revise = (await harness.ctx.issues.list({ companyId: CO })).find((row) => row.title.startsWith("Revise campaign"));
    expect(revise).toMatchObject({ assigneeAgentId: "agent-camp", originId: `campaigns:revise:${store.campaigns![0]!.id}:${issueId}` });
    expect(revise!.description).toContain("request-campaign-approval");
  });

  it("our own updates never launch or reopen", async () => {
    const store = draftStore();
    const { harness } = await boot({ store });
    const { issueId } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "done");
    await issueUpdated(harness, issueId, { type: "plugin", id: "partnersinbiz.campaigns" });
    expect(store.campaigns![0]!.status).toBe("draft");
  });

  it("the sweep launches an approval whose event was missed, and hands an agent-closed one to a person", async () => {
    const store = draftStore();
    store.campaigns!.push(campaign("camp-2", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet", approval_issue_id: "appr-agent" }));
    store.campaign_steps!.push(step("camp-2", 1, "a", "Hello", "Body"));
    const { harness } = await boot({ store });
    seedIssue(harness, store, { id: "appr-person", status: "done", assigneeUserId: "user-peet" });
    seedIssue(harness, store, { id: "appr-agent", status: "done", assigneeAgentId: "agent-reviewer" });
    store.campaigns![0]!.approval_issue_id = "appr-person";
    await harness.runJob("open-due-steps");
    expect(store.campaigns!.find((row) => row.id === "camp-1")).toMatchObject({ status: "active", approved_by_user_id: "user-peet" });
    expect(store.campaigns!.find((row) => row.id === "camp-2")!.status).toBe("draft");
    expect(await harness.ctx.issues.get("appr-agent", CO)).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-peet" });
  });

  it("launch-campaign still refuses a draft without a person's approval", async () => {
    const store = draftStore();
    const { harness } = await boot({ store });
    const tool = await harness.executeTool<{ error?: string }>("launch-campaign", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(tool.error).toMatch(/Request approval first/);
  });
});

describe("step issues", () => {
  function issueStore() {
    const store = seed();
    store.campaigns!.push(campaign("camp-i", { delivery: "issue", owner_agent_id: "agent-gone" }));
    store.campaign_steps!.push(step("camp-i", 1, "a", "Hi {{first_name}}", "Hello {{first_name}} at {{company}}"), step("camp-i", 2, "a", "Again", "Second", 2));
    store.campaign_enrollments!.push(enrollment("e-ada", "camp-i", "ada", { next_due_at: PAST }));
    return store;
  }

  it("go to the Account Manager when the creator agent is gone, filled in for the contact", async () => {
    const store = issueStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner", team: { "account-manager": { agentId: "agent-am", status: "idle" } } });
    await harness.runJob("open-due-steps");
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue).toMatchObject({ title: "Hi Ada: Ada Lovelace", assigneeAgentId: "agent-am" });
    expect(issue!.description).toContain("Hello Ada at Acme Plumbing");
    expect(issue!.description).toContain("mark this issue **done**");
  });

  it("fall back to the owner when no agent can take them", async () => {
    const store = issueStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await harness.runJob("open-due-steps");
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue).toMatchObject({ assigneeUserId: "user-owner" });
  });

  it("a closed step issue we did not hear about still moves the contact on; a cancelled one stops them", async () => {
    const store = seed();
    store.campaigns!.push(campaign("camp-i", { delivery: "issue" }));
    store.campaign_steps!.push(step("camp-i", 1, "a", "One", "1"), step("camp-i", 2, "a", "Two", "2", 2));
    store.campaign_enrollments!.push(
      enrollment("e-done", "camp-i", "ada", { open_issue_id: "iss-done" }),
      enrollment("e-cancel", "camp-i", "bob", { open_issue_id: "iss-cancel" }),
    );
    const { harness } = await boot({ store });
    seedIssue(harness, store, { id: "iss-done", status: "done" });
    seedIssue(harness, store, { id: "iss-cancel", status: "cancelled" });
    await harness.runJob("open-due-steps");
    expect(store.campaign_enrollments!.find((row) => row.id === "e-done")).toMatchObject({ status: "running", step_position: 2, open_issue_id: null });
    expect(store.campaign_enrollments!.find((row) => row.id === "e-cancel")).toMatchObject({ status: "stopped", open_issue_id: null });
  });

  it("are never opened for a suppressed address", async () => {
    const store = issueStore();
    store.suppressions!.push({ company_id: CO, email: "ada@acme.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.crm", contact_id: null, campaign_id: null });
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);
    expect(store.campaign_enrollments![0]!.status).toBe("stopped");
  });
});

describe("cockpit waiting items", () => {
  const row = (extra: Record<string, unknown>) => ({
    id: "c1", name: "Spring", client_name: null, client_ref: null, approval_issue_id: "iss-1", launch_error: null,
    issue_status: "todo", issue_agent_id: null, created_at: new Date().toISOString(), updated_at: null, ...extra,
  });

  it("shows open approvals, approved-but-not-launched campaigns, and approvals an agent held too long", () => {
    const now = Date.now();
    const old = new Date(now - AGENT_HOLD_MS - 60_000).toISOString();
    const items = approvalWaiting([
      row({}),
      row({ id: "c2", approval_issue_id: "iss-2", issue_status: "done" }),
      row({ id: "c3", approval_issue_id: "iss-3", issue_agent_id: "agent-reviewer" }),
      row({ id: "c4", approval_issue_id: "iss-4", issue_agent_id: "agent-reviewer", created_at: old }),
      row({ id: "c5", approval_issue_id: "iss-5", launch_error: "The client contact is not in the list yet." }),
    ], now);
    expect(items.map((item) => item.key)).toEqual(["approval:iss-1", "launch:c2", "approval:iss-4", "approval:iss-5"]);
    expect(items[1]).toMatchObject({ title: "Launch approved campaign Spring", kind: "review" });
    expect(items[2]!.why).toMatch(/held this launch approval for over a day/);
    expect(items[3]!.why).toMatch(/could not launch after the last approval/);
  });
});
