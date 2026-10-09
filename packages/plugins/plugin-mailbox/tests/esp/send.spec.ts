import { describe, expect, it, vi } from "vitest";
import { PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { ESP_RETRY_WINDOW_MS } from "../../src/esp/send.js";
import { readEspState } from "../../src/esp/runtime.js";
import { buildEspEmail, formatFrom, idempotencyKeyFor, maybeAcceptedAt, sendTagValue } from "../../src/esp/send.js";
import { handleSendRequested, performSend, retrySend } from "../../src/gmail/send.js";
import { PLUGIN_ID } from "../../src/namespace.js";
import { pickSender } from "../../src/pick-sender.js";
import { loadMailboxConfig } from "../../src/config.js";
import { CO } from "../helpers/memory.js";
import { openGate } from "../helpers/proxy.js";
import { addEspDomain, API_KEY, CLIENT, DOMAIN, espSetup, FROM, healthyCheck, invoice, marketing, results, SES_ON, sendEvent, sesMockSetup, sesSetup, WEBHOOK_SECRET } from "../helpers/esp.js";
import { SES_SECRET_ACCESS_KEY } from "../helpers/fake-ses.js";

const DAY = 86_400_000;
const OWN_DOMAIN = "mail.pib.test";
const OWN_FROM = `hello@${OWN_DOMAIN}`;
const today = () => new Date().toISOString().slice(0, 10);

/** The company's own provider account (no client), for transactional mail. */
const own = (t: Parameters<typeof addEspDomain>[0], options: Parameters<typeof addEspDomain>[1] = {}) => addEspDomain(t, { domain: OWN_DOMAIN, client: null, replyTo: "ops@pib.test", ...options });

describe("sending through the email provider", () => {
  it("sends a client's marketing as the client's own domain: the provider gets the message, the answer is the usual mail.send.result, and Gmail is not touched", async () => {
    const t = espSetup();
    await addEspDomain(t);
    const result = await handleSendRequested(t.env, sendEvent(marketing()));

    expect(result).toMatchObject({ key: "campaigns:step:e1:1", status: "sent", messageId: "resend:mock-0001", threadId: null, permanent: false, provider: "resend", context: marketing().context });
    expect(result!.sentAt).toBeTruthy();
    expect(t.provider.sent).toHaveLength(1);
    expect(t.provider.sent[0]!.email).toMatchObject({
      from: `"Client Co" <${FROM}>`,
      to: ["ann@x.co"],
      subject: "Spring offer",
      html: "<p>Hi Ann</p>",
      text: "Hi Ann",
      replyTo: "team@client.co.za",
      // RFC 8058: the https address and the Post header, and no mailto (nobody reads a send-only inbox).
      headers: { "List-Unsubscribe": "<https://paperclip.example.com/unsub?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "pib_company", value: CO }],
    });
    expect(t.provider.sent[0]!.email.idempotencyKey).toBe(idempotencyKeyFor(CO, "campaigns:step:e1:1"));
    expect(t.provider.sent[0]!.email.idempotencyKey).toMatch(/^pib-[0-9a-f]{48}$/);
    // Gmail is neither asked to send nor to look the message up.
    expect(t.gmail.sent).toHaveLength(0);
    expect(t.gmail.calls).toHaveLength(0);

    const row = t.store.sends.get("campaigns:step:e1:1")!;
    expect(row).toMatchObject({ status: "sent", provider: "resend", provider_message_id: "mock-0001", from_address: FROM, source_plugin: PIB_PLUGINS.campaigns });
    expect(results(t.host.emitted)).toEqual([expect.objectContaining({ key: "campaigns:step:e1:1", status: "sent", messageId: "resend:mock-0001", provider: "resend" })]);
    expect(t.host.inbox.get("campaigns:step:e1:1")).toMatchObject({ status: "sent" });
    // It counted against the domain's day.
    expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(1);
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ first_sent_at: expect.any(String), last_sent_at: expect.any(String) });
  });

  it("answers a repeat delivery with the stored result and sends once", async () => {
    const t = espSetup();
    await addEspDomain(t);
    await handleSendRequested(t.env, sendEvent(marketing()));
    await handleSendRequested(t.env, sendEvent(marketing()));
    expect(t.provider.sent).toHaveLength(1);
    const sent = results(t.host.emitted);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(1);
  });

  it("a stored result for a message the provider took keeps its provider id (a retry by hand answers the same)", async () => {
    const t = espSetup();
    await addEspDomain(t);
    await handleSendRequested(t.env, sendEvent(marketing()));
    const again = await performSend(t.env, CO, marketing(), { sourcePlugin: PIB_PLUGINS.campaigns });
    expect(again).toMatchObject({ status: "sent", messageId: "resend:mock-0001", provider: "resend" });
  });

  describe("which sender takes a request", () => {
    it("Gmail takes everything that names no provider account, exactly as before", async () => {
      const t = espSetup();
      await addEspDomain(t);
      await own(t);
      const result = await handleSendRequested(t.env, sendEvent(invoice(), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(result).toMatchObject({ status: "sent", messageId: "sent-1" });
      expect(result).not.toHaveProperty("provider");
      expect(t.provider.sent).toHaveLength(0);
      expect(t.gmail.sent).toHaveLength(1);
    });

    it("transactional mail goes from the company's own provider account when the owner chose that, and marketing still goes from the sender it names or Gmail", async () => {
      const t = espSetup({ esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, prefer: "transactional" } });
      await addEspDomain(t);
      await own(t);
      const first = await handleSendRequested(t.env, sendEvent(invoice(), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(first).toMatchObject({ status: "sent", provider: "resend" });
      expect(t.provider.sent[0]!.email.from).toBe(`"Partners in Biz" <${OWN_FROM}>`);
      // Marketing for the company's own (no client) is not what the preference is about: it goes from Gmail's default.
      const own1 = await handleSendRequested(t.env, sendEvent(marketing({ from: null, key: "crm:seq:1", context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "s1" }, unsubscribeUrl: null })));
      expect(own1).toMatchObject({ status: "sent", messageId: "sent-1" });
      expect(t.provider.sent).toHaveLength(1);
    });

    it("the preference never holds an invoice back: with the provider not ready, refusing its key, or its DNS failing, Gmail takes it", async () => {
      const prefer = { esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, prefer: "transactional" } };
      const send = (t: ReturnType<typeof espSetup>, key: string) => handleSendRequested(t.env, sendEvent(invoice({ key }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      // the domain is not verified yet
      let t = espSetup(prefer);
      await own(t, { status: "pending" });
      expect(await send(t, "i1")).toMatchObject({ status: "sent", messageId: "sent-1" });
      expect(t.provider.sent).toHaveLength(0);
      // no webhook secret
      t = espSetup({ esp: { enabled: true, apiKey: API_KEY, prefer: "transactional" } });
      await own(t);
      expect(await send(t, "i2")).toMatchObject({ status: "sent", messageId: "sent-1" });
      // the provider refused the key lately
      t = espSetup(prefer);
      await own(t);
      await t.host.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "mailbox-esp", stateKey: "provider-state" }, { ok: false, at: new Date().toISOString(), code: "key_refused", detail: "401" });
      expect(await send(t, "i3")).toMatchObject({ status: "sent", messageId: "sent-1" });
      // its DNS check is failing
      t = espSetup(prefer);
      await own(t);
      await healthyCheck(t, OWN_DOMAIN, "bad", [{ code: "esp_spf_missing", severity: "bad", message: "no SPF at the return path", fix: "add it" }]);
      expect(await send(t, "i4")).toMatchObject({ status: "sent", messageId: "sent-1" });
      expect(t.provider.sent).toHaveLength(0);
    });

    it("a client's marketing that names no sender goes from that client's own provider account", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const result = await handleSendRequested(t.env, sendEvent(marketing({ from: null })));
      expect(result).toMatchObject({ status: "sent", provider: "resend" });
      expect(t.provider.sent[0]!.email.from).toBe(`"Client Co" <${FROM}>`);
      expect(t.gmail.sent).toHaveLength(0);
    });

    it("a client's marketing is NEVER moved to another sender when its account cannot send: it fails and says why", async () => {
      const t = espSetup();
      await addEspDomain(t, { status: "pending" });
      const result = await handleSendRequested(t.env, sendEvent(marketing({ from: null })));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/updates\.client\.co\.za is not verified at the email provider yet/);
      expect(t.gmail.sent).toHaveLength(0);
      expect(t.provider.sent).toHaveLength(0);
    });

    it("an address that is neither a connected Gmail mailbox nor a provider account is not sent from, and never falls back to the default", async () => {
      const t = espSetup();
      const result = await handleSendRequested(t.env, sendEvent(marketing({ from: "who@nowhere.test" })));
      expect(result).toMatchObject({ status: "failed", permanent: true, error: "No connected Gmail account for who@nowhere.test in Mailbox" });
      expect(t.gmail.sent).toHaveLength(0);
    });

    it("pickSender: a client's account is not offered to another client, a disconnected account is not offered at all", async () => {
      const t = espSetup();
      const a = await addEspDomain(t);
      const loaded = await loadMailboxConfig(t.host.ctx, CO);
      const other = await pickSender(t.env, loaded, CO, { from: null, marketing: true, context: { plugin: "p", kind: "k", id: "i", clientKind: "company", clientRef: "crm-someone-else" } });
      expect(other.kind).toBe("gmail");
      await t.store.setAccountStatus(CO, a.accountId, "disconnected");
      expect((await pickSender(t.env, loaded, CO, { from: FROM, marketing: true, context: { plugin: "p", kind: "k", id: "i" } })).kind).toBe("gmail");
    });
  });

  describe("it must be allowed to send at all", () => {
    it("is refused for good while the provider is off, or its API key or webhook secret is missing, and nothing leaves", async () => {
      for (const [config, expected] of [
        [{ esp: { enabled: false, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET } }, /switched off/],
        [{ esp: { enabled: true, webhookSecret: WEBHOOK_SECRET } }, /API key is not saved/],
        [{ esp: { enabled: true, apiKey: API_KEY } }, /nothing is sent through the provider, because bounces and complaints would be missed/],
      ] as const) {
        const t = espSetup(config);
        await addEspDomain(t);
        const result = await handleSendRequested(t.env, sendEvent(marketing()));
        expect(result, JSON.stringify(config)).toMatchObject({ status: "failed", permanent: true });
        expect(result!.error).toMatch(/^Not sent: the email provider is not ready\./);
        expect(result!.error).toMatch(expected);
        expect(t.provider.sent).toHaveLength(0);
        expect(t.gmail.sent).toHaveLength(0);
      }
    });

    it("is refused for good for a domain the provider has not verified, and the answer says which records to add", async () => {
      const t = espSetup();
      await addEspDomain(t, { status: "pending" });
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/not verified at the email provider yet.*list-sending-domains.*check-sender-domain/);
      expect(t.provider.calls).toEqual([]);
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "failed", permanent: true });
    });

    it("is refused when the account is not connected even though the provider verified the domain", async () => {
      const t = espSetup();
      const a = await addEspDomain(t);
      await t.store.setAccountStatus(CO, a.accountId, "pending");
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
    });

    it("a client's account sends only that client's mail", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const other = await handleSendRequested(t.env, sendEvent(marketing({ key: "k-other", context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "x", clientKind: "company", clientRef: "crm-someone-else" } })));
      expect(other).toMatchObject({ status: "failed", permanent: true });
      expect(other!.error).toMatch(/belongs to a client .*only sends that client's mail/);
      const own1 = await handleSendRequested(t.env, sendEvent(marketing({ key: "k-own", context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "y" } })));
      expect(own1).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
    });

    it("a failing DNS check (bad SPF or DKIM at the provider's records) holds back EVERY send from the domain, marketing and transactional", async () => {
      const t = espSetup();
      await own(t);
      await healthyCheck(t, OWN_DOMAIN, "bad", [{ code: "esp_dkim_missing", severity: "bad", message: `No DKIM key was found at resend._domainkey.${OWN_DOMAIN}.`, fix: "add it" }]);
      const inv = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(inv).toMatchObject({ status: "failed", permanent: true });
      expect(inv!.error).toMatch(/^Not sent from mail\.pib\.test: No DKIM key was found.*run check-sender-domain, then retry/);
      const mk = await handleSendRequested(t.env, sendEvent(marketing({ from: OWN_FROM, key: "m1", context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "s" } })));
      expect(mk).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
      // Once the check is healthy again a retry by hand goes out.
      await healthyCheck(t, OWN_DOMAIN);
      expect(await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, key: "billing:invoice:inv-2:send" }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent" });
    });

    it("a problem on the domain's Gmail side does not hold back the provider's mail, a problem with the provider's own records does", async () => {
      const t = espSetup();
      await own(t);
      // The company's own domain also has Gmail on it, and no Google SPF yet: the provider signs with its own records.
      await healthyCheck(t, OWN_DOMAIN, "bad", [{ code: "spf_missing", severity: "bad", message: "no SPF at the apex for Google", fix: "add it" }, { code: "mx_missing", severity: "bad", message: "no MX", fix: "add it" }]);
      expect(await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent", provider: "resend" });
      await healthyCheck(t, OWN_DOMAIN, "bad", [{ code: "spf_missing", severity: "bad", message: "no SPF at the apex for Google", fix: "add it" }, { code: "esp_spf_missing", severity: "bad", message: "send.mail.pib.test has no SPF record", fix: "add it" }]);
      const blocked = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, key: "billing:invoice:inv-2:send" }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(blocked).toMatchObject({ status: "failed", permanent: true });
      expect(blocked!.error).toMatch(/send\.mail\.pib\.test has no SPF record/);
      expect(blocked!.error).not.toMatch(/no SPF at the apex/);
    });

    it("a warning is not a block: DMARC still at the first step does not stop mail, and shows as a warning on marketing", async () => {
      const t = espSetup();
      await addEspDomain(t);
      await healthyCheck(t, DOMAIN, "warn", [{ code: "dmarc_missing", severity: "warn", message: "no DMARC record yet", fix: "add it" }]);
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "sent", warnings: ["no DMARC record yet"] });
    });

    it("a bounce or complaint record over its limit holds back MARKETING only, never an invoice", async () => {
      const t = espSetup();
      await own(t);
      await healthyCheck(t, OWN_DOMAIN, "bad", [{ code: "esp_bounce_rate", severity: "bad", message: `${OWN_DOMAIN}: 30 of 1000 recipients hard bounced`, fix: "clean the list", blocks: "marketing" }]);
      const mk = await handleSendRequested(t.env, sendEvent(marketing({ from: OWN_FROM, key: "m1", context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "s" } })));
      expect(mk).toMatchObject({ status: "failed", permanent: true });
      expect(mk!.error).toMatch(/hard bounced/);
      const inv = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(inv).toMatchObject({ status: "sent", provider: "resend" });
      expect(t.provider.sent).toHaveLength(1);
    });

    it("a draft sent from a provider account stays under the same rules and records the draft as sent", async () => {
      const t = espSetup();
      await own(t);
      const id = "draft-1";
      t.store.messages.set(id, { id, company_id: CO, account_id: `esp-${OWN_DOMAIN}`, subject: "Re: hello", body: "Hi", direction: "outbound", status: "queued", to_addrs: [{ email: "ann@x.co" }], cc_addrs: [], bcc_addrs: [], draft: { html: null }, created_at: new Date().toISOString() } as never);
      const request = invoice({ key: `draft:${id}`, from: OWN_FROM, subject: "Re: hello", text: "Hi", context: { plugin: PLUGIN_ID, kind: "draft", id } });
      const result = await performSend(t.env, CO, request, { sourcePlugin: PLUGIN_ID, force: true, draftRowId: id });
      expect(result).toMatchObject({ status: "sent", provider: "resend" });
      expect(t.store.messages.get(id)).toMatchObject({ status: "sent", send_key: `draft:${id}`, sent_context: { kind: "draft" } });
    });
  });

  describe("the do-not-email list", () => {
    it("leaves a suppressed address out, and fails for good with the list when nobody is left", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.store.addSuppression(CO, "ann@x.co", "marketing", "unsubscribed", "partnersinbiz.crm", `company:${CLIENT.ref}`);
      const none = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(none).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@x.co", scope: "marketing", reason: "unsubscribed" }] });
      const some = await handleSendRequested(t.env, sendEvent(marketing({ key: "k2", to: [{ email: "ann@x.co" }, { email: "bea@x.co" }] })));
      expect(some).toMatchObject({ status: "sent", suppressed: [{ email: "ann@x.co" }] });
      expect(t.provider.sent[0]!.email.to).toEqual(["bea@x.co"]);
    });

    it("an unsubscribe is per sender: the client's list stops the client's marketing, the company's own list does not", async () => {
      let t = espSetup();
      await addEspDomain(t);
      t.store.addSuppression(CO, "ann@x.co", "marketing", "unsubscribed", "x", "own");
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "sent" });
      t = espSetup();
      await addEspDomain(t);
      // A row from before senders existed blocks every sender.
      t.store.addSuppression(CO, "ann@x.co", "marketing", "unsubscribed", "x", "");
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "failed" });
    });

    it("a hard bounce stops every send to the address, transactional included, from every sender", async () => {
      const t = espSetup();
      await own(t);
      t.store.addSuppression(CO, "ann@x.co", "all", "bounced", "partnersinbiz.mailbox", "");
      const inv = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(inv).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@x.co", scope: "all", reason: "bounced" }] });
      expect(t.provider.sent).toHaveLength(0);
    });
  });

  describe("marketing needs a working unsubscribe link", () => {
    it("fails for good with the way out when the request has none and the Mailbox cannot make its own", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const result = await handleSendRequested(t.env, sendEvent(marketing({ unsubscribeUrl: null })));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/needs an https one-click unsubscribe link.*nobody reads the inbox of a send-only address.*reverse-proxy rule proved/);
      expect(t.provider.sent).toHaveLength(0);
    });

    it("uses the Mailbox's own one-click link for one recipient once the proxy rule is proved, and never a mailto", async () => {
      const t = espSetup({ unsubscribe: { secret: "unsubscribe-secret-0123456789" } });
      await addEspDomain(t);
      await openGate(t.env);
      const result = await handleSendRequested(t.env, sendEvent(marketing({ unsubscribeUrl: null })));
      expect(result).toMatchObject({ status: "sent" });
      const header = t.provider.sent[0]!.email.headers!["List-Unsubscribe"]!;
      expect(header).toMatch(/^<https:\/\/paperclip\.example\.com\/api\/plugins\/partnersinbiz\.mailbox\/webhooks\/unsubscribe\?token=[^>]+>$/);
      expect(header).not.toContain("mailto");
    });

    it("transactional mail carries no unsubscribe header", async () => {
      const t = espSetup();
      await own(t);
      await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(t.provider.sent[0]!.email.headers).toBeUndefined();
    });
  });

  describe("the daily cap while a domain warms up", () => {
    const recipients = (n: number, from = 0) => Array.from({ length: n }, (_v, i) => ({ email: `p${from + i}@x.co` }));

    it("a new domain may send 50 recipients of marketing on day one, and the next is deferred: nothing is stored and the sender retries", async () => {
      const t = espSetup();
      await addEspDomain(t);
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k50", to: recipients(50) })))).toMatchObject({ status: "sent" });
      const deferred = await handleSendRequested(t.env, sendEvent(marketing({ key: "k51", to: [{ email: "one-more@x.co" }] })));
      // Deferred: no answer is given (the sender's outbox asks again), nothing is recorded as failed, and nothing was sent.
      expect(deferred).toBeNull();
      expect(t.store.sends.has("k51")).toBe(false);
      expect(t.provider.sent).toHaveLength(1);
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(50);
      expect(t.host.ctx.logger.info).toHaveBeenCalledWith("Mail send deferred", expect.objectContaining({ key: "k51", error: expect.stringMatching(/may send 50 recipients a day \(warm-up day 1\) and today's are used up/) }));
    });

    it("the next UTC day has a bigger cap, so the deferred message goes then", async () => {
      const t = espSetup();
      await addEspDomain(t);
      await handleSendRequested(t.env, sendEvent(marketing({ key: "k50", to: recipients(50) })));
      const tomorrow = Date.now() + DAY;
      t.env.now = () => tomorrow;
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k51", to: recipients(100, 100) })))).toMatchObject({ status: "sent" });
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${new Date(tomorrow).toISOString().slice(0, 10)}`)!.sent).toBe(100);
    });

    it("transactional mail is counted and never held back, even over the cap, and it eats into marketing's room", async () => {
      const t = espSetup();
      await own(t);
      expect(await handleSendRequested(t.env, sendEvent(invoice({ key: "i-big", from: OWN_FROM, to: recipients(60) }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent" });
      expect(t.store.espDays.get(`${CO}:${OWN_DOMAIN}:${today()}`)!.sent).toBe(60);
      expect(await handleSendRequested(t.env, sendEvent(marketing({ from: OWN_FROM, key: "m1", to: recipients(1, 500), context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "s" } })))).toBeNull();
    });

    it("a domain a person marked as established has the steady cap, and one with its own cap has that", async () => {
      const t = espSetup();
      await addEspDomain(t);
      await t.store.patchEspDomain(CO, DOMAIN, { warmup_exempt: true });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "big", to: recipients(50) })))).toMatchObject({ status: "sent" });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "bigger", to: recipients(50, 50) })))).toMatchObject({ status: "sent" });
      await t.store.patchEspDomain(CO, DOMAIN, { daily_cap_override: 101 });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "over", to: recipients(2, 200) })))).toBeNull();
    });

    it("a marketing message with more recipients than the domain is EVER handed in a day fails for good with a clear reason, instead of waiting for days; fewer than that only wait for a bigger day", async () => {
      const t = espSetup({ esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, steadyDailyCap: 200 } });
      await addEspDomain(t);
      // 150 is over today's 50 but under the steady 200: it waits for the warm-up to get there.
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "waits", to: recipients(150) })))).toBeNull();
      // 201 can never go: a permanent failure, nothing reserved, nothing sent, nothing deferred.
      const never = await handleSendRequested(t.env, sendEvent(marketing({ key: "never", to: recipients(201) })));
      expect(never).toMatchObject({ status: "failed", permanent: true });
      expect(never!.error).toMatch(/201 recipients and updates\.client\.co\.za is never handed more than 200 recipients in a day.*one recipient per message/);
      expect(t.store.sends.get("never")).toMatchObject({ status: "failed", permanent: true });
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)?.sent ?? 0).toBe(0);
      expect(t.provider.sent).toHaveLength(0);
      // A person's own cap is the ceiling for that domain; and transactional mail is never judged by it.
      await t.store.patchEspDomain(CO, DOMAIN, { daily_cap_override: 100 });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "over-own", to: recipients(101) })))).toMatchObject({ status: "failed", permanent: true });
      await own(t);
      await t.store.patchEspDomain(CO, OWN_DOMAIN, { daily_cap_override: 100 });
      expect(await handleSendRequested(t.env, sendEvent(invoice({ key: "i-wide", from: OWN_FROM, to: recipients(150) }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent" });
    });

    it("gives the reservation back when the message does not go out (a refused message, a deferral), so a failure does not use up the cap", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "rejected", status: 422, error: "bad field" });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "bad", to: recipients(10) })))).toMatchObject({ status: "failed" });
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(0);
      t.provider.failNext({ kind: "retry", status: 429, error: "slow down" });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "slow", to: recipients(10) })))).toBeNull();
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(0);
    });

    it("does not give it back for a message the provider DID take, even if recording it fails afterwards", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const original = t.store.markSendSentProvider.bind(t.store);
      t.store.markSendSentProvider = async () => {
        throw new Error("the database dropped");
      };
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "kept", to: recipients(5) })))).toBeNull();
      t.store.markSendSentProvider = original;
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(5);
      expect(t.provider.sent).toHaveLength(1);
    });
  });

  describe("soft bounces back off", () => {
    it("a marketing message to an address that soft bounced lately waits (deferred), and goes to the others", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const until = new Date(Date.now() + 6 * 3_600_000).toISOString();
      await t.store.recordSoftBounce(CO, "ann@x.co", new Date().toISOString(), 14);
      await t.store.setBackoff(CO, "ann@x.co", until);
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
      expect(t.store.sends.has("campaigns:step:e1:1")).toBe(false);
      const both = await handleSendRequested(t.env, sendEvent(marketing({ key: "two", to: [{ email: "ann@x.co" }, { email: "bea@x.co" }] })));
      expect(both).toMatchObject({ status: "sent" });
      expect(t.provider.sent[0]!.email.to).toEqual(["bea@x.co"]);
      expect(both!.warnings!.join(" ")).toMatch(/Left out for now after a soft bounce.*ann@x\.co/);
    });

    it("goes again when the wait is over, and an invoice is never held back by it", async () => {
      const t = espSetup();
      await addEspDomain(t);
      await own(t);
      await t.store.recordSoftBounce(CO, "ann@x.co", new Date().toISOString(), 14);
      await t.store.setBackoff(CO, "ann@x.co", new Date(Date.now() + 3_600_000).toISOString());
      expect(await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent" });
      t.env.now = () => Date.now() + 2 * 3_600_000;
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "sent" });
    });
  });

  describe("what the provider answers", () => {
    it("a refused message is a permanent failure with the provider's words, recorded", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "rejected", status: 422, code: "validation_error", error: "The `to` field is invalid." });
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "failed", permanent: true, error: "The email provider refused the message: The `to` field is invalid." });
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "failed", permanent: true });
    });

    it("a domain the provider says is not verified puts it back to pending (with its account) and fails for good", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "unverified", status: 403, code: "validation_error", error: "The updates.client.co.za domain is not verified." });
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/says updates\.client\.co\.za is not verified/);
      expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)!.status).toBe("pending");
      expect(t.store.accounts.get(`esp-${DOMAIN}`)!.status).toBe("pending");
      // The next send is refused up front, without calling the provider again.
      const calls = t.provider.calls.length;
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "next" })))).toMatchObject({ status: "failed" });
      expect(t.provider.calls).toHaveLength(calls);
    });

    it("a refused API key defers the send (nothing stored as failed), says so on the provider's state, and the send goes once the key works", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "config", status: 401, code: "restricted_api_key", error: "This API key is restricted to only send emails." });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "retrying" });
      expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "key_refused" });
      expect(t.host.ctx.logger.info).toHaveBeenCalledWith("Mail send deferred", expect.objectContaining({ error: expect.stringMatching(/refused the Mailbox's API key/) }));
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "sent" });
      expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: true, code: null });
    });

    it("a used-up quota defers it too, and shows as quota", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "quota", status: 429, code: "daily_quota_exceeded", error: "You have exceeded your daily email sending quota." });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
      expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "quota" });
    });

    it("a rate limit defers it shortly, as retrying", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "retry", status: 429, code: "rate_limit_exceeded", error: "Too many requests." });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "retrying", error: "Too many requests." });
    });

    it("a call with no answer is retried with the SAME key, so a message the provider kept is not delivered twice", async () => {
      const t = espSetup();
      await addEspDomain(t);
      // The provider took the message, but the answer never came back.
      t.provider.failNext({ kind: "unknown", error: "socket hang up" }, 1, { accepted: true });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
      expect(t.provider.sent).toHaveLength(1);
      const stale = t.store.sends.get("campaigns:step:e1:1")!;
      expect(stale).toMatchObject({ status: "retrying", attempts: 1 });
      const retry = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(retry).toMatchObject({ status: "sent", messageId: "resend:mock-0001" });
      // Still ONE message at the provider: its idempotency key answered the retry with the first result.
      expect(t.provider.sent).toHaveLength(1);
    });

    it("up to 19 hours after a call with no answer a retry is safe (same key), but after 21 the provider has forgotten the key at 24, so it fails for good and says to look in its log", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const HOUR = 3_600_000;
      const ahead = (hours: number) => void (t.env.now = () => Date.now() + hours * HOUR);
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 2);
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k19" })))).toBeNull();
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k21" })))).toBeNull();
      // The call with no answer is written down on the send: that is what the window is counted from.
      for (const key of ["k19", "k21"]) expect(Date.parse(String(t.store.sends.get(key)!.delivery?.maybeAcceptedAt))).toBeGreaterThan(Date.now() - 60_000);
      // 19 hours after: still inside the provider's memory of the key, so it is retried.
      ahead(19);
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k19" })))).toMatchObject({ status: "sent" });
      // 21 hours after: not retried blind.
      ahead(21);
      const late = await handleSendRequested(t.env, sendEvent(marketing({ key: "k21" })));
      expect(late).toMatchObject({ status: "failed", permanent: true });
      expect(late!.error).toMatch(/did not answer an earlier attempt.*20 hours.*Look for it in the provider's log.*could deliver it twice/);
      expect(t.provider.sent).toHaveLength(1);
      expect(ESP_RETRY_WINDOW_MS).toBe(20 * HOUR);
      // A person who has looked in the provider's log can still send it by hand: the same key (the provider may still remember it), no stale mark.
      ahead(21.5);
      expect(t.store.sends.get("k21")!.delivery?.maybeAcceptedAt).toBeNull();
      expect(await retrySend(t.env, CO, "k21")).toMatchObject({ status: "sent" });
      expect(t.provider.received.at(-1)!.idempotencyKey).toBe(idempotencyKeyFor(CO, "k21"));
    });

    it("a retry by hand after the provider refused the message gets a NEW key (it may have kept the first with its answer), while a retry of a call with no answer keeps its key", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "rejected", status: 422, error: "bad field" });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "failed", permanent: true });
      const first = t.provider.received[0]!.idempotencyKey;
      expect(first).toBe(idempotencyKeyFor(CO, "campaigns:step:e1:1"));
      // The person fixes the cause and retries from the Sent tab.
      const retried = await retrySend(t.env, CO, "campaigns:step:e1:1");
      expect(retried).toMatchObject({ status: "sent" });
      const second = t.provider.received[1]!.idempotencyKey;
      expect(second).not.toBe(first);
      expect(second).toBe(idempotencyKeyFor(CO, "campaigns:step:e1:1", 1));
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "sent", delivery: { gen: 1 } });
      // No answer at all: the same key again, so the provider can answer with the first result.
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 1, { accepted: true });
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k-noanswer" })))).toBeNull();
      expect(await handleSendRequested(t.env, sendEvent(marketing({ key: "k-noanswer" })))).toMatchObject({ status: "sent" });
      const keys = t.provider.received.filter((_m, i) => i >= 2).map((m) => m.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(t.provider.sent).toHaveLength(2);
    });

    it("the key never repeats across companies, requests or generations, and stays within the provider's limit", () => {
      const keys = new Set([idempotencyKeyFor("a", "k"), idempotencyKeyFor("b", "k"), idempotencyKeyFor("a", "k2"), idempotencyKeyFor("a", "k", 1), idempotencyKeyFor("a", "k", 2)]);
      expect(keys.size).toBe(5);
      for (const key of keys) expect(key).toMatch(/^pib-[0-9a-f]{48}$/);
    });

    it("a key the provider saw with a different message is a permanent failure that says to look in its log", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "conflict", status: 409, code: "invalid_idempotent_request", error: "Idempotency key has been used" });
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/earlier attempt of this message under the same key that differed/);
    });
  });

  describe("a send the provider did not take can wait; a send it may have taken cannot be retried blind for long", () => {
    const HOUR = 3_600_000;
    const KEY = "campaigns:step:e1:1";
    const later = (t: ReturnType<typeof espSetup>, hours: number) => void (t.env.now = () => Date.now() + hours * HOUR);
    const attempt = (t: ReturnType<typeof espSetup>, key = KEY) => handleSendRequested(t.env, sendEvent(marketing({ key })));
    const marked = (t: ReturnType<typeof espSetup>, key = KEY) => t.store.sends.get(key)!.delivery?.maybeAcceptedAt;

    for (const [name, failure] of [
      ["the API key was refused", { kind: "config", status: 401, code: "restricted_api_key", error: "This API key is restricted to only send emails." }],
      ["the daily quota was used up", { kind: "quota", status: 429, code: "daily_quota_exceeded", error: "You have exceeded your daily email sending quota." }],
      ["a rate limit answered", { kind: "retry", status: 429, code: "rate_limit_exceeded", error: "Too many requests." }],
    ] as const) {
      it(`${name}: nothing was taken, so 21 hours later (and 70) with the cause gone it is SENT, once, and not failed as "unknown"`, async () => {
        const t = espSetup();
        await addEspDomain(t);
        t.provider.failNext(failure);
        expect(await attempt(t)).toBeNull();
        expect(t.store.sends.get(KEY)).toMatchObject({ status: "retrying", attempts: 1 });
        // Nothing about it is unknown: no mark that it may have been delivered.
        expect(marked(t)).toBeUndefined();
        later(t, 21);
        const result = await attempt(t);
        expect(result).toMatchObject({ status: "sent", permanent: false, provider: "resend" });
        expect(t.provider.sent).toHaveLength(1);
        expect(t.store.sends.get(KEY)).toMatchObject({ status: "sent", error: null });
      });
    }

    it("the key could not be read: waits however long it takes, then sends; and the host is asked once (not once per attempt) while the secret is missing", async () => {
      const t = espSetup({ esp: { enabled: true, apiKey: { type: "secret_ref", secretId: "sec-key" }, webhookSecret: WEBHOOK_SECRET } });
      await addEspDomain(t);
      const secrets = t.host.ctx.secrets as unknown as { resolve: (...args: unknown[]) => Promise<string | undefined> };
      const resolve = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
      secrets.resolve = resolve;
      for (const key of ["a", "b", "c", "d", "e"]) expect(await attempt(t, key)).toBeNull();
      expect(t.store.sends.get("a")).toMatchObject({ status: "retrying", error: expect.stringMatching(/Resend API key secret could not be read/) });
      expect(marked(t, "a")).toBeUndefined();
      expect(resolve).toHaveBeenCalledTimes(1);
      // The missing secret is remembered for half a minute, then asked again.
      t.env.now = () => Date.now() + 31_000;
      expect(await attempt(t, "f")).toBeNull();
      expect(resolve).toHaveBeenCalledTimes(2);
      // The owner fixed it; 21 hours later the send goes.
      resolve.mockImplementation(async () => API_KEY);
      later(t, 21);
      expect(await attempt(t, "a")).toMatchObject({ status: "sent" });
      expect(t.provider.sent).toHaveLength(1);
    });

    it("a refusal after a call with no answer does not move the mark: the window still runs from the unanswered attempt", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "unknown", error: "no answer" });
      expect(await attempt(t)).toBeNull();
      const first = marked(t);
      expect(Date.parse(String(first))).toBeGreaterThan(0);
      // An hour later the key is refused (says nothing about the first call), and the mark stays.
      later(t, 1);
      t.provider.failNext({ kind: "config", status: 401, error: "refused" });
      expect(await attempt(t)).toBeNull();
      expect(marked(t)).toBe(first);
      // 21 hours after the unanswered call the key works again: it is still not retried blind.
      later(t, 21);
      const result = await attempt(t);
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/did not answer an earlier attempt/);
      expect(t.provider.sent).toHaveLength(0);
    });

    it("a second call with no answer does not move the mark either: the provider has remembered the key since the first one", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 2);
      expect(await attempt(t)).toBeNull();
      const first = marked(t);
      later(t, 10);
      expect(await attempt(t)).toBeNull();
      expect(marked(t)).toBe(first);
      // 21 hours after the FIRST call (11 after the second): past the key's safe life.
      later(t, 21);
      expect(await attempt(t)).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
    });

    it("a refusal BEFORE a call with no answer does not start the clock: it runs from the unanswered attempt, not from the first try", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "config", status: 401, error: "refused" });
      expect(await attempt(t)).toBeNull();
      // 20.5 hours later: a call whose answer is lost (the provider kept the message).
      later(t, 20.5);
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 1, { accepted: true });
      expect(await attempt(t)).toBeNull();
      expect(t.provider.sent).toHaveLength(1);
      // 1.5 hours after THAT the key (remembered for 24 hours from its first use) answers with the first result: one message, not two.
      later(t, 22);
      expect(await attempt(t)).toMatchObject({ status: "sent", messageId: "resend:mock-0001" });
      expect(t.provider.sent).toHaveLength(1);
    });

    it("a definitive answer ends the unknown: the mark is cleared and the key changes, and the delivery status is left to the provider's events", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "unknown", error: "no answer" });
      expect(await attempt(t)).toBeNull();
      expect(marked(t)).toEqual(expect.any(String));
      later(t, 1);
      t.provider.failNext({ kind: "rejected", status: 422, error: "bad field" });
      expect(await attempt(t)).toMatchObject({ status: "failed", permanent: true });
      expect(t.store.sends.get(KEY)).toMatchObject({ delivery_status: null, delivery: { gen: 1, maybeAcceptedAt: null } });
      // The retry by hand uses the new key, and nothing is "failed" in the way of a later "delivered".
      expect(await retrySend(t.env, CO, KEY)).toMatchObject({ status: "sent" });
      expect(t.provider.received.at(-1)!.idempotencyKey).toBe(idempotencyKeyFor(CO, KEY, 1));
      expect(t.store.sends.get(KEY)!.delivery_status).toBeNull();
    });

    it("a send that failed for another reason after a call with no answer is not blindly resent by hand after the window either: the person is told once to look, and then may", async () => {
      const t = espSetup();
      await addEspDomain(t);
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 1, { accepted: true });
      expect(await attempt(t)).toBeNull();
      // The domain stops being verified; the send fails for that reason, and the mark of the unanswered call stays.
      later(t, 1);
      await t.store.patchEspDomain(CO, DOMAIN, { status: "pending" });
      expect(await attempt(t)).toMatchObject({ status: "failed", permanent: true, error: expect.stringMatching(/not verified at the email provider yet/) });
      expect(marked(t)).toEqual(expect.any(String));
      await t.store.patchEspDomain(CO, DOMAIN, { status: "verified" });
      // 21 hours after the unanswered call a person retries from the Sent tab: told to look in the provider's log, nothing is sent.
      later(t, 21);
      const calls = t.provider.calls.length;
      const told = await retrySend(t.env, CO, KEY);
      expect(told).toMatchObject({ status: "failed", permanent: true });
      expect(told!.error).toMatch(/did not answer an earlier attempt.*Look for it in the provider's log/);
      expect(t.provider.calls).toHaveLength(calls);
      expect(marked(t)).toBeNull();
      // Their next retry is their decision: it goes (the provider still has the first message under the same key).
      expect(await retrySend(t.env, CO, KEY)).toMatchObject({ status: "sent", messageId: "resend:mock-0001" });
      expect(t.provider.sent).toHaveLength(1);
    });

    it("a claim that never settled (the worker died around the call) counts as unanswered: written down, and not retried blind after the window", async () => {
      const t = espSetup();
      await addEspDomain(t);
      const stuck = async (key: string, minutesAgo: number) => {
        const request = marketing({ key });
        await t.store.claimSend({ key, companyId: CO, sourcePlugin: PIB_PLUGINS.campaigns, accountId: `esp-${DOMAIN}`, fromAddress: FROM, to: request.to, subject: request.subject, context: request.context, request }, false);
        const row = t.store.sends.get(key)!;
        row.claimed_at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
        return row;
      };
      // Stuck 21 hours ago: past the window, so it is not sent blind.
      await stuck("old", 21 * 60);
      expect(await attempt(t, "old")).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
      // Stuck 30 minutes ago and then deferred by a rate limit: the mark is written, so a later try cannot forget it.
      const row = await stuck("recent", 30);
      const claimedAt = row.claimed_at!;
      t.provider.failNext({ kind: "retry", status: 429, error: "slow down" });
      expect(await attempt(t, "recent")).toBeNull();
      expect(marked(t, "recent")).toBe(claimedAt);
      later(t, 21);
      expect(await attempt(t, "recent")).toMatchObject({ status: "failed", permanent: true });
      expect(t.provider.sent).toHaveLength(0);
    });

    it("maybeAcceptedAt: the earliest of the mark and an unsettled claim, and nothing for a send that only waited", () => {
      const base = { status: "retrying" as const, claimed_at: "2026-10-01T10:00:00.000Z", delivery: {} };
      expect(maybeAcceptedAt(null)).toBeNull();
      expect(maybeAcceptedAt(base)).toBeNull();
      expect(maybeAcceptedAt({ ...base, delivery: { maybeAcceptedAt: "2026-10-01T09:00:00.000Z" } })).toBe(Date.parse("2026-10-01T09:00:00.000Z"));
      expect(maybeAcceptedAt({ ...base, status: "sending" })).toBe(Date.parse("2026-10-01T10:00:00.000Z"));
      expect(maybeAcceptedAt({ ...base, status: "sending", delivery: { maybeAcceptedAt: "2026-10-01T09:00:00.000Z" } })).toBe(Date.parse("2026-10-01T09:00:00.000Z"));
      expect(maybeAcceptedAt({ ...base, delivery: { maybeAcceptedAt: null } })).toBeNull();
      expect(maybeAcceptedAt({ ...base, delivery: { maybeAcceptedAt: "not a time" } })).toBeNull();
    });
  });

  describe("attachments and the message itself", () => {
    const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10]);

    it("downloads an attachment and hands it over as base64 with its type", async () => {
      const t = espSetup();
      await own(t);
      t.gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
      const result = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, attachments: [{ url: "https://files.example.com/inv-1.pdf", filename: "INV-1.pdf", mime: "application/pdf", bytes: PDF.byteLength }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(result).toMatchObject({ status: "sent" });
      expect(t.provider.sent[0]!.email.attachments).toEqual([{ filename: "INV-1.pdf", contentType: "application/pdf", contentBase64: Buffer.from(PDF).toString("base64") }]);
    });

    it("an expired attachment link is a permanent failure and gives the cap back; a flaky download is retried", async () => {
      const t = espSetup();
      await own(t);
      t.gmail.files.set("/gone.pdf", { status: 404, body: new Uint8Array(), type: "text/plain" });
      const gone = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, key: "gone", attachments: [{ url: "https://files.example.com/gone.pdf", filename: "g.pdf", mime: "application/pdf" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(gone).toMatchObject({ status: "failed", permanent: true });
      expect(gone!.error).toMatch(/could not be downloaded \(HTTP 404\); the link may have expired/);
      expect(t.store.espDays.get(`${CO}:${OWN_DOMAIN}:${today()}`)!.sent).toBe(0);
      t.gmail.files.set("/flaky.pdf", { status: 503, body: new Uint8Array(), type: "text/plain" });
      expect(await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, key: "flaky", attachments: [{ url: "https://files.example.com/flaky.pdf", filename: "f.pdf", mime: "application/pdf" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toBeNull();
      expect(t.store.sends.get("flaky")).toMatchObject({ status: "retrying" });
    });

    it("an attachment over 15 MB is refused for good, with the way out, and gives the cap back", async () => {
      const t = espSetup();
      await own(t);
      t.gmail.files.set("/big.pdf", { status: 200, body: new Uint8Array(15 * 1024 * 1024 + 1), type: "application/pdf" });
      const result = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, key: "big", attachments: [{ url: "https://files.example.com/big.pdf", filename: "big.pdf", mime: "application/pdf" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/larger than the email provider path carries \(15 MB\).*download link/);
      expect(t.provider.sent).toHaveLength(0);
      expect(t.store.espDays.get(`${CO}:${OWN_DOMAIN}:${today()}`)!.sent).toBe(0);
    });

    it("replies go to the request's reply-to when it has one, else the account's, and the answer warns when there is none", async () => {
      const t = espSetup();
      await addEspDomain(t, { replyTo: null });
      const none = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(none!.warnings!.join(" ")).toMatch(/No Reply-To: replies go to hello@updates\.client\.co\.za, which nobody reads/);
      expect(t.provider.sent[0]!.email.replyTo).toBeNull();
      const named = await handleSendRequested(t.env, sendEvent(marketing({ key: "k2", replyTo: { email: "boss@client.co.za" } })));
      expect(t.provider.sent[1]!.email.replyTo).toBe("boss@client.co.za");
      expect(named).not.toHaveProperty("warnings");
      await t.store.setAccountReplyTo(CO, `esp-${DOMAIN}`, "team@client.co.za");
      await handleSendRequested(t.env, sendEvent(marketing({ key: "k3" })));
      expect(t.provider.sent[2]!.email.replyTo).toBe("team@client.co.za");
    });

    it("a From name cannot break the header, and the key the provider sees is not the request key", () => {
      expect(formatFrom('Acme "Quote" \\ Co', "a@b.co")).toBe('"Acme \\"Quote\\" \\\\ Co" <a@b.co>');
      expect(formatFrom("", "a@b.co")).toBe("a@b.co");
      expect(formatFrom("Evil <x@y>\r\nBcc: z@y", "a@b.co")).not.toMatch(/[\r\n<]x@y/);
      const key = idempotencyKeyFor(CO, "billing:invoice:" + "x".repeat(400));
      expect(key.length).toBeLessThanOrEqual(256);
      expect(idempotencyKeyFor(CO, "k")).not.toBe(idempotencyKeyFor("co-2", "k"));
      const { email } = buildEspEmail({ companyId: CO, account: { address: FROM, from_name: null, reply_to: null }, fromName: "Fallback", request: invoice(), unsubscribeUrl: null, attachments: [] });
      expect(email.from).toBe(`"Fallback" <${FROM}>`);
    });
  });

  describe("batching (off unless the owner switches it on)", () => {
    const batchOn = { esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, batch: true } };

    it("messages that arrive together go in one request, each with its own answer, result and day count", async () => {
      const t = espSetup(batchOn);
      await addEspDomain(t);
      const sends = ["a", "b", "c"].map((k) => handleSendRequested(t.env, sendEvent(marketing({ key: `batch:${k}`, to: [{ email: `${k}@x.co` }] }))));
      const done = await Promise.all(sends);
      expect(done.every((r) => r?.status === "sent")).toBe(true);
      expect(t.provider.calls).toEqual(["sendBatch"]);
      expect(new Set(done.map((r) => r!.messageId)).size).toBe(3);
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(3);
    });

    it("a batch the provider never answered is NOT sent again message by message: each fails for good and says to look in the log", async () => {
      const t = espSetup(batchOn);
      await addEspDomain(t);
      t.provider.failNext({ kind: "unknown", error: "no answer" }, 2, { accepted: true });
      const done = await Promise.all(["a", "b"].map((k) => handleSendRequested(t.env, sendEvent(marketing({ key: `batch:${k}`, to: [{ email: `${k}@x.co` }] })))));
      expect(done.every((r) => r?.status === "failed" && r.permanent === true)).toBe(true);
      expect(done[0]!.error).toMatch(/did not answer the batch.*Look in the provider's log/);
      expect(t.provider.calls).toEqual(["sendBatch", "sendBatch"]);
      // The provider kept them (the answer was lost): still exactly two messages, no duplicates.
      expect(t.provider.sent).toHaveLength(2);
    });

    it("a message with an attachment is never batched", async () => {
      const t = espSetup(batchOn);
      await own(t);
      t.gmail.files.set("/a.txt", { status: 200, body: new Uint8Array([65]), type: "text/plain" });
      await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM, attachments: [{ url: "https://files.example.com/a.txt", filename: "a.txt", mime: "text/plain" }] }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
      expect(t.provider.calls).toEqual(["send"]);
    });
  });
});

describe("sending through Amazon SES (a provider with no idempotency key)", () => {
  const SES_SANDBOX = "SES is in the sandbox: 200 a day, 1 a second, verified recipients only; ask AWS for production access";

  it("sends a marketing message as Raw MIME with the unsubscribe headers and both tags, and answers provider ses with an ses: message id", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses" });
    t.store.addSuppression(CO, "ann@x.co", "marketing", "unsubscribed", "partnersinbiz.crm", `company:${CLIENT.ref}`);
    const result = await handleSendRequested(t.env, sendEvent(marketing({ to: [{ email: "ann@x.co" }, { email: "bea@x.co" }] })));
    expect(result).toMatchObject({ status: "sent", provider: "ses", messageId: expect.stringMatching(/^ses:.+ses-test-id$/), permanent: false, suppressed: [{ email: "ann@x.co" }] });
    expect(t.ses.sends).toHaveLength(1);
    const request = t.ses.sends[0]!;
    expect(request.body!.Destination.ToAddresses).toEqual(["bea@x.co"]);
    expect(request.body!.ConfigurationSetName).toBe("pib-marketing");
    expect(request.body!.EmailTags).toEqual([{ Name: "pib_company", Value: CO }, { Name: "pib_send", Value: "campaigns_step_e1_1" }]);
    expect(request.mime).toContain("List-Unsubscribe: <https://paperclip.example.com/unsub?t=abc>");
    expect(request.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(request.mime).not.toContain("ann@x.co");
    expect(t.ses.signatureProblems).toEqual([]);
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "sent", provider: "ses" });
    expect(t.gmail.sent).toHaveLength(0);
  });

  it("puts no unsubscribe headers on a message that is not marketing", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses", domain: OWN_DOMAIN, client: null });
    const result = await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`));
    expect(result).toMatchObject({ status: "sent", provider: "ses" });
    expect(t.ses.sends[0]!.mime).not.toMatch(/List-Unsubscribe/i);
  });

  it("an unknown outcome is a PERMANENT failure that names SES and tells the person to look in the console; nothing is retried", async () => {
    for (const scripted of [{ status: 500, message: "internal" }, { status: 0, throws: "socket hang up" }, { status: 200, body: {} }]) {
      const t = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      t.ses.errors.push(scripted);
      const result = await handleSendRequested(t.env, sendEvent(marketing()));
      expect(result).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error).toMatch(/SES did not confirm this message/);
      expect(result!.error).toMatch(/SES console.*before sending it again.*twice/);
      // One call, no second attempt, and the send is settled (a later delivery of the same request is answered, not re-sent).
      expect(t.ses.sends).toHaveLength(1);
      expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "failed", permanent: true });
      expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "failed", permanent: true });
      expect(t.ses.sends).toHaveLength(1);
      // The message may have gone out, so it stays counted against the day.
      expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)!.sent).toBe(1);
      expect(JSON.stringify(result)).not.toContain(SES_SECRET_ACCESS_KEY);
    }
  });

  it("the mock with idempotentSends = true keeps the existing rule: the same key is retried and nothing fails for good", async () => {
    const t = espSetup();
    await addEspDomain(t);
    t.provider.failNext({ kind: "unknown", error: "no answer" });
    expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "retrying" });
    expect(t.provider.idempotentSends).toBe(true);
  });

  it("the same unknown outcome from a non-idempotent mock fails for good without a retry mark", async () => {
    const t = sesMockSetup();
    await addEspDomain(t, { provider: "ses" });
    t.provider.failNext({ kind: "unknown", error: "no answer" }, 1, { accepted: true });
    const result = await handleSendRequested(t.env, sendEvent(marketing()));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(t.store.sends.get("campaigns:step:e1:1")!.delivery?.maybeAcceptedAt ?? null).toBeNull();
    expect(t.provider.calls).toEqual(["send"]);
  });

  it("a 429 defers the send (nothing stored as sent) and pauses the company's limiter", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses" });
    t.ses.errors.push({ status: 429, type: "TooManyRequestsException", message: "Too many requests", headers: { "retry-after": "3" } });
    expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "retrying" });
    expect(t.ses.sends).toHaveLength(1);
  });

  it("SES's quota refusal defers the send, shows as the provider state, and holds the company's requests back", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses" });
    t.ses.errors.push({ status: 400, type: "LimitExceededException", message: "Daily message quota exceeded." });
    expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
    expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "quota" });
    expect(t.store.sends.get("campaigns:step:e1:1")).toMatchObject({ status: "retrying" });
  });

  it("SES refusing the keys or pausing sending is a config problem with SES's own words", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses" });
    t.ses.errors.push({ status: 400, type: "SendingPausedException", message: "Sending paused" });
    expect(await handleSendRequested(t.env, sendEvent(marketing()))).toBeNull();
    expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "key_refused" });
    expect(t.store.sends.get("campaigns:step:e1:1")!.error).toBe("Sending paused");
  });

  it("an unverified identity puts the domain back to pending; a rejected message fails for good", async () => {
    const t = sesSetup();
    await addEspDomain(t, { provider: "ses" });
    t.ses.errors.push({ status: 400, type: "MessageRejected", message: "Email address is not verified. The following identities failed the check in region EU-NORTH-1: hello@updates.client.co.za" });
    expect(await handleSendRequested(t.env, sendEvent(marketing()))).toMatchObject({ status: "failed", permanent: true });
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ status: "pending" });
    const u = sesSetup();
    await addEspDomain(u, { provider: "ses" });
    u.ses.errors.push({ status: 400, type: "BadRequestException", message: "Invalid parameter" });
    const result = await handleSendRequested(u.env, sendEvent(marketing()));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/refused the message: Invalid parameter/);
  });

  it("refuses marketing in the sandbox before any send call, with the one sentence; transactional mail is not refused", async () => {
    const t = sesSetup();
    t.ses.account.productionAccessEnabled = false;
    await addEspDomain(t, { provider: "ses" });
    await addEspDomain(t, { provider: "ses", domain: OWN_DOMAIN, client: null });
    const result = await handleSendRequested(t.env, sendEvent(marketing()));
    expect(result).toMatchObject({ status: "failed", permanent: true, error: `${SES_SANDBOX}.` });
    expect(t.ses.sends).toHaveLength(0);
    // Only GetAccount was asked, and the day's cap was not touched.
    expect(t.ses.requests.map((r) => r.path)).toEqual(["/v2/email/account"]);
    expect(t.store.espDays.get(`${CO}:${DOMAIN}:${today()}`)).toBeUndefined();
    expect(await handleSendRequested(t.env, sendEvent(invoice({ from: OWN_FROM }), `plugin.${PIB_PLUGINS.billing}.mail.send.requested`))).toMatchObject({ status: "sent", provider: "ses" });
  });

  it("the same sandbox refusal with the mock reporting a quota, and none when it is out of the sandbox", async () => {
    const quota = { maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 0, productionAccessEnabled: false, sendingEnabled: true };
    const sandbox = sesMockSetup({}, { quota });
    await addEspDomain(sandbox, { provider: "ses" });
    expect(await handleSendRequested(sandbox.env, sendEvent(marketing()))).toMatchObject({ status: "failed", error: expect.stringContaining(SES_SANDBOX) });
    expect(sandbox.provider.calls).toEqual([]);
    const live = sesMockSetup({}, { quota: { ...quota, productionAccessEnabled: true } });
    await addEspDomain(live, { provider: "ses" });
    expect(await handleSendRequested(live.env, sendEvent(marketing()))).toMatchObject({ status: "sent" });
  });

  it("builds no batcher for SES even with esp.batch on: five sends at once are five requests", async () => {
    const t = sesSetup({ esp: { ...SES_ON.esp, batch: true } });
    await addEspDomain(t, { provider: "ses" });
    const sends = await Promise.all([1, 2, 3, 4, 5].map((n) => handleSendRequested(t.env, sendEvent(marketing({ key: `k${n}`, to: [{ email: `p${n}@x.co` }] })))));
    expect(sends.every((r) => r?.status === "sent")).toBe(true);
    expect(t.ses.sends).toHaveLength(5);
  });

  it("buildEspEmail adds the pib_send tag only when asked, and a long key is hashed to fit", () => {
    const base = { companyId: CO, account: { address: FROM, from_name: null, reply_to: null }, fromName: null, request: marketing(), unsubscribeUrl: null, attachments: [] };
    expect(buildEspEmail(base).email.tags).toEqual([{ name: "pib_company", value: CO }]);
    expect(buildEspEmail({ ...base, sendTag: true }).email.tags).toEqual([{ name: "pib_company", value: CO }, { name: "pib_send", value: "campaigns_step_e1_1" }]);
    expect(sendTagValue("k".repeat(300))).toMatch(/^h_[0-9a-f]{48}$/);
  });
});
