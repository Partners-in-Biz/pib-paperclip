/**
 * The company graph for Campaigns: stable `campaigns:<kind>:…` origin ids,
 * the done checks on every kind of work it hands to agents (reopen, pass,
 * finished another way), the `log-reply` tool, the skill line and the
 * `campaign.running` report.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDoneCheck } from "@partnersinbiz/pib-plugin-kit";
import { runningReport } from "../src/cockpit.js";
import { CAMPAIGN_DONE_CHECKS, checkReply } from "../src/donechecks.js";
import { NAMESPACE } from "../src/namespace.js";
import { parsePairOrigin, parseStepOrigin, CAMPAIGN_ORIGINS } from "../src/origins.js";
import { CAMPAIGN_SKILL } from "../src/skills.js";
import { CAMPAIGN_TOOLS } from "../src/tools.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";
import { boot, campaign, CO, enrollment, issueUpdated, PAST, seed, setIssueStatus, step, type Harness } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

const AGENT = { type: "agent" as const, id: "agent-camp" };
const PERSON = { type: "user" as const, id: "user-peet" };
const RUN = { companyId: CO, agentId: "agent-camp" };
const MAILBOX = "plugin.partnersinbiz.mailbox";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function tool<T = Record<string, any>>(harness: Harness, name: string, params: Record<string, unknown>): Promise<T> {
  const result = await harness.executeTool<{ data?: T; error?: string }>(name, params, RUN);
  if (result.error) throw new Error(result.error);
  return result.data as T;
}

/** The agent marks the issue done; the host then sends issue.updated. */
async function agentCloses(harness: Harness, store: Store, issueId: string, actor: { type: "agent" | "user"; id: string } = AGENT) {
  await setIssueStatus(harness, store, issueId, "done");
  await issueUpdated(harness, issueId, actor);
  return (await harness.ctx.issues.get(issueId, CO))!;
}

/** Comments the plugin wrote on an issue (the harness spies on createComment). */
function commentsOn(booted: { comments: { mock: { calls: unknown[][] } } }, issueId: string): string[] {
  return booted.comments.mock.calls.filter((call) => call[0] === issueId).map((call) => String(call[1]));
}

describe("origins and surface", () => {
  it("parses step and pair origin ids", () => {
    expect(parseStepOrigin("campaigns:step:e-1:2", CAMPAIGN_ORIGINS.step)).toEqual({ enrollmentId: "e-1", position: 2 });
    expect(parseStepOrigin("campaigns:step:e-1", CAMPAIGN_ORIGINS.step)).toBeNull();
    expect(parseStepOrigin("e-1", CAMPAIGN_ORIGINS.step)).toBeNull();
    expect(parsePairOrigin("campaigns:reply:e-1:msg:with:colons", CAMPAIGN_ORIGINS.reply)).toEqual({ id: "e-1", rest: "msg:with:colons" });
    expect(parsePairOrigin("reply:msg", CAMPAIGN_ORIGINS.reply)).toBeNull();
  });

  it("every rule is namespaced so it never matches the CRM's reply: or send-failed: issues", () => {
    for (const rule of CAMPAIGN_DONE_CHECKS) expect(rule.originPrefix.startsWith("campaigns:")).toBe(true);
    expect(CAMPAIGN_DONE_CHECKS.map((r) => r.originPrefix)).not.toContain(CAMPAIGN_ORIGINS.approval);
  });

  it("log-reply is described with a fixed outcome, and the skill says closes are checked", () => {
    const logReply = CAMPAIGN_TOOLS.find((t) => t.name === "log-reply")!;
    const schema = logReply.parametersSchema as { required: string[]; properties: Record<string, { enum?: string[]; description?: string }> };
    expect(schema.required).toEqual(["messageId", "outcome", "note"]);
    expect(schema.properties.outcome!.enum).toEqual(["answered", "no-reply-needed"]);
    expect(CAMPAIGN_SKILL).toContain("When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.");
    expect(CAMPAIGN_SKILL).toContain("`log-reply`");
  });

  it("the 012 migration passes the host guard with no quotes in comments", () => {
    const sql = readFileSync(new URL("../migrations/012_campaigns.sql", import.meta.url), "utf8");
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE)).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).toContain("ADD COLUMN edited_at timestamptz");
    expect(sql).toContain("CHECK (outcome IN ('answered', 'no-reply-needed'))");
  });

  it("campaign.running counts active campaigns and those with stuck sends", () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(runningReport(2, [])).toEqual({ stage: "campaign.running", count: 2, stuck: 0, stuckReason: null, oldestDays: null });
    expect(runningReport(3, [
      { campaign_id: "a", failed: "2", waiting: "0", oldest: old },
      { campaign_id: "b", failed: "0", waiting: "1", oldest: new Date().toISOString() },
      { campaign_id: "c", failed: "0", waiting: "0", oldest: null },
    ])).toEqual({ stage: "campaign.running", count: 3, stuck: 2, stuckReason: "2 failed sends, 1 send waiting over a day", oldestDays: 3 });
  });
});

describe("step issues", () => {
  function stepStore(): Store {
    const store = seed();
    store.campaigns!.push(campaign("camp-issue", { delivery: "issue" }));
    store.campaign_steps!.push(step("camp-issue", 1, "a", "Hello {{first_name}}", "Body"), step("camp-issue", 2, "a", "Follow up", "Body 2", 3));
    store.campaign_enrollments!.push(enrollment("e-ada", "camp-issue", "ada", { next_due_at: PAST }));
    return store;
  }

  async function openStep() {
    const store = stepStore();
    const booted = await boot({ store });
    const { harness } = booted;
    await harness.runJob("open-due-steps");
    const issueId = store.campaign_enrollments![0]!.open_issue_id as string;
    const issue = (await harness.ctx.issues.get(issueId, CO))!;
    expect(issue.originId).toBe("campaigns:step:e-ada:1");
    (store.issues ??= []).push({ id: issueId, status: "todo", assignee_agent_id: issue.assigneeAgentId, created_at: new Date().toISOString() });
    return { harness, store, issueId, booted };
  }

  it("closing the step issue moves the contact on, so the check passes", async () => {
    const { harness, store, issueId, booted } = await openStep();
    const issue = await agentCloses(harness, store, issueId);
    expect(issue.status).toBe("done");
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2, open_issue_id: null });
    expect(commentsOn(booted, issueId).join("\n")).not.toContain("Not done yet");
  });

  it("reopens when the close did not move the contact on", async () => {
    const { harness, store, issueId, booted } = await openStep();
    // The issue is done but the plugin's own handler has not moved the contact (it failed).
    await setIssueStatus(harness, store, issueId, "done");
    expect(await runDoneCheck(harness.ctx, CAMPAIGN_DONE_CHECKS, { entityId: issueId, companyId: CO, actorType: "agent" })).toBe("reopened");
    expect((await harness.ctx.issues.get(issueId, CO))!.status).toBe("todo");
    expect(commentsOn(booted, issueId).at(-1)).toContain('- Ada Lovelace is still on step 1 of campaign "camp-issue": closing this issue should move them on.');
    // Closing it again runs the handler: the contact moves on and the check passes.
    expect((await agentCloses(harness, store, issueId)).status).toBe("done");
  });

  it("passes when the contact was stopped instead", async () => {
    const { harness, store, issueId } = await openStep();
    await tool(harness, "stop-enrollment", { enrollmentId: "e-ada" });
    await setIssueStatus(harness, store, issueId, "done");
    expect(await runDoneCheck(harness.ctx, CAMPAIGN_DONE_CHECKS, { entityId: issueId, companyId: CO, actorType: "agent" })).toBe("passed");
  });

  it("a failed send's issue is checked the same way", async () => {
    const store = seed();
    store.campaigns!.push(campaign("camp-mail"));
    store.campaign_steps!.push(step("camp-mail", 1, "a", "Hi", "Body"), step("camp-mail", 2, "a", "Again", "Body"));
    store.campaign_enrollments!.push(enrollment("e-bob", "camp-mail", "bob", { next_due_at: PAST, sending_key: "campaigns:step:e-bob:1" }));
    store.outbox!.push({ key: "campaigns:step:e-bob:1", company_id: CO, event: "mail.send.requested", payload: {}, status: "failed", attempts: 9, last_error: "Gmail not connected", result: null });
    const { harness } = await boot({ store, config: { timezone: "Africa/Johannesburg", jev: undefined } });
    await harness.runJob("redeliver-mail");
    const issueId = store.campaign_enrollments![0]!.open_issue_id as string;
    expect((await harness.ctx.issues.get(issueId, CO))!.originId).toBe("campaigns:send-failed:e-bob:1");
    await setIssueStatus(harness, store, issueId, "done");
    expect(await runDoneCheck(harness.ctx, CAMPAIGN_DONE_CHECKS, { entityId: issueId, companyId: CO, actorType: "agent" })).toBe("reopened");
    expect((await agentCloses(harness, store, issueId)).status).toBe("done");
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2 });
  });
});

describe("Revise campaign", () => {
  function draftStore(): Store {
    const store = seed();
    store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], owner_user_id: "user-peet" }));
    store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello. Reply STOP to stop these emails."));
    return store;
  }

  async function refused() {
    const store = draftStore();
    const booted = await boot({ store });
    const { harness } = booted;
    const asked = await tool(harness, "request-campaign-approval", { campaignId: "camp-1" });
    const approvalId = String(asked.approvalIssueId);
    expect((await harness.ctx.issues.get(approvalId, CO))!.originId).toBe("campaigns:approval:camp-1");
    (store.issues ??= []).push({ id: approvalId, status: "todo", created_at: new Date().toISOString() });
    await setIssueStatus(harness, store, approvalId, "cancelled");
    await issueUpdated(harness, approvalId, PERSON);
    const revise = (await harness.ctx.issues.list({ companyId: CO })).find((row) => row.title.startsWith("Revise campaign"))!;
    expect(revise.originId).toBe(`campaigns:revise:camp-1:${approvalId}`);
    (store.issues ??= []).push({ id: revise.id, status: "todo", created_at: new Date().toISOString() });
    await tick();
    return { harness, store, reviseId: revise.id, booted };
  }

  it("reopens until the draft changed and approval is asked again", async () => {
    const { harness, store, reviseId, booted } = await refused();
    expect((await agentCloses(harness, store, reviseId)).status).toBe("todo");
    let last = commentsOn(booted, reviseId).at(-1)!;
    expect(last).toContain('Campaign "camp-1" has not changed since its approval was refused');
    expect(last).toContain('Campaign "camp-1" has no new approval: `request-campaign-approval` (campaignId `camp-1`)');

    await tool(harness, "update-campaign", { campaignId: "camp-1", name: "camp-1", description: "Shorter, with the price" });
    expect(store.campaigns![0]!.edited_at).toBeTruthy();
    expect((await agentCloses(harness, store, reviseId)).status).toBe("todo");
    last = commentsOn(booted, reviseId).at(-1)!;
    expect(last).not.toContain("has not changed");
    expect(last).toContain("has no new approval");

    await tool(harness, "request-campaign-approval", { campaignId: "camp-1" });
    expect((await agentCloses(harness, store, reviseId)).status).toBe("done");
  });

  it("asking again without a change is not enough; a new step counts as a change", async () => {
    const { harness, store, reviseId, booted } = await refused();
    await tool(harness, "request-campaign-approval", { campaignId: "camp-1" });
    expect((await agentCloses(harness, store, reviseId)).status).toBe("todo");
    expect(commentsOn(booted, reviseId).at(-1)).toContain("has not changed since its approval was refused");
    // Adding a step cancels that approval: ask again after the change.
    await tool(harness, "add-campaign-step", { campaignId: "camp-1", subject: "One more", body: "Reply STOP to stop." });
    await tool(harness, "request-campaign-approval", { campaignId: "camp-1" });
    expect((await agentCloses(harness, store, reviseId)).status).toBe("done");
  });

  it("is not checked when the campaign is no longer a draft, nor when a person closes it", async () => {
    const a = await refused();
    a.store.campaigns![0]!.status = "completed";
    expect((await agentCloses(a.harness, a.store, a.reviseId)).status).toBe("done");
    const b = await refused();
    expect((await agentCloses(b.harness, b.store, b.reviseId, PERSON)).status).toBe("done");
  });
});

describe("replies", () => {
  function replyStore(): Store {
    const store = seed();
    store.campaigns!.push(campaign("camp-mail"));
    store.campaign_steps!.push(step("camp-mail", 1, "a", "Hi Ada", "Body"), step("camp-mail", 2, "a", "Again", "Body"));
    store.campaign_enrollments!.push(enrollment("e-ada", "camp-mail", "ada", { step_position: 2 }));
    store.campaign_step_events!.push({
      id: "sent-1", company_id: CO, campaign_id: "camp-mail", enrollment_id: "e-ada", step_position: 1, event_type: "sent", variant: "a",
      source_key: "sent:campaigns:step:e-ada:1", meta: { to: "ada@acme.test" }, occurred_at: "2026-09-20T08:00:00.000Z",
    });
    return store;
  }
  const mail = (over: Record<string, unknown> = {}) => ({
    key: "mbx:m-1", accountAddress: "peet@partnersinbiz.online", messageId: "m-1", threadId: "t-1", from: { email: "ada@acme.test", name: "Ada" },
    to: [{ email: "peet@partnersinbiz.online" }], subject: "Re: Hi Ada", snippet: "Can you call me?", receivedAt: new Date().toISOString(), attachments: [],
    triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: null, ...over,
  });

  async function openReply() {
    const store = replyStore();
    const booted = await boot({ store, jev: false });
    const { harness } = booted;
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, mail(), { companyId: CO });
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue).toMatchObject({ title: "Check reply from Ada Lovelace: Re: Hi Ada", originId: "campaigns:reply:e-ada:m-1" });
    expect(issue!.description).toContain("`partnersinbiz.campaigns:log-reply` (messageId `m-1`");
    (store.issues ??= []).push({ id: issue!.id, status: "todo", created_at: new Date().toISOString() });
    await tick();
    return { harness, store, issueId: issue!.id, booted };
  }

  it("reopens while the reply has no answer or decision", async () => {
    const { harness, store, issueId, booted } = await openReply();
    expect((await agentCloses(harness, store, issueId)).status).toBe("todo");
    expect(commentsOn(booted, issueId).at(-1)).toContain('- The reply from Ada Lovelace to campaign "camp-mail" has no answer or decision yet: answer it (`partnersinbiz.mailbox:create-draft`) and log it with `log-reply` (messageId `m-1`)');
  });

  it("passes once the answer is logged", async () => {
    const { harness, store, issueId } = await openReply();
    await expect(tool(harness, "log-reply", { messageId: "m-404", outcome: "answered", note: "x" })).rejects.toThrow(/No campaign reply has Mailbox message id m-404/);
    await expect(tool(harness, "log-reply", { messageId: "m-1", outcome: "maybe", note: "x" })).rejects.toThrow(/answered or no-reply-needed/);
    const logged = await tool(harness, "log-reply", { messageId: "m-1", outcome: "answered", note: "Drafted: happy to call Thursday.", mailDraftId: "d-7" });
    expect(logged).toMatchObject({ logged: true, campaignId: "camp-mail", enrollmentId: "e-ada", outcome: "answered" });
    expect(store.reply_log).toEqual([expect.objectContaining({ message_id: "m-1", outcome: "answered", mail_draft_id: "d-7", created_by: "agent:agent-camp" })]);
    expect((await agentCloses(harness, store, issueId)).status).toBe("done");
  });

  it("passes when the agent stopped the contact or suppressed the address", async () => {
    const a = await openReply();
    await tool(a.harness, "stop-enrollment", { enrollmentId: "e-ada" });
    expect((await agentCloses(a.harness, a.store, a.issueId)).status).toBe("done");
    const b = await openReply();
    await tool(b.harness, "suppress-address", { email: "ada@acme.test", reason: "unsubscribe" });
    expect((await agentCloses(b.harness, b.store, b.issueId)).status).toBe("done");
  });

  it("a stop the plugin made before the reply issue opened is not a decision", async () => {
    const { harness, store, issueId } = await openReply();
    const row = store.campaign_enrollments!.find((e) => e.id === "e-ada")!;
    row.status = "stopped";
    row.updated_at = new Date(Date.now() - 60_000).toISOString();
    const issue = (await harness.ctx.issues.get(issueId, CO))!;
    const result = await checkReply(harness.ctx, { id: issueId, companyId: CO, identifier: null, title: issue.title, originId: issue.originId ?? null, assigneeAgentId: "agent-camp", createdAt: new Date().toISOString() });
    expect(result.done).toBe(false);
  });
});

describe("Cockpit snapshot", () => {
  it("carries the campaigns stages with the snapshot", async () => {
    const store = seed();
    store.campaigns!.push(campaign("draft-a", { status: "draft" }), campaign("run-a"));
    store.campaign_enrollments!.push(enrollment("e-old", "run-a", "ada", { next_due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
    store.issues!.push({ id: "reply-1", status: "todo", origin_id: "campaigns:reply:e-old:m-1", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const { harness } = await boot({ store });
    const { cockpitSnapshot } = await import("../src/cockpit.js");
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.flows).toEqual([
      { stage: "campaign.draft", count: 1, stuck: 0 },
      { stage: "campaign.approval", count: 0, stuck: 0 },
      { stage: "campaign.running", count: 1, stuck: 1, stuckReason: "1 send waiting over a day", oldestDays: 2 },
      { stage: "campaign.replies", count: 1, stuck: 1, stuckReason: "1 open over 2 days", oldestDays: 3 },
    ]);
  });
});
