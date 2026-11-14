import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";
import type { Company } from "@paperclipai/shared";

const manifest = {
  id: "paperclip.test-companies",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Companies",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "./worker.js" },
} satisfies PaperclipPluginManifestV1;

const companies = ["company-1", "company-2", "company-3"].map((id) => ({ id, name: id }) as unknown as Company);
const ids = (rows: Company[]) => rows.map((row) => row.id);

describe("createTestHarness companies.list actionableOnly (PAR-11072 T2)", () => {
  it("defaults to every seeded company", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies });
    expect(ids(await harness.ctx.companies.list({ actionableOnly: true }))).toEqual(["company-1", "company-2", "company-3"]);
  });

  it("honours the actionable set, before limit and offset", async () => {
    const harness = createTestHarness({ manifest, actionableCompanyIds: ["company-3"] });
    harness.seed({ companies });
    expect(ids(await harness.ctx.companies.list({ actionableOnly: true, limit: 1 }))).toEqual(["company-3"]);
    expect(ids(await harness.ctx.companies.list({ limit: 1 }))).toEqual(["company-1"]);

    harness.setActionableCompanyIds(["company-1", "company-2"]);
    expect(ids(await harness.ctx.companies.list({ actionableOnly: true, offset: 1 }))).toEqual(["company-2"]);
    harness.setActionableCompanyIds([]);
    expect(await harness.ctx.companies.list({ actionableOnly: true })).toEqual([]);
    harness.setActionableCompanyIds(null);
    expect(ids(await harness.ctx.companies.list({ actionableOnly: true }))).toHaveLength(3);
  });
});
