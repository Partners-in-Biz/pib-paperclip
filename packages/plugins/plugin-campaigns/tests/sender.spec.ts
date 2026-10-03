import { describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "@partnersinbiz/pib-plugin-kit";
import { linkSecret } from "../src/links.js";
import { boot, campaign, CO, contact, enrollment, issueUpdated, PAST, PUBLIC_URL, seed, seedIssue, setIssueStatus, setRoles, step, UI_BASE } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

const AGENT = { companyId: CO, agentId: "agent-camp" };
const PERSON = { type: "user" as const, id: "user-peet" };

const clientCampaign = (extra: Record<string, unknown> = {}) => campaign("camp-acme", { status: "draft", delivery: "email", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing", audience_mode: "client_contacts", owner_user_id: "user-peet", ...extra });

function clientStore(extra: Record<string, unknown> = {}): Store {
  const s = seed();
  s.campaigns!.push(clientCampaign(extra));
  s.campaign_steps!.push(step("camp-acme", 1, "a", "Hello {{first_name}}", "Your boiler service is due."));
  return s;
}

const identity = (over: Record<string, unknown> = {}) => ({ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme Plumbing", reply_to: "bookings@acme.test", sms_from: null, whatsapp_from: null, ...over });

describe("set-sender-identity", () => {
  it("saves who a client's messages go out as, keeps omitted fields, clears with an empty string, and lists them", async () => {
    const s = seed();
    const { harness } = await boot({ store: s });
    const saved = await harness.executeTool<{ data: Record<string, any> }>("set-sender-identity", { client: "company:acme", fromAddress: "Hello@Acme.test", fromName: "Acme Plumbing", replyTo: "bookings@acme.test", smsFrom: "082 000 0001" }, { ...AGENT });
    expect(saved.data).toMatchObject({ saved: true, sender: "company:acme", fromAddress: "hello@acme.test", fromName: "Acme Plumbing", replyTo: "bookings@acme.test", smsFrom: "+27820000001" });
    expect(s.sender_identities).toEqual([expect.objectContaining({ sender_key: "company:acme", updated_by: "agent:agent-camp" })]);
    await harness.executeTool("set-sender-identity", { client: "company:acme", fromName: "Acme" }, { ...AGENT });
    expect(s.sender_identities![0]).toMatchObject({ from_address: "hello@acme.test", from_name: "Acme", sms_from: "+27820000001" });
    await harness.executeTool("set-sender-identity", { client: "company:acme", smsFrom: "" }, { ...AGENT });
    expect(s.sender_identities![0]!.sms_from).toBeNull();
    const listed = await harness.executeTool<{ data: { identities: Array<{ sender: string }> } }>("list-sender-identities", {}, { ...AGENT });
    expect(listed.data.identities.map((row) => row.sender)).toEqual(["company:acme"]);
    const removed = await harness.executeTool<{ data: { removed: boolean } }>("remove-sender-identity", { client: "company:acme" }, { ...AGENT });
    expect(removed.data.removed).toBe(true);
    expect(s.sender_identities).toHaveLength(0);
  });

  it("is own marketing's identity when no client is named, and refuses what cannot be right", async () => {
    const s = seed();
    const { harness } = await boot({ store: s });
    await harness.executeTool("set-sender-identity", { fromName: "Partners in Biz", replyTo: "peet@partnersinbiz.online" }, { ...AGENT });
    expect(s.sender_identities![0]).toMatchObject({ sender_key: "own" });
    const call = (params: Record<string, unknown>) => harness.executeTool<{ error?: string }>("set-sender-identity", params, { ...AGENT });
    expect((await call({ client: "company:acme", fromAddress: "not-an-email" })).error).toMatch(/fromAddress must be an email/);
    expect((await call({ client: "company:acme", replyTo: "nope" })).error).toMatch(/replyTo must be an email/);
    expect((await call({ client: "company:acme", smsFrom: "12345" })).error).toMatch(/smsFrom must be a phone number/);
    expect((await call({ client: "company:acme", smsFrom: "011 123 4567" })).error).toMatch(/smsFrom must be a phone number/);
    expect((await call({ client: "company:ghost", fromName: "Ghost" })).error).toMatch(/not found/);
    expect((await call({ client: "acme", fromName: "x" })).error).toMatch(/client must be/);
    expect((await call({ client: "company:acme" })).error).toMatch(/Nothing to save/);
    // A Messaging Service SID is fine for SMS only.
    expect((await call({ client: "company:acme", smsFrom: "MG0123456789abcdef0123456789abcdef" })) as unknown).toMatchObject({ data: { smsFrom: "MG0123456789abcdef0123456789abcdef" } });
    expect((await call({ client: "company:acme", whatsappFrom: "MG0123456789abcdef0123456789abcdef" })).error).toMatch(/whatsappFrom must be a phone number/);
  });

  it("cancels the open approval of that sender's drafts, because the approver saw the old sender", async () => {
    const s = clientStore({ approval_issue_id: "appr-1" });
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s });
    seedIssue(harness, s, { id: "appr-1", status: "todo", assigneeUserId: "user-peet" });
    const saved = await harness.executeTool<{ data: { approvalsReset: number }; error?: string }>("set-sender-identity", { client: "company:acme", fromAddress: "other@acme.test" }, { ...AGENT });
    expect(saved.error).toBeUndefined();
    expect(saved.data.approvalsReset).toBe(1);
    expect(await harness.ctx.issues.get("appr-1", CO)).toMatchObject({ status: "cancelled" });
    expect(s.campaigns![0]!.approval_issue_id).toBeNull();
  });
});

describe("a sender cannot change under a running campaign", () => {
  it("refuses a new reply-to, name, mailbox or number while one of its campaigns is running or paused, and allows it once they are complete", async () => {
    const s = clientStore({ status: "active" });
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s });
    const change = (params: Record<string, unknown>) => harness.executeTool<{ data?: Record<string, unknown>; error?: string }>("set-sender-identity", { client: "company:acme", ...params }, AGENT);
    for (const params of [{ replyTo: "attacker@evil.test" }, { fromName: "Someone else" }, { fromAddress: "other@acme.test" }, { smsFrom: "+27820000009" }]) {
      const refused = await change(params);
      expect(refused.error, JSON.stringify(params)).toMatch(/running or paused \(camp-acme\).*Complete it \(complete-campaign\) first/);
    }
    expect(s.sender_identities![0]).toMatchObject({ reply_to: "bookings@acme.test", from_name: "Acme Plumbing", from_address: "hello@acme.test" });
    // Saving what is already there changes nothing, so it is allowed.
    expect((await change({ fromName: "Acme Plumbing", replyTo: "bookings@acme.test" })).error).toBeUndefined();
    // Paused is still approved as it was.
    s.campaigns![0]!.status = "paused";
    expect((await change({ replyTo: "attacker@evil.test" })).error).toMatch(/running or paused/);
    // Complete it: now the sender can change, and a new campaign needs its own approval.
    s.campaigns![0]!.status = "completed";
    expect((await change({ replyTo: "new@acme.test" })).error).toBeUndefined();
    expect(s.sender_identities![0]).toMatchObject({ reply_to: "new@acme.test" });
  });

  it("a draft does not block the change (it is sent for approval again); another client's running campaign does not either", async () => {
    const s = clientStore({ status: "draft" });
    s.campaigns!.push(campaign("camp-beta", { status: "active", client_kind: "company", client_ref: "beta", client_name: "Beta Co", delivery: "email" }));
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s });
    const out = await harness.executeTool<{ error?: string }>("set-sender-identity", { client: "company:acme", replyTo: "new@acme.test" }, AGENT);
    expect(out.error).toBeUndefined();
  });

  it("a first identity for a sender whose campaign already runs is refused too (it would start sending unapproved)", async () => {
    const s = clientStore({ status: "active" });
    const { harness } = await boot({ store: s });
    const out = await harness.executeTool<{ error?: string }>("set-sender-identity", { client: "company:acme", fromAddress: "hello@acme.test" }, AGENT);
    expect(out.error).toMatch(/running or paused/);
    expect(s.sender_identities ?? []).toHaveLength(0);
  });
});

describe("a client's email goes out as the client", () => {
  it("is refused at approval without a sender of its own, then asks for approval showing exactly who it goes out as", async () => {
    const s = clientStore();
    const { harness } = await boot({ store: s });
    const refused = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(refused.error).toMatch(/Fix these before asking for approval/);
    expect(refused.error).toMatch(/No sender is set up for company:acme \(Acme Plumbing\)/);
    expect(refused.error).toMatch(/never sent from the default account/);
    expect(s.campaigns![0]!.approval_issue_id).toBeNull();

    s.sender_identities = [identity()];
    const asked = await harness.executeTool<{ data: { approvalIssueId: string; warnings: string[] } }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    const issue = await harness.ctx.issues.get(asked.data.approvalIssueId, CO);
    expect(issue!.description).toContain("**Sent as:** Acme Plumbing <hello@acme.test>, replies to bookings@acme.test.");
    expect(issue!.description).toContain("**Added to every email:** who sent it and how to stop");
    // What the Mailbox has not told us is said, not hidden.
    expect(issue!.description).toContain("**Check before approving:**");
    expect(issue!.description).toMatch(/Check: The sender's domain health \(SPF, DKIM, DMARC\) has not been reported/);
    expect(asked.data.warnings.some((w) => /one-click unsubscribe header/.test(w))).toBe(true);
  });

  it("sends nothing at launch time when the sender was removed after approval, and hands the approval back with the reason", async () => {
    const s = clientStore({ approval_issue_id: "appr-1" });
    const { harness, comments } = await boot({ store: s });
    seedIssue(harness, s, { id: "appr-1", status: "done", assigneeUserId: "user-peet", description: "- **Audience:** Contacts at Acme Plumbing (1)." });
    await issueUpdated(harness, "appr-1", PERSON);
    expect(s.campaigns![0]).toMatchObject({ status: "draft" });
    expect(s.campaigns![0]!.launch_error).toMatch(/No sender is set up for company:acme/);
    expect(s.campaign_enrollments).toHaveLength(0);
    expect(String(comments.mock.calls.at(-1)?.[1])).toMatch(/^Approved, but the campaign could not launch: It cannot launch yet: No sender is set up/);
  });

  it("holds a due step when the sender goes missing: no email out, no issue per contact, the step stays due", async () => {
    const s = clientStore({ status: "active" });
    s.campaign_enrollments!.push(enrollment("e1", "camp-acme", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    expect(s.outbox).toHaveLength(0);
    expect(s.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 1, sending_key: null, open_issue_id: null });
    expect(await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).toHaveLength(0);
    expect(harness.logs.some((entry) => entry.message === "Campaign email held: no sender")).toBe(true);
  });

  it("puts the client's mailbox, name and reply-to on the send request, never the default account", async () => {
    const s = clientStore({ status: "active" });
    s.sender_identities = [identity()];
    s.campaign_enrollments!.push(enrollment("e1", "camp-acme", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    expect(s.outbox![0]!.payload).toMatchObject({
      from: "hello@acme.test",
      fromName: "Acme Plumbing",
      replyTo: { email: "bookings@acme.test" },
      marketing: true,
      context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", clientKind: "company", clientRef: "acme" },
    });
  });

  it("lets the campaign's own sender name and reply-to win over the identity's", async () => {
    const s = clientStore({ status: "active", from_name: "Dave at Acme", reply_to: "dave@acme.test" });
    s.sender_identities = [identity()];
    s.campaign_enrollments!.push(enrollment("e1", "camp-acme", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    expect(s.outbox![0]!.payload).toMatchObject({ from: "hello@acme.test", fromName: "Dave at Acme", replyTo: { email: "dave@acme.test" } });
  });

  it("keeps PiB's own marketing on the default account, now with its name and reply-to instead of dropping them", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { delivery: "email", from_name: "Peet at Partners in Biz", reply_to: "peet@partnersinbiz.online" }));
    s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"));
    s.campaign_enrollments!.push(enrollment("e1", "camp-own", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    const payload = s.outbox![0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ fromName: "Peet at Partners in Biz", replyTo: { email: "peet@partnersinbiz.online" } });
    expect(payload.from).toBeUndefined();
  });

  it("does not need a sender when an agent sends each email by hand from an issue", async () => {
    const s = clientStore({ delivery: "issue", status: "draft" });
    const { harness } = await boot({ store: s });
    const asked = await harness.executeTool<{ data?: { approvalIssueId: string }; error?: string }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(asked.error).toBeUndefined();
    expect(asked.data?.approvalIssueId).toBeTruthy();
  });
});

describe("the footer and the unsubscribe header", () => {
  const dueStore = (extra: Record<string, unknown> = {}) => {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { delivery: "email", ...extra }));
    s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello {{first_name}}. Unsubscribe any time: {{unsubscribe_url}}"));
    s.campaign_enrollments!.push(enrollment("e1", "camp-own", "ada", { next_due_at: PAST }));
    return s;
  };

  it("adds who sent it and how to stop to every email, with a link that verifies, and fills {{unsubscribe_url}}", async () => {
    const s = dueStore();
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    const payload = s.outbox![0]!.payload as { text: string; html: string };
    const link = /https:\/\/paperclip\.test\/_plugins\/[0-9a-f-]+\/ui\/unsubscribe\.html\?t=([^\s<"]+)/.exec(payload.text);
    expect(link, payload.text).toBeTruthy();
    expect(payload.text).toContain("You are getting this email from Partners in Biz. To stop getting these emails, unsubscribe here:");
    expect(payload.text).toContain("or reply STOP.");
    // The token names the company, the address and whose list; only this company's secret verifies it.
    const secret = await linkSecret(harness.ctx, CO, { create: false });
    expect(verifyUnsubscribeToken(decodeURIComponent(link![1]!), secret!)).toEqual({ companyId: CO, email: "ada@acme.test", senderKey: "own" });
    expect(verifyUnsubscribeToken(decodeURIComponent(link![1]!), "another-secret-of-enough-length")).toBeNull();
    expect(payload.html).toContain('<a href="https://paperclip.test/_plugins/');
    // The body's own {{unsubscribe_url}} is filled with the same link.
    expect(payload.text.split(link![0]!).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("builds the link for the client's list when the campaign is a client's", async () => {
    const s = clientStore({ status: "active" });
    s.sender_identities = [identity()];
    s.campaign_enrollments!.push(enrollment("e1", "camp-acme", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    const payload = s.outbox![0]!.payload as { text: string };
    const token = decodeURIComponent(/\?t=([^\s<"]+)/.exec(payload.text)![1]!);
    const secret = await linkSecret(harness.ctx, CO, { create: false });
    expect(verifyUnsubscribeToken(token, secret!)).toMatchObject({ senderKey: "company:acme", email: "ada@acme.test" });
    expect(payload.text).toContain("You are getting this email from Acme Plumbing.");
  });

  it("offers the RFC 8058 one-click address only once the front-door rule is saved, and it carries the same token", async () => {
    const without = dueStore();
    const first = await boot({ store: without });
    await first.harness.runJob("open-due-steps");
    expect((without.outbox![0]!.payload as Record<string, unknown>).unsubscribeUrl).toBeUndefined();

    const withRule = dueStore();
    const second = await boot({ store: withRule, config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, oneClickUnsubscribeUrl: "https://paperclip.test/u" } });
    await second.harness.runJob("open-due-steps");
    const url = String((withRule.outbox![0]!.payload as Record<string, unknown>).unsubscribeUrl);
    expect(url.startsWith("https://paperclip.test/u?t=")).toBe(true);
    const secret = await linkSecret(second.harness.ctx, CO, { create: false });
    expect(verifyUnsubscribeToken(decodeURIComponent(url.slice("https://paperclip.test/u?t=".length)), secret!)).toMatchObject({ email: "ada@acme.test" });
  });

  it("never offers a one-click address that is not https", async () => {
    const s = dueStore();
    const { harness } = await boot({ store: s, config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, oneClickUnsubscribeUrl: "http://paperclip.test/u" } });
    await harness.runJob("open-due-steps");
    expect((s.outbox![0]!.payload as Record<string, unknown>).unsubscribeUrl).toBeUndefined();
  });

  it("puts the footer before the closing body tag of a designed email", async () => {
    const s = dueStore();
    s.campaign_steps![0]!.html_body = "<html><body><p>Hi {{first_name}}</p></body></html>";
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    const html = (s.outbox![0]!.payload as { html: string }).html;
    expect(html.indexOf("You are getting this email")).toBeGreaterThan(html.indexOf("<p>Hi Ada</p>"));
    expect(html.indexOf("You are getting this email")).toBeLessThan(html.indexOf("</body>"));
  });

  it("without the public address the footer still says how to stop (reply STOP), and a client's approval is refused", async () => {
    const s = dueStore();
    const { harness } = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    await harness.runJob("open-due-steps");
    const payload = s.outbox![0]!.payload as { text: string };
    expect(payload.text).toContain("To stop getting these emails, reply STOP.");
    expect(payload.text).not.toContain("unsubscribe.html");

    const client = clientStore();
    client.sender_identities = [identity()];
    const booted = await boot({ store: client, config: { timezone: "Africa/Johannesburg" } });
    const refused = await booted.harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(refused.error).toMatch(/Emails cannot carry an unsubscribe link yet: The public address is not set/);
  });
});

describe("the Mailbox's report on the sender's domain", () => {
  const MAILBOX = "plugin.partnersinbiz.mailbox";

  it("a domain reported bad blocks the approval; ok clears it; unknown is only a warning", async () => {
    const s = clientStore();
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s });
    await harness.emit(`${MAILBOX}.sender.health` as `plugin.${string}`, { accountAddress: "hello@acme.test", status: "bad", detail: "No SPF record for acme.test", checkedAt: "2026-10-03T08:00:00Z" }, { companyId: CO });
    const blocked = await harness.executeTool<{ data: { ok: boolean; errors: Array<{ code: string; message: string }> } }>("preflight-campaign", { campaignId: "camp-acme", links: false }, AGENT);
    expect(blocked.data.ok).toBe(false);
    expect(blocked.data.errors).toEqual([expect.objectContaining({ code: "domain-bad", message: expect.stringContaining("No SPF record for acme.test") })]);
    const refused = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(refused.error).toMatch(/No SPF record/);
    await harness.emit(`${MAILBOX}.sender.health` as `plugin.${string}`, { accountAddress: "hello@acme.test", status: "ok", checkedAt: "2026-10-03T09:00:00Z" }, { companyId: CO });
    const clear = await harness.executeTool<{ data: { ok: boolean; warnings: Array<{ code: string }> } }>("preflight-campaign", { campaignId: "camp-acme", links: false }, AGENT);
    expect(clear.data.ok).toBe(true);
    expect(clear.data.warnings.map((w) => w.code)).not.toContain("domain-unknown");
  });

  it("ignores a report it cannot read", async () => {
    const s = clientStore();
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s });
    await harness.emit(`${MAILBOX}.sender.health` as `plugin.${string}`, { status: "bad" }, { companyId: CO });
    await harness.emit(`${MAILBOX}.sender.health` as `plugin.${string}`, { accountAddress: "hello@acme.test", status: "great" }, { companyId: CO });
    const result = await harness.executeTool<{ data: { errors: unknown[]; warnings: Array<{ code: string }> } }>("preflight-campaign", { campaignId: "camp-acme", links: false }, AGENT);
    expect(result.data.errors).toEqual([]);
    expect(result.data.warnings.map((w) => w.code)).toContain("domain-unknown");
  });
});

describe("approval routing", () => {
  it("never opens the approval unassigned: with no owner anywhere it goes to the Operator with a note", async () => {
    const s = clientStore({ owner_user_id: null });
    s.sender_identities = [identity()];
    const { harness } = await boot({ store: s, agents: [{ id: "agent-camp", status: "idle" }, { id: "agent-operator", status: "idle" }] });
    await setRoles(harness, { operatorAgentId: "agent-operator", ownerUserId: null, operatorStatus: "idle" });
    const asked = await harness.executeTool<{ data: { approvalIssueId: string; routedTo: string } }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(asked.data.routedTo).toBe("operator");
    const issue = await harness.ctx.issues.get(asked.data.approvalIssueId, CO);
    expect(issue!.assigneeAgentId).toBe("agent-operator");
    expect(issue!.description).toContain("No approver found");
    void setIssueStatus;
    void UI_BASE;
    void contact;
  });
});
