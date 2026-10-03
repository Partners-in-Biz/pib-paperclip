import { describe, expect, it } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import { setupStatus } from "../src/setup-status.js";
import { CO, tool } from "./helpers/crm.js";
import { bootLeads, makeSource } from "./helpers/leads.js";

// The kit remembers the plugin's public address in the module, so this file keeps "before" and "after" in one order.
const UI_BASE = "/_plugins/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/ui/";

describe("until the plugin knows its public address", () => {
  it("the tool still makes the form and says to open the CRM page once; no snippet is invented", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "Quote form" });
    expect(made.created).toBe(true);
    expect(made.source.embed).toBeNull();
    expect(made.source.embedNote).toMatch(/Open the CRM page once/);
    expect(made.next).toMatch(/Open the CRM page once/);
    const listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(listed.note).toMatch(/Open the CRM page once/);
  });

  it("the setup item says the same instead of showing a snippet", async () => {
    const booted = await bootLeads();
    await makeSource(booted, {});
    const item = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key.startsWith("lead-form:"))!;
    expect(item.steps).toEqual([expect.stringMatching(/Open the CRM page once/)]);
  });

  it("once the CRM page reports its address the snippet appears for forms that already exist", async () => {
    const booted = await bootLeads();
    await makeSource(booted, {});
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    const listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(listed.sources[0].embed.snippet).toContain(`${UI_BASE}lead.js`);
    expect(listed.note).toBeUndefined();
  });
});
