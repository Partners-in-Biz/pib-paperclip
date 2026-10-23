import { describe, expect, it } from "vitest";
import { espReadiness, parseEspConfig, validateMailboxConfig } from "../../src/config.js";
import { checkDomain, evaluateDomain, sendingDomains, type EspCheck } from "../../src/domain-health.js";
import { addSendingDomain, dnsInstructions, MAX_ESP_DOMAINS, ownerSteps, refreshPendingDomains, refreshSendingDomain, requiredRecords, sendingDomainView, VERIFY_EVERY_MS } from "../../src/esp/domains.js";
import { forgetEspRuntime } from "../../src/esp/runtime.js";
import { loadMailboxConfig } from "../../src/config.js";
import { CO } from "../helpers/memory.js";
import { fakeDns } from "../helpers/dns.js";
import { addEspDomain, API_KEY, CLIENT, DOMAIN, dnsVerified, ESP_ON, espSetup, FROM, providerRecords, WEBHOOK_SECRET } from "../helpers/esp.js";

const LINKS = { settings: "/company/settings/instance/plugins/abc", webhookUrl: "https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/resend" };

function setupWithClient(config: Record<string, unknown> = {}) {
  const t = espSetup(config);
  t.store.crm.push({ kind: "company", id: CLIENT.ref, name: "Client Co", domain: "client.co.za", emails: [], accountIds: [] });
  // Before the owner adds any DNS.
  t.env.dns = fakeDns({});
  return t;
}

const add = (t: ReturnType<typeof setupWithClient>, input: Partial<Parameters<typeof addSendingDomain>[2]> = {}) =>
  addSendingDomain(t.env, CO, { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref, replyTo: "team@client.co.za", createdBy: "agent:am", ownerLinks: LINKS, ...input });

describe("the provider settings", () => {
  it("is off until switched on AND the API key is saved, and sends only with the webhook secret too", () => {
    expect(espReadiness(parseEspConfig({}))).toEqual({ domains: false, sending: false, blockers: ["The email provider is switched off in the Mailbox settings.", "The Resend API key is not saved as a Paperclip secret in the Mailbox settings."] });
    const keyOnly = espReadiness(parseEspConfig({ esp: { enabled: false, apiKey: { type: "secret_ref", secretId: "s1" } } }));
    expect(keyOnly).toMatchObject({ domains: false, sending: false });
    const on = espReadiness(parseEspConfig({ esp: { enabled: true, apiKey: { type: "secret_ref", secretId: "s1" } } }));
    expect(on).toMatchObject({ domains: true, sending: false });
    expect(on.blockers).toEqual([expect.stringMatching(/webhook signing secret is not saved: until it is, nothing is sent through the provider/)]);
    expect(espReadiness(parseEspConfig({ esp: { enabled: true, apiKey: { type: "secret_ref", secretId: "s1" }, webhookSecret: { type: "secret_ref", secretId: "s2" } } }))).toEqual({ domains: true, sending: true, blockers: [] });
    // A secret ref with no id is not a saved secret.
    expect(parseEspConfig({ esp: { enabled: true, apiKey: { type: "secret_ref", secretId: "" } } }).hasCredentials).toBe(false);
  });

  it("reads the numbers with their defaults and limits", () => {
    expect(parseEspConfig({})).toMatchObject({ enabled: false, ratePerSecond: 4, steadyDailyCap: 10_000, prefer: "gmail", defaultFrom: null, batch: false });
    expect(parseEspConfig({ esp: { ratePerSecond: 99, steadyDailyCap: 0, prefer: "transactional", defaultFrom: " Hello@X.co ", batch: true } })).toMatchObject({ ratePerSecond: 4, steadyDailyCap: 10_000, prefer: "transactional", defaultFrom: "hello@x.co", batch: true });
    const bad = validateMailboxConfig({ esp: { ratePerSecond: 50, steadyDailyCap: -3, defaultFrom: "nope", apiKey: "re_typed", webhookSecret: "whsec_typed" } });
    expect(bad.errors).toEqual(["Requests per second must be a whole number from 1 to 10", "The daily cap must be a whole number from 1 to 1000000", "The company's own provider address is not an email address"]);
    expect(bad.warnings).toHaveLength(2);
    expect(validateMailboxConfig({ esp: "no" }).errors).toEqual(["The email provider settings are not valid"]);
    expect(validateMailboxConfig({ esp: ESP_ON.esp }).ok).toBe(true);
  });
});

describe("add-sending-domain", () => {
  it("says what the owner must do, in steps with links, when the provider is not ready, and registers nothing", async () => {
    const t = setupWithClient({ esp: { enabled: false } });
    const error = await add(t).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/The email provider is not ready: The email provider is switched off.*The Resend API key is not saved/);
    expect((error as Error).message).toMatch(/An agent cannot create the Resend account or its API key. Ask the owner ONCE \(partnersinbiz\.cockpit:ask-owner\)/);
    for (const part of ["https://resend.com/signup", "https://resend.com/api-keys", "Full access", "/company/settings/instance/plugins/abc", "https://resend.com/webhooks", "https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/resend", "whsec_", "email.bounced", "email.complained"]) {
      expect((error as Error).message, part).toContain(part);
    }
    expect(t.provider.calls).toEqual([]);
    expect(t.store.espDomains.size).toBe(0);
    expect(t.store.accounts.has("esp")).toBe(false);
  });

  it("with only the webhook still to do, the steps are only the webhook's", () => {
    const steps = ownerSteps(parseEspConfig({ esp: { enabled: true, apiKey: API_KEY } }), LINKS);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("Add Webhook");
    expect(ownerSteps(parseEspConfig({ esp: { enabled: false, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET } }), LINKS)).toEqual([expect.stringMatching(/switch it on/)]);
  });

  it("registers the domain, creates the send-only account for the client, and returns the exact records, who adds them, and what happens after", async () => {
    const t = setupWithClient();
    const { created, view, report } = await add(t);
    expect(created).toBe(true);
    expect(t.provider.calls).toEqual(["addDomain"]);
    expect(view).toMatchObject({ domain: DOMAIN, status: "not_started", ready: false, client: { kind: "company", ref: CLIENT.ref }, region: "us-east-1", account: { address: FROM, fromName: "Client Co", replyTo: "team@client.co.za", status: "pending" } });
    expect(view.cap).toMatchObject({ cap: 50, day: 1, warming: true, sentToday: 0, remaining: 50 });
    // The records, in order, with the full host and the host to type in the zone.
    expect(view.dns!.zone).toBe("client.co.za");
    expect(view.dns!.records.map((r) => [r.type, r.host, r.hostInZone, r.priority])).toEqual([
      ["MX", `send.${DOMAIN}`, "send.updates", 10],
      ["TXT", `send.${DOMAIN}`, "send.updates", null],
      ["TXT", `resend._domainkey.${DOMAIN}`, "resend._domainkey.updates", null],
    ]);
    expect(view.dns!.records[1]!.value).toBe("v=spf1 include:amazonses.com ~all");
    // DMARC is suggested because the domain (and its parent) has none.
    expect(view.dns!.dmarc).toMatchObject({ type: "TXT", host: `_dmarc.${DOMAIN}`, value: expect.stringMatching(/^v=DMARC1; p=none; rua=mailto:/) });
    expect(view.dns!.steps[0]).toMatch(/^At the DNS host for client\.co\.za, add these 4 records, exactly as written/);
    expect(view.dns!.steps).toContain("Save. DNS changes can take a few hours to show.");
    expect(view.dns!.whoAddsIt).toMatch(/the owner, or the client or their web host\. An agent cannot edit DNS/);
    expect(view.dns!.afterwards).toMatch(/verifies the domain by itself.*every hour/);
    // What is stored.
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ provider: "resend", status: "not_started", client_kind: "company", client_ref: CLIENT.ref, return_path_host: `send.${DOMAIN}`, dkim_selector: "resend", spf_include: "amazonses.com", created_by: "agent:am" });
    const account = [...t.store.accounts.values()].find((a) => a.provider === "resend")!;
    expect(account).toMatchObject({ address: FROM, status: "pending", client_kind: "company", client_ref: CLIENT.ref, reply_to: "team@client.co.za", token_sealed: null, is_default: false });
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)!.account_id).toBe(account.id);
    // The DNS was read straight away, so it is watched from now on and the first answer says what is missing.
    expect(report).toMatchObject({ status: "bad" });
    expect(report!.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["esp_waiting_for_dns", "esp_spf_missing", "esp_dkim_missing"]));
    expect(t.store.domainChecks.has(`${CO}:${DOMAIN}`)).toBe(true);
  });

  it("nothing is sent, no DNS is edited and no secret is stored by adding a domain", async () => {
    const t = setupWithClient();
    await add(t);
    expect(t.provider.sent).toEqual([]);
    expect(t.gmail.sent).toEqual([]);
    expect(JSON.stringify([...t.store.espDomains.values()])).not.toContain(API_KEY);
    expect(JSON.stringify([...t.store.espDomains.values()])).not.toContain(WEBHOOK_SECRET);
  });

  it("is idempotent: a second call returns where it stands, registers nothing again, and keeps the account", async () => {
    const t = setupWithClient();
    const first = await add(t);
    const second = await add(t);
    expect(second.created).toBe(false);
    expect(t.provider.calls.filter((c) => c === "addDomain")).toHaveLength(1);
    expect([...t.store.accounts.values()].filter((a) => a.provider === "resend")).toHaveLength(1);
    expect(second.view.account!.id).toBe(first.view.account!.id);
    // A reply-to given later is saved on the account.
    await add(t, { replyTo: "boss@client.co.za" });
    expect([...t.store.accounts.values()].find((a) => a.provider === "resend")!.reply_to).toBe("boss@client.co.za");
  });

  it("adopts a domain the owner already added in the Resend dashboard instead of failing or registering twice", async () => {
    const t = setupWithClient();
    await t.provider.addDomain({ name: DOMAIN });
    const { created, view } = await add(t);
    expect(created).toBe(true);
    expect(t.provider.calls).toEqual(["addDomain", "addDomain", "listDomains", "getDomain"]);
    expect(view.dns!.records).toHaveLength(3);
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)!.provider_domain_id).toBe("dom-1");
  });

  it("a domain the provider already verified brings its account up at once", async () => {
    const t = setupWithClient();
    const remote = await t.provider.addDomain({ name: DOMAIN });
    t.provider.markVerified(DOMAIN);
    expect(remote.status).toBe("not_started");
    const { view } = await add(t);
    expect(view).toMatchObject({ status: "verified", ready: true, dns: null, account: { status: "connected" } });
  });

  it("refuses what cannot work, with the fix, and registers nothing", async () => {
    const t = setupWithClient();
    await expect(add(t, { domain: "gmail.com" })).rejects.toThrow(/free mail service/);
    await expect(add(t, { domain: "not a domain" })).rejects.toThrow(/domain is required/);
    await expect(add(t, { fromAddress: "hello@other.co.za" })).rejects.toThrow(/must be an address at updates\.client\.co\.za/);
    await expect(add(t, { fromAddress: "nope" })).rejects.toThrow(/must be an address at/);
    await expect(add(t, { replyTo: "not-an-address" })).rejects.toThrow(/reply-to address not-an-address is not an email address/);
    await expect(add(t, { replyTo: FROM })).rejects.toThrow(/must be somewhere somebody reads/);
    await expect(add(t, { clientRef: "crm-missing" })).rejects.toThrow(/no company crm-missing.*find-records/);
    expect(t.provider.calls).toEqual([]);
    expect(t.store.espDomains.size).toBe(0);
  });

  it("refuses a From address that is already a mailbox, so an existing Gmail identity is never taken over", async () => {
    const t = setupWithClient();
    t.store.addAccount({ id: "acc-x", company_id: CO, address: FROM, token_sealed: "x" });
    await expect(add(t)).rejects.toThrow(/already a mailbox in this company/);
    expect(t.provider.calls).toEqual([]);
  });

  it("registers at most 25 domains, and a domain belongs to one client", async () => {
    const t = setupWithClient();
    for (let i = 0; i < MAX_ESP_DOMAINS; i += 1) await addEspDomain(t, { domain: `d${i}.client.co.za`, id: `esp-${i}` });
    await expect(add(t, { domain: "one-more.client.co.za" })).rejects.toThrow(/25 sending domains are already registered/);
    const u = setupWithClient();
    await add(u);
    await expect(add(u, { clientRef: "crm-someone-else" })).rejects.toThrow(/already belongs to another client/);
  });

  it("the company's own domain cannot be given to a client afterwards: it says so instead of silently ignoring the client", async () => {
    const t = setupWithClient();
    const own = await add(t, { clientRef: undefined });
    expect(own.view.client).toBeNull();
    const calls = t.provider.calls.length;
    await expect(add(t, { clientRef: "crm-client-1" })).rejects.toThrow(/already registered as the company's own sending domain.*one client only.*subdomain/);
    expect(t.provider.calls).toHaveLength(calls);
    // Asking again without a client is still the harmless "where does it stand" call, and stays the company's own.
    expect((await add(t, { clientRef: undefined })).view.client).toBeNull();
    expect([...t.store.espDomains.values()][0]).toMatchObject({ client_ref: null });
  });

  it("two add-sending-domain calls racing for one address: the second one is told so (the unique index refuses its account), and anything else is not dressed up as that", async () => {
    const t = setupWithClient();
    const insert = t.store.insertEspAccount.bind(t.store);
    t.store.insertEspAccount = async (row) => {
      await insert(row);
      // The other call got there first: the same insert again hits the index.
      throw new Error('duplicate key value violates unique constraint "accounts_resend_address"');
    };
    await expect(add(t)).rejects.toThrow(/Another add-sending-domain for updates\.client\.co\.za has just created hello@updates\.client\.co\.za/);
    t.store.insertEspAccount = async () => {
      throw new Error("the database dropped");
    };
    await expect(add(t, { domain: "other.client.co.za" })).rejects.toThrow(/database dropped/);
  });

  it("the provider's own refusal reaches the agent as words (a sending-only key cannot add a domain)", async () => {
    const t = setupWithClient();
    t.provider.addDomain = async () => {
      const { EspApiError } = await import("../../src/esp/types.js");
      throw new EspApiError("The Resend API key is restricted to sending. Managing domains needs a key with full access", "config", 401, "restricted_api_key");
    };
    await expect(add(t)).rejects.toThrow(/Could not add the domain: The Resend API key is restricted to sending.*full access/);
    expect(t.store.espDomains.size).toBe(0);
  });
});

describe("verification", () => {
  it("asks the provider to look again, at most once every six hours per domain, and reads its status", async () => {
    const t = setupWithClient();
    await add(t);
    const loaded = await loadMailboxConfig(t.host.ctx, CO);
    const first = await refreshSendingDomain(t.env, loaded, CO, DOMAIN);
    expect(first).toMatchObject({ status: "pending", asked: true, becameVerified: false });
    const second = await refreshSendingDomain(t.env, loaded, CO, DOMAIN);
    expect(second.asked).toBe(false);
    expect(t.provider.calls.filter((c) => c === "verifyDomain")).toHaveLength(1);
    // After six hours it asks again; a person pressing Check now asks at once.
    t.env.now = () => Date.now() + VERIFY_EVERY_MS + 1000;
    expect((await refreshSendingDomain(t.env, loaded, CO, DOMAIN)).asked).toBe(true);
    t.env.now = () => Date.now();
    expect((await refreshSendingDomain(t.env, loaded, CO, DOMAIN, { force: true })).asked).toBe(true);
  });

  it("when the provider verifies the domain the account becomes connected, and the DNS is checked from outside straight away", async () => {
    const t = setupWithClient();
    await add(t);
    expect(t.store.domainChecks.get(`${CO}:${DOMAIN}`)!.status).toBe("bad");
    // The owner adds the records: the provider sees them, and so does public DNS.
    t.provider.dnsAdded = true;
    t.env.dns = fakeDns(dnsVerified());
    const loaded = await loadMailboxConfig(t.host.ctx, CO);
    const out = await refreshSendingDomain(t.env, loaded, CO, DOMAIN);
    expect(out).toMatchObject({ status: "verified", becameVerified: true });
    expect([...t.store.accounts.values()].find((a) => a.provider === "resend")!.status).toBe("connected");
    expect(t.store.espDomains.get(`${CO}:${DOMAIN}`)).toMatchObject({ status: "verified", verified_at: expect.any(String) });
    expect(t.store.domainChecks.get(`${CO}:${DOMAIN}`)).toMatchObject({ status: "healthy" });
  });

  it("the hourly pass looks only at domains still waiting, and one that fails does not stop the others", async () => {
    const t = setupWithClient();
    await add(t);
    await addEspDomain(t, { domain: "ready.client.co.za", id: "esp-ready" });
    await addEspDomain(t, { domain: "gone.client.co.za", id: "esp-gone", status: "pending" });
    const out = await refreshPendingDomains(t.env, CO);
    // The mock has no such domain as gone.client.co.za: it fails alone.
    expect(out).toEqual({ looked: 1, verified: 0 });
    // The waiting domain was read; the one the provider does not know failed at the verify call, alone.
    expect(t.provider.calls.filter((c) => c === "getDomain")).toHaveLength(1);
    expect(t.provider.calls.filter((c) => c === "verifyDomain")).toHaveLength(2);
    t.provider.dnsAdded = true;
    t.env.dns = fakeDns(dnsVerified());
    t.env.now = () => Date.now() + VERIFY_EVERY_MS + 1000;
    expect(await refreshPendingDomains(t.env, CO)).toEqual({ looked: 1, verified: 1 });
  });

  it("does nothing, and calls nothing, for a company that has not switched the provider on", async () => {
    const t = setupWithClient({ esp: { enabled: false } });
    await addEspDomain(t, { status: "pending" });
    expect(await refreshPendingDomains(t.env, CO)).toEqual({ looked: 0, verified: 0 });
    expect(t.provider.calls).toEqual([]);
  });

  it("a provider refusing the key while reading a domain says so", async () => {
    const t = setupWithClient();
    await add(t);
    const { EspApiError } = await import("../../src/esp/types.js");
    t.provider.getDomain = async () => {
      throw new EspApiError("API key is not active", "config", 403);
    };
    const loaded = await loadMailboxConfig(t.host.ctx, CO);
    await expect(refreshSendingDomain(t.env, loaded, CO, DOMAIN)).rejects.toThrow(/Could not read the domain: API key is not active/);
    const { readEspState } = await import("../../src/esp/runtime.js");
    expect(await readEspState(t.host.ctx, CO)).toMatchObject({ ok: false, code: "key_refused" });
  });

  it("a domain that is not one of the provider's is refused with the way to add it", async () => {
    const t = setupWithClient();
    const loaded = await loadMailboxConfig(t.host.ctx, CO);
    await expect(refreshSendingDomain(t.env, loaded, CO, "nope.co.za")).rejects.toThrow(/not a sending domain of the email provider/);
  });
});

describe("what the domain is judged on", () => {
  const esp = (overrides: Partial<EspCheck> = {}): EspCheck => ({ returnPathHost: `send.${DOMAIN}`, dkimSelector: "resend", spfInclude: "amazonses.com", providerStatus: "verified", ...overrides });
  const NOW = Date.parse("2026-10-03T10:00:00Z");
  const check = (records: Record<string, string[]>, options: Partial<Parameters<typeof checkDomain>[2]> = {}) => checkDomain(fakeDns(records), DOMAIN, { esp: esp(), gmail: false, hasMailbox: false, now: NOW, ...options });

  it("a provider-only domain with its records in place is healthy and send-ready, with no MX or apex SPF of its own", async () => {
    const report = await check(dnsVerified());
    expect(report).toMatchObject({ status: "healthy", sendReady: true, problems: [] });
    expect(report.esp).toMatchObject({ returnPathHost: `send.${DOMAIN}`, spfAuthorisesProvider: true, selector: "resend", providerStatus: "verified" });
  });

  it("reads only the provider's DKIM selector, not the long list of usual ones", async () => {
    const dns = fakeDns(dnsVerified());
    await checkDomain(dns, DOMAIN, { esp: esp(), gmail: false, now: NOW });
    expect(dns.queries.filter((q) => q.includes("_domainkey"))).toEqual([`TXT resend._domainkey.${DOMAIN}`]);
  });

  it("no SPF at the return-path host, or no DKIM key, is bad; a missing return-path MX is a warning", async () => {
    const noSpf = await check({ ...dnsVerified(), [`TXT send.${DOMAIN}`]: [] });
    expect(noSpf.status).toBe("bad");
    expect(noSpf.problems.map((p) => p.code)).toEqual(["esp_spf_missing"]);
    expect(noSpf.problems[0]!.message).toBe(`send.${DOMAIN} has no SPF record: mail from the email provider would fail SPF for ${DOMAIN}.`);
    expect(noSpf.sendReady).toBe(false);
    const noDkim = await check({ ...dnsVerified(), [`TXT resend._domainkey.${DOMAIN}`]: [] });
    expect(noDkim.problems.map((p) => p.code)).toEqual(["esp_dkim_missing"]);
    const noMx = await check({ ...dnsVerified(), [`MX send.${DOMAIN}`]: [] });
    expect(noMx).toMatchObject({ status: "warn" });
    expect(noMx.problems.map((p) => p.code)).toEqual(["esp_return_mx_missing"]);
  });

  it("an SPF record that does not include the provider, or two SPF records, is bad", async () => {
    const wrong = await check({ ...dnsVerified(), [`TXT send.${DOMAIN}`]: ["v=spf1 include:_spf.google.com ~all"] });
    expect(wrong.problems.map((p) => p.code)).toEqual(["esp_spf_wrong"]);
    const two = await check({ ...dnsVerified(), [`TXT send.${DOMAIN}`]: ["v=spf1 include:amazonses.com ~all", "v=spf1 include:other.com ~all"] });
    expect(two.problems.map((p) => p.code)).toContain("esp_spf_multiple");
  });

  it("a domain the provider has not verified is a warning while it waits and bad when verification failed", async () => {
    const waiting = await checkDomain(fakeDns(dnsVerified()), DOMAIN, { esp: esp({ providerStatus: "pending" }), gmail: false, now: NOW });
    expect(waiting.problems.map((p) => p.code)).toEqual(["esp_waiting_for_dns"]);
    expect(waiting).toMatchObject({ status: "warn", sendReady: false });
    const failed = await checkDomain(fakeDns(dnsVerified()), DOMAIN, { esp: esp({ providerStatus: "failed" }), gmail: false, now: NOW });
    expect(failed).toMatchObject({ status: "bad" });
    expect(failed.problems.map((p) => p.code)).toEqual(["esp_verification_failed"]);
  });

  it("a DNS lookup that cannot be read is never called missing", async () => {
    const report = await checkDomain(fakeDns(dnsVerified(), { down: [`TXT send.${DOMAIN}`] }), DOMAIN, { esp: esp(), gmail: false, now: NOW });
    expect(report.unreadable).toBe(true);
    expect(report.problems.map((p) => p.code)).toEqual(["dns_unreadable"]);
    expect(report.status).toBe("warn");
    expect(report.manual).toEqual(expect.arrayContaining([`dig +short TXT send.${DOMAIN}`, `dig +short MX send.${DOMAIN}`]));
  });

  it("DMARC is still asked of a provider domain (its organisational domain's counts)", async () => {
    const noDmarc = await check({ ...dnsVerified(), ["TXT _dmarc.client.co.za"]: [] });
    expect(noDmarc.problems.map((p) => p.code)).toEqual(["dmarc_missing"]);
    expect(noDmarc.sendReady).toBe(false);
  });

  it("a domain that ALSO has a Gmail mailbox is judged on both: Google's SPF at the apex and the provider's at its return path", async () => {
    const both = await check({ ...dnsVerified(), [`TXT ${DOMAIN}`]: ["v=spf1 include:_spf.google.com ~all"], [`MX ${DOMAIN}`]: ["1 smtp.google.com."], "TXT _spf.google.com": ["v=spf1 ip4:35.190.247.0/24 ~all"], [`TXT google._domainkey.${DOMAIN}`]: ["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmql4cTGP5v9DJUqAC1HXLqqxXVXyOZhbLzoPFOSTqiSnSmprmP0fpv2Ql5oR3BG9zMDW+pNKQKZZYZP0V7p8ATEeB3Bp3MvvQ4vzpnB+RUCTMHNHdlSLAw/b5GZrRLwwIDAQAB"] }, { gmail: true, hasMailbox: true });
    // (An info note that the sample DKIM key is 1024-bit is not a problem.)
    expect(both.problems.filter((p) => p.severity !== "info")).toEqual([]);
    expect(both.status).toBe("healthy");
    // Without the Gmail records the same domain fails on Gmail's side, not the provider's.
    const missing = await check(dnsVerified(), { gmail: true, hasMailbox: true });
    expect(missing.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["spf_missing", "mx_missing"]));
    expect(missing.problems.map((p) => p.code)).not.toContain("esp_spf_missing");
  });

  it("the last 7 days of bounces and complaints are merged in as problems that hold marketing back", () => {
    const parts = { domain: DOMAIN, mx: { state: "missing" as const, hosts: [], provider: null }, spf: { state: "missing" as const, record: null, all: null, lookups: 0, lookupsApprox: false, includes: [], authorisesGoogle: false }, dkim: { state: "missing" as const, found: [], selectors: [] }, dmarc: { state: "monitor" as const, record: "v=DMARC1; p=none", policy: "none", subdomainPolicy: null, pct: null, rua: ["mailto:a@b.co"], inheritedFrom: null }, selectors: ["resend"] };
    const okSpf = { state: "ok" as const, record: "v=spf1 include:amazonses.com ~all", all: "~all" as const, lookups: 1, lookupsApprox: false, includes: ["amazonses.com"], authorisesGoogle: false };
    const espParts = { providerStatus: "verified" as const, returnPathHost: `send.${DOMAIN}`, spf: okSpf, spfAuthorisesProvider: true, mx: { state: "ok" as const, hosts: ["feedback-smtp.eu-west-1.amazonses.com"], provider: "other" as const }, dkim: { state: "ok" as const, found: ["resend"], selectors: [] }, selector: "resend" };
    const rep = { windowDays: 7, sent: 1000, delivered: 970, hardBounces: 30, softBounces: 0, complaints: 0, bounceRate: 0.03, complaintRate: 0, judged: true, complaintsJudged: true, computedAt: "x", problems: [{ code: "esp_bounce_rate" as const, severity: "bad" as const, message: "30 of 1000 hard bounced", fix: "clean the list", blocks: "marketing" as const }] };
    const report = evaluateDomain({ ...parts, esp: espParts }, { esp: esp(), gmail: false, reputation: rep, now: NOW });
    expect(report.status).toBe("bad");
    expect(report.problems).toEqual([{ code: "esp_bounce_rate", severity: "bad", message: "30 of 1000 hard bounced", fix: "clean the list", blocks: "marketing" }]);
    // Without it the same domain is healthy.
    expect(evaluateDomain({ ...parts, esp: espParts }, { esp: esp(), gmail: false, now: NOW }).status).toBe("healthy");
  });

  it("sendingDomains lists a provider domain beside the Gmail ones, as one that does not receive mail, and a Gmail domain with a provider account keeps both", async () => {
    const t = setupWithClient();
    await addEspDomain(t);
    // The Gmail mailbox peet@partnersinbiz.online is the setup's own.
    await addEspDomain(t, { domain: "partnersinbiz.online", client: null, id: "esp-pib" });
    const list = await sendingDomains(t.store, CO);
    const provider = list.find((d) => d.domain === DOMAIN)!;
    expect(provider).toMatchObject({ receives: false, gmail: false, mailboxes: [FROM], esp: { returnPathHost: `send.${DOMAIN}`, dkimSelector: "resend", spfInclude: "amazonses.com", providerStatus: "verified" }, clientRef: CLIENT.ref });
    const both = list.find((d) => d.domain === "partnersinbiz.online")!;
    expect(both).toMatchObject({ receives: true, gmail: true, esp: expect.objectContaining({ dkimSelector: "resend" }) });
    expect(both.mailboxes.sort()).toEqual(["hello@partnersinbiz.online", "peet@partnersinbiz.online"]);
  });
});

describe("the records handed over", () => {
  const row = { domain: DOMAIN, status: "pending" as const, records: [...providerRecords("not_started"), { record: "Tracking", type: "CNAME" as const, name: `links.${DOMAIN}`, fqdn: `links.${DOMAIN}`, value: "links1.resend-dns.com", priority: null, ttl: "Auto", status: "not_started", purpose: "tracking" }] };

  it("leaves the tracking record out: the Mailbox does not switch tracking on", () => {
    expect(requiredRecords(row.records)).toHaveLength(3);
    const text = dnsInstructions(row).steps.join("\n");
    expect(text).not.toContain("links1.resend-dns.com");
    expect(text).toContain("1. MX record at send.updates.client.co.za (in the client.co.za zone: send.updates), priority 10: feedback-smtp.eu-west-1.amazonses.com");
    expect(text).toContain("3. TXT record at resend._domainkey.updates.client.co.za (in the client.co.za zone: resend._domainkey.updates): p=MIGf");
  });

  it("suggests DMARC only when the domain has none, and names a mailbox that reads the reports", () => {
    expect(dnsInstructions(row, { report: { dmarc: { state: "monitor" } as never } }).dmarc).toBeNull();
    const need = dnsInstructions(row, { report: { dmarc: { state: "missing" } as never }, reportsMailbox: "peet@partnersinbiz.online" });
    expect(need.dmarc!.value).toBe("v=DMARC1; p=none; rua=mailto:peet@partnersinbiz.online");
    expect(need.steps.filter((s) => /^\d\./.test(s))).toHaveLength(4);
    expect(dnsInstructions({ ...row, records: [] }).steps).toEqual(["The provider has not listed any records yet; check the domain again in a minute."]);
  });
});

describe("the view", () => {
  it("shows today's cap, what is left, the warm-up day and the 7-day record; a verified domain needs no records", async () => {
    const t = setupWithClient();
    await addEspDomain(t, { firstSent: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastSent: new Date().toISOString() });
    const today = new Date().toISOString().slice(0, 10);
    t.store.espDays.set(`${CO}:${DOMAIN}:${today}`, { company_id: CO, domain: DOMAIN, day: today, sent: 120, delivered: 100, hard_bounces: 1, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 });
    const row = (await t.store.getEspDomain(CO, DOMAIN))!;
    const account = await t.store.getAccount(CO, row.account_id!);
    const view = await sendingDomainView(t.env, { steadyDailyCap: 10_000 }, row, account);
    expect(view).toMatchObject({ ready: true, dns: null, cap: { cap: 400, day: 4, warming: true, source: "warm-up", sentToday: 120, remaining: 280 }, reputation: { sent: 120, hardBounces: 1, problems: [] } });
    forgetEspRuntime();
  });
});
