import { readFileSync } from "node:fs";
import { PLUGIN_CAPABILITIES } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("manifest", () => {
  it("includes agents.read and agent.tools.register capabilities", () => {
    expect(manifest.capabilities).toContain("agents.read");
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("manifest version matches package.json version", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.version).toBe(packageJson.version);
  });

  it("every capability is a member of PLUGIN_CAPABILITIES", () => {
    for (const capability of manifest.capabilities) {
      expect(PLUGIN_CAPABILITIES).toContain(capability);
    }
  });
});
