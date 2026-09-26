import { readFileSync } from "node:fs";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { MODULE_KEYS, SETUP_EVENTS, SETUP_PLUGIN, type SetupItem, type SetupStatus } from "../src/kit-setup.js";
import manifest, { JOBS } from "../src/manifest.js";
import { allModulesOn } from "../src/modules.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { handleApiRoute, registerSetup } from "../src/register.js";
import { onStatusEvent, reemitModules, refreshFinishIssue, rememberInstalled, saveModules, weeklyFinishSetup } from "../src/service.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const A = "company-a";
const B = "company-b";
const ONLY_CRM = Object.fromEntries(MODULE_KEYS.map((key) => [key, key === "crm"]));
const INSTALLED = { [PIB_PLUGINS.crm]: { id: "crm-uuid", status: "ready" } };

const item = (key: string, status: SetupItem["status"], extra: Partial<SetupItem> = {}): SetupItem => ({ key, title: key, status, required: true, ...extra });
const crmStatus = (items: SetupItem[], checkedAt = "2026-09-26T10:00:00.000Z"): SetupStatus => ({ plugin: PIB_PLUGINS.crm, module: "crm", title: "CRM", items, checkedAt });

function apiInput(companyId: string, routeKey = "modules"): PluginApiRequestInput {
  return { routeKey, method: "GET", path: "/modules", params: {}, query: { companyId }, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId, headers: {} };
}

describe("manifest and migration", () => {
  it("uses the kit plugin key and the host namespace derivation", () => {
    expect(PLUGIN_ID).toBe(SETUP_PLUGIN);
    expect(NAMESPACE).toBe("plugin_setup_48494712db");
    expect(manifest.database?.namespaceSlug).toBe("setup");
    expect(manifest.version).toBe("0.1.1");
    for (const capability of ["ui.page.register", "ui.sidebar.register", "ui.dashboardWidget.register", "api.routes.register", "events.emit", "events.subscribe", "jobs.schedule", "issues.read", "issues.create", "issues.update", "plugin.state.read", "plugin.state.write", "companies.read", "database.namespace.migrate", "database.namespace.read", "database.namespace.write"]) {
      expect(manifest.capabilities).toContain(capability);
    }
    expect(manifest.ui?.slots?.map((slot) => slot.type)).toEqual(["page", "sidebar", "dashboardWidget"]);
    expect(manifest.apiRoutes?.[0]).toMatchObject({ routeKey: "modules", path: "/modules", auth: "board", companyResolution: { from: "query", key: "companyId" } });
    expect(manifest.jobs?.find((job) => job.jobKey === JOBS.weeklyFinishSetup)?.schedule).toBe("0 5 * * 1");
  });

  it("passes the host migration guard", () => {
    const sql = readFileSync(new URL("../migrations/001_setup.sql", import.meta.url), "utf8");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    for (const statement of statements) validateMigrationStatement(statement, NAMESPACE);
  });
});

describe("module choice", () => {
  it("saves, emits modules.updated and serves GET /modules", async () => {
    const { ctx, emitted, store } = fakeCtx();
    expect(await handleApiRoute(ctx, apiInput(A))).toEqual({ status: 200, body: { modules: null, updatedAt: null } });

    const clock = fixedClock("2026-09-26T08:00:00.000Z");
    const result = await saveModules(ctx, { companyId: A, modules: { seo: false }, userId: "user-1" }, clock);
    expect(result.modules).toEqual({ ...allModulesOn(), seo: false });
    expect(store.module_choices).toEqual([expect.objectContaining({ company_id: A, updated_by: "user-1", updated_at: "2026-09-26T08:00:00.000Z" })]);
    expect(emitted).toEqual([{ name: SETUP_EVENTS.modulesUpdated, companyId: A, payload: { companyId: A, modules: { ...allModulesOn(), seo: false }, updatedAt: "2026-09-26T08:00:00.000Z" } }]);

    const res = await handleApiRoute(ctx, apiInput(A));
    expect(res.status).toBe(200);
    expect((res.body as { modules: Record<string, boolean> }).modules.seo).toBe(false);
    expect((await handleApiRoute(ctx, apiInput(B))).body).toEqual({ modules: null, updatedAt: null });
    expect((await handleApiRoute(ctx, apiInput(A, "other"))).status).toBe(404);
  });

  it("refuses bad input without writing", async () => {
    const { ctx, emitted, store } = fakeCtx();
    await expect(saveModules(ctx, { companyId: A, modules: { crm: "yes" }, userId: "u" })).rejects.toThrow(/crm must be true or false/);
    expect(store.module_choices ?? []).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("re-emits every saved choice hourly, skipping companies without saved Setup settings", async () => {
    const { ctx, emitted } = fakeCtx({ savedConfigs: { [A]: { weeklyIssue: true } } });
    await saveModules(ctx, { companyId: A, modules: { seo: false }, userId: "u" }, fixedClock("2026-09-26T08:00:00.000Z"));
    await saveModules(ctx, { companyId: B, modules: {}, userId: "u" }, fixedClock("2026-09-26T08:05:00.000Z"));
    emitted.length = 0;
    expect(await reemitModules(ctx)).toEqual({ emitted: 1, skipped: 1, failed: 0 });
    expect(emitted).toEqual([{ name: SETUP_EVENTS.modulesUpdated, companyId: A, payload: expect.objectContaining({ companyId: A, updatedAt: "2026-09-26T08:00:00.000Z" }) }]);
  });

  it("wires the action to board users only, with the hourly job", async () => {
    const { ctx, actions, jobs, handlers, emitted } = fakeCtx({ savedConfigs: { [A]: {} } });
    registerSetup(ctx);
    const save = actions.get("setup.save-modules")!;
    await expect(save({ modules: {} }, { companyId: A, actor: { type: "agent", userId: null, agentId: "ag" } })).rejects.toThrow(/board user/);
    await save({ modules: { payroll: false }, installed: INSTALLED }, { companyId: A, actor: { type: "user", userId: "user-9", agentId: null } });
    expect(emitted).toHaveLength(1);
    expect([...jobs.keys()].sort()).toEqual([JOBS.reemitModules, JOBS.weeklyFinishSetup].sort());
    expect([...handlers.keys()].sort()).toEqual(Object.values(PIB_PLUGINS).map((key) => `plugin.${key}.setup.status`).sort());
    const load = (await actions.get("setup.load")!({}, { companyId: A, actor: { type: "user", userId: "user-9" } })) as Record<string, unknown>;
    expect(load).toMatchObject({ modules: expect.objectContaining({ payroll: false }), updatedBy: "user-9", installed: { [PIB_PLUGINS.crm]: { id: "crm-uuid", status: "ready" } } });
  });
});

describe("status projection", () => {
  it("stores the newest status per company and plugin", async () => {
    const { ctx, store, fire } = fakeCtx();
    registerSetup(ctx);
    await fire(`plugin.${PIB_PLUGINS.crm}.setup.status`, { companyId: A, payload: crmStatus([item("settings", "missing")]) });
    await fire(`plugin.${PIB_PLUGINS.crm}.setup.status`, { companyId: A, payload: crmStatus([item("settings", "done")], "2026-09-26T11:00:00.000Z") });
    // An older status arriving late does not replace the newer one.
    await fire(`plugin.${PIB_PLUGINS.crm}.setup.status`, { companyId: A, payload: crmStatus([item("settings", "missing")], "2026-09-26T09:00:00.000Z") });
    await fire(`plugin.${PIB_PLUGINS.seo}.setup.status`, { companyId: B, payload: { data: { ...crmStatus([item("gsc", "missing")]), plugin: "spoofed.plugin" } } });
    expect(store.statuses).toHaveLength(2);
    const a = store.statuses!.find((row) => row.company_id === A)!;
    expect(a.status.items[0].status).toBe("done");
    expect(a.checked_at).toBe("2026-09-26T11:00:00.000Z");
    const b = store.statuses!.find((row) => row.company_id === B)!;
    expect(b.plugin_key).toBe(PIB_PLUGINS.seo);
    expect(b.status.plugin).toBe(PIB_PLUGINS.seo);
  });

  it("ignores payloads that are not a status", async () => {
    const { ctx, store } = fakeCtx();
    expect(await onStatusEvent(ctx, PIB_PLUGINS.crm, { companyId: A, payload: { hello: 1 } } as never)).toBe(false);
    expect(await onStatusEvent(ctx, PIB_PLUGINS.crm, { companyId: "", payload: crmStatus([]) } as never)).toBe(false);
    expect(store.statuses ?? []).toHaveLength(0);
  });
});

describe("Finish setup issue", () => {
  async function setup() {
    const env = fakeCtx({ savedConfigs: { [A]: { weeklyIssue: true } }, prefixes: { [A]: "PIB" } });
    await rememberInstalled(env.ctx, INSTALLED);
    await saveModules(env.ctx, { companyId: A, modules: ONLY_CRM, userId: "owner-1" }, fixedClock("2026-09-26T08:00:00.000Z"));
    return env;
  }

  it("opens one issue for the user who chose the modules, listing never-reported installed modules", async () => {
    const { issues, store } = await setup();
    expect(issues.size).toBe(1);
    const issue = [...issues.values()][0]!;
    expect(issue).toMatchObject({ companyId: A, status: "todo", assigneeUserId: "owner-1", originKind: `plugin:${SETUP_PLUGIN}`, title: "Finish setup: 1 item left" });
    expect(issue.description).toContain("**Save the plugin settings**");
    expect(issue.description).toContain("(/PIB/company/settings/instance/plugins/crm-uuid)");
    expect(store.finish_issues).toEqual([expect.objectContaining({ company_id: A, issue_id: issue.id, missing_count: 1 })]);
  });

  it("updates the open issue when statuses change, leaves it alone when nothing changed, and closes it when done", async () => {
    const { ctx, issues, store } = await setup();
    const id = [...issues.keys()][0]!;
    await onStatusEvent(ctx, PIB_PLUGINS.crm, { companyId: A, payload: crmStatus([item("settings", "done"), item("gmail", "missing", { title: "Connect Gmail", href: "/mailbox" }), item("import", "missing", { title: "Import contacts" })]) } as never);
    expect(issues.size).toBe(1);
    expect(issues.get(id)).toMatchObject({ title: "Finish setup: 2 items left", status: "todo" });
    expect(issues.get(id)!.description).toContain("[Open](/PIB/mailbox)");
    const print = store.finish_issues![0]!.fingerprint;

    expect(await refreshFinishIssue(ctx, A, { allowCreate: true })).toMatchObject({ action: "unchanged", issueId: id });
    expect(store.finish_issues![0]!.fingerprint).toBe(print);

    await onStatusEvent(ctx, PIB_PLUGINS.crm, { companyId: A, payload: crmStatus([item("settings", "done"), item("gmail", "done"), item("import", "done")], "2026-09-26T12:00:00.000Z") } as never);
    expect(issues.get(id)!.status).toBe("done");
    expect(issues.get(id)!.description).toContain("Everything required is set up.");
    expect(store.finish_issues ?? []).toHaveLength(0);
  });

  it("status events never open a new issue; the weekly job does, once per company", async () => {
    const { ctx, issues } = await setup();
    const first = [...issues.values()][0]!;
    first.status = "cancelled"; // a person closed it while items are still missing
    await onStatusEvent(ctx, PIB_PLUGINS.crm, { companyId: A, payload: crmStatus([item("settings", "missing")], "2026-09-26T13:00:00.000Z") } as never);
    expect(issues.size).toBe(1);

    expect(await weeklyFinishSetup(ctx)).toEqual({ created: 1 });
    expect(issues.size).toBe(2);
    expect(await weeklyFinishSetup(ctx)).toEqual({ unchanged: 1 });
    expect(issues.size).toBe(2);
  });

  it("skips companies without a module choice or saved Setup settings, and honours weeklyIssue: false", async () => {
    const env = fakeCtx({ savedConfigs: { [B]: { weeklyIssue: false } } });
    await saveModules(env.ctx, { companyId: A, modules: ONLY_CRM, userId: "u" });
    env.issues.clear();
    await env.ctx.db.execute(`DELETE FROM ${NAMESPACE}.finish_issues WHERE company_id = $1`, [A]);
    expect(await weeklyFinishSetup(env.ctx)).toEqual({ skipped: 1 });
    expect(await refreshFinishIssue(env.ctx, "nobody", { allowCreate: true })).toEqual({ action: "skipped", reason: "no module choice saved" });
    await saveModules(env.ctx, { companyId: B, modules: ONLY_CRM, userId: "u" });
    expect(env.issues.size).toBe(0);
  });
});
