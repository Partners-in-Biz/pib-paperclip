import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";

// PAR-11072 T2: the real host service filters `companies.list` before the
// limit/offset window, driven through the real SDK gate.
const COMPANIES = ["company-1", "company-2", "company-3", "company-4"].map((id) => ({ id, name: id }));

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    list: vi.fn(async () => COMPANIES),
    getById: vi.fn(async (id: string) => COMPANIES.find((c) => c.id === id) ?? null),
  }),
}));

function eventBusStub() {
  return { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never;
}

function handlers() {
  return createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities: ["companies.read"],
    services: buildHostServices({} as never, "plugin-record-id", "test.plugin", eventBusStub()),
  });
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe("companies.list host service (PAR-11072 T2)", () => {
  it("a call that never sends the param gets every company, windowed as today", async () => {
    const list = handlers()["companies.list"];
    expect(ids(await list({}, {}))).toEqual(["company-1", "company-2", "company-3", "company-4"]);
    expect(ids(await list({ limit: 2, offset: 1 }, {}))).toEqual(["company-2", "company-3"]);
  });

  it("outside an invocation, actionableOnly filters to the configured set before the window", async () => {
    const list = handlers()["companies.list"];
    // company-4 sits past `limit: 1` in the full list; it still comes back.
    expect(ids(await list({ actionableOnly: true, limit: 1 }, { actionableCompanyIds: ["company-4"] })))
      .toEqual(["company-4"]);
    expect(ids(await list({ actionableOnly: true, limit: 1, offset: 1 }, { actionableCompanyIds: ["company-2", "company-4"] })))
      .toEqual(["company-4"]);
  });

  it("inside an invocation, the invocation filter runs before the window too", async () => {
    const list = handlers()["companies.list"];
    const context = { invocationScope: { companyId: "company-3" } };
    expect(ids(await list({ limit: 1 }, context))).toEqual(["company-3"]);
    expect(ids(await list({ actionableOnly: true, limit: 1 }, context))).toEqual(["company-3"]);
  });
});
