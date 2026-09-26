import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { SEO_TOOLS } from "../src/tools.js";

/**
 * The SDK harness enforces the manifest's capabilities on every ctx call, so
 * these smoke tests catch a host call the manifest forgot to declare.
 */
describe("worker wiring", () => {
  async function boot() {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  it("registers every tool and runs one", async () => {
    const harness = await boot();
    for (const tool of SEO_TOOLS) await expect(harness.executeTool(tool.name, {}, { companyId: "co-1" })).resolves.toBeDefined();
    const result = await harness.executeTool<{ data?: { sprints: unknown[] }; error?: string }>("list-sprints", {}, { companyId: "co-1" });
    expect(result.error).toBeUndefined();
    expect(result.data?.sprints).toEqual([]);
  });

  it("serves the page load action and runs both jobs with no sprints", async () => {
    const harness = await boot();
    const uiBase = "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/";
    const load = await harness.performAction<{ settings: { saved: boolean; redirectUri: string } }>("seo.load", { uiBase }, { companyId: "co-1", actor: { type: "user", userId: "user-1" } });
    expect(load.settings.saved).toBe(true);
    // The host serves plugin files only by installation uuid, which the page reports.
    expect(load.settings.redirectUri).toBe(`https://paperclip.partnersinbiz.online${uiBase}oauth-callback.html`);
    await harness.runJob("seo-daily");
    await harness.runJob("seo-weekly");
    await harness.emit("issue.updated", {}, { entityId: "iss-1", companyId: "co-1" });
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("validates config", async () => {
    const result = await plugin.definition.onValidateConfig!({ timezone: "Bad/Zone" });
    expect(result.ok).toBe(false);
  });
});
