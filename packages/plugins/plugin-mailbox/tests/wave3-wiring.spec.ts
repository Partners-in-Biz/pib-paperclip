import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MAIL_EVENTS, PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { resetEnsureMemo } from "../src/delegations.js";
import { DOMAIN_HEALTH_EVENT } from "../src/domain-health.js";
import { connectStart, oauthComplete } from "../src/gmail/oauth.js";
import { runSyncJob } from "../src/gmail/sync.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import { setupStatus } from "../src/setup-status.js";
import plugin from "../src/worker.js";
import { CO } from "./helpers/memory.js";
import { dohFetchFrom, PIB_DNS_BEFORE } from "./helpers/dns.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

beforeEach(() => resetEnsureMemo());

const ROLES = { companyId: CO, operatorAgentId: "agent-op", operatorStatus: "idle", reviewerAgentId: null, ownerUserId: "user-owner", reviewOutward: false, team: {}, updatedAt: new Date().toISOString() };

function withRoles(host: ReturnType<typeof setup>["host"], roles: Record<string, unknown> = ROLES) {
  const state = host.ctx.state as unknown as { get: (key: { namespace?: string; stateKey?: string }) => Promise<unknown> };
  const original = state.get;
  state.get = vi.fn(async (key) => (key.namespace === "pib-cockpit" && key.stateKey === "roles" ? roles : original(key)));
}

describe("the Operator gets mailbox access without anyone asking", () => {
  it("when Gmail is connected", async () => {
    const { env, store, gmail, host } = setup();
    store.accounts.clear();
    withRoles(host);
    gmail.tokenResponse = () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send" }), { status: 200 });
    const start = await connectStart(env, CO, "user-7", {});
    const input: PluginApiRequestInput = { routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", params: {}, query: {}, body: { companyId: CO, state: start.state, params: { code: "c", state: start.state } }, actor: { actorType: "user", actorId: "user-7", userId: "user-7" }, companyId: CO, headers: {} };
    expect((await oauthComplete(env, input)).status).toBe(200);
    const [account] = [...store.accounts.values()];
    expect(await store.delegationFor(account!.id, "agent-op")).toEqual({ can_read: true, can_draft: true, can_send: false });
  });

  it("from the sync job, for a company that connected Gmail before the Operator was staffed", async () => {
    const { env, store, host } = setup();
    withRoles(host);
    expect(await store.delegationFor("acc-1", "agent-op")).toBeNull();
    await runSyncJob(env);
    expect(await store.delegationFor("acc-1", "agent-op")).toEqual({ can_read: true, can_draft: true, can_send: false });
    // A person removes it: the next sync run does not put it back.
    await store.removeDelegation(CO, "acc-1", "agent-op", "user-owner");
    resetEnsureMemo();
    await runSyncJob(env);
    expect(await store.delegationFor("acc-1", "agent-op")).toBeNull();
  });

  it("not when the company switched automatic access off", async () => {
    const { env, store, host } = setup({ autoDelegate: "off" });
    withRoles(host);
    await runSyncJob(env);
    expect(store.delegations.size).toBe(0);
  });
});

describe("the Setup items", () => {
  const harnessCtx = (config: Record<string, unknown>) => createTestHarness({ manifest, config }).ctx;
  const FULL = { publicBaseUrl: "https://paperclip.example.com", encryptionKey: { type: "secret_ref", secretId: "s1" }, google: { clientSecret: { type: "secret_ref", secretId: "s2" } } };
  const item = (status: Awaited<ReturnType<typeof setupStatus>>, key: string) => status.items.find((row) => row.key === key)!;

  async function status(config: Record<string, unknown>, store = setup().store, roles: Record<string, unknown> | null = ROLES, proof: Record<string, unknown> | null = null) {
    const ctx = harnessCtx(config);
    if (roles || proof) {
      (ctx as unknown as { state: unknown }).state = {
        get: async (key: { namespace?: string; stateKey?: string }) =>
          key.namespace === "pib-cockpit" && key.stateKey === "roles" ? roles : key.namespace === "mailbox-unsubscribe" && key.stateKey === "proxy-proof" ? proof : null,
        set: async () => undefined,
      };
    }
    return setupStatus(ctx, CO, store, Date.parse("2026-10-03T10:00:00Z"));
  }

  it("the Operator's access is done once it exists, offered as one click while it is missing, and left alone when a person removed it", async () => {
    const { store } = setup();
    let s = await status(FULL, store);
    expect(item(s, "operator_delegation")).toMatchObject({ status: "missing", required: true, action: { plugin: "partnersinbiz.mailbox", key: "mailbox.create-delegation", params: { accountId: "acc-1", agentId: "agent-op" } } });
    expect(item(s, "operator_delegation").detail).toMatch(/within a few minutes/);
    store.delegate("acc-1", "agent-op");
    s = await status(FULL, store);
    expect(item(s, "operator_delegation")).toMatchObject({ status: "done", action: null });
    expect(item(s, "operator_delegation").detail).toMatch(/never send/);
    await store.removeDelegation(CO, "acc-1", "agent-op", "u");
    s = await status(FULL, store);
    expect(item(s, "operator_delegation")).toMatchObject({ status: "optional", required: false, action: null });
    expect(item(s, "operator_delegation").detail).toMatch(/You removed the Operator's access/);
    s = await status({ ...FULL, autoDelegate: "off" }, setup().store);
    expect(item(s, "operator_delegation").detail).toMatch(/switched off in the Mailbox settings/);
  });

  it("without an Operator the item is optional and points at Setup → Team", async () => {
    const s = await status(FULL, setup().store, { ...ROLES, operatorAgentId: null });
    expect(item(s, "operator_delegation")).toMatchObject({ status: "optional", required: false, href: "/setup?section=team#team-operator" });
  });

  it("sender domain authentication is optional with nothing to check, done when healthy, and names the fix when not", async () => {
    const { store } = setup();
    expect(item(await status(FULL, store), "sender_domain")).toMatchObject({ status: "optional", required: false });
    const row = (status_: "healthy" | "bad", problems: unknown[]) => ({ company_id: CO, domain: "partnersinbiz.online", status: status_, source: "account" as const, client_kind: null, client_ref: null, checked_at: "2026-10-03T05:17:00.000Z", first_checked_at: "2026-10-03T05:17:00.000Z", status_since: "2026-10-03T05:17:00.000Z", dmarc_none_since: null, result: { problems, sendReady: false } });
    await store.upsertDomainCheck(row("bad", [{ code: "spf_missing", severity: "bad", message: "partnersinbiz.online has no SPF record.", fix: "Add a TXT record at the domain (host @): v=spf1 include:_spf.google.com ~all." }]));
    const bad = item(await status(FULL, store), "sender_domain");
    expect(bad).toMatchObject({ status: "missing", required: false, href: "/mailbox?tab=mailboxes", hrefLabel: "Open sender domains" });
    expect(bad.detail).toBe("partnersinbiz.online (bad). partnersinbiz.online has no SPF record.");
    expect(bad.steps).toEqual(expect.arrayContaining([expect.stringContaining("v=spf1 include:_spf.google.com ~all")]));
    await store.upsertDomainCheck(row("healthy", []));
    expect(item(await status(FULL, store), "sender_domain")).toMatchObject({ status: "done", detail: "partnersinbiz.online: SPF, DKIM and DMARC are in place." });
  });

  describe("one-click unsubscribe", () => {
    const WITH_SECRET = { ...FULL, unsubscribe: { secret: { type: "secret_ref", secretId: "u1" } } };
    const passed = (at: string) => ({ ok: true, at, detail: null, probe: "p1" });

    it("is optional until the secret and the public address are set, and the proxy rule comes first in the steps", async () => {
      const none = item(await status(FULL), "unsubscribe");
      expect(none).toMatchObject({ status: "optional", required: false, action: null });
      expect(none.steps![0]).toMatch(/^First, ask whoever runs the server to add the reverse proxy rule/);
      expect(none.steps![1]).toMatch(/pick or create a Paperclip secret of 16 or more random characters/);
      expect(none.steps!.at(-1)).toMatch(/only after that test passes/);
      expect(item(await status({ ...WITH_SECRET, publicBaseUrl: "" }), "unsubscribe").status).toBe("optional");
    });

    it("is NOT done just because the secret is saved: until the Mailbox has proved the proxy rule it is not active, and says what it found", async () => {
      const unchecked = item(await status(WITH_SECRET), "unsubscribe");
      expect(unchecked).toMatchObject({ status: "optional", action: { plugin: "partnersinbiz.mailbox", key: "mailbox.check-unsubscribe-proxy", label: "Check now" } });
      expect(unchecked.detail).toMatch(/Not active yet: the Mailbox has not checked the reverse proxy yet.*mailto unsubscribe only/);
      // The secret is set, so only the proxy and the test are left.
      expect(unchecked.steps).toHaveLength(2);
      expect(unchecked.steps![0]).toMatch(/reverse proxy rule/);
      const failed = item(await status(WITH_SECRET, setup().store, ROLES, { ok: false, at: "2026-10-03T09:30:00.000Z", detail: "The request arrived without the token: the reverse proxy does not pass the request address on." }), "unsubscribe");
      expect(failed).toMatchObject({ status: "optional" });
      expect(failed.detail).toMatch(/Not active yet: The request arrived without the token/);
      const stale = item(await status(WITH_SECRET, setup().store, ROLES, passed("2026-10-03T03:00:00.000Z")), "unsubscribe");
      expect(stale).toMatchObject({ status: "optional" });
      expect(stale.detail).toMatch(/more than 6 hours old/);
    });

    it("is done only while a passed check is recent, and then the Check now button is gone", async () => {
      const live = item(await status(WITH_SECRET, setup().store, ROLES, passed("2026-10-03T09:30:00.000Z")), "unsubscribe");
      expect(live).toMatchObject({ status: "done", action: null, steps: undefined });
      expect(live.detail).toMatch(/last passed 2026-10-03 09:30 UTC/);
      // A passed check without a secret (it was removed later) is not active either.
      expect(item(await status(FULL, setup().store, ROLES, passed("2026-10-03T09:30:00.000Z")), "unsubscribe").status).toBe("optional");
    });
  });
});

describe("the daily domain job and the hourly housekeeping", () => {
  async function boot(config: Record<string, unknown> = {}) {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20), ...config } });
    const written: Array<{ sql: string; params: unknown[] }> = [];
    const account = { id: "acc-1", company_id: CO, provider: "gmail", address: "peet@partnersinbiz.online", status: "connected", token_sealed: "sealed", is_default: true, client_kind: null, client_ref: null, from_name: null, connected_at: "2026-09-26T08:00:00.000Z", created_at: "2026-09-26T08:00:00.000Z" };
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        if (sql.includes(`SELECT DISTINCT company_id FROM ${NAMESPACE}.accounts`)) return [{ company_id: CO }];
        if (sql.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 ORDER BY address`)) return [account];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        written.push({ sql, params });
        return { rowCount: 1 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    (harness.ctx as unknown as { http: unknown }).http = { fetch: dohFetchFrom(PIB_DNS_BEFORE).fetch };
    await plugin.definition.setup(harness.ctx);
    return { harness, written, emit: vi.spyOn(harness.ctx.events, "emit") };
  }

  it("checks every sending domain once a day, records it and announces it", async () => {
    const { harness, written, emit } = await boot();
    await harness.runJob("check-domain-health");
    const insert = written.find((w) => w.sql.includes(`INSERT INTO ${NAMESPACE}.domain_checks`))!;
    expect(insert.params.slice(0, 3)).toEqual([CO, "partnersinbiz.online", "bad"]);
    const [, , , result] = insert.params;
    expect(JSON.parse(String(result))).toMatchObject({ status: "bad", spf: { state: "missing" }, dkim: { found: ["default", "resend"] } });
    expect(emit.mock.calls.filter(([name]) => name === DOMAIN_HEALTH_EVENT)).toHaveLength(1);
  });

  it("does nothing for a company that switched the checks off", async () => {
    const { harness, written } = await boot({ domainChecks: false });
    await harness.runJob("check-domain-health");
    expect(written.filter((w) => w.sql.includes("domain_checks"))).toEqual([]);
  });

  it("keeps the provider's old history trimmed one company at a time, each statement inside its own company (also when the domain checks are off)", async () => {
    for (const config of [{}, { domainChecks: false }]) {
      const { harness, written } = await boot(config);
      await harness.runJob("check-domain-health");
      const purges = written.filter((w) => /DELETE FROM \S+\.(esp_events|esp_domain_days)/.test(w.sql));
      expect(purges.map((w) => /esp_events/.test(w.sql))).toEqual([true, false]);
      for (const purge of purges) {
        expect(purge.sql).toMatch(/WHERE company_id = \$1 AND /);
        expect(purge.params[0]).toBe(CO);
      }
      // 90 days of events and 60 days of daily counts.
      expect(Date.now() - Date.parse(String(purges[0]!.params[1]))).toBeGreaterThan(89 * 86_400_000);
      expect(String(purges[1]!.params[1])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps the managed skills of every known company up to date, not only the one a call comes from", async () => {
    const { harness } = await boot();
    await harness.runJob("setup-status");
    const status = (await harness.ctx.state.get({ scopeKind: "instance", namespace: "pib-kit", stateKey: "skill-sync-status" })) as { companies: Record<string, { status: string; plugin?: string }> };
    expect(status.companies[CO]).toMatchObject({ plugin: "partnersinbiz.mailbox" });
  });

  it("every hour the Mailbox posts to its own public address to prove the unsubscribe proxy rule, and records the answer before it reports Setup", async () => {
    const { harness } = await boot({ unsubscribe: { secret: "unsubscribe-secret-0123456789" } });
    const posted: string[] = [];
    // The host's webhook route plus a proxy with the rule: the plugin gets the headers (with X-Original-Uri) and the body.
    (harness.ctx as unknown as { http: unknown }).http = {
      async fetch(url: string, init?: { body?: string; headers?: Record<string, string> }) {
        posted.push(url);
        const target = new URL(url);
        await plugin.definition.onWebhook!({ endpointKey: "unsubscribe", headers: { "x-original-uri": target.pathname + target.search }, rawBody: String(init?.body ?? ""), parsedBody: {}, requestId: "r1" });
        return { ok: true, status: 200, text: async () => "" };
      },
    };
    await harness.runJob("setup-status");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/^https:\/\/paperclip\.example\.com\/api\/plugins\/partnersinbiz\.mailbox\/webhooks\/unsubscribe\?token=/);
    expect(await harness.ctx.state.get({ scopeKind: "company", scopeId: CO, namespace: "mailbox-unsubscribe", stateKey: "proxy-proof" })).toMatchObject({ ok: true, detail: null });
  });

  it("with no unsubscribe secret the hourly job makes no request to itself", async () => {
    const { harness } = await boot();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    (harness.ctx as unknown as { http: unknown }).http = { fetch };
    await harness.runJob("setup-status");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers one company.created handler (the kit's bootstrap) and no second one", async () => {
    const { harness } = await boot();
    await harness.emit("company.created", { id: "co-new" }, { companyId: "co-new" });
    // The bootstrap remembered the new company, so the hourly sweep will reach it.
    expect((await harness.ctx.state.get({ scopeKind: "instance", namespace: "pib-kit", stateKey: "known-companies" }) as { ids: string[] }).ids).toContain("co-new");
  });
});

describe("the Cockpit snapshot", () => {
  it("reports a sender domain with no SPF, and client mail nobody mapped, as health", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com" } });
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        if (sql.includes(`FROM ${NAMESPACE}.domain_checks WHERE company_id = $1 ORDER BY domain`)) {
          return [{ company_id: CO, domain: "partnersinbiz.online", status: "bad", source: "account", client_kind: null, client_ref: null, checked_at: new Date().toISOString(), first_checked_at: new Date().toISOString(), status_since: "2026-10-03T05:17:00.000Z", dmarc_none_since: null, result: { problems: [{ code: "spf_missing", severity: "bad", message: "partnersinbiz.online has no SPF record.", fix: "Add the SPF record." }] } }];
        }
        if (sql.includes("map_state = 'needs_mapping'")) return [{ domain: "ahslaw.co.za", n: 3, last_at: null, sample_id: "m1" }];
        return [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    const snap = await cockpitSnapshot(harness.ctx, CO, Date.now());
    expect(snap.health.find((h) => h.key === "mailbox:domain:partnersinbiz.online")).toMatchObject({ status: "bad", detail: "partnersinbiz.online has no SPF record.", fix: "Add the SPF record.", since: "2026-10-03T05:17:00.000Z" });
    expect(snap.health.find((h) => h.key === "mailbox:client-mail-unmapped")).toMatchObject({
      status: "warn",
      detail: "3 messages in the last 30 days look like a client's mail (ahslaw.co.za) but are filed as the company's own.",
      href: "/mailbox",
    });
  });
});

describe("the mail contract is unchanged for everyone else", () => {
  it("still listens to every mail sender, and answers a request with no new field exactly as before", async () => {
    const { env, gmail } = setup();
    const { handleSendRequested } = await import("../src/gmail/send.js");
    const result = await handleSendRequested(env, { eventId: "e", eventType: pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested) as never, occurredAt: "", companyId: CO, payload: { key: "billing:inv-1:send", to: [{ email: "ann@client.co.za" }], subject: "Invoice", text: "Hi", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1", clientKind: "company", clientRef: "crm-co-1" } } });
    expect(result).toMatchObject({ status: "sent", permanent: false });
    expect(result).not.toHaveProperty("warnings");
    expect(gmail.sent[0]!.mime).not.toContain("Reply-To:");
    expect(gmail.sent[0]!.mime).not.toContain("List-Unsubscribe");
  });
});
