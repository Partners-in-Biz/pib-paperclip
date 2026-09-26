import { describe, expect, it } from "vitest";
import type { SetupItem, SetupStatus } from "../src/kit-setup.js";
import { MODULE_KEYS } from "../src/kit-setup.js";
import { isEmptyValue, mergeMissing, planCopy, secretFields, stripSecrets } from "../src/copy.js";
import { finishSetupContent, finishSetupMissing } from "../src/finish-issue.js";
import { guidedOrder, itemPhase, overallProgress } from "../src/guide.js";
import { allModulesOn, crmHint, effectiveModules, normalizeModules, ORDERED_MODULES } from "../src/modules.js";
import { linkFor, parseSetupStatus, standInStatus } from "../src/status.js";

const item = (key: string, status: SetupItem["status"], extra: Partial<SetupItem> = {}): SetupItem => ({ key, title: key, status, required: true, ...extra });
const status = (plugin: string, items: SetupItem[], module: SetupStatus["module"] = null): SetupStatus => ({ plugin, module, title: plugin, items, checkedAt: "2026-09-26T10:00:00.000Z" });

describe("module switches", () => {
  it("fills unspecified modules with on and drops unknown keys", () => {
    expect(normalizeModules({ seo: false, nope: true })).toEqual({ ...allModulesOn(), seo: false });
    expect(Object.keys(normalizeModules({})).sort()).toEqual([...MODULE_KEYS].sort());
  });

  it("refuses non-boolean switches and non-objects", () => {
    expect(() => normalizeModules({ seo: "no" })).toThrow(/seo must be true or false/);
    expect(() => normalizeModules(null)).toThrow(/modules must be an object/);
    expect(() => normalizeModules([true])).toThrow();
  });

  it("treats no saved choice as everything on", () => {
    expect(effectiveModules(null)).toEqual(allModulesOn());
    expect(effectiveModules({ payroll: false }).payroll).toBe(false);
  });

  it("hints (does not force) CRM when a module that reads its clients is on", () => {
    expect(crmHint({ crm: true, seo: true })).toBeNull();
    expect(crmHint({ ...allModulesOn(), crm: false })).toMatch(/Social media, SEO, Billing, Email campaigns take their clients from the CRM/);
    expect(crmHint({ crm: false, social: false, seo: false, billing: false, campaigns: false })).toBeNull();
    expect(crmHint({ crm: false, social: false, seo: false, billing: false, campaigns: true })).toMatch(/Email campaigns takes its clients/);
  });

  it("orders CRM and Mailbox first", () => {
    expect(ORDERED_MODULES.slice(0, 2)).toEqual(["crm", "mailbox"]);
    expect(ORDERED_MODULES).toHaveLength(MODULE_KEYS.length);
  });
});

describe("copy setup", () => {
  const schema = {
    type: "object",
    properties: {
      timezone: { type: "string" },
      apiKey: { title: "API key", format: "secret-ref" },
      r2: { type: "object", properties: { bucket: { type: "string" }, secretAccessKey: { title: "R2 secret", format: "secret-ref" } } },
    },
  };

  it("finds secret fields in the schema", () => {
    expect(secretFields(schema)).toEqual([
      { path: "apiKey", title: "API key" },
      { path: "r2.secretAccessKey", title: "R2 secret" },
    ]);
  });

  it("strips secret refs anywhere, schema secret fields, and company ids", () => {
    const source = {
      timezone: "Africa/Johannesburg",
      apiKey: "typed-in-plain-text",
      r2: { bucket: "docs", secretAccessKey: { type: "secret_ref", secretId: "s1" } },
      other: { type: "secret_ref", secretId: "s2" },
      list: [{ type: "secret_ref", secretId: "s3" }, "keep"],
      agentId: "3f2b1c4d-1111-4222-8333-944445555666",
      jev: { enabled: true },
    };
    const { config, removed } = stripSecrets(source, schema);
    expect(config).toEqual({ timezone: "Africa/Johannesburg", r2: { bucket: "docs" }, list: ["keep"], jev: { enabled: true } });
    expect(removed).toEqual([
      { path: "apiKey", reason: "secret" },
      { path: "r2.secretAccessKey", reason: "secret" },
      { path: "other", reason: "secret" },
      { path: "list[0]", reason: "secret" },
      { path: "agentId", reason: "company-id" },
    ]);
    // Never mutates the source.
    expect(source.r2.secretAccessKey).toEqual({ type: "secret_ref", secretId: "s1" });
  });

  it("merges without overwriting what the target has", () => {
    const target = { timezone: "Europe/London", r2: { prefix: "pib/" }, empty: "", tags: [] as string[], flag: false };
    const source = { timezone: "Africa/Johannesburg", r2: { bucket: "docs", prefix: "x/" }, empty: "filled", tags: ["a"], flag: true, fresh: 5, blank: {} };
    const { merged, added } = mergeMissing(target, source);
    expect(merged).toEqual({ timezone: "Europe/London", r2: { prefix: "pib/", bucket: "docs" }, empty: "filled", tags: ["a"], flag: false, fresh: 5 });
    expect(added.map((entry) => entry.path)).toEqual(["r2.bucket", "empty", "tags", "fresh"]);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
  });

  it("plans a copy and lists the secrets the target still has to pick", () => {
    const plan = planCopy({
      source: { timezone: "Africa/Johannesburg", apiKey: { type: "secret_ref", secretId: "s1" }, r2: { bucket: "docs" } },
      target: { r2: { secretAccessKey: { type: "secret_ref", secretId: "mine" } } },
      schema,
    });
    expect(plan.merged).toEqual({ timezone: "Africa/Johannesburg", r2: { bucket: "docs", secretAccessKey: { type: "secret_ref", secretId: "mine" } } });
    expect(plan.secretsToPick).toEqual([{ path: "apiKey", title: "API key" }]);
    expect(plan.removed).toEqual([{ path: "apiKey", reason: "secret" }]);
  });

  it("copies into a company with no saved settings", () => {
    const plan = planCopy({ source: { timezone: "UTC" }, target: {}, schema: undefined });
    expect(plan.merged).toEqual({ timezone: "UTC" });
    expect(plan.added).toEqual([{ path: "timezone", value: "UTC" }]);
  });
});

describe("guided order", () => {
  it("classifies items into settings, connections, agents, first data", () => {
    expect(itemPhase({ key: "settings", title: "Save the plugin settings" })).toBe(0);
    expect(itemPhase({ key: "gmail", title: "Connect Gmail" })).toBe(1);
    expect(itemPhase({ key: "service_account", title: "Share the site with the service account" })).toBe(1);
    expect(itemPhase({ key: "jev_key", title: "Jev API key" })).toBe(1);
    expect(itemPhase({ key: "agent", title: "Hire the SEO agent" })).toBe(2);
    expect(itemPhase({ key: "hire_bookkeeper", title: "Hire the bookkeeper" })).toBe(2);
    expect(itemPhase({ key: "first_sprint", title: "Start the first sprint" })).toBe(3);
  });

  it("walks settings → connections → agents → first data, CRM and Mailbox first within a phase", () => {
    const order = guidedOrder([
      { module: "seo", pluginKey: "partnersinbiz.seo", status: status("partnersinbiz.seo", [item("first_sprint", "missing"), item("agent", "missing"), item("settings", "missing"), item("gsc", "missing", { title: "Connect Search Console" })]) },
      { module: "crm", pluginKey: "partnersinbiz.crm", status: status("partnersinbiz.crm", [item("settings", "missing"), item("import", "missing", { title: "Import contacts" })]) },
      { module: "mailbox", pluginKey: "partnersinbiz.mailbox", status: status("partnersinbiz.mailbox", [item("settings", "done"), item("gmail", "missing")]) },
      { module: "billing", pluginKey: "partnersinbiz.billing", status: null },
    ]);
    expect(order.map((entry) => entry.id)).toEqual([
      "partnersinbiz.crm:settings",
      "partnersinbiz.seo:settings",
      "partnersinbiz.mailbox:gmail",
      "partnersinbiz.seo:gsc",
      "partnersinbiz.seo:agent",
      "partnersinbiz.crm:import",
      "partnersinbiz.seo:first_sprint",
    ]);
  });

  it("skips done, optional and skipped items, and never puts an item before what it waits on", () => {
    const order = guidedOrder([
      {
        module: "social",
        pluginKey: "partnersinbiz.social",
        status: status("partnersinbiz.social", [
          item("settings", "done"),
          item("hire_agent", "blocked", { title: "Hire the social agent", blockedBy: ["first_post"] }),
          item("first_post", "missing", { title: "Schedule a first post" }),
          item("growth_lab", "missing", { required: false }),
          item("account", "missing", { title: "Connect an account" }),
        ]),
      },
    ], new Set(["partnersinbiz.social:account"]));
    expect(order.map((entry) => entry.item.key)).toEqual(["first_post", "hire_agent"]);
    expect(order[1]!.phase).toBe(3);
  });

  it("totals progress over reported statuses", () => {
    expect(overallProgress([status("a", [item("x", "done"), item("y", "missing"), item("z", "missing", { required: false })]), null])).toEqual({ done: 1, total: 2, percent: 50 });
    expect(overallProgress([]).percent).toBe(100);
  });
});

describe("setup status parsing", () => {
  it("accepts a plain status, a {data} wrapper and a stored {status} row", () => {
    const raw = { plugin: "partnersinbiz.crm", module: "crm", title: "CRM", items: [{ key: "settings", title: "Save", status: "missing", required: true, action: { plugin: "partnersinbiz.crm", key: "crm.setup", label: "Do it" } }], checkedAt: "2026-09-26T10:00:00.000Z" };
    for (const body of [raw, { data: raw }, { status: raw, receivedAt: "x" }]) {
      const parsed = parseSetupStatus(body);
      expect(parsed?.plugin).toBe("partnersinbiz.crm");
      expect(parsed?.items[0]).toMatchObject({ key: "settings", status: "missing", required: true, action: { key: "crm.setup", label: "Do it" } });
    }
  });

  it("drops malformed items and rejects non-statuses", () => {
    expect(parseSetupStatus({ error: "nope" })).toBeNull();
    expect(parseSetupStatus(null)).toBeNull();
    const parsed = parseSetupStatus({ items: [{ key: "a" }, { key: "b", title: "B", status: "weird" }] }, "partnersinbiz.seo");
    expect(parsed?.plugin).toBe("partnersinbiz.seo");
    expect(parsed?.items).toEqual([expect.objectContaining({ key: "b", status: "unknown", required: false })]);
  });

  it("builds company links for Paperclip paths and leaves https alone", () => {
    expect(linkFor("/crm?tab=x", "PIB")).toBe("/PIB/crm?tab=x");
    expect(linkFor("setup", null)).toBe("/setup");
    expect(linkFor("https://search.google.com", "PIB")).toBe("https://search.google.com");
  });

  it("stands in for a plugin that cannot report", () => {
    expect(standInStatus({ pluginKey: "partnersinbiz.seo", module: "seo", kind: "not-ready" }).items[0]).toMatchObject({ title: "Update or enable the plugin", href: "/company/settings/instance/plugins" });
    expect(standInStatus({ pluginKey: "partnersinbiz.seo", module: "seo", kind: "no-settings", pluginId: "uuid-1" }).items[0]!.href).toBe("/company/settings/instance/plugins/uuid-1");
  });
});

describe("finish setup content", () => {
  const installed = { "partnersinbiz.crm": { id: "crm-id" }, "partnersinbiz.seo": { id: "seo-id" }, "partnersinbiz.mailbox": { id: "mb-id" } };

  it("lists missing required items of enabled modules with deep links", () => {
    const content = finishSetupContent({
      modules: { ...allModulesOn(), seo: false },
      statuses: {
        "partnersinbiz.crm": status("partnersinbiz.crm", [
          item("settings", "done"),
          item("gmail", "missing", { title: "Connect Gmail", detail: "Sequences send through it.", href: "/mailbox", hrefLabel: "Open Mailbox", agentNext: "Sends due sequence steps.", action: { plugin: "partnersinbiz.crm", key: "crm.x", label: "Do it for me" } }),
          item("nice", "missing", { required: false }),
        ]),
        "partnersinbiz.seo": status("partnersinbiz.seo", [item("settings", "missing")]),
      },
      installed,
      prefix: "PIB",
    });
    expect(content?.title).toBe("Finish setup: 2 items left");
    expect(content?.description).toContain("## CRM (1 of 2 done)");
    expect(content?.description).toContain("- [ ] **Connect Gmail** — Sequences send through it. [Open Mailbox](/PIB/mailbox)");
    expect(content?.description).toContain("Once done: Sends due sequence steps.");
    expect(content?.description).toContain('"Do it for me"');
    // Installed, enabled, never reported → settings not saved yet.
    expect(content?.description).toContain("## Mailbox (Gmail) (0 of 1 done)");
    expect(content?.description).toContain("[Open settings](/PIB/company/settings/instance/plugins/mb-id)");
    // SEO is off: not listed. Uninstalled enabled modules are mentioned but not counted.
    expect(content?.description).not.toContain("## SEO");
    expect(content?.description).toContain("Switched on but not installed: Cockpit & team, Social media, Email campaigns, Billing, Accounting, Payroll, Partners.");
    expect(content?.description).toContain("[Open the Setup page](/PIB/setup)");
    expect(content?.missing.map((m) => `${m.module}:${m.item.key}`)).toEqual(["crm:gmail", "mailbox:settings"]);
  });

  it("is null when nothing required is missing", () => {
    const modules = Object.fromEntries(MODULE_KEYS.map((key) => [key, key === "crm"]));
    expect(finishSetupContent({ modules, statuses: { "partnersinbiz.crm": status("partnersinbiz.crm", [item("settings", "done"), item("x", "missing", { required: false })]) }, installed, prefix: null })).toBeNull();
    expect(finishSetupMissing({ modules, statuses: {}, installed, prefix: null }).missing).toHaveLength(1);
  });
});
