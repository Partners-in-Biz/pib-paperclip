import { describe, expect, it, vi } from "vitest";
import type { JsonSchema, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  GROWTH_SCOPE_KINDS, GROWTH_TOOL_NAMES, MAX_PARAM_DESCRIPTION, growthToolDeclarations, registerGrowthTools, resolveGrowthScopeParams, runGrowthTool,
  type GrowthToolsHost,
} from "../src/growth/tools.js";

const SCOPED = ["performance-review", "get-playbook", "propose-playbook-change", "list-experiments", "propose-experiment"];
const ID_ONLY = ["decide-playbook-change", "approve-experiment", "reject-experiment"];

function descriptions(schema: JsonSchema, path = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (typeof schema.description === "string") out.push([path, schema.description]);
  for (const [key, child] of Object.entries(schema.properties ?? {})) out.push(...descriptions(child as JsonSchema, `${path}.${key}`));
  if (schema.items) out.push(...descriptions(schema.items as JsonSchema, `${path}[]`));
  return out;
}

describe("growth tool declarations", () => {
  const tools = growthToolDeclarations();

  it("declares the eight tools in order", () => {
    expect(tools.map((t) => t.name)).toEqual([...GROWTH_TOOL_NAMES]);
    expect(GROWTH_TOOL_NAMES).toHaveLength(8);
  });

  it("has a name, display name, description and a closed object schema", () => {
    for (const t of tools) {
      expect(t.displayName).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parametersSchema).toMatchObject({ type: "object", additionalProperties: false });
      for (const r of (t.parametersSchema.required ?? []) as string[]) expect(Object.keys(t.parametersSchema.properties ?? {})).toContain(r);
    }
  });

  it("keeps every parameter description under the limit and on one line", () => {
    for (const t of tools) {
      expect(t.description, t.name).not.toMatch(/\n/);
      for (const [path, text] of descriptions(t.parametersSchema)) {
        expect(text.length, `${t.name}${path}`).toBeLessThanOrEqual(MAX_PARAM_DESCRIPTION);
        expect(text, `${t.name}${path}`).not.toMatch(/\n/);
      }
    }
  });

  it("gives the scoped tools a scope and the id tools none", () => {
    for (const t of tools) {
      const props = Object.keys(t.parametersSchema.properties ?? {});
      expect(props.includes("scope"), t.name).toBe(SCOPED.includes(t.name));
      if (ID_ONLY.includes(t.name)) expect(props.includes("client"), t.name).toBe(false);
    }
  });

  it("names the supported kinds only when the host runs fewer than four", () => {
    const scope = (opts?: Parameters<typeof growthToolDeclarations>[0]) => String((growthToolDeclarations(opts)[1].parametersSchema.properties as Record<string, JsonSchema>).scope.description);
    expect(scope({ kinds: [...GROWTH_SCOPE_KINDS] })).not.toContain("Supported here");
    expect(scope()).toContain("Supported here: own, client");
  });

  it("can drop the older client params and replace a description", () => {
    const t = growthToolDeclarations({ legacyClientParams: false, descriptions: { "get-playbook": "Custom." } });
    expect(Object.keys(t[1].parametersSchema.properties ?? {})).toEqual(["scope"]);
    expect(t[1].description).toBe("Custom.");
  });
});

describe("resolveGrowthScopeParams", () => {
  const all = [...GROWTH_SCOPE_KINDS];
  it("passes params without scope through unchanged", () => {
    const p = { client: "company:a", periodDays: 14 };
    expect(resolveGrowthScopeParams(p)).toBe(p);
    expect(resolveGrowthScopeParams({ scope: "" })).toEqual({ scope: "" });
  });
  it("maps own and client scopes to the client param", () => {
    expect(resolveGrowthScopeParams({ scope: "own", periodDays: 7 })).toEqual({ client: null, periodDays: 7 });
    expect(resolveGrowthScopeParams({ scope: "client:company:acme" })).toEqual({ client: "company:acme" });
    expect(resolveGrowthScopeParams({ scope: "client:contact:jo" })).toEqual({ client: "contact:jo" });
  });
  it("maps product and book scopes to scopeKey when the host runs them", () => {
    expect(resolveGrowthScopeParams({ scope: "product:p1" }, all)).toEqual({ scopeKey: "product:p1" });
    expect(resolveGrowthScopeParams({ scope: "book:b1" }, all)).toEqual({ scopeKey: "book:b1" });
  });
  it("refuses a kind the host does not run instead of falling back to own work", () => {
    expect(() => resolveGrowthScopeParams({ scope: "product:p1" })).toThrow(/does not run product scopes/);
    expect(() => resolveGrowthScopeParams({ scope: "book:b1" }, ["own", "client", "product"])).toThrow(/does not run book scopes/);
  });
  it("refuses a malformed scope and a scope mixed with client params", () => {
    expect(() => resolveGrowthScopeParams({ scope: "acme" })).toThrow(/not valid/);
    expect(() => resolveGrowthScopeParams({ scope: "client:other:x" })).toThrow(/not valid/);
    expect(() => resolveGrowthScopeParams({ scope: 5 })).toThrow(/must be text/);
    expect(() => resolveGrowthScopeParams({ scope: "own", client: "company:a" }, all)).toThrow(/not both/);
    expect(() => resolveGrowthScopeParams({ scope: "own", clientRef: "a" }, all)).toThrow(/not both/);
  });
});

describe("running the tools", () => {
  const run = { companyId: "co", agentId: "ag", runId: "r1" } as unknown as ToolRunContext;
  const actor = { companyId: "co", userId: "u", agentId: "ag", isAgent: true };
  const handlers = () => Object.fromEntries(GROWTH_TOOL_NAMES.map((n) => [n, vi.fn(async (_a: unknown, p: Record<string, unknown>) => ({ tool: n, params: p }))])) as unknown as GrowthToolsHost["handlers"];

  it("hands the handler the resolved params and returns text plus data", async () => {
    const host: GrowthToolsHost = { actor: async () => actor, handlers: handlers() };
    const result = await runGrowthTool(host, "get-playbook", { scope: "client:company:a" }, run);
    expect(host.handlers["get-playbook"]).toHaveBeenCalledWith(actor, { client: "company:a" });
    expect(result.data).toEqual({ tool: "get-playbook", params: { client: "company:a" } });
    expect(result.content).toContain('"tool": "get-playbook"');
  });

  it("returns an error, and calls no handler, for a refused actor or scope", async () => {
    const h = handlers();
    const refused = await runGrowthTool({ actor: async () => { throw new Error("Social is switched off"); }, handlers: h }, "list-experiments", {}, run);
    expect(refused).toEqual({ error: "Social is switched off" });
    const badScope = await runGrowthTool({ actor: async () => actor, handlers: h }, "list-experiments", { scope: "book:b" }, run);
    expect(badScope.error).toMatch(/does not run book scopes/);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("registers all eight tools on the context", async () => {
    const registered = new Map<string, (params: unknown, run: ToolRunContext) => Promise<unknown>>();
    const ctx = { tools: { register: (name: string, _d: unknown, fn: never) => registered.set(name, fn) } } as unknown as PluginContext;
    registerGrowthTools(ctx, { actor: async () => actor, handlers: handlers() });
    expect([...registered.keys()]).toEqual([...GROWTH_TOOL_NAMES]);
    expect(await registered.get("approve-experiment")!({ experimentId: "e" }, run)).toMatchObject({ data: { tool: "approve-experiment" } });
  });
});
