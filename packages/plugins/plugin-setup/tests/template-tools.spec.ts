import { describe, it, expect, beforeEach } from "vitest";
import { TEMPLATE_TOOLS, registerTemplateTools } from "../src/template-tools.js";
import { loadPack, packSources, templateVars } from "../src/templates.js";
import { renderHash } from "../src/render-hash.js";
import { renderInstructions } from "../src/templates-render.js";
import { subagentExtraArgs } from "../src/subagents.js";
import { fakeCtx, type FakeCompany } from "./helpers/fake-ctx.js";
import manifest from "../src/manifest.js";

function getHandler(ctx: any, toolName: string) {
  let handler: unknown;
  (ctx as any).tools.register = (_name: string, _decl: unknown, fn: unknown) => {
    if (_name === toolName) handler = fn;
  };
  registerTemplateTools(ctx);
  return handler as any;
}

describe("template-tools", () => {
  describe("declarations", () => {
    it("exports two tools in TEMPLATE_TOOLS", () => {
      expect(TEMPLATE_TOOLS).toHaveLength(2);
      expect(TEMPLATE_TOOLS.map((t) => t.name)).toEqual(["template-list", "template-get"]);
    });

    it("all tools are in manifest.tools", () => {
      const manifestNames = (manifest.tools ?? []).map((t) => t.name);
      for (const tool of TEMPLATE_TOOLS) {
        expect(manifestNames).toContain(tool.name);
      }
    });

    it("each tool has displayName, description, and parametersSchema", () => {
      for (const tool of TEMPLATE_TOOLS) {
        expect(tool.displayName).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parametersSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
    });

    it("template-list has no required params", () => {
      const listTool = TEMPLATE_TOOLS.find((t) => t.name === "template-list")!;
      expect(listTool.parametersSchema.required).toHaveLength(0);
    });

    it("template-get requires key param", () => {
      const getTool = TEMPLATE_TOOLS.find((t) => t.name === "template-get")!;
      expect(getTool.parametersSchema.required).toContain("key");
      expect(getTool.parametersSchema.required).not.toContain("companyId");
    });
  });

  describe("registerTemplateTools", () => {
    it("registers two tools with ctx.tools.register", () => {
      const { ctx } = fakeCtx();
      const registered = new Map<string, boolean>();
      const original = (ctx as any).tools.register;
      (ctx as any).tools.register = (name: string, _decl: unknown, _handler: unknown) => {
        registered.set(name, true);
      };
      registerTemplateTools(ctx);
      expect(registered.get("template-list")).toBe(true);
      expect(registered.get("template-get")).toBe(true);
      (ctx as any).tools.register = original;
    });
  });

  describe("template-list handler", () => {
    it("returns all templates from pack with key, file, scope, hostOwned, and hash", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const handler = getHandler(ctx, "template-list");
      const result = await handler({}, { companyId: "test" });
      expect(result.data.templates).toHaveLength(pack.templates.length);
      for (const template of result.data.templates) {
        expect(template).toHaveProperty("key");
        expect(template).toHaveProperty("file");
        expect(template).toHaveProperty("scope");
        expect(template).toHaveProperty("hostOwned");
        expect(template).toHaveProperty("hash");
      }
    });

    it("host-owned templates have hash null", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const hostOwned = pack.templates.find((t) => t.hostOwned);
      if (!hostOwned) return;
      const handler = getHandler(ctx, "template-list");
      const result = await handler({}, { companyId: "test" });
      const entry = result.data.templates.find((t: any) => t.key === hostOwned.key);
      expect(entry.hash).toBeNull();
    });

    it("non-host-owned templates have hash equal to renderHash of canonical render", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const nonHostOwned = pack.templates.find((t) => !t.hostOwned);
      if (!nonHostOwned) return;
      const handler = getHandler(ctx, "template-list");
      const result = await handler({}, { companyId: "test" });
      const entry = result.data.templates.find((t: any) => t.key === nonHostOwned.key);
      const defaultVars = templateVars();
      const rendered = renderInstructions(nonHostOwned, defaultVars);
      const expectedHash = renderHash(rendered);
      expect(entry.hash).toBe(expectedHash);
    });
  });

  describe("template-get handler", () => {
    it("returns error for unknown key", async () => {
      const { ctx } = fakeCtx();
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: "nonexistent" }, { companyId: "test" });
      expect(result.error).toContain("unknown template");
    });

    it("returns stub for host-owned template", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const hostOwned = pack.templates.find((t) => t.hostOwned);
      if (!hostOwned) return;
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: hostOwned.key }, { companyId: "test" });
      expect(result.data.hostOwned).toBe(true);
      expect(result.data.raw).toBeUndefined();
    });

    it("returns raw, rendered, and renderHash for non-host-owned template", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const nonHostOwned = pack.templates.find((t) => !t.hostOwned)!;
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: nonHostOwned.key }, { companyId: "test" });
      expect(result.data.key).toBe(nonHostOwned.key);
      expect(result.data.raw).toBeTruthy();
      expect(result.data.rendered).toBeTruthy();
      expect(result.data.renderHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("renders with company-specific vars and detects not found", async () => {
      const { ctx } = fakeCtx({ companies: { "company-1": { name: "Test Company", issuePrefix: "TST" } } });
      const pack = loadPack();
      const nonHostOwned = pack.templates.find((t) => !t.hostOwned)!;
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: nonHostOwned.key, companyId: "company-1" }, { companyId: "company-1" });
      expect(result.data.rendered).toContain("Test Company");
      const resultBad = await handler({ key: nonHostOwned.key, companyId: "nonexistent-company" }, {});
      expect(resultBad.error).toContain('company "nonexistent-company" not found');
    });

    it("returns hostOwned false and handles subagents", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const nonHostOwned = pack.templates.find((t) => !t.hostOwned)!;
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: nonHostOwned.key }, {});
      expect(result.data.hostOwned).toBe(false);
      // If template has subagents, verify extraArgs is computed; otherwise verify both are absent
      const withSubagents = pack.templates.find((t) => t.subagents && !t.hostOwned);
      if (withSubagents) {
        const resultSubagents = await handler({ key: withSubagents.key }, { companyId: "test" });
        expect(resultSubagents.data.subagents).toEqual(withSubagents.subagents);
        const expectedExtraArgs = subagentExtraArgs(withSubagents.subagents);
        if (expectedExtraArgs.length > 0) {
          expect(resultSubagents.data.extraArgs).toEqual(expectedExtraArgs);
        } else {
          expect(resultSubagents.data.extraArgs).toBeUndefined();
        }
      }
      const withoutSubagents = pack.templates.find((t) => !t.subagents && !t.hostOwned);
      if (withoutSubagents) {
        const resultNoSubagents = await handler({ key: withoutSubagents.key }, { companyId: "test" });
        expect(resultNoSubagents.data.extraArgs).toBeUndefined();
        expect(resultNoSubagents.data.subagents).toBeUndefined();
      }
    });
  });
});
