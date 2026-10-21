import { afterEach, describe, expect, it } from "vitest";
import { setMessagingProvider } from "../src/messaging.js";
import { boot, campaign, CO, contact, enrollment, PAST, PUBLIC_URL, seed, step } from "./helpers/harness.js";
import { MockProvider, reply } from "./helpers/mock-provider.js";
import type { Store } from "./helpers/fake-db.js";

/**
 * The whole opt-out loop through the provider seam, one person at a time:
 * recorded consent -> a step goes out -> inbound STOP revokes -> the next step
 * is not sent -> START restores -> a step goes out again. The pieces are pinned
 * one by one in sms.spec, inbound.spec and privacy.spec; this pins that they
 * work together. No Twilio account is involved: `setMessagingProvider` swaps in
 * the recording mock.
 */

afterEach(() => setMessagingProvider(null));

const ADA = "+27821234567";
const OWN_SMS = "+14155550100";
const OWN_WHATSAPP = "+14155238886";
const OPEN = { weekdays: "00:00-24:00", saturday: "00:00-24:00", sunday: "00:00-24:00" };
const AGENT = { companyId: CO, agentId: "agent-camp" };
const EVIDENCE = "Ticked the text offers box on the sign-up form on 2026-09-14";

const CASES = [
  { channel: "sms" as const, own: OWN_SMS, from: ADA, to: OWN_SMS },
  { channel: "whatsapp" as const, own: OWN_WHATSAPP, from: ADA, to: OWN_WHATSAPP },
];

function journeyStore(channel: "sms" | "whatsapp"): Store {
  const s = seed();
  s.crm_contacts = [contact("ada", "Ada Lovelace", ["ada@acme.test"], { phones: ["082 123 4567"] })];
  s.campaigns!.push(campaign("camp-text", { delivery: "auto" }));
  const template = channel === "whatsapp" ? { template_ref: "HX0123456789abcdef0123456789abcdef", template_vars: ["{{first_name}}"] } : {};
  s.campaign_steps!.push(
    { ...step("camp-text", 1, "a", "", "Hi {{first_name}}, your order is ready. Reply STOP to opt out."), channel, ...template },
    { ...step("camp-text", 2, "a", "", "Still ready, {{first_name}}. Reply STOP to opt out.", 2), channel, ...template },
  );
  s.channel_consents = [];
  s.channel_suppressions = [];
  s.channel_messages = [];
  return s;
}

describe.each(CASES)("opt-out loop on $channel", ({ channel, own, from, to }) => {
  async function bootJourney() {
    const store = journeyStore(channel);
    const mock = new MockProvider();
    const config = { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, messaging: { smsFrom: OWN_SMS, whatsappFrom: OWN_WHATSAPP, ...OPEN, inboundWebhookSecret: "0123456789abcdef-shared-secret" } };
    const booted = await boot({ store, config });
    setMessagingProvider(() => mock);
    return { ...booted, store, mock };
  }
  const stopStatus = (store: Store) => store.campaign_enrollments!.map((row) => row.status);

  it("honours recorded consent, then STOP, then START", async () => {
    const { harness, store, mock } = await bootJourney();

    // 1. Without a recorded opt-in the step is skipped, with the reason on the step event, and nothing is sent.
    store.campaign_enrollments!.push(enrollment("e0", "camp-text", "ada", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.campaign_step_events).toEqual([expect.objectContaining({ event_type: "skipped", meta: expect.objectContaining({ why: "no opt-in on record for this sender" }) })]);

    // 2. An agent records the opt-in with its evidence; the next enrollment's step goes out from our number.
    const recorded = await harness.executeTool<{ data?: Record<string, any> }>("record-channel-consent", { channel, contactIds: ["ada"], evidence: EVIDENCE }, AGENT);
    expect(recorded.data).toMatchObject({ channel, sender: "own", granted: true, recorded: 1 });
    expect(store.channel_consents).toEqual([expect.objectContaining({ channel, address: ADA, sender_key: "own", granted: true, evidence: EVIDENCE })]);
    store.campaign_enrollments!.push(enrollment("e1", "camp-text", "ada", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    expect(mock.sent).toEqual([expect.objectContaining({ channel, to: ADA, from: own })]);

    // 3. They reply STOP: the number goes on our do-not-message list for this channel and the campaign stops.
    store.campaign_enrollments!.push(enrollment("e2", "camp-text", "ada", { next_due_at: PAST, step_position: 2 }));
    mock.inboundQueue.push(reply(from, to, "STOP", "SMjourneystop", new Date().toISOString(), channel));
    await harness.runJob("poll-messaging");
    expect(store.channel_suppressions).toEqual([expect.objectContaining({ channel, address: ADA, sender_key: "own", reason: "stop_keyword", scope: "marketing", contact_id: "ada" })]);
    expect(store.campaign_enrollments!.filter((row) => row.id !== "e0").every((row) => row.status === "stopped")).toBe(true);

    // 4. Opted out: a fresh enrollment's step is not sent (the enrollment stops), however recent the opt-in was.
    const sentBefore = mock.sent.length;
    store.campaign_enrollments!.push(enrollment("e3", "camp-text", "ada", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(sentBefore);
    expect(store.campaign_enrollments!.find((row) => row.id === "e3")).toMatchObject({ status: "stopped", next_due_at: null });

    // 5. START lifts their own opt-out and records a fresh opt-in; the next step goes out again.
    mock.inboundQueue.push(reply(from, to, "START", "SMjourneystart", new Date(Date.now() + 1000).toISOString(), channel));
    await harness.runJob("poll-messaging");
    expect(store.channel_suppressions).toEqual([]);
    expect(store.channel_consents).toEqual(expect.arrayContaining([expect.objectContaining({ channel, address: ADA, granted: true, source: "reply" })]));
    store.campaign_enrollments!.push(enrollment("e4", "camp-text", "ada", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(sentBefore + 1);
    expect(stopStatus(store).at(-1)).toBe("running");
  });
});
