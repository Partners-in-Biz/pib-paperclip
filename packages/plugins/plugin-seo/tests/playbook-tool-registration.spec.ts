import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { registerSeoTools, KIT_GROWTH_TOOL_NAMES } from "../src/growth-host.js";
import { SEO_TOOLS } from "../src/tools.js";

const PLAYBOOK = ["get-playbook", "propose-playbook-change", "decide-playbook-change"];

describe("SEO tool registration", () => {
  it("registers each playbook tool exactly once, natively, and no tool twice", async () => {
    const reg: Array<{ name: string; handler: (p: unknown, r: unknown) => Promise<unknown> }> = [];
    const ctx = { tools: { register: (name: string, _d: unknown, handler: never) => void reg.push({ name, handler }) } } as unknown as PluginContext;
    const calls: string[] = [];
    registerSeoTools(ctx, SEO_TOOLS, async (name) => { calls.push(name); return { content: "native" } as never; });
    const names = reg.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of PLAYBOOK) {
      expect(names.filter((x) => x === n)).toHaveLength(1);
      await reg.find((r) => r.name === n)!.handler({}, {});
    }
    expect(calls.sort()).toEqual([...PLAYBOOK].sort());
    for (const n of KIT_GROWTH_TOOL_NAMES) expect(names).toContain(n);
  });
});
