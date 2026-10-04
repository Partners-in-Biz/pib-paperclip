/**
 * `mail.delivery` (0.7.0): what the email provider says became of a campaign email, announced by the Mailbox. Each report becomes a step
 * event once, and a hard bounce or a complaint puts the address on the per-client do-not-email list once, with a reason. The same
 * discipline as `mail.send.result` and `mail.received`: the event is handled once per key, a step event once per send and kind, a
 * suppression once per address and sender, so a redelivered event (or the Mailbox's own `contact.suppressed` for the same fact) adds nothing.
 */
import { describe, expect, it } from "vitest";
import { HANDOFF_EVENTS, MAIL_DELIVERY_TYPES, MAIL_EVENTS, type MailDeliveryType } from "@partnersinbiz/pib-plugin-kit";
import { asCampaignDelivery, handleDelivery } from "../src/delivery.js";
import { boot, campaign, CO, enrollment, seed, step } from "./helpers/harness.js";
import type { Row } from "./helpers/fake-db.js";

const MAILBOX = "plugin.partnersinbiz.mailbox";
const CRM = "plugin.partnersinbiz.crm";
const OWN = "campaigns:step:e-own:1";
const CLIENT = "campaigns:step:e-client:1";
const OTHER_CLIENT = "campaigns:step:e-other:1";

function store() {
  const s = seed();
  s.campaigns!.push(
    campaign("camp-own"),
    campaign("camp-client", { client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
    campaign("camp-other", { client_kind: "company", client_ref: "beta", client_name: "Beta Builders" }),
  );
  s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"), step("camp-client", 1, "a", "Hi", "Hello"), step("camp-other", 1, "a", "Hi", "Hello"));
  s.campaign_enrollments!.push(
    enrollment("e-own", "camp-own", "ada", { sending_key: null }),
    enrollment("e-client", "camp-client", "ada"),
    enrollment("e-other", "camp-other", "ada"),
  );
  // What the sends recorded when the Mailbox answered: the address each email went to.
  for (const [enrollmentId, campaignId] of [["e-own", "camp-own"], ["e-client", "camp-client"], ["e-other", "camp-other"]] as const) {
    s.campaign_step_events!.push({ id: `sent-${enrollmentId}`, company_id: CO, campaign_id: campaignId, enrollment_id: enrollmentId, step_position: 1, event_type: "sent", variant: "a", source_key: `sent:campaigns:step:${enrollmentId}:1`, meta: { to: "ada@acme.test", key: `campaigns:step:${enrollmentId}:1` }, occurred_at: "2026-10-04T08:00:00.000Z" });
  }
  return s;
}

/** A `mail.delivery` payload the way the Mailbox announces it. */
function delivery(sendKey: string, type: MailDeliveryType, over: Record<string, unknown> = {}) {
  const enrollmentId = /^campaigns:step:(.+):\d+$/.exec(sendKey)?.[1] ?? "x";
  return {
    key: `esp:${type}-${enrollmentId}`,
    type,
    provider: "resend",
    sendKey,
    recipient: "ada@acme.test",
    at: "2026-10-04T09:00:00.000Z",
    context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: enrollmentId, ...(enrollmentId === "e-client" ? { clientKind: "company", clientRef: "acme" } : {}) },
    clientKind: enrollmentId === "e-client" ? "company" : null,
    clientRef: enrollmentId === "e-client" ? "acme" : null,
    ...over,
  };
}

async function announce(harness: Awaited<ReturnType<typeof boot>>["harness"], payload: Record<string, unknown>, company = CO) {
  await harness.emit(`${MAILBOX}.${MAIL_EVENTS.delivery}` as `plugin.${string}`, payload, { companyId: company });
}

const events = (s: Record<string, Row[]>, type?: string) => s.campaign_step_events!.filter((row) => row.event_type !== "sent" && (!type || row.event_type === type));

describe("the payload is read strictly", () => {
  it("accepts only a delivery of one of this plugin's own campaign sends", () => {
    expect(asCampaignDelivery(delivery(OWN, "delivered"))).toMatchObject({ key: "esp:delivered-e-own", type: "delivered", sendKey: OWN, recipient: "ada@acme.test", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-own" } });
    // Another plugin's mail, a send that is not a campaign step, a key that is not a campaign's, an unknown type, junk.
    expect(asCampaignDelivery(delivery(OWN, "delivered", { context: { plugin: "partnersinbiz.crm", kind: "client_message", id: "x" } }))).toBeNull();
    expect(asCampaignDelivery(delivery(OWN, "delivered", { context: { plugin: "partnersinbiz.campaigns", kind: "campaign_reply", id: "x" } }))).toBeNull();
    expect(asCampaignDelivery(delivery("crm:msg:1", "delivered"))).toBeNull();
    expect(asCampaignDelivery(delivery(OWN, "delivered", { sendKey: null }))).toBeNull();
    expect(asCampaignDelivery(delivery(OWN, "delivered", { type: "exploded" }))).toBeNull();
    expect(asCampaignDelivery(delivery(OWN, "delivered", { key: "" }))).toBeNull();
    expect(asCampaignDelivery(null)).toBeNull();
    expect(asCampaignDelivery("delivered")).toBeNull();
  });

  it("knows every type the kit names", () => {
    for (const type of MAIL_DELIVERY_TYPES) expect(asCampaignDelivery(delivery(OWN, type))?.type, type).toBe(type);
  });

  it("keeps a hard or soft bounce's kind, drops an address that is not one and a time that is not a time", () => {
    const bounced = asCampaignDelivery(delivery(OWN, "bounced", { bounce: { kind: "hard", subType: "General" }, recipient: "not-an-address", at: "yesterday" }))!;
    expect(bounced.bounce).toEqual({ kind: "hard", subType: "General" });
    expect(bounced.recipient).toBeUndefined();
    expect(Number.isFinite(Date.parse(bounced.at))).toBe(true);
    expect(asCampaignDelivery(delivery(OWN, "bounced", { bounce: { kind: "sideways" } }))!.bounce).toBeUndefined();
  });
});

describe("a report becomes a step event, once", () => {
  it("delivered is recorded on the step and variant of the send, and a repeat of the same event changes nothing", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "delivered"));
    await announce(harness, delivery(CLIENT, "delivered"));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "delivered", enrollment_id: "e-client", campaign_id: "camp-client", step_position: 1, variant: "a", source_key: `delivery:delivered:${CLIENT}` })]);
    expect(events(s)[0]!.meta).toMatchObject({ sendKey: CLIENT, deliveryKey: "esp:delivered-e-client", type: "delivered", provider: "resend", to: "ada@acme.test" });
    // The stored answer is what a repeat gets back (the same discipline as mail.received).
    expect(s.inbox).toEqual([expect.objectContaining({ key: "esp:delivered-e-client", event: MAIL_EVENTS.delivery, result: expect.objectContaining({ matched: true, event: "delivered", recorded: true }) })]);
    // Nothing else happened: no suppression, the enrollment goes on.
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-client")!.status).toBe("running");
  });

  it("the same fact under another delivery id is still one step event (the provider can report it twice)", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "delivered", { key: "esp:first" }));
    await announce(harness, delivery(CLIENT, "delivered", { key: "esp:second" }));
    expect(events(s, "delivered")).toHaveLength(1);
    // Both deliveries were handled, so a redelivery of either is answered from the store.
    expect(s.inbox!.map((row) => row.key).sort()).toEqual(["esp:first", "esp:second"]);
    expect(s.inbox!.find((row) => row.key === "esp:second")!.result).toMatchObject({ matched: true, recorded: false });
  });

  it("an open or a click counts the first per send: a mail client may preload a pixel and a person may click twice", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    for (const n of [1, 2, 3]) await announce(harness, delivery(CLIENT, "opened", { key: `esp:open-${n}` }));
    for (const n of [1, 2]) await announce(harness, delivery(CLIENT, "clicked", { key: `esp:click-${n}` }));
    expect(events(s, "open")).toHaveLength(1);
    expect(events(s, "click")).toHaveLength(1);
    // The other sends of the same contact keep their own counts.
    await announce(harness, delivery(OWN, "opened", { key: "esp:open-own" }));
    expect(events(s, "open")).toHaveLength(2);
  });

  it("a delay is not an outcome, and a failure is recorded without stopping anyone", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "delayed"));
    expect(events(s)).toHaveLength(0);
    expect(s.inbox![0]!.result).toMatchObject({ matched: true, event: null, recorded: false });
    await announce(harness, delivery(CLIENT, "failed"));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "failed" })]);
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.every((row) => row.status === "running")).toBe(true);
  });

  it("a soft bounce is recorded apart from a hard one and suppresses nobody: the address may work next time", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "soft_bounced", { bounce: { kind: "soft", subType: "MailboxFull" } }));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "soft_bounce", source_key: `delivery:soft_bounce:${CLIENT}` })]);
    expect(events(s)[0]!.meta).toMatchObject({ bounceKind: "soft", bounceSubType: "MailboxFull" });
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.find((row) => row.id === "e-client")!.status).toBe("running");
  });
});

describe("a hard bounce stops the address for every sender, once, with a reason", () => {
  it("records the bounce, suppresses the address for all mail with the reason, and stops the contact's running campaigns", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } }));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "bounce", enrollment_id: "e-client", source_key: `delivery:bounce:${CLIENT}` })]);
    expect(events(s)[0]!.meta).toMatchObject({ bounceKind: "hard", bounceSubType: "General" });
    // Every sender's list (a bounce is about the address), the reason, who told us, and which contact and campaign.
    expect(s.suppressions).toEqual([expect.objectContaining({ company_id: CO, email: "ada@acme.test", reason: "bounce", scope: "all", sender_key: "", source: "partnersinbiz.mailbox", contact_id: "ada", campaign_id: "camp-client" })]);
    expect(s.campaign_enrollments!.filter((row) => row.contact_id === "ada").every((row) => row.status === "stopped")).toBe(true);
  });

  it("a redelivered event, the same bounce under another id, and the Mailbox's own contact.suppressed add nothing twice", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const bounce = delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } });
    await announce(harness, bounce);
    await announce(harness, bounce);
    await announce(harness, { ...bounce, key: "esp:another-id" });
    // The Mailbox announces the same bounce as contact.suppressed (it always has), usually before or after the report.
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { key: "suppress:ada@acme.test:bounced", email: "ada@acme.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox", at: "2026-10-04T09:00:00.000Z" }, { companyId: CO });
    expect(s.suppressions).toHaveLength(1);
    expect(events(s, "bounce")).toHaveLength(1);
    // And in the other order: the Mailbox's event first, then the report.
    const t = store();
    const second = await boot({ store: t });
    await second.harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { key: "suppress:ada@acme.test:bounced", email: "ada@acme.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox", at: "2026-10-04T09:00:00.000Z" }, { companyId: CO });
    await announce(second.harness, bounce);
    expect(t.suppressions).toHaveLength(1);
    expect(events(t, "bounce")).toHaveLength(1);
  });

  it("the provider's own refusal of a listed address (suppressed) is treated as a hard bounce", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(OWN, "suppressed"));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "bounce" })]);
    expect(events(s)[0]!.meta).toMatchObject({ type: "suppressed" });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "bounce", scope: "all", sender_key: "" })]);
  });

  it("a report that says nothing about who bounced uses the address the campaign email went to", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const { recipient: _recipient, ...noRecipient } = delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } });
    await announce(harness, noRecipient);
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "bounce" })]);
  });

  it("an event that names an address the campaign did not email suppresses nobody (it only changes the report)", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "bounced", { recipient: "stranger@elsewhere.test", bounce: { kind: "hard", subType: "General" } }));
    expect(events(s, "bounce")).toHaveLength(1);
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.every((row) => row.status === "running")).toBe(true);
  });
});

describe("a complaint stops the address for this client's marketing only, once, with a reason", () => {
  it("suppresses the address on the client's own list and leaves another client's and PiB's own campaigns running", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "complained"));
    expect(events(s)).toEqual([expect.objectContaining({ event_type: "complaint", enrollment_id: "e-client", source_key: `delivery:complaint:${CLIENT}` })]);
    expect(s.suppressions).toEqual([expect.objectContaining({ company_id: CO, email: "ada@acme.test", reason: "complaint", scope: "marketing", sender_key: "company:acme", source: "partnersinbiz.mailbox", contact_id: "ada", campaign_id: "camp-client" })]);
    const status = (id: string) => s.campaign_enrollments!.find((row) => row.id === id)!.status;
    expect(status("e-client")).toBe("stopped");
    expect(status("e-own")).toBe("running");
    expect(status("e-other")).toBe("running");
  });

  it("for PiB's own campaign it is PiB's own list, and a redelivery or the Mailbox's own announcement adds nothing", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const complaint = delivery(OWN, "complained");
    await announce(harness, complaint);
    await announce(harness, complaint);
    await announce(harness, { ...complaint, key: "esp:again" });
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { key: "suppress:ada@acme.test:complained:own", email: "ada@acme.test", reason: "complained", scope: "marketing", source: "partnersinbiz.mailbox", senderKey: "own", at: "2026-10-04T09:00:00.000Z" }, { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ reason: "complaint", scope: "marketing", sender_key: "own" })]);
    expect(events(s, "complaint")).toHaveLength(1);
    // The client's campaigns for the same person are not touched by a complaint about PiB's own mail.
    const status = (id: string) => s.campaign_enrollments!.find((row) => row.id === id)!.status;
    expect(status("e-own")).toBe("stopped");
    expect(status("e-client")).toBe("running");
  });

  it("a complaint after a hard bounce keeps both on record without a second row for the same list", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } }));
    await announce(harness, delivery(CLIENT, "complained"));
    expect(s.suppressions!.map((row) => `${row.reason}:${row.scope}:${row.sender_key || "every"}`).sort()).toEqual(["bounce:all:every", "complaint:marketing:company:acme"]);
  });
});

describe("only a campaign's own sends are read", () => {
  it("ignores another company's enrollment, an enrollment that is gone, and a key whose context disagrees", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    // The same enrollment id announced under another company: nothing is recorded for it.
    await announce(harness, delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } }), "co-2");
    await announce(harness, delivery("campaigns:step:gone:1", "complained"));
    await announce(harness, delivery(CLIENT, "complained", { key: "esp:liar", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-own" } }));
    expect(events(s)).toHaveLength(0);
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.every((row) => row.status === "running")).toBe(true);
  });

  it("ignores another plugin's mail on the same event, with nothing stored for it", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    await announce(harness, { key: "esp:crm-1", type: "bounced", provider: "resend", sendKey: "crm:msg:1", recipient: "ada@acme.test", at: "2026-10-04T09:00:00.000Z", context: { plugin: CRM.replace("plugin.", ""), kind: "client_message", id: "1" } });
    expect(events(s)).toHaveLength(0);
    expect(s.suppressions).toHaveLength(0);
    expect(s.inbox).toHaveLength(0);
  });

  it("never throws into the host: a failure is logged, nothing is stored, and the Mailbox's own suppression event still reaches the list", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const real = harness.ctx.db.execute.bind(harness.ctx.db);
    (harness.ctx.db as { execute: unknown }).execute = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO \S+\.campaign_step_events/.test(sql)) throw new Error("database is down");
      return real(sql, params);
    };
    await expect(announce(harness, delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } }))).resolves.toBeUndefined();
    expect(s.inbox).toHaveLength(0);
    expect(harness.logs.some((line) => /Campaign delivery report failed/.test(line.message))).toBe(true);
    (harness.ctx.db as { execute: unknown }).execute = real;
    // The report that failed is not lost for good when the Mailbox re-announces the suppression it made.
    await harness.emit(`${MAILBOX}.${HANDOFF_EVENTS.contactSuppressed}` as `plugin.${string}`, { key: "suppress:ada@acme.test:bounced", email: "ada@acme.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox", at: "2026-10-04T09:00:00.000Z" }, { companyId: CO });
    expect(s.suppressions).toHaveLength(1);
  });
});

describe("handleDelivery on its own", () => {
  it("answers what it did, so a repeat can be answered from the store", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const parsed = asCampaignDelivery(delivery(CLIENT, "complained"))!;
    expect(await handleDelivery(harness.ctx, CO, parsed)).toMatchObject({ matched: true, campaignId: "camp-client", enrollmentId: "e-client", event: "complaint", recorded: true, suppressed: true });
    expect(await handleDelivery(harness.ctx, CO, parsed)).toMatchObject({ matched: true, recorded: false, suppressed: false });
  });

  it("is for the company that owns the enrollment: the same send key under another company matches nothing and writes nothing", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    const parsed = asCampaignDelivery(delivery(CLIENT, "bounced", { bounce: { kind: "hard", subType: "General" } }))!;
    expect(await handleDelivery(harness.ctx, "co-2", parsed)).toEqual({ matched: false });
    expect(events(s)).toHaveLength(0);
    expect(s.suppressions).toHaveLength(0);
  });
});
