import { describe, expect, it } from "vitest";
import { coversPluginTools, mergePluginToolsGrant } from "../src/grants.js";

const other = { permissionKey: "tasks:assign", scope: null };

describe("plugin tools grant merge (one tools:use grant per agent)", () => {
  it("adds the grant when there is none, keeping other grants", () => {
    const merged = mergePluginToolsGrant([other]);
    expect(merged.changed).toBe(true);
    expect(merged.grants).toEqual([other, { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
  });

  it("leaves an unscoped or already covering grant alone", () => {
    expect(mergePluginToolsGrant([{ permissionKey: "tools:use", scope: null }]).changed).toBe(false);
    expect(mergePluginToolsGrant([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]).changed).toBe(false);
    expect(coversPluginTools({ allow: ["tool:x"] })).toBe(true);
  });

  it("widens a provider-limited grant instead of adding a second one", () => {
    const merged = mergePluginToolsGrant([{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http", allow: ["tool:y"] } }]);
    expect(merged.grants.filter((g) => g.permissionKey === "tools:use")).toHaveLength(1);
    expect(merged.grants[0]!.scope).toEqual({ providerTypes: ["mcp_remote_http", "paperclip_plugin"], allow: ["tool:y"] });
    expect(merged.changed).toBe(true);
  });

  it("never widens a grant limited to named tools or one connection; reports it", () => {
    const merged = mergePluginToolsGrant([{ permissionKey: "tools:use", scope: { toolNames: ["a:b"] } }]);
    expect(merged.changed).toBe(false);
    expect(merged.conflict).toContain("limited");
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: { toolNames: ["a:b"] } }]);
  });

  it("collapses duplicate rows to the widest", () => {
    const merged = mergePluginToolsGrant([
      { permissionKey: "tools:use", scope: { toolNames: ["a:b"] } },
      { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } },
    ]);
    expect(merged.changed).toBe(true);
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
  });
});
