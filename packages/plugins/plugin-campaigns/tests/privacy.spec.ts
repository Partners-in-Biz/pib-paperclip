import { describe, expect, it } from "vitest";
import { consentKey, HANDOFF_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { addressHash, blockedAddresses, isSuppressed } from "../src/db.js";
import { boot, campaign, CO, contact, enrollment, PAST, seed, seedIssue, step } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

const CRM = "plugin.partnersinbiz.crm";
const ADA = "+27821234567";
const BOB = "+27835550001";

function personalStore(): Store {
  const s = seed();
  s.crm_contacts = [
    contact("ada", "Ada Lovelace", ["ada@acme.test"], { phones: ["082 123 4567"], tags: ["vip"] }),
    contact("bob", "Bob Builder", ["bob@beta.test"], { phones: ["083 555 0001"], tags: ["vip"] }),
  ];
  s.campaigns!.push(campaign("camp-own", { delivery: "auto" }));
  s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"), step("camp-own", 2, "a", "Again", "Again", 2));
  s.campaign_enrollments!.push(
    enrollment("e-ada", "camp-own", "ada", { open_issue_id: "iss-step-ada" }),
    enrollment("e-bob", "camp-own", "bob", { open_issue_id: "iss-step-bob" }),
  );
  const ev = (enrollmentId: string, type: string, key: string) => ({ id: `ev-${key}`, company_id: CO, campaign_id: "camp-own", enrollment_id: enrollmentId, step_position: 1, event_type: type, variant: "a", source_key: key, meta: null, occurred_at: PAST });
  s.campaign_step_events!.push(ev("e-ada", "sent", "sent:a"), ev("e-ada", "reply", "reply:m-1"), ev("e-bob", "sent", "sent:b"));
  s.reply_log = [
    { id: "rl-a", company_id: CO, message_id: "m-1", campaign_id: "camp-own", enrollment_id: "e-ada", outcome: "answered", note: "Called Ada on her mobile", mail_draft_id: null, created_by: null },
    { id: "rl-b", company_id: CO, message_id: "m-9", campaign_id: "camp-own", enrollment_id: "e-bob", outcome: "answered", note: "x", mail_draft_id: null, created_by: null },
  ];
  s.outbox!.push(
    { key: "campaigns:step:e-ada:1", company_id: CO, event: "mail.send.requested", payload: { to: [{ email: "ada@acme.test" }], text: "Hello Ada" }, status: "done", attempts: 1 },
    { key: "campaigns:step:e-bob:1", company_id: CO, event: "mail.send.requested", payload: { to: [{ email: "bob@beta.test" }], text: "Hello Bob" }, status: "done", attempts: 1 },
  );
  s.channel_messages = [
    { key: "campaigns:msg:e-ada:1", company_id: CO, campaign_id: "camp-own", enrollment_id: "e-ada", step_position: 1, channel: "sms", to_address: ADA, contact_id: "ada", sender_key: "own", body: "Hi Ada", status: "sent", attempts: 1 },
    { key: "campaigns:msg:e-bob:1", company_id: CO, campaign_id: "camp-own", enrollment_id: "e-bob", step_position: 1, channel: "sms", to_address: BOB, contact_id: "bob", sender_key: "own", body: "Hi Bob", status: "sent", attempts: 1 },
  ];
  s.channel_consents = [
    { company_id: CO, channel: "sms", address: ADA, sender_key: "own", granted: true, basis: "consent", source: "form", evidence: "form", recorded_at: PAST },
    { company_id: CO, channel: "sms", address: BOB, sender_key: "own", granted: true, basis: "consent", source: "form", evidence: "form", recorded_at: PAST },
  ];
  s.suppressions!.push(
    { company_id: CO, email: "ada@acme.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada", campaign_id: null, sender_key: "own" },
    { company_id: CO, email: "bob@beta.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "bob", campaign_id: null, sender_key: "own" },
  );
  s.channel_suppressions = [{ company_id: CO, channel: "sms", address: ADA, sender_key: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada", campaign_id: null }];
  return s;
}

const erase = (over: Record<string, unknown> = {}) => ({
  requestId: "req-1", subject: { email: "ada@acme.test", phone: "082 123 4567", contactId: "ada" }, scope: "all", reason: "data_subject_request",
  approvedByUserId: "user-peet", requestedAt: "2026-10-03T08:00:00Z", source: "partnersinbiz.crm", ...over,
});

async function seededBoot(s = personalStore()) {
  const booted = await boot({ store: s });
  seedIssue(booted.harness, s, { id: "iss-step-ada", status: "todo", assigneeAgentId: "agent-camp", title: "Hi: Ada Lovelace", description: "Hello Ada Lovelace <ada@acme.test>" });
  seedIssue(booted.harness, s, { id: "iss-step-bob", status: "todo", assigneeAgentId: "agent-camp", title: "Hi: Bob Builder", description: "Hello Bob" });
  // Issues Campaigns opened earlier for Ada, found by their origin.
  for (const [id, originId, title] of [["iss-reply-ada", "campaigns:reply:e-ada:m-1", "Reply from Ada Lovelace: Re: Hi"], ["iss-fail-ada", "campaigns:send-failed:e-ada:1", "Email not sent: Hi: Ada Lovelace"], ["iss-other", "campaigns:reply:e-bob:m-9", "Reply from Bob Builder: Re: Hi"]] as const) {
    booted.harness.seed({ issues: [{ id, companyId: CO, title, description: "Ada Lovelace wrote: please call me", status: "done", originKind: "plugin:partnersinbiz.campaigns", originId, assigneeAgentId: null, assigneeUserId: null } as never] });
  }
  return booted;
}

const completed = (emit: { mock: { calls: unknown[][] } }) => emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactEraseCompleted).map((c) => c[2] as Record<string, any>);

describe("contact.erase.requested", () => {
  it("erases the person's campaign data, scrubs their issues, keeps the opt-out as a hash and reports what it kept", async () => {
    const s = personalStore();
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase(), { companyId: CO });
    const [answer] = completed(emit);
    expect(answer).toMatchObject({ requestId: "req-1", plugin: "partnersinbiz.campaigns", status: "erased" });
    expect(answer!.counts).toMatchObject({ enrollments: 1, step_events: 2, reply_log: 1, messages: 1, mail_requests: 1, consents: 1, issues_scrubbed: 3, contact_copies: 1 });
    expect(answer!.retained.map((r: { what: string }) => r.what)).toEqual([expect.stringMatching(/^2 do-not-contact entries \(as a one-way hash/), "comments agents wrote on campaign issues"]);

    // Her rows are gone and Bob's are untouched.
    expect(s.campaign_enrollments!.map((r) => r.id)).toEqual(["e-bob"]);
    expect(s.campaign_step_events!.map((r) => r.enrollment_id)).toEqual(["e-bob"]);
    expect(s.reply_log!.map((r) => r.id)).toEqual(["rl-b"]);
    expect(s.outbox!.map((r) => r.key)).toEqual(["campaigns:step:e-bob:1"]);
    expect(s.channel_messages!.map((r) => r.to_address)).toEqual([BOB]);
    expect(s.channel_consents!.map((r) => r.address)).toEqual([BOB]);
    // The address and number are gone from the lists, but they still block.
    expect(s.suppressions!.map((r) => r.email)).toEqual([addressHash("ada@acme.test"), "bob@beta.test"]);
    expect(s.suppressions![0]).toMatchObject({ contact_id: null });
    expect(JSON.stringify(s.suppressions)).not.toContain("ada@acme.test");
    expect(s.channel_suppressions![0]!.address).toBe(addressHash(ADA));
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "own")).toBe(true);
    expect((await blockedAddresses(harness.ctx, CO, "sms", [ADA], "own")).has(ADA)).toBe(true);
    // The projected copy of the contact is blanked.
    expect(s.crm_contacts![0]).toMatchObject({ name: "[erased]", emails: [], phones: [], tags: [], deleted: true });
    expect(s.crm_contacts![1]).toMatchObject({ name: "Bob Builder" });
    // Issues about her lose their text and close; Bob's are left alone.
    for (const id of ["iss-step-ada", "iss-reply-ada", "iss-fail-ada"]) expect(await harness.ctx.issues.get(id, CO), id).toMatchObject({ title: "Erased contact", status: "cancelled" });
    expect((await harness.ctx.issues.get("iss-reply-ada", CO))!.description).not.toContain("Ada");
    expect(await harness.ctx.issues.get("iss-step-bob", CO)).toMatchObject({ title: "Hi: Bob Builder", status: "todo" });
    expect(await harness.ctx.issues.get("iss-other", CO)).toMatchObject({ title: "Reply from Bob Builder: Re: Hi" });
  });

  it("erases a person who was erased before, came back and opted out again: the old opt-out folds into the hash entry instead of failing", async () => {
    const s = personalStore();
    // The earlier erasure left a hash entry for the same sender; a new, wider opt-out (a hard bounce) arrived since.
    s.suppressions!.push({ company_id: CO, email: addressHash("ada@acme.test"), reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, sender_key: "own" });
    s.suppressions![0] = { ...s.suppressions![0]!, scope: "all", reason: "bounce" };
    s.channel_suppressions!.push({ company_id: CO, channel: "sms", address: addressHash(ADA), sender_key: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null });
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase(), { companyId: CO });
    const [answer] = completed(emit);
    expect(answer!.status).toBe("erased");
    expect(answer!.errors).toBeUndefined();
    // One entry per sender and address, the wider scope kept, and no readable address left.
    expect(s.suppressions!.filter((r) => r.sender_key === "own").map((r) => [r.email, r.scope]).sort()).toEqual([[addressHash("ada@acme.test"), "all"], ["bob@beta.test", "marketing"]].sort());
    expect(s.channel_suppressions!.filter((r) => r.channel === "sms")).toEqual([expect.objectContaining({ address: addressHash(ADA), sender_key: "own" })]);
    expect(JSON.stringify(s.suppressions)).not.toContain("ada@acme.test");
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "own")).toBe(true);
  });

  it("refuses a request no person approved, and erases nothing", async () => {
    const s = personalStore();
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase({ approvedByUserId: "" }), { companyId: CO });
    expect(completed(emit)).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("Not approved by a person") })]);
    expect(s.campaign_enrollments).toHaveLength(2);
    expect(s.suppressions!.map((r) => r.email)).toEqual(["ada@acme.test", "bob@beta.test"]);
  });

  it("runs once: the same request again gets the stored answer and touches nothing new", async () => {
    const s = personalStore();
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase(), { companyId: CO });
    s.campaign_enrollments!.push(enrollment("e-new", "camp-own", "ada"));
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase(), { companyId: CO });
    const answers = completed(emit);
    expect(answers).toHaveLength(2);
    expect(answers[1]).toEqual(answers[0]);
    expect(s.campaign_enrollments!.map((r) => r.id)).toEqual(["e-bob", "e-new"]);
  });

  it("finds the person by email or phone alone, and says nothing was found for someone it never knew", async () => {
    const s = personalStore();
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase({ requestId: "req-2", subject: { email: "BOB@beta.test" } }), { companyId: CO });
    expect(completed(emit)[0]!.counts).toMatchObject({ enrollments: 1, messages: 1 });
    expect(s.campaign_enrollments!.map((r) => r.id)).toEqual(["e-ada"]);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase({ requestId: "req-3", subject: { email: "ghost@nowhere.test" } }), { companyId: CO });
    expect(completed(emit)[1]).toMatchObject({ status: "nothing_found", counts: {} });
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase({ requestId: "req-4", subject: { phone: "+27 82 123 4567" } }), { companyId: CO });
    expect(completed(emit)[2]!.counts).toMatchObject({ enrollments: 1 });
    expect(s.campaign_enrollments).toHaveLength(0);
  });

  it("a request limited to marketing only adds the opt-outs and stops the campaigns, keeping the data", async () => {
    const s = personalStore();
    s.suppressions = [];
    s.channel_suppressions = [];
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.contact.erase.requested` as `plugin.${string}`, erase({ scope: "marketing_only" }), { companyId: CO });
    expect(completed(emit)[0]).toMatchObject({ status: "erased", counts: { enrollments_stopped: 1, opt_outs: 3 } });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "", scope: "marketing" })]);
    expect(s.channel_suppressions!.map((r) => r.channel).sort()).toEqual(["sms", "whatsapp"]);
    expect(s.campaign_enrollments!.find((r) => r.id === "e-ada")).toMatchObject({ status: "stopped" });
    expect(s.channel_messages).toHaveLength(2);
    expect(await harness.ctx.issues.get("iss-step-ada", CO)).toMatchObject({ status: "cancelled", title: "Hi: Ada Lovelace" });
  });

  it("does not answer a request that does not come from the CRM", async () => {
    const s = personalStore();
    const { harness, emit } = await seededBoot(s);
    await harness.emit("plugin.partnersinbiz.mailbox.contact.erase.requested" as `plugin.${string}`, erase(), { companyId: CO });
    expect(completed(emit)).toHaveLength(0);
    expect(s.campaign_enrollments).toHaveLength(2);
  });
});

describe("consent.recorded", () => {
  const consent = (over: Record<string, unknown> = {}) => {
    const subject = (over.subject as Record<string, unknown>) ?? { phone: "0821234567", contactId: "ada" };
    const recordedAt = String(over.recordedAt ?? "2026-10-01T08:00:00Z");
    return { key: consentKey(subject, "marketing_sms", recordedAt) ?? "k", purpose: "marketing_sms", basis: "consent", granted: true, source: "form", evidence: { wording: "Ticked SMS offers" }, recordedAt, recordedBy: "partnersinbiz.crm", ...over, subject };
  };

  it("an SMS opt-in from the CRM is stored for the sender it names, and a client's is not PiB's", async () => {
    const s = seed();
    const { harness } = await boot({ store: s });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent(), { companyId: CO });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ subject: { phone: "083 555 0001", clientKind: "company", clientRef: "acme" } }), { companyId: CO });
    expect(s.channel_consents).toEqual([
      expect.objectContaining({ channel: "sms", address: ADA, sender_key: "own", granted: true, source: "form", evidence: "Ticked SMS offers", recorded_by: "partnersinbiz.crm" }),
      expect.objectContaining({ address: BOB, sender_key: "company:acme", granted: true }),
    ]);
  });

  it("an older record never overwrites a newer one", async () => {
    const s = seed();
    const { harness } = await boot({ store: s });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ recordedAt: "2026-10-02T08:00:00Z", granted: true }), { companyId: CO });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ recordedAt: "2026-10-01T08:00:00Z", granted: false }), { companyId: CO });
    expect(s.channel_consents).toEqual([expect.objectContaining({ granted: true })]);
    expect(s.channel_suppressions ?? []).toHaveLength(0);
  });

  it("a withdrawal with no client puts the number on PiB's own list and stops PiB's own campaigns, without announcing it back", async () => {
    const s = personalStore();
    s.channel_suppressions = [];
    const { harness, emit } = await seededBoot(s);
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ granted: false, recordedAt: "2026-10-03T08:00:00Z" }), { companyId: CO });
    expect(s.channel_consents!.find((r) => r.address === ADA)).toMatchObject({ granted: false, sender_key: "own" });
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, sender_key: "own", reason: "consent_withdrawn", source: "partnersinbiz.crm" })]);
    expect(s.campaign_enrollments!.find((r) => r.id === "e-ada")).toMatchObject({ status: "stopped" });
    expect(emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.consentRecorded)).toHaveLength(0);
  });

  /** Ada is in PiB's own campaign and in two clients' campaigns. */
  function threeSenders(): Store {
    const s = personalStore();
    s.channel_suppressions = [];
    s.suppressions = [];
    s.campaigns!.push(
      campaign("camp-acme", { delivery: "auto", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
      campaign("camp-beta", { delivery: "auto", client_kind: "company", client_ref: "beta", client_name: "Beta Builders" }),
    );
    s.campaign_steps!.push(step("camp-acme", 1, "a", "Hi", "Hello"), step("camp-beta", 1, "a", "Hi", "Hello"));
    s.campaign_enrollments!.push(enrollment("e-ada-acme", "camp-acme", "ada"), enrollment("e-ada-beta", "camp-beta", "ada"));
    return s;
  }
  const status = (s: Store, id: string) => s.campaign_enrollments!.find((r) => r.id === id)!.status;

  it("a client's SMS withdrawal (the subject names the client) silences that client only, never PiB or another client", async () => {
    const s = threeSenders();
    const { harness } = await seededBoot(s);
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ granted: false, recordedAt: "2026-10-03T08:00:00Z", subject: { phone: "0821234567", contactId: "ada", clientKind: "company", clientRef: "acme" } }), { companyId: CO });
    expect(s.channel_consents!.filter((r) => r.address === ADA && r.granted === false)).toEqual([expect.objectContaining({ sender_key: "company:acme" })]);
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, sender_key: "company:acme", reason: "consent_withdrawn" })]);
    expect((await blockedAddresses(harness.ctx, CO, "sms", [ADA], "company:acme")).has(ADA)).toBe(true);
    expect((await blockedAddresses(harness.ctx, CO, "sms", [ADA], "own")).has(ADA)).toBe(false);
    expect((await blockedAddresses(harness.ctx, CO, "sms", [ADA], "company:beta")).has(ADA)).toBe(false);
    expect(status(s, "e-ada-acme")).toBe("stopped");
    expect(status(s, "e-ada")).toBe("running");
    expect(status(s, "e-ada-beta")).toBe("running");
  });

  it("a client's email unsubscribe announced as a consent withdrawal (what the Mailbox sends) silences that client only", async () => {
    const s = threeSenders();
    const { harness } = await seededBoot(s);
    const unsubscribe = { subject: { email: "ada@acme.test", clientKind: "company", clientRef: "acme" }, purpose: "marketing_email", granted: false, source: "unsubscribe_link", recordedBy: "partnersinbiz.mailbox" };
    await harness.emit("plugin.partnersinbiz.mailbox.consent.recorded" as `plugin.${string}`, consent(unsubscribe), { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "company:acme", reason: "unsubscribe", scope: "marketing" })]);
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "company:acme")).toBe(true);
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "own")).toBe(false);
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "company:beta")).toBe(false);
    expect(status(s, "e-ada-acme")).toBe("stopped");
    expect(status(s, "e-ada")).toBe("running");
    expect(status(s, "e-ada-beta")).toBe("running");
    // The same person leaving a different client's list later does not touch the first one.
    await harness.emit("plugin.partnersinbiz.mailbox.consent.recorded" as `plugin.${string}`, consent({ ...unsubscribe, subject: { email: "ada@acme.test", clientKind: "contact", clientRef: "ct-9" } }), { companyId: CO });
    expect(s.suppressions!.map((r) => r.sender_key).sort()).toEqual(["company:acme", "contact:ct-9"]);
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "own")).toBe(false);
  });

  it("an email withdrawal with no client is PiB's own unsubscribe, not a client's; other purposes and unreadable subjects are ignored", async () => {
    const s = threeSenders();
    const { harness } = await seededBoot(s);
    const email = { subject: { email: "ada@acme.test" }, purpose: "marketing_email", granted: false };
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent(email), { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "own", reason: "unsubscribe" })]);
    expect(await isSuppressed(harness.ctx, CO, "ada@acme.test", "company:acme")).toBe(false);
    expect(status(s, "e-ada")).toBe("stopped");
    expect(status(s, "e-ada-acme")).toBe("running");
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ purpose: "profiling" }), { companyId: CO });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, consent({ subject: { phone: "12" }, key: "k2" }), { companyId: CO });
    await harness.emit(`${CRM}.consent.recorded` as `plugin.${string}`, { nonsense: true }, { companyId: CO });
    expect(s.channel_consents!.filter((r) => r.granted === true)).toHaveLength(2);
    expect(s.suppressions).toHaveLength(1);
  });
});

describe("record-channel-consent", () => {
  const AGENT = { companyId: CO, agentId: "agent-camp" };
  const evidence = "Ticked SMS offers on the Acme sign-up form on 2026-09-14";
  const call = (harness: Awaited<ReturnType<typeof boot>>["harness"], params: Record<string, unknown>) => harness.executeTool<{ data?: Record<string, any>; error?: string }>("record-channel-consent", params, AGENT);

  it("records opt-ins with their evidence for the people given, for the sender named", async () => {
    const s = seed();
    s.crm_contacts![0]!.phones = ["082 123 4567"];
    s.crm_contacts![1]!.phones = ["011 123 4567"];
    const { harness } = await boot({ store: s });
    const out = await call(harness, { channel: "sms", contactIds: ["ada", "bob", "ghost"], phones: ["083 555 0001", "12"], client: "company:acme", evidence });
    expect(out.data).toMatchObject({ channel: "sms", sender: "company:acme", granted: true, recorded: 2 });
    expect(out.data!.skipped).toEqual(expect.arrayContaining(["bob: no mobile number", "ghost: not found in the CRM"]));
    expect(s.channel_consents).toEqual([
      expect.objectContaining({ address: ADA, sender_key: "company:acme", contact_id: "ada", basis: "consent", source: "manual", evidence, recorded_by: "agent:agent-camp" }),
      expect.objectContaining({ address: BOB, sender_key: "company:acme", contact_id: null }),
    ]);
  });

  it("refuses what it must: no evidence, a contract basis for WhatsApp, nobody named, too many, a bad channel or source", async () => {
    const { harness } = await boot({ store: seed() });
    expect((await call(harness, { channel: "sms", contactIds: ["ada"], evidence: "yes" })).error).toMatch(/evidence must say what the person agreed to/);
    expect((await call(harness, { channel: "sms", contactIds: ["ada"] })).error).toMatch(/evidence is required/);
    expect((await call(harness, { channel: "whatsapp", contactIds: ["ada"], basis: "contract", evidence })).error).toMatch(/WhatsApp needs the person's own opt-in/);
    expect((await call(harness, { channel: "sms", evidence })).error).toMatch(/Give contactIds/);
    expect((await call(harness, { channel: "sms", phones: Array.from({ length: 201 }, (_v, i) => `+2782000${String(i).padStart(4, "0")}`), evidence })).error).toMatch(/At most 200/);
    expect((await call(harness, { channel: "email", contactIds: ["ada"], evidence })).error).toMatch(/channel must be sms or whatsapp/);
    expect((await call(harness, { channel: "sms", contactIds: ["ada"], evidence, source: "telepathy" })).error).toMatch(/source must be one of/);
    expect((await call(harness, { channel: "sms", contactIds: ["ada"], evidence, basis: "vibes" })).error).toMatch(/basis must be consent or contract/);
  });

  it("granted false records an opt-out instead: the number is blocked and their campaigns stop", async () => {
    const s = personalStore();
    s.channel_suppressions = [];
    const { harness } = await seededBoot(s);
    const out = await call(harness, { channel: "sms", contactIds: ["ada"], evidence: "Said on the phone on 2026-10-03 that she wants no more texts", granted: false });
    expect(out.data).toMatchObject({ granted: false, recorded: 1 });
    expect(s.channel_consents!.find((r) => r.address === ADA)).toMatchObject({ granted: false });
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, reason: "manual", sender_key: "own" })]);
    expect(s.campaign_enrollments!.find((r) => r.id === "e-ada")).toMatchObject({ status: "stopped" });
  });

  it("suppress-phone blocks a number for one sender or for all, on one channel or both", async () => {
    const s = personalStore();
    s.channel_suppressions = [];
    const { harness } = await seededBoot(s);
    const first = await harness.executeTool<{ data: Record<string, any> }>("suppress-phone", { phone: "082 123 4567", channel: "sms", client: "company:acme" }, AGENT);
    expect(first.data).toMatchObject({ phone: "+27*****4567", channels: ["sms"], sender: "company:acme", stoppedEnrollments: 0 });
    const all = await harness.executeTool<{ data: Record<string, any> }>("suppress-phone", { phone: "+27821234567" }, AGENT);
    expect(all.data).toMatchObject({ channels: ["sms", "whatsapp"], sender: "every sender", stoppedEnrollments: 1 });
    expect(s.channel_suppressions!.map((r) => [r.channel, r.sender_key])).toEqual([["sms", "company:acme"], ["sms", ""], ["whatsapp", ""]]);
    expect((await harness.executeTool<{ error?: string }>("suppress-phone", { phone: "abc" }, AGENT)).error).toMatch(/phone must be a phone number/);
    expect((await harness.executeTool<{ error?: string }>("suppress-phone", { phone: ADA, channel: "fax" }, AGENT)).error).toMatch(/channel must be sms, whatsapp or both/);
  });
});
