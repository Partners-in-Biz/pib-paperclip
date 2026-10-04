/**
 * Replies to a campaign email that went out through the email provider (0.7.0). Such a send has no Gmail thread and no Message-ID the Mailbox
 * knows, and its replies go to the Reply-To mailbox, so the Mailbox cannot link a reply to the send. Campaigns attributes it to its step by
 * the Reply-To mailbox the reply arrived at plus the send it answers (each `sent` event keeps the Reply-To, the address and the subject, and
 * the send's key goes on the reply). The Gmail path (the Mailbox linked the send's context) is tried first and is unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainSubject, REPLY_TO_MATCH_DAYS } from "../src/mail.js";
import { boot, campaign, CO, enrollment, seed, step } from "./helpers/harness.js";
import type { Row } from "./helpers/fake-db.js";

const MAILBOX = "plugin.partnersinbiz.mailbox";
const TEAM = "team@client.co.za";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJev(choice: string, confidence = 0.95) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { reply_kind: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } } }), { status: 200 })));
}

/** A `sent` event of a provider send: the Reply-To, the address, the subject and the key are in its meta. */
function sent(enrollmentId: string, campaignId: string, over: { to?: string; replyTo?: string | null; subject?: string; at?: string; position?: number; provider?: string | null } = {}): Row {
  const position = over.position ?? 1;
  const key = `campaigns:step:${enrollmentId}:${position}`;
  return {
    id: `sent-${enrollmentId}-${position}`, company_id: CO, campaign_id: campaignId, enrollment_id: enrollmentId, step_position: position, event_type: "sent", variant: "a", source_key: `sent:${key}`,
    meta: { to: over.to ?? "ada@acme.test", key, messageId: "resend:abc", threadId: null, ...(over.provider === null ? {} : { provider: "resend" }), ...(over.replyTo === null ? {} : { replyTo: over.replyTo ?? TEAM }), subject: over.subject ?? "Hi Ada" },
    occurred_at: over.at ?? "2026-10-01T08:00:00.000Z",
  };
}

function store() {
  const s = seed();
  s.campaigns!.push(
    campaign("camp-a", { client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
    campaign("camp-b", { client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
  );
  s.campaign_steps!.push(step("camp-a", 1, "a", "Hi {{first_name}}", "Hello"), step("camp-a", 2, "a", "Again", "Second", 3), step("camp-b", 1, "a", "Offer", "Offer body"));
  s.campaign_enrollments!.push(enrollment("e-a", "camp-a", "ada", { step_position: 2 }), enrollment("e-b", "camp-b", "ada"));
  return s;
}

/** A reply as the Mailbox announces it: it arrived at the Reply-To mailbox, linked to nothing (the provider's mail has no thread). */
function reply(over: Record<string, unknown> = {}) {
  return {
    key: "mail:m-1", accountAddress: TEAM, messageId: "m-1", threadId: "t-1",
    from: { email: "ada@acme.test", name: "Ada" }, to: [{ email: TEAM }], subject: "Re: Hi Ada", snippet: "Sounds good, call me", receivedAt: "2026-10-02T09:00:00Z",
    attachments: [], triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: null,
    ...over,
  };
}

async function receive(harness: Awaited<ReturnType<typeof boot>>["harness"], payload: Record<string, unknown>) {
  await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, payload, { companyId: CO });
}
const replies = (s: Record<string, Row[]>) => s.campaign_step_events!.filter((row) => row.event_type === "reply");

describe("a reply to a provider send is attributed by the Reply-To mailbox and the send", () => {
  it("lands on the step that was emailed, with the send's key on the reply, and stops that enrollment", async () => {
    stubJev("interested", 0.9);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a"));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply());
    expect(replies(s)).toEqual([expect.objectContaining({ enrollment_id: "e-a", campaign_id: "camp-a", step_position: 1, variant: "a", source_key: "reply:m-1" })]);
    expect(replies(s)[0]!.meta).toMatchObject({ matchedBy: "reply-to", sendKey: "campaigns:step:e-a:1" });
    // Attributed to the campaign that sent it, not to the contact's other running campaign.
    expect(s.campaign_enrollments!.find((row) => row.id === "e-a")!.status).toBe("stopped");
    expect(s.campaign_enrollments!.find((row) => row.id === "e-b")!.status).toBe("running");
    const [issue] = await harness.ctx.issues.list({ companyId: CO });
    expect(issue!.title).toBe("[Acme Plumbing] Reply from Ada Lovelace: Re: Hi Ada");
  });

  it("is matched when the reply landed in the mailbox through another address (an alias, a group): the Reply-To is among the recipients", async () => {
    stubJev("question", 0.9);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a"));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply({ accountAddress: "peet@partnersinbiz.online", to: [{ email: TEAM }, { email: "someone@client.co.za" }] }));
    expect(replies(s)[0]!.meta).toMatchObject({ matchedBy: "reply-to", sendKey: "campaigns:step:e-a:1" });
  });

  it("with two campaigns to the same person from the same mailbox, the one whose subject the reply carries wins, else the newest send", async () => {
    stubJev("question", 0.9);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a", { subject: "Hi Ada", at: "2026-10-01T08:00:00.000Z" }), sent("e-b", "camp-b", { subject: "Offer for you", at: "2026-10-01T10:00:00.000Z" }));
    const first = await boot({ store: s, jev: true });
    await receive(first.harness, reply({ subject: "RE: Hi Ada" }));
    expect(replies(s)).toEqual([expect.objectContaining({ enrollment_id: "e-a", step_position: 1 })]);
    // No subject to go by: the newest send to that person from that mailbox.
    const t = store();
    t.campaign_step_events!.push(sent("e-a", "camp-a", { subject: "Hi Ada", at: "2026-10-01T08:00:00.000Z" }), sent("e-b", "camp-b", { subject: "Offer for you", at: "2026-10-01T10:00:00.000Z" }));
    const second = await boot({ store: t, jev: true });
    await receive(second.harness, reply({ subject: "(no subject)" }));
    expect(replies(t)).toEqual([expect.objectContaining({ enrollment_id: "e-b" })]);
  });

  it("a reply from somebody else, to another mailbox, before the send, or long after it is not attributed this way", async () => {
    stubJev("interested", 0.9);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a stranger writing to the same mailbox", { from: { email: "stranger@elsewhere.test" } }],
      ["a reply that arrived at another mailbox", { accountAddress: "other@client.co.za", to: [{ email: "other@client.co.za" }] }],
      ["a message that arrived before the email was sent", { receivedAt: "2026-09-30T09:00:00Z" }],
      ["a reply long after the matching window", { receivedAt: new Date(Date.parse("2026-10-01T08:00:00Z") + (REPLY_TO_MATCH_DAYS + 1) * 86_400_000).toISOString() }],
    ];
    for (const [label, over] of cases) {
      const s = store();
      s.campaign_step_events!.push(sent("e-a", "camp-a"));
      // Nobody else is a contact, so the older contact-based match cannot rescue the stranger; for the rest it can, which is why only `matchedBy` is checked.
      const { harness } = await boot({ store: s, jev: true });
      await receive(harness, reply(over));
      const found = replies(s);
      expect(found.every((row) => row.meta?.matchedBy !== "reply-to"), label).toBe(true);
      if (over.from) expect(found, label).toHaveLength(0);
    }
  });

  it("does not break the Gmail path: a reply the Mailbox linked to a send's context is attributed by that context, even when another send to the same person names the same Reply-To mailbox", async () => {
    stubJev("interested", 0.9);
    const s = store();
    // e-a went out through Gmail (a thread, no provider); e-b is a newer provider send from the same client mailbox. The reply is in e-a's thread.
    s.campaign_step_events!.push(sent("e-a", "camp-a", { provider: null, at: "2026-10-01T08:00:00.000Z" }), sent("e-b", "camp-b", { subject: "Hi Ada", at: "2026-10-01T10:00:00.000Z" }));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply({ replyTo: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-a" } }));
    expect(replies(s)).toEqual([expect.objectContaining({ enrollment_id: "e-a", step_position: 1 })]);
    expect(replies(s)[0]!.meta).toMatchObject({ matchedBy: "send-context" });
    expect(replies(s)[0]!.meta).not.toHaveProperty("sendKey");
  });

  it("an old send with no Reply-To on record (before 0.7.0) still falls back to the contact's most recent send, as before", async () => {
    stubJev("interested", 0.9);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a", { replyTo: null }));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply({ accountAddress: "peet@partnersinbiz.online", to: [{ email: "peet@partnersinbiz.online" }] }));
    expect(replies(s)).toEqual([expect.objectContaining({ enrollment_id: "e-a" })]);
    expect(replies(s)[0]!.meta).toMatchObject({ matchedBy: "contact" });
  });

  it("an unsubscribe reply to a provider send is attributed to its send too: the address leaves that client's marketing list", async () => {
    stubJev("unsubscribe", 0.97);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a"));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply({ snippet: "Please stop emailing me" }));
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "unsubscribe", sender_key: "company:acme" })]);
    expect(s.campaign_step_events!.filter((row) => row.event_type === "unsubscribe")).toEqual([expect.objectContaining({ enrollment_id: "e-a" })]);
  });

  it("a repeated delivery of the reply is handled once", async () => {
    stubJev("question", 0.9);
    const s = store();
    s.campaign_step_events!.push(sent("e-a", "camp-a"));
    const { harness } = await boot({ store: s, jev: true });
    await receive(harness, reply());
    await receive(harness, reply());
    expect(replies(s)).toHaveLength(1);
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(1);
  });
});

describe("what a send records so its replies can be found", () => {
  async function sendOne(result: Record<string, unknown>, config: { replyTo?: string } = {}) {
    const s = store();
    s.campaign_enrollments = [enrollment("e-a", "camp-a", "ada", { next_due_at: "2026-09-01T08:00:00.000Z" })];
    s.campaign_step_events = [];
    s.campaigns!.find((row) => row.id === "camp-a")!.reply_to = config.replyTo ?? null;
    const { harness } = await boot({ store: s });
    // The client's identity: a send-only address on its sending domain.
    s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@updates.client.co.za", from_name: "Acme Plumbing", reply_to: null, sms_from: null, whatsapp_from: null }];
    await harness.runJob("open-due-steps");
    await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, { key: "campaigns:step:e-a:1", status: "sent", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-a" }, ...result }, { companyId: CO });
    return s;
  }

  it("keeps the provider, the Reply-To the Mailbox says the message carried, and the subject; a provider send has no thread", async () => {
    const s = await sendOne({ messageId: "resend:abc", threadId: null, provider: "resend", replyTo: "Team@Client.co.za" });
    const [event] = s.campaign_step_events!.filter((row) => row.event_type === "sent");
    expect(event!.meta).toMatchObject({ to: "ada@acme.test", key: "campaigns:step:e-a:1", provider: "resend", replyTo: TEAM, subject: "Hi Ada", messageId: "resend:abc", threadId: null });
  });

  it("falls back to the Reply-To the campaign asked for when the Mailbox does not say, and records none when there is none", async () => {
    const asked = await sendOne({ messageId: "gm-1", threadId: "th-1" }, { replyTo: "sales@client.co.za" });
    expect(asked.campaign_step_events!.find((row) => row.event_type === "sent")!.meta).toMatchObject({ replyTo: "sales@client.co.za" });
    expect(asked.campaign_step_events!.find((row) => row.event_type === "sent")!.meta).not.toHaveProperty("provider");
    const none = await sendOne({ messageId: "gm-2", threadId: "th-2" });
    expect(none.campaign_step_events!.find((row) => row.event_type === "sent")!.meta).not.toHaveProperty("replyTo");
  });
});

describe("plainSubject", () => {
  it("drops reply and forward prefixes in any case, language prefix or repeat, and spacing", () => {
    expect(plainSubject("Re: Hi Ada")).toBe("hi ada");
    expect(plainSubject("RE:  RE: Hi   Ada ")).toBe("hi ada");
    expect(plainSubject("Fwd: Re: Offer")).toBe("offer");
    expect(plainSubject("AW: Angebot")).toBe("angebot");
    expect(plainSubject("Reply to our offer")).toBe("reply to our offer");
    expect(plainSubject("")).toBe("");
  });
});
