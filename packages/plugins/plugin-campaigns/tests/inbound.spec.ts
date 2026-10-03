import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { INBOUND_READ_CAP, setMessagingProvider } from "../src/messaging.js";
import { boot, campaign, CO, contact, enrollment, PUBLIC_URL, seed, seedIssue, step } from "./helpers/harness.js";
import { MockProvider, reply } from "./helpers/mock-provider.js";
import type { Store } from "./helpers/fake-db.js";

const TZ = "Africa/Johannesburg";
const ADA = "+27821234567";
const BOB = "+27835550001";
const OWN_NUMBER = "+14155550100";
const CLIENT_NUMBER = "+27820000001";
const OPEN = { weekdays: "00:00-24:00", saturday: "00:00-24:00", sunday: "00:00-24:00" };
const SECRET = "0123456789abcdef-shared-secret";

afterEach(() => {
  setMessagingProvider(null);
  vi.unstubAllGlobals();
});

function store(): Store {
  const s = seed();
  s.crm_contacts = [
    contact("ada", "Ada Lovelace", ["ada@acme.test"], { phones: ["082 123 4567"], account_ids: ["acme"] }),
    contact("bob", "Bob Builder", ["bob@beta.test"], { phones: ["083 555 0001"] }),
  ];
  s.campaigns!.push(
    campaign("camp-own", { delivery: "auto" }),
    campaign("camp-acme", { delivery: "auto", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
  );
  s.campaign_steps!.push(
    ...["camp-own", "camp-acme"].flatMap((id) => [{ ...step(id, 1, "a", "", "Hello"), channel: "sms" }, { ...step(id, 2, "a", "", "Again", 2), channel: "sms" }]),
  );
  s.channel_consents = [];
  s.channel_suppressions = [];
  s.channel_messages = [];
  s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: null, from_name: "Acme Plumbing", reply_to: null, sms_from: CLIENT_NUMBER, whatsapp_from: null }];
  return s;
}

const sentMessage = (enrollmentId: string, campaignId: string, to: string, senderKey: string, extra: Record<string, unknown> = {}) => ({
  key: `campaigns:msg:${enrollmentId}:1`, company_id: CO, campaign_id: campaignId, enrollment_id: enrollmentId, step_position: 1, channel: "sms", to_address: to, contact_id: "ada",
  sender_key: senderKey, body: "x", segments: 1, status: "sent", provider_id: `SMsent${enrollmentId}`, provider_status: "queued", error_code: null, error: null, attempts: 1, created_at: new Date().toISOString(), ...extra,
});

async function bootInbound(options: { store?: Store; jev?: boolean; messaging?: Record<string, unknown> } = {}) {
  const mock = new MockProvider();
  const s = options.store ?? store();
  const config = {
    timezone: TZ,
    publicBaseUrl: PUBLIC_URL,
    ...(options.jev ? { jev: { apiKey: "test-key" } } : {}),
    messaging: { smsFrom: OWN_NUMBER, ...OPEN, inboundWebhookSecret: SECRET, ...options.messaging },
  };
  const booted = await boot({ store: s, config });
  setMessagingProvider(() => mock);
  return { ...booted, mock, store: s };
}

const consentEvents = (emit: { mock: { calls: unknown[][] } }) => emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.consentRecorded).map((call) => call[2] as Record<string, any>);

describe("STOP words", () => {
  it("put the number on that sender's list, stop their campaigns, cancel the open step issue and tell the CRM", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada", { open_issue_id: "step-iss" }), enrollment("e-bob", "camp-own", "bob"));
    const { harness, mock, emit, comments } = await bootInbound({ store: s });
    seedIssue(harness, s, { id: "step-iss", status: "todo", assigneeAgentId: "agent-camp" });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "STOP", "SMstop1"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ channel: "sms", address: ADA, sender_key: "own", reason: "stop_keyword", scope: "marketing", contact_id: "ada" })]);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-own")).toMatchObject({ status: "stopped" });
    // Somebody else's campaign is not touched.
    expect(s.campaign_enrollments!.find((row) => row.id === "e-bob")).toMatchObject({ status: "running" });
    expect(await harness.ctx.issues.get("step-iss", CO)).toMatchObject({ status: "cancelled" });
    expect(String(comments.mock.calls.find(([id]) => id === "step-iss")?.[1])).toMatch(/Do not send this/);
    // The CRM hears it as a withdrawn consent, with the number but no message text.
    expect(consentEvents(emit)).toEqual([expect.objectContaining({ purpose: "marketing_sms", granted: false, source: "reply", subject: expect.objectContaining({ phone: ADA, contactId: "ada" }), recordedBy: "partnersinbiz.campaigns" })]);
    expect(JSON.stringify(consentEvents(emit))).not.toContain("STOP\"");
    // Reading the same message again changes nothing and announces nothing.
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toHaveLength(1);
    expect(consentEvents(emit)).toHaveLength(1);
    expect(s.inbox!.map((row) => row.key)).toEqual(["msg:sms:SMstop1"]);
  });

  it("stop only the sender whose number was texted: a STOP to a client's number leaves PiB's own campaign running", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-acme", "camp-acme", "ada"));
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, CLIENT_NUMBER, "Stop", "SMstop2"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, sender_key: "company:acme" })]);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-acme")).toMatchObject({ status: "stopped" });
    expect(s.campaign_enrollments!.find((row) => row.id === "e-own")).toMatchObject({ status: "running" });
  });

  it("a STOP to a client's number reaches the CRM as that client's withdrawn consent, never as PiB's own", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-acme", "camp-acme", "ada"));
    const { harness, mock, emit } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, CLIENT_NUMBER, "STOP", "SMclient1"));
    await harness.runJob("poll-messaging");
    expect(consentEvents(emit)).toEqual([expect.objectContaining({ granted: false, subject: expect.objectContaining({ phone: ADA, clientKind: "company", clientRef: "acme" }) })]);
    // PiB's own number: no client in the subject.
    mock.inboundQueue.push(reply(BOB, OWN_NUMBER, "STOP", "SMown1"));
    await harness.runJob("poll-messaging");
    const own = consentEvents(emit).find((e) => e.subject.phone === BOB)!;
    expect(own.subject.clientRef).toBeNull();
    expect(own.subject.clientKind).toBeNull();
  });

  it("a START to a client's number is announced for that client too", async () => {
    const s = store();
    s.channel_suppressions!.push({ company_id: CO, channel: "sms", address: ADA, sender_key: "company:acme", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada", campaign_id: null });
    const { harness, mock, emit } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, CLIENT_NUMBER, "START", "SMstart9"));
    await harness.runJob("poll-messaging");
    expect(consentEvents(emit)).toEqual([expect.objectContaining({ granted: true, subject: expect.objectContaining({ phone: ADA, clientKind: "company", clientRef: "acme" }) })]);
  });

  it("sent to a number the plugin does not know, stop everything (the safe side)", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-acme", "camp-acme", "ada"));
    const { harness } = await bootInbound({ store: s });
    // Webhook-forwarded: a number that is neither the company's nor any identity's.
    await plugin.definition.onWebhook!({ endpointKey: "messaging-inbound", headers: { "x-pib-webhook-secret": SECRET }, rawBody: "", parsedBody: { companyId: CO, MessageSid: "SMx1", From: ADA, To: "+27829999999", Body: "STOP" }, requestId: "r1" });
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ sender_key: "" })]);
    expect(s.campaign_enrollments!.every((row) => row.status === "stopped")).toBe(true);
    void harness;
  });

  it("are recognised in a sentence that plainly asks to stop, and not in one that merely contains the word", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-bob", "camp-own", "bob"));
    s.channel_messages!.push(sentMessage("e-bob", "camp-own", BOB, "own", { contact_id: "bob" }));
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "Please stop texting me", "SMa"), reply(BOB, OWN_NUMBER, "Can you cancel my appointment?", "SMb"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions!.map((row) => row.address)).toEqual([ADA]);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-bob")).toMatchObject({ status: "running" });
  });
});

describe("START words", () => {
  it("lift the person's own opt-out and record a fresh opt-in, but never a block a person set", async () => {
    const s = store();
    s.channel_suppressions!.push(
      { company_id: CO, channel: "sms", address: ADA, sender_key: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "ada", campaign_id: null },
      { company_id: CO, channel: "sms", address: BOB, sender_key: "own", reason: "manual", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: "bob", campaign_id: null },
    );
    const { harness, mock, emit } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "START", "SMs1"), reply(BOB, OWN_NUMBER, "unstop", "SMs2"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions!.map((row) => row.address)).toEqual([BOB]);
    expect(s.channel_consents).toEqual(expect.arrayContaining([expect.objectContaining({ address: ADA, sender_key: "own", granted: true, source: "reply", basis: "consent" })]));
    expect(consentEvents(emit).filter((e) => e.granted === true).map((e) => e.subject.phone).sort()).toEqual([ADA, BOB]);
  });

  it("HELP is the provider's to answer: nothing is recorded", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "HELP", "SMh"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toHaveLength(0);
    expect(s.channel_consents).toHaveLength(0);
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);
  });
});

describe("other replies", () => {
  it("open an issue for the campaign's agent with the message, say that texts cannot be answered here, and can be logged", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"));
    s.channel_messages!.push(sentMessage("e-own", "camp-own", ADA, "own"));
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "Sounds good, call me tomorrow", "SMr1"));
    await harness.runJob("poll-messaging");
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "Check reply from Ada Lovelace (SMS)", assigneeAgentId: "agent-camp" });
    expect(issues[0]!.description).toContain("> Sounds good, call me tomorrow");
    expect(issues[0]!.description).toContain("cannot answer a text");
    expect(issues[0]!.description).toContain("messageId `SMr1`");
    expect(s.campaign_step_events).toEqual([expect.objectContaining({ event_type: "reply", source_key: "reply:SMr1", meta: expect.objectContaining({ channel: "sms" }) })]);
    // The agent logs what it did, using the provider's message id, and the done check accepts it.
    const logged = await harness.executeTool<{ data?: { logged: boolean }; error?: string }>("log-reply", { messageId: "SMr1", outcome: "answered", note: "Called Ada and booked Tuesday" }, { companyId: CO, agentId: "agent-camp" });
    expect(logged.data).toMatchObject({ logged: true });
  });

  it("read as interested by Jev, stop that campaign for the person and open a follow-up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { reply_kind: { type: "choice", choice: "interested", probabilities: { interested: 0.97 }, confidence: 0.97 } } }), { status: 200 })));
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"));
    s.channel_messages!.push(sentMessage("e-own", "camp-own", ADA, "own"));
    const { harness, mock } = await bootInbound({ store: s, jev: true });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "Yes please, send a quote", "SMr2"));
    await harness.runJob("poll-messaging");
    expect(s.campaign_enrollments![0]).toMatchObject({ status: "stopped" });
    const [issue] = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issue!.title).toBe("Reply from Ada Lovelace (SMS)");
    // Jev saw the words but never the number.
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body));
    expect(JSON.stringify(sent)).not.toContain("82123");
  });

  it("an opt-out said in their own words, read by Jev, goes on the list of the sender that texted them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { reply_kind: { type: "choice", choice: "unsubscribe", probabilities: { unsubscribe: 0.96 }, confidence: 0.96 } } }), { status: 200 })));
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-acme", "camp-acme", "ada"), enrollment("e-own", "camp-own", "ada"));
    s.channel_messages!.push(sentMessage("e-acme", "camp-acme", ADA, "company:acme"));
    const { harness, mock } = await bootInbound({ store: s, jev: true });
    mock.inboundQueue.push(reply(ADA, CLIENT_NUMBER, "I am not interested in these offers anymore", "SMr3"));
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, sender_key: "company:acme" })]);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-own")).toMatchObject({ status: "running" });
  });

  it("belong to the sender whose number was texted: a reply to PiB's number is not an answer to a client's campaign", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-acme", "camp-acme", "ada"));
    // Ada was texted by the client only, and writes to PiB's own number.
    s.channel_messages!.push(sentMessage("e-acme", "camp-acme", ADA, "company:acme"));
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "Please call me about the quote", "SMx1"));
    await harness.runJob("poll-messaging");
    expect(await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).toHaveLength(0);
    expect(s.campaign_step_events).toHaveLength(0);
    // The same words to the client's own number are the client's reply.
    mock.inboundQueue.push(reply(ADA, CLIENT_NUMBER, "Please call me about the quote", "SMx2"));
    await harness.runJob("poll-messaging");
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("[Acme Plumbing] Check reply from Ada Lovelace (SMS)");
  });

  it("go to the campaign of the number that was texted when the person was texted by two senders", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-acme", "camp-acme", "ada"));
    // The client's text is the newer one; the reply to PiB's number still belongs to PiB's campaign.
    s.channel_messages!.push(
      sentMessage("e-own", "camp-own", ADA, "own", { created_at: "2026-10-01T08:00:00.000Z" }),
      sentMessage("e-acme", "camp-acme", ADA, "company:acme", { created_at: "2026-10-02T08:00:00.000Z" }),
    );
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "Yes interested, call me", "SMy1"));
    await harness.runJob("poll-messaging");
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Check reply from Ada Lovelace (SMS)");
    expect(issues[0]!.originId).toBe("campaigns:reply:e-own:SMy1");
    expect(s.campaign_step_events!.map((row) => row.enrollment_id)).toEqual(["e-own"]);
  });

  it("from someone we never texted are ignored", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    mock.inboundQueue.push(reply("+27824440000", OWN_NUMBER, "Hello?", "SMu"));
    await harness.runJob("poll-messaging");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);
    expect(s.campaign_step_events).toHaveLength(0);
  });
});

describe("the poll", () => {
  it("looks back three days the first time, then from five minutes before the last poll", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    const before = Date.now();
    await harness.runJob("poll-messaging");
    expect(before - mock.inboundCalls[0]!.since.getTime()).toBeGreaterThan(3 * 86_400_000 - 5_000);
    expect(before - mock.inboundCalls[0]!.since.getTime()).toBeLessThan(3 * 86_400_000 + 5_000);
    expect(mock.inboundCalls[0]!.numbers).toEqual(expect.arrayContaining([{ channel: "sms", address: OWN_NUMBER }, { channel: "sms", address: CLIENT_NUMBER }]));
    // A message that reached the provider two minutes late is inside the five minute overlap: read once, never twice.
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "HELP", "SMc", at));
    await harness.runJob("poll-messaging");
    await harness.runJob("poll-messaging");
    const since = (call: number) => Date.now() - mock.inboundCalls[call]!.since.getTime();
    expect(since(1)).toBeGreaterThan(5 * 60_000 - 5_000);
    expect(since(1)).toBeLessThan(5 * 60_000 + 5_000);
    expect(mock.inboundCalls[2]!.since.getTime()).toBeLessThanOrEqual(Date.parse(at));
    expect(s.inbox!.map((row) => row.key)).toEqual(["msg:sms:SMc"]);
  });

  it("an idle poll never moves the read window backwards: each poll starts no earlier than the one before", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    for (let i = 0; i < 4; i += 1) await harness.runJob("poll-messaging");
    const starts = mock.inboundCalls.map((call) => call.since.getTime());
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]!, `poll ${i}`).toBeGreaterThanOrEqual(starts[i - 1]!);
    // After the first poll it is about five minutes, not three days and growing.
    expect(Date.now() - starts[3]!).toBeLessThan(6 * 60_000);
  });

  it("a read that hits the provider's cap stays at the newest message it handled and warns, so nothing newer is skipped", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    const newest = Date.now() - 2 * 3_600_000;
    for (let i = 0; i < INBOUND_READ_CAP; i += 1) mock.inboundQueue.push(reply(ADA, OWN_NUMBER, "HELP", `SMcap${i}`, new Date(newest - (INBOUND_READ_CAP - i) * 1000).toISOString()));
    await harness.runJob("poll-messaging");
    expect(harness.logs.some((entry) => entry.message.startsWith("Messaging poll read as many replies as it can"))).toBe(true);
    await harness.runJob("poll-messaging");
    // Five minutes before the newest message it read, not before now.
    expect(mock.inboundCalls.at(-1)!.since.getTime()).toBeLessThan(newest);
    expect(mock.inboundCalls.at(-1)!.since.getTime()).toBeGreaterThan(newest - 6 * 60_000);
  });

  it("does nothing for a company that switched Campaigns off, and one provider failing does not stop the job", async () => {
    const s = store();
    const { harness, mock } = await bootInbound({ store: s });
    await harness.emit("plugin.partnersinbiz.setup.modules.updated" as `plugin.${string}`, { companyId: CO, modules: { campaigns: false }, updatedAt: new Date().toISOString() }, { companyId: CO });
    await harness.runJob("poll-messaging");
    expect(mock.inboundCalls).toHaveLength(0);
    await harness.emit("plugin.partnersinbiz.setup.modules.updated" as `plugin.${string}`, { companyId: CO, modules: { campaigns: true }, updatedAt: new Date(Date.now() + 1000).toISOString() }, { companyId: CO });
    mock.inbound = async () => {
      throw new Error("Twilio answered 401 when reading messages.");
    };
    await expect(harness.runJob("poll-messaging")).resolves.toBeUndefined();
    expect(harness.logs.some((entry) => entry.message === "Messaging poll failed")).toBe(true);
  });
});

describe("delivery results", () => {
  it("record delivered messages, and a number the carrier says is not there is not tried again", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-bob", "camp-own", "bob"));
    s.channel_messages!.push(
      sentMessage("e1", "camp-own", ADA, "own", { enrollment_id: "e-own", key: "campaigns:msg:e-own:1", provider_id: "SMd1" }),
      sentMessage("e2", "camp-own", BOB, "own", { enrollment_id: "e-bob", key: "campaigns:msg:e-bob:1", provider_id: "SMd2", contact_id: "bob" }),
    );
    const { harness, mock } = await bootInbound({ store: s });
    mock.statusMap.set("SMd1", { providerId: "SMd1", status: "delivered", errorCode: null });
    mock.statusMap.set("SMd2", { providerId: "SMd2", status: "undelivered", errorCode: "30006" });
    await harness.runJob("poll-messaging");
    expect(s.channel_messages!.map((row) => [row.provider_id, row.status])).toEqual([["SMd1", "delivered"], ["SMd2", "failed"]]);
    expect(s.campaign_step_events!.map((row) => row.event_type).sort()).toEqual(["delivered", "failed"]);
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: BOB, reason: "invalid_number", scope: "all" })]);
    // Settled messages are not asked about again.
    mock.statusMap.set("SMd1", { providerId: "SMd1", status: "failed", errorCode: "30008" });
    await harness.runJob("poll-messaging");
    expect(s.channel_messages![0]).toMatchObject({ status: "delivered" });
  });

  it("an undelivered message the provider blocked after STOP opts the person out", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"));
    s.channel_messages!.push(sentMessage("e1", "camp-own", ADA, "own", { enrollment_id: "e-own", key: "campaigns:msg:e-own:1", provider_id: "SMd3" }));
    const { harness, mock } = await bootInbound({ store: s });
    mock.statusMap.set("SMd3", { providerId: "SMd3", status: "undelivered", errorCode: "21610" });
    await harness.runJob("poll-messaging");
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, reason: "provider_opt_out", sender_key: "own" })]);
    expect(s.campaign_enrollments![0]).toMatchObject({ status: "stopped" });
  });
});

describe("the reply webhook", () => {
  const post = (parsedBody: unknown, headers: Record<string, string> = { "x-pib-webhook-secret": SECRET }) =>
    plugin.definition.onWebhook!({ endpointKey: "messaging-inbound", headers, rawBody: "", parsedBody, requestId: "r1" });
  const body = { companyId: CO, MessageSid: "SMw1", From: ADA, To: OWN_NUMBER, Body: "STOP" };

  it("takes a reply with the company's secret", async () => {
    const s = store();
    await bootInbound({ store: s });
    await post(body);
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ address: ADA, sender_key: "own" })]);
  });

  it("refuses a missing, wrong or too short secret with the same answer, and records nothing", async () => {
    const s = store();
    await bootInbound({ store: s });
    await expect(post(body, {})).rejects.toThrow("Not accepted.");
    await expect(post(body, { "x-pib-webhook-secret": "wrong-secret-of-the-same-length!" })).rejects.toThrow("Not accepted.");
    await expect(post(body, { "x-pib-webhook-secret": "" })).rejects.toThrow("Not accepted.");
    expect(s.channel_suppressions).toHaveLength(0);
    // No secret saved for the company: nothing can be accepted, even with a header.
    const open = store();
    await bootInbound({ store: open, messaging: { inboundWebhookSecret: undefined } });
    await expect(post(body)).rejects.toThrow("Not accepted.");
    const short = store();
    await bootInbound({ store: short, messaging: { inboundWebhookSecret: "short" } });
    await expect(post(body, { "x-pib-webhook-secret": "short" })).rejects.toThrow("Not accepted.");
    expect(short.channel_suppressions).toHaveLength(0);
  });

  it("needs a company and the message's fields", async () => {
    await bootInbound({ store: store() });
    await expect(post({ ...body, companyId: undefined })).rejects.toThrow(/companyId is required/);
    await expect(post({ ...body, From: "" })).rejects.toThrow(/MessageSid, From and To/);
    await expect(post("not an object")).rejects.toThrow(/companyId is required/);
  });

  it("reads a WhatsApp reply by its whatsapp: address", async () => {
    const s = store();
    const booted = await bootInbound({ store: s, messaging: { whatsappFrom: "+14155238886" } });
    await post({ ...body, MessageSid: "SMw2", To: "whatsapp:+14155238886", From: "whatsapp:+27821234567" });
    expect(s.channel_suppressions).toEqual([expect.objectContaining({ channel: "whatsapp", address: ADA, sender_key: "own" })]);
    void booted;
  });
});
