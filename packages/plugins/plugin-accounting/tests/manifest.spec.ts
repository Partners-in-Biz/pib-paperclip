import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL, LEDGER_SOURCES, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
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
    expect(manifest.version).toBe("0.3.2");
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

  it("ships the tools the Bookkeeper needs for the whole monthly cycle", () => {
    expect(ACCOUNTING_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "accept-categorisation", "balance-sheet", "create-manual-journal", "gl", "import-statement", "list-accounts", "list-bank-accounts", "list-bank-lines",
        "mark-not-needed", "mark-statement-email", "pdf-statements", "period-close-checklist", "pnl", "prepare-reconciliation", "prepare-vat201", "suggest-categorisation", "trial-balance", "vat-summary",
      ].sort(),
    );
    for (const tool of ACCOUNTING_TOOLS) expect(manifest.tools?.some((t) => t.name === tool.name)).toBe(true);
  });

  it("every tool parameter has a description, and fixed values an enum", () => {
    type Prop = { description?: string; enum?: unknown[]; items?: Prop & { properties?: Record<string, Prop> }; properties?: Record<string, Prop> };
    const walk = (tool: string, props: Record<string, Prop>, path: string) => {
      for (const [name, prop] of Object.entries(props)) {
        expect(prop.description, `${tool}.${path}${name}`).toMatch(/\S/);
        if (prop.items?.properties) walk(tool, prop.items.properties, `${path}${name}[].`);
      }
    };
    for (const tool of ACCOUNTING_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      walk(tool.name, ((tool.parametersSchema as { properties?: Record<string, Prop> }).properties ?? {}), "");
    }
    const props = (name: string) => (ACCOUNTING_TOOLS.find((t) => t.name === name)!.parametersSchema as { properties: Record<string, Prop> }).properties;
    expect(props("import-statement").format!.enum).toEqual(["auto", "csv", "ofx", "mt940"]);
    expect(props("list-bank-lines").status!.enum).toEqual(["unreconciled", "matching", "reconciled", "excluded"]);
    expect(props("accept-categorisation").taxCode!.enum).toContain("za_std_15");
  });

  it("the managed skill has a unique pib- slug and the hire role points at it", () => {
    expect(SKILLS).toHaveLength(1);
    expect(SKILLS[0]!.slug).toBe("pib-bookkeeping");
    expect(SKILLS[0]!.markdown).toMatch(/^---\nname: pib-bookkeeping\nslug: pib-bookkeeping/);
    expect(SKILLS[0]!.markdown).toMatch(/Never post, lock or approve yourself/);
    expect(SKILL_CANONICAL_KEY).toBe("plugin/partnersinbiz-accounting/bookkeeping");
    expect(BOOKKEEPER_ROLE).toMatchObject({ roleKey: "bookkeeper", displayName: "Bookkeeper", pluginKey: PLUGIN_ID, budgetMonthlyCents: 2000 });
    expect(BOOKKEEPER_ROLE.capabilities).toContain("80%");
    expect(BOOKKEEPER_ROLE.skills[0]).toMatchObject({ key: SKILL_CANONICAL_KEY, slug: SKILL_SLUG });
    // The company operating manual is always last.
    expect(BOOKKEEPER_ROLE.skills.at(-1)).toEqual(COMPANY_OS_HIRE_SKILL);
  });

  it("the skill walks the whole monthly cycle and asks people through ask-owner, never in comments", () => {
    const md = SKILLS[0]!.markdown!;
    for (const step of ["### 1. Statement in", "### 2. Match", "### 3. Reconcile", "### 4. VAT201", "### 5. Month-end close", "## What only a person does"]) expect(md, step).toContain(step);
    for (const tool of ACCOUNTING_TOOLS) expect(md, tool.name).toContain(`\`${tool.name}\``);
    expect(md).toContain("partnersinbiz.mailbox:get-attachment");
    expect(md).toContain(ASK_OWNER_TOOL);
    expect(md).not.toMatch(/leave a comment|comment on your issue for a person|tell a person/i);
    expect(BOOKKEEPER_ROLE.instructions).toContain(ASK_OWNER_TOOL);
    expect(BOOKKEEPER_ROLE.instructions).not.toMatch(/leave a comment/i);
  });

  it("merges the plugin tools grant without duplicating it", () => {
    const first = mergeToolsGrant([{ permissionKey: "tasks:assign", scope: null }]);
    expect(first.added).toBe(true);
    expect(first.grants).toHaveLength(2);
    expect(mergeToolsGrant(first.grants).added).toBe(false);
  });
});
