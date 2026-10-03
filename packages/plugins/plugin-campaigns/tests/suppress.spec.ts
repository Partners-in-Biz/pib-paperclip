import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { asContactSuppressed, reannounceSuppressions, REANNOUNCE_HOURS } from "../src/suppress.js";
import { boot, campaign, CO, enrollment, PAST, seed, seedIssue, step } from "./helpers/harness.js";

const MAILBOX = "plugin.partnersinbiz.mailbox";
const CRM = "plugin.partnersinbiz.crm";

function stubJev(choice: string, confidence = 0.95) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { reply_kind: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } },
  }), { status: 200 })));
}

function store() {
  const s = seed();
  s.campaigns!.push(campaign("camp-mail"), campaign("camp-issue", { delivery: "issue" }));
  s.campaign_steps!.push(
    step("camp-mail", 1, "a", "Hi {{first_name}}", "Hello {{first_name}}. Reply STOP to stop."),
    step("camp-mail", 2, "a", "Again", "Second", 3),
    step("camp-issue", 1, "a", "Manual", "Send by hand"),
  );
  return s;
}

const suppressedEvents = (emit: { mock: { calls: unknown[][] } }) => emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactSuppressed).map((call) => call[2] as Record<string, unknown>);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign email is marketing mail", () => {
  it("asks the Mailbox to treat the step as marketing (suppression and List-Unsubscribe)", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e1", "camp-mail", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    expect(s.outbox![0]!.payload).toMatchObject({ marketing: true, to: [{ email: "ada@acme.test" }], subject: "Hi Ada" });
  });

  it("a Mailbox refusal for a suppressed address stops the contact instead of asking someone to send it", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e1", "camp-mail", "ada", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, {
      key: "campaigns:step:e1:1", status: "failed", permanent: true, error: "Not sent: ada@acme.test unsubscribed from marketing email.",
      suppressed: [{ email: "ada@acme.test", reason: "unsubscribed", scope: "marketing" }],
      context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e1" },
    }, { companyId: CO });
    expect(s.campaign_enrollments![0]).toMatchObject({ status: "stopped", sending_key: null });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.mailbox" })]);
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);
  });
});

describe("unsubscribe replies", () => {
  it("suppress the address, stop every campaign, cancel open step issues and tell the CRM and Mailbox", async () => {
    stubJev("unsubscribe");
    const s = store();
    s.campaign_enrollments!.push(
      enrollment("e-mail", "camp-mail", "ada", { next_due_at: "2026-10-01T08:00:00.000Z" }),
      enrollment("e-issue", "camp-issue", "ada", { open_issue_id: "step-iss" }),
    );
    s.campaign_step_events!.push({ id: "sent-1", company_id: CO, campaign_id: "camp-mail", enrollment_id: "e-mail", step_position: 1, event_type: "sent", variant: "a", source_key: "sent:x", meta: { to: "ada@acme.test" }, occurred_at: "2026-09-20T08:00:00.000Z" });
    const { harness, emit, comments } = await boot({ store: s, jev: true });
    seedIssue(harness, s, { id: "step-iss", status: "todo", assigneeAgentId: "agent-camp" });
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
      key: "mail:m-1", accountAddress: "peet@partnersinbiz.online", messageId: "m-1", threadId: "t-1",
      from: { email: "ada@acme.test", name: "Ada" }, to: [], subject: "Re: Hi Ada", snippet: "Please stop emailing me", receivedAt: "2026-09-26T09:00:00Z",
      attachments: [], triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: null,
    }, { companyId: CO });
    expect(s.campaign_enrollments!.every((row) => row.status === "stopped")).toBe(true);
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada" })]);
    expect(suppressedEvents(emit)).toEqual([expect.objectContaining({ key: "suppress:ada@acme.test:unsubscribed", email: "ada@acme.test", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.campaigns" })]);
    expect(await harness.ctx.issues.get("step-iss", CO)).toMatchObject({ status: "cancelled" });
    expect(String(comments.mock.calls.find(([id]) => id === "step-iss")?.[1])).toMatch(/Do not send this/);
  });

  it("an unsure reply asks the owner to choose, with the exact tool calls", async () => {
    stubJev("unsubscribe", 0.4);
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-mail", "camp-mail", "ada"));
    const { harness } = await boot({ store: s, jev: true });
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
      key: "mail:m-2", accountAddress: "peet@partnersinbiz.online", messageId: "m-2", threadId: "t-2",
      from: { email: "ada@acme.test", name: "Ada" }, to: [], subject: "Re: Hi Ada", snippet: "hmm", receivedAt: "2026-09-26T09:00:00Z",
      attachments: [], triage: { category: "reply" }, replyTo: null,
    }, { companyId: CO });
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue!.title).toBe("Check reply from Ada Lovelace: Re: Hi Ada");
    expect(issue!.assigneeAgentId).toBe("agent-camp");
    expect(issue!.description).toContain("`partnersinbiz.campaigns:suppress-address` (email `ada@acme.test`, reason `unsubscribe`)");
    expect(issue!.description).toContain("`partnersinbiz.campaigns:stop-enrollment` (enrollmentId `e-mail`)");
  });
});

describe("contact.suppressed from the CRM and the Mailbox", () => {
  it("joins the list, stops running campaigns and cancels open step issues", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-issue", "camp-issue", "bob", { open_issue_id: "bob-step" }), enrollment("e-ada", "camp-mail", "ada"));
    const { harness } = await boot({ store: s });
    seedIssue(harness, s, { id: "bob-step", status: "todo", assigneeAgentId: "agent-camp" });
    await harness.emit(`${CRM}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, {
      key: "suppress:bob@beta.test:unsubscribed", email: " Bob@Beta.test ", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.crm", at: "2026-09-26T09:00:00Z",
    }, { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "bob@beta.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.crm" })]);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-issue")!.status).toBe("stopped");
    expect(s.campaign_enrollments!.find((row) => row.id === "e-ada")!.status).toBe("running");
    expect(await harness.ctx.issues.get("bob-step", CO)).toMatchObject({ status: "cancelled" });
  });

  it("a hard bounce from the Mailbox widens a marketing-only row to all mail; junk is ignored", async () => {
    const s = store();
    // An empty sender key is how a row from before 0.6 is stored (the column is NOT NULL DEFAULT '').
    s.suppressions!.push({ company_id: CO, email: "uma@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, sender_key: "" });
    const { harness } = await boot({ store: s });
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { email: "uma@x.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox" }, { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "uma@x.test", scope: "all", reason: "unsubscribe" })]);
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { email: "not-an-address", reason: "bounced" }, { companyId: CO });
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { email: "x@y.co", reason: "because" }, { companyId: CO });
    expect(s.suppressions).toHaveLength(1);
  });

  it("parses the payload and defaults the scope from the reason", () => {
    expect(asContactSuppressed({ email: "A@B.co", reason: "bounced" }, "partnersinbiz.mailbox")).toMatchObject({ email: "a@b.co", scope: "all", source: "partnersinbiz.mailbox", key: "suppress:a@b.co:bounced" });
    expect(asContactSuppressed({ email: "a@b.co", reason: "complained" }, null)).toMatchObject({ scope: "marketing" });
    expect(asContactSuppressed({ email: "a@b.co" }, null)).toBeNull();
  });
});

describe("agent tools", () => {
  it("suppress-address records an opt-out and tells the others", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-ada", "camp-mail", "ada"));
    const { harness, emit } = await boot({ store: s });
    const result = await harness.executeTool<{ data: Record<string, unknown> }>("suppress-address", { email: "ADA@acme.test", reason: "complaint" }, { companyId: CO, agentId: "agent-camp" });
    expect(result.data).toMatchObject({ email: "ada@acme.test", reason: "complaint", added: true, stoppedContacts: 1, announced: true });
    expect(s.campaign_enrollments![0]!.status).toBe("stopped");
    expect(suppressedEvents(emit)).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "complained", scope: "marketing" })]);
    const bad = await harness.executeTool<{ error?: string }>("suppress-address", { email: "ada@acme.test", reason: "bounce" }, { companyId: CO, agentId: "agent-camp" });
    expect(bad.error).toMatch(/reason must be/);
  });

  it("stop-enrollment stops one campaign, or every campaign for the contact", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e1", "camp-mail", "ada"), enrollment("e2", "camp-issue", "ada"));
    const { harness } = await boot({ store: s });
    await harness.executeTool("stop-enrollment", { enrollmentId: "e1" }, { companyId: CO, agentId: "agent-camp" });
    expect(s.campaign_enrollments!.map((row) => row.status)).toEqual(["stopped", "running"]);
    await harness.executeTool("stop-enrollment", { enrollmentId: "e1", everyCampaign: true }, { companyId: CO, agentId: "agent-camp" });
    expect(s.campaign_enrollments!.map((row) => row.status)).toEqual(["stopped", "stopped"]);
  });

  it("enroll-contact refuses a suppressed address", async () => {
    const s = store();
    s.suppressions!.push({ company_id: CO, email: "uma@x.test", reason: "bounce", scope: "all", source: "partnersinbiz.mailbox", contact_id: null, campaign_id: null });
    const { harness } = await boot({ store: s });
    const refused = await harness.executeTool<{ error?: string }>("enroll-contact", { campaignId: "camp-mail", contactId: "uma" }, { companyId: CO, agentId: "agent-camp" });
    expect(refused.error).toMatch(/unsubscribed or bounced/);
    const ok = await harness.executeTool<{ data?: Record<string, unknown> }>("enroll-contact", { campaignId: "camp-mail", contactId: "bob" }, { companyId: CO, agentId: "agent-camp" });
    expect(ok.data).toMatchObject({ contactId: "bob", status: "running" });
  });
});

describe("re-announcing unsubscribes", () => {
  it("announces Campaigns' own unsubscribes from the last 3 days again, not bounces or older ones", async () => {
    const now = Date.parse("2026-09-27T10:00:00Z");
    const s = store();
    s.suppressions!.push(
      { company_id: CO, email: "new@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, created_at: new Date(now - 3_600_000).toISOString() },
      { company_id: CO, email: "old@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, created_at: new Date(now - (REANNOUNCE_HOURS + 1) * 3_600_000).toISOString() },
      { company_id: CO, email: "bounce@x.test", reason: "bounce", scope: "all", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, created_at: new Date(now - 3_600_000).toISOString() },
      { company_id: CO, email: "crm@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.crm", contact_id: null, campaign_id: null, created_at: new Date(now - 3_600_000).toISOString() },
    );
    const { harness, emit } = await boot({ store: s });
    expect(await reannounceSuppressions(harness.ctx, now)).toBe(1);
    expect(suppressedEvents(emit).map((payload) => payload.email)).toEqual(["new@x.test"]);
  });
});
