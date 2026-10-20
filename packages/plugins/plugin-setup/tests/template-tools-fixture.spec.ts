import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { subagentExtraArgs, type SubagentPolicy } from "../src/subagents.js";
import { fakeCtx } from "./helpers/fake-ctx.js";
import type { AgentTemplate, TemplatePack } from "../src/templates.js";

const fixtureHostOwned: AgentTemplate = {
  key: "f-host", name: "Host", title: "Host", role: "general", icon: "bot", group: "core",
  capabilities: "Host", reportsTo: null, adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: ["paperclipai/skills-catalog/scratch-pad"], file: "f-host", match: { names: [], titles: [], roles: [] },
  provisioning: "host", defaultOn: false, requires: { modules: [] }, notes: [], hostOwned: true,
};

const fixtureSubagents: AgentTemplate = {
  key: "f-sub", name: "Sub", title: "Sub", role: "general", icon: "bot", group: "core",
  capabilities: "Sub", reportsTo: null, adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: ["paperclipai/skills-catalog/scratch-pad"], file: "f-sub", match: { names: [], titles: [], roles: [] },
  provisioning: "hire", defaultOn: false, requires: { modules: [] }, notes: [], hostOwned: false,
  subagents: { allowed: ["Dev", "Critic"], model: "claude-sonnet-5-5", maxParallel: 2 } as SubagentPolicy,
};

const fixtureTemplate: AgentTemplate = {
  key: "f-plain", name: "Plain", title: "Plain", role: "general", icon: "bot", group: "core",
  capabilities: "Plain", reportsTo: null, adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: ["paperclipai/skills-catalog/scratch-pad"], file: "f-plain", match: { names: [], titles: [], roles: [] },
  provisioning: "hire", defaultOn: false, requires: { modules: [] }, notes: [], hostOwned: false,
};

const fixtureFiles = { "f-host": "Host.", "f-sub": "With {{company}}.", "f-plain": "Plain." };
const fixtureBlocks = {};

const fixturePack: TemplatePack = {
  pack: "fixture", version: 2, updated: "2000-01-01", description: "Fixture templates",
  variables: { company: "company name" }, sharedBlocks: [],
  templates: [fixtureHostOwned, fixtureSubagents, fixtureTemplate],
};

// Use a simpler approach: read and export the needed functions from original, override a few
vi.mock(
  "../src/templates.js",
  () => {
    // Create a synchronous mock factory that returns the overrides
    return {
      // Overridden functions
      loadPack: () => fixturePack,
      templateByKey: (key: string) => fixturePack.templates.find((t) => t.key === key) ?? null,
      packSources: () => ({ files: fixtureFiles, blocks: fixtureBlocks }),
      // Re-export stubs for the functions we don't mock (they'll be imported from actual module)
      // These are defined inline to avoid circular dependencies
      expandBlocks: (text: string, blocks: Record<string, string>): string => {
        const INCLUDE_RE = /\{\{include:([a-z0-9-]+)\}\}/g;
        return text.replace(INCLUDE_RE, (_all, name: string) => (blocks[name] ?? "").trimEnd()).trimEnd() + "\n";
      },
      fillVariables: (text: string, vars: any): string => {
        const VARIABLE_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;
        const PREFIX_LINK_RE = /\[([^\]]+)\]\(\/\{\{prefix\}\}\/[^)]*\)/g;
        const linked = vars.prefix ? text : text.replace(PREFIX_LINK_RE, "$1");
        return linked
          .replace(VARIABLE_RE, (all: string, name: string) => (name in vars ? vars[name] : all))
          .replace(/\bthe CEO, the CEO\b/g, "the CEO");
      },
      // Other needed exports
      templateVars: (input?: any) => ({
        company: input?.company?.trim() || "the company",
        prefix: input?.prefix?.trim() || "",
        owner: input?.owner?.trim() || "the company owner",
        ceo: input?.ceo?.name?.trim() || "the CEO",
        ceoLink: "the CEO",
        wikiRoot: input?.wikiRoot?.trim() || "(not configured)",
      }),
      // Type exports
      NO_WIKI_ROOT: "(not configured)",
      // Functions that might be needed
      matchTemplate: () => null,
      manager: () => null,
    };
  }
);

// Import registerTemplateTools after the mock is set up.
import { registerTemplateTools } from "../src/template-tools.js";

describe("template-tools fixture", () => {
  it("host-owned get returns {hostOwned:true}, no raw/rendered/hash", async () => {
    const { ctx } = fakeCtx({ companies: { "t": { name: "T" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-host" }, { companyId: "t" });
    expect(r.data!.hostOwned).toBe(true);
    expect(r.data!.raw).toBeUndefined();
    expect(r.data!.rendered).toBeUndefined();
    expect(r.data!.renderHash).toBeUndefined();
  });

  it("list hash null for host-owned", async () => {
    const { ctx } = fakeCtx();
    const { templateList } = registerTemplateTools(ctx);
    const r = await templateList({}, {});
    expect(r.data!.templates[0].hash).toBeNull();
  });

  it("get subagents template returns subagents, non-empty extraArgs", async () => {
    const { ctx } = fakeCtx({ companies: { "t": { name: "T" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-sub" }, { companyId: "t" });
    if (r.error) throw new Error(`Handler returned error: ${r.error}`);
    expect(r.data!.subagents).toEqual(fixtureSubagents.subagents);
    expect(r.data!.extraArgs.length).toBeGreaterThan(0);
    expect(r.data!.extraArgs).toEqual(subagentExtraArgs(fixtureSubagents.subagents));
  });

  it("companyId defaults to run.companyId, uses company vars", async () => {
    const { ctx } = fakeCtx({ companies: { "c1": { name: "Co One" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-sub" }, { companyId: "c1" });
    if (r.error) throw new Error(`Handler returned error: ${r.error}`);
    expect(r.data!.rendered).toContain("Co One");
  });

  it("rejects mismatched companyId", async () => {
    const { ctx } = fakeCtx({ companies: { "c1": { name: "C1" }, "c2": { name: "C2" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-sub", companyId: "c2" }, { companyId: "c1" });
    expect(r.error).toContain("must match");
  });

  it("returns error when company not found", async () => {
    const { ctx } = fakeCtx({ companies: { "c": { name: "C" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-sub", companyId: "x" }, { companyId: "x" });
    expect(r.error).toContain("not found");
  });

  it("returns error for unknown key", async () => {
    const { ctx } = fakeCtx();
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "x" }, { companyId: "t" });
    expect(r.error).toContain("unknown template");
  });
});
