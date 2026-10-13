import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_VERSION } from "../src/namespace.js";
import packageJson from "../package.json" with { type: "json" };

const VALID_CAPS = new Set([
  "database.namespace.read", "database.namespace.write", "database.namespace.migrate",
  "http.outbound", "issues.create", "secrets.read-ref", "jobs.schedule", "webhooks.receive",
  "agent.tools.register", "companies.read", "ui.page.register",
]);

describe("CRM Telephony manifest", () => {
  it("version matches package.json", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("capabilities are valid", () => {
    const caps = manifest.capabilities ?? [];
    const invalid = caps.filter((c) => !VALID_CAPS.has(c));
    expect(invalid).toEqual([]);
  });

  it("has agent.tools.register capability", () => {
    const caps = manifest.capabilities ?? [];
    expect(caps).toContain("agent.tools.register");
  });

  it("has ui.page.register capability", () => {
    const caps = manifest.capabilities ?? [];
    expect(caps).toContain("ui.page.register");
  });

  it("does not have appShellOverlay capability", () => {
    const caps = manifest.capabilities ?? [];
    expect(caps).not.toContain("ui.appShellOverlay.register");
  });

  it("has only one UI slot (dialer-page)", () => {
    const slots = manifest.ui?.slots ?? [];
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe("dialer-page");
    expect(slots[0].exportName).toBe("DialerPage");
    expect(slots[0].type).toBe("page");
  });

  it("has telephony-status tool", () => {
    const tools = manifest.tools ?? [];
    const tool = tools.find((t) => t.name === "telephony-status");
    expect(tool).toBeDefined();
    expect(tool?.displayName).toBeTruthy();
    expect(tool?.description).toBeTruthy();
  });

  it("has 6 webhooks with required fields", () => {
    const webhooks = manifest.webhooks ?? [];
    expect(webhooks).toHaveLength(6);
    for (const w of webhooks) {
      expect(w.endpointKey).toBeTruthy();
      expect(w.displayName).toBeTruthy();
    }
  });

  it("media-pipeline job schedule is */1 * * * *", () => {
    const job = manifest.jobs?.find((j) => j.jobKey === "media-pipeline");
    expect(job?.schedule).toBe("*/1 * * * *");
  });

  it("database has correct namespace and migrations dir", () => {
    expect(manifest.database?.namespaceSlug).toBe("crm_telephony");
    expect(manifest.database?.migrationsDir).toBe("migrations");
  });

  it("src and migrations contain no Twilio SID patterns", () => {
    const source = JSON.stringify(manifest);
    expect(source).not.toMatch(/\b(?:AC|SK)[0-9a-f]{32}\b/);
  });
});
