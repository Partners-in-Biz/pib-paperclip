import { describe, it, expect } from "vitest";
import { TEMPLATE_TOOLS, registerTemplateTools } from "../src/template-tools.js";
import { loadPack, templateVars } from "../src/templates.js";
import { renderHash } from "../src/render-hash.js";
import { renderInstructions } from "../src/templates-render.js";
import { fakeCtx } from "./helpers/fake-ctx.js";
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
  it("exports two tools, both in manifest", () => {
    expect(TEMPLATE_TOOLS).toHaveLength(2);
    expect(TEMPLATE_TOOLS.map((t) => t.name)).toEqual(["template-list", "template-get"]);
    const manifestNames = (manifest.tools ?? []).map((t) => t.name);
    for (const tool of TEMPLATE_TOOLS) {
      expect(manifestNames).toContain(tool.name);
      expect(tool.displayName).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parametersSchema).toEqual(expect.objectContaining({ type: "object" }));
    }
  });

  describe("template-list", () => {
    it("returns all 11 templates with key, file, scope, hostOwned, hash", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const handler = getHandler(ctx, "template-list");
      const result = await handler({}, { companyId: "test" });
      expect(result.data.templates).toHaveLength(11);
      for (const template of result.data.templates) {
        expect(template).toHaveProperty("key");
        expect(template).toHaveProperty("file");
        expect(template).toHaveProperty("scope");
        expect(template).toHaveProperty("hostOwned");
        expect(template).toHaveProperty("hash");
      }
    });

    it("templates have hash matching renderHash of canonical render", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const handler = getHandler(ctx, "template-list");
      const result = await handler({}, { companyId: "test" });
      for (const templatePack of pack.templates) {
        const entry = result.data.templates.find((t: any) => t.key === templatePack.key);
        const defaultVars = templateVars();
        const rendered = renderInstructions(templatePack, defaultVars);
        const expectedHash = renderHash(rendered);
        expect(entry.hash).toBe(expectedHash);
      }
    });
  });

  describe("template-get", () => {
    it("returns error for unknown key", async () => {
      const { ctx } = fakeCtx();
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: "nonexistent" }, { companyId: "test" });
      expect(result.error).toContain("unknown template");
    });

    it("returns raw, rendered, renderHash for template", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test" } } });
      const pack = loadPack();
      const template = pack.templates[0];
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: template.key }, { companyId: "test" });
      expect(result.data.raw).toBeTruthy();
      expect(result.data.rendered).toBeTruthy();
      expect(result.data.renderHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("renders with company-specific vars, detects missing company", async () => {
      const { ctx } = fakeCtx({ companies: { "company-1": { name: "Test Co" } } });
      const pack = loadPack();
      const template = pack.templates[0];
      const handler = getHandler(ctx, "template-get");
      const r1 = await handler({ key: template.key, companyId: "company-1" }, { companyId: "company-1" });
      expect(r1.data.rendered).toContain("Test Co");
      const r2 = await handler({ key: template.key, companyId: "missing" }, { companyId: "missing" });
      expect(r2.error).toContain('not found');
    });

    it("rejects mismatched companyId parameter", async () => {
      const { ctx } = fakeCtx({ companies: { "c1": { name: "C1" }, "c2": { name: "C2" } } });
      const pack = loadPack();
      const template = pack.templates[0];
      const handler = getHandler(ctx, "template-get");
      const result = await handler({ key: template.key, companyId: "c2" }, { companyId: "c1" });
      expect(result.error).toContain("must match");
    });
  });
});
