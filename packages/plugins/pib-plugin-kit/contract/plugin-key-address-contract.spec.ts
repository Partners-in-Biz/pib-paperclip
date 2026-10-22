/**
 * Contract: plugin source code must not hardcode plugin-key addresses.
 *
 * The host serves plugin files only under the installation id:
 * `/_plugins/<installation uuid>/ui/...`
 *
 * A plugin-key address like `/_plugins/partnersinbiz.cockpit/...` 404s at runtime.
 * Plugins must build the address from the runtime installation id via
 * `pluginUiBaseFromModule(import.meta.url)`, never hardcode the plugin key.
 *
 * Run with `corepack pnpm test:contract -- plugin-key-address` or as part of
 * `corepack pnpm test`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * Scans a source string and returns all string literals containing a
 * plugin-key address pattern `/_plugins/<key>/` where key matches
 * `[a-z0-9-]+\.[a-z0-9.-]+` (e.g. partnersinbiz.cockpit).
 *
 * Allows:
 * - `${...}` template interpolation (dynamic addresses)
 * - `<installation uuid>` placeholders (uuid-like text)
 * - Comment-only lines (starting with //, *, or /*)
 *
 * @param source The source code string
 * @param file The file path for error reporting
 * @returns Array of hits with file, line number, and trimmed line text
 */
function findKeyAddressLiterals(source: string, file: string): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comment-only lines
    const trimmed = line.trim();
    const isCommentLine = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
    if (isCommentLine) {
      continue;
    }

    // Look for string literals (single, double, or backtick)
    // Match quoted strings and extract their content
    const stringMatches = line.matchAll(/(['"`])((?:\\.|(?!\1).)*?)\1/g);

    for (const match of stringMatches) {
      const quote = match[1];
      const content = match[2];

      // Check for plugin-key address pattern: /_plugins/<key>/ where key = [a-z0-9-]+\.[a-z0-9.-]+
      if (content.includes("/_plugins/")) {
        // Check for the bad pattern: /_plugins/[a-z0-9-]+\.[a-z0-9.-]+/
        // This pattern requires a dot, so it naturally excludes UUIDs (all hex/hyphens, no dot)
        // and placeholders like <installation uuid> (has angle brackets, not alphanumeric+dot)
        const pluginsKeyPattern = /_plugins\/[a-z0-9-]+\.[a-z0-9.-]+\//;
        if (pluginsKeyPattern.test(content)) {
          hits.push({
            file,
            line: lineNum,
            text: line.trim(),
          });
        }
      }
    }
  }

  return hits;
}

/**
 * Recursively scan all TypeScript/JavaScript source files in a directory.
 * Skip node_modules, dist, and test files.
 */
function scanPluginDir(dir: string): string[] {
  const files: string[] = [];

  function walk(current: string) {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        // Skip these directories
        if (["node_modules", "dist", ".next", ".turbo"].includes(entry.name)) {
          continue;
        }

        const fullPath = join(current, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          // Include .ts, .tsx, .js, .jsx, .mjs but skip test files
          if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(spec|test)\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
            files.push(fullPath);
          }
        }
      }
    } catch (e) {
      // Ignore errors (e.g. permission denied)
    }
  }

  walk(dir);
  return files;
}

/**
 * Discover all plugin directories under packages/plugins/
 */
function discoverPlugins(repoRoot: string): Array<{ name: string; dir: string }> {
  const pluginsDir = join(repoRoot, "packages", "plugins");
  const entries = readdirSync(pluginsDir, { withFileTypes: true });
  const plugins: Array<{ name: string; dir: string }> = [];

  for (const entry of entries) {
    // Only consider directories starting with "plugin-" or "pib-plugin-"
    if ((entry.name.startsWith("plugin-") || entry.name.startsWith("pib-plugin-")) && entry.isDirectory()) {
      plugins.push({
        name: entry.name,
        dir: join(pluginsDir, entry.name),
      });
    }
  }

  return plugins;
}

describe("plugin-key address contract", () => {
  const repoRoot = join(__dirname, "../../../..");
  const plugins = discoverPlugins(repoRoot);

  // Verify we found the expected plugins
  it("discovers at least the known plugins", () => {
    const names = new Set(plugins.map((p) => p.name));
    const knownPlugins = ["plugin-cockpit", "plugin-crm", "plugin-mailbox", "plugin-social", "plugin-seo"];
    for (const known of knownPlugins) {
      expect(names.has(known), `should discover ${known}`).toBe(true);
    }
    // Verify we got more than just the known ones (showing scan is not silently empty)
    expect(plugins.length).toBeGreaterThan(5);
  });

  it("flags a literal key address with the correct line number", () => {
    const source = `// comment
const url = "/_plugins/partnersinbiz.cockpit/ui/x.js";`;
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(2);
  });

  it("allows template `/_plugins/${installationId}/ui/x.js` without flagging", () => {
    const source = "const url = `/_plugins/${installationId}/ui/x.js`;";
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(0);
  });

  it("allows comment-only `// /_plugins/partnersinbiz.cockpit/` without flagging", () => {
    const source = "// /_plugins/partnersinbiz.cockpit/ui/x.js";
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(0);
  });

  it("allows `/_plugins/<installation uuid>/ui/` placeholder without flagging", () => {
    const source = `const url = "/_plugins/<installation uuid>/ui/x.js";`;
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(0);
  });

  it("(e) flags backtick template with no interpolation", () => {
    const source = "const url = `/_plugins/partnersinbiz.cockpit/ui/x.js`;";
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(1);
  });

  it("(f) flags backtick template with interpolation after the key", () => {
    const source = "const url = `/_plugins/partnersinbiz.cockpit/${file}`;";
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(1);
  });

  it("(g) flags keys that start with hex-like letters", () => {
    const source1 = `const url1 = "/_plugins/acme.crm/ui/x.js";`;
    const source2 = `const url2 = "/_plugins/b2b.tools/ui/x.js";`;
    const hits1 = findKeyAddressLiterals(source1, "test1.ts");
    const hits2 = findKeyAddressLiterals(source2, "test2.ts");
    expect(hits1.length).toBe(1);
    expect(hits2.length).toBe(1);
  });

  it("(h) allows real uuid without flagging", () => {
    const source = `const url = "/_plugins/3f2a9c1e-8b7d-4e21-9a55-0c1d2e3f4a5b/ui/x.js";`;
    const hits = findKeyAddressLiterals(source, "test.ts");
    expect(hits.length).toBe(0);
  });

  it("scans all plugin source files and bans key addresses", () => {
    const allHits: Array<{ file: string; line: number; text: string }> = [];

    for (const plugin of plugins) {
      const sourceFiles = scanPluginDir(plugin.dir);
      for (const file of sourceFiles) {
        const source = readFileSync(file, "utf-8");
        const hits = findKeyAddressLiterals(source, file);
        allHits.push(...hits);
      }
    }

    // Format the error message
    const message =
      allHits.length > 0
        ? `Found ${allHits.length} plugin-key address(es). The host serves plugin files only under the installation id; build the address from the runtime installation id (pluginUiBaseFromModule(import.meta.url)), not the plugin key.\n\n` +
          allHits
            .map((hit) => {
              const rel = relative(repoRoot, hit.file);
              return `${rel}:${hit.line}  ${hit.text}`;
            })
            .join("\n")
        : "";

    expect(allHits, message).toEqual([]);
  });
});
