import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { rememberPluginUiBase, SETUP_STATUS_ROUTE, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE, PLUGIN_VERSION } from "../src/namespace.js";
import { setupStatus } from "../src/setup-status.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";

const CO = "co-1";
const BOARD = { type: "user" as const, userId: "local-board" };
const SETUP_EVENT = "plugin.partnersinbiz.setup.modules.updated";
const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

const ROUTES: Route[] = [
  [/\bUNION\b/, (_p, s) => [...new Set([...(s.companies ?? []), ...(s.contacts ?? [])].map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/make_interval/, () => []],
  [/record_grants/, () => []],
];

function seed(withRows: boolean): Store {
  const contact: Row = {
    id: "ada", company_id: CO, name: "Ada", emails: ["ada@acme.test"], phones: [], lifecycle: "lead", custom: {}, human_owned_fields: [],
    owner_user_id: null, assignee_agent_id: null, tags: [], next_action_kind: null, next_action_due_at: null, email_status: "ok",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  return {
    companies: withRows ? [{ id: "acme", company_id: CO, name: "Acme", domain: null, lifecycle: "lead", currency: "ZAR", custom: {}, human_owned_fields: [], tags: [], updated_at: "2026-01-01T00:00:00Z" }] : [],
    contacts: withRows ? [contact] : [],
    contact_companies: [],
    sequences: withRows
      ? [
          { id: "seq-intro", company_id: CO, name: "Intro", completion_mode: "manual", delivery: "issue", email_approval_issue_id: null, email_approved_at: null, email_approved_by: null },
          { id: "seq-mail", company_id: CO, name: "Cold", completion_mode: "sent", delivery: "email", email_approval_issue_id: null, email_approved_at: null, email_approved_by: null },
        ]
      : [],
    sequence_steps: [{ id: "s1", company_id: CO, sequence_id: "seq-intro", position: 1, delay_minutes: 0, title: "Say hello", body: "Call them" }],
    enrollments: [],
    record_grants: [],
    outbox: [],
    inbox: [],
    facts: [],
    activities: [],
  };
}

async function boot(options: { config?: Record<string, unknown>; rows?: boolean } = {}) {
  const store = seed(options.rows ?? true);
  const harness = createTestHarness({ manifest, config: options.config ?? { timezone: "Africa/Johannesburg" } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, { namespace: NAMESPACE, coreReadTables: ["heartbeat_runs", "issues"], routes: ROUTES });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, emit };
}

const item = (status: SetupStatus, key: string) => status.items.find((row) => row.key === key)!;

describe("CRM setup status", () => {
  it("declares the setup route and the hourly status job, and bumps the version", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: SETUP_STATUS_ROUTE.routeKey, path: "/setup-status" }));
    expect(manifest.jobs?.map((job) => job.jobKey)).toContain("setup-status");
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["api.routes.register", "events.emit", "plugin.state.read"]));
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(PLUGIN_VERSION).toBe("0.3.1");
  });

  it("an unconfigured company: settings missing, the rest optional, settings link falls back to the plugin list", async () => {
    const { harness } = await boot({ config: {}, rows: false });
    const status = await setupStatus(harness.ctx, CO);
    expect(status).toMatchObject({ plugin: "partnersinbiz.crm", module: "crm", title: "CRM", version: PLUGIN_VERSION });
    expect(status.items.map((row) => row.key)).toEqual(["settings", "jev", "clients", "shared", "mailbox"]);
    expect(item(status, "settings")).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    expect(item(status, "jev")).toMatchObject({ status: "optional", required: false });
    expect(item(status, "jev").detail).toMatch(/lead scoring and reply classification/);
    expect(item(status, "clients")).toMatchObject({ status: "optional", required: false, href: "/crm" });
    expect(item(status, "shared")).toMatchObject({ status: "optional", required: false, action: null });
    expect(item(status, "mailbox")).toMatchObject({ status: "optional", href: "/mailbox" });
  });

  it("a configured company with clients: sharing is required until the resync action runs", async () => {
    const { harness } = await boot({ config: { timezone: "Africa/Johannesburg", jev: { apiKey: { type: "secret_ref", secretId: "sec-1" } } } });
    let status = await setupStatus(harness.ctx, CO);
    expect(item(status, "settings")).toMatchObject({ status: "done" });
    expect(item(status, "jev")).toMatchObject({ status: "done" });
    expect(item(status, "clients")).toMatchObject({ status: "done" });
    expect(item(status, "shared")).toMatchObject({
      status: "missing",
      required: true,
      action: { plugin: "partnersinbiz.crm", key: "crm.resync", label: "Send clients to the other plugins" },
    });

    await harness.performAction("crm.resync", {}, { companyId: CO, actor: BOARD });
    status = await setupStatus(harness.ctx, CO);
    expect(item(status, "shared")).toMatchObject({ status: "done" });
  });

  it("a Jev key that is switched off does not count", async () => {
    const { harness } = await boot({ config: { jev: { apiKey: "raw-key", enabled: false } } });
    expect(item(await setupStatus(harness.ctx, CO), "jev").status).toBe("optional");
  });

  it("email sequences with the Mailbox module off are blocked", async () => {
    const { harness } = await boot();
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { mailbox: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: CO });
    expect(item(await setupStatus(harness.ctx, CO), "mailbox").status).toBe("blocked");
  });

  it("serves GET /setup-status", async () => {
    const { harness } = await boot();
    const response = await plugin.definition.onApiRequest!({
      routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as SetupStatus).plugin).toBe("partnersinbiz.crm");
    expect(harness).toBeTruthy();
  });

  it("the setup-status job publishes setup.status for known companies with saved settings", async () => {
    const { harness, emit } = await boot();
    await harness.runJob("setup-status");
    expect(emit).toHaveBeenCalledWith("setup.status", CO, expect.objectContaining({ plugin: "partnersinbiz.crm" }));
  });

  it("the setup-status job skips companies without saved settings", async () => {
    const { harness, emit } = await boot({ config: {} });
    await harness.runJob("setup-status");
    expect(emit).not.toHaveBeenCalledWith("setup.status", expect.anything(), expect.anything());
  });
});

describe("CRM module switch", () => {
  it("open-due-steps skips a company that switched the CRM off, and resumes when it is on again", async () => {
    const { harness, store } = await boot();
    store.enrollments = [{
      id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1,
      next_due_at: "2026-09-01T08:00:00.000Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null,
      created_at: "2026-09-01T00:00:00Z",
    }];
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { crm: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: CO });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);

    // An older switch message does not win over a newer one.
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { crm: true }, updatedAt: "2026-09-26T07:00:00Z" }, { companyId: CO });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);

    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { crm: true }, updatedAt: "2026-09-26T09:00:00Z" }, { companyId: CO });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(1);
  });

  it("emit-all skips a switched-off company", async () => {
    const { harness, emit } = await boot();
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { crm: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: CO });
    await harness.runJob("emit-all");
    expect(emit).not.toHaveBeenCalledWith("company.upserted", expect.anything(), expect.anything());
  });
});

// Last: the kit caches the UI base for the rest of the module's life.
describe("CRM settings link", () => {
  it("links the plugin's own settings page once the page reported its installation uuid", async () => {
    const { harness } = await boot();
    await rememberPluginUiBase(harness.ctx, `/_plugins/${UUID}/ui/`);
    const status = await setupStatus(harness.ctx, CO);
    expect(item(status, "settings").href).toBe(`/company/settings/instance/plugins/${UUID}`);
    expect(item(status, "jev").href).toBe(`/company/settings/instance/plugins/${UUID}`);
  });
});
