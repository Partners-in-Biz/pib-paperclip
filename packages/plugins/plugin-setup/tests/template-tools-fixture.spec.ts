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

// Mock the pack accessors, use real render code
vi.mock("../src/templates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/templates.js")>();
  return {
    ...actual,
    loadPack: () => fixturePack,
    templateByKey: (key: string) => fixturePack.templates.find((t) => t.key === key) ?? null,
    packSources: () => ({ files: fixtureFiles, blocks: fixtureBlocks }),
  };
});

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

  it("company literally named 'the company' is reported as found", async () => {
    const { ctx } = fakeCtx({ companies: { "c": { name: "the company" } } });
    const { templateGet } = registerTemplateTools(ctx);
    const r = await templateGet({ key: "f-sub" }, { companyId: "c" });
    if (r.error) throw new Error(`Handler returned error: ${r.error}`);
    expect(r.data!.rendered).toContain("the company");
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
