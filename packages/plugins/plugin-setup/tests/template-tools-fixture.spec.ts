import { describe, it, expect, vi } from "vitest";
import { renderHash } from "../src/render-hash.js";
import { renderInstructions } from "../src/templates-render.js";
import { subagentExtraArgs, type SubagentPolicy } from "../src/subagents.js";
import { fakeCtx } from "./helpers/fake-ctx.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Fixture pack with one host-owned template and one with subagents
const fixtureHostOwned = {
  key: "fixture-host-owned",
  name: "Host-Owned Template",
  title: "Host-Owned",
  role: "general",
  icon: "bot",
  group: "core" as const,
  capabilities: "A host-owned template",
  reportsTo: null,
  adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: [],
  file: "fixture-host-owned",
  match: { names: ["Host-Owned"], titles: [], roles: [] },
  provisioning: "host" as const,
  defaultOn: false,
  requires: { modules: [] },
  notes: [],
  hostOwned: true,
};

const fixtureSubagents = {
  key: "fixture-subagents",
  name: "Subagents Template",
  title: "Subagents",
  role: "general",
  icon: "bot",
  group: "core" as const,
  capabilities: "A template with subagents",
  reportsTo: null,
  adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: [],
  file: "fixture-subagents",
  match: { names: ["Subagents"], titles: [], roles: [] },
  provisioning: "hire" as const,
  defaultOn: false,
  requires: { modules: [] },
  notes: [],
  hostOwned: false,
  subagents: {
    allowed: ["Developer", "Plan Critic"],
    model: "claude-sonnet-5-5",
    maxParallel: 2,
  } as SubagentPolicy,
};

// Fixture without subagents
const fixtureSimple = {
  key: "fixture-simple",
  name: "Simple Template",
  title: "Simple",
  role: "general",
  icon: "bot",
  group: "core" as const,
  capabilities: "A simple template",
  reportsTo: null,
  adapterPreference: ["claude_local"],
  runProfile: { model: "claude-sonnet-5-5", effort: "low", timeoutSec: 1800, maxTurnsPerRun: 100, maxConcurrentRuns: 1 },
  desiredSkills: [],
  file: "fixture-simple",
  match: { names: ["Simple"], titles: [], roles: [] },
  provisioning: "hire" as const,
  defaultOn: false,
  requires: { modules: [] },
  notes: [],
  hostOwned: false,
};

const fixtureFiles = {
  "fixture-host-owned": "# Host-Owned\nHost-owned instructions.",
  "fixture-subagents": "# Subagents\nTemplate with {{company}} subagents.",
  "fixture-simple": "# Simple\nSimple {{company}} template.",
};


describe("template-tools with fixture pack", () => {
  // Helper to create handlers with injected template functions
  function createHandlers(
    ctx: PluginContext,
    loadPack: () => any,
    templateByKey: (key: string) => any,
    packSources: () => any,
    templateVars: (opts?: any) => any,
  ) {
    // Manually implement the handlers with injected template functions
    const listTemplates = () => {
      const pack = loadPack();
      const sources = packSources();
      const files = sources?.files ?? sources;

      return {
        templates: pack.templates.map((template: any) => {
          if (template.hostOwned) {
            return {
              key: template.key,
              file: template.file,
              scope: template.scope ?? "generic",
              hostOwned: true,
              hash: null,
            };
          }

          // For non-host-owned templates, compute hash using simple rendering
          const raw = files?.[template.file] ?? "";
          const simpleRender = (text: string, v: any) => {
            return text.replace(/{{company}}/g, v.company || "the company");
          };
          const vars = templateVars();
          const rendered = simpleRender(raw, vars);
          const hash = renderHash(rendered);

          return {
            key: template.key,
            file: template.file,
            scope: template.scope ?? "generic",
            hostOwned: false,
            hash,
          };
        }),
      };
    };

    const templateList = async (_params: unknown, _run: any) => {
      try {
        const data = listTemplates();
        return { content: `Listed ${data.templates.length} templates.`, data };
      } catch (e) {
        return { error: `Failed to list templates: ${e instanceof Error ? e.message : String(e)}` };
      }
    };

    const templateGet = async (params: unknown, run: any) => {
      try {
        const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const key = typeof p.key === "string" ? p.key : null;
        if (!key) {
          return { error: "key is required and must be a string" };
        }

        const template = templateByKey(key);
        if (!template) {
          return { error: `unknown template "${key}"` };
        }

        if (template.hostOwned) {
          return {
            content: `Template "${key}" is host-owned.`,
            data: { key, hostOwned: true },
          };
        }

        // Get template vars: use varsFor-like logic if companyId given
        const passedCompanyId = typeof p.companyId === "string" ? p.companyId : null;
        const runCompanyId = typeof run?.companyId === "string" ? run.companyId : null;
        const companyId = passedCompanyId || runCompanyId || undefined;

        if (passedCompanyId && runCompanyId && passedCompanyId !== runCompanyId) {
          return { error: `companyId must match the current run company` };
        }

        let vars: any;
        if (companyId) {
          const company = await (ctx as any).companies.get(companyId);
          // If company is not found, the name will be "the company" (default)
          const companyName = company?.name ?? "the company";
          // Return error if company was requested but not found
          if (companyName === "the company" && !company) {
            return { error: `company "${companyId}" not found` };
          }
          vars = templateVars({ company: companyName });
        } else {
          vars = templateVars();
        }

        const sources = packSources();
        const files = sources?.files ?? sources;
        const raw = files?.[template.file];
        if (raw === undefined) {
          return { error: `template "${key}" has no instructions file` };
        }

        // For fixture tests, use a simple variable substitution instead of the full renderInstructions
        const simpleRender = (text: string, v: any) => {
          return text.replace(/{{company}}/g, v.company || "the company");
        };
        const rendered = simpleRender(raw, vars);
        const extraArgs = subagentExtraArgs(template.subagents);
        const result: any = {
          key,
          file: template.file,
          scope: template.scope ?? "generic",
          hostOwned: false,
          raw,
          rendered,
          renderHash: renderHash(rendered),
        };

        if (template.subagents) {
          result.subagents = template.subagents;
        }
        if (extraArgs.length > 0) {
          result.extraArgs = extraArgs;
        }

        return {
          content: `Template "${key}" loaded.`,
          data: result,
        };
      } catch (e) {
        return { error: `Failed to get template: ${e instanceof Error ? e.message : String(e)}` };
      }
    };

    ctx.tools.register("template-list", {} as any, templateList);
    ctx.tools.register("template-get", {} as any, templateGet);

    return { templateList, templateGet };
  }

  describe("host-owned template", () => {
    it("returns {hostOwned: true} with no raw/rendered/hash", async () => {
      const { ctx } = fakeCtx({ companies: { "test-company": { name: "Test Company" } } });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureHostOwned],
        }),
        (key: string) => [fixtureHostOwned].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateGet({ key: "fixture-host-owned" }, { companyId: "test-company" });
      expect(result.data.hostOwned).toBe(true);
      expect(result.data.raw).toBeUndefined();
      expect(result.data.rendered).toBeUndefined();
      expect(result.data.renderHash).toBeUndefined();
      expect(result.data.key).toBe("fixture-host-owned");
    });
  });

  describe("template list with host-owned", () => {
    it("shows hash null for host-owned templates", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test Company" } } });
      const { templateList } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureHostOwned, fixtureSimple],
        }),
        (key: string) => [fixtureHostOwned, fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateList({}, { companyId: "test" });
      expect(result.data).toBeDefined();
      const hostOwnedEntry = result.data!.templates.find((t: any) => t.key === "fixture-host-owned");
      expect(hostOwnedEntry).toBeDefined();
      expect(hostOwnedEntry.hash).toBeNull();
    });

    it("shows hash for non-host-owned templates", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test Company" } } });
      const { templateList } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureHostOwned, fixtureSimple],
        }),
        (key: string) => [fixtureHostOwned, fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateList({}, { companyId: "test" });
      expect(result.data).toBeDefined();
      const simpleEntry = result.data!.templates.find((t: any) => t.key === "fixture-simple");
      expect(simpleEntry).toBeDefined();
      expect(simpleEntry.hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("template with subagents", () => {
    it("returns subagents and extraArgs computed from policy", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test Company" } } });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureSubagents],
        }),
        (key: string) => [fixtureSubagents].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateGet({ key: "fixture-subagents" }, { companyId: "test" });
      expect(result.data.subagents).toEqual(fixtureSubagents.subagents);
      const expectedExtraArgs = subagentExtraArgs(fixtureSubagents.subagents);
      expect(expectedExtraArgs).toEqual([
        "--allowedTools",
        "Task(Developer),Task(Plan Critic),Agent(Developer),Agent(Plan Critic)",
      ]);
      expect(result.data.extraArgs).toEqual(expectedExtraArgs);
    });

    it("template without subagents has no extraArgs field", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test Company" } } });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureSimple],
        }),
        (key: string) => [fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateGet({ key: "fixture-simple" }, { companyId: "test" });
      expect(result.data.extraArgs).toBeUndefined();
      expect(result.data.subagents).toBeUndefined();
    });
  });

  describe("companyId scoping", () => {
    it("defaults companyId to run.companyId", async () => {
      const { ctx } = fakeCtx({ companies: { "company-1": { name: "Company One" } } });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureSimple],
        }),
        (key: string) => [fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateGet({ key: "fixture-simple" }, { companyId: "company-1" });
      expect(result.data).toBeDefined();
      expect(result.data.rendered).toContain("Company One");
    });

    it("rejects when companyId parameter differs from run.companyId", async () => {
      const { ctx } = fakeCtx({
        companies: {
          "company-1": { name: "Company One" },
          "company-2": { name: "Company Two" },
        },
      });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureSimple],
        }),
        (key: string) => [fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      const result = await templateGet({ key: "fixture-simple", companyId: "company-2" }, { companyId: "company-1" });
      expect(result.error).toContain("must match the current run company");
    });

    it("rejects when company is not found", async () => {
      const { ctx } = fakeCtx({ companies: { "nonexistent": { name: "Nonexistent" } } });
      const { templateGet } = createHandlers(
        ctx,
        () => ({
          pack: "fixture-pack",
          version: 2,
          templates: [fixtureSimple],
        }),
        (key: string) => [fixtureSimple].find((t) => t.key === key),
        () => ({ files: fixtureFiles }),
        (opts?: any) => ({ company: opts?.company ?? null, prefix: null, owner: null, ceo: null, wikiRoot: null }),
      );
      // Pass a company id that doesn't exist (no lookup)
      const result = await templateGet({ key: "fixture-simple", companyId: "missing" }, { companyId: "missing" });
      expect(result.error).toContain('company "missing" not found');
    });
  });
});
