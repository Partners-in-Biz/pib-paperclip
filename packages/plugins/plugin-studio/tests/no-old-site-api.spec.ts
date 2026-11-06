/**
 * Studio runs on Paperclip alone: none of its source may call the old partnersinbiz-web site's API. Same patterns as
 * pib-plugin-kit/tests/no-old-site-api.spec.ts, run here too so this package's own test run proves it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
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

describe("Studio doesn't depend on the old site's API", () => {
  const files = sourceFiles(SRC);

  it("scans every source file, including the worker, generation and UI", () => {
    const names = files.map((f) => f.slice(SRC.length + 1));
    expect(names).toEqual(expect.arrayContaining(["worker.ts", "generation.ts", "provider.ts", "storage.ts", join("ui", "index.tsx")]));
  });

  for (const [what, pattern] of FORBIDDEN) {
    it(`has no ${what}`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, "utf8")));
      expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
    });
  }
});
