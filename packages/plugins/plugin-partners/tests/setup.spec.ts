import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { SETUP_STATUS_ROUTE, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE, PLUGIN_VERSION } from "../src/namespace.js";
import { setupStatus } from "../src/setup-status.js";

const CO = "co-1";

type Link = { id: string; company_a_id: string; company_b_id: string; status: string };

/** Just the two link reads the setup status makes. */
function fakeDb(links: Link[]) {
  return {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      if (!sql.includes(`${NAMESPACE}.links`)) return [];
      if (/status = 'active'/.test(sql)) {
        return links.filter((link) => link.status === "active" && (link.company_a_id === params[0] || link.company_b_id === params[0])).map((link) => ({ id: link.id }));
      }
      return links.map((link) => ({ company_a_id: link.company_a_id, company_b_id: link.company_b_id }));
    },
    async execute() {
      return { rowCount: 0 };
    },
  };
}

async function boot(options: { config?: Record<string, unknown>; links?: Link[] } = {}) {
  const harness = createTestHarness({ manifest, config: options.config ?? { requireOwnerForGrants: true } });
  (harness.ctx as unknown as { db: ReturnType<typeof fakeDb> }).db = fakeDb(options.links ?? []);
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, emit };
}

const item = (status: SetupStatus, key: string) => status.items.find((row) => row.key === key)!;

describe("Partners setup status", () => {
  it("declares the route, the job and the capabilities, and bumps the version", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: SETUP_STATUS_ROUTE.routeKey, path: "/setup-status" }));
    expect(manifest.jobs?.map((job) => job.jobKey)).toEqual(["setup-status"]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["api.routes.register", "jobs.schedule", "events.emit"]));
    expect(manifest.version).toBe("0.1.1");
    expect(PLUGIN_VERSION).toBe("0.1.1");
  });

  it("unconfigured: settings missing, the partner link optional", async () => {
    const { harness } = await boot({ config: {} });
    const status = await setupStatus(harness.ctx, CO);
    expect(status).toMatchObject({ plugin: "partnersinbiz.partners", module: "partners", title: "Partners" });
    expect(status.items.map((row) => row.key)).toEqual(["settings", "link"]);
    expect(item(status, "settings")).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    expect(item(status, "link")).toMatchObject({ status: "optional", required: false, href: "/partners" });
  });

  it("configured with an active link: everything done", async () => {
    const { harness } = await boot({ links: [{ id: "l1", company_a_id: CO, company_b_id: "co-2", status: "active" }] });
    const status = await setupStatus(harness.ctx, CO);
    expect(item(status, "settings").status).toBe("done");
    expect(item(status, "link")).toMatchObject({ status: "done", detail: "1 active partner link." });
  });

  it("serves GET /setup-status and publishes for linked companies with saved settings", async () => {
    const { harness, emit } = await boot({ links: [{ id: "l1", company_a_id: CO, company_b_id: "co-2", status: "pending" }] });
    const response = await plugin.definition.onApiRequest!({
      routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as SetupStatus).plugin).toBe("partnersinbiz.partners");
    await harness.runJob("setup-status");
    expect(emit).toHaveBeenCalledWith("setup.status", CO, expect.objectContaining({ plugin: "partnersinbiz.partners" }));
    expect(emit).toHaveBeenCalledWith("setup.status", "co-2", expect.anything());
  });

  it("an unknown route is a 404", async () => {
    await boot();
    const response = await plugin.definition.onApiRequest!({
      routeKey: "nope", method: "GET", path: "/nope", params: {}, query: {}, body: null,
      actor: { actorType: "user", actorId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(404);
  });
});
