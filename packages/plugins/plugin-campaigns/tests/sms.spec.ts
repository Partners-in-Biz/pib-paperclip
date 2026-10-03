import { afterEach, describe, expect, it } from "vitest";
import { messagingHealth } from "../src/cockpit.js";
import { sendMessagingStep, MESSAGE_MAX_ATTEMPTS } from "../src/sms.js";
import { campaignMessageKey } from "../src/domain.js";
import { enrollmentById, getCampaign, listSteps, listSenderIdentityRows } from "../src/db.js";
import { BREAKER_FAILURES, BREAKER_PAUSE_MS, messagingSetup, providerPaused, recordProviderResult, resetProviderBreaker, setMessagingProvider, type SendOutcome } from "../src/messaging.js";
import { boot, campaign, CO, contact, enrollment, PAST, PUBLIC_URL, seed, step } from "./helpers/harness.js";
import { MockProvider } from "./helpers/mock-provider.js";
import type { Store } from "./helpers/fake-db.js";

const TZ = "Africa/Johannesburg";
const ADA = "+27821234567";
const OWN_NUMBER = "+14155550100";
const WHATSAPP_NUMBER = "+14155238886";

afterEach(() => setMessagingProvider(null));

/** Windows that are always open, so the job's real clock does not decide a test. */
const OPEN = { weekdays: "00:00-24:00", saturday: "00:00-24:00", sunday: "00:00-24:00" };

function textStore(extra: { delivery?: string; steps?: Array<ReturnType<typeof step>>; campaignExtra?: Record<string, unknown> } = {}): Store {
  const s = seed();
  s.crm_contacts = [
    contact("ada", "Ada Lovelace", ["ada@acme.test"], { phones: ["082 123 4567"], account_ids: ["acme"] }),
    contact("bob", "Bob Builder", ["bob@beta.test"], { phones: ["+27 83 555 0001"] }),
    contact("carl", "Carl NoPhone", ["carl@x.test"], { phones: ["011 123 4567"] }),
  ];
  s.campaigns!.push(campaign("camp-sms", { delivery: extra.delivery ?? "auto", ...extra.campaignExtra }));
  s.campaign_steps!.push(...(extra.steps ?? [step("camp-sms", 1, "a", "", "Hi {{first_name}}, 10% off this week at {{company}}."), step("camp-sms", 2, "a", "", "Last chance, {{first_name}}.", 2)].map((row) => ({ ...row, channel: "sms" }))));
  s.channel_consents = [];
  s.channel_suppressions = [];
  s.channel_messages = [];
  return s;
}

const consent = (address: string, over: Record<string, unknown> = {}) => ({ company_id: CO, channel: "sms", address, sender_key: "own", granted: true, basis: "consent", source: "form", evidence: "Ticked SMS offers on the sign-up form", contact_id: null, recorded_at: "2026-09-01T08:00:00.000Z", recorded_by: null, ...over });

async function bootSms(options: { store?: Store; messaging?: Record<string, unknown>; mock?: MockProvider; noProvider?: boolean } = {}) {
  const mock = options.mock ?? new MockProvider();
  const store = options.store ?? textStore();
  const config = { timezone: TZ, publicBaseUrl: PUBLIC_URL, messaging: { smsFrom: OWN_NUMBER, whatsappFrom: WHATSAPP_NUMBER, ...OPEN, ...options.messaging } };
  const booted = await boot({ store, config });
  if (!options.noProvider) setMessagingProvider(() => mock);
  return { ...booted, mock, store };
}

describe("an SMS step", () => {
  it("is sent once through the provider with the person's name, the opt-out line and nothing else, then they move on", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toEqual([{ channel: "sms", to: ADA, from: OWN_NUMBER, body: "Hi Ada, 10% off this week at Acme Plumbing. Reply STOP to opt out.", template: null, reference: campaignMessageKey("e1", 1) }]);
    expect(store.channel_messages).toEqual([expect.objectContaining({ key: "campaigns:msg:e1:1", status: "sent", to_address: ADA, segments: 1, sender_key: "own", provider_id: expect.stringMatching(/^SM/) })]);
    // The step event keeps the provider id and a masked number, never the number itself.
    const event = store.campaign_step_events!.find((row) => row.event_type === "sent")!;
    expect(JSON.stringify(event.meta)).not.toContain("82123");
    expect(event.meta).toMatchObject({ channel: "sms", to: "+27*****4567", key: "campaigns:msg:e1:1" });
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 2 });
    // The next run has nothing due, and never sends step 1 again.
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(1);
    expect(await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).toHaveLength(0);
  });

  it("copy that merely contains the word stop still goes out with the opt-out line", async () => {
    const store = textStore({ steps: [step("camp-sms", 1, "a", "", "Stop paying too much for electricity, {{first_name}}. Save 20% today. Visit us next to the bus stop on Main Rd.")].map((row) => ({ ...row, channel: "sms" })) });
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]!.body).toBe("Stop paying too much for electricity, Ada. Save 20% today. Visit us next to the bus stop on Main Rd. Reply STOP to opt out.");
    expect(store.channel_messages![0]!.body).toMatch(/Reply STOP to opt out\.$/);
  });

  it("is skipped, not sent, for a person with no opt-in on record, and they move to the next step", async () => {
    const store = textStore();
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.channel_messages).toHaveLength(0);
    expect(store.campaign_step_events).toEqual([expect.objectContaining({ event_type: "skipped", meta: { channel: "sms", why: "no opt-in on record for this sender" } })]);
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 2 });
  });

  it("is skipped for a contact whose only number is a landline", async () => {
    const store = textStore();
    store.channel_consents!.push(consent("+27111234567"));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "carl", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_step_events![0]).toMatchObject({ event_type: "skipped", meta: { why: "no mobile number on the contact" } });
  });

  it("stops the enrollment for a number on the sender's do-not-message list, even with an old opt-in", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.channel_suppressions!.push({ company_id: CO, channel: "sms", address: ADA, sender_key: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada", campaign_id: null });
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "stopped", next_due_at: null });
  });

  it("keeps each sender's list apart: a client's opt-out does not stop PiB's own texts, and a hard block stops every sender", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA), consent(ADA, { sender_key: "company:acme" }));
    store.channel_suppressions!.push({ company_id: CO, channel: "sms", address: ADA, sender_key: "company:acme", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null });
    store.campaign_enrollments!.push(enrollment("e-own", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(1);

    const hard = textStore();
    hard.channel_consents!.push(consent(ADA));
    hard.channel_suppressions!.push({ company_id: CO, channel: "sms", address: ADA, sender_key: "company:acme", reason: "invalid_number", scope: "all", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null });
    hard.campaign_enrollments!.push(enrollment("e-own", "camp-sms", "ada", { next_due_at: PAST }));
    const second = await bootSms({ store: hard });
    await second.harness.runJob("open-due-steps");
    expect(second.mock.sent).toHaveLength(0);
    expect(hard.campaign_enrollments![0]).toMatchObject({ status: "stopped" });
  });

  it("a client's campaign never goes out from PiB's number: with no number of its own nothing is sent and nothing is asked of a person", async () => {
    const store = textStore({ campaignExtra: { client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" } });
    store.channel_consents!.push(consent(ADA, { sender_key: "company:acme" }));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 1, open_issue_id: null });
    expect(store.channel_messages).toHaveLength(0);

    // With the client's own number it goes out from that number, as that client.
    store.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: null, from_name: "Acme Plumbing", reply_to: null, sms_from: "+27820000001", whatsapp_from: null }];
    await harness.runJob("open-due-steps");
    expect(mock.sent).toEqual([expect.objectContaining({ from: "+27820000001", to: ADA })]);
    expect(store.channel_messages![0]).toMatchObject({ sender_key: "company:acme" });
  });

  it("waits for the send window instead of sending at night or on a Sunday", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock, store: s } = await bootSms({ store, messaging: { weekdays: "08:00-20:00", saturday: "09:00-13:00", sunday: "off" } });
    const setup = await messagingSetup(harness.ctx, CO);
    const steps = await listSteps(harness.ctx, "camp-sms");
    const enr = { id: "e1", companyId: CO, campaignId: "camp-sms", contactId: "ada", status: "running" as const, stepPosition: 1, variant: "a" as const, nextDueAt: PAST, openIssueId: null };
    const camp = { id: "camp-sms", companyId: CO, name: "camp-sms", delivery: "auto" as const, clientKind: null, clientRef: null, clientName: null } as never;
    // Sunday noon in Johannesburg: closed. The step is put back to Monday 08:00.
    const sunday = new Date("2026-10-11T12:00:00+02:00");
    expect(await sendMessagingStep(harness.ctx, { campaign: camp, enrollment: enr, step: steps[0]!, steps, setup, now: sunday })).toBe("deferred");
    expect(mock.sent).toHaveLength(0);
    expect(new Date(String(s.campaign_enrollments![0]!.next_due_at)).toISOString()).toBe(new Date("2026-10-12T08:00:00+02:00").toISOString());
    // Monday 10:00: open.
    expect(await sendMessagingStep(harness.ctx, { campaign: camp, enrollment: enr, step: steps[0]!, steps, setup, now: new Date("2026-10-12T10:00:00+02:00") })).toBe("sent");
    expect(mock.sent).toHaveLength(1);
  });

  it("the approval says how many opt-ins an agent recorded, so a person can ask for the evidence before approving", async () => {
    const store = textStore();
    store.campaigns![0]!.status = "draft";
    store.campaigns![0]!.owner_user_id = "user-peet";
    store.campaigns![0]!.audience_tags = [];
    store.campaigns![0]!.audience_mode = "tags";
    // Ada's opt-in came from a form, Bob's was typed in by an agent.
    store.channel_consents!.push(consent(ADA, { recorded_by: "partnersinbiz.crm" }), consent("+27835550001", { source: "manual", recorded_by: "agent:agent-camp", contact_id: "bob" }));
    const { harness } = await bootSms({ store });
    const asked = await harness.executeTool<{ data?: { approvalIssueId: string }; error?: string }>("request-campaign-approval", { campaignId: "camp-sms" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.error).toBeUndefined();
    const issue = (await harness.ctx.issues.get(asked.data!.approvalIssueId, CO))!;
    expect(issue.description).toMatch(/\*\*SMS:\*\* from \+14155550100\..*2 of \d+ contacts have a mobile number and a recorded opt-in for this sender/);
    expect(issue.description).toContain("**1 of those opt-ins were recorded by an agent**");
    expect(issue.description).toContain("ask to see the evidence before approving");
  });

  it("an approval with no agent-recorded opt-ins does not raise the point", async () => {
    const store = textStore();
    store.campaigns![0]!.status = "draft";
    store.campaigns![0]!.owner_user_id = "user-peet";
    store.channel_consents!.push(consent(ADA, { recorded_by: "partnersinbiz.crm" }));
    const { harness } = await bootSms({ store });
    const asked = await harness.executeTool<{ data?: { approvalIssueId: string }; error?: string }>("request-campaign-approval", { campaignId: "camp-sms" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.error).toBeUndefined();
    expect((await harness.ctx.issues.get(asked.data!.approvalIssueId, CO))!.description).not.toContain("recorded by an agent");
  });

  it("is refused at launch and at send time when the channel is not configured, and says so", async () => {
    const store = textStore();
    store.campaigns![0]!.status = "draft";
    store.channel_consents!.push(consent(ADA));
    const { harness, mock } = await bootSms({ store, noProvider: true, messaging: { smsFrom: undefined } });
    const asked = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-sms" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.error).toMatch(/SMS steps cannot go out: .*not set up/i);
    // A running campaign whose provider was switched off sends nothing and stays due.
    store.campaigns![0]!.status = "active";
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 1 });
  });
});

describe("what the provider says", () => {
  async function runWith(outcome: SendOutcome, setupStore?: (s: Store) => void) {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    setupStore?.(store);
    const booted = await bootSms({ store });
    booted.mock.script.push(outcome);
    await booted.harness.runJob("open-due-steps");
    const issues = await booted.harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    return { ...booted, issues };
  }

  it("an answer that does not say whether it was sent is never repeated: recorded unknown and handed to a person", async () => {
    const { store, mock, harness, issues } = await runWith({ ok: false, kind: "unknown", code: null, error: "No answer from Twilio (AbortError)." });
    expect(store.channel_messages![0]).toMatchObject({ status: "unknown", error: expect.stringContaining("No answer") });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toMatch(/^SMS not sent: .*Ada Lovelace$/);
    expect(issues[0]!.description).toContain("It may or may not have been sent");
    expect(issues[0]!.description).toContain("Twilio console");
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 1, open_issue_id: issues[0]!.id });
    // Later runs and a repeat of the same step never send it.
    await harness.runJob("open-due-steps");
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(1);
  });

  it("a crash between writing the row and the provider's answer is treated as unknown, not sent again", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    store.channel_messages!.push({ key: "campaigns:msg:e1:1", company_id: CO, campaign_id: "camp-sms", enrollment_id: "e1", step_position: 1, channel: "sms", to_address: ADA, contact_id: "ada", sender_key: "own", body: "x", segments: 1, status: "sending", provider_id: null, provider_status: null, error_code: null, error: null, attempts: 1 });
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.channel_messages![0]).toMatchObject({ status: "unknown" });
    expect(await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).toHaveLength(1);
  });

  it("a message the provider accepted but the plugin did not record is moved on, not sent again", async () => {
    const store = textStore();
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    store.channel_messages!.push({ key: "campaigns:msg:e1:1", company_id: CO, campaign_id: "camp-sms", enrollment_id: "e1", step_position: 1, channel: "sms", to_address: ADA, contact_id: "ada", sender_key: "own", body: "x", segments: 1, status: "sent", provider_id: "SMabc", provider_status: "queued", error_code: null, error: null, attempts: 1 });
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2 });
  });

  it("a busy provider (429) is retried in ten minutes and, after five tries, handed to a person", async () => {
    const busy: SendOutcome = { ok: false, kind: "retry", code: "20429", error: "Too many requests" };
    const { store, mock, harness } = await runWith(busy);
    expect(store.channel_messages![0]).toMatchObject({ status: "pending", attempts: 1, error_code: "20429" });
    const due = Date.parse(String(store.campaign_enrollments![0]!.next_due_at));
    expect(due - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(due - Date.now()).toBeLessThan(11 * 60_000);
    for (let attempt = 2; attempt <= MESSAGE_MAX_ATTEMPTS; attempt += 1) {
      store.campaign_enrollments![0]!.next_due_at = PAST;
      mock.script.push(busy);
      // Ten minutes pass between tries, so these failures do not add up to a pause (see the pause tests below).
      resetProviderBreaker();
      await harness.runJob("open-due-steps");
      expect(store.channel_messages![0]).toMatchObject({ attempts: attempt });
    }
    expect(mock.sent).toHaveLength(MESSAGE_MAX_ATTEMPTS);
    expect(store.channel_messages![0]).toMatchObject({ status: "failed" });
    expect(await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).toHaveLength(1);
  });

  it("a refused account or sender keeps the step due and asks nobody", async () => {
    const { store, issues, harness } = await runWith({ ok: false, kind: "config", code: "20003", error: "Authenticate" });
    expect(issues).toHaveLength(0);
    expect(store.channel_messages![0]).toMatchObject({ status: "pending", error_code: "20003" });
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "running", step_position: 1, open_issue_id: null });
    // The Cockpit goes red for it.
    expect(await messagingHealth(harness.ctx, CO)).toEqual([expect.objectContaining({ key: "campaigns:messaging", status: "bad", detail: expect.stringContaining("code 20003") })]);
  });

  describe("a provider that keeps failing", () => {
    const CONTACTS = ["c1", "c2", "c3", "c4", "c5", "c6"];
    /** Six people with a mobile number and an opt-in, all due now. */
    function crowd(): Store {
      const store = textStore();
      store.crm_contacts = CONTACTS.map((id, i) => contact(id, `Person ${i + 1}`, [`${id}@x.test`], { phones: [`082 000 000${i + 1}`] }));
      for (const [i, id] of CONTACTS.entries()) {
        store.channel_consents!.push(consent(`+2782000000${i + 1}`));
        store.campaign_enrollments!.push(enrollment(`e-${id}`, "camp-sms", id, { next_due_at: PAST }));
      }
      return store;
    }
    const unknown: SendOutcome = { ok: false, kind: "unknown", code: null, error: "No answer from Twilio (TimeoutError)." };
    const refused: SendOutcome = { ok: false, kind: "config", code: "20003", error: "Authenticate" };
    const jobIssues = (harness: Awaited<ReturnType<typeof bootSms>>["harness"]) => harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });

    it("an outage opens a few issues, not one per contact: after three failures in a row the rest wait, untouched", async () => {
      const store = crowd();
      const { harness, mock } = await bootSms({ store });
      mock.script.push(unknown, unknown, unknown);
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      expect(await jobIssues(harness)).toHaveLength(BREAKER_FAILURES);
      // The other three were not called, claimed, or handed to anybody: they are still due.
      expect(store.channel_messages).toHaveLength(BREAKER_FAILURES);
      const waiting = store.campaign_enrollments!.filter((row) => !row.open_issue_id);
      expect(waiting).toHaveLength(3);
      for (const row of waiting) expect(row).toMatchObject({ status: "running", step_position: 1, next_due_at: PAST });
      // The next runs leave the provider alone while it is paused.
      await harness.runJob("open-due-steps");
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      expect(await jobIssues(harness)).toHaveLength(BREAKER_FAILURES);
      expect(harness.logs.filter((entry) => entry.message.startsWith("Messaging provider paused for ten minutes"))).toHaveLength(1);
    });

    it("goes on after the pause: a waiting step is sent, and the good answer clears the count", async () => {
      const store = crowd();
      const { harness, mock } = await bootSms({ store });
      mock.script.push(unknown, unknown, unknown);
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      const waiting = store.campaign_enrollments!.find((row) => !row.open_issue_id)!;
      const input = async (now: Date) => ({
        campaign: (await getCampaign(harness.ctx, "camp-sms"))!,
        enrollment: (await enrollmentById(harness.ctx, String(waiting.id)))!,
        steps: await listSteps(harness.ctx, "camp-sms"),
        now,
      });
      const first = await input(new Date());
      // Still inside the pause: nothing is sent, nothing is claimed, the step stays due.
      expect(await sendMessagingStep(harness.ctx, { ...first, step: first.steps[0]! })).toBe("deferred");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      // Once the pause is over the provider is asked again, and one good answer clears the failures.
      const later = new Date(Date.now() + BREAKER_PAUSE_MS + 60_000);
      const second = await input(later);
      expect(await sendMessagingStep(harness.ctx, { ...second, step: second.steps[0]!, now: later })).toBe("sent");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES + 1);
      expect(providerPaused(CO, later.getTime())).toBe(false);
      expect(recordProviderResult(CO, false, later.getTime())).toBe(false);
      resetProviderBreaker();
    });

    it("a refused account is asked three times, not once per contact every five minutes", async () => {
      const store = crowd();
      const { harness, mock } = await bootSms({ store });
      mock.script.push(refused, refused, refused);
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(BREAKER_FAILURES);
      // Nothing was lost or handed over: every step is still due, nobody is asked.
      expect(await jobIssues(harness)).toHaveLength(0);
      expect(store.campaign_enrollments!.every((row) => row.status === "running" && row.step_position === 1)).toBe(true);
      // The pause ends (or an operator resets it) and the same steps go out.
      resetProviderBreaker();
      await harness.runJob("open-due-steps");
      expect(mock.sent.length).toBeGreaterThan(BREAKER_FAILURES);
    });

    it("failures with a good answer between them, and answers about a recipient, never pause it", async () => {
      const store = crowd();
      const { harness, mock } = await bootSms({ store });
      const bad: SendOutcome = { ok: false, kind: "rejected", code: "21211", error: "Invalid 'To' Phone Number", invalidRecipient: true };
      mock.script.push(unknown, unknown, { ok: true, providerId: "SM1", status: "queued", segments: 1 }, unknown, unknown, bad);
      await harness.runJob("open-due-steps");
      expect(mock.sent).toHaveLength(6);
      expect(providerPaused(CO)).toBe(false);
    });

    it("counts failures in the last ten minutes only, so a lone message retried every ten minutes never pauses the provider", () => {
      resetProviderBreaker();
      const t0 = 1_000_000_000;
      expect(recordProviderResult(CO, false, t0)).toBe(false);
      expect(recordProviderResult(CO, false, t0 + BREAKER_PAUSE_MS + 1_000)).toBe(false);
      expect(recordProviderResult(CO, false, t0 + 2 * (BREAKER_PAUSE_MS + 1_000))).toBe(false);
      expect(providerPaused(CO, t0 + 2 * (BREAKER_PAUSE_MS + 1_000))).toBe(false);
      // Three in quick succession do.
      expect(recordProviderResult(CO, false, t0 + 3_000_000)).toBe(false);
      expect(recordProviderResult(CO, false, t0 + 3_000_100)).toBe(false);
      expect(recordProviderResult(CO, false, t0 + 3_000_200)).toBe(true);
      expect(providerPaused(CO, t0 + 3_000_300)).toBe(true);
      expect(providerPaused(CO, t0 + 3_000_200 + BREAKER_PAUSE_MS + 1)).toBe(false);
      resetProviderBreaker();
    });
  });

  it("a number the provider blocked after STOP goes on the sender's list and stops the enrollment", async () => {
    const { store, issues } = await runWith({ ok: false, kind: "rejected", code: "21610", error: "unsubscribed recipient", optedOut: true });
    expect(issues).toHaveLength(0);
    expect(store.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, reason: "provider_opt_out", sender_key: "own", scope: "marketing" })]);
    expect(store.campaign_enrollments![0]).toMatchObject({ status: "stopped" });
    expect(store.channel_messages![0]).toMatchObject({ status: "failed", error_code: "21610" });
  });

  it("a number that cannot be messaged is blocked for every sender and the contact is handed to a person", async () => {
    const { store, issues } = await runWith({ ok: false, kind: "rejected", code: "21211", error: "Invalid 'To' Phone Number", invalidRecipient: true });
    expect(store.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, reason: "invalid_number", scope: "all" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.description).toContain("do-not-message list");
  });

  it("a WhatsApp message with no template tells the person what to do", async () => {
    const store = textStore({ steps: [{ ...step("camp-sms", 1, "a", "", "Hello {{first_name}}"), channel: "whatsapp" }] });
    store.channel_consents!.push(consent(ADA, { channel: "whatsapp" }));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    mock.script.push({ ok: false, kind: "rejected", code: "63016", error: "outside the allowed window", needsTemplate: true });
    await harness.runJob("open-due-steps");
    const [issue] = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issue!.title).toMatch(/^WhatsApp not sent/);
    expect(issue!.description).toContain("approved template");
    expect(issue!.description).toContain("templateRef");
  });

  it("a message over the provider's limit is handed to a person without calling the provider", async () => {
    const long = "word ".repeat(400);
    const store = textStore({ steps: [{ ...step("camp-sms", 1, "a", "", long), channel: "sms" }] });
    store.channel_consents!.push(consent(ADA));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    const [issue] = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issue!.description).toMatch(/1600/);
  });
});

describe("a WhatsApp template step", () => {
  it("is sent with the approved template and the person's details in its numbered variables", async () => {
    const template = { ...step("camp-sms", 1, "a", "", "Hi {{first_name}}, your order from {{company}} is ready. Reply STOP to opt out."), channel: "whatsapp", template_ref: "HX0123456789abcdef0123456789abcdef", template_vars: ["{{first_name}}", "{{company}}"] };
    const store = textStore({ steps: [template] });
    store.channel_consents!.push(consent(ADA, { channel: "whatsapp" }));
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toEqual([expect.objectContaining({ channel: "whatsapp", to: ADA, from: WHATSAPP_NUMBER, template: { ref: "HX0123456789abcdef0123456789abcdef", vars: { "1": "Ada", "2": "Acme Plumbing" } } })]);
  });
});

describe("held campaigns", () => {
  it("log once an hour per campaign, not once per contact per run", async () => {
    const store = textStore();
    for (const id of ["e1", "e2", "e3"]) store.campaign_enrollments!.push(enrollment(id, "camp-sms", "ada", { next_due_at: PAST }));
    const { harness } = await bootSms({ store, noProvider: true });
    await harness.runJob("open-due-steps");
    await harness.runJob("open-due-steps");
    expect(harness.logs.filter((entry) => entry.message === "Campaign message held: channel not ready")).toHaveLength(1);
  });
});

describe("mixed campaigns", () => {
  it("a person who cannot get the SMS still gets the email step that follows it", async () => {
    const steps = [{ ...step("camp-sms", 1, "a", "", "Text first"), channel: "sms" }, { ...step("camp-sms", 2, "a", "Then email", "Email body"), channel: "email" }];
    const store = textStore({ steps });
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "ada", { next_due_at: PAST }));
    const { harness, mock } = await bootSms({ store });
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_enrollments![0]).toMatchObject({ step_position: 2 });
    store.campaign_enrollments![0]!.next_due_at = PAST;
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox![0]!.payload).toMatchObject({ subject: "Then email", to: [{ email: "ada@acme.test" }] });
  });
});

describe("sender identities for texts", () => {
  it("reads the number for a client from its identity", async () => {
    const store = textStore();
    store.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: null, from_name: null, reply_to: null, sms_from: "+27820000001", whatsapp_from: null }];
    const { harness } = await bootSms({ store });
    expect((await listSenderIdentityRows(harness.ctx, CO)).map((row) => row.sender_key)).toEqual(["company:acme"]);
  });
});
