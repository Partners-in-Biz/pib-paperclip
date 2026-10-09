/**
 * The email provider on a real Postgres with all nine migrations, through the real worker: the SQL (the daily cap taken in one
 * statement, the unique indexes that make a delivery count once, the upserts that never touch a domain's history) and the owner's
 * journey from nothing to mail going out as a client's own domain. The provider's API is the in-memory Resend of
 * `fake-resend.ts` behind the host's `ctx.http.fetch`, and public DNS is a records table behind the same fetch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { HANDOFF_EVENTS, MAIL_EVENTS, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { resetEnsureMemo } from "../../src/delegations.js";
import { SqlStore } from "../../src/db.js";
import { DOMAIN_HEALTH_EVENT } from "../../src/domain-health.js";
import { ESP_DELIVERY_EVENT } from "../../src/esp/events.js";
import { forgetLimiters } from "../../src/esp/limiter.js";
import { forgetEspRuntime } from "../../src/esp/runtime.js";
import { forgetWebhookCandidates } from "../../src/esp/webhook.js";
import manifest from "../../src/manifest.js";
import { NAMESPACE } from "../../src/namespace.js";
import { setupStatus } from "../../src/setup-status.js";
import plugin from "../../src/worker.js";
import { dohFetchFrom } from "../helpers/dns.js";
import { API_KEY, CLIENT, DOMAIN, dnsVerified, ESP_ON, eventBody, FROM, marketing, svixHeaders, WEBHOOK_SECRET } from "../helpers/esp.js";
import { FakeResend } from "../helpers/fake-resend.js";
import { CO } from "../helpers/memory.js";
import { embeddedAvailable, startPg, type PgHarness } from "../helpers/pg.js";

const available = await embeddedAvailable();
const today = () => new Date().toISOString().slice(0, 10);
const CAMPAIGN_SEND = `plugin.${PIB_PLUGINS.campaigns}.${MAIL_EVENTS.sendRequested}` as const;

describe.skipIf(!available)("the email provider on a real Postgres", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await startPg();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    forgetEspRuntime();
    forgetLimiters();
    forgetWebhookCandidates();
    resetEnsureMemo();
  });

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.client.query(text, params)).rows as T[];

  /** The worker booted on the real database, the fake provider and a DNS table behind `ctx.http.fetch`. */
  async function boot(config: Record<string, unknown> = ESP_ON) {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20), ...config } });
    const resend = new FakeResend();
    const dns: { records: Record<string, string[]> } = { records: {} };
    (harness.ctx as unknown as { db: unknown }).db = pg.db;
    (harness.ctx as unknown as { http: unknown }).http = {
      async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
        const host = new URL(url).host;
        if (host === "api.resend.com") return resend.handle(url, init);
        if (host === "dns.google" || host === "cloudflare-dns.com") return dohFetchFrom(dns.records).fetch(url);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
      },
    };
    await plugin.definition.setup(harness.ctx);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    const events = (name: string) => emit.mock.calls.filter(([n]) => n === name).map(([, , payload]) => payload as Record<string, unknown>);
    const store = new SqlStore(pg.db);
    return { harness, resend, dns, emit, events, store };
  }

  type Booted = Awaited<ReturnType<typeof boot>>;
  const am = { agentId: "agent-am", companyId: CO };

  async function addClient() {
    await sql(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, domain, lifecycle, updated_at) VALUES ($1, $2, 'Client Co', 'client.co.za', 'customer', now())`, [CLIENT.ref, CO]);
  }

  /** A verified provider domain for the client, the way the journey leaves it. */
  async function verifiedDomain(b: Booted, input: Record<string, unknown> = {}) {
    await addClient();
    const added = await b.harness.executeTool<{ error?: string; data?: { dns: { records: unknown[] } } }>("add-sending-domain", { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref, replyTo: "team@client.co.za", ...input }, am);
    expect(added.error).toBeUndefined();
    b.resend.dnsAdded = true;
    b.dns.records = dnsVerified();
    await b.harness.executeTool("list-sending-domains", { refresh: true }, am);
    return added;
  }

  const send = (b: Booted, overrides: Record<string, unknown> = {}) => b.harness.emit(CAMPAIGN_SEND, { ...marketing(), ...overrides }, { companyId: CO });
  const results = (b: Booted) => b.events(MAIL_EVENTS.sendResult);
  const deliver = (b: Booted, body: string, id = `msg_${Math.random().toString(36).slice(2)}`) =>
    plugin.definition.onWebhook!({ endpointKey: "resend", headers: svixHeaders(body, { id }), rawBody: body, parsedBody: JSON.parse(body), requestId: id });

  it("the owner's journey: nothing set up, the owner's steps, a client's domain with its records, DNS added, verified, mail goes out as the client", async () => {
    // 1. The provider is off: the agent is told exactly what the owner must do, and nothing is created.
    const off = await boot({ esp: { enabled: false } });
    await addClient();
    const refused = await off.harness.executeTool<{ error?: string }>("add-sending-domain", { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref }, am);
    expect(refused.error).toMatch(/The email provider is not ready.*An agent cannot create the Resend account/);
    expect(refused.error).toContain("https://resend.com/api-keys");
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_domains`)).toHaveLength(0);
    expect(off.resend.requests).toEqual([]);

    // 2. Switched on: the domain is registered at the provider, with the records for the owner or the client.
    forgetEspRuntime();
    const b = await boot();
    const added = await b.harness.executeTool<{ data?: Record<string, any> }>("add-sending-domain", { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref, replyTo: "team@client.co.za", fromName: "Client Co" }, am);
    const data = added.data!;
    expect(data).toMatchObject({ created: true, domain: DOMAIN, status: "not_started", ready: false, client: { kind: "company", ref: CLIENT.ref } });
    expect(data.dns.records.map((r: { type: string; host: string }) => `${r.type} ${r.host}`)).toEqual([`MX send.${DOMAIN}`, `TXT send.${DOMAIN}`, `TXT resend._domainkey.${DOMAIN}`]);
    expect(data.dns.whoAddsIt).toMatch(/An agent cannot edit DNS/);
    const [domainRow] = await sql<{ status: string; client_ref: string; return_path_host: string; account_id: string }>(`SELECT status, client_ref, return_path_host, account_id FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]);
    expect(domainRow).toMatchObject({ status: "not_started", client_ref: CLIENT.ref, return_path_host: `send.${DOMAIN}` });
    const [account] = await sql<{ provider: string; status: string; address: string; reply_to: string; token_sealed: string | null; client_ref: string }>(`SELECT provider, status, address, reply_to, token_sealed, client_ref FROM ${NAMESPACE}.accounts WHERE id = $1`, [domainRow!.account_id]);
    expect(account).toMatchObject({ provider: "resend", status: "pending", address: FROM, reply_to: "team@client.co.za", token_sealed: null, client_ref: CLIENT.ref });
    // The DNS was read at once and is watched daily: the missing records are the problem.
    const [check] = await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]);
    expect(check!.status).toBe("bad");

    // 3. Before the DNS is in, a send for the client fails for good and says why: it does not go out as the company.
    await send(b);
    expect(results(b).at(-1)).toMatchObject({ status: "failed", permanent: true });
    expect(String(results(b).at(-1)!.error)).toMatch(/not verified at the email provider yet/);
    expect(b.resend.emails).toHaveLength(0);

    // 4. The owner (or the client) adds the records. The hourly job sees the provider verify the domain, brings the account up
    //    and checks the DNS from outside.
    b.resend.dnsAdded = true;
    b.dns.records = dnsVerified();
    await b.harness.runJob("setup-status");
    const [after] = await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.accounts WHERE id = $1`, [domainRow!.account_id]);
    expect(after!.status).toBe("connected");
    expect((await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.status).toBe("verified");
    expect((await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]))[0]!.status).toBe("healthy");
    expect(b.events(DOMAIN_HEALTH_EVENT).at(-1)).toMatchObject({ domain: DOMAIN, status: "healthy", healthy: true, sendReady: true, provider: "resend", clientKind: "company", clientRef: CLIENT.ref });

    // 5. Now the client's campaign goes out as the client's own domain, and the answer is the usual mail.send.result.
    await send(b, { key: "campaigns:step:e2:1" });
    expect(b.resend.emails).toHaveLength(1);
    expect(b.resend.emails[0]!.body).toMatchObject({ from: `"Client Co" <${FROM}>`, to: ["ann@x.co"], reply_to: "team@client.co.za", headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    expect(b.resend.emails[0]!.idempotencyKey).toMatch(/^pib-/);
    expect(results(b).at(-1)).toMatchObject({ key: "campaigns:step:e2:1", status: "sent", provider: "resend", messageId: `resend:${b.resend.emails[0]!.id}` });
    const [row] = await sql<{ status: string; provider: string; provider_message_id: string; from_address: string }>(`SELECT status, provider, provider_message_id, from_address FROM ${NAMESPACE}.send_requests WHERE key = $1`, ["campaigns:step:e2:1"]);
    expect(row).toMatchObject({ status: "sent", provider: "resend", provider_message_id: b.resend.emails[0]!.id, from_address: FROM });
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`)).toHaveLength(0);

    // 6. The Setup items follow along.
    const status = await setupStatus(b.harness.ctx, CO, b.store, Date.now());
    const item = (key: string) => status.items.find((entry) => entry.key === key)!;
    expect(item("esp_account")).toMatchObject({ status: "done", required: false });
    expect(item("esp_webhook")).toMatchObject({ status: "done" });
    expect(item("esp_domain")).toMatchObject({ status: "done" });
    expect(item("esp_domain").detail).toContain(DOMAIN);
  });

  it("the provider's events change the do-not-email list in the database, once, and a replay or a concurrent duplicate counts once", async () => {
    const b = await boot();
    await verifiedDomain(b);
    await send(b);
    const id = b.resend.emails[0]!.id;
    const bounce = eventBody("email.bounced", { email_id: id, bounce: { type: "Permanent", subType: "General", message: "no such user" } });
    // Two copies of the same delivery arrive at the same time, then it is replayed.
    await Promise.all([deliver(b, bounce, "msg_a"), deliver(b, bounce, "msg_a")]).catch(() => undefined);
    await deliver(b, bounce, "msg_a");
    // The same bounce under another delivery id.
    await deliver(b, bounce, "msg_b");
    const [day] = await sql<{ hard_bounces: number; sent: number }>(`SELECT hard_bounces, sent FROM ${NAMESPACE}.esp_domain_days WHERE domain = $1 AND day = $2`, [DOMAIN, today()]);
    expect(day).toMatchObject({ hard_bounces: 1, sent: 1 });
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_events WHERE event_type = 'email.bounced'`)).toHaveLength(1);
    const rows = await sql<{ scope: string; reason: string; sender_key: string }>(`SELECT scope, reason, sender_key FROM ${NAMESPACE}.suppressions WHERE email = 'ann@x.co'`);
    expect(rows).toEqual([{ scope: "all", reason: "bounced", sender_key: "" }]);
    expect(b.events(HANDOFF_EVENTS.contactSuppressed)).toHaveLength(1);
    expect(b.events(ESP_DELIVERY_EVENT)).toHaveLength(1);
    expect((await sql<{ delivery_status: string }>(`SELECT delivery_status FROM ${NAMESPACE}.send_requests WHERE key = $1`, ["campaigns:step:e1:1"]))[0]!.delivery_status).toBe("bounced");
    // The address is now refused for everyone, with the list in the answer.
    await send(b, { key: "campaigns:step:e1:2" });
    expect(results(b).at(-1)).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@x.co", scope: "all", reason: "bounced" }] });
  });

  it("a complaint goes on the client's own marketing list, not the company's, and withdraws consent", async () => {
    const b = await boot();
    await verifiedDomain(b);
    await send(b);
    await deliver(b, eventBody("email.complained", { email_id: b.resend.emails[0]!.id }));
    const rows = await sql<{ sender_key: string; scope: string; reason: string }>(`SELECT sender_key, scope, reason FROM ${NAMESPACE}.suppressions WHERE email = 'ann@x.co'`);
    expect(rows).toEqual([{ sender_key: `company:${CLIENT.ref}`, scope: "marketing", reason: "complained" }]);
    expect(b.events(HANDOFF_EVENTS.consentRecorded)).toEqual([expect.objectContaining({ granted: false, source: "api" })]);
  });

  it("soft bounces back off in the database: 6, 24, then 72 hours, and the third suppresses marketing", async () => {
    const b = await boot();
    await verifiedDomain(b);
    await send(b);
    const id = b.resend.emails[0]!.id;
    const hours = async () => {
      const [h] = await sql<{ soft_bounces: number; hrs: number }>(`SELECT soft_bounces, extract(epoch FROM (backoff_until - now())) / 3600 AS hrs FROM ${NAMESPACE}.esp_recipient_health WHERE email = 'ann@x.co'`);
      return { count: h!.soft_bounces, hours: Math.round(Number(h!.hrs)) };
    };
    const soft = (n: number) => eventBody("email.bounced", { email_id: n === 1 ? id : `${id}-${n}`, bounce: { type: "Transient", subType: "MailboxFull", message: "full" } });
    await deliver(b, soft(1), "s1");
    expect(await hours()).toEqual({ count: 1, hours: 6 });
    await deliver(b, soft(2), "s2");
    expect(await hours()).toEqual({ count: 2, hours: 24 });
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.suppressions`)).toHaveLength(0);
    await deliver(b, soft(3), "s3");
    expect(await hours()).toEqual({ count: 3, hours: 72 });
    expect(await sql<{ scope: string; sender_key: string }>(`SELECT scope, sender_key FROM ${NAMESPACE}.suppressions`)).toEqual([{ scope: "marketing", sender_key: `company:${CLIENT.ref}` }]);
    // A delivery to the address clears it.
    await deliver(b, eventBody("email.delivered", { email_id: id }), "d1");
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_recipient_health`)).toHaveLength(0);
  });

  it("the daily cap is taken in one statement: sends that arrive together cannot pass it between them", async () => {
    const b = await boot();
    await verifiedDomain(b);
    const people = (n: number, from: number) => Array.from({ length: n }, (_v, i) => ({ email: `p${from + i}@x.co` }));
    // Day one is 50 recipients. Five sends of 20 arrive at the same moment: two fit (40), the other three do not.
    await Promise.all([0, 1, 2, 3, 4].map((i) => send(b, { key: `campaigns:step:burst:${i}`, to: people(20, i * 20) })));
    const sent = results(b).filter((r) => r.status === "sent");
    expect(sent).toHaveLength(2);
    expect(b.resend.emails).toHaveLength(2);
    const [day] = await sql<{ sent: number }>(`SELECT sent FROM ${NAMESPACE}.esp_domain_days WHERE domain = $1 AND day = $2`, [DOMAIN, today()]);
    expect(day!.sent).toBe(40);
    // The three that did not fit were deferred, not failed: nothing stored, the sender asks again.
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.send_requests WHERE status = 'failed'`)).toHaveLength(0);
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.send_requests`)).toHaveLength(2);
    // 10 more fit exactly; one more does not.
    await send(b, { key: "campaigns:step:fit", to: people(10, 100) });
    expect(results(b).filter((r) => r.status === "sent")).toHaveLength(3);
    await send(b, { key: "campaigns:step:over", to: people(1, 200) });
    expect(results(b).filter((r) => r.status === "sent")).toHaveLength(3);
  });

  it("hard bounces over the limit hold the domain's marketing back in the database, announce it, and the next send is refused", async () => {
    const b = await boot();
    await verifiedDomain(b);
    // 40 recipients go out (day one allows 50). Under 100 recipients a rate is not judged (one bounce of 40 would be 2.5%, and a client's
    // marketing is not held for a week over one address), so the absolute floor decides: three hard bounces.
    await send(b, { key: "campaigns:step:first", to: Array.from({ length: 40 }, (_v, i) => ({ email: `r${i}@x.co` })) });
    const id = b.resend.emails[0]!.id;
    const status = async () => (await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]))[0]!.status;
    expect(await status()).toBe("healthy");
    const before = b.events(DOMAIN_HEALTH_EVENT).length;
    const bounce = (who: string, delivery: string) => deliver(b, eventBody("email.bounced", { email_id: id, to: [who], bounce: { type: "Permanent", subType: "General", message: "x" } }), delivery);
    await bounce("r0@x.co", "b1");
    await bounce("r1@x.co", "b2");
    expect(await status()).toBe("healthy");
    expect(b.events(DOMAIN_HEALTH_EVENT)).toHaveLength(before);
    await bounce("r2@x.co", "b3");
    const [check] = await sql<{ status: string; result: { problems: Array<{ code: string; blocks?: string }> } }>(`SELECT status, result FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]);
    expect(check!.status).toBe("bad");
    expect(check!.result.problems).toEqual([expect.objectContaining({ code: "esp_bounce_rate", blocks: "marketing" })]);
    expect(b.events(DOMAIN_HEALTH_EVENT)).toHaveLength(before + 1);
    expect(b.events(DOMAIN_HEALTH_EVENT).at(-1)).toMatchObject({ domain: DOMAIN, status: "bad", healthy: false });
    const [rep] = await sql<{ reputation: { sent: number; hardBounces: number; problems: Array<{ code: string }> } }>(`SELECT reputation FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]);
    expect(rep!.reputation).toMatchObject({ sent: 40, hardBounces: 3 });
    expect(rep!.reputation.problems.map((p) => p.code)).toEqual(["esp_bounce_rate"]);
    // The client's next campaign is refused for good, with the reason; nothing more leaves.
    await send(b, { key: "campaigns:step:next", to: [{ email: "new@x.co" }] });
    expect(results(b).at(-1)).toMatchObject({ key: "campaigns:step:next", status: "failed", permanent: true });
    expect(String(results(b).at(-1)!.error)).toMatch(/3 of 40 recipients hard bounced/);
    expect(b.resend.emails).toHaveLength(1);
    // The daily job re-judges the same 7 days and keeps it (the check comes back from the DNS with the problem merged in).
    await b.harness.runJob("check-domain-health");
    const [daily] = await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]);
    expect(daily!.status).toBe("bad");
  });

  it("no secret is ever stored, emitted or logged: not the API key, not the webhook signing secret, through the whole journey", async () => {
    const b = await boot();
    await verifiedDomain(b);
    await send(b);
    const id = b.resend.emails[0]!.id;
    await deliver(b, eventBody("email.bounced", { email_id: id, bounce: { type: "Permanent", subType: "General", message: "no such user" } }), "m1");
    await deliver(b, eventBody("email.complained", { email_id: `${id}-x` }), "m2").catch(() => undefined);
    // A refused key and a failed webhook put provider text into state and logs: none of it may carry a secret.
    b.resend.errors.push({ status: 401, body: { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails." } });
    await send(b, { key: "campaigns:step:refused", to: [{ email: "z@x.co" }] });
    await b.harness.runJob("setup-status");
    await b.harness.runJob("check-domain-health");
    const tables = (await sql<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = '${NAMESPACE}'`)).map((row) => row.tablename);
    let everything = "";
    for (const table of tables) everything += (await sql<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM ${NAMESPACE}.${table} t`)).map((row) => row.j).join("\n");
    const state = JSON.stringify(await b.harness.ctx.state.get({ scopeKind: "company", scopeId: CO, namespace: "mailbox-esp", stateKey: "provider-state" }));
    const emitted = JSON.stringify(b.emit.mock.calls);
    const logs = JSON.stringify(b.harness.logs);
    const secretKey = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64").toString();
    for (const [where, text] of [["tables", everything], ["state", state], ["events", emitted], ["logs", logs]] as const) {
      for (const secret of [API_KEY, WEBHOOK_SECRET, WEBHOOK_SECRET.slice("whsec_".length), secretKey]) expect(text.includes(secret), `${where} holds a secret`).toBe(false);
    }
    // The provider's state did record the refusal (so the Cockpit can say it), without the key.
    expect(state).toMatch(/key_refused/);
  });

  it("the webhook route refuses what is not signed with the company's secret, and the actions that change a domain's limits are for people", async () => {
    const b = await boot();
    await verifiedDomain(b);
    await send(b);
    const id = b.resend.emails[0]!.id;
    const body = eventBody("email.bounced", { email_id: id, bounce: { type: "Permanent", subType: "General", message: "x" } });
    const other = ["whsec", Buffer.from("fedcba9876543210fedcba9876543210").toString("base64")].join("_");
    // Signed with another secret, or not signed at all: the host answers with an error and nothing changes.
    await expect(plugin.definition.onWebhook!({ endpointKey: "resend", headers: svixHeaders(body, { secret: other }), rawBody: body, parsedBody: JSON.parse(body), requestId: "r1" })).rejects.toMatchObject({ message: "The delivery could not be verified", code: "bad_signature" });
    await expect(plugin.definition.onWebhook!({ endpointKey: "resend", headers: {}, rawBody: body, parsedBody: JSON.parse(body), requestId: "r2" })).rejects.toMatchObject({ message: "The delivery could not be verified", code: "missing" });
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.suppressions`)).toHaveLength(0);
    expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_events`)).toHaveLength(0);
    // The unsubscribe webhook still answers with nothing, as before.
    await expect(plugin.definition.onWebhook!({ endpointKey: "unsubscribe", headers: {}, rawBody: "", parsedBody: {}, requestId: "r3" })).resolves.toBeUndefined();

    // A person decides that a domain is established or gives it a cap of its own; an agent cannot lift its own limit.
    await expect(b.harness.performAction("mailbox.set-sending-domain", { domain: DOMAIN, warmupExempt: true }, { companyId: CO, actor: { type: "agent", agentId: "agent-am" } } as never)).rejects.toThrow(/board users/);
    const done = await b.harness.performAction<{ domains: Array<{ cap: { cap: number; source: string } }> }>("mailbox.set-sending-domain", { domain: DOMAIN, warmupExempt: true }, { companyId: CO, actor: { type: "user", userId: "user-1" } });
    expect(done.domains[0]!.cap).toMatchObject({ cap: 10_000, source: "established" });
    const capped = await b.harness.performAction<{ domains: Array<{ cap: { cap: number; source: string } }> }>("mailbox.set-sending-domain", { domain: DOMAIN, dailyCap: 300 }, { companyId: CO, actor: { type: "user", userId: "user-1" } });
    expect(capped.domains[0]!.cap).toMatchObject({ cap: 300, source: "override" });
    await expect(b.harness.performAction("mailbox.set-sending-domain", { domain: DOMAIN, dailyCap: -2 }, { companyId: CO, actor: { type: "user", userId: "user-1" } })).rejects.toThrow(/dailyCap must be/);
    await expect(b.harness.performAction("mailbox.set-sending-domain", { domain: "nope.co.za", dailyCap: 5 }, { companyId: CO, actor: { type: "user", userId: "user-1" } })).rejects.toThrow(/not a sending domain/);
    // A send-only account is made by adding its domain, never by hand.
    await expect(b.harness.performAction("mailbox.create-account", { provider: "resend", address: "x@y.co" }, { companyId: CO, actor: { type: "user", userId: "user-1" } })).rejects.toThrow(/created by adding its sending domain/);
  });

  describe("a person lifts a reputation hold", () => {
    const person = { companyId: CO, actor: { type: "user", userId: "user-owner" } } as never;
    const lift = (b: Booted, params: Record<string, unknown> = {}, actor: unknown = person) => b.harness.performAction<Record<string, any>>("mailbox.clear-reputation-hold", { domain: DOMAIN, reason: "Cleaned the 14 dead addresses out of the list", ...params }, actor as never);

    /** A client's domain held for marketing: 40 recipients went out and three of them hard bounced (the floor under 100 recipients). */
    async function held(b: Booted) {
      await verifiedDomain(b);
      await send(b, { key: "campaigns:step:first", to: Array.from({ length: 40 }, (_v, i) => ({ email: `r${i}@x.co` })) });
      const id = b.resend.emails[0]!.id;
      const bounce = (who: string, delivery: string) => deliver(b, eventBody("email.bounced", { email_id: id, to: [who], bounce: { type: "Permanent", subType: "General", message: "x" } }), delivery);
      for (const [n, who] of ["r0@x.co", "r1@x.co", "r2@x.co"].entries()) await bounce(who, `b${n}`);
      await send(b, { key: "campaigns:step:blocked", to: [{ email: "new@x.co" }] });
      expect(results(b).at(-1)).toMatchObject({ key: "campaigns:step:blocked", status: "failed", permanent: true });
      return { id, bounce };
    }
    const status = async () => (await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.domain_checks WHERE domain = $1`, [DOMAIN]))[0]!.status;

    it("lifts the hold at once, on record, and a new bounce after it counts again", async () => {
      const b = await boot();
      const { bounce } = await held(b);
      expect(await status()).toBe("bad");
      const before = b.events(DOMAIN_HEALTH_EVENT).length;

      // The person is the host's actor: a `userId`, `by` or `actor` in the request changes nothing.
      const out = await lift(b, { userId: "user-someone-else", by: "user-evil", actor: "user-evil" });
      expect(out).toMatchObject({ domain: DOMAIN, lifted: true, by: "user:user-owner", day: today() });
      expect(out.was[0]).toMatch(/3 of 40 recipients hard bounced/);
      expect(out.note).toMatch(/can hold it again/);
      // What the page reads: no problem left, and who lifted it and from which day.
      expect(out.overview.domains[0]).toMatchObject({ reputation: { problems: [], hardBounces: 0, clearedDay: today() }, holdLifted: { by: "user:user-owner", day: today() } });

      // The database: the clearance with its baseline, one audit row naming the host's user, the check healthy again and announced.
      const [row] = await sql<{ reputation_cleared_by: string; reputation_cleared_day: string; reputation_cleared_baseline: Record<string, number> }>(`SELECT reputation_cleared_by, reputation_cleared_day, reputation_cleared_baseline FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]);
      expect(row).toMatchObject({ reputation_cleared_by: "user:user-owner", reputation_cleared_day: today(), reputation_cleared_baseline: { sent: 40, hard_bounces: 3, complaints: 0 } });
      const audit = await sql<{ action: string; actor: string; detail: Record<string, any> }>(`SELECT action, actor, detail FROM ${NAMESPACE}.esp_domain_audit WHERE domain = $1`, [DOMAIN]);
      expect(audit).toEqual([expect.objectContaining({ action: "clear_reputation_hold", actor: "user:user-owner" })]);
      expect(audit[0]!.detail).toMatchObject({ reason: "Cleaned the 14 dead addresses out of the list", problems: [expect.objectContaining({ code: "esp_bounce_rate" })], window: { sent: 40, hardBounces: 3 }, countedFrom: today() });
      expect(JSON.stringify(audit)).not.toContain("user-evil");
      expect(await status()).toBe("healthy");
      expect(b.events(DOMAIN_HEALTH_EVENT)).toHaveLength(before + 1);
      expect(b.events(DOMAIN_HEALTH_EVENT).at(-1)).toMatchObject({ domain: DOMAIN, status: "healthy", healthy: true });

      // Marketing goes out again. It is a different message to a different address, so the earlier refusal is not replayed.
      await send(b, { key: "campaigns:step:after", to: [{ email: "new@x.co" }] });
      expect(results(b).at(-1)).toMatchObject({ key: "campaigns:step:after", status: "sent", provider: "resend" });

      // It lifts, it does not forget: two more hard bounces are under the floor of three counted from now, the third holds the domain again.
      await b.harness.executeTool("sender-domain-health", {}, am);
      const id2 = b.resend.emails.at(-1)!.id;
      for (const [n, who] of ["n0@x.co", "n1@x.co"].entries()) await deliver(b, eventBody("email.bounced", { email_id: id2, to: [who], bounce: { type: "Permanent", subType: "General", message: "x" } }), `c${n}`);
      expect(await status()).toBe("healthy");
      await deliver(b, eventBody("email.bounced", { email_id: id2, to: ["n2@x.co"], bounce: { type: "Permanent", subType: "General", message: "x" } }), "c2");
      expect(await status()).toBe("bad");
      await send(b, { key: "campaigns:step:again", to: [{ email: "later@x.co" }] });
      expect(results(b).at(-1)).toMatchObject({ key: "campaigns:step:again", status: "failed", permanent: true });
      const stored = (await sql<{ reputation: { hardBounces: number; clearedDay: string } }>(`SELECT reputation FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.reputation;
      expect(stored).toMatchObject({ hardBounces: 3, clearedDay: today() });
      // The daily job keeps the lifted state (it judges through the same clearance).
      await b.harness.runJob("check-domain-health");
      expect(await status()).toBe("bad");
      expect((await sql<{ reputation: { hardBounces: number } }>(`SELECT reputation FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.reputation.hardBounces).toBe(3);
    });

    it("is for a signed-in person only: an agent, or an actor with no user, changes nothing and leaves no record", async () => {
      const b = await boot();
      await held(b);
      for (const actor of [{ type: "agent", agentId: "agent-am" }, { type: "user" }, { type: "agent", agentId: "agent-am", userId: "user-owner" }]) {
        await expect(lift(b, {}, { companyId: CO, actor }), JSON.stringify(actor)).rejects.toThrow(/board users/);
      }
      expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_domain_audit`)).toHaveLength(0);
      expect((await sql<{ reputation_cleared_at: string | null }>(`SELECT reputation_cleared_at FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.reputation_cleared_at).toBeNull();
      expect(await status()).toBe("bad");
      // No tool can do it either: the agent's way is to tell the owner.
      const names = (await import("../../src/tools.js")).MAILBOX_TOOLS.map((tool) => tool.name);
      expect(names.some((name) => /hold|reputation/i.test(name))).toBe(false);
      const text = JSON.stringify((await import("../../src/tools.js")).MAILBOX_TOOLS);
      expect(text).not.toMatch(/clear-reputation-hold|lift the hold/i);
    });

    it("refuses without a reason, for a domain that is not held, and for a domain it does not know", async () => {
      const b = await boot();
      await verifiedDomain(b);
      await expect(lift(b)).rejects.toThrow(/Nothing to lift: updates\.client\.co\.za has no reputation hold/);
      await expect(lift(b, { domain: "nope.co.za" })).rejects.toThrow(/not a sending domain/);
      await expect(lift(b, { reason: "ok" })).rejects.toThrow(/Say why the hold may be lifted/);
      await expect(lift(b, { reason: "" })).rejects.toThrow(/reason is required/);
      expect(await sql(`SELECT 1 FROM ${NAMESPACE}.esp_domain_audit`)).toHaveLength(0);
    });

    it("an audit row that cannot be written means no lifted hold: the clearance is taken back", async () => {
      const b = await boot();
      await held(b);
      await sql(`ALTER TABLE ${NAMESPACE}.esp_domain_audit ADD CONSTRAINT esp_domain_audit_broken CHECK (action = 'never')`);
      await expect(lift(b)).rejects.toThrow(/The hold was not lifted: its audit record could not be written/);
      await sql(`ALTER TABLE ${NAMESPACE}.esp_domain_audit DROP CONSTRAINT esp_domain_audit_broken`);
      expect((await sql<{ reputation_cleared_at: string | null; reputation_cleared_day: string | null }>(`SELECT reputation_cleared_at, reputation_cleared_day FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]).toEqual({ reputation_cleared_at: null, reputation_cleared_day: null });
      expect(await status()).toBe("bad");
      // And it works once the record can be written.
      expect(await lift(b)).toMatchObject({ lifted: true });
    });

    it("shows where the hold is reported: the Setup item while held, the domain's card with what was lifted after, and the daily and limit changes are on record too", async () => {
      const b = await boot();
      await held(b);
      const items = async () => (await setupStatus(b.harness.ctx, CO, b.store, Date.now())).items;
      const hold = (await items()).find((item) => item.key === "esp_hold")!;
      expect(hold).toMatchObject({ status: "missing", required: false, href: "/mailbox?tab=mailboxes" });
      expect(hold.title).toContain(DOMAIN);
      expect(hold.detail).toMatch(/Only a person can, with a reason, and it is recorded: an agent cannot/);
      expect(hold.steps!.join(" ")).toMatch(/Lift the hold/);
      const shown = await b.harness.performAction<{ domains: Array<Record<string, any>> }>("mailbox.sending-domains", {}, person);
      expect(shown.domains[0]!.reputation.problems[0].message).toMatch(/3 of 40/);
      expect(shown.domains[0]!.reputation.problems[0].fix).toMatch(/a person can lift the hold/);
      expect(shown.domains[0]!.holdLifted).toBeNull();

      await lift(b);
      expect((await items()).find((item) => item.key === "esp_hold")).toBeUndefined();
      // A person's change of the limits is on record as well (who, and what it was).
      await b.harness.performAction("mailbox.set-sending-domain", { domain: DOMAIN, dailyCap: 300 }, person);
      const audit = await sql<{ action: string; actor: string; detail: Record<string, any> }>(`SELECT action, actor, detail FROM ${NAMESPACE}.esp_domain_audit WHERE domain = $1 ORDER BY created_at`, [DOMAIN]);
      expect(audit.map((row) => row.action)).toEqual(["clear_reputation_hold", "set_limits"]);
      expect(audit[1]).toMatchObject({ actor: "user:user-owner", detail: { dailyCap: 300, was: { dailyCap: null } } });
    });
  });

  it("check-sender-domain asks the provider and judges a provider domain on its records; list-mailboxes and mail-status tell an agent what it is", async () => {
    const b = await boot();
    await addClient();
    await b.harness.executeTool("add-sending-domain", { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref, replyTo: "team@client.co.za" }, am);
    // Before the DNS: the check says which records are missing, with the provider's status.
    const early = await b.harness.executeTool<{ data?: Record<string, any> }>("check-sender-domain", { domain: DOMAIN }, am);
    expect(early.data).toMatchObject({ domain: DOMAIN, status: "bad", provider: { status: "pending" } });
    expect(early.data!.onboarding.steps[0]).toMatch(/^At the DNS host for client\.co\.za, add these/);
    expect(early.data!.onboarding.whoAddsIt).toMatch(/An agent cannot edit DNS/);
    expect(early.data!.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(["esp_spf_missing", "esp_dkim_missing", "esp_waiting_for_dns"]));
    // After: the same call finds the domain verified and healthy, and nothing is left to add.
    b.resend.dnsAdded = true;
    b.dns.records = dnsVerified();
    const late = await b.harness.executeTool<{ data?: Record<string, any> }>("check-sender-domain", { domain: DOMAIN }, am);
    expect(late.data).toMatchObject({ status: "healthy", healthy: true, sendReady: true, provider: { status: "verified" } });
    expect(late.data!.onboarding.steps).toEqual(["Nothing to add: the provider has verified every record."]);

    await sql(`INSERT INTO ${NAMESPACE}.delegations (id, company_id, account_id, agent_id, can_read, can_draft, can_send) SELECT 'dl1', $1, id, 'agent-am', true, true, true FROM ${NAMESPACE}.accounts WHERE provider = 'resend'`, [CO]);
    const boxes = await b.harness.executeTool<{ data?: { accounts: Array<Record<string, any>> } }>("list-mailboxes", {}, am);
    const mailbox = boxes.data!.accounts[0]!;
    expect(mailbox).toMatchObject({ address: FROM, kind: "email-provider", status: "connected", replyTo: "team@client.co.za", problem: null, client: { kind: "company", ref: CLIENT.ref }, maySend: true, askToOwner: null, domainHealth: { healthy: true } });

    await send(b);
    const status = await b.harness.executeTool<{ data?: Record<string, any> }>("mail-status", { key: "campaigns:step:e1:1" }, am);
    expect(status.data).toMatchObject({ status: "sent", provider: "resend", providerMessageId: b.resend.emails[0]!.id, deliveryStatus: null, from: FROM });
    await deliver(b, eventBody("email.delivered", { email_id: b.resend.emails[0]!.id }));
    const after = await b.harness.executeTool<{ data?: Record<string, any> }>("mail-status", { key: "campaigns:step:e1:1" }, am);
    expect(after.data).toMatchObject({ deliveryStatus: "delivered", delivery: { delivered_at: expect.any(String) } });
  });

  it("giving a provider account to a client binds its domain too, and a provider account is never offered as the company's only Gmail mailbox", async () => {
    const b = await boot();
    await addClient();
    await b.harness.executeTool("add-sending-domain", { domain: DOMAIN }, am);
    const [account] = await sql<{ id: string }>(`SELECT id FROM ${NAMESPACE}.accounts WHERE provider = 'resend'`);
    // No Gmail mailbox exists, yet the company's own provider account can be given to a client (the "only Gmail mailbox" rule is for Gmail).
    const done = await b.harness.performAction<{ client: { ref: string } }>("mailbox.set-account-client", { accountId: account!.id, clientKind: "company", clientRef: CLIENT.ref }, { companyId: CO, actor: { type: "user", userId: "user-1" } });
    expect(done.client.ref).toBe(CLIENT.ref);
    expect((await sql<{ client_ref: string }>(`SELECT client_ref FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.client_ref).toBe(CLIENT.ref);
    await b.harness.performAction("mailbox.set-account-client", { accountId: account!.id }, { companyId: CO, actor: { type: "user", userId: "user-1" } });
    expect((await sql<{ client_ref: string | null }>(`SELECT client_ref FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]!.client_ref).toBeNull();
  });

  it("the migration is applied on top of the earlier ones, leaves their rows alone, and the old Gmail rows still read", async () => {
    // A Gmail account and a send written the way 0.5.0 wrote them (no provider columns) still read through the 0.6.0 store.
    await sql(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, provider, address, status, token_sealed, is_default) VALUES ('g1', $1, 'gmail', 'peet@partnersinbiz.online', 'connected', 'v1.x', true)`, [CO]);
    await sql(`INSERT INTO ${NAMESPACE}.send_requests (key, company_id, source_plugin, status, request) VALUES ('old:1', $1, 'partnersinbiz.billing', 'sent', '{}'::jsonb)`, [CO]);
    const store = new SqlStore(pg.db);
    expect(await store.getAccount(CO, "g1")).toMatchObject({ provider: "gmail", status: "connected", reply_to: null, token_sealed: "v1.x" });
    expect(await store.getSend(CO, "old:1")).toMatchObject({ provider: null, provider_message_id: null, delivery_status: null, delivery: {} });
    expect((await store.defaultAccount(CO))!.id).toBe("g1");
    // A send-only account never becomes the default sender or a sync account.
    await store.insertEspAccount({ id: "e1", companyId: CO, provider: "resend", address: FROM, status: "connected", fromName: null, replyTo: null, clientKind: null, clientRef: null, createdBy: null });
    expect((await store.defaultAccount(CO))!.id).toBe("g1");
    expect((await store.listSyncAccounts()).map((a) => a.id)).toEqual(["g1"]);
    // The status list accepts pending and refuses anything else.
    await expect(sql(`UPDATE ${NAMESPACE}.accounts SET status = 'banana' WHERE id = 'e1'`)).rejects.toThrow(/accounts_status/);
  });
});

describe.skipIf(!available)("the provider's SQL, statement by statement", () => {
  let pg: PgHarness;
  let s: SqlStore;
  beforeAll(async () => {
    pg = await startPg();
    s = new SqlStore(pg.db);
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
  });
  const rows = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.client.query(text, params)).rows as T[];
  const domainRow = (over: Record<string, unknown> = {}) => ({
    company_id: CO, domain: "d.co", provider: "resend", provider_domain_id: "pd-1", region: "eu-west-1", status: "pending" as const, records: [{ record: "SPF", type: "TXT" as const, name: "send", fqdn: "send.d.co", value: "v=spf1", priority: null, ttl: "Auto", status: "pending", purpose: "p" }],
    return_path_host: "send.d.co", dkim_selector: "resend", spf_include: "amazonses.com", client_kind: "company", client_ref: "crm-1", account_id: "a1", created_by: "u", verified_at: null, checked_at: new Date().toISOString(),
    verify_asked_at: null, first_sent_at: null, last_sent_at: null, warmup_exempt: false, daily_cap_override: null, reputation: null, created_at: "", updated_at: "", ...over,
  });

  it("takes recipients of the day's cap atomically, whatever the cap, and gives them back", async () => {
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-03", 30, 50)).toBe(true);
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-03", 21, 50)).toBe(false);
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-03", 20, 50)).toBe(true);
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-03", 1, 50)).toBe(false);
    // No cap: counted, never refused.
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-03", 500, null)).toBe(true);
    expect((await s.espDayRows(CO, "d.co", "2026-10-03"))[0]!.sent).toBe(550);
    await s.releaseEspSends(CO, "d.co", "2026-10-03", 600);
    expect((await s.espDayRows(CO, "d.co", "2026-10-03"))[0]!.sent).toBe(0);
    // The first reservation of a day is checked against the cap too (an insert, not an update).
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-04", 51, 50)).toBe(false);
    expect(await s.espDayRows(CO, "d.co", "2026-10-04")).toHaveLength(0);
    expect(await s.reserveEspSends(CO, "d.co", "2026-10-04", 50, 50)).toBe(true);
    // Another company's day is its own.
    expect(await s.reserveEspSends("co-2", "d.co", "2026-10-04", 50, 50)).toBe(true);
  });

  it("two reservations at once cannot both pass", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => s.reserveEspSends(CO, "d.co", "2026-10-03", 10, 50)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await s.espDayRows(CO, "d.co", "2026-10-03"))[0]!.sent).toBe(50);
  });

  it("counts each outcome on its own day and column, and refuses a column it does not know", async () => {
    for (const field of ["delivered", "hard_bounces", "soft_bounces", "complaints", "opened", "clicked", "failed"] as const) await s.bumpEspDay(CO, "d.co", "2026-10-03", field, 2);
    await s.bumpEspDay(CO, "d.co", "2026-10-03", "delivered", 3);
    expect((await s.espDayRows(CO, "d.co", "2026-10-03"))[0]).toMatchObject({ sent: 0, delivered: 5, hard_bounces: 2, soft_bounces: 2, complaints: 2, opened: 2, clicked: 2, failed: 2 });
    expect((await s.espDayRows(CO, "d.co", "2026-10-04"))).toHaveLength(0);
    expect((await s.espDayRows(CO, "d.co", "2026-10-03"))[0]!.day).toBe("2026-10-03");
  });

  it("records a delivery once by id and once by message, kind and recipient, and takes it back out", async () => {
    const input = { companyId: CO, eventId: "msg_1", dedupeKey: "e1:email.bounced:a@b.co", provider: "resend", type: "email.bounced", emailId: "e1", recipient: "A@B.co", domain: "d.co", sendKey: "k", detail: { bounceType: "Permanent" } };
    expect(await s.recordEspEvent(input)).toBe(true);
    expect(await s.recordEspEvent(input)).toBe(false);
    expect(await s.recordEspEvent({ ...input, eventId: "msg_2" })).toBe(false);
    expect(await s.recordEspEvent({ ...input, eventId: "msg_3", dedupeKey: "e1:email.bounced:other@b.co" })).toBe(true);
    // Another company has its own.
    expect(await s.recordEspEvent({ ...input, companyId: "co-2" })).toBe(true);
    expect((await rows(`SELECT recipient FROM ${NAMESPACE}.esp_events WHERE company_id = $1 ORDER BY event_id`, [CO])).map((r) => (r as { recipient: string }).recipient)).toEqual(["a@b.co", "a@b.co"]);
    await s.forgetEspEvent(CO, "msg_1");
    expect(await s.recordEspEvent(input)).toBe(true);
  });

  it("counts soft bounces in a 14 day window and forgets older ones", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z").toISOString();
    expect((await s.recordSoftBounce(CO, "A@x.co", t0, 14)).soft_bounces).toBe(1);
    expect((await s.recordSoftBounce(CO, "a@x.co", new Date("2026-10-02T10:00:00Z").toISOString(), 14)).soft_bounces).toBe(2);
    expect((await s.recordSoftBounce(CO, "a@x.co", new Date("2026-10-10T10:00:00Z").toISOString(), 14)).soft_bounces).toBe(3);
    // 15 days after the last one: it starts again.
    const again = await s.recordSoftBounce(CO, "a@x.co", new Date("2026-10-25T10:00:00Z").toISOString(), 14);
    expect(again.soft_bounces).toBe(1);
    expect(again.first_soft_at).toBe("2026-10-25T10:00:00.000Z");
    await s.setBackoff(CO, "a@x.co", "2026-10-26T00:00:00.000Z");
    expect((await s.recipientHealth(CO, ["A@X.co", "other@x.co"]))[0]).toMatchObject({ email: "a@x.co", backoff_until: "2026-10-26T00:00:00.000Z" });
    await s.clearRecipientHealth(CO, "a@x.co");
    expect(await s.recipientHealth(CO, ["a@x.co"])).toEqual([]);
  });

  it("refreshing a domain from the provider never touches its send history or a person's settings", async () => {
    await s.upsertEspDomain(domainRow());
    await s.patchEspDomain(CO, "d.co", { warmup_exempt: true, daily_cap_override: 300, reputation: { sent: 9 } });
    await s.noteEspSend(CO, "d.co", "2026-10-01T09:00:00.000Z", false);
    await s.noteEspSend(CO, "d.co", "2026-10-03T09:00:00.000Z", false);
    await s.upsertEspDomain(domainRow({ status: "verified", verified_at: "2026-10-03T10:00:00.000Z", provider_domain_id: "pd-2", region: "us-east-1" }));
    const row = (await s.getEspDomain(CO, "d.co"))!;
    expect(row).toMatchObject({ status: "verified", provider_domain_id: "pd-2", region: "us-east-1", verified_at: "2026-10-03T10:00:00.000Z", warmup_exempt: true, daily_cap_override: 300, reputation: { sent: 9 }, client_ref: "crm-1", account_id: "a1" });
    // First send is day one of the warm-up and stays; the last send moves; a cold domain restarts.
    expect(row.first_sent_at).toBe("2026-10-01T09:00:00.000Z");
    expect(row.last_sent_at).toBe("2026-10-03T09:00:00.000Z");
    await s.noteEspSend(CO, "d.co", "2026-12-01T09:00:00.000Z", true);
    expect((await s.getEspDomain(CO, "d.co"))!.first_sent_at).toBe("2026-12-01T09:00:00.000Z");
    // A verified time is kept when a later refresh does not carry one.
    await s.upsertEspDomain(domainRow({ status: "verified", verified_at: null }));
    expect((await s.getEspDomain(CO, "d.co"))!.verified_at).toBe("2026-10-03T10:00:00.000Z");
  });

  it("keeps one domain row and one provider id per company, and refuses a negative cap or an unknown status", async () => {
    await s.upsertEspDomain(domainRow());
    await expect(s.upsertEspDomain(domainRow({ domain: "e.co" }))).rejects.toThrow(/esp_domains_provider_id|duplicate key/);
    await expect(s.patchEspDomain(CO, "d.co", { daily_cap_override: -5 })).rejects.toThrow(/esp_domains_cap/);
    await expect(rows(`UPDATE ${NAMESPACE}.esp_domains SET status = 'banana'`)).rejects.toThrow(/esp_domains_status/);
    // Another company may use the same provider id.
    await s.upsertEspDomain(domainRow({ company_id: "co-2" }));
    expect(await s.listEspDomains(CO)).toHaveLength(1);
  });

  it("erasure removes a person's events and soft-bounce rows, and only theirs", async () => {
    await s.recordEspEvent({ companyId: CO, eventId: "m1", dedupeKey: "k1", provider: "resend", type: "email.bounced", emailId: "e", recipient: "a@x.co", domain: "d.co", sendKey: null, detail: {} });
    await s.recordEspEvent({ companyId: CO, eventId: "m2", dedupeKey: "k2", provider: "resend", type: "email.bounced", emailId: "e2", recipient: "b@x.co", domain: "d.co", sendKey: null, detail: {} });
    await s.recordSoftBounce(CO, "a@x.co", new Date().toISOString(), 14);
    expect(await s.eraseEspRecipients(CO, ["A@x.co"])).toBe(2);
    expect((await rows(`SELECT recipient FROM ${NAMESPACE}.esp_events`)).map((r) => (r as { recipient: string }).recipient)).toEqual(["b@x.co"]);
    expect(await s.eraseEspRecipients(CO, [])).toBe(0);
  });

  it("purges old events and old days, and keeps the rest", async () => {
    await s.recordEspEvent({ companyId: CO, eventId: "old", dedupeKey: "k-old", provider: "resend", type: "email.delivered", emailId: "e", recipient: "", domain: "d.co", sendKey: null, detail: {} });
    await rows(`UPDATE ${NAMESPACE}.esp_events SET received_at = now() - interval '100 days' WHERE event_id = 'old'`);
    await s.recordEspEvent({ companyId: CO, eventId: "new", dedupeKey: "k-new", provider: "resend", type: "email.delivered", emailId: "e", recipient: "", domain: "d.co", sendKey: null, detail: {} });
    await s.bumpEspDay(CO, "d.co", "2026-07-01", "delivered", 1);
    await s.bumpEspDay(CO, "d.co", "2026-10-01", "delivered", 1);
    // Another company's old rows are not this company's to purge: the retention step runs once per company.
    await s.recordEspEvent({ companyId: "co-2", eventId: "old-2", dedupeKey: "k-old-2", provider: "resend", type: "email.delivered", emailId: "e", recipient: "", domain: "d.co", sendKey: null, detail: {} });
    await rows(`UPDATE ${NAMESPACE}.esp_events SET received_at = now() - interval '100 days' WHERE event_id = 'old-2'`);
    await s.bumpEspDay("co-2", "d.co", "2026-07-01", "delivered", 1);
    const out = await s.purgeEspHistory(CO, new Date(Date.now() - 90 * 86_400_000).toISOString(), "2026-08-01");
    expect(out).toEqual({ events: 1, days: 1 });
    expect((await rows(`SELECT event_id FROM ${NAMESPACE}.esp_events ORDER BY event_id`)).map((r) => (r as { event_id: string }).event_id)).toEqual(["new", "old-2"]);
    expect((await rows(`SELECT company_id, day FROM ${NAMESPACE}.esp_domain_days ORDER BY company_id, day`)).map((r) => `${(r as { company_id: string }).company_id}:${(r as { day: string }).day}`)).toEqual([`${CO}:2026-10-01`, "co-2:2026-07-01"]);
    expect(await s.purgeEspHistory("co-2", new Date(Date.now() - 90 * 86_400_000).toISOString(), "2026-08-01")).toEqual({ events: 1, days: 1 });
  });

  it("one send-only address is one account per company; the same address elsewhere, and Gmail accounts, are not touched by the rule", async () => {
    const account = (id: string, companyId: string, provider: string, address: string) => s.insertEspAccount({ id, companyId, provider, address, status: "pending", fromName: null, replyTo: null, clientKind: null, clientRef: null, createdBy: null });
    await account("r1", CO, "resend", "hello@d.co");
    await expect(account("r2", CO, "resend", "hello@d.co")).rejects.toThrow(/accounts_resend_address|duplicate key/);
    await account("r3", "co-2", "resend", "hello@d.co");
    await account("r4", CO, "resend", "other@d.co");
    // The index is only for provider accounts: a Gmail mailbox is not constrained by it.
    await rows(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, provider, address) VALUES ('g1', $1, 'gmail', 'hello@d.co'), ('g2', $1, 'gmail', 'hello@d.co')`, [CO]);
  });

  it("patchSendDelivery merges notes without touching the delivery status, clears a key set to null, and stays inside the company", async () => {
    await rows(`INSERT INTO ${NAMESPACE}.send_requests (key, company_id, source_plugin, status, request) VALUES ('k1', $1, 'p', 'sending', '{}'::jsonb)`, [CO]);
    await s.setSendDelivery(CO, "k1", "delivered", { delivered_at: "t1" });
    await s.patchSendDelivery(CO, "k1", { maybeAcceptedAt: "2026-10-03T10:00:00.000Z", gen: 1 });
    expect(await s.getSend(CO, "k1")).toMatchObject({ delivery_status: "delivered", delivery: { delivered_at: "t1", maybeAcceptedAt: "2026-10-03T10:00:00.000Z", gen: 1 } });
    await s.patchSendDelivery(CO, "k1", { maybeAcceptedAt: null });
    expect((await s.getSend(CO, "k1"))!.delivery).toEqual({ delivered_at: "t1", maybeAcceptedAt: null, gen: 1 });
    await s.patchSendDelivery("co-2", "k1", { gen: 9 });
    expect((await s.getSend(CO, "k1"))!.delivery).toMatchObject({ gen: 1 });
  });

  it("finds a send by the provider's message id, scoped to the company, and records what happened to it without losing earlier detail", async () => {
    await rows(`INSERT INTO ${NAMESPACE}.send_requests (key, company_id, source_plugin, status, request) VALUES ('k1', $1, 'p', 'sending', '{}'::jsonb)`, [CO]);
    await s.markSendSentProvider("k1", { provider: "resend", providerMessageId: "m-1", accountId: "a1", fromAddress: FROM });
    expect((await s.sendByProviderMessage(CO, "resend", "m-1"))!.key).toBe("k1");
    expect(await s.sendByProviderMessage("co-2", "resend", "m-1")).toBeNull();
    await s.setSendDelivery(CO, "k1", "delivered", { delivered_at: "t1" });
    await s.setSendDelivery(CO, "k1", "bounced", { bounced_at: "t2", bounceType: "Permanent" });
    expect(await s.getSend(CO, "k1")).toMatchObject({ status: "sent", delivery_status: "bounced", delivery: { delivered_at: "t1", bounced_at: "t2", bounceType: "Permanent" } });
    // Erasure of a send wipes what the provider said about it.
    await s.redactSends(CO, ["k1"]);
    expect((await s.getSend(CO, "k1"))!.delivery).toEqual({});
  });
});

describe.skipIf(!available)("migration 011 (SES)", () => {
  const INDEX = "accounts_ses_address";
  const ELEVEN = "011_ses.sql";
  let pg: PgHarness | null = null;
  afterEach(async () => {
    await pg?.stop();
    pg = null;
  });
  const names = async (text: string, params: unknown[] = []) => ((await pg!.client.query(text, params)).rows as Array<Record<string, string>>).map((row) => Object.values(row)[0]!);
  const insertAccount = (id: string, company: string, provider: string, address: string) =>
    pg!.client.query(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, provider, address, status) VALUES ($1, $2, $3, $4, 'connected')`, [id, company, provider, address]);

  it("applies on the 0.6.5 schema (001–010, with rows in it) and on an empty one, and creates only the index", async () => {
    const all = readdirSync(new URL("../../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
    expect(all.at(-1)).toBe(ELEVEN);
    // 0.6.5: everything before 011, with a Gmail and a Resend account already there.
    pg = await startPg({ migrations: all.filter((f) => f !== ELEVEN) });
    await insertAccount("g1", CO, "gmail", "peet@partnersinbiz.online");
    await insertAccount("r1", CO, "resend", "hello@updates.client.co.za");
    const before = await names(`SELECT indexname FROM pg_indexes WHERE schemaname = '${NAMESPACE}'`);
    expect(before).not.toContain(INDEX);
    await pg.client.query(readFileSync(new URL(`../../migrations/${ELEVEN}`, import.meta.url), "utf8"));
    const after = await names(`SELECT indexname FROM pg_indexes WHERE schemaname = '${NAMESPACE}'`);
    expect(after.filter((name) => !before.includes(name))).toEqual([INDEX]);
    expect(await names(`SELECT count(*)::text FROM ${NAMESPACE}.accounts`)).toEqual(["2"]);
    await pg.stop();
    // An empty schema takes all eleven in order.
    pg = await startPg();
    expect((await pg.client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = '${NAMESPACE}' AND indexname = $1`, [INDEX])).rows).toHaveLength(1);
  }, 180_000);

  it("refuses two ses accounts with one address in a company, and ignores Gmail and Resend rows and other companies", async () => {
    pg = await startPg();
    await insertAccount("s1", CO, "ses", "hello@pib.test");
    await expect(insertAccount("s2", CO, "ses", "hello@pib.test")).rejects.toThrow(INDEX);
    // The same address elsewhere is fine: another company, another provider, Gmail.
    await insertAccount("s3", "co-2", "ses", "hello@pib.test");
    await insertAccount("r1", CO, "resend", "hello@pib.test");
    await insertAccount("g1", CO, "gmail", "hello@pib.test");
    await insertAccount("g2", CO, "gmail", "hello@pib.test").catch(() => undefined);
    expect(await names(`SELECT id FROM ${NAMESPACE}.accounts WHERE provider = 'ses' ORDER BY id`)).toEqual(["s1", "s3"]);
  }, 180_000);
});
