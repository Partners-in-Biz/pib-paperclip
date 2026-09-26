import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { rememberPluginUiBase, SETUP_STATUS_ROUTE, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE, PLUGIN_VERSION } from "../src/namespace.js";
import { setupStatus } from "../src/setup-status.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";

const CO = "co-1";
const SETUP_EVENT = "plugin.partnersinbiz.setup.modules.updated";
const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

const ROUTES: Route[] = [
  [/SELECT DISTINCT company_id/, (_p, s) => [...new Set((s.campaigns ?? []).map((row) => row.company_id))].map((company_id) => ({ company_id }))],
  [/campaign_id IN \(SELECT id FROM/, (_p, s) => {
    const active = new Set((s.campaigns ?? []).filter((c) => c.status === "active").map((c) => c.id));
    return (s.campaign_enrollments ?? []).filter((e) => e.status === "running" && e.open_issue_id == null && e.sending_key == null && e.next_due_at && Date.parse(e.next_due_at) <= Date.now() && active.has(e.campaign_id));
  }],
  [/JOIN \S+\.outbox o/, () => []],
];

function campaign(id: string, extra: Row = {}): Row {
  return {
    id, company_id: CO, name: id, description: "", status: "active", from_name: "", from_local: "campaigns", reply_to: null, audience_tags: [],
    start_at: null, end_at: null, approval_issue_id: null, winner_variant: null, client_kind: null, client_ref: null, client_name: null,
    audience_mode: "tags", delivery: "issue", owner_user_id: null, owner_agent_id: null, ...extra,
  };
}

function seed(campaigns: Row[]): Store {
  return {
    crm_companies: [],
    crm_contacts: [{ id: "ada", company_id: CO, name: "Ada", emails: ["ada@acme.test"], phones: [], lifecycle: "lead", tags: [], account_ids: [], updated_at: "2026-01-01T00:00:00Z", deleted: false }],
    campaigns,
    campaign_steps: [{ id: "c1-1a", company_id: CO, campaign_id: "camp-issue", position: 1, delay_days: 0, subject: "Manual", body: "Send by hand", html_body: null, variant: "a" }],
    campaign_enrollments: [],
    campaign_step_events: [],
    suppressions: [],
    outbox: [],
    inbox: [],
    decisions: [],
  };
}

async function boot(options: { config?: Record<string, unknown>; campaigns?: Row[] } = {}) {
  const store = seed(options.campaigns ?? [campaign("camp-issue")]);
  const harness = createTestHarness({ manifest, config: options.config ?? { timezone: "Africa/Johannesburg" } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  const db = createFakeDb(store, { namespace: NAMESPACE, coreReadTables: ["heartbeat_runs", "issues"], routes: ROUTES });
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, emit };
}

const item = (status: SetupStatus, key: string) => status.items.find((row) => row.key === key)!;

describe("Campaigns setup status", () => {
  it("declares the setup route and job, and bumps the version", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: SETUP_STATUS_ROUTE.routeKey, path: "/setup-status" }));
    expect(manifest.jobs?.map((job) => job.jobKey)).toContain("setup-status");
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["api.routes.register", "events.emit"]));
    expect(manifest.version).toBe("0.3.2");
    expect(PLUGIN_VERSION).toBe("0.3.2");
  });

  it("an unconfigured company: settings missing, Jev and Mailbox optional", async () => {
    const { harness } = await boot({ config: {} });
    const status = await setupStatus(harness.ctx, CO);
    expect(status).toMatchObject({ plugin: "partnersinbiz.campaigns", module: "campaigns", title: "Campaigns" });
    expect(status.items.map((row) => row.key)).toEqual(["settings", "jev", "mailbox"]);
    expect(item(status, "settings")).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    expect(item(status, "jev")).toMatchObject({ status: "optional", required: false });
    expect(item(status, "mailbox")).toMatchObject({ status: "optional", required: false, href: "/mailbox" });
  });

  it("a configured company with a Jev key", async () => {
    const { harness } = await boot({ config: { timezone: "Africa/Johannesburg", jev: { apiKey: { type: "secret_ref", secretId: "sec-1" } } } });
    const status = await setupStatus(harness.ctx, CO);
    expect(item(status, "settings").status).toBe("done");
    expect(item(status, "jev").status).toBe("done");
  });

  it("active email campaigns with the Mailbox module off are blocked", async () => {
    const { harness } = await boot({ campaigns: [campaign("camp-mail", { delivery: "email" })] });
    expect(item(await setupStatus(harness.ctx, CO), "mailbox").status).toBe("optional");
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { mailbox: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: CO });
    expect(item(await setupStatus(harness.ctx, CO), "mailbox").status).toBe("blocked");
  });

  it("serves GET /setup-status and publishes it hourly", async () => {
    const { harness, emit } = await boot();
    const response = await plugin.definition.onApiRequest!({
      routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as SetupStatus).plugin).toBe("partnersinbiz.campaigns");
    await harness.runJob("setup-status");
    expect(emit).toHaveBeenCalledWith("setup.status", CO, expect.objectContaining({ plugin: "partnersinbiz.campaigns" }));
  });

  it("does not publish for a company without saved settings", async () => {
    const { harness, emit } = await boot({ config: {} });
    await harness.runJob("setup-status");
    expect(emit).not.toHaveBeenCalledWith("setup.status", expect.anything(), expect.anything());
  });
});

describe("Campaigns module switch", () => {
  it("open-due-steps skips a company that switched Campaigns off", async () => {
    const { harness, store } = await boot();
    store.campaign_enrollments = [{
      id: "e1", company_id: CO, campaign_id: "camp-issue", contact_id: "ada", status: "running", step_position: 1, variant: "a",
      next_due_at: "2026-09-01T08:00:00.000Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null,
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    }];
    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { campaigns: false }, updatedAt: "2026-09-26T08:00:00Z" }, { companyId: CO });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(0);

    await harness.emit(SETUP_EVENT, { companyId: CO, modules: { campaigns: true }, updatedAt: "2026-09-26T09:00:00Z" }, { companyId: CO });
    await harness.runJob("open-due-steps");
    expect(await harness.ctx.issues.list({ companyId: CO })).toHaveLength(1);
  });
});

// Last: the kit caches the UI base for the rest of the module's life.
describe("Campaigns settings link", () => {
  it("links the plugin's own settings page once the installation uuid is known", async () => {
    const { harness } = await boot();
    await rememberPluginUiBase(harness.ctx, `/_plugins/${UUID}/ui/`);
    expect(item(await setupStatus(harness.ctx, CO), "settings").href).toBe(`/company/settings/instance/plugins/${UUID}`);
  });
});
