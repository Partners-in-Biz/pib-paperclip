/**
 * Paperclip runs on its own: no plugin may call the old partnersinbiz-web site's API (the Drive and ad-connections
 * brokers were the last two, removed in CRM 0.28.0 and Ads 0.3.7). This scans every plugin's own source and fails
 * on a call to the apex site's /api, its broker routes, its broker settings, or its bearer-token prefixes.
 * The brand domain stays fine for user agents, mailto links and the paperclip./preview./mail. subdomains.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGINS = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "tests" || name === "test") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".generated.ts") ? [path] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["a call to the old site's API", /https?:\/\/(?:www\.)?partnersinbiz\.online\/api\b/],
  ["a base URL that defaults to the old site", /(?:BrokerUrl|BASE_URL|baseUrl)\s*[:=]\s*["']https:\/\/partnersinbiz\.online["']/],
  ["an old-site broker route", /workspace-broker|workspace-folders|\/api\/v1\/agent\/|\/api\/v1\/ads\/(?:connections|google|meta)/],
  ["an old-site broker setting", /\b(?:driveBrokerUrl|driveBrokerToken|webBrokerUrl|webBrokerToken|webOrgId)\b/],
  ["an old-site bearer token", /\bpib_(?:usr|dlg|rt|ag|ak)_/],
  ["the old site's org header", /["']X-Org-Id["']/i],
];

describe("no plugin depends on the old site's API", () => {
  // Every package that is ours: plugin-*, pib-* (kit, ui, browser, build host, WordPress connector). Not the upstream SDK, examples or sandbox providers.
  const files = readdirSync(PLUGINS)
    .filter((d) => (d.startsWith("plugin-") || d.startsWith("pib-")) && statSync(join(PLUGINS, d)).isDirectory())
    .flatMap((d) => sourceFiles(join(PLUGINS, d)));

  it("scans a meaningful number of source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const [what, pattern] of FORBIDDEN) {
    it(`has no ${what}`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, "utf8")));
      expect(hits.map((f) => f.slice(PLUGINS.length))).toEqual([]);
    });
  }
});
