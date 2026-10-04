/**
 * A client message (context kind client_message: a signing email, a report) through the email provider, on the in-memory store and the mock
 * provider: its links must reach the recipient untouched, so it is not handed to a domain that tracks, and its text is not kept after the send.
 * (The same on a real Postgres, with the whole schema scanned for the link, is in `private-mail.pg.spec.ts`.)
 */
import { describe, expect, it } from "vitest";
import { PIB_PLUGINS, pluginEvent, MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { handleSendRequested, retrySend } from "../../src/gmail/send.js";
import { readEspState } from "../../src/esp/runtime.js";
import { trackingProblem } from "../../src/esp/send.js";
import { EspApiError } from "../../src/esp/types.js";
import { CO } from "../helpers/memory.js";
import { addEspDomain, CLIENT, DOMAIN, espSetup, FROM, results, sendEvent } from "../helpers/esp.js";

const TOKEN = ["pibt", "unit".padEnd(40, "z")].join("_");
const LINK = `https://paperclip.example.com/_plugins/00000000-0000-4000-8000-000000000001/ui/s/page1234.html#${TOKEN}`;
const CRM_SEND = pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested);

function signing(overrides: Record<string, unknown> = {}) {
  return {
    key: "crm:msg:a1",
    from: FROM,
    to: [{ email: "ada@client.co.za", name: "Ada" }],
    subject: "Please sign",
    text: `Sign here: ${LINK}`,
    html: `<p><a href="${LINK}">Sign</a></p>`,
    context: { plugin: PIB_PLUGINS.crm, kind: "client_message", id: "a1", clientKind: CLIENT.kind, clientRef: CLIENT.ref },
    marketing: false,
    ...overrides,
  };
}

/** The domain is registered at the mock provider too (the guard asks the provider about it), with the ids lined up. */
async function ready() {
  const t = espSetup();
  await addEspDomain(t);
  const remote = await t.provider.addDomain({ name: DOMAIN });
  t.store.espDomains.get(`${CO}:${DOMAIN}`)!.provider_domain_id = remote.id;
  t.provider.markVerified(DOMAIN);
  return t;
}
const asked = (t: Awaited<ReturnType<typeof ready>>) => t.provider.calls.filter((call) => call === "getDomain").length;
const idle = (t: Awaited<ReturnType<typeof ready>>) => t.provider.sent.length === 0 && t.gmail.sent.length === 0;

describe("a client message through the provider", () => {
  it("goes out when the provider says tracking is off, as written, and the Mailbox asked first", async () => {
    const t = await ready();
    const result = await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND));
    expect(result).toMatchObject({ status: "sent", provider: "resend" });
    expect(asked(t)).toBe(1);
    expect(t.provider.sent[0]!.email).toMatchObject({ html: `<p><a href="${LINK}">Sign</a></p>`, text: `Sign here: ${LINK}` });
    // No unsubscribe header (it is not marketing) and nothing else that touches the links.
    expect(t.provider.sent[0]!.email.headers).toBeUndefined();
  });

  it("is refused for good, and handed to nobody, when click tracking is on: the answer says how to fix it, and Gmail is not used instead", async () => {
    const t = await ready();
    t.provider.setTracking(DOMAIN, { click: true });
    const result = await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/^Not sent: click tracking is switched on for updates\.client\.co\.za at the email provider\./);
    expect(result!.error).toMatch(/rewrites links through the provider's own address/);
    expect(result!.error).toMatch(/resend\.com\/domains/);
    expect(result!.error).toMatch(/Gmail mailbox/);
    expect(idle(t)).toBe(true);
    // The text is gone from the record (it failed for good) and what the provider said is kept.
    const row = t.store.sends.get("crm:msg:a1")!;
    expect(row).toMatchObject({ status: "failed", permanent: true });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ click_tracking: true, open_tracking: false });
    // A retry by hand has no text to send, and says why.
    await expect(retrySend(t.env, CO, "crm:msg:a1")).rejects.toThrow(/text is not kept once its send has ended/);
  });

  it("is refused for open tracking alone, and for both, and the words say which", async () => {
    const t = await ready();
    t.provider.setTracking(DOMAIN, { open: true });
    expect((await handleSendRequested(t.env, sendEvent(signing({ key: "k-open" }), CRM_SEND)))!.error).toMatch(/^Not sent: open tracking is switched on/);
    t.provider.setTracking(DOMAIN, { click: true });
    expect((await handleSendRequested(t.env, sendEvent(signing({ key: "k-both" }), CRM_SEND)))!.error).toMatch(/^Not sent: click and open tracking are switched on|^Not sent: click and open tracking is switched on/);
    expect(idle(t)).toBe(true);
  });

  it("an answer that does not say whether tracking is off is not taken as off", async () => {
    const t = await ready();
    t.provider.setTracking(DOMAIN, { open: null, click: null });
    const unknown = await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND));
    expect(unknown).toMatchObject({ status: "failed", permanent: true });
    expect(unknown!.error).toMatch(/did not say whether open and click tracking are off/);
    // One flag known and off, the other not said: still not enough.
    t.provider.setTracking(DOMAIN, { open: false, click: null });
    expect((await handleSendRequested(t.env, sendEvent(signing({ key: "k2" }), CRM_SEND)))!.error).toMatch(/did not say/);
    expect(idle(t)).toBe(true);
  });

  it("is asked again later, with nothing stored and nothing handed over, when the provider cannot be asked", async () => {
    const t = await ready();
    const real = t.provider.getDomain.bind(t.provider);
    t.provider.getDomain = async () => {
      throw new EspApiError("Resend did not answer: timed out", "unknown", null);
    };
    const result = await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND));
    expect(result).toBeNull();
    expect(results(t.host.emitted)).toEqual([]);
    expect(t.store.sends.has("crm:msg:a1")).toBe(false);
    expect(idle(t)).toBe(true);
    // The sender's outbox delivers it again once the provider answers.
    t.provider.getDomain = real;
    expect(await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND))).toMatchObject({ status: "sent" });
  });

  it("a key the provider refuses to read domains with is reported on the Cockpit and the send waits (it is not sent unchecked)", async () => {
    const t = await ready();
    t.provider.getDomain = async () => {
      throw new EspApiError("The Resend API key is restricted to sending.", "config", 401, "restricted_api_key");
    };
    expect(await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND))).toBeNull();
    expect(idle(t)).toBe(true);
    expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "key_refused" });
  });

  it("a domain that is gone from the provider is a permanent failure with the way out", async () => {
    const t = await ready();
    t.store.espDomains.get(`${CO}:${DOMAIN}`)!.provider_domain_id = "dom-gone";
    const result = await handleSendRequested(t.env, sendEvent(signing(), CRM_SEND));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/is not registered at the email provider any more/);
  });

  it("asks nothing for any other kind of mail: a campaign or an invoice through a tracked domain goes as before", async () => {
    const t = await ready();
    t.provider.setTracking(DOMAIN, { click: true });
    const campaign = await handleSendRequested(t.env, sendEvent(signing({ key: "campaigns:step:e1:1", marketing: true, unsubscribeUrl: "https://paperclip.example.com/u?t=abc", context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "e1", clientKind: CLIENT.kind, clientRef: CLIENT.ref } }), `plugin.${PIB_PLUGINS.campaigns}.mail.send.requested`));
    expect(campaign).toMatchObject({ status: "sent", provider: "resend" });
    expect(asked(t)).toBe(0);
  });

  it("trackingProblem is not asked for a message that is not a client message, or has no provider domain", async () => {
    const t = await ready();
    const pick = { account: t.store.accounts.get(`esp-${DOMAIN}`)!, domain: t.store.espDomains.get(`${CO}:${DOMAIN}`)! };
    const loaded = await (await import("../../src/config.js")).loadMailboxConfig(t.host.ctx, CO);
    expect(await trackingProblem(t.env, loaded, pick, { context: { plugin: "p", kind: "invoice", id: "1" } })).toBeNull();
    expect(await trackingProblem(t.env, loaded, { ...pick, domain: null }, signing())).toBeNull();
    expect(asked(t)).toBe(0);
  });
});

describe("where a reply arrives is part of the answer", () => {
  it("a provider send says its Reply-To: the request's wins, else the account's own, so the sender can match a reply that has no thread", async () => {
    const t = await ready();
    const own = await handleSendRequested(t.env, sendEvent(signing({ key: "k-own" }), CRM_SEND));
    expect(own).toMatchObject({ status: "sent", provider: "resend", replyTo: "team@client.co.za" });
    const asked = await handleSendRequested(t.env, sendEvent(signing({ key: "k-asked", replyTo: { email: "sales@client.co.za" } }), CRM_SEND));
    expect(asked).toMatchObject({ status: "sent", replyTo: "sales@client.co.za" });
    expect(results(t.host.emitted).map((r) => r.replyTo)).toEqual(["team@client.co.za", "sales@client.co.za"]);
  });

  it("a Gmail send says its Reply-To only when it has one besides the mailbox itself", async () => {
    const t = espSetup();
    const plain = await handleSendRequested(t.env, sendEvent({ ...signing({ key: "g1" }), from: null }, CRM_SEND));
    expect(plain).toMatchObject({ status: "sent", replyTo: null });
    const redirected = await handleSendRequested(t.env, sendEvent({ ...signing({ key: "g2", replyTo: { email: "team@client.co.za" } }), from: null }, CRM_SEND));
    expect(redirected).toMatchObject({ status: "sent", replyTo: "team@client.co.za" });
    const self = await handleSendRequested(t.env, sendEvent({ ...signing({ key: "g3", replyTo: { email: t.gmail.email } }), from: null }, CRM_SEND));
    expect(self).toMatchObject({ status: "sent", replyTo: null });
  });
});
