/**
 * Snapshot of all seven access presets (PAR-12578 plan, section 4.7; PAR-12633).
 *
 * The five older lists are the keys each preset produced on `development` on
 * 17 Nov 2026, before the catalog grew. A resource added to the catalog must not
 * reach any preset by itself: change a list here only on purpose.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARDED_PLUGINS, PIB_PLUGINS, isGuardedPlugin } from "../src/index.js";
import {
  PERMISSION_CATALOG,
  PRESETS,
  audit,
  clean,
  decideAccess,
  isPermissionKey,
  permissionKey,
  roleOf,
  undoAfterFailedAudit,
  type AccessGrant,
} from "../src/permissions.js";

const RECORDED: Record<string, readonly string[]> = {
  salesperson: [
    "crm.contacts:view", "crm.contacts:create", "crm.contacts:edit", "crm.companies:view", "crm.companies:create",
    "crm.companies:edit", "crm.deals:view", "crm.deals:create", "crm.deals:edit", "crm.projects:view",
    "crm.projects:create", "crm.projects:edit", "billing.invoices:view", "billing.quotes:view",
    "billing.quotes:create", "billing.quotes:edit", "mailbox.mail:view", "mailbox.mail:create",
    "campaigns.campaigns:view",
  ],
  accountant: [
    "accounting.ledger:view", "accounting.ledger:create", "accounting.ledger:edit", "accounting.ledger:delete",
    "accounting.ledger:approve", "accounting.reports:view", "accounting.reports:export", "accounting.settings:view",
    "accounting.settings:edit", "billing.invoices:view", "billing.invoices:create", "billing.invoices:edit",
    "billing.invoices:delete", "billing.invoices:export", "billing.invoices:approve", "billing.quotes:view",
    "billing.quotes:create", "billing.quotes:edit", "billing.quotes:delete", "billing.quotes:approve",
    "billing.reports:view", "billing.reports:export", "billing.settings:view", "billing.settings:edit",
    "payroll.employees:view", "payroll.payruns:view", "payroll.payruns:export", "crm.companies:view",
    "crm.contacts:view",
  ],
  client: [
    "crm.companies:view", "crm.projects:view", "billing.invoices:view", "billing.quotes:view",
  ],
  viewer: [
    "crm.contacts:view", "crm.companies:view", "crm.deals:view", "crm.projects:view", "crm.reports:view",
    "billing.invoices:view", "billing.quotes:view", "billing.reports:view", "social.posts:view",
    "social.accounts:view", "mailbox.mail:view", "seo.work:view", "campaigns.campaigns:view", "partners.grants:view",
    "cockpit.dashboards:view",
  ],
  manager: [
    "crm.contacts:view", "crm.contacts:create", "crm.contacts:edit", "crm.contacts:delete", "crm.contacts:export",
    "crm.companies:view", "crm.companies:create", "crm.companies:edit", "crm.companies:delete", "crm.deals:view",
    "crm.deals:create", "crm.deals:edit", "crm.deals:delete", "crm.projects:view", "crm.projects:create",
    "crm.projects:edit", "crm.projects:delete", "crm.reports:view", "crm.reports:export", "crm.settings:view",
    "crm.settings:edit", "billing.invoices:view", "billing.invoices:create", "billing.invoices:edit",
    "billing.invoices:delete", "billing.invoices:export", "billing.invoices:approve", "billing.quotes:view",
    "billing.quotes:create", "billing.quotes:edit", "billing.quotes:delete", "billing.quotes:approve",
    "billing.reports:view", "billing.reports:export", "billing.settings:view", "billing.settings:edit",
    "social.posts:view", "social.posts:create", "social.posts:edit", "social.posts:delete", "social.posts:approve",
    "social.accounts:view", "social.accounts:create", "social.accounts:edit", "social.accounts:delete",
    "social.settings:view", "social.settings:edit", "mailbox.mail:view", "mailbox.mail:create", "mailbox.mail:edit",
    "mailbox.mail:delete", "mailbox.settings:view", "mailbox.settings:edit", "seo.work:view", "seo.work:create",
    "seo.work:edit", "seo.work:delete", "seo.work:approve", "seo.work:export", "seo.settings:view",
    "seo.settings:edit", "campaigns.campaigns:view", "campaigns.campaigns:create", "campaigns.campaigns:edit",
    "campaigns.campaigns:delete", "campaigns.campaigns:approve", "campaigns.settings:view", "campaigns.settings:edit",
    "partners.grants:view", "partners.grants:create", "partners.grants:edit", "partners.grants:delete",
    "cockpit.dashboards:view", "cockpit.dashboards:export", "cockpit.settings:view", "cockpit.settings:edit",
  ],
  clientManager: [
    "crm.contacts:view", "crm.contacts:create", "crm.contacts:edit", "crm.contacts:delete", "crm.contacts:export",
    "crm.companies:view", "crm.companies:create", "crm.companies:edit", "crm.companies:delete", "crm.deals:view",
    "crm.deals:create", "crm.deals:edit", "crm.deals:delete", "crm.projects:view", "crm.projects:create",
    "crm.projects:edit", "crm.projects:delete", "billing.invoices:view", "billing.invoices:create",
    "billing.invoices:edit", "billing.invoices:delete", "billing.invoices:export", "billing.invoices:approve",
    "billing.quotes:view", "billing.quotes:create", "billing.quotes:edit", "billing.quotes:delete",
    "billing.quotes:approve", "seo.work:view", "seo.work:create", "seo.work:edit", "seo.work:delete",
    "seo.work:approve", "seo.work:export", "social.posts:view", "social.posts:create", "social.posts:edit",
    "social.posts:delete", "social.posts:approve", "social.accounts:view", "social.accounts:create",
    "social.accounts:edit", "social.accounts:delete", "campaigns.campaigns:view", "campaigns.campaigns:create",
    "campaigns.campaigns:edit", "campaigns.campaigns:delete", "campaigns.campaigns:approve", "ads.work:view",
    "ads.work:create", "ads.work:edit", "ads.work:delete", "ads.work:approve", "crm.sites:view", "crm.sites:create",
    "crm.sites:edit", "crm.sites:delete", "crm.esign:view", "crm.esign:create", "crm.esign:edit", "crm.esign:delete",
    "crm.care:view", "crm.care:create", "crm.care:edit", "crm.care:delete", "crm.drive:view", "crm.drive:create",
    "crm.drive:delete", "crm.desk:view", "crm.desk:edit", "crm.sequences:view", "crm.sequences:create",
    "crm.sequences:edit", "crm.sequences:delete",
  ],
};

const allKeys = () => PERMISSION_CATALOG.flatMap((r) => r.actions.map((a) => permissionKey(r.id, a)));

describe("presets", () => {
  it("has exactly the seven presets", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["accountant", "client", "clientManager", "fullAccess", "manager", "salesperson", "viewer"]);
  });

  for (const id of Object.keys(RECORDED)) {
    it(`${id} has exactly its recorded keys, in order`, () => {
      expect(PRESETS[id as keyof typeof PRESETS].permissions).toEqual(RECORDED[id]);
    });
  }

  it("Full access is every catalog key, scope all", () => {
    expect(PRESETS.fullAccess.scope).toBe("all");
    expect([...PRESETS.fullAccess.permissions].sort()).toEqual(allKeys().sort());
  });

  it("keeps each older preset's scope", () => {
    expect(Object.fromEntries(Object.values(PRESETS).map((p) => [p.id, p.scope]))).toEqual({
      salesperson: "all", accountant: "all", client: "linked", viewer: "all", manager: "all", clientManager: "linked", fullAccess: "all",
    });
  });

  it("Client manager has no voice, settings, reports, Accounting, Payroll, Setup, Mailbox or Cockpit", () => {
    const bad = PRESETS.clientManager.permissions.filter((k) =>
      /^(voice|accounting|payroll|setup|mailbox|cockpit)\.|\.(settings|reports):/.test(k),
    );
    expect(bad).toEqual([]);
    expect(PRESETS.clientManager.permissions.every((k) => PERMISSION_CATALOG.find((r) => k.startsWith(`${r.id}:`))?.scopable)).toBe(true);
  });

  it("every preset key is a catalog key", () => {
    for (const p of Object.values(PRESETS)) expect(p.permissions.filter((k) => !isPermissionKey(k))).toEqual([]);
  });

  it("Client manager is limited to the person's own companies", () => {
    const grant: AccessGrant = {
      userId: "u", preset: "clientManager", allow: [], deny: [], linkedCompanyIds: ["c1"], scopeOverrides: {}, updatedBy: null, updatedAt: "",
    };
    const access = { userId: "u", bypass: false, grant };
    expect(decideAccess(access, "crm.sites", "edit")).toEqual({ allowed: true, scope: "linked", companyIds: ["c1"] });
    expect(decideAccess(access, "voice.use", "view").allowed).toBe(false);
    expect(decideAccess(access, "billing.bank", "view").allowed).toBe(false);
  });
});

describe("catalog additions (plan 4.7)", () => {
  const CRUD = ["view", "create", "edit", "delete"];
  const expected: Array<[string, string[], boolean]> = [
    ["billing.expenses", [...CRUD, "approve", "export"], false],
    ["billing.bills", [...CRUD, "approve", "export"], false],
    ["billing.time", CRUD, true],
    ["billing.plans", CRUD, true],
    ["billing.bank", ["view", "edit"], false],
    ["accounting.bank", ["view", "edit", "approve"], false],
    ["accounting.assets", CRUD, false],
    ["crm.desk", ["view", "edit"], true],
    ["crm.sequences", CRUD, true],
    ["crm.sites", CRUD, true],
    ["crm.esign", CRUD, true],
    ["crm.care", CRUD, true],
    ["crm.drive", ["view", "create", "delete"], true],
    ["mailbox.accounts", CRUD, false],
    ["cockpit.paper", ["view", "create", "edit", "approve"], false],
    ["ads.work", [...CRUD, "approve"], true],
    ["studio.work", [...CRUD, "export"], false],
    ["telephony.calls", ["view", "create"], false],
    ["voice.use", ["view", "create"], false],
    ["ads.settings", ["view", "edit"], false],
    ["studio.settings", ["view", "edit"], false],
    ["telephony.settings", ["view", "edit"], false],
    ["voice.settings", ["view", "edit"], false],
  ];
  for (const [id, actions, scopable] of expected) {
    it(`${id}: ${actions.join(", ")}${scopable ? ", scopable" : ""}`, () => {
      const r = PERMISSION_CATALOG.find((x) => x.id === id);
      expect(r && [...r.actions].sort()).toEqual([...actions].sort());
      expect(Boolean(r?.scopable)).toBe(scopable);
    });
  }

  it("has unique resource ids", () => {
    expect(new Set(PERMISSION_CATALOG.map((r) => r.id)).size).toBe(PERMISSION_CATALOG.length);
  });
});

describe("GUARDED_PLUGINS", () => {
  it("is the 12 PIB_PLUGINS plus Studio, CRM telephony and Voice", () => {
    expect(GUARDED_PLUGINS).toHaveLength(15);
    expect(new Set(GUARDED_PLUGINS).size).toBe(15);
    expect([...GUARDED_PLUGINS].sort()).toEqual(
      [...Object.values(PIB_PLUGINS), "partnersinbiz.studio", "partnersinbiz.crm-telephony", "partnersinbiz.voice"].sort(),
    );
    expect(Object.keys(PIB_PLUGINS)).toHaveLength(12);
    expect(Object.isFrozen(GUARDED_PLUGINS)).toBe(true);
  });

  it("isGuardedPlugin", () => {
    expect(isGuardedPlugin("partnersinbiz.voice")).toBe(true);
    expect(isGuardedPlugin("partnersinbiz.llm-wiki")).toBe(false);
    expect(isGuardedPlugin(undefined)).toBe(false);
  });

  it("names the plugin id each of the three extra plugins declares", () => {
    const PLUGINS = fileURLToPath(new URL("../..", import.meta.url));
    for (const dir of ["plugin-studio", "plugin-crm-telephony", "plugin-voice"]) {
      const ns = readFileSync(join(PLUGINS, dir, "src", "namespace.ts"), "utf8");
      const id = /PLUGIN_ID = "([^"]+)"/.exec(ns)?.[1];
      expect(id && isGuardedPlugin(id), `${dir} id ${id}`).toBe(true);
    }
  });
});

describe("no PiB plugin can write memberships", () => {
  const PLUGINS = fileURLToPath(new URL("../..", import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (["node_modules", "dist", "tests", "test"].includes(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx|mjs|js|json)$/.test(name) ? [path] : [];
    });
  const plugins = readdirSync(PLUGINS).filter((d) => d.startsWith("plugin-") && statSync(join(PLUGINS, d)).isDirectory());

  it("finds every guarded plugin's manifest", () => {
    const manifests = plugins.filter((d) => {
      try { return statSync(join(PLUGINS, d, "src", "manifest.ts")).isFile(); } catch { return false; }
    });
    expect(manifests.length).toBeGreaterThanOrEqual(GUARDED_PLUGINS.length);
  });

  it("no plugin manifest or source lists access.members.write", () => {
    const hits = plugins.flatMap((d) => sources(join(PLUGINS, d))).filter((f) => readFileSync(f, "utf8").includes("access.members.write"));
    expect(hits).toEqual([]);
  });
});

describe("exports for Setup's switch audit (plan 4.1)", () => {
  it("exports audit, undoAfterFailedAudit, clean and roleOf", () => {
    for (const fn of [audit, undoAfterFailedAudit, clean, roleOf]) expect(typeof fn).toBe("function");
  });

  it("clean drops unknown keys and presets", () => {
    expect(clean({ preset: "nope", allow: ["voice.use:view", "x:y"], deny: [] }, "u")).toMatchObject({
      userId: "u", preset: null, allow: ["voice.use:view"],
    });
    expect(clean({ preset: "fullAccess" }, "u")?.preset).toBe("fullAccess");
    expect(clean([], "u")).toBeNull();
  });
});
