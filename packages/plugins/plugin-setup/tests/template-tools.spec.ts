import { describe, it, expect, vi, afterEach } from "vitest";
import { TEMPLATE_TOOLS, registerTemplateTools } from "../src/template-tools.js";
import { loadPack, templateVars, type AgentTemplate } from "../src/templates.js";
import * as templatesModule from "../src/templates.js";
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
  it("exports three tools, all in manifest", () => {
    expect(TEMPLATE_TOOLS).toHaveLength(3);
    expect(TEMPLATE_TOOLS.map((t) => t.name)).toEqual(["template-list", "template-get", "template-preview"]);
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

  describe("template-preview", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns error for unknown key", async () => {
      const { ctx } = fakeCtx();
      const handler = getHandler(ctx, "template-preview");
      const result = await handler({ key: "nonexistent", unifiedDiff: "dummy" }, { companyId: "test" });
      expect(result.error).toContain("unknown template");
    });

    it("bad diff: context does not match returns error", async () => {
      const { ctx } = fakeCtx();
      const handler = getHandler(ctx, "template-preview");

      const pack = loadPack();
      const template = pack.templates[0];

      const badDiff = `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-This line does not exist in the template
+Replaced
 Another line that also does not exist
`;

      const result = await handler({ key: template.key, unifiedDiff: badDiff }, { companyId: "test" });
      expect(result.error).toContain("does not apply cleanly");
    });

    it("good diff: applies cleanly and produces different render hash with marker", async () => {
      const { ctx } = fakeCtx({ companies: { "test": { name: "Test" } } });
      const pack = loadPack();
      // Find a non-host-owned template
      const template = pack.templates.find((t) => !t.hostOwned);
      expect(template).toBeDefined();

      const previewHandler = getHandler(ctx, "template-preview");
      // Get the template to obtain its raw text
      const getHandlerFn = getHandler(ctx, "template-get");
      const getResult = await getHandlerFn({ key: template!.key }, { companyId: "test" });
      expect(getResult.data.raw).toBeTruthy();

      const raw = getResult.data.raw;
      const lines = raw.split("\n");
      // Use a simple change: replace first non-empty line
      let lineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().length > 0) {
          lineIndex = i;
          break;
        }
      }
      expect(lineIndex).toBeGreaterThanOrEqual(0);

      const originalLine = lines[lineIndex]!;
      const markerLine = "PREVIEW-MARKER-4197";

      // Build a simple unified diff
      const unifiedDiff = `@@ -${lineIndex + 1},1 +${lineIndex + 1},1 @@
-${originalLine}
+${markerLine}`;

      const previewResult = await previewHandler(
        { key: template!.key, unifiedDiff },
        { companyId: "test" }
      );

      expect(previewResult.data).toBeDefined();
      expect(previewResult.data.rendered).toContain(markerLine);
      expect(previewResult.data.renderHash).toMatch(/^[0-9a-f]{16}$/);
      expect(previewResult.data.changed).toBe(true);
    });

    it("hash differs: preview renderHash differs from baseRenderHash and baseRenderHash stable", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const template = pack.templates.find((t) => !t.hostOwned);
      expect(template).toBeDefined();

      const previewHandler = getHandler(ctx, "template-preview");
      const getHandlerFn = getHandler(ctx, "template-get");
      // Get with default variables (no companyId)
      const getResult = await getHandlerFn({ key: template!.key }, {});
      const baselineRenderHash = getResult.data.renderHash;

      const raw = getResult.data.raw;
      const lines = raw.split("\n");
      // Find first non-empty line
      let lineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().length > 0) {
          lineIndex = i;
          break;
        }
      }
      expect(lineIndex).toBeGreaterThanOrEqual(0);

      const originalLine = lines[lineIndex]!;

      // Build a simple unified diff
      const unifiedDiff = `@@ -${lineIndex + 1},1 +${lineIndex + 1},1 @@
-${originalLine}
+MODIFIED-LINE-4197`;

      const previewResult = await previewHandler(
        { key: template!.key, unifiedDiff },
        {}
      );

      expect(previewResult.data).toBeDefined();
      expect(previewResult.data.renderHash).not.toBe(previewResult.data.baseRenderHash);
      expect(previewResult.data.baseRenderHash).toBe(baselineRenderHash);
    });

    it("no-op diff safety: replacing line with identical text returns changed false and same hash", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const template = pack.templates.find((t) => !t.hostOwned);
      expect(template).toBeDefined();

      const previewHandler = getHandler(ctx, "template-preview");
      const getHandlerFn = getHandler(ctx, "template-get");
      // Get with default variables (no companyId)
      const getResult = await getHandlerFn({ key: template!.key }, {});
      const baselineRenderHash = getResult.data.renderHash;

      const raw = getResult.data.raw;
      const lines = raw.split("\n");
      // Find first non-empty line
      let lineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().length > 0) {
          lineIndex = i;
          break;
        }
      }
      expect(lineIndex).toBeGreaterThanOrEqual(0);

      const line = lines[lineIndex]!;

      // A no-op diff that removes and re-adds the same line
      const unifiedDiff = `@@ -${lineIndex + 1},1 +${lineIndex + 1},1 @@
-${line}
+${line}`;

      const previewResult = await previewHandler(
        { key: template!.key, unifiedDiff },
        {}
      );

      expect(previewResult.data).toBeDefined();
      expect(previewResult.data.changed).toBe(false);
      expect(previewResult.data.renderHash).toBe(previewResult.data.baseRenderHash);
      expect(previewResult.data.renderHash).toBe(baselineRenderHash);
    });

    it("host-owned template returns stub with hostOwned flag", async () => {
      const { ctx } = fakeCtx();
      const pack = loadPack();
      const hostOwnedTemplate = pack.templates.find((t) => t.hostOwned);

      // If no real host-owned template exists, mock one for testing
      if (!hostOwnedTemplate) {
        const mockHostOwnedTemplate: AgentTemplate = {
          key: "test-host-owned",
          name: "Test Host Owned",
          title: "Test Host Owned Template",
          role: "general",
          icon: "bot",
          group: "core",
          capabilities: "Mock template for testing host-owned behavior",
          reportsTo: null,
          adapterPreference: ["claude_local"],
          runProfile: {
            model: "claude-sonnet-5-5",
            effort: "medium",
            timeoutSec: 3600,
            maxTurnsPerRun: 200,
            maxConcurrentRuns: 3,
          },
          desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"],
          file: "test-host-owned",
          match: { names: [], titles: [], roles: [] },
          provisioning: "host",
          defaultOn: false,
          requires: { modules: [] },
          notes: [],
          hostOwned: true,
        };

        const originalTemplateByKey = templatesModule.templateByKey;
        vi.spyOn(templatesModule, "templateByKey").mockImplementation((key: string) => {
          if (key === "test-host-owned") return mockHostOwnedTemplate;
          return originalTemplateByKey(key);
        });
      }

      const templateKey = hostOwnedTemplate?.key ?? "test-host-owned";
      const handler = getHandler(ctx, "template-preview");
      const result = await handler({ key: templateKey, unifiedDiff: "dummy" }, { companyId: "test" });

      expect(result.data).toBeDefined();
      expect(result.data.hostOwned).toBe(true);
      expect(result.data.raw).toBeUndefined();
      expect(result.data.rendered).toBeUndefined();
      expect(result.data.renderHash).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("tool is registered by registerTemplateTools", async () => {
      const { ctx } = fakeCtx();
      let previewRegistered = false;
      (ctx as any).tools.register = (_name: string, _decl: unknown, fn: unknown) => {
        if (_name === "template-preview") previewRegistered = true;
      };
      registerTemplateTools(ctx);
      expect(previewRegistered).toBe(true);
    });
  });
});
