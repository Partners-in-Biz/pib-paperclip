import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEDGER_SOURCES, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { SKILL_CANONICAL_KEY, SKILL_SLUG, SKILLS } from "../src/skills.js";
import { ACCOUNTING_TOOLS } from "../src/tools.js";
import { BOOKKEEPER_ROLE, mergeToolsGrant } from "../src/service/agent.js";

describe("manifest", () => {
  it("is the accounting plugin with its namespace, page and sidebar", () => {
    expect(manifest.id).toBe(PIB_PLUGINS.accounting);
    expect(PLUGIN_ID).toBe("partnersinbiz.accounting");
    expect(NAMESPACE).toBe("plugin_accounting_03d0185a67");
    expect(manifest.database).toMatchObject({ namespaceSlug: "accounting", migrationsDir: "migrations" });
    expect(manifest.ui?.slots).toEqual([
      expect.objectContaining({ type: "page", exportName: "AccountingPage", routePath: "accounting" }),
      expect.objectContaining({ type: "sidebar", exportName: "AccountingSidebar" }),
    ]);
  });

  it("declares the capabilities its host calls need", () => {
    for (const cap of [
      "database.namespace.migrate", "database.namespace.read", "database.namespace.write", "agent.tools.register", "skills.managed",
      "agents.read", "authorization.grants.read", "authorization.grants.write", "issues.read", "issues.create", "issues.update",
      "issues.wakeup", "issue.comments.create", "secrets.read-ref", "http.outbound", "plugin.state.read", "plugin.state.write",
      "jobs.schedule", "events.subscribe", "events.emit", "ui.page.register", "ui.sidebar.register",
    ]) {
      expect(manifest.capabilities, cap).toContain(cap);
    }
    expect(manifest.capabilities).not.toContain("agents.managed");
  });

  it("serves the setup status route and matches the package version", async () => {
    const { SETUP_STATUS_ROUTE } = await import("@partnersinbiz/pib-plugin-kit");
    const { COCKPIT_ROUTE } = await import("@partnersinbiz/pib-plugin-kit");
    expect(manifest.apiRoutes).toEqual([SETUP_STATUS_ROUTE, COCKPIT_ROUTE]);
    expect(manifest.capabilities).toContain("api.routes.register");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toBe("0.1.2");
  });

  it("schedules redeliver, month-end and FX jobs", () => {
    expect(manifest.jobs?.map((j) => j.jobKey)).toEqual(["redeliver", "month-end", "fx-rates"]);
  });

  it("settings: VAT category, year end, Jev and a private R2 block with secret refs", () => {
    const props = (manifest.instanceConfigSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect((props.vatCategory!.enum as string[])).toEqual(["A", "B", "C", "D", "E", "none"]);
    expect(props.financialYearEndMonth).toMatchObject({ minimum: 1, maximum: 12, default: 2 });
    const jev = props.jev as { properties: Record<string, Record<string, unknown>> };
    expect(jev.properties.apiKey).toMatchObject({ format: "secret-ref" });
    expect(jev.properties.apiKey!.type).toBeUndefined();
    const r2 = props.r2 as { properties: Record<string, Record<string, unknown>> };
    expect(r2.properties.secretAccessKey).toMatchObject({ format: "secret-ref" });
    expect(r2.properties.secretAccessKey!.type).toBeUndefined();
  });

  it("listens to every ledger source", () => {
    expect(LEDGER_SOURCES).toEqual([PIB_PLUGINS.billing, PIB_PLUGINS.payroll]);
  });

  it("ships the tools the Bookkeeper needs", () => {
    expect(ACCOUNTING_TOOLS.map((t) => t.name).sort()).toEqual(
      ["accept-categorisation", "balance-sheet", "create-manual-journal", "gl", "list-accounts", "list-bank-lines", "period-close-checklist", "pnl", "suggest-categorisation", "trial-balance", "vat-summary"].sort(),
    );
    for (const tool of ACCOUNTING_TOOLS) expect(manifest.tools?.some((t) => t.name === tool.name)).toBe(true);
  });

  it("the managed skill has a unique pib- slug and the hire role points at it", () => {
    expect(SKILLS).toHaveLength(1);
    expect(SKILLS[0]!.slug).toBe("pib-bookkeeping");
    expect(SKILLS[0]!.markdown).toMatch(/^---\nname: pib-bookkeeping\nslug: pib-bookkeeping/);
    expect(SKILLS[0]!.markdown).toMatch(/Never post, lock or approve on your own/);
    expect(SKILL_CANONICAL_KEY).toBe("plugin/partnersinbiz-accounting/bookkeeping");
    expect(BOOKKEEPER_ROLE).toMatchObject({ roleKey: "bookkeeper", displayName: "Bookkeeper", pluginKey: PLUGIN_ID, budgetMonthlyCents: 2000 });
    expect(BOOKKEEPER_ROLE.capabilities).toContain("80%");
    expect(BOOKKEEPER_ROLE.skills[0]).toMatchObject({ key: SKILL_CANONICAL_KEY, slug: SKILL_SLUG });
  });

  it("merges the plugin tools grant without duplicating it", () => {
    const first = mergeToolsGrant([{ permissionKey: "tasks:assign", scope: null }]);
    expect(first.added).toBe(true);
    expect(first.grants).toHaveLength(2);
    expect(mergeToolsGrant(first.grants).added).toBe(false);
  });
});
