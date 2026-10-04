import { describe, expect, it } from "vitest";
import { HANDOFF_EVENTS, MAIL_EVENTS, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { DOMAIN_HEALTH_EVENT } from "../../src/domain-health.js";
import { ESP_DELIVERY_EVENT, mergedDeliveryStatus } from "../../src/esp/events.js";
import { forgetWebhookCandidates, handleEspWebhook, WebhookRejected } from "../../src/esp/webhook.js";
import { handleSendRequested } from "../../src/gmail/send.js";
import { CO } from "../helpers/memory.js";
import { addEspDomain, API_KEY, CLIENT, DOMAIN, espSetup, eventBody, FROM, healthyCheck, invoice, knownToWebhook, marketing, OTHER_SECRET, sendEvent, svixHeaders, WEBHOOK_SECRET } from "../helpers/esp.js";

const OWN_DOMAIN = "mail.pib.test";
const OWN_FROM = `hello@${OWN_DOMAIN}`;
const today = () => new Date().toISOString().slice(0, 10);
const day = (domain = DOMAIN) => `${CO}:${domain}:${today()}`;

type T = ReturnType<typeof espSetup>;

/** A domain with one message already sent through it (the provider id is mock-0001), ready for events about it. */
async function sent(options: { key?: string; to?: string; client?: boolean } = {}): Promise<T> {
  const t = espSetup();
  await addEspDomain(t, options.client === false ? { domain: OWN_DOMAIN, client: null } : {});
  await knownToWebhook(t);
  const request = options.client === false
    ? invoice({ key: options.key ?? "billing:invoice:inv-1:send", from: OWN_FROM, to: [{ email: options.to ?? "ann@x.co" }] })
    : marketing({ key: options.key ?? "campaigns:step:e1:1", to: [{ email: options.to ?? "ann@x.co" }] });
  await handleSendRequested(t.env, sendEvent(request, options.client === false ? `plugin.${PIB_PLUGINS.billing}.mail.send.requested` : undefined));
  expect(t.provider.sent).toHaveLength(1);
  return t;
}

let seq = 0;
/** Delivers one event the way the host does: the raw body and the headers. */
async function deliver(t: T, body: string, options: { id?: string; secret?: string; timestamp?: number } = {}) {
  seq += 1;
  return handleEspWebhook(t.env, { rawBody: body, headers: svixHeaders(body, { id: options.id ?? `msg_${seq}`, ...options }) });
}

const emitted = (t: T, name: string) => t.host.emitted.filter((e) => e.name === name).map((e) => e.payload);
const bounce = (type: string, subType = "General", extra: Record<string, unknown> = {}) => eventBody("email.bounced", { bounce: { type, subType, message: "x" }, ...extra });

describe("the provider webhook is believed only when it is signed", () => {
  it("applies a delivery signed with the company's secret, and counts it", async () => {
    const t = await sent();
    const out = await deliver(t, eventBody("email.delivered"));
    expect(out).toEqual({ outcome: "applied", companyId: CO });
    expect(t.store.espDays.get(day())).toMatchObject({ sent: 1, delivered: 1 });
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ delivery_status: "delivered", delivery: { delivered_at: expect.any(String) } });
  });

  it("refuses a bad signature: a different secret, a changed body", async () => {
    const t = await sent();
    const body = eventBody("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "x" } });
    await expect(handleEspWebhook(t.env, { rawBody: body, headers: svixHeaders(body, { secret: OTHER_SECRET }) })).rejects.toMatchObject({ name: "WebhookRejected", code: "bad_signature" });
    await expect(handleEspWebhook(t.env, { rawBody: `${body} `, headers: svixHeaders(body) })).rejects.toMatchObject({ code: "bad_signature" });
    // Nothing was applied: nobody was suppressed, nothing counted.
    expect(t.store.suppressions.size).toBe(0);
    expect(t.store.espDays.get(day())!.hard_bounces).toBe(0);
    expect(t.store.espEvents).toHaveLength(0);
  });

  it("refuses a replay of an old delivery, even one that was correctly signed, and a missing or malformed header", async () => {
    const t = await sent();
    const body = eventBody("email.complained");
    const old = Math.floor(Date.now() / 1000) - 3600;
    await expect(handleEspWebhook(t.env, { rawBody: body, headers: svixHeaders(body, { timestamp: old }) })).rejects.toMatchObject({ code: "stale" });
    await expect(handleEspWebhook(t.env, { rawBody: body, headers: {} })).rejects.toMatchObject({ code: "missing" });
    await expect(handleEspWebhook(t.env, { rawBody: body, headers: { ...svixHeaders(body), "svix-signature": "v1,short" } })).rejects.toMatchObject({ code: "malformed" });
    expect(t.store.suppressions.size).toBe(0);
  });

  it("refuses everything when no company has the provider on with a webhook secret", async () => {
    const t = espSetup({ esp: { enabled: true, apiKey: API_KEY } });
    await knownToWebhook(t);
    const body = eventBody("email.delivered");
    await expect(handleEspWebhook(t.env, { rawBody: body, headers: svixHeaders(body) })).rejects.toMatchObject({ code: "unconfigured" });
    const off = espSetup({ esp: { enabled: false, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET } });
    await knownToWebhook(off);
    await expect(handleEspWebhook(off.env, { rawBody: body, headers: svixHeaders(body) })).rejects.toMatchObject({ code: "unconfigured" });
  });

  it("tells a public caller the same thing whatever the reason, and keeps the reason in the worker log", async () => {
    const t = await sent();
    const body = eventBody("email.delivered");
    const reasons = new Map<string, string>();
    const attempt = async (name: string, headers: Record<string, string>, rawBody = body, env = t.env) => {
      const error = (await handleEspWebhook(env, { rawBody, headers }).catch((e: Error) => e)) as WebhookRejected;
      reasons.set(name, error.message);
      return error;
    };
    const none = espSetup({ esp: { enabled: false } });
    await knownToWebhook(none);
    await attempt("bad signature", svixHeaders(body, { secret: OTHER_SECRET }));
    await attempt("stale", svixHeaders(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }));
    await attempt("missing", {});
    forgetWebhookCandidates();
    await attempt("nobody has it on", svixHeaders(body), body, none.env);
    await attempt("too large", svixHeaders("x"), "x".repeat(300_000));
    expect(new Set(reasons.values())).toEqual(new Set(["The delivery could not be verified"]));
    // The worker log says which check failed, without the body or any secret.
    const logged = JSON.stringify((t.host.ctx.logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).toMatch(/"code":"bad_signature"/);
    expect(logged).toMatch(/"code":"stale"/);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toContain("ann@x.co");
  });

  it("logs a refusal at info, once a minute per reason with a count of the rest, so a flood of forged deliveries cannot fill the log", async () => {
    const t = await sent();
    const body = eventBody("email.delivered");
    const log = () => (t.host.ctx.logger.info as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }).mock.calls.filter(([message]) => message === "Provider webhook refused");
    const forge = (env = t.env) => handleEspWebhook(env, { rawBody: body, headers: svixHeaders(body, { secret: OTHER_SECRET }) }).catch(() => undefined);
    for (let i = 0; i < 50; i += 1) await forge();
    expect(log()).toHaveLength(1);
    expect(log()[0]![1]).toMatchObject({ code: "bad_signature" });
    expect((t.host.ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([message]) => message === "Provider webhook refused")).toHaveLength(0);
    // A minute later the next one is logged, with how many were left out in between.
    t.env.now = () => Date.now() + 61_000;
    await handleEspWebhook(t.env, { rawBody: body, headers: svixHeaders(body, { secret: OTHER_SECRET }) }).catch(() => undefined);
    expect(log()).toHaveLength(2);
    expect(log()[1]![1]).toMatchObject({ code: "bad_signature", alsoRefused: 49 });
    // A different reason is its own line.
    await handleEspWebhook(t.env, { rawBody: body, headers: {} }).catch(() => undefined);
    expect(log().map(([, fields]) => fields.code)).toEqual(["bad_signature", "bad_signature", "missing"]);
  });

  it("refuses an oversized body before it is parsed", async () => {
    const t = await sent();
    const huge = JSON.stringify({ type: "email.delivered", data: { pad: "x".repeat(300_000) } });
    await expect(handleEspWebhook(t.env, { rawBody: huge, headers: svixHeaders(huge) })).rejects.toMatchObject({ code: "too_large" });
  });

  it("the secret decides the company: a delivery signed with company B's secret is never applied to A, whatever the tag in it says, and is B's only when it is about a message B sent", async () => {
    const t = await sent();
    // Two companies with their own secrets (the fake host otherwise answers every company with one config).
    const configs: Record<string, Record<string, unknown>> = {
      [CO]: { publicBaseUrl: "https://paperclip.example.com", esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET } },
      "co-2": { publicBaseUrl: "https://paperclip.example.com", esp: { enabled: true, apiKey: API_KEY, webhookSecret: OTHER_SECRET } },
    };
    (t.host.ctx.config as unknown as { get: (id: string) => Promise<unknown> }).get = async (id: string) => configs[id] ?? {};
    const { rememberCompany } = await import("../../src/setup-status.js");
    await rememberCompany(t.host.ctx, "co-2");
    await addEspDomain(t, { company: "co-2", id: "esp-co2" });
    const { forgetWebhookCandidates } = await import("../../src/esp/webhook.js");
    forgetWebhookCandidates();
    // The body says it is company 1's (its tag) but is signed with company 2's secret: company 2 is the company, and it never sent that
    // message, so nothing changes anywhere.
    const lie = eventBody("email.complained", { email_id: "mock-0001", tags: { pib_company: CO } });
    const none = await handleEspWebhook(t.env, { rawBody: lie, headers: svixHeaders(lie, { secret: OTHER_SECRET }) });
    expect(none).toMatchObject({ outcome: "ignored", companyId: "co-2" });
    expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.complaints).toBe(0);
    expect(t.store.suppressions.size).toBe(0);
    // About a message company 2 sent (its own tag), signed with its secret: applied to company 2 only.
    const own = eventBody("email.complained", { email_id: "mock-0002", tags: { pib_company: "co-2" } });
    const out = await handleEspWebhook(t.env, { rawBody: own, headers: svixHeaders(own, { secret: OTHER_SECRET, id: "msg_co2" }) });
    expect(out).toMatchObject({ outcome: "applied", companyId: "co-2" });
    expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.complaints).toBe(0);
    expect([...t.store.suppressions.values()].map((row) => row.company_id)).toEqual(["co-2"]);
  });

  it("when the signature verifies for company A, the delivery is applied to A even if the tag names B", async () => {
    const t = await sent();
    const body = eventBody("email.delivered", { tags: { pib_company: "co-2" } });
    expect(await deliver(t, body)).toMatchObject({ outcome: "applied", companyId: CO });
  });
});

describe("a delivery is applied once", () => {
  it("a replay of the same delivery id changes nothing", async () => {
    const t = await sent();
    const body = eventBody("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "x" } });
    expect(await deliver(t, body, { id: "msg_same" })).toMatchObject({ outcome: "applied" });
    expect(await deliver(t, body, { id: "msg_same" })).toMatchObject({ outcome: "duplicate" });
    expect(t.store.espDays.get(day())!.hard_bounces).toBe(1);
    expect(emitted(t, HANDOFF_EVENTS.contactSuppressed)).toHaveLength(1);
    expect(emitted(t, ESP_DELIVERY_EVENT)).toHaveLength(1);
  });

  it("a second copy under another delivery id (the same message, kind and recipient) changes nothing either", async () => {
    const t = await sent();
    const body = eventBody("email.complained");
    expect(await deliver(t, body)).toMatchObject({ outcome: "applied" });
    expect(await deliver(t, body)).toMatchObject({ outcome: "duplicate" });
    expect(t.store.espDays.get(day())!.complaints).toBe(1);
    expect(t.store.espEvents).toHaveLength(1);
  });

  it("opens and clicks are counted once per delivery, not once per message", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.clicked", { click: { link: "https://x" } }));
    await deliver(t, eventBody("email.clicked", { click: { link: "https://y" } }));
    expect(t.store.espDays.get(day())!.clicked).toBe(2);
    await deliver(t, eventBody("email.opened"));
    expect(t.store.espDays.get(day())!.opened).toBe(1);
    // Opens and clicks are counted and announced (they can repeat: a consumer counts the first per send); only the provider's own "sent" is not.
    expect(emitted(t, ESP_DELIVERY_EVENT).map((p) => p.type)).toEqual(["clicked", "clicked", "opened"]);
  });

  it("announces mail.delivery in the kit's shape: the send's key, the client it was for, the provider and the time, and no content", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.delivered", {}, { createdAt: "2026-10-04T08:00:00.000Z" }), { id: "msg_shape" });
    expect(ESP_DELIVERY_EVENT).toBe(MAIL_EVENTS.delivery);
    const [delivery] = emitted(t, MAIL_EVENTS.delivery);
    expect(delivery).toEqual({
      key: "esp:msg_shape",
      type: "delivered",
      provider: "resend",
      sendKey: "campaigns:step:e1:1",
      recipient: "ann@x.co",
      at: "2026-10-04T08:00:00.000Z",
      context: marketing().context,
      clientKind: CLIENT.kind,
      clientRef: CLIENT.ref,
    });
    // The company's own mail has no client; an event about a send the Mailbox does not know yet takes the client of the domain it came through.
    const own = await sent({ client: false });
    await deliver(own, eventBody("email.delivered", { from: `Partners in Biz <${OWN_FROM}>` }), { id: "msg_own" });
    expect(emitted(own, MAIL_EVENTS.delivery)[0]).toMatchObject({ clientKind: null, clientRef: null, sendKey: "billing:invoice:inv-1:send" });
    const early = await sent();
    await deliver(early, eventBody("email.delivered", { email_id: "not-recorded-yet" }), { id: "msg_early" });
    expect(emitted(early, MAIL_EVENTS.delivery)[0]).toMatchObject({ sendKey: null, context: null, clientKind: CLIENT.kind, clientRef: CLIENT.ref });
    expect(JSON.stringify(emitted(t, MAIL_EVENTS.delivery))).not.toMatch(/subject|Spring offer|Hi Ann/);
  });

  it("an event that fails to apply is taken back out, so the provider's retry applies it", async () => {
    const t = await sent();
    const original = t.store.bumpEspDay.bind(t.store);
    let broken = true;
    t.store.bumpEspDay = async (...args) => {
      if (broken) throw new Error("the database dropped");
      return original(...args);
    };
    const body = eventBody("email.delivered");
    await expect(deliver(t, body, { id: "msg_retry" })).rejects.toThrow(/database dropped/);
    expect(t.store.espEvents).toHaveLength(0);
    broken = false;
    expect(await deliver(t, body, { id: "msg_retry" })).toMatchObject({ outcome: "applied" });
    expect(t.store.espDays.get(day())!.delivered).toBe(1);
  });

  it("an event that fails AFTER its suppression was written is not counted twice when the provider delivers it again", async () => {
    const t = await sent();
    const original = t.store.setSendDelivery.bind(t.store);
    let broken = true;
    t.store.setSendDelivery = async (...args) => {
      if (broken) throw new Error("the database dropped");
      return original(...args);
    };
    const body = bounce("Permanent");
    await expect(deliver(t, body, { id: "msg_half" })).rejects.toThrow(/database dropped/);
    // The do-not-email entry is the same when written twice; the day's counter is not, so it must not have moved yet.
    expect(t.store.suppressions.get(`${CO}:ann@x.co:`)).toMatchObject({ scope: "all" });
    expect(t.store.espDays.get(day())?.hard_bounces ?? 0).toBe(0);
    expect(t.store.espEvents).toHaveLength(0);
    broken = false;
    expect(await deliver(t, body, { id: "msg_half" })).toMatchObject({ outcome: "applied" });
    expect(t.store.espDays.get(day())!.hard_bounces).toBe(1);
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ delivery_status: "bounced" });
  });

  it("an event about a message we did not send, or another domain, or another kind of event, is acknowledged and ignored", async () => {
    const t = await sent();
    // Another app's mail through the same provider account (not a domain the company registered).
    expect(await deliver(t, eventBody("email.bounced", { from: "App <noreply@some-other-app.io>", to: ["x@y.co"], bounce: { type: "Permanent", subType: "General", message: "x" } }))).toMatchObject({ outcome: "ignored" });
    expect(t.store.suppressions.size).toBe(0);
    expect(await deliver(t, JSON.stringify({ type: "contact.created", data: { id: "c1" } }))).toMatchObject({ outcome: "ignored" });
    expect(await deliver(t, "not json")).toMatchObject({ outcome: "ignored" });
    expect(await deliver(t, eventBody("email.sent"))).toMatchObject({ outcome: "applied" });
    expect(t.store.espDays.get(day())).toMatchObject({ hard_bounces: 0 });
  });

  it("with the Mailbox switched off in Setup it acknowledges and changes nothing", async () => {
    const t = await sent();
    const state = t.host.ctx.state as unknown as { get: (key: { namespace?: string; stateKey?: string }) => Promise<unknown> };
    const original = state.get;
    state.get = async (key) => (key.namespace === "pib-setup" && key.stateKey === "modules" ? { companyId: CO, modules: { mailbox: false }, updatedAt: new Date().toISOString() } : original(key));
    expect(await deliver(t, bounce("Permanent"))).toMatchObject({ outcome: "ignored" });
    expect(t.store.suppressions.size).toBe(0);
  });
});

describe("hard bounces", () => {
  it("put the address on the do-not-email list for ALL mail, tell the other plugins, and stop even an invoice", async () => {
    const t = await sent({ client: false, to: "ann@x.co" });
    await deliver(t, bounce("Permanent", "General", { from: `Partners <${OWN_FROM}>` }));
    const row = t.store.suppressions.get(`${CO}:ann@x.co:`)!;
    expect(row).toMatchObject({ scope: "all", reason: "bounced", source: "partnersinbiz.mailbox", sender_key: "" });
    expect(emitted(t, HANDOFF_EVENTS.contactSuppressed)).toEqual([expect.objectContaining({ email: "ann@x.co", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox" })]);
    expect(emitted(t, ESP_DELIVERY_EVENT)).toEqual([expect.objectContaining({ type: "bounced", provider: "resend", sendKey: "billing:invoice:inv-1:send", recipient: "ann@x.co", bounce: { kind: "hard", subType: "General" }, context: expect.objectContaining({ plugin: PIB_PLUGINS.billing }) })]);
    expect(t.store.espDays.get(day(OWN_DOMAIN))).toMatchObject({ hard_bounces: 1 });
    expect(t.store.sends.get("billing:invoice:inv-1:send")).toMatchObject({ delivery_status: "bounced" });
    const again = await handleSendRequested(t.env, sendEvent(invoice({ key: "billing:invoice:inv-2:send", from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
    expect(again).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@x.co", scope: "all", reason: "bounced" }] });
  });

  it("are per address, not per sender: a client's recipient that bounced is blocked for the company's own mail too", async () => {
    const t = await sent();
    await deliver(t, bounce("Permanent"));
    const row = t.store.suppressions.get(`${CO}:ann@x.co:`)!;
    expect(row.sender_key).toBe("");
    expect(row.scope).toBe("all");
  });

  it("a message to several recipients does not say which one bounced: nobody is suppressed, but it still counts toward the rate", async () => {
    const t = espSetup();
    await addEspDomain(t, { domain: OWN_DOMAIN, client: null });
    await knownToWebhook(t);
    await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, to: [{ email: "a@x.co" }, { email: "b@x.co" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
    expect(await deliver(t, bounce("Permanent", "General", { from: OWN_FROM, to: ["a@x.co", "b@x.co"] }))).toMatchObject({ outcome: "applied" });
    expect(t.store.suppressions.size).toBe(0);
    expect(t.store.espDays.get(day(OWN_DOMAIN))!.hard_bounces).toBe(1);
  });

  it("a message the Mailbox has no record of yet still counts when it carries the Mailbox's own tag (the webhook can beat the database write by milliseconds)", async () => {
    const t = await sent();
    await deliver(t, bounce("Permanent", "General", { email_id: "mock-9999", to: ["stranger@x.co"] }));
    expect(t.store.suppressions.get(`${CO}:stranger@x.co:`)).toMatchObject({ scope: "all", reason: "bounced" });
    expect(t.store.espDays.get(day())!.hard_bounces).toBe(1);
  });

  describe("a provider team shared with another app (the webhook is team-wide)", () => {
    // The other app (the PiB web app, say) sends from the same domain through the same team: its events arrive here too, untagged and unknown.
    const foreign = (type: string, extra: Record<string, unknown> = {}) => eventBody(type, { email_id: "web-app-1", to: ["customer@x.co"], tags: {}, ...extra });

    it("its bounces, complaints, deliveries and opens change nothing: no counter, no do-not-email entry, no announcement, nothing recorded", async () => {
      const t = await sent();
      const before = JSON.stringify([...t.store.espDays.values()]);
      for (const [i, body] of [foreign("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "x" } }), foreign("email.complained"), foreign("email.delivered"), foreign("email.opened"), foreign("email.clicked"), foreign("email.suppressed"), foreign("email.bounced", { bounce: { type: "Transient", subType: "MailboxFull", message: "x" } })].entries()) {
        expect(await deliver(t, body, { id: `msg_foreign_${i}` })).toMatchObject({ outcome: "ignored" });
      }
      expect(JSON.stringify([...t.store.espDays.values()])).toBe(before);
      expect(t.store.suppressions.size).toBe(0);
      expect(t.store.health.size).toBe(0);
      expect(t.store.espEvents).toHaveLength(0);
      expect(emitted(t, ESP_DELIVERY_EVENT)).toEqual([]);
      expect(emitted(t, HANDOFF_EVENTS.contactSuppressed)).toEqual([]);
    });

    it("so a foreign flood cannot push the domain over its bounce rate, however many it sends", async () => {
      const t = espSetup();
      await addEspDomain(t, { domain: OWN_DOMAIN, client: null });
      await knownToWebhook(t);
      await healthyCheck(t, OWN_DOMAIN);
      for (let i = 0; i < 12; i += 1) await deliver(t, foreign("email.bounced", { from: OWN_FROM, email_id: `web-${i}`, to: [`c${i}@x.co`], bounce: { type: "Permanent", subType: "General", message: "x" } }), { id: `msg_flood_${i}` });
      expect(t.store.domainChecks.get(`${CO}:${OWN_DOMAIN}`)!.status).toBe("healthy");
      expect(t.store.espDays.get(day(OWN_DOMAIN))).toBeUndefined();
      expect(t.store.suppressions.size).toBe(0);
    });

    it("a tag naming another company is foreign too, and a message this company recorded counts even without a tag", async () => {
      const t = await sent();
      expect(await deliver(t, foreign("email.complained", { tags: { pib_company: "co-2" } }))).toMatchObject({ outcome: "ignored" });
      expect(t.store.suppressions.size).toBe(0);
      // The recorded message (mock-0001) has no tag in this event, and is still ours.
      expect(await deliver(t, eventBody("email.delivered", { tags: {} }))).toMatchObject({ outcome: "applied" });
      expect(t.store.espDays.get(day())!.delivered).toBe(1);
    });
  });

  it("the provider's own suppression of an address is treated as a hard bounce, but is not the domain's bounce rate", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.suppressed"));
    expect(t.store.suppressions.get(`${CO}:ann@x.co:`)).toMatchObject({ scope: "all", reason: "bounced" });
    expect(t.store.espDays.get(day())).toMatchObject({ hard_bounces: 0, failed: 1 });
  });

  it("crossing 2% of the last 7 days holds the domain's marketing back at once, announces it, and keeps invoices going", async () => {
    const t = espSetup();
    await addEspDomain(t, { domain: OWN_DOMAIN, client: null });
    await knownToWebhook(t);
    await healthyCheck(t, OWN_DOMAIN);
    // 99 recipients already sent today and one hard bounce so far; the invoice below makes 100 sent (1%).
    t.store.espDays.set(day(OWN_DOMAIN), { company_id: CO, domain: OWN_DOMAIN, day: today(), sent: 99, delivered: 98, hard_bounces: 1, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 });
    t.provider.markVerified(OWN_DOMAIN);
    await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
    const before = emitted(t, DOMAIN_HEALTH_EVENT).length;
    // The second hard bounce makes it 2 of 100.
    await deliver(t, bounce("Permanent", "General", { from: OWN_FROM }));
    const check = t.store.domainChecks.get(`${CO}:${OWN_DOMAIN}`)!;
    expect(check.status).toBe("bad");
    expect((check.result as { problems: Array<{ code: string; blocks?: string }> }).problems).toEqual([expect.objectContaining({ code: "esp_bounce_rate", blocks: "marketing" })]);
    expect(emitted(t, DOMAIN_HEALTH_EVENT)).toHaveLength(before + 1);
    expect(emitted(t, DOMAIN_HEALTH_EVENT).at(-1)).toMatchObject({ domain: OWN_DOMAIN, status: "bad", healthy: false, problems: [expect.objectContaining({ code: "esp_bounce_rate" })] });
    // Marketing is held back, an invoice still goes.
    const mk = await handleSendRequested(t.env, sendEvent(marketing({ from: OWN_FROM, key: "m1", to: [{ email: "new@x.co" }], context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "s" } })));
    expect(mk).toMatchObject({ status: "failed", permanent: true });
    expect(mk!.error).toMatch(/2 of 100 recipients hard bounced/);
    expect(await handleSendRequested(t.env, sendEvent(invoice({ key: "billing:invoice:inv-9:send", from: OWN_FROM, to: [{ email: "fresh@x.co" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent" });
  });

  it("does not raise it below the limit, and does not announce when nothing changed", async () => {
    const t = espSetup();
    await addEspDomain(t, { domain: OWN_DOMAIN, client: null });
    await knownToWebhook(t);
    await healthyCheck(t, OWN_DOMAIN);
    t.store.espDays.set(day(OWN_DOMAIN), { company_id: CO, domain: OWN_DOMAIN, day: today(), sent: 1000, delivered: 1000, hard_bounces: 0, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 });
    await deliver(t, bounce("Permanent", "General", { from: OWN_FROM }));
    expect(t.store.domainChecks.get(`${CO}:${OWN_DOMAIN}`)!.status).toBe("healthy");
    expect(emitted(t, DOMAIN_HEALTH_EVENT)).toHaveLength(0);
  });
});

describe("soft bounces", () => {
  it("back off marketing to the address 6, then 24, then 72 hours, and the third in 14 days puts it on the marketing list (not the invoice list)", async () => {
    const t = await sent();
    const hours = (email: string) => (Date.parse(t.store.health.get(`${CO}:${email}`)!.backoff_until!) - Date.now()) / 3_600_000;
    const soft = (extra: Record<string, unknown> = {}) => bounce("Transient", "MailboxFull", extra);
    await deliver(t, soft());
    expect(Math.round(hours("ann@x.co"))).toBe(6);
    expect(t.store.suppressions.size).toBe(0);
    await deliver(t, soft({ email_id: "mock-0002" }));
    expect(Math.round(hours("ann@x.co"))).toBe(24);
    await deliver(t, soft({ email_id: "mock-0003" }));
    expect(Math.round(hours("ann@x.co"))).toBe(72);
    // The third: marketing is suppressed for the CLIENT's list; the address is not blocked for transactional mail.
    expect(t.store.suppressions.get(`${CO}:ann@x.co:company:${CLIENT.ref}`)).toMatchObject({ scope: "marketing", reason: "bounced" });
    expect(t.store.suppressions.has(`${CO}:ann@x.co:`)).toBe(false);
    expect(t.store.espDays.get(day())!.soft_bounces).toBe(3);
    expect(emitted(t, HANDOFF_EVENTS.contactSuppressed)).toEqual([expect.objectContaining({ scope: "marketing", reason: "bounced", senderKey: `company:${CLIENT.ref}` })]);
  });

  it("a delivered message to the address clears the soft bounces: it works", async () => {
    const t = await sent();
    await deliver(t, bounce("Transient", "MailboxFull"));
    expect(t.store.health.has(`${CO}:ann@x.co`)).toBe(true);
    await deliver(t, eventBody("email.delivered"));
    expect(t.store.health.has(`${CO}:ann@x.co`)).toBe(false);
  });

  it("are not counted as the domain's bounce rate, and Undetermined is soft too", async () => {
    const t = await sent();
    await deliver(t, bounce("Undetermined", "Undetermined"));
    expect(t.store.espDays.get(day())).toMatchObject({ hard_bounces: 0, soft_bounces: 1 });
  });

  it("a delay is noted on the send and suppresses nobody", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.delivery_delayed"));
    expect(t.store.suppressions.size).toBe(0);
    expect(t.store.health.size).toBe(0);
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ delivery_status: "delayed" });
  });
});

describe("complaints", () => {
  it("go on the SENDER's marketing list (the client's), are announced, and withdraw consent; the company's own marketing is untouched", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.complained"));
    expect(t.store.suppressions.get(`${CO}:ann@x.co:company:${CLIENT.ref}`)).toMatchObject({ scope: "marketing", reason: "complained", source: "partnersinbiz.mailbox" });
    expect(t.store.suppressions.has(`${CO}:ann@x.co:own`)).toBe(false);
    expect(t.store.suppressions.has(`${CO}:ann@x.co:`)).toBe(false);
    expect(emitted(t, HANDOFF_EVENTS.contactSuppressed)).toEqual([expect.objectContaining({ email: "ann@x.co", reason: "complained", scope: "marketing", senderKey: `company:${CLIENT.ref}`, clientKind: null })]);
    expect(emitted(t, HANDOFF_EVENTS.consentRecorded)).toEqual([expect.objectContaining({ granted: false, purpose: "marketing_email", source: "api", subject: expect.objectContaining({ email: "ann@x.co", clientRef: CLIENT.ref }) })]);
    expect(t.store.espDays.get(day())!.complaints).toBe(1);
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ delivery_status: "complained" });
    // The client's next campaign to the address is stopped; the company's own is not; an invoice is not.
    const next = await handleSendRequested(t.env, sendEvent(marketing({ key: "next" })));
    expect(next).toMatchObject({ status: "failed", suppressed: [{ email: "ann@x.co", scope: "marketing", reason: "complained" }] });
    const { checkSuppression } = await import("../../src/suppression.js");
    expect((await checkSuppression(t.store, CO, { ...marketing(), key: "own" }, "own")).blocked).toBe(false);
    expect((await checkSuppression(t.store, CO, { ...invoice(), to: [{ email: "ann@x.co" }] }, "own")).blocked).toBe(false);
  });

  it("a complaint rate of 0.1% holds marketing back", async () => {
    const t = espSetup();
    await addEspDomain(t, { domain: OWN_DOMAIN, client: null });
    await knownToWebhook(t);
    await healthyCheck(t, OWN_DOMAIN);
    t.store.espDays.set(day(OWN_DOMAIN), { company_id: CO, domain: OWN_DOMAIN, day: today(), sent: 1999, delivered: 1999, hard_bounces: 0, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 });
    await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
    await deliver(t, eventBody("email.complained", { from: OWN_FROM }));
    expect(t.store.domainChecks.get(`${CO}:${OWN_DOMAIN}`)!.status).toBe("healthy");
    // Two complaints in 2000 recipients is 0.1%.
    await deliver(t, eventBody("email.complained", { from: OWN_FROM, email_id: "mock-9", to: ["b@x.co"] }));
    expect(t.store.domainChecks.get(`${CO}:${OWN_DOMAIN}`)!.status).toBe("bad");
  });
});

describe("failed and domain events", () => {
  it("a failed message is noted with its reason, and a quota reason shows on the provider's state", async () => {
    const t = await sent();
    await deliver(t, eventBody("email.failed", { failed: { reason: "reached_daily_quota" } }));
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ delivery_status: "failed", delivery: expect.objectContaining({ reason: "reached_daily_quota" }) });
    expect(t.store.espDays.get(day())!.failed).toBe(1);
    const { readEspState } = await import("../../src/esp/runtime.js");
    expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "quota" });
  });

  it("a domain event reads the provider's status of the domain again and brings the account up", async () => {
    const t = espSetup();
    const remote = await t.provider.addDomain({ name: DOMAIN, region: "eu-west-1" });
    await addEspDomain(t, { status: "pending" });
    t.store.espDomains.get(`${CO}:${DOMAIN}`)!.provider_domain_id = remote.id;
    await knownToWebhook(t);
    t.provider.markVerified(DOMAIN);
    const body = JSON.stringify({ type: "domain.updated", created_at: new Date().toISOString(), data: { id: remote.id, name: DOMAIN, status: "verified" } });
    expect(await deliver(t, body)).toMatchObject({ outcome: "applied" });
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ status: "verified", verified_at: expect.any(String) });
    expect(t.store.accounts.get(`esp-${DOMAIN}`)!.status).toBe("connected");
    // A domain event about a domain we do not know is acknowledged.
    expect(await deliver(t, JSON.stringify({ type: "domain.updated", data: { id: "unknown-id", name: "x.co", status: "verified" } }))).toMatchObject({ outcome: "ignored" });
  });
});

describe("the strongest thing that happened to a message wins", () => {
  it("a bounce is never overwritten by a late 'delivered'", async () => {
    const t = await sent();
    await deliver(t, bounce("Permanent"));
    await deliver(t, eventBody("email.delivered"));
    expect(t.store.sends.get("campaigns:step:e1:1")!.delivery_status).toBe("bounced");
    expect(mergedDeliveryStatus("delivered", "bounced")).toBe("bounced");
    expect(mergedDeliveryStatus("bounced", "delivered")).toBe("bounced");
    expect(mergedDeliveryStatus("complained", "bounced")).toBe("complained");
    expect(mergedDeliveryStatus(null, "delayed")).toBe("delayed");
    expect(mergedDeliveryStatus("delivered", "delayed")).toBe("delivered");
  });
});

describe("what the pieces do together", () => {
  it("a hard bounce found through the webhook reaches a later send as a failed result with the suppressed list (the contract Campaigns already reads)", async () => {
    const t = await sent();
    await deliver(t, bounce("Permanent"));
    const next = await handleSendRequested(t.env, sendEvent(marketing({ key: "campaigns:step:e1:2" })));
    expect(next).toMatchObject({ key: "campaigns:step:e1:2", status: "failed", permanent: true, suppressed: [{ email: "ann@x.co", scope: "all", reason: "bounced" }] });
    expect(t.host.emitted.filter((e) => e.name === MAIL_EVENTS.sendResult)).toHaveLength(2);
    // The first result (sent) was never replaced by a second one for the same key.
    expect(t.host.emitted.filter((e) => e.name === MAIL_EVENTS.sendResult && e.payload.key === "campaigns:step:e1:1")).toHaveLength(1);
  });

  it("uses FROM only for the domain: the same events for a client domain and the company's own are kept apart", async () => {
    const t = espSetup();
    await addEspDomain(t);
    await addEspDomain(t, { domain: OWN_DOMAIN, client: null, id: "esp-own" });
    await knownToWebhook(t);
    await handleSendRequested(t.env, sendEvent(marketing()));
    await deliver(t, eventBody("email.delivered", { from: `X <${OWN_FROM}>`, email_id: "other" }));
    expect(t.store.espDays.get(day(OWN_DOMAIN))!.delivered).toBe(1);
    expect(t.store.espDays.get(day(DOMAIN))!.delivered).toBe(0);
    expect(FROM).not.toBe(OWN_FROM);
  });
});
