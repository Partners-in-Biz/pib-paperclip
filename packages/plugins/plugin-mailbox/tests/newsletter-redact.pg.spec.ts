/**
 * Newsletter send records (key `crm:nl:`) on a real Postgres, through the real worker: the hourly private-mail job blanks recipients, subject
 * and request of such a record once it is older than 30 days. Younger ones and other keys are untouched, and the blanked key is still refused as a duplicate.
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
import { ESP_ON } from "./helpers/esp.js";
import { FakeGmail } from "./helpers/fake-gmail.js";
import { FakeResend } from "./helpers/fake-resend.js";
import { CO, ENCRYPTION_KEY } from "./helpers/memory.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { sealedTokens } from "./helpers/setup.js";

const available = await embeddedAvailable();

const CRM_SEND = pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested);
const am = { agentId: "agent-am", companyId: CO };

function newsletter(overrides: Record<string, unknown> = {}) {
  return { key: "crm:nl:new", to: [{ email: "ada@client.co.za", name: "Ada" }], subject: "News", text: "hello", marketing: false, ...overrides };
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

  /** The worker on the real database, a fake Gmail behind the global fetch (the Mailbox's Gmail calls) and a fake Resend and DNS behind the host's. */
  async function boot(config: Record<string, unknown> = ESP_ON) {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: ENCRYPTION_KEY, ...config } });
    const gmail = new FakeGmail();
    gmail.sentText = () => "hello";
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

  const send = (b: Booted, overrides: Record<string, unknown> = {}) => b.harness.emit(CRM_SEND, newsletter(overrides), { companyId: CO });

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
