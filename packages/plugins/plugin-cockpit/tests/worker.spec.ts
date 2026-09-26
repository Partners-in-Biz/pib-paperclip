import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { COCKPIT_EVENTS, COCKPIT_PLUGIN, COCKPIT_ROUTE, hireTaskDraft, PIB_PLUGINS, SETUP_STATUS_ROUTE, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { companyBrief, postDailyBrief, runTool, weekKey } from "../src/brief.js";
import { JOBS, ROUTINES } from "../src/constants.js";
import { createEnv, handleApiRoute, onSetupStatusEvent, onSnapshotEvent, registerCockpit } from "../src/register.js";
import { healthAlerts, healthIssueContent, refreshHealthIssue } from "../src/health.js";
import { HIRE_ROLES, OPERATOR_ROLE, OPERATOR_SKILL_KEY, REVIEWER_ROLE, REVIEWER_SKILL_KEY } from "../src/hire.js";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { ownSetupStatus } from "../src/own.js";
import { parseTeamInput, reemitRoles, saveTeam } from "../src/roles.js";
import { SKILLS } from "../src/skills.js";
import { COCKPIT_TOOLS, TOOL_NAMES } from "../src/tools.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const A = "company-a";
const B = "company-b";
const SAVED = { [A]: { healthIssue: true } };

const snapshot = (plugin: string, checkedAt: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  plugin,
  title: plugin.split(".")[1]!,
  checkedAt,
  kpis: [],
  health: [],
  waiting: [],
  activity: [],
  quality: [],
  ...extra,
});

const agents: FakeAgent[] = [
  { id: "op", companyId: A, name: "Olive", status: "active", role: "general", budgetMonthlyCents: 3000, spentMonthlyCents: 100 },
  { id: "rev", companyId: A, name: "Rex", status: "paused", role: "general", budgetMonthlyCents: 2000, spentMonthlyCents: 0 },
  { id: "ceo", companyId: A, name: "CEO", status: "active", role: "ceo", budgetMonthlyCents: 0, spentMonthlyCents: 0 },
];

function setup(options: Parameters<typeof fakeCtx>[0] = {}, now = "2026-09-26T10:00:00.000Z") {
  const fake = fakeCtx({ savedConfigs: SAVED, prefixes: { [A]: "PIB" }, agents: agents.map((a) => ({ ...a })), ...options });
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

function apiInput(routeKey: string, companyId = A): PluginApiRequestInput {
  return { routeKey, method: "GET", path: `/${routeKey}`, params: {}, query: { companyId }, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId, headers: {} };
}

const userCtx = (companyId = A, userId = "user-1") => ({ companyId, actor: { type: "user", userId } });

describe("manifest and migration", () => {
  it("uses the kit key, the host namespace and declares what the Cockpit uses", () => {
    expect(PLUGIN_ID).toBe(COCKPIT_PLUGIN);
    expect(NAMESPACE).toBe("plugin_cockpit_b8a99e8b16");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.database).toMatchObject({ namespaceSlug: "cockpit", coreReadTables: ["issues", "heartbeat_runs"] });
    for (const capability of [
      "ui.page.register", "ui.sidebar.register", "ui.dashboardWidget.register", "api.routes.register", "events.emit", "events.subscribe", "jobs.schedule",
      "issues.read", "issues.create", "issues.update", "issues.wakeup", "issue.comments.create", "agents.read", "approvals.read", "routines.managed", "skills.managed",
      "authorization.grants.read", "authorization.grants.write", "plugin.state.read", "plugin.state.write", "companies.read", "agent.tools.register",
      "database.namespace.migrate", "database.namespace.read", "database.namespace.write",
    ]) expect(manifest.capabilities).toContain(capability);
    expect(manifest.ui?.slots?.map((slot) => [slot.type, slot.displayName])).toEqual([["page", "Cockpit"], ["sidebar", "Cockpit"], ["dashboardWidget", "Company today"]]);
    expect(manifest.ui?.slots?.find((s) => s.type === "sidebar")).toMatchObject({ order: 5 });
    expect(manifest.ui?.slots?.find((s) => s.type === "page")).toMatchObject({ routePath: "cockpit" });
    expect(manifest.apiRoutes).toEqual([{ ...COCKPIT_ROUTE }, { ...SETUP_STATUS_ROUTE }]);
    expect(manifest.jobs?.map((j) => [j.jobKey, j.schedule])).toEqual([[JOBS.reemitRoles, "10 * * * *"], [JOBS.healthAlerts, "20 * * * *"]]);
    expect(manifest.routines?.map((r) => [r.routineKey, r.triggers?.[0]?.cronExpression, r.triggers?.[0]?.timezone])).toEqual([
      [ROUTINES.daily, "0 7 * * *", "Africa/Johannesburg"],
      [ROUTINES.weekly, "0 8 * * 1", "Africa/Johannesburg"],
    ]);
    expect(manifest.tools?.map((t) => t.name)).toEqual(["company-brief", "health-issues", "waiting-on-owner", "agent-scorecards", "post-daily-brief"]);
    expect(manifest.skills?.map((s) => s.slug)).toEqual(["pib-operator", "pib-reviewer"]);
  });

  it("passes the host migration guard", () => {
    const sql = readFileSync(new URL("../migrations/001_cockpit.sql", import.meta.url), "utf8");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(4);
    for (const statement of statements) validateMigrationStatement(statement, NAMESPACE);
  });

  it("skills carry unique pib- frontmatter and describe the boundaries", () => {
    for (const skill of SKILLS) expect(skill.markdown).toMatch(new RegExp(`^---\\nname: ${skill.slug}\\nslug: ${skill.slug}\\n`));
    const operator = SKILLS[0]!.markdown!;
    for (const text of ["Daily operations review", "Weekly retro", "Never approve money or legal", "Hand-off", "company-brief", "post-daily-brief", "Escalate"]) expect(operator).toContain(text);
    const reviewer = SKILLS[1]!.markdown!;
    for (const text of ["### Social post", "### Campaign email", "### Invoice or quote email", "### Sequence email", "### SEO pull request", "**PASS**", "**CHANGES NEEDED**", "Never approve"]) expect(reviewer).toContain(text);
  });
});

describe("hire roles", () => {
  it("Operator and Reviewer have the agreed titles, budgets and skills", () => {
    expect(OPERATOR_ROLE).toMatchObject({ pluginKey: COCKPIT_PLUGIN, roleKey: "operator", displayName: "Operator", title: "Chief of staff", budgetMonthlyCents: 3000 });
    expect(REVIEWER_ROLE).toMatchObject({ pluginKey: COCKPIT_PLUGIN, roleKey: "reviewer", displayName: "Reviewer", title: "Quality reviewer", budgetMonthlyCents: 2000 });
    expect(OPERATOR_ROLE.skills).toEqual([expect.objectContaining({ key: OPERATOR_SKILL_KEY, slug: "pib-operator" })]);
    expect(REVIEWER_ROLE.skills).toEqual([expect.objectContaining({ key: REVIEWER_SKILL_KEY, slug: "pib-reviewer" })]);
    expect(OPERATOR_SKILL_KEY).toBe("plugin/partnersinbiz-cockpit/operator");
    const draft = hireTaskDraft(OPERATOR_ROLE);
    expect(draft.title).toBe("Hire: Operator (Cockpit agent)");
    expect(draft.description).toContain("$30.00 per month");
    expect(draft.description).toContain("alerts at 80%");
    expect(OPERATOR_ROLE.capabilities).toContain("daily brief");
    expect(hireTaskDraft(REVIEWER_ROLE).description).toContain("$20.00 per month");
  });

  it("opens a hire task through the action, woken for the chosen agent", async () => {
    const { ctx, env, actions, issues, wakeups } = setup();
    registerCockpit(ctx, env);
    const options = (await actions.get("cockpit.hire-options")!({ role: "operator" }, userCtx())) as { defaultAssigneeAgentId: string; draft: { title: string } };
    expect(options.defaultAssigneeAgentId).toBe("ceo");
    const { hire } = (await actions.get("cockpit.start-hire")!({ role: "operator", assigneeAgentId: "ceo", title: options.draft.title }, userCtx())) as { hire: { issueId: string } };
    expect(issues.get(hire.issueId)).toMatchObject({ assigneeAgentId: "ceo", status: "todo", title: "Hire: Operator (Cockpit agent)" });
    expect(wakeups).toContain(hire.issueId);
    await expect(actions.get("cockpit.start-hire")!({ role: "boss" }, userCtx())).rejects.toThrow(/operator or reviewer/);
    await expect(actions.get("cockpit.start-hire")!({ role: "operator" }, { companyId: A, actor: { type: "agent", agentId: "op" } })).rejects.toThrow(/board user/);
  });
});

describe("snapshot projection", () => {
  it("keeps the newest snapshot per company and plugin; older ones never replace it", async () => {
    const { ctx, env, store, fire } = setup();
    registerCockpit(ctx, env);
    const crm = PIB_PLUGINS.crm;
    await fire(`plugin.${crm}.cockpit.snapshot`, { companyId: A, payload: snapshot(crm, "2026-09-26T09:00:00.000Z", { kpis: [{ key: "k", label: "v1", value: "1", group: "pipeline" }] }) });
    await fire(`plugin.${crm}.cockpit.snapshot`, { companyId: A, payload: snapshot(crm, "2026-09-26T10:00:00.000Z", { kpis: [{ key: "k", label: "v2", value: "2", group: "pipeline" }] }) });
    await fire(`plugin.${crm}.cockpit.snapshot`, { companyId: A, payload: snapshot(crm, "2026-09-26T08:00:00.000Z", { kpis: [{ key: "k", label: "old", value: "0", group: "pipeline" }] }) });
    // A payload cannot claim another plugin; the subscription decides.
    await fire(`plugin.${PIB_PLUGINS.seo}.cockpit.snapshot`, { companyId: B, payload: { data: { ...snapshot("evil.plugin", "2026-09-26T09:00:00.000Z"), health: [] } } });
    const rows = store.snapshots!.filter((row) => row.kind === "cockpit");
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.company_id === A)!;
    expect(a.payload.kpis[0].label).toBe("v2");
    expect(a.checked_at).toBe("2026-09-26T10:00:00.000Z");
    expect(rows.find((row) => row.company_id === B)!.payload.plugin).toBe(PIB_PLUGINS.seo);
    expect(await onSnapshotEvent(env, crm, { companyId: A, payload: { nope: true } })).toBe(false);
    expect(await onSnapshotEvent(env, crm, { companyId: "", payload: snapshot(crm, "2026-09-26T09:00:00.000Z") })).toBe(false);
  });

  it("also keeps setup statuses, and does not subscribe to itself", async () => {
    const { ctx, env, store, handlers } = setup();
    registerCockpit(ctx, env);
    expect(handlers.has(`plugin.${COCKPIT_PLUGIN}.cockpit.snapshot`)).toBe(false);
    expect(handlers.has(`plugin.${PIB_PLUGINS.payroll}.cockpit.snapshot`)).toBe(true);
    expect(await onSetupStatusEvent(env, PIB_PLUGINS.crm, { companyId: A, payload: { plugin: "x", items: [{ key: "gmail", title: "Gmail", status: "missing", required: true }], checkedAt: "2026-09-26T09:00:00.000Z" } })).toBe(true);
    expect(store.snapshots!.find((row) => row.kind === "setup")).toMatchObject({ plugin_key: PIB_PLUGINS.crm, payload: { plugin: PIB_PLUGINS.crm } });
  });
});

describe("team roles", () => {
  it("validates input", () => {
    expect(parseTeamInput({ operatorAgentId: "op", reviewerAgentId: "", reviewOutward: true })).toEqual({ operatorAgentId: "op", reviewerAgentId: null, reviewOutward: true });
    expect(() => parseTeamInput({ operatorAgentId: "x", reviewerAgentId: "x" })).toThrow(/different/);
    expect(() => parseTeamInput({ reviewOutward: "yes" })).toThrow(/true or false/);
  });

  it("saves the team, wires the agents, defaults the owner and emits roles.updated", async () => {
    const { env, emitted, grants, routines, skillCalls, store } = setup();
    const result = await saveTeam(env, A, { operatorAgentId: "op", reviewerAgentId: "rev", reviewOutward: true }, "user-1");
    expect(result.firstSave).toBe(true);
    expect(result.roles).toEqual({ companyId: A, operatorAgentId: "op", reviewerAgentId: "rev", ownerUserId: "user-1", reviewOutward: true, updatedAt: "2026-09-26T10:00:00.000Z" });
    expect(store.roles).toHaveLength(1);
    const events = emitted.filter((e) => e.name === COCKPIT_EVENTS.rolesUpdated);
    expect(events.at(-1)).toEqual({ name: "roles.updated", companyId: A, payload: result.roles });
    // Wiring: tool grant for both, routines for the Operator, skills synced.
    expect(grants.get("op")).toEqual([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
    expect(grants.get("rev")).toEqual([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
    expect([...routines.values()].map((r) => [r.key, r.assigneeAgentId])).toEqual([[ROUTINES.daily, "op"], [ROUTINES.weekly, "op"]]);
    expect(skillCalls).toEqual(expect.arrayContaining(["reset:operator", "reset:reviewer"]));
    expect(result.steps.join("\n")).toContain('Assigned the "Daily operations review" routine to Olive.');
    expect(result.steps.join("\n")).toContain("Open Agents → Rex, check its adapter");
  });

  it("moves the routines to a new Operator and keeps their status", async () => {
    const { env, routines, agents: list } = setup();
    list.push({ id: "op2", companyId: A, name: "Otto", status: "active" });
    await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
    routines.get(`${A}:${ROUTINES.weekly}`)!.status = "paused";
    const result = await saveTeam(env, A, { operatorAgentId: "op2" }, "user-1");
    expect(routines.get(`${A}:${ROUTINES.daily}`)).toMatchObject({ assigneeAgentId: "op2", status: "active" });
    expect(routines.get(`${A}:${ROUTINES.weekly}`)).toMatchObject({ assigneeAgentId: "op2", status: "paused" });
    expect(result.steps.join("\n")).toContain("moved over from the previous Operator");
    expect(result.firstSave).toBe(false);
  });

  it("refuses unknown agents", async () => {
    const { env } = setup();
    await expect(saveTeam(env, A, { operatorAgentId: "ghost" }, "user-1")).rejects.toThrow(/not found/);
  });

  it("re-sends saved roles hourly, only for companies with saved Cockpit settings", async () => {
    const { env, emitted } = setup();
    await saveTeam(env, A, { reviewOutward: false }, "user-1");
    await saveTeam(env, B, {}, "user-2");
    emitted.length = 0;
    const result = await reemitRoles(env);
    expect(result).toEqual({ emitted: 1, skipped: 1, failed: 0 });
    expect(emitted).toEqual([{ name: "roles.updated", companyId: A, payload: expect.objectContaining({ companyId: A, ownerUserId: "user-1" }) }]);
  });

  it("the save action is for board users and refreshes the health issue", async () => {
    const { ctx, env, actions } = setup();
    registerCockpit(ctx, env);
    await expect(actions.get("cockpit.save-team")!({}, { companyId: A, actor: { type: "agent", agentId: "op" } })).rejects.toThrow(/board user/);
    const result = (await actions.get("cockpit.save-team")!({ operatorAgentId: "op" }, userCtx())) as { roles: { operatorAgentId: string }; health: string };
    expect(result.roles.operatorAgentId).toBe("op");
    expect(result.health).toBe("none");
  });

  it("links a hire's agent automatically when it appears", async () => {
    const { ctx, env, actions, agents: list, emitted, fire } = setup();
    registerCockpit(ctx, env);
    await saveTeam(env, A, {}, "user-1");
    await actions.get("cockpit.start-hire")!({ role: "reviewer", assigneeAgentId: "ceo" }, userCtx());
    list.push({ id: "new-rev", companyId: A, name: "Reviewer", status: "paused", createdAt: new Date().toISOString() });
    await fire("agent.created", { companyId: A });
    const last = emitted.filter((e) => e.name === "roles.updated").at(-1)!;
    expect(last.payload).toMatchObject({ reviewerAgentId: "new-rev" });
  });
});

describe("System health issue", () => {
  async function withRoles(env: ReturnType<typeof setup>["env"], input: Parameters<typeof saveTeam>[2] = {}) {
    await saveTeam(env, A, input, "user-1");
  }

  it("lists problems with fixes and links (pure)", () => {
    const content = healthIssueContent([
      { key: "outbox", title: "Deliveries", status: "bad", detail: "2 failed", fix: "Retry them", href: "/billing", plugin: "partnersinbiz.billing", pluginTitle: "Billing" },
    ], "PIB");
    expect(content?.title).toBe("System health: 1 problem");
    expect(content?.description).toContain("## Billing");
    expect(content?.description).toContain("[Open](/PIB/billing)");
    expect(content?.description).toContain("Fix: Retry them");
    expect(healthIssueContent([], null)).toBeNull();
  });

  it("opens one issue for the owner, updates it as problems change, and closes it when all is ok", async () => {
    const { env, store, issues, comments } = setup();
    await withRoles(env);
    store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.billing, kind: "cockpit", payload: snapshot(PIB_PLUGINS.billing, "2026-09-26T09:30:00.000Z", { health: [{ key: "outbox", title: "Deliveries", status: "bad", fix: "Retry" }, { key: "w", title: "Warn only", status: "warn" }] }), checked_at: "2026-09-26T09:30:00.000Z", received_at: "2026-09-26T09:30:00.000Z" }];
    const created = await refreshHealthIssue(env, A);
    expect(created).toMatchObject({ action: "created", problems: 1 });
    const id = (created as { issueId: string }).issueId;
    expect(issues.get(id)).toMatchObject({ assigneeUserId: "user-1", status: "todo", title: "System health: 1 problem", priority: "high" });
    expect(issues.get(id)!.description).not.toContain("Warn only");
    expect(await refreshHealthIssue(env, A)).toMatchObject({ action: "unchanged" });

    // A second problem: same issue, updated.
    store.snapshots[0]!.payload.health.push({ key: "job:publish", title: "Publishing", status: "bad" });
    expect(await refreshHealthIssue(env, A)).toMatchObject({ action: "updated", issueId: id, problems: 2 });
    expect(issues.get(id)!.title).toBe("System health: 2 problems");
    expect(issues.size).toBe(1);

    // All ok: closed with a comment.
    store.snapshots[0]!.payload.health = [];
    expect(await refreshHealthIssue(env, A)).toMatchObject({ action: "closed", issueId: id });
    expect(issues.get(id)!.status).toBe("done");
    expect(comments.at(-1)!.body).toContain("Everything is ok again");
    expect(store.health_issues).toHaveLength(0);
  });

  it("assigns to the Operator when linked (and wakes it on new problems), and flags budgets and errors", async () => {
    const { env, issues, wakeups, agents: list } = setup();
    await withRoles(env, { operatorAgentId: "op" });
    list.find((a) => a.id === "rev")!.spentMonthlyCents = 1700; // 85% of $20
    const created = await refreshHealthIssue(env, A);
    const id = (created as { issueId: string }).issueId;
    expect(issues.get(id)).toMatchObject({ assigneeAgentId: "op" });
    expect(issues.get(id)!.description).toContain("Rex is near its budget");
    expect(wakeups).toContain(id);
    wakeups.length = 0;
    list.find((a) => a.id === "ceo")!.status = "error";
    expect(await refreshHealthIssue(env, A)).toMatchObject({ action: "updated", problems: 2 });
    expect(issues.get(id)!.description).toContain("CEO is in error");
    expect(wakeups).toContain(id);
  });

  it("warns about plugins that stopped reporting", async () => {
    const { env, store, issues, clock } = setup();
    await withRoles(env);
    await env.ctx.state.set({ scopeKind: "instance", namespace: "cockpit", stateKey: "installed-plugins" }, { [PIB_PLUGINS.crm]: { id: "c", status: "ready" }, [PIB_PLUGINS.seo]: { id: "s", status: "ready" } });
    store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.crm, kind: "cockpit", payload: snapshot(PIB_PLUGINS.crm, "2026-09-26T09:30:00.000Z"), checked_at: "2026-09-26T09:30:00.000Z", received_at: "2026-09-26T09:30:00.000Z" }];
    // The Cockpit started listening at 10:00; SEO never reported. Not stale yet.
    expect(await refreshHealthIssue(env, A)).toMatchObject({ action: "none" });
    clock.set("2026-09-26T14:00:00.000Z");
    const result = await refreshHealthIssue(env, A);
    expect(result).toMatchObject({ action: "created", problems: 2 });
    const text = issues.get((result as { issueId: string }).issueId)!.description;
    expect(text).toContain("CRM plugin not reporting");
    expect(text).toContain("SEO plugin not reporting");
  });

  it("the hourly job skips companies without saved settings or roles", async () => {
    const { env, store } = setup();
    await saveTeam(env, A, {}, "user-1");
    await saveTeam(env, B, {}, "user-2");
    store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.billing, kind: "cockpit", payload: snapshot(PIB_PLUGINS.billing, "2026-09-26T09:30:00.000Z", { health: [{ key: "x", title: "X", status: "bad" }] }), checked_at: "2026-09-26T09:30:00.000Z", received_at: "2026-09-26T09:30:00.000Z" }];
    expect(await healthAlerts(env)).toEqual({ created: 1, skipped: 1 });
  });

  it("honours healthIssue: false", async () => {
    const { env } = setup({ savedConfigs: { [A]: { healthIssue: false } } });
    await saveTeam(env, A, {}, "user-1");
    expect(await refreshHealthIssue(env, A)).toEqual({ action: "skipped", reason: "health issue switched off" });
  });
});

describe("Operator tools", () => {
  function seeded() {
    const s = setup({
      approvals: [{ id: "ap1", companyId: A, type: "budget_override_required", status: "pending", payload: { agentName: "SEO" }, createdAt: "2026-09-25T10:00:00.000Z" }],
      coreIssues: [{ id: "i1", company_id: A, assignee_user_id: "user-1", status: "in_review", title: "Approve post", identifier: "PIB-7", updated_at: "2026-09-26T08:00:00.000Z" }],
      runs: [{ company_id: A, agent_id: "op", status: "succeeded", started_at: "2026-09-26T07:00:00.000Z" }, { company_id: A, agent_id: "op", status: "failed", started_at: "2026-09-25T07:00:00.000Z", error: "boom" }],
    });
    s.store.snapshots = [{
      company_id: A,
      plugin_key: PIB_PLUGINS.billing,
      kind: "cockpit",
      payload: snapshot(PIB_PLUGINS.billing, "2026-09-26T09:30:00.000Z", {
        kpis: [{ key: "overdue", label: "Overdue", value: "R 4,000", raw: 400000, tone: "bad", group: "money", href: "/billing?tab=invoices" }],
        health: [{ key: "outbox", title: "Deliveries", status: "bad", fix: "Retry", href: "/billing" }],
        waiting: [{ key: "approval:inv", title: "Send INV-12", why: "Money goes out", kind: "money", issueId: "i-inv" }],
        activity: [{ at: "2026-09-26T08:00:00.000Z", text: "Sent 2 reminders", agentId: "op" }],
        quality: [{ key: "rejected", label: "Rejected", value: "0%", agentId: "op" }],
      }),
      checked_at: "2026-09-26T09:30:00.000Z",
      received_at: "2026-09-26T09:30:00.000Z",
    }];
    return s;
  }

  it("company-brief returns compact JSON with waiting, health, KPIs, activity and agents incl. spend/budget", async () => {
    const { env } = seeded();
    await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
    const brief = await companyBrief(env, A);
    expect(brief.company).toEqual({ id: A, name: `Company ${A}`, prefix: "PIB" });
    expect(brief.waiting.map((w) => [w.title, w.kind, w.href])).toEqual([
      ["Budget override needed: SEO", "money", "/PIB/approvals/ap1"],
      ["Send INV-12", "money", null],
      ["PIB-7 Approve post", "review", "/PIB/issues/PIB-7"],
    ]);
    expect(brief.health.status).toBe("bad");
    expect(brief.health.problems[0]).toMatchObject({ plugin: "billing", status: "bad", title: "Deliveries", fix: "Retry", href: "/PIB/billing" });
    expect(brief.kpis).toEqual({ money: [{ label: "Overdue", value: "R 4,000", tone: "bad", delta: null, href: "/PIB/billing?tab=invoices", from: "billing" }] });
    expect(brief.activity[0]).toMatchObject({ agent: "Olive", runs: { total: 1, failed: 0 }, done: [{ text: "Sent 2 reminders" }] });
    const olive = brief.agents.find((a) => a.id === "op")!;
    expect(olive).toMatchObject({ spentCents: 100, budgetCents: 3000, budgetUsedPct: 3, runs7d: { total: 2, failed: 1 }, quality: [{ label: "Rejected", value: "0%", tone: "neutral" }] });
    expect(brief.today).toMatch(/^3 things wait on you · 1 problem to fix/);
    expect(brief.links).toEqual({ cockpit: "/PIB/cockpit", setup: "/PIB/setup" });
  });

  it("every tool returns an object and fails softly", async () => {
    const { ctx, env, tools } = seeded();
    registerCockpit(ctx, env);
    await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
    const run = { agentId: "op", runId: "r1", companyId: A, projectId: "p1" };
    for (const tool of COCKPIT_TOOLS.filter((t) => t.name !== TOOL_NAMES.postBrief)) {
      const result = (await tools.get(tool.name)!({}, run)) as { content: string; data: Record<string, unknown>; error?: string };
      expect(result.error).toBeUndefined();
      expect(typeof result.data).toBe("object");
      expect(Array.isArray(result.data)).toBe(false);
    }
    const waiting = (await tools.get(TOOL_NAMES.waiting)!({}, run)) as { data: { count: number } };
    expect(waiting.data.count).toBe(3);
    const health = (await tools.get(TOOL_NAMES.health)!({ includeWarnings: false }, run)) as { data: { problems: unknown[] } };
    expect(health.data.problems).toHaveLength(1);
    const cards = (await tools.get(TOOL_NAMES.scorecards)!({}, run)) as { data: { items: Array<{ name: string }> } };
    expect(cards.data.items.map((i) => i.name)).toEqual(["CEO", "Olive", "Rex"]);
    const failed = (await runTool(env, TOOL_NAMES.postBrief, { body: "" }, run)) as { error?: string; data: Record<string, unknown> };
    expect(failed.error).toMatch(/empty/);
    expect(failed.data).toEqual({ ok: false, error: "The brief is empty." });
  });

  it("post-daily-brief posts on one pinned issue per week, assigned to the owner, and closes last week's", async () => {
    const { env, issues, comments, clock } = setup();
    await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
    const first = await postDailyBrief(env, A, "**Daily brief** one", "op");
    const second = await postDailyBrief(env, A, "**Daily brief** two", "op");
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, issueId: first.issueId });
    expect(issues.get(first.issueId)).toMatchObject({ assigneeUserId: "user-1", title: "Daily brief: week of 2026-09-21", status: "todo" });
    expect(comments.filter((c) => c.issueId === first.issueId).map((c) => c.authorAgentId)).toEqual(["op", "op"]);
    clock.set("2026-10-03T06:00:00.000Z");
    const next = await postDailyBrief(env, A, "next week", "op");
    expect(next.created).toBe(true);
    expect(issues.get(first.issueId)!.status).toBe("done");
    expect(weekKey(new Date("2026-09-26T10:00:00.000Z"))).toBe("2026-W39");
    // Sunday 23:30 UTC is Monday in SAST.
    expect(weekKey(new Date("2026-09-27T23:30:00.000Z"))).toBe("2026-W40");
  });
});

describe("own routes", () => {
  it("serves its own snapshot and setup checklist", async () => {
    const { env } = setup();
    const snap = await handleApiRoute(env, apiInput("cockpit"));
    expect(snap.status).toBe(200);
    expect((snap.body as CockpitSnapshot).plugin).toBe(COCKPIT_PLUGIN);
    expect((snap.body as CockpitSnapshot).health.find((h) => h.key === "operator")?.status).toBe("warn");
    const before = await ownSetupStatus(env, A);
    expect(before.items.map((i) => [i.key, i.status])).toEqual([["settings", "done"], ["owner", "missing"], ["operator_agent", "missing"], ["reviewer_agent", "optional"], ["routines", "blocked"]]);
    await saveTeam(env, A, { operatorAgentId: "op", reviewerAgentId: "rev" }, "user-1");
    const after = await ownSetupStatus(env, A);
    expect(after.items.map((i) => [i.key, i.status])).toEqual([["settings", "done"], ["owner", "done"], ["operator_agent", "done"], ["reviewer_agent", "done"], ["routines", "done"]]);
    expect((await handleApiRoute(env, apiInput("setup-status"))).status).toBe(200);
    expect((await handleApiRoute(env, apiInput("nope"))).status).toBe(404);
  });

  it("the load action returns the projection, roles and team", async () => {
    const { ctx, env, actions, store } = setup();
    registerCockpit(ctx, env);
    await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
    store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.crm, kind: "cockpit", payload: snapshot(PIB_PLUGINS.crm, "2026-09-26T09:30:00.000Z"), checked_at: "2026-09-26T09:30:00.000Z", received_at: "2026-09-26T09:31:00.000Z" }];
    const load = (await actions.get("cockpit.load")!({ installed: { [PIB_PLUGINS.crm]: { id: "c", status: "ready" } } }, userCtx())) as Record<string, any>;
    expect(load.roles.operatorAgentId).toBe("op");
    expect(load.settingsSaved).toBe(true);
    expect(Object.keys(load.snapshots)).toEqual([PIB_PLUGINS.crm]);
    expect(load.team.operator.agent.id).toBe("op");
    expect(load.installed).toEqual({ [PIB_PLUGINS.crm]: { id: "c", status: "ready" } });
    expect(HIRE_ROLES.operator).toBe(OPERATOR_ROLE);
  });
});
