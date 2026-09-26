import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { checkRules } from "../src/rules.js";
import { RULE_VERSION_2026_27, ruleSeedSql, rulesHash } from "../src/seed.js";

const dir = new URL("../migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");

describe("migrations", () => {
  it("uses the payroll namespace", () => {
    expect(NAMESPACE).toBe("plugin_payroll_c6fcddb95c");
    expect(manifest.database?.namespaceSlug).toBe("payroll");
    for (const match of sql.matchAll(/\b(?:TABLE|ON|INTO|REFERENCES)\s+([a-z_0-9]+)\.[a-z_]+/g)) expect(match[1]).toBe(NAMESPACE);
  });

  it("never deletes or drops and holds no plaintext personal-detail columns", () => {
    const code = sql.replace(/--.*$/gm, "").replace(/'([^']|'')*'/g, "''");
    expect(code).not.toMatch(/\bdelete\b|\bdrop\b|\btruncate\b|\bgrant\b|\brevoke\b|\bcopy\b|\bcall\b/i);
    expect(code).not.toMatch(/\b(id_number|passport_number|tax_reference|account_number|branch_code)\b/);
    for (const column of ["sealed_identity text", "sealed_tax text", "sealed_bank text", "pii_masks jsonb"]) expect(sql).toContain(column);
  });

  it("includes the kit outbox and inbox tables", () => {
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.outbox (`);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.inbox (`);
    expect(sql).toContain(`CREATE INDEX outbox_due ON ${NAMESPACE}.outbox (status, next_attempt_at)`);
  });

  it("seeds exactly the 2026/27 rule version in src/seed.ts", () => {
    expect(sql).toContain(ruleSeedSql(NAMESPACE, RULE_VERSION_2026_27));
    expect(RULE_VERSION_2026_27.contentHash).toBe(rulesHash(RULE_VERSION_2026_27.rules));
    expect(checkRules(RULE_VERSION_2026_27.rules)).toEqual([]);
  });

  it("cites a SARS (or government) source for every rule area", () => {
    const covered = new Set(RULE_VERSION_2026_27.sources.flatMap((s) => s.covers.map((c) => c.split(".")[0])));
    for (const area of ["paye", "rebates", "thresholds", "medicalCredits", "uif", "sdl", "eti", "retirement", "travel"]) expect(covered.has(area)).toBe(true);
    for (const source of RULE_VERSION_2026_27.sources) {
      expect(source.url).toMatch(/^https:\/\/www\.(sars|treasury|labour)\.gov\.za\//);
      expect(source.accessed).toBe("2026-09-26");
    }
  });
});
