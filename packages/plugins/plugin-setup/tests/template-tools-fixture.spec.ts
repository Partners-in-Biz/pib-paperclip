import { describe, it, expect } from "vitest";
import { renderHash } from "../src/render-hash.js";
import { subagentExtraArgs, type SubagentPolicy } from "../src/subagents.js";
import { fakeCtx } from "./helpers/fake-ctx.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const fixtureHostOwned = {
  key: "f-host", name: "Host", title: "Host", role: "general", icon: "bot", group: "core" as const,
  capabilities: "Host", reportsTo: null, adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: [], file: "f-host", match: { names: [], titles: [], roles: [] },
  provisioning: "host" as const, defaultOn: false, requires: { modules: [] }, notes: [], hostOwned: true,
};

const fixtureSubagents = {
  key: "f-sub", name: "Sub", title: "Sub", role: "general", icon: "bot", group: "core" as const,
  capabilities: "Sub", reportsTo: null, adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: [], file: "f-sub", match: { names: [], titles: [], roles: [] },
  provisioning: "hire" as const, defaultOn: false, requires: { modules: [] }, notes: [], hostOwned: false,
  subagents: { allowed: ["Dev", "Critic"], model: "claude-sonnet-5-5", maxParallel: 2 } as SubagentPolicy,
};

const fixtureFiles = { "f-host": "Host.", "f-sub": "With {{company}}." };

function mkHandlers(ctx: PluginContext, templates: any[]) {
  const listTemplates = () => ({
    templates: templates.map((t: any) => ({
      key: t.key, file: t.file, scope: "generic", hostOwned: !!t.hostOwned,
      hash: t.hostOwned ? null : renderHash((fixtureFiles as any)[t.file].replace(/{{company}}/g, "the company")),
    })),
  });

  const templateList = async (_p: unknown, _r: any) => {
    try {
      return { content: `Listed.`, data: listTemplates() };
    } catch (e) {
      return { error: String(e) };
    }
  };

  const templateGet = async (params: unknown, run: any) => {
    try {
      const p = params && typeof params === "object" ? params as Record<string, unknown> : {};
      const key = typeof p.key === "string" ? p.key : null;
      if (!key) return { error: "key required" };

      const t = templates.find((x: any) => x.key === key);
      if (!t) return { error: `unknown template "${key}"` };
      if (t.hostOwned) return { content: "Host.", data: { key, hostOwned: true } };

      const pCid = typeof p.companyId === "string" ? p.companyId : null;
      const rCid = typeof run?.companyId === "string" ? run.companyId : null;
      const cid = pCid || rCid || undefined;
      if (pCid && rCid && pCid !== rCid) return { error: "companyId mismatch" };

      let company = "the company";
      if (cid) {
        const c = await (ctx as any).companies.get(cid);
        if (!c) return { error: `company "${cid}" not found` };
        company = c.name;
      }

      const raw = (fixtureFiles as any)[t.file];
      const rendered = raw.replace(/{{company}}/g, company);
      const extraArgs = subagentExtraArgs(t.subagents);
      const result: any = { key, file: t.file, scope: "generic", hostOwned: false, raw, rendered, renderHash: renderHash(rendered) };
      if (t.subagents) result.subagents = t.subagents;
      if (extraArgs.length > 0) result.extraArgs = extraArgs;
      return { content: "Loaded.", data: result };
    } catch (e) {
      return { error: String(e) };
    }
  };

  ctx.tools.register("template-list", {} as any, templateList);
  ctx.tools.register("template-get", {} as any, templateGet);
  return { templateList, templateGet };
}

describe("template-tools fixture", () => {
  it("host-owned get returns {hostOwned:true}, no raw/rendered/hash", async () => {
    const { ctx } = fakeCtx({ companies: { "t": { name: "T" } } });
    const { templateGet } = mkHandlers(ctx, [fixtureHostOwned]);
    const r = await templateGet({ key: "f-host" }, { companyId: "t" });
    expect(r.data!.hostOwned).toBe(true);
    expect(r.data!.raw).toBeUndefined();
    expect(r.data!.rendered).toBeUndefined();
    expect(r.data!.renderHash).toBeUndefined();
  });

  it("list hash null for host-owned", async () => {
    const { ctx } = fakeCtx();
    const { templateList } = mkHandlers(ctx, [fixtureHostOwned]);
    const r = await templateList({}, {});
    expect(r.data!.templates[0].hash).toBeNull();
  });

  it("get subagents template returns subagents, non-empty extraArgs", async () => {
    const { ctx } = fakeCtx({ companies: { "t": { name: "T" } } });
    const { templateGet } = mkHandlers(ctx, [fixtureSubagents]);
    const r = await templateGet({ key: "f-sub" }, { companyId: "t" });
    expect(r.data!.subagents).toEqual(fixtureSubagents.subagents);
    expect(r.data!.extraArgs.length).toBeGreaterThan(0);
    expect(r.data!.extraArgs).toEqual(subagentExtraArgs(fixtureSubagents.subagents));
  });

  it("companyId defaults to run.companyId, uses company vars", async () => {
    const { ctx } = fakeCtx({ companies: { "c1": { name: "Co One" } } });
    const { templateGet } = mkHandlers(ctx, [fixtureSubagents]);
    const r = await templateGet({ key: "f-sub" }, { companyId: "c1" });
    expect(r.data!.rendered).toContain("Co One");
  });

  it("rejects mismatched companyId", async () => {
    const { ctx } = fakeCtx({ companies: { "c1": { name: "C1" }, "c2": { name: "C2" } } });
    const { templateGet } = mkHandlers(ctx, [fixtureSubagents]);
    const r = await templateGet({ key: "f-sub", companyId: "c2" }, { companyId: "c1" });
    expect(r.error).toContain("mismatch");
  });

  it("returns error when company not found", async () => {
    const { ctx } = fakeCtx({ companies: { "c": { name: "C" } } });
    const { templateGet } = mkHandlers(ctx, [fixtureSubagents]);
    const r = await templateGet({ key: "f-sub", companyId: "x" }, { companyId: "x" });
    expect(r.error).toContain("not found");
  });

  it("returns error for unknown key", async () => {
    const { ctx } = fakeCtx();
    const { templateGet } = mkHandlers(ctx, [fixtureSubagents]);
    const r = await templateGet({ key: "x" }, { companyId: "t" });
    expect(r.error).toContain("unknown template");
  });
});
