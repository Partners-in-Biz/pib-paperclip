import { describe, expect, it } from "vitest";
import { MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { applyEspEvent, ESP_DELIVERY_EVENT } from "../../src/esp/events.js";
import { parseSesEvent } from "../../src/esp/ses.js";
import { sendTagValue } from "../../src/esp/send.js";
import { CO } from "../helpers/memory.js";
import { addEspDomain, DOMAIN, espSetup } from "../helpers/esp.js";

type T = ReturnType<typeof espSetup>;

/** Build a SES SNS message body with correct structure (event-specific fields at top level, not inside mail). */
function sesEvent(
  eventType: string,
  options: {
    mail?: Partial<{ messageId: string; timestamp: string | number; source: string; destination: string[]; tags: Record<string, unknown> }>;
    bounce?: Record<string, unknown>;
    complaint?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
    deliveryDelay?: Record<string, unknown>;
    reject?: Record<string, unknown>;
    open?: Record<string, unknown>;
    click?: Record<string, unknown>;
  } = {},
): string {
  const mailDefaults = {
    messageId: "test-msg-id-123",
    timestamp: new Date().toISOString(),
    source: `sender@${DOMAIN}`,
    destination: ["recipient@example.com"],
    tags: { pib_company: [CO], pib_send: ["key_123"] },
  };

  const mailOptions = options.mail ?? {};
  // If tags are explicitly provided in options, use them as-is (allow overriding defaults)
  // Otherwise, merge them with defaults
  const mail = {
    ...mailDefaults,
    ...mailOptions,
    tags: "tags" in mailOptions ? mailOptions.tags : { ...mailDefaults.tags, ...mailOptions.tags },
  };

  const result: Record<string, unknown> = {
    eventType,
    mail,
  };

  // Add event-specific fields at top level (not inside mail)
  if (options.bounce) result.bounce = options.bounce;
  if (options.complaint) result.complaint = options.complaint;
  if (options.delivery) result.delivery = options.delivery;
  if (options.deliveryDelay) result.deliveryDelay = options.deliveryDelay;
  if (options.reject) result.reject = options.reject;
  if (options.open) result.open = options.open;
  if (options.click) result.click = options.click;

  return JSON.stringify(result);
}

describe("SES event handling", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const day = (domain = DOMAIN) => `${CO}:${domain}:${today()}`;

  async function setup() {
    const t = espSetup();
    await addEspDomain(t);
    return t;
  }

  it("applies a bounce with two bouncedRecipients on a three-recipient message => two esp_events rows with per-recipient event ids", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        mail: { destination: ["ann@x.co", "bob@x.co", "carol@x.co"] },
        bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "ann@x.co", diagnosticCode: "smtp; 550 user unknown" }, { emailAddress: "bob@x.co", diagnosticCode: "smtp; 550 user unknown" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Two recipients should be recorded with per-recipient event ids
    expect(t.store.espEvents).toHaveLength(2);
    expect(t.store.espEvents[0]!.eventId).toMatch(/delivery-123:ann@x\.co/i);
    expect(t.store.espEvents[1]!.eventId).toMatch(/delivery-123:bob@x\.co/i);

    // Both should be suppressed (scope all, reason bounced)
    const suppressions = [...t.store.suppressions.values()];
    expect(suppressions.filter((s) => s.email === "ann@x.co" && s.scope === "all")).toHaveLength(1);
    expect(suppressions.filter((s) => s.email === "bob@x.co" && s.scope === "all")).toHaveLength(1);

    // Announcements: one contact.suppressed and one mail.delivery per recipient
    const announcements = t.host.emitted.filter((e) => e.name === "contact.suppressed" || e.name === ESP_DELIVERY_EVENT);
    expect(announcements.filter((a) => a.name === "contact.suppressed")).toHaveLength(2);
    expect(announcements.filter((a) => a.name === ESP_DELIVERY_EVENT)).toHaveLength(2);

    // Counters: hard_bounces +2
    expect(t.store.espDays.get(day())).toMatchObject({ hard_bounces: 2 });
  });

  it("rejects a duplicate bounce event", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "ann@x.co", diagnosticCode: "550" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const first = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(first).toBe("applied");

    const second = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(second).toBe("duplicate");

    // Only one event recorded
    expect(t.store.espEvents).toHaveLength(1);
  });

  it("handles error on second recipient: forgets only that row, first stays, retry applies only the failed recipient", async () => {
    const t = await setup();
    // Inject an error for the second recipient (bob) by wrapping upsertSuppression
    let suppressionCallCount = 0;
    const originalUpsertSuppression = t.store.upsertSuppression.bind(t.store);
    t.store.upsertSuppression = async (input: Parameters<typeof originalUpsertSuppression>[0]) => {
      suppressionCallCount += 1;
      // Throw on the second suppression call (for bob@x.co)
      if (suppressionCallCount === 2) throw new Error("Injected error for bob");
      return originalUpsertSuppression(input);
    };

    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        mail: { destination: ["ann@x.co", "bob@x.co"] },
        bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "ann@x.co" }, { emailAddress: "bob@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    let errorThrown = false;
    try {
      await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    } catch (e) {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);

    // Ann's event should have been recorded, bob's should be forgotten
    expect(t.store.espEvents).toHaveLength(1);
    expect(t.store.espEvents[0]!.eventId).toMatch(/ann/i);

    // Restore original and retry
    t.store.upsertSuppression = originalUpsertSuppression;
    const retry = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(retry).toBe("applied");

    // Ann is now a duplicate, bob is newly applied
    expect(t.store.espEvents).toHaveLength(2);
    expect(t.store.espEvents.some((e) => e.eventId.includes("ann"))).toBe(true);
    expect(t.store.espEvents.some((e) => e.eventId.includes("bob"))).toBe(true);
  });

  it("handles Complaint => sender's marketing list", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("Complaint", {
        complaint: { complainedRecipients: [{ emailAddress: "ann@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Check suppression is on marketing scope with correct sender key
    const suppressions = [...t.store.suppressions.values()];
    expect(suppressions.filter((s) => s.email === "ann@x.co" && s.scope === "marketing")).toHaveLength(1);
  });

  it("handles suppressed kind (OnAccountSuppressionList)", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        bounce: { bounceType: "Permanent", bounceSubType: "OnAccountSuppressionList", bouncedRecipients: [{ emailAddress: "ann@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Should suppress globally like a hard bounce
    const suppressions = [...t.store.suppressions.values()];
    expect(suppressions.filter((s) => s.email === "ann@x.co" && s.scope === "all")).toHaveLength(1);

    // Should not count as hard bounce, just as failed
    expect(t.store.espDays.get(day())).toMatchObject({ hard_bounces: 0, failed: 1 });
  });

  it("handles Delivery clears soft-bounce health", async () => {
    const t = await setup();
    // First record a soft bounce
    t.store.health.set(`${CO}:ann@x.co`, { company_id: CO, email: "ann@x.co", soft_bounces: 3, first_soft_at: "2024-01-01T00:00:00Z", last_soft_at: "2024-01-02T00:00:00Z", backoff_until: null });

    const parsed = parseSesEvent(
      sesEvent("Delivery", {
        delivery: { recipients: ["ann@x.co"] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Health should be cleared
    expect(t.store.health.has(`${CO}:ann@x.co`)).toBe(false);
  });

  it("handles DeliveryDelay suppresses nobody, bumps no counters", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("DeliveryDelay", {
        deliveryDelay: { delayedRecipients: [{ emailAddress: "ann@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // No suppressions
    expect(t.store.suppressions.size).toBe(0);

    // No counters except what announceDelivery does
    const day_data = t.store.espDays.get(day("example.com"));
    expect(day_data?.hard_bounces ?? 0).toBe(0);
    expect(day_data?.complaints ?? 0).toBe(0);

    // But should announce mail.delivery
    const deliveryAnnouncements = t.host.emitted.filter((e) => e.name === ESP_DELIVERY_EVENT);
    expect(deliveryAnnouncements).toHaveLength(1);
  });

  it("handles Reject (failed) with empty about list applied once", async () => {
    const t = await setup();
    const parsed = parseSesEvent(sesEvent("Reject", { reject: { reason: "Email address is not verified" } }));

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // One event with bare id (not per-recipient)
    expect(t.store.espEvents).toHaveLength(1);
    expect(t.store.espEvents[0]!.eventId).toBe("delivery-123");

    // Counters
    expect(t.store.espDays.get(day())).toMatchObject({ failed: 1 });
  });

  it("handles Send event with empty about list applied once", async () => {
    const t = await setup();
    const parsed = parseSesEvent(sesEvent("Send"));

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // One event with bare id
    expect(t.store.espEvents).toHaveLength(1);
    expect(t.store.espEvents[0]!.eventId).toBe("delivery-123");

    // Send doesn't announce or count
    expect(t.host.emitted.filter((e) => e.name === ESP_DELIVERY_EVENT)).toHaveLength(0);
  });

  it("handles Open and Click with empty about list", async () => {
    const t = await setup();
    const openEvent = parseSesEvent(sesEvent("Open"));
    const clickEvent = parseSesEvent(sesEvent("Click", { click: { link: "https://example.com" } }));

    if (!("event" in openEvent) || !("event" in clickEvent)) throw new Error("Failed to parse events");

    await applyEspEvent(t.env, await t.loaded(), openEvent.event, { id: "delivery-123" });
    await applyEspEvent(t.env, await t.loaded(), clickEvent.event, { id: "delivery-124" });

    // Two events with bare ids
    expect(t.store.espEvents).toHaveLength(2);
    expect(t.store.espEvents[0]!.eventId).toBe("delivery-123");
    expect(t.store.espEvents[1]!.eventId).toBe("delivery-124");

    // Counters
    expect(t.store.espDays.get(day())).toMatchObject({ opened: 1, clicked: 1 });
  });

  it("reconciles failed-unknown send with Send event carrying pib_send", async () => {
    const t = await setup();

    // Create a failed-unknown send
    const sendKey = "test:send:123";
    const sendTagVal = sendTagValue(sendKey);
    t.store.sends.set(sendKey, {
      key: sendKey,
      company_id: CO,
      source_plugin: "test",
      account_id: null,
      from_address: "test@example.com",
      to_addrs: [{ email: "recipient@example.com" }],
      subject: "Test",
      status: "failed",
      permanent: false,
      attempts: 1,
      gmail_message_id: null,
      gmail_thread_id: null,
      rfc_message_id: null,
      error: "Unknown outcome",
      context: { plugin: "test", kind: "unknown", id: "1", clientKind: "company", clientRef: "ref" },
      request: { key: sendKey, to: [{ email: "recipient@example.com" }], subject: "Test", html: null, text: null, context: { plugin: "test", kind: "unknown", id: "1", clientKind: "company", clientRef: "ref" } },
      claimed_at: null,
      sent_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: null,
      provider_message_id: null,
    });

    // Parse Send event with matching pib_send tag
    const parsed = parseSesEvent(
      sesEvent("Send", {
        mail: { tags: { pib_company: [CO], pib_send: [sendTagVal] } },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Send should be reconciled to sent with provider_message_id
    const reconciled = t.store.sends.get(sendKey);
    expect(reconciled?.status).toBe("failed"); // Status stays failed, but delivery_status changes
    expect(reconciled?.provider).toBe("ses");
    expect(reconciled?.provider_message_id).toBe("ses:test-msg-id-123");
    expect(reconciled?.delivery_status).toBe("sent");
  });

  it("reconciles failed-unknown send with Delivered event", async () => {
    const t = await setup();

    // Create a failed-unknown send
    const sendKey = "test:send:456";
    const sendTagVal = sendTagValue(sendKey);
    t.store.sends.set(sendKey, {
      key: sendKey,
      company_id: CO,
      source_plugin: "test",
      account_id: null,
      from_address: "test@example.com",
      to_addrs: [{ email: "recipient@example.com" }],
      subject: "Test",
      status: "failed",
      permanent: false,
      attempts: 1,
      gmail_message_id: null,
      gmail_thread_id: null,
      rfc_message_id: null,
      error: "Unknown outcome",
      context: { plugin: "test", kind: "unknown", id: "1", clientKind: "company", clientRef: "ref" },
      request: { key: sendKey, to: [{ email: "recipient@example.com" }], subject: "Test", html: null, text: null, context: { plugin: "test", kind: "unknown", id: "1", clientKind: "company", clientRef: "ref" } },
      claimed_at: null,
      sent_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: null,
      provider_message_id: null,
    });

    // Parse Delivery event with matching pib_send tag
    const parsed = parseSesEvent(
      sesEvent("Delivery", {
        mail: { tags: { pib_company: [CO], pib_send: [sendTagVal] } },
        delivery: { recipients: ["recipient@example.com"] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("applied");

    // Send should be reconciled to delivered with provider_message_id
    const reconciled = t.store.sends.get(sendKey);
    expect(reconciled?.delivery_status).toBe("delivered");
    expect(reconciled?.provider).toBe("ses");
    expect(reconciled?.provider_message_id).toBe("ses:test-msg-id-123");
  });

  it("ignores event for unregistered domain", async () => {
    const t = await setup();
    // Create an event with an unregistered domain
    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        mail: { source: "sender@unknown-domain.com" },
        bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "ann@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("ignored");

    // No events, no suppressions
    expect(t.store.espEvents).toHaveLength(0);
    expect(t.store.suppressions.size).toBe(0);
  });

  it("ignores event for unknown message with no pib_company tag", async () => {
    const t = await setup();
    const parsed = parseSesEvent(
      sesEvent("Bounce", {
        mail: { tags: {} }, // No pib_company tag - override defaults
        bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "ann@x.co" }] },
      })
    );

    if (!("event" in parsed)) throw new Error("Failed to parse event");
    const outcome = await applyEspEvent(t.env, await t.loaded(), parsed.event, { id: "delivery-123" });
    expect(outcome).toBe("ignored");

    // No events, no suppressions
    expect(t.store.espEvents).toHaveLength(0);
    expect(t.store.suppressions.size).toBe(0);
  });
});
