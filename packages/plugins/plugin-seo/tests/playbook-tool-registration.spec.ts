import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { registerKitGrowthTools, KIT_GROWTH_TOOL_NAMES } from "../src/growth-host.js";

describe("SEO playbook tool registration", () => {
  it("leaves get-, propose- and decide-playbook to the native handlers", () => {
    const names: string[] = [];
    const ctx = { tools: { register: (n: string) => void names.push(n) } } as unknown as PluginContext;
    registerKitGrowthTools(ctx);
    expect(names.sort()).toEqual([...KIT_GROWTH_TOOL_NAMES].sort());
    for (const n of ["get-playbook", "propose-playbook-change", "decide-playbook-change"]) expect(names).not.toContain(n);
  });
});
