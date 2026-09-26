import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MAIL_EVENTS, PIB_PLUGINS, pluginEvent, rememberPluginUiBase, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE, PLUGIN_VERSION } from "../src/namespace.js";
import { handleSendRequested, MAILBOX_OFF } from "../src/gmail/send.js";
import { runSyncJob } from "../src/gmail/sync.js";
import { missingSettings, setupStatus, SYNC_HEALTHY_MS } from "../src/setup-status.js";
import { CO, MemoryStore } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = Date.parse("2026-09-26T10:00:00Z");
const FULL = {
  publicBaseUrl: "https://paperclip.example.com",
  encryptionKey: { type: "secret_ref", secretId: "sec-enc" },
  google: { clientId: "client-id", clientSecret: { type: "secret_ref", secretId: "sec-google" } },
};

function harnessCtx(config: Record<string, unknown>): PluginContext {
  const harness = createTestHarness({ manifest, config });
  return harness.ctx;
}

const item = (status: SetupStatus, key: string) => status.items.find((row) => row.key === key)!;

/** Stand-in state that reports the company switched the given modules off. */
function switchedOff(ctx: PluginContext, modules: Record<string, boolean>) {
  (ctx as unknown as { state: unknown }).state = {
    get: async (key: { namespace?: string; stateKey?: string }) =>
      key.namespace === "pib-setup" && key.stateKey === "modules" ? { companyId: CO, modules, updatedAt: "2026-09-26T08:00:00Z" } : null,
    set: async () => undefined,
  };
}

describe("Mailbox setup status", () => {
  it("names each missing Gmail setting", () => {
    expect(missingSettings({})).toEqual(["Public base URL", "Token encryption key", "Google client secret"]);
    expect(missingSettings({ publicBaseUrl: "https://x.test", encryptionKey: { type: "secret_ref", secretId: "s" } })).toEqual(["Google client secret"]);
    expect(missingSettings(FULL)).toEqual([]);
  });

  it("an unconfigured company: settings missing, Gmail missing, the rest waits on Gmail", async () => {
    const status = await setupStatus(harnessCtx({}), CO, new MemoryStore(), NOW);
    expect(status).toMatchObject({ plugin: "partnersinbiz.mailbox", module: "mailbox", title: "Mailbox", version: PLUGIN_VERSION });
    expect(status.items.map((row) => row.key)).toEqual(["settings", "gmail", "default_account", "jev", "sync"]);
    const settings = item(status, "settings");
    expect(settings).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    expect(settings.detail).toContain("Public base URL, Token encryption key, Google client secret");
    expect(item(status, "gmail")).toMatchObject({ status: "missing", required: true, href: "/mailbox", blockedBy: ["settings"] });
    expect(item(status, "gmail").steps!.join(" ")).toMatch(/unverified app/);
    expect(item(status, "gmail").steps![0]).toMatch(/Open the Mailbox page once/);
    expect(item(status, "default_account")).toMatchObject({ status: "missing", blockedBy: ["gmail"], action: null });
    expect(item(status, "jev")).toMatchObject({ status: "optional", required: false });
    expect(item(status, "sync")).toMatchObject({ status: "missing", blockedBy: ["gmail"] });
  });

  it("saved but without the Google client secret says only that", async () => {
    const status = await setupStatus(harnessCtx({ publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) }), CO, new MemoryStore(), NOW);
    expect(item(status, "settings")).toMatchObject({ status: "missing", detail: "Still needed: Google client secret." });
  });

  it("a healthy company: connected default account synced recently", async () => {
    const store = new MemoryStore();
    store.addAccount({ id: "acc-1", company_id: CO, address: "peet@partnersinbiz.online", token_sealed: "sealed", is_default: true, last_sync_at: new Date(NOW - 60_000).toISOString() });
    const status = await setupStatus(harnessCtx({ ...FULL, jev: { apiKey: { type: "secret_ref", secretId: "sec-jev" } } }), CO, store, NOW);
    for (const key of ["settings", "gmail", "default_account", "jev", "sync"]) expect(item(status, key).status, key).toBe("done");
    expect(item(status, "default_account").detail).toContain("peet@partnersinbiz.online");
  });

  it("one connected account without a default offers to make it the default", async () => {
    const store = new MemoryStore();
    store.addAccount({ id: "acc-1", company_id: CO, address: "peet@partnersinbiz.online", token_sealed: "sealed", is_default: false, last_sync_at: new Date(NOW).toISOString() });
    const status = await setupStatus(harnessCtx(FULL), CO, store, NOW);
    expect(item(status, "default_account")).toMatchObject({
      status: "missing",
      action: { plugin: "partnersinbiz.mailbox", key: "mailbox.set-default", params: { accountId: "acc-1" } },
    });
  });

  it("a sync older than 10 minutes is blocked and carries the last error", async () => {
    const store = new MemoryStore();
    store.addAccount({ id: "acc-1", company_id: CO, address: "peet@partnersinbiz.online", token_sealed: "sealed", is_default: true, last_sync_at: new Date(NOW - SYNC_HEALTHY_MS - 1000).toISOString(), last_error: "Gmail said 500" });
    const status = await setupStatus(harnessCtx(FULL), CO, store, NOW);
    expect(item(status, "sync")).toMatchObject({ status: "blocked", required: true });
    expect(item(status, "sync").detail).toContain("Last error: Gmail said 500");
  });

  it("an account that needs reconnecting blocks the Gmail item", async () => {
    const store = new MemoryStore();
    store.addAccount({ id: "acc-1", company_id: CO, address: "peet@partnersinbiz.online", token_sealed: "sealed", status: "needs_reconnect" });
    const status = await setupStatus(harnessCtx(FULL), CO, store, NOW);
    expect(item(status, "gmail")).toMatchObject({ status: "blocked" });
    expect(item(status, "gmail").detail).toMatch(/must be reconnected/);
  });

  it("serves GET /setup-status and publishes it from the hourly job", async () => {
    const harness = createTestHarness({ manifest, config: FULL });
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        if (/SELECT DISTINCT company_id FROM/.test(sql)) return [{ company_id: CO }];
        return [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    await plugin.definition.setup(harness.ctx);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    const response = await plugin.definition.onApiRequest!({
      routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as SetupStatus).plugin).toBe("partnersinbiz.mailbox");
    await harness.runJob("setup-status");
    expect(emit).toHaveBeenCalledWith("setup.status", CO, expect.objectContaining({ plugin: "partnersinbiz.mailbox" }));
  });
});

describe("Mailbox module switch", () => {
  it("the sync job skips a company that switched the Mailbox off", async () => {
    const { env, gmail, host } = setup();
    switchedOff(host.ctx, { mailbox: false });
    const result = await runSyncJob(env);
    expect(result).toMatchObject({ accounts: 1, synced: 0, failed: 0 });
    expect(gmail.calls).toHaveLength(0);
  });

  it("another module being off does not stop the sync", async () => {
    const { env, host } = setup();
    switchedOff(host.ctx, { crm: false, billing: false });
    const result = await runSyncJob(env);
    expect(result.synced).toBe(1);
  });

  it("answers send requests with a permanent failure while the Mailbox is off", async () => {
    const { env, gmail, host } = setup();
    switchedOff(host.ctx, { mailbox: false });
    const event: PluginEvent = {
      eventId: "ev-1",
      eventType: pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested) as PluginEvent["eventType"],
      occurredAt: new Date().toISOString(),
      companyId: CO,
      payload: { key: "billing:invoice:inv-1:send", to: [{ email: "ann@client.co.za" }], subject: "Invoice", text: "Hi", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "inv-1" } },
    };
    const result = await handleSendRequested(env, event);
    expect(result).toMatchObject({ status: "failed", permanent: true, error: MAILBOX_OFF });
    expect(gmail.sent).toHaveLength(0);
    expect(host.emitted.find((e) => e.name === MAIL_EVENTS.sendResult)?.payload).toMatchObject({ status: "failed" });
  });

  it("still sends for other plugins when their modules are off", async () => {
    const { env, gmail, host } = setup();
    switchedOff(host.ctx, { billing: false });
    const event: PluginEvent = {
      eventId: "ev-2",
      eventType: pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested) as PluginEvent["eventType"],
      occurredAt: new Date().toISOString(),
      companyId: CO,
      payload: { key: "billing:invoice:inv-2:send", to: [{ email: "ann@client.co.za" }], subject: "Invoice", text: "Hi", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "inv-2" } },
    };
    const result = await handleSendRequested(env, event);
    expect(result).toMatchObject({ status: "sent" });
    expect(gmail.sent).toHaveLength(1);
  });
});

// Last: the kit caches the UI base for the rest of the module's life.
describe("Mailbox settings link", () => {
  it("links the plugin's own settings page and shows the redirect URI once the page reported its uuid", async () => {
    const ctx = harnessCtx(FULL);
    await rememberPluginUiBase(ctx, `/_plugins/${UUID}/ui/`);
    const status = await setupStatus(ctx, CO, new MemoryStore(), NOW);
    expect(item(status, "settings").href).toBe(`/company/settings/instance/plugins/${UUID}`);
    expect(item(status, "gmail").steps![0]).toContain(`https://paperclip.example.com/_plugins/${UUID}/ui/oauth-callback.html`);
  });
});
