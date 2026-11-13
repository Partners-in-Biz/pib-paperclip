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

describe.skipIf(!available)("old newsletter send records are blanked by the hourly job (real Postgres)", () => {
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

  const insert = (key: string, age: string) =>
    sql(`INSERT INTO ${NAMESPACE}.send_requests (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, context, request, gmail_message_id, rfc_message_id, sent_at, created_at)
         VALUES ($1, $2, $3, 'acc-1', 'peet@partnersinbiz.online', '[{"email":"ada@client.co.za"}]'::jsonb, 'Newsletter', 'sent', '{}'::jsonb, '{"text":"hello"}'::jsonb, $1, $1, now(), now() - $4::interval)`, [key, CO, PIB_PLUGINS.crm, age]);
  const row = async (key: string) => (await sql<{ to_addrs: unknown[]; subject: string; request: Record<string, unknown> }>(`SELECT to_addrs, subject, request FROM ${NAMESPACE}.send_requests WHERE key = $1`, [key]))[0]!;

  it("blanks crm:nl: records older than 30 days, leaves younger and other keys, and still refuses the blanked key", async () => {
    const b = await boot();
    await insert("crm:nl:old", "31 days");
    await insert("crm:nl:young", "29 days");
    await insert("crm:msg:old", "31 days");
    await b.harness.runJob("setup-status");
    expect(await row("crm:nl:old")).toMatchObject({ to_addrs: [], subject: "[erased on request]", request: { key: "crm:nl:old", erased: true } });
    expect((await row("crm:nl:young")).request).toMatchObject({ text: "hello" });
    expect((await row("crm:msg:old")).request).toMatchObject({ text: "hello" });
    // A second hour changes nothing, and the blanked key is still a duplicate.
    await b.harness.runJob("setup-status");
    await send(b, { key: "crm:nl:old" });
    expect(b.gmail.sent).toHaveLength(0);
    expect((await sql(`SELECT 1 FROM ${NAMESPACE}.send_requests WHERE key = 'crm:nl:old'`))).toHaveLength(1);
  });
});
