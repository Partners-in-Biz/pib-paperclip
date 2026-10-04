/**
 * Client messages (the CRM's signing email, reports, feedback requests: `context.kind` `client_message`) on a real Postgres with all ten
 * migrations, through the real worker. The signing link in such an email is a bearer token, so once its send has ended the Mailbox must
 * hold no text of it anywhere: this scans EVERY table of the plugin's schema, every event the worker emitted, every log line and every
 * answer a tool gave, for the token. A send that is still waiting for a retry keeps its text (the retry needs it), and the same scan finds it.
 * Both ways of sending are covered: Gmail, and the email provider (where the links must also reach the provider untouched, with no tracking).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MAIL_EVENTS, PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { resetEnsureMemo } from "../src/delegations.js";
import { SqlStore } from "../src/db.js";
import { forgetLimiters } from "../src/esp/limiter.js";
import { forgetEspRuntime } from "../src/esp/runtime.js";
import { forgetWebhookCandidates } from "../src/esp/webhook.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { rememberCompany } from "../src/setup-status.js";
import plugin from "../src/worker.js";
import { dohFetchFrom } from "./helpers/dns.js";
import { CLIENT, DOMAIN, dnsVerified, ESP_ON, FROM } from "./helpers/esp.js";
import { FakeGmail } from "./helpers/fake-gmail.js";
import { FakeResend } from "./helpers/fake-resend.js";
import { CO, ENCRYPTION_KEY } from "./helpers/memory.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { sealedTokens } from "./helpers/setup.js";

const available = await embeddedAvailable();

// Built at runtime: a secret-shaped literal in a test file is refused by GitHub push protection, and a test must not share a token with anything real.
const TOKEN = ["pibt", `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(40, "q")].join("_");
const PAGE = "https://paperclip.example.com/_plugins/00000000-0000-4000-8000-000000000001/ui/s/page1234.html";
const LINK = `${PAGE}#${TOKEN}`;
const TEXT = `Hi Ada,\n\nPlease review and sign your proposal here: ${LINK}\n\nThank you`;
const HTML = `<p>Hi Ada,</p><p><a href="${LINK}">Please review and sign your proposal</a></p>`;
const CRM_SEND = pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested);
const am = { agentId: "agent-am", companyId: CO };

function signing(overrides: Record<string, unknown> = {}) {
  return {
    key: "crm:msg:approval-1",
    to: [{ email: "ada@client.co.za", name: "Ada" }],
    subject: "Please sign your proposal",
    text: TEXT,
    html: HTML,
    context: { plugin: PIB_PLUGINS.crm, kind: "client_message", id: "approval-1", clientKind: "company", clientRef: CLIENT.ref },
    labels: ["PiB/Clients"],
    marketing: false,
    ...overrides,
  };
}

describe.skipIf(!available)("a client message keeps no text once its send has ended (real Postgres)", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await startPg();
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
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

  /** Every row of every table of the plugin's schema, as text. */
  async function wholeStore(): Promise<string> {
    const tables = await sql<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = '${NAMESPACE}' ORDER BY tablename`);
    let all = "";
    for (const { tablename } of tables) all += JSON.stringify(await sql(`SELECT row_to_json(t) AS r FROM ${NAMESPACE}.${tablename} t`));
    return all;
  }

  /** The worker on the real database, a fake Gmail behind the global fetch (the Mailbox's Gmail calls) and a fake Resend and DNS behind the host's. */
  async function boot(config: Record<string, unknown> = ESP_ON) {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: ENCRYPTION_KEY, ...config } });
    const gmail = new FakeGmail();
    // Gmail reads its own sent mail back: its snippet and its text contain the link, as the real one would.
    gmail.sentText = () => TEXT;
    vi.stubGlobal("fetch", gmail.fetch);
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
    await rememberCompany(harness.ctx, CO);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    const store = new SqlStore(pg.db);
    await store.insertAccount({ id: "acc-1", companyId: CO, provider: "gmail", address: gmail.email, ownerUserId: null, isDefault: true });
    await store.updateAccount(CO, "acc-1", { status: "connected", token_sealed: sealedTokens(), connected_at: new Date().toISOString() });
    // The agent that may read the mailbox (the Operator's default access, or a grant): what it can reach through the Mailbox is what matters.
    await store.grantDelegation({ id: "d1", companyId: CO, accountId: "acc-1", agentId: am.agentId, canRead: true, canDraft: true, canSend: false, source: "manual", grantedBy: null });
    const events = (name: string) => emit.mock.calls.filter(([n]) => n === name).map(([, , payload]) => payload as Record<string, unknown>);
    return { harness, gmail, resend, dns, emit, events, store };
  }
  type Booted = Awaited<ReturnType<typeof boot>>;

  const send = (b: Booted, overrides: Record<string, unknown> = {}) => b.harness.emit(CRM_SEND, signing(overrides), { companyId: CO });
  const results = (b: Booted) => b.events(MAIL_EVENTS.sendResult);
  const storedRequest = async (key = "crm:msg:approval-1") => (await sql<{ request: Record<string, unknown> }>(`SELECT request FROM ${NAMESPACE}.send_requests WHERE key = $1`, [key]))[0]!.request;

  /** A verified provider domain for the client with the provider switched on, the way the owner's journey leaves it. */
  async function verifiedDomain(b: Booted) {
    await sql(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, domain, lifecycle, updated_at) VALUES ($1, $2, 'Client Co', 'client.co.za', 'customer', now())`, [CLIENT.ref, CO]);
    const added = await b.harness.executeTool<{ error?: string }>("add-sending-domain", { domain: DOMAIN, clientKind: "company", clientRef: CLIENT.ref, replyTo: "team@client.co.za" }, am);
    expect(added.error).toBeUndefined();
    b.resend.dnsAdded = true;
    b.dns.records = dnsVerified();
    await b.harness.executeTool("list-sending-domains", { refresh: true }, am);
  }

  /** What everything the worker said or did outside the database holds. */
  const outside = (b: Booted, ...answers: unknown[]) => JSON.stringify({ emitted: b.emit.mock.calls, logs: b.harness.logs, answers });

  describe("through Gmail", () => {
    it("keeps the text while a retry is waiting, then holds none of it anywhere once the message has gone", async () => {
      const b = await boot();
      // Gmail is down: the send is asked again later, and the retry needs the text.
      b.gmail.intercept = (call) => (call.method === "POST" && call.url.pathname.endsWith("/messages/send") ? new Response(JSON.stringify({ error: { code: 503, message: "backend error" } }), { status: 503 }) : null);
      await send(b);
      expect(results(b)).toHaveLength(0);
      expect((await sql<{ status: string }>(`SELECT status FROM ${NAMESPACE}.send_requests WHERE key = 'crm:msg:approval-1'`))[0]!.status).toBe("retrying");
      expect(await storedRequest()).toMatchObject({ text: TEXT, html: HTML });
      expect(await wholeStore()).toContain(TOKEN);

      // Gmail is back; the sender's outbox delivers the request again.
      b.gmail.intercept = null;
      await send(b);
      expect(results(b).at(-1)).toMatchObject({ key: "crm:msg:approval-1", status: "sent", context: { kind: "client_message" } });
      expect(b.gmail.sent).toHaveLength(1);
      expect(b.gmail.sent[0]!.mime).toContain("sign your proposal");

      // The whole store: nothing. Not the token, not the page, not a word of the text.
      const all = await wholeStore();
      for (const needle of [TOKEN, PAGE, "Please review and sign your proposal here"]) expect(all, needle).not.toContain(needle);
      const request = await storedRequest();
      expect(request).not.toHaveProperty("text");
      expect(request).not.toHaveProperty("html");
      expect(request).toMatchObject({ key: "crm:msg:approval-1", subject: "Please sign your proposal", context: { kind: "client_message" } });
      // The stored sent copy has its subject and recipients and no preview.
      const [copy] = await sql<{ snippet: string; sent_context: { kind: string } }>(`SELECT snippet, sent_context FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`);
      expect(copy).toMatchObject({ snippet: "", sent_context: { kind: "client_message" } });
      // What the worker emitted and logged holds none of it either.
      expect(outside(b)).not.toContain(TOKEN);
    });

    it("hands the text of the sent copy to nobody: get-message, search-mail, the inbox lists and mail-status say none of it", async () => {
      const b = await boot();
      await send(b);
      const [copy] = await sql<{ id: string; gmail_message_id: string }>(`SELECT id, gmail_message_id FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`);
      // Control: Gmail itself does hold the link in its Sent folder, and the Mailbox's own reader would return it. That is why the tools refuse.
      expect(b.gmail.messages.get(copy!.gmail_message_id)!.snippet).toContain("Please review");
      const read = await b.harness.executeTool<{ data?: Record<string, any>; error?: string }>("get-message", { messageId: copy!.id }, am);
      expect(read.error).toBeUndefined();
      expect(read.data).toMatchObject({ withheld: true, text: "", subject: "Please sign your proposal" });
      expect(read.data!.note).toMatch(/does not keep or show its text/);
      // The same by the Gmail message id, and from the page by a person.
      const byGmailId = await b.harness.executeTool<{ data?: Record<string, any> }>("get-message", { messageId: copy!.gmail_message_id }, am);
      expect(byGmailId.data).toMatchObject({ withheld: true, text: "" });
      const asPerson = await b.harness.performAction<Record<string, any>>("mailbox.get-message", { messageId: copy!.id }, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
      expect(asPerson).toMatchObject({ withheld: true, text: "" });

      const found = await b.harness.executeTool<{ data?: { messages: Array<Record<string, any>> } }>("search-mail", { query: "in:sent" }, am);
      expect(found.data!.messages).toEqual([expect.objectContaining({ gmailMessageId: copy!.gmail_message_id, snippet: "", withheld: true })]);
      const inbox = await b.harness.executeTool("list-inbox", { accountId: "acc-1" }, am);
      const threads = await b.harness.executeTool("list-threads", { accountId: "acc-1" }, am);
      const status = await b.harness.executeTool<{ data?: Record<string, any> }>("mail-status", { key: "crm:msg:approval-1" }, am);
      expect(status.data).toMatchObject({ status: "sent", private: true, textKept: false });
      expect(outside(b, read, byGmailId, asPerson, found, inbox, threads, status)).not.toContain(TOKEN);
    });

    it("an ordinary message is kept as before: only a client message is treated this way", async () => {
      const b = await boot();
      await b.harness.emit(pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested), { key: "billing:invoice:1:send", to: [{ email: "ann@x.co" }], subject: "Invoice 1", text: "Invoice text with a reference ABC-123", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1" } }, { companyId: CO });
      expect(results(b).at(-1)).toMatchObject({ status: "sent" });
      expect(await storedRequest("billing:invoice:1:send")).toMatchObject({ text: "Invoice text with a reference ABC-123" });
      const [copy] = await sql<{ snippet: string }>(`SELECT snippet FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`);
      expect(copy!.snippet).toContain("Invoice text");
      const status = await b.harness.executeTool<{ data?: Record<string, any> }>("mail-status", { key: "billing:invoice:1:send" }, am);
      expect(status.data).not.toHaveProperty("private");
    });

    it("a send that fails for good drops its text too, and cannot be sent again from the Mailbox", async () => {
      const b = await boot();
      // The address bounced for good before: the Mailbox refuses it for everyone.
      await b.store.upsertSuppression({ companyId: CO, email: "ada@client.co.za", scope: "all", reason: "bounced", source: PIB_PLUGINS.mailbox, senderKey: "" });
      await send(b);
      expect(results(b).at(-1)).toMatchObject({ status: "failed", permanent: true });
      expect(b.gmail.sent).toHaveLength(0);
      expect(await storedRequest()).not.toHaveProperty("text");
      expect(await wholeStore()).not.toContain(TOKEN);
      // A retry by hand has nothing to send: it says so (and does not claim to have tried).
      await expect(b.harness.performAction("mailbox.retry-send", { key: "crm:msg:approval-1" }, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never)).rejects.toThrow(/text is not kept once its send has ended/);
      expect(b.gmail.sent).toHaveLength(0);
    });

    it("the hourly sweep drops what slipped through: a stuck send nobody settled, and a preview an older version stored", async () => {
      const b = await boot();
      // A send the sender's outbox gave up on 5 days ago (the Mailbox never hears of that), and one asked for a minute ago and still waiting.
      b.gmail.intercept = (call) => (call.method === "POST" && call.url.pathname.endsWith("/messages/send") ? new Response(JSON.stringify({ error: { code: 503, message: "backend error" } }), { status: 503 }) : null);
      await send(b, { key: "crm:msg:old" });
      await send(b, { key: "crm:msg:fresh" });
      await sql(`UPDATE ${NAMESPACE}.send_requests SET created_at = now() - interval '5 days' WHERE key = 'crm:msg:old'`);
      // A copy stored by version 0.6.0: the preview holds the start of the text, and the message is not marked.
      await sql(`INSERT INTO ${NAMESPACE}.send_requests (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, context, request, gmail_message_id, rfc_message_id, sent_at)
                 VALUES ('crm:msg:sent-old', $1, $2, 'acc-1', 'peet@partnersinbiz.online', '[]'::jsonb, 'Old', 'sent', $3::jsonb, '{}'::jsonb, 'g-old', '<old@x>', now())`, [CO, PIB_PLUGINS.crm, JSON.stringify(signing().context)]);
      await sql(`INSERT INTO ${NAMESPACE}.messages (id, company_id, account_id, subject, body, direction, status, gmail_message_id, gmail_thread_id, rfc_message_id, snippet, labels, received_at)
                 VALUES ('gm_old', $1, 'acc-1', 'Old', '', 'outbound', 'sent', 'g-old', 't-old', '<old@x>', $2, '[]'::jsonb, now())`, [CO, `Please sign: ${LINK}`]);
      expect(await wholeStore()).toContain(TOKEN);

      await b.harness.runJob("setup-status");
      const requests = await sql<{ key: string; request: Record<string, unknown> }>(`SELECT key, request FROM ${NAMESPACE}.send_requests WHERE key IN ('crm:msg:old', 'crm:msg:fresh')`);
      const byKey = Object.fromEntries(requests.map((row) => [row.key, row.request]));
      expect(byKey["crm:msg:old"]).not.toHaveProperty("text");
      // The one that is still inside the sender's retry period keeps its text: the retry needs it.
      expect(byKey["crm:msg:fresh"]).toMatchObject({ text: TEXT });
      expect((await sql<{ snippet: string }>(`SELECT snippet FROM ${NAMESPACE}.messages WHERE id = 'gm_old'`))[0]!.snippet).toBe("");
      // And it never throws, whatever the hour finds: a second run changes nothing.
      await b.harness.runJob("setup-status");
      expect(await sql(`SELECT 1 FROM ${NAMESPACE}.send_requests WHERE key = 'crm:msg:fresh' AND request ->> 'text' IS NOT NULL`)).toHaveLength(1);
    });

    it("the sync that finds the sent copy before the send is stored does not keep its preview either", async () => {
      const b = await boot();
      // The Gmail message exists (the send landed) but this worker has not stored it: the next sync imports it, with Gmail's own snippet.
      b.gmail.intercept = null;
      await send(b);
      await sql(`DELETE FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`);
      const copy = [...b.gmail.messages.values()].find((m) => m.labelIds.includes("SENT"))!;
      expect(copy.snippet).toContain("Please review");
      b.gmail.history.push({ id: ++b.gmail.historyId, added: [copy.id] });
      await b.store.updateAccount(CO, "acc-1", { history_id: String(b.gmail.historyId - 1) });
      await b.harness.performAction("mailbox.sync-now", {}, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
      const [stored] = await sql<{ snippet: string }>(`SELECT snippet FROM ${NAMESPACE}.messages WHERE direction = 'outbound'`);
      expect(stored, "the sync stored the sent copy").toBeDefined();
      expect(stored!.snippet).toBe("");
      expect(await wholeStore()).not.toContain(TOKEN);
    });
  });

  describe("through the email provider", () => {
    const FROM_PROVIDER = { from: FROM };

    it("keeps the text while a retry waits, hands the provider the links untouched with no tracking, then holds none of it anywhere", async () => {
      const b = await boot();
      await verifiedDomain(b);
      // The provider answers 503: not taken, asked again later. The text is held for that.
      b.resend.errors.push({ status: 503, body: { statusCode: 503, name: "application_error", message: "try again" }, on: /^\/emails/ });
      await send(b, FROM_PROVIDER);
      expect(results(b)).toHaveLength(0);
      expect(b.resend.emails).toHaveLength(0);
      expect(await storedRequest()).toMatchObject({ text: TEXT, html: HTML });
      expect(await wholeStore()).toContain(TOKEN);

      await send(b, FROM_PROVIDER);
      expect(results(b).at(-1)).toMatchObject({ status: "sent", provider: "resend", context: { kind: "client_message" } });
      expect(b.resend.emails).toHaveLength(1);

      // What the provider was handed: the message exactly as written, the link byte for byte, and not one field that could switch tracking on.
      const handed = b.resend.emails[0]!.body;
      expect(handed.html).toBe(HTML);
      expect(handed.text).toBe(TEXT);
      expect(String(handed.html)).toContain(`href="${LINK}"`);
      expect(Object.keys(handed).sort()).toEqual(["from", "html", "reply_to", "subject", "tags", "text", "to"]);
      expect(JSON.stringify(handed)).not.toMatch(/track/i);
      expect(handed).not.toHaveProperty("headers");
      // Before handing it over the Mailbox asked the provider whether the domain tracks (and it said no).
      expect(b.resend.requests.some((r) => r.method === "GET" && /^\/domains\/[^/]+$/.test(r.path))).toBe(true);

      const all = await wholeStore();
      for (const needle of [TOKEN, PAGE, "Please review and sign your proposal here"]) expect(all, needle).not.toContain(needle);
      expect(await storedRequest()).not.toHaveProperty("html");
      expect(outside(b)).not.toContain(TOKEN);
    });

    it("a message the provider refuses for good drops its text", async () => {
      const b = await boot();
      await verifiedDomain(b);
      b.resend.errors.push({ status: 422, body: { statusCode: 422, name: "validation_error", message: "Invalid `to` field." }, on: /^\/emails/ });
      await send(b, FROM_PROVIDER);
      expect(results(b).at(-1)).toMatchObject({ status: "failed", permanent: true });
      expect(await storedRequest()).not.toHaveProperty("text");
      expect(await wholeStore()).not.toContain(TOKEN);
      expect(outside(b)).not.toContain(TOKEN);
    });

    it("refuses to send a client message through a domain that tracks clicks or opens, hands the provider nothing, and says how to fix it", async () => {
      const b = await boot();
      await verifiedDomain(b);
      b.resend.setTracking(DOMAIN, { click: true });
      await send(b, FROM_PROVIDER);
      const refused = results(b).at(-1)!;
      expect(refused).toMatchObject({ status: "failed", permanent: true });
      expect(String(refused.error)).toMatch(/click tracking is switched on for updates\.client\.co\.za/);
      expect(String(refused.error)).toMatch(/rewrites links/);
      expect(String(refused.error)).toMatch(/send this message from the client's Gmail mailbox/);
      expect(b.resend.emails).toHaveLength(0);
      expect(b.gmail.sent).toHaveLength(0);
      expect(await storedRequest()).not.toHaveProperty("text");
      expect(await wholeStore()).not.toContain(TOKEN);
      // What the provider said is kept for the page.
      expect((await sql<{ click_tracking: boolean; open_tracking: boolean }>(`SELECT click_tracking, open_tracking FROM ${NAMESPACE}.esp_domains WHERE domain = $1`, [DOMAIN]))[0]).toEqual({ click_tracking: true, open_tracking: false });

      // Open tracking alone is refused as well (a pixel tells the provider who read a private message).
      b.resend.setTracking(DOMAIN, { click: false, open: true });
      await send(b, { ...FROM_PROVIDER, key: "crm:msg:approval-2" });
      expect(String(results(b).at(-1)!.error)).toMatch(/open tracking is switched on/);
      expect(b.resend.emails).toHaveLength(0);

      // An answer that does not say is not "off": it is refused too, and says so.
      b.resend.setTracking(DOMAIN, { open: false });
      b.resend.hideTracking = true;
      await send(b, { ...FROM_PROVIDER, key: "crm:msg:approval-3" });
      expect(String(results(b).at(-1)!.error)).toMatch(/did not say whether open and click tracking are off/);
      expect(b.resend.emails).toHaveLength(0);

      // Switched off in the dashboard, a new message goes, unchanged.
      b.resend.hideTracking = false;
      await send(b, { ...FROM_PROVIDER, key: "crm:msg:approval-4" });
      expect(results(b).at(-1)).toMatchObject({ status: "sent", provider: "resend" });
      expect(b.resend.emails[0]!.body.html).toBe(HTML);
    });

    it("mail that is not a client message is not held up by tracking: nothing about its links is promised, so nothing is asked", async () => {
      const b = await boot();
      await verifiedDomain(b);
      b.resend.setTracking(DOMAIN, { click: true });
      const before = b.resend.requests.length;
      await send(b, { ...FROM_PROVIDER, key: "campaigns:step:e9:1", context: { plugin: PIB_PLUGINS.crm, kind: "sequence_step", id: "e9", clientKind: "company", clientRef: CLIENT.ref } });
      expect(results(b).at(-1)).toMatchObject({ status: "sent", provider: "resend" });
      expect(b.resend.requests.slice(before).filter((r) => r.method === "GET")).toHaveLength(0);
    });

    it("a domain is registered with tracking switched off, and the page shows when somebody switches it on", async () => {
      const b = await boot();
      await verifiedDomain(b);
      expect(b.resend.domainBodies[0]).toMatchObject({ name: DOMAIN, open_tracking: false, click_tracking: false });
      const shown = await b.harness.performAction<{ domains: Array<{ tracking: unknown }> }>("mailbox.sending-domains", {}, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
      expect(shown.domains[0]!.tracking).toEqual({ open: false, click: false });
    });
  });
});
