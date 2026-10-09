import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { PIB_PLUGINS, type ContactEraseRequested } from "@partnersinbiz/pib-plugin-kit";
import { espHealth } from "../../src/cockpit.js";
import { parseMailboxConfig } from "../../src/config.js";
import { eraseSubject } from "../../src/erasure.js";
import { listMailboxes } from "../../src/agent-mail.js";
import manifest from "../../src/manifest.js";
import { NAMESPACE } from "../../src/namespace.js";
import { setupStatus } from "../../src/setup-status.js";
import { EMAIL_PROVIDER_REFERENCE, MAILBOX_DRAFT_SKILL, SKILLS } from "../../src/skills.js";
import { MAILBOX_TOOLS } from "../../src/tools.js";
import { CO } from "../helpers/memory.js";
import { addEspDomain, API_KEY, DOMAIN, dnsVerified, espSetup, FROM, sesSetup, WEBHOOK_SECRET } from "../helpers/esp.js";
import { checkDomain, holdsProviderSend, type EspCheck } from "../../src/domain-health.js";
import { addSendingDomain, ownerSteps } from "../../src/esp/domains.js";
import { espReadiness, espWebhookUrl, loadMailboxConfig, parseEspConfig, validateMailboxConfig } from "../../src/config.js";
import { markSesTopicConfirmed, readSesTopicConfirmed } from "../../src/esp/topic-state.js";
import { fakeDns } from "../helpers/dns.js";
import { SES_ACCESS_KEY_ID } from "../helpers/fake-ses.js";

const SECRET = (id: string) => ({ type: "secret_ref", secretId: id });
const BASE = { publicBaseUrl: "https://paperclip.example.com", encryptionKey: SECRET("s1"), google: { clientSecret: SECRET("s2") } };
const NOW = Date.parse("2026-10-03T10:00:00Z");

async function status(config: Record<string, unknown>, store = espSetup().store, state: unknown = null) {
  const ctx = createTestHarness({ manifest, config: { ...BASE, ...config } }).ctx;
  (ctx as unknown as { state: unknown }).state = {
    get: async (key: { namespace?: string; stateKey?: string }) => (key.namespace === "mailbox-esp" ? state : null),
    set: async () => undefined,
  };
  return setupStatus(ctx, CO, store, NOW);
}
const item = (s: Awaited<ReturnType<typeof status>>, key: string) => s.items.find((entry) => entry.key === key)!;

describe("the Setup items for the email provider", () => {
  it("are optional while nothing is set up, and say what they are for", async () => {
    const s = await status({});
    for (const key of ["esp_account", "esp_webhook", "esp_domain"]) expect(item(s, key), key).toMatchObject({ status: "optional", required: false });
    expect(item(s, "esp_account").detail).toMatch(/Optional\. Lets the Mailbox send as a client's own verified domain through Resend/);
    expect(item(s, "esp_webhook").blockedBy).toEqual(["esp_account"]);
    // Gmail's own items are not affected by them.
    expect(s.items.slice(0, -3).every((entry) => !entry.key.startsWith("esp_"))).toBe(true);
  });

  it("the account item gives the exact owner steps with their deep links, and becomes done when the switch and the key are saved", async () => {
    const todo = item(await status({}), "esp_account");
    expect(todo.steps).toEqual(expect.arrayContaining([
      expect.stringContaining("https://resend.com/signup"),
      expect.stringContaining("https://resend.com/api-keys"),
      expect.stringContaining("Full access"),
      expect.stringContaining("Switch the email provider on"),
    ]));
    expect(todo).toMatchObject({ href: "/company/settings/instance/plugins", hrefLabel: "Open settings" });
    // The key is saved but the switch is off.
    const off = item(await status({ esp: { enabled: false, apiKey: SECRET("k") } }), "esp_account");
    expect(off.detail).toMatch(/saved but the provider is switched off/);
    expect(off.steps!.some((step) => step.includes("resend.com/signup"))).toBe(false);
    const done = item(await status({ esp: { enabled: true, apiKey: SECRET("k") } }), "esp_account");
    expect(done).toMatchObject({ status: "done", steps: undefined });
    expect(done.agentNext).toMatch(/add-sending-domain/);
  });

  it("the webhook item names the address, the events and where the signing secret goes; with the secret saved it is done", async () => {
    const missing = item(await status({ esp: { enabled: true, apiKey: SECRET("k") } }), "esp_webhook");
    expect(missing).toMatchObject({ status: "missing", required: false, blockedBy: undefined });
    expect(missing.detail).toMatch(/Until this is set, nothing is sent through the provider/);
    expect(missing.steps![0]).toContain("https://resend.com/webhooks");
    expect(missing.steps![0]).toContain("https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/resend");
    expect(missing.steps![1]).toMatch(/email\.delivered, email\.bounced, email\.complained, email\.delivery_delayed, email\.failed, email\.opened, email\.clicked, email\.suppressed, domain\.updated/);
    expect(missing.steps!.join(" ")).toMatch(/Signing Secret.*whsec_/);
    expect(missing.agentNext).toMatch(/2% .* complaint rate 0\.1% .*held back for marketing/);
    expect(item(await status({ esp: { enabled: true, apiKey: SECRET("k"), webhookSecret: SECRET("w") } }), "esp_webhook")).toMatchObject({ status: "done", steps: undefined });
    // Without the public address the step says to save it first.
    const noBase = item(await status({ publicBaseUrl: "", esp: { enabled: true, apiKey: SECRET("k") } }), "esp_webhook");
    expect(noBase.steps![0]).toMatch(/save the Public base URL in the Mailbox settings first/);
  });

  it("the domain item lists the exact records while a domain waits, who adds them, and what happens after; done once verified", async () => {
    const t = espSetup();
    await addEspDomain(t, { status: "pending" });
    const waiting = item(await status({ esp: { enabled: true, apiKey: SECRET("k"), webhookSecret: SECRET("w") } }, t.store), "esp_domain");
    expect(waiting).toMatchObject({ status: "missing", required: false, blockedBy: undefined, href: "/mailbox?tab=mailboxes" });
    expect(waiting.detail).toContain(`${DOMAIN} (waiting for DNS records)`);
    expect(waiting.steps![0]).toMatch(/^For updates\.client\.co\.za: Whoever controls the DNS of client\.co\.za: the owner, or the client or their web host\. An agent cannot edit DNS/);
    expect(waiting.steps!.join("\n")).toContain("MX record at send.updates.client.co.za (in the client.co.za zone: send.updates), priority 10: feedback-smtp.eu-west-1.amazonses.com");
    expect(waiting.steps!.at(-1)).toMatch(/asks Resend to verify every hour/);
    // Not ready to send yet (no webhook secret): the item says it waits on the other two.
    const blocked = item(await status({ esp: { enabled: true, apiKey: SECRET("k") } }, t.store), "esp_domain");
    expect(blocked.blockedBy).toEqual(["esp_account", "esp_webhook"]);
    const verified = espSetup();
    await addEspDomain(verified);
    const done = item(await status({ esp: { enabled: true, apiKey: SECRET("k"), webhookSecret: SECRET("w") } }, verified.store), "esp_domain");
    expect(done).toMatchObject({ status: "done", steps: undefined });
    expect(done.detail).toBe(`Ready: ${DOMAIN}. Mail can go out as it; each domain's daily cap ramps up over its first 13 days.`);
  });

  it("a key Resend refused, or a quota used up, shows as blocked with the reason", async () => {
    const refused = item(await status({ esp: { enabled: true, apiKey: SECRET("k") } }, espSetup().store, { ok: false, at: "2026-10-03T09:00:00Z", code: "key_refused", detail: "API key is not active" }), "esp_account");
    expect(refused.status).toBe("blocked");
    expect(refused.detail).toMatch(/refused the Mailbox's API key \(API key is not active\)\. Mail through the provider waits.*Gmail is not affected/);
    expect(refused.steps!.join(" ")).toMatch(/create a new one and pick the new secret/);
    const quota = item(await status({ esp: { enabled: true, apiKey: SECRET("k") } }, espSetup().store, { ok: false, at: "2026-10-03T09:00:00Z", code: "quota", detail: "daily" }), "esp_account");
    expect(quota.detail).toMatch(/sending quota is used up/);
  });
});

describe("the Cockpit's view of the provider", () => {
  const ctxWith = (config: Record<string, unknown>, rows: Array<{ sent: string; events: string }> = [{ sent: "0", events: "0" }], state: unknown = null) => {
    const ctx = createTestHarness({ manifest, config }).ctx;
    (ctx as unknown as { db: unknown }).db = { namespace: NAMESPACE, query: async () => rows, execute: async () => ({ rowCount: 0 }) };
    (ctx as unknown as { state: unknown }).state = { get: async (key: { namespace?: string }) => (key.namespace === "mailbox-esp" ? state : null), set: async () => undefined };
    return ctx;
  };
  const ON = { esp: { enabled: true, apiKey: SECRET("k"), webhookSecret: SECRET("w") } };

  it("says nothing for a company that never set the provider up", async () => {
    const t = espSetup();
    expect(await espHealth(ctxWith({}), CO, t.store, NOW)).toEqual({ kpis: [], health: [] });
  });

  it("is bad when the provider refused the key or the quota is used up, with the fix", async () => {
    const t = espSetup();
    await addEspDomain(t);
    const out = await espHealth(ctxWith(ON, undefined, { ok: false, at: "2026-10-03T09:00:00Z", code: "key_refused", detail: "401" }), CO, t.store, NOW);
    expect(out.health[0]).toMatchObject({ key: "mailbox:esp", status: "bad", since: "2026-10-03T09:00:00Z" });
    expect(out.health[0]!.fix).toMatch(/create a new Resend API key with Full access/i);
    const quota = await espHealth(ctxWith(ON, undefined, { ok: false, at: "2026-10-03T09:00:00Z", code: "quota", detail: "daily" }), CO, t.store, NOW);
    expect(quota.health[0]!.detail).toMatch(/sending quota is used up/);
  });

  it("warns when domains exist but the webhook secret is missing, and when mail went out and no event came back", async () => {
    const t = espSetup();
    await addEspDomain(t);
    const noSecret = await espHealth(ctxWith({ esp: { enabled: true, apiKey: SECRET("k") } }), CO, t.store, NOW);
    expect(noSecret.health[0]).toMatchObject({ key: "mailbox:esp", status: "warn" });
    expect(noSecret.health[0]!.detail).toMatch(/until it is, nothing is sent through the provider, because bounces and complaints would be missed/);
    const silent = await espHealth(ctxWith(ON, [{ sent: "5", events: "0" }]), CO, t.store, NOW);
    expect(silent.health[0]).toMatchObject({ key: "mailbox:esp", status: "warn" });
    expect(silent.health[0]!.detail).toMatch(/5 messages went out through the provider.*no delivery event has come back.*bounces and complaints are not being seen/);
    expect(silent.health[0]!.fix).toMatch(/Endpoint URL.*signing secret/);
    const fine = await espHealth(ctxWith(ON, [{ sent: "5", events: "7" }]), CO, t.store, NOW);
    expect(fine.health[0]).toEqual({ key: "mailbox:esp", title: "Email provider", status: "ok" });
  });

  it("warns when a domain has used its daily cap, and counts what went out today", async () => {
    const t = espSetup();
    await addEspDomain(t);
    const today = new Date(NOW).toISOString().slice(0, 10);
    t.store.espDays.set(`${CO}:${DOMAIN}:${today}`, { company_id: CO, domain: DOMAIN, day: today, sent: 50, delivered: 0, hard_bounces: 0, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 });
    const out = await espHealth(ctxWith(ON, [{ sent: "0", events: "0" }]), CO, t.store, NOW);
    const cap = out.health.find((h) => h.key === `mailbox:esp-cap:${DOMAIN}`)!;
    expect(cap).toMatchObject({ status: "warn", title: `Daily send cap: ${DOMAIN}` });
    expect(cap.detail).toBe("50 of 50 recipients today (warm-up day 1): marketing mail from this domain waits until tomorrow (UTC). Transactional mail is not held back.");
    expect(out.kpis).toEqual([expect.objectContaining({ key: "esp_sent_today", raw: 50, label: "Sent through the email provider today" })]);
  });
});

describe("erasure", () => {
  it("removes what the provider said about a person (events and soft bounces) and wipes the delivery detail of their sends, and only theirs", async () => {
    const t = espSetup();
    await addEspDomain(t);
    const base = { provider: "resend", type: "email.bounced", emailId: "e", domain: DOMAIN, sendKey: null, detail: {} };
    await t.store.recordEspEvent({ ...base, companyId: CO, eventId: "m1", dedupeKey: "k1", recipient: "ann@lead.co.za" });
    await t.store.recordEspEvent({ ...base, companyId: CO, eventId: "m2", dedupeKey: "k2", recipient: "bob@x.co.za" });
    await t.store.recordSoftBounce(CO, "ann@lead.co.za", new Date().toISOString(), 14);
    t.store.sends.set("billing:inv-1", { key: "billing:inv-1", company_id: CO, source_plugin: "partnersinbiz.billing", account_id: null, from_address: FROM, to_addrs: [{ email: "ann@lead.co.za" }], subject: "Invoice", status: "sent", permanent: false, attempts: 1, gmail_message_id: null, gmail_thread_id: null, rfc_message_id: null, error: null, context: { plugin: "p", kind: "k", id: "i" }, request: { key: "billing:inv-1", to: [{ email: "ann@lead.co.za" }] } as never, claimed_at: null, sent_at: null, created_at: "", updated_at: "", skipped: [], provider: "resend", provider_message_id: "x", delivery_status: "bounced", delivery: { bounced_at: "t", bounceType: "Permanent" } });
    const request: ContactEraseRequested = { key: "erase:r", requestId: "r", subject: { email: "ann@lead.co.za" }, scope: "all", reason: "data_subject_request", approvedByUserId: "user-peet", requestedAt: "2026-10-03T08:00:00.000Z", dueBy: null, source: PIB_PLUGINS.crm };
    const outcome = await eraseSubject(t.env, CO, request);
    expect(outcome.counts).toMatchObject({ providerEvents: 2, sendRecords: 1 });
    expect(t.store.espEvents.map((e) => e.recipient)).toEqual(["bob@x.co.za"]);
    expect(t.store.health.size).toBe(0);
    expect(t.store.sends.get("billing:inv-1")).toMatchObject({ delivery: {}, to_addrs: [], request: { erased: true } });
  });
});

describe("what an agent sees", () => {
  it("list-mailboxes marks a send-only account, never offers to ask for read access to it, and says what a pending one waits for", async () => {
    const t = espSetup();
    await addEspDomain(t, { status: "pending" });
    await addEspDomain(t, { domain: "ready.client.co.za", id: "esp-ready", client: null, replyTo: "ops@pib.test" });
    const out = await listMailboxes(t.env, CO, "agent-am");
    const pending = out.accounts.find((a) => a.address === FROM)!;
    expect(pending).toMatchObject({ kind: "email-provider", status: "pending", mayRead: false, mayDraft: false, maySend: false, askToOwner: null, replyTo: "team@client.co.za" });
    expect(pending.problem).toMatch(/Waiting for the domain's DNS records to be verified.*list-sending-domains/);
    const ready = out.accounts.find((a) => a.address === "hello@ready.client.co.za")!;
    expect(ready).toMatchObject({ kind: "email-provider", status: "connected", problem: null, askToOwner: null });
    // The Gmail account is still offered for access, and is still the default.
    const gmail = out.accounts.find((a) => a.kind === "gmail")!;
    expect(gmail.askToOwner).not.toBeNull();
    expect(out.defaultAddress).toBe("peet@partnersinbiz.online");
  });
});

describe("the skill and the settings", () => {
  it("keeps the adapter OFF by default: nothing is on until the owner switches it on and the secrets exist", () => {
    expect(parseMailboxConfig({}).esp).toMatchObject({ enabled: false, hasCredentials: false, hasWebhookSecret: false });
    const esp = (manifest.instanceConfigSchema as { properties: Record<string, { properties: Record<string, Record<string, unknown>> }> }).properties.esp!;
    expect(esp.properties.enabled).toMatchObject({ type: "boolean", default: false });
    expect(esp.properties.apiKey).toMatchObject({ format: "secret-ref" });
    expect(esp.properties.apiKey).not.toHaveProperty("type");
    expect(esp.properties.webhookSecret).toMatchObject({ format: "secret-ref" });
    expect(esp.properties.prefer).toMatchObject({ enum: ["gmail", "transactional", "marketing"], default: "gmail" });
    expect(esp.properties.batch).toMatchObject({ default: false });
    expect(esp.properties.provider).toMatchObject({ enum: ["resend", "ses"] });
  });

  it("teaches the rules an agent must keep: DNS is never edited, one ask, no tests, no bypassing an approval, no Gmail as the client", () => {
    expect(MAILBOX_DRAFT_SKILL).toMatch(/\*\*DNS is never yours to edit\.\*\*/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/Put the steps in ONE `partnersinbiz\.cockpit:ask-owner`/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/you cannot create the account or the key/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/never moved to Gmail or to another client's domain/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/Never send a test through the provider, and never use it to get round an approval/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/a hard bounce puts the address on the list for all mail, a complaint on that SENDER's marketing list, a soft bounce pauses marketing to it 6, 24, then 72 hours/);
    expect(MAILBOX_DRAFT_SKILL).toMatch(/2% hard bounces or 0\.1% complaints over 7 days/);
    expect(MAILBOX_DRAFT_SKILL).toContain("references/email-provider.md");
  });

  it("documents the numbers it enforces, in the reference the skill opens", () => {
    expect(EMAIL_PROVIDER_REFERENCE).toContain("50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, then the steady cap (default 10,000)");
    expect(EMAIL_PROVIDER_REFERENCE).toMatch(/2% hard bounces \(judged from 100 recipients\) or 0\.1% complaints \(judged from 1,000 recipients; under those, three hard bounces or two complaints\)/);
    expect(EMAIL_PROVIDER_REFERENCE).toMatch(/6, 24, then 72 hours; the third in 14 days suppresses its marketing/);
    expect(EMAIL_PROVIDER_REFERENCE).toMatch(/Never send from Gmail as the client/);
    expect(SKILLS[0]!.files!.find((file) => file.path === "references/email-provider.md")!.content).toBe(EMAIL_PROVIDER_REFERENCE);
    expect(SKILLS[0]!.markdown!.length).toBeLessThanOrEqual(18_000);
    // The reference holds no secret-shaped text and no credential.
    expect(EMAIL_PROVIDER_REFERENCE).not.toMatch(/re_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9+/=]{8,}/);
  });

  it("describes the new tools well enough for an agent, and every parameter", () => {
    const add = MAILBOX_TOOLS.find((tool) => tool.name === "add-sending-domain")!;
    expect(add.description).toMatch(/DNS is edited by the owner, or the client or their web host, never by an agent/);
    expect((add.parametersSchema as { required: string[] }).required).toEqual(["domain"]);
    expect(Object.keys((add.parametersSchema as { properties: object }).properties)).toEqual(["domain", "fromAddress", "fromName", "replyTo", "clientKind", "clientRef", "region"]);
    const list = MAILBOX_TOOLS.find((tool) => tool.name === "list-sending-domains")!;
    expect((list.parametersSchema as { required: string[] }).required).toEqual([]);
    expect(API_KEY).toBeTruthy();
    expect(WEBHOOK_SECRET).toBeTruthy();
  });
});

describe("sending domains and domain health with Amazon SES", () => {
  const SES_DOMAIN = "partnersinbiz.online";
  const DMARC = { [`TXT _dmarc.${SES_DOMAIN}`]: ["v=DMARC1; p=none; rua=mailto:dmarc@partnersinbiz.online"] };
  const sesCheck = (over: Partial<EspCheck> = {}): EspCheck => ({ provider: "ses", returnPathHost: null, dkimSelector: "tok1abc", spfInclude: "amazonses.com", providerStatus: "verified", ...over });
  const KEY = `TXT tok1abc._domainkey.${SES_DOMAIN}`;
  const dkimValue = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84";

  it("add-sending-domain registers the identity at SES, stores provider ses, and creates a ses send-only account", async () => {
    const t = sesSetup();
    t.env.dns = fakeDns({ ...DMARC });
    const { created, view } = await addSendingDomain(t.env, CO, { domain: SES_DOMAIN, fromAddress: `news@${SES_DOMAIN}`, createdBy: "agent:am" });
    expect(created).toBe(true);
    expect(t.store.espDomains.get(`${CO}:${SES_DOMAIN}`)).toMatchObject({ provider: "ses", provider_domain_id: SES_DOMAIN, region: "eu-north-1", status: "pending", return_path_host: `mail.${SES_DOMAIN}`, spf_include: "amazonses.com" });
    const account = [...t.store.accounts.values()].find((a) => a.provider === "ses")!;
    expect(account).toMatchObject({ address: `news@${SES_DOMAIN}`, status: "pending" });
    expect(view.dns!.records.filter((r) => r.type === "CNAME")).toHaveLength(3);
    expect(view.dns!.records.map((r) => r.type)).toEqual(["CNAME", "CNAME", "CNAME", "MX", "TXT"]);
    expect(t.ses.identityCalls("PUT", "/mail-from")).toHaveLength(1);
    // Nothing secret reaches the store.
    expect(JSON.stringify([...t.store.espDomains.values()])).not.toContain(SES_ACCESS_KEY_ID);
    // Second call: where it stands, nothing registered again.
    const again = await addSendingDomain(t.env, CO, { domain: SES_DOMAIN, createdBy: "agent:am" });
    expect(again.created).toBe(false);
    expect(t.ses.identityCalls("POST")).toHaveLength(1);
  });

  it("adopts an identity verified in the console as it is: verified at once, account connected, MAIL FROM untouched", async () => {
    const t = sesSetup();
    t.ses.identities.set(SES_DOMAIN, { verifiedForSending: true, dkimStatus: "SUCCESS" });
    t.env.dns = fakeDns({ ...DMARC });
    const { view } = await addSendingDomain(t.env, CO, { domain: SES_DOMAIN, createdBy: "agent:am" });
    expect(view).toMatchObject({ status: "verified", ready: true, dns: null, account: { status: "connected" } });
    expect(t.ses.identityCalls("PUT")).toEqual([]);
    expect(t.store.espDomains.get(`${CO}:${SES_DOMAIN}`)!.return_path_host).toBeNull();
  });

  it("will not manage a domain registered with the other provider, in words", async () => {
    const t = sesSetup();
    await addEspDomain(t, { domain: SES_DOMAIN, provider: "resend", client: null });
    await expect(addSendingDomain(t.env, CO, { domain: SES_DOMAIN, createdBy: "agent:am" })).rejects.toThrow(/registered with Resend, but the Mailbox is set to Amazon SES/);
    expect(t.ses.requests.filter((r) => r.path.startsWith("/v2/email/identities"))).toEqual([]);
  });

  it("the owner steps are per provider: the SES ones name the AWS console and the configuration set, never Resend", () => {
    const links = { settings: "/settings", webhookUrl: null };
    const steps = ownerSteps(parseEspConfig({ esp: { enabled: true, provider: "ses" } }), links).join(" ");
    expect(steps).toMatch(/AWS console.*IAM user/);
    expect(steps).toMatch(/configuration set/);
    expect(steps).not.toMatch(/resend/i);
    expect(ownerSteps(parseEspConfig({ esp: { enabled: true, apiKey: API_KEY } }), links).join(" ")).toMatch(/Add Webhook/);
  });

  it("the daily DKIM read is informational: a resolver that does not follow the CNAME does not hold sends", async () => {
    // Does not follow: the CNAME is seen, no TXT comes back.
    const blind = await checkDomain(fakeDns({ ...DMARC }, { cnames: { [`tok1abc._domainkey.${SES_DOMAIN}`]: "tok1abc.dkim.amazonses.com" } }), SES_DOMAIN, { esp: sesCheck() });
    expect(blind.dkim.state).toBe("missing");
    expect(blind.problems.some((p) => p.code === "esp_dkim_missing")).toBe(false);
    expect(blind.problems.filter((p) => p.severity === "bad")).toEqual([]);
    expect(blind.problems.every((p) => !holdsProviderSend(p, true))).toBe(true);
    expect(blind.status).not.toBe("bad");
    expect(blind.sendReady).toBe(true);
    expect(blind.esp).toMatchObject({ provider: "ses", returnPathHost: null });
    // No CNAME visible either (NXDOMAIN): still informational.
    const none = await checkDomain(fakeDns({ ...DMARC }), SES_DOMAIN, { esp: sesCheck() });
    expect(none.problems.filter((p) => p.severity === "bad")).toEqual([]);
    // Follows the CNAME: the key comes back.
    const follows = await checkDomain(fakeDns({ ...DMARC, [KEY]: [dkimValue] }), SES_DOMAIN, { esp: sesCheck() });
    expect(follows.dkim.state).toBe("ok");
    expect(follows.problems.some((p) => p.code.startsWith("esp_dkim"))).toBe(false);
    expect(follows.status).toBe("healthy");
    expect(follows.sendReady).toBe(true);
  });

  it("an SES domain SES has not verified is still waiting or failed, whatever DNS shows; the same blind read on Resend is bad", async () => {
    const waiting = await checkDomain(fakeDns({ ...DMARC, [KEY]: [dkimValue] }), SES_DOMAIN, { esp: sesCheck({ providerStatus: "pending" }) });
    expect(waiting.problems.map((p) => p.code)).toContain("esp_waiting_for_dns");
    expect(waiting.sendReady).toBe(false);
    const failed = await checkDomain(fakeDns({ ...DMARC }), SES_DOMAIN, { esp: sesCheck({ providerStatus: "failed" }) });
    expect(failed.problems.some((p) => p.code === "esp_verification_failed" && holdsProviderSend(p, false))).toBe(true);
    const resend = await checkDomain(fakeDns({ ...DMARC }), SES_DOMAIN, { esp: { provider: "resend", returnPathHost: `send.${SES_DOMAIN}`, dkimSelector: "resend", spfInclude: "amazonses.com", providerStatus: "verified" } });
    expect(resend.problems.map((p) => p.code)).toContain("esp_dkim_missing");
  });

  it("with a custom MAIL FROM the SPF and MX at that host are judged for SES too; without one nothing is read there", async () => {
    const withHost = fakeDns({ ...DMARC, [`TXT mail.${SES_DOMAIN}`]: ["v=spf1 include:amazonses.com ~all"], [`MX mail.${SES_DOMAIN}`]: ["10 feedback-smtp.eu-north-1.amazonses.com."] });
    const ok = await checkDomain(withHost, SES_DOMAIN, { esp: sesCheck({ returnPathHost: `mail.${SES_DOMAIN}` }) });
    expect(ok.sendReady).toBe(true);
    expect(ok.problems.filter((p) => p.severity !== "info")).toEqual([]);
    const missing = await checkDomain(fakeDns({ ...DMARC }), SES_DOMAIN, { esp: sesCheck({ returnPathHost: `mail.${SES_DOMAIN}` }) });
    expect(missing.problems.map((p) => p.code)).toContain("esp_spf_missing");
    const dns = fakeDns({ ...DMARC });
    await checkDomain(dns, SES_DOMAIN, { esp: sesCheck() });
    expect(dns.queries.some((q) => q.includes("mail.") || q.includes("send."))).toBe(false);
  });

  it("a Resend domain is judged exactly as before (the provider field defaults to resend)", async () => {
    const report = await checkDomain(fakeDns(dnsVerified(DOMAIN)), DOMAIN, { esp: { returnPathHost: `send.${DOMAIN}`, dkimSelector: "resend", spfInclude: "amazonses.com", providerStatus: "verified" } });
    expect(report.status).toBe("healthy");
    expect(report.esp).toMatchObject({ provider: "resend", returnPathHost: `send.${DOMAIN}` });
  });
});

describe("Amazon SES settings, readiness and the marketing preference", () => {
  const KEY = (id: string) => ({ type: "secret_ref", secretId: id });
  const ARN = "arn:aws:sns:eu-north-1:123456789012:pib-ses-events";
  const ses = (more: Record<string, unknown> = {}) => ({ accessKeyId: KEY("a"), secretAccessKey: KEY("b"), configurationSet: "pib-marketing", snsTopicArn: ARN, ...more });
  const cfg = (esp: Record<string, unknown> = {}, confirmed = false) => {
    const parsed = parseEspConfig({ esp: { enabled: true, provider: "ses", ses: ses(), ...esp } });
    parsed.ses.topicConfirmed = confirmed;
    return parsed;
  };

  it("parses the ses block (region defaults to eu-north-1) and prefer accepts gmail, transactional and marketing only", () => {
    const parsed = cfg();
    expect(parsed).toMatchObject({ provider: "ses", hasCredentials: true, prefer: "gmail", ses: { region: "eu-north-1", configurationSet: "pib-marketing", snsTopicArn: ARN, hasAccessKeyId: true, hasSecretAccessKey: true } });
    expect(cfg({ prefer: "marketing" }).prefer).toBe("marketing");
    expect(cfg({ prefer: "transactional" }).prefer).toBe("transactional");
    expect(cfg({ prefer: "all" }).prefer).toBe("gmail");
    expect(validateMailboxConfig({ esp: { prefer: "all" } }).errors).toEqual([expect.stringMatching(/gmail, transactional or marketing/)]);
    expect(validateMailboxConfig({ esp: { prefer: "marketing", provider: "ses", ses: ses() } })).toMatchObject({ ok: true, errors: [] });
  });

  it("validateMailboxConfig refuses a malformed ARN and a region mismatch", () => {
    expect(validateMailboxConfig({ esp: { ses: ses({ snsTopicArn: "arn:aws:sns:eu-north-1:123:x" }) } }).errors).toEqual([expect.stringMatching(/should look like arn:aws:sns/)]);
    expect(validateMailboxConfig({ esp: { ses: ses({ snsTopicArn: "not an arn" }) } }).ok).toBe(false);
    expect(validateMailboxConfig({ esp: { ses: ses({ snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:t" }) } }).errors).toEqual([expect.stringMatching(/eu-west-1 but the AWS region is eu-north-1/)]);
    expect(validateMailboxConfig({ esp: { ses: ses({ region: "eu-west-1", snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:t" }) } }).ok).toBe(true);
  });

  it("SES readiness lists the blockers in fix order and is false until the topic is confirmed", () => {
    expect(espReadiness(parseEspConfig({ esp: { provider: "ses" } })).blockers).toEqual([
      "The email provider is switched off in the Mailbox settings.",
      expect.stringMatching(/access key id/),
      expect.stringMatching(/secret access key/),
    ]);
    const noSet = espReadiness(cfg({ ses: ses({ configurationSet: "" }) }));
    expect(noSet.sending).toBe(false);
    expect(noSet.blockers.map((b) => b.replace(/:.*/, ""))).toEqual(["The SES configuration set is not saved in the Mailbox settings"]);
    const noArn = espReadiness(cfg({ ses: ses({ snsTopicArn: "" }) }));
    expect(noArn).toMatchObject({ domains: true, sending: false });
    expect(noArn.blockers).toEqual([expect.stringMatching(/SNS topic ARN is not saved/)]);
    const waiting = espReadiness(cfg());
    expect(waiting).toEqual({ domains: true, sending: false, blockers: ["waiting for the SNS subscription: in the SNS console, use Request confirmation"] });
    expect(espReadiness(cfg({}, true))).toEqual({ domains: true, sending: true, blockers: [] });
  });

  it("confirmation is per topic ARN: changing the ARN starts over", async () => {
    const harness = createTestHarness({ manifest, config: { esp: { enabled: true, provider: "ses", prefer: "marketing", ses: ses() } } });
    expect(await readSesTopicConfirmed(harness.ctx, CO, ARN)).toBe(false);
    await markSesTopicConfirmed(harness.ctx, CO, ARN, Date.now());
    expect(await readSesTopicConfirmed(harness.ctx, CO, ARN)).toBe(true);
    expect(await readSesTopicConfirmed(harness.ctx, CO, "arn:aws:sns:eu-north-1:123456789012:other")).toBe(false);
    expect((await loadMailboxConfig(harness.ctx, CO)).config.esp.ses.topicConfirmed).toBe(true);
    const changed = createTestHarness({ manifest, config: { esp: { enabled: true, provider: "ses", ses: ses({ snsTopicArn: "arn:aws:sns:eu-north-1:123456789012:other" }) } } });
    await markSesTopicConfirmed(changed.ctx, CO, ARN, Date.now());
    expect((await loadMailboxConfig(changed.ctx, CO)).config.esp.ses.topicConfirmed).toBe(false);
  });

  it("espWebhookUrl names the endpoint of the provider", () => {
    expect(espWebhookUrl("https://p.example.com/")).toBe("https://p.example.com/api/plugins/partnersinbiz.mailbox/webhooks/resend");
    expect(espWebhookUrl("https://p.example.com", "ses")).toBe("https://p.example.com/api/plugins/partnersinbiz.mailbox/webhooks/ses");
    expect(espWebhookUrl(null, "ses")).toBeNull();
  });
});
