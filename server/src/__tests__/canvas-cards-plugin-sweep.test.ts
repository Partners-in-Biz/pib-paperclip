import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * PAR-14411 (plan PAR-14389 E path 9, core half): a plugin that declares an
 * `entityCard` slot must be one of the five card plugins named here, and its
 * worker source must register the card actions through the kit helper
 * `registerCanvasCards`. Adding a sixth plugin means editing this list on
 * purpose. Core still guards every `canvas.cards.*` call whatever a plugin does.
 */

const CARD_PLUGIN_KEYS = [
  "partnersinbiz.crm",
  "partnersinbiz.billing",
  "partnersinbiz.mailbox",
  "partnersinbiz.social",
  "partnersinbiz.campaigns",
] as const;

const PLUGINS_DIR = fileURLToPath(new URL("../../../packages/plugins/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The plugin key: the package's `PLUGIN_ID` constant, else the manifest's literal top-level id. */
function pluginKey(src: string, manifest: string): string | null {
  for (const file of sourceFiles(src)) {
    const match = /export const PLUGIN_ID\s*=\s*"([^"]+)"/.exec(readFileSync(file, "utf8"));
    if (match) return match[1]!;
  }
  return /^\s{2}id:\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null;
}

/** Problems found under a `packages/plugins`-shaped folder; empty when the rule holds. */
function sweepCardPlugins(root: string, allowed: readonly string[] = CARD_PLUGIN_KEYS): string[] {
  const problems: string[] = [];
  for (const dir of readdirSync(root).sort()) {
    const manifestPath = join(root, dir, "src", "manifest.ts");
    if (!existsSync(manifestPath)) continue;
    const manifest = readFileSync(manifestPath, "utf8");
    const src = join(root, dir, "src");
    // The manifest, or any file it builds its slots from.
    if (!sourceFiles(src).some((file) => /\bentityCard\b/.test(readFileSync(file, "utf8")))) continue;
    const key = pluginKey(src, manifest);
    if (!key || !allowed.includes(key)) {
      problems.push(`${dir} (${key ?? "no key found"}) declares entityCard but is not one of the card plugins`);
      continue;
    }
    if (!sourceFiles(src).some((file) => /\bregisterCanvasCards\s*\(/.test(readFileSync(file, "utf8")))) {
      problems.push(`${dir} (${key}) declares entityCard but its worker does not call registerCanvasCards`);
    }
  }
  return problems;
}

describe("entity card plugin sweep (PAR-14389 E path 9)", () => {
  it("the five card keys are the real plugin keys", () => {
    for (const [dir, key] of [["plugin-crm", "partnersinbiz.crm"], ["plugin-billing", "partnersinbiz.billing"],
      ["plugin-mailbox", "partnersinbiz.mailbox"], ["plugin-social", "partnersinbiz.social"], ["plugin-campaigns", "partnersinbiz.campaigns"]]) {
      const src = join(PLUGINS_DIR, dir!, "src");
      expect(pluginKey(src, readFileSync(join(src, "manifest.ts"), "utf8")), dir).toBe(key);
    }
  });

  it("every plugin that declares entityCard is a card plugin and registers through the kit helper", () => {
    expect(readdirSync(PLUGINS_DIR).filter((dir) => existsSync(join(PLUGINS_DIR, dir, "src", "manifest.ts"))).length)
      .toBeGreaterThan(5);
    expect(sweepCardPlugins(PLUGINS_DIR)).toEqual([]);
  });

  describe("on a fixture folder", () => {
    const root = mkdtempSync(join(tmpdir(), "canvas-cards-sweep-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const plugin = (dir: string, key: string, files: Record<string, string>) => {
      mkdirSync(join(root, dir, "src"), { recursive: true });
      writeFileSync(join(root, dir, "src", "namespace.ts"), `export const PLUGIN_ID = "${key}";\n`);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, "src", name), text);
    };
    const cardManifest = `import { PLUGIN_ID } from "./namespace.js";\nexport default { id: PLUGIN_ID, ui: { slots: [\n  { type: "canvasNode", id: "card-x", entityCard: { kind: "x", search: true, related: false } },\n] } };\n`;

    it("passes a listed plugin that registers, and a plugin with no card", () => {
      plugin("plugin-crm", "partnersinbiz.crm", { "manifest.ts": cardManifest,
        "worker.ts": "registerCanvasCards({ register, kinds });\n" });
      plugin("plugin-other", "paperclip.other", { "manifest.ts": "export default { id: PLUGIN_ID };\n" });
      expect(sweepCardPlugins(root)).toEqual([]);
    });

    it("fails a sixth plugin that declares entityCard", () => {
      plugin("plugin-sixth", "partnersinbiz.sixth", { "manifest.ts": cardManifest,
        "worker.ts": "registerCanvasCards({ register, kinds });\n" });
      expect(sweepCardPlugins(root)).toEqual([
        "plugin-sixth (partnersinbiz.sixth) declares entityCard but is not one of the card plugins",
      ]);
      rmSync(join(root, "plugin-sixth"), { recursive: true });
    });

    it("fails a sixth plugin written other ways: a literal manifest id, slots from another file", () => {
      mkdirSync(join(root, "plugin-literal", "src"), { recursive: true });
      writeFileSync(join(root, "plugin-literal", "src", "manifest.ts"),
        `export default {\n  id: "acme.literal",\n  ui: { slots: [{ type: "canvasNode", id: "c", entityCard: { kind: "x", search: false, related: false } }] },\n};\n`);
      plugin("plugin-split", "acme.split", { "manifest.ts": "import { slots } from \"./slots.js\";\nexport default { id: PLUGIN_ID, ui: { slots } };\n",
        "slots.ts": "export const slots = [{ type: \"canvasNode\", id: \"c\", entityCard: { kind: \"x\", search: true, related: true } }];\n" });
      expect(sweepCardPlugins(root)).toEqual([
        "plugin-literal (acme.literal) declares entityCard but is not one of the card plugins",
        "plugin-split (acme.split) declares entityCard but is not one of the card plugins",
      ]);
      rmSync(join(root, "plugin-literal"), { recursive: true });
      rmSync(join(root, "plugin-split"), { recursive: true });
    });

    it("fails a listed plugin whose worker registers the actions by hand", () => {
      plugin("plugin-billing", "partnersinbiz.billing", { "manifest.ts": cardManifest,
        "worker.ts": "ctx.actions.register(\"canvas.cards.resolve\", handler);\n",
        "worker.test.ts": "registerCanvasCards({ register, kinds });\n" });
      expect(sweepCardPlugins(root)).toEqual([
        "plugin-billing (partnersinbiz.billing) declares entityCard but its worker does not call registerCanvasCards",
      ]);
    });
  });
});
