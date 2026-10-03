import { describe, expect, it } from "vitest";
import { MEMORY_AGENT_TOOLS, MEMORY_TOOLS_GRANT, coversPluginTools, mergeMemoryToolsGrant, mergePluginToolsGrant, scopeAllowsTool, toolsMissing } from "../src/index.js";

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

const RECALL = "partnersinbiz.cockpit:memory-recall";
const CRM_TOOL = "partnersinbiz.crm:crm-records";

describe("what a tools grant scope really allows (mirrors the host's scopeAllowsTool)", () => {
  it("the memory tools are the four exact names the skills tell agents to call", () => {
    expect(MEMORY_AGENT_TOOLS).toEqual(["partnersinbiz.cockpit:memory-recall", "partnersinbiz.cockpit:memory-search", "partnersinbiz.cockpit:memory-add", "partnersinbiz.cockpit:memory-feedback"]);
    expect(MEMORY_TOOLS_GRANT).toEqual({ permissionKey: "tools:use", scope: { toolNames: [...MEMORY_AGENT_TOOLS] } });
  });

  it("an empty scope, the provider type, and a matching tool name or allow entry allow the tool", () => {
    expect(scopeAllowsTool(null, RECALL)).toBe(true);
    expect(scopeAllowsTool({}, RECALL)).toBe(true);
    expect(scopeAllowsTool({ providerType: "paperclip_plugin" }, RECALL)).toBe(true);
    expect(scopeAllowsTool({ providerTypes: ["mcp_remote_http", "paperclip_plugin"] }, RECALL)).toBe(true);
    expect(scopeAllowsTool({ toolNames: [RECALL] }, RECALL)).toBe(true);
    expect(scopeAllowsTool({ providerType: "paperclip_plugin", toolNames: [RECALL] }, RECALL)).toBe(true);
    expect(scopeAllowsTool({ toolName: RECALL }, RECALL)).toBe(true);
    expect(scopeAllowsTool({ providerType: "mcp_remote_http", allow: [`tool:${RECALL}`] }, RECALL)).toBe(true);
    // the host quirk: a scope with only `allow` has no selector, so it matches everything
    expect(scopeAllowsTool({ allow: ["tool:something-else"] }, RECALL)).toBe(true);
  });

  it("a different tool, another provider type, or a selector it cannot judge does not allow it", () => {
    expect(scopeAllowsTool({ toolNames: [RECALL] }, CRM_TOOL)).toBe(false);
    expect(scopeAllowsTool({ toolName: "x" }, RECALL)).toBe(false);
    expect(scopeAllowsTool({ providerType: "mcp_remote_http" }, RECALL)).toBe(false);
    expect(scopeAllowsTool({ providerTypes: ["mcp_remote_http"] }, RECALL)).toBe(false);
    expect(scopeAllowsTool({ applicationKeys: ["gmail"] }, RECALL)).toBe(false);
    expect(scopeAllowsTool({ riskLevels: ["read"] }, RECALL)).toBe(false);
    expect(scopeAllowsTool({ providerType: "paperclip_plugin", riskLevel: "read" }, RECALL)).toBe(false);
  });

  it("lists the needed tools no grant lets the agent call", () => {
    const all = [{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }];
    const memoryOnly = [{ permissionKey: "tools:use", scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }];
    const recallOnly = [{ permissionKey: "tools:use", scope: { toolNames: [RECALL] } }];
    expect(toolsMissing(all, MEMORY_AGENT_TOOLS)).toEqual([]);
    expect(toolsMissing(memoryOnly, MEMORY_AGENT_TOOLS)).toEqual([]);
    expect(toolsMissing(memoryOnly, [CRM_TOOL])).toEqual([CRM_TOOL]);
    expect(toolsMissing(recallOnly, MEMORY_AGENT_TOOLS)).toEqual(MEMORY_AGENT_TOOLS.filter((name) => name !== RECALL));
    expect(toolsMissing([], MEMORY_AGENT_TOOLS)).toEqual([...MEMORY_AGENT_TOOLS]);
    expect(toolsMissing([{ permissionKey: "tasks:assign", scope: null }], [RECALL])).toEqual([RECALL]);
    // a memory-only grant is not "all plugin tools"
    expect(coversPluginTools({ toolNames: [...MEMORY_AGENT_TOOLS] })).toBe(false);
  });
});

describe("the memory-only grant merge (narrow, never wider than memory)", () => {
  it("adds exactly the memory tools when there is no tools grant, keeping other grants", () => {
    const merged = mergeMemoryToolsGrant([other]);
    expect(merged).toMatchObject({ changed: true, conflict: null });
    expect(merged.grants).toEqual([other, { permissionKey: "tools:use", scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }]);
  });

  it("leaves a grant that already allows the memory tools alone", () => {
    expect(mergeMemoryToolsGrant([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]).changed).toBe(false);
    expect(mergeMemoryToolsGrant([{ permissionKey: "tools:use", scope: null }]).changed).toBe(false);
    expect(mergeMemoryToolsGrant([{ permissionKey: "tools:use", scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }]).changed).toBe(false);
  });

  it("adds only the missing memory names to a named-tools grant", () => {
    const merged = mergeMemoryToolsGrant([{ permissionKey: "tools:use", scope: { toolNames: [CRM_TOOL, RECALL] } }]);
    expect(merged.changed).toBe(true);
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: { toolNames: [CRM_TOOL, RECALL, ...MEMORY_AGENT_TOOLS.filter((n) => n !== RECALL)] } }]);
    expect(merged.conflict).toBeNull();
  });

  it("never widens a grant limited another way; reports it for a person", () => {
    const limited = [{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http" } }];
    const merged = mergeMemoryToolsGrant(limited);
    expect(merged.changed).toBe(false);
    expect(merged.conflict).toContain("memory-recall");
    expect(merged.grants).toEqual(limited);
    expect(mergeMemoryToolsGrant([{ permissionKey: "tools:use", scope: { applicationKeys: ["gmail"] } }]).conflict).not.toBeNull();
  });
});
