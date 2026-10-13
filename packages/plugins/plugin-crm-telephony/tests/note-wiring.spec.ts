import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_VERSION } from "../src/namespace.js";
import packageJson from "../package.json" with { type: "json" };

describe("CRM Telephony note wiring", () => {
  it("manifest capabilities include 'events.emit'", () => {
    const caps = manifest.capabilities ?? [];
    expect(caps).toContain("events.emit");
  });

  it("package.json version equals manifest version", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("PLUGIN_VERSION matches package.json version", () => {
    expect(PLUGIN_VERSION).toBe(packageJson.version);
  });
});
