import { describe, expect, it } from "vitest";
import { RUN_PROFILES, TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit";
import { allModulesOn } from "../src/modules.js";
import { PLUGIN_ID } from "../src/namespace.js";
import { recordStep, sanitizeOptions, starterPackHash, toAgentLikes } from "../src/new-company.js";
import { handleApiRoute, registerSetup } from "../src/register.js";
import { fixedClock, fakeCtx } from "./helpers/fake-ctx.js";
import { loadStarterPack } from "../src/starter-pack.js";
import { loadPack } from "../src/templates.js";
import { PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { rememberInstalled, reportStatuses } from "../src/service.js";

const A = "co-aaaaaaaa";
const B = "co-bbbbbbbb";
const COMPANIES = { [A]: { name: "Acme Ltd", issuePrefix: "ACM", defaultResponsibleUserId: "owner-1", requireBoardApprovalForNewAgents: true }, [B]: { name: "Beta Inc", issuePrefix: "BET" } };
const asUser = (companyId: string, userId = "user-1") => ({ companyId, actor: { type: "user", userId, agentId: null } });
const asAgent = (companyId: string) => ({ companyId, actor: { type: "agent", userId: null, agentId: "ag-1" } });

function setup() {
  const fake = fakeCtx({ companies: COMPANIES });
  registerSetup(fake.ctx);
  const call = (key: string, params: Record<string, unknown>, context: unknown) => fake.actions.get(key)!(params, context) as Promise<any>;
  return { ...fake, call };
}

describe("a company is created", () => {
  it("opens the owner's one Set up issue, remembers the company, and does nothing twice", async () => {
    const { fire, issues, store, wakes } = setup();
    await fire("company.created", { companyId: A });
    await fire("company.created", { companyId: A });
    const opened = [...issues.values()];
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ companyId: A, title: "Set up Acme Ltd", originKind: `plugin:${PLUGIN_ID}`, originId: "company-setup", assigneeUserId: "owner-1" });
    expect(opened[0]!.description).toMatch(/Staff the team/);
    expect(wakes).toEqual([]);
    expect(store.bootstrap_runs).toEqual([expect.objectContaining({ company_id: A, source: "company.created" })]);
    expect(store.bootstrap_runs).toHaveLength(1);
  });

  it("catches a company that missed company.created on a lazy event, without opening an issue", async () => {
    const { fire, issues, store } = setup();
    await fire("company.updated", { companyId: B });
    expect(issues.size).toBe(0);
    expect(store.bootstrap_runs).toEqual([expect.objectContaining({ company_id: B, source: "lazy" })]);
  });
});

describe("setup.bootstrap-company", () => {
  it("saves every module on, adopts the owner's issue as the Finish setup issue (one issue, not two) and records both steps", async () => {
    const { fire, call, issues, emitted, store } = setup();
    await fire("company.created", { companyId: A });
    const result = await call("setup.bootstrap-company", {}, asUser(A));
    expect(issues.size).toBe(1);
    const issue = [...issues.values()][0]!;
    expect(issue.title).toMatch(/^Finish setup: \d+ steps? left$/);
    expect(issue.originId).toBe("company-setup");
    expect(store.finish_issues).toEqual([expect.objectContaining({ company_id: A, issue_id: issue.id })]);
    expect(emitted.filter((entry) => entry.name === "modules.updated")).toHaveLength(1);
    const steps = Object.fromEntries(result.steps.map((step: any) => [step.id, step]));
    expect(steps.modules).toMatchObject({ status: "done", detail: "Saved: every module is on." });
    expect(steps["finish-issue"]).toMatchObject({ status: "done", detail: "The Finish setup issue is open and up to date." });
    expect(steps["plugin-settings"]).toMatchObject({ status: "pending" });
    expect(result.run).toMatchObject({ companyId: A, status: "running", startedBy: "user-1" });
    expect(result.modules).toEqual(allModulesOn());
    expect(result.company).toMatchObject({ name: "Acme Ltd", prefix: "ACM", requireApproval: true });
  });

  it("is idempotent: a repeat opens no second issue and re-saves nothing it was not asked to", async () => {
    const { call, issues, emitted } = setup();
    await call("setup.bootstrap-company", {}, asUser(A));
    const first = [...issues.keys()];
    await call("setup.bootstrap-company", {}, asUser(A));
    await call("setup.bootstrap-company", {}, asUser(A));
    expect([...issues.keys()]).toEqual(first);
    // The module choice was saved once; later calls only refresh the issue.
    expect(emitted.filter((entry) => entry.name === "modules.updated")).toHaveLength(1);
  });

  it("saves the switches it is given and remembers the options", async () => {
    const { call, store } = setup();
    const result = await call("setup.bootstrap-company", { options: { modules: { payroll: false, partners: false }, includeOptionalRoles: true, templates: ["developer", "planner", "nope"], copyFromCompanyId: "11111111-2222-3333-4444-555555555555", hiringAgentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", starterPack: true } }, asUser(A));
    expect(result.modules).toMatchObject({ payroll: false, partners: false, crm: true });
    expect(result.steps.find((step: any) => step.id === "modules").detail).toBe("Saved. Switched off: payroll, partners.");
    expect(result.run.options).toEqual({ modules: { payroll: false, partners: false }, includeOptionalRoles: true, templates: ["developer", "planner"], copyFromCompanyId: "11111111-2222-3333-4444-555555555555", hiringAgentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", starterPack: true });
    expect(store.bootstrap_runs![0]!.options).toMatchObject({ includeOptionalRoles: true });
  });

  it("keeps an existing module choice when no switches are passed", async () => {
    const { call, emitted } = setup();
    await call("setup.bootstrap-company", { options: { modules: { seo: false } } }, asUser(A));
    const again = await call("setup.bootstrap-company", {}, asUser(A));
    expect(again.modules).toMatchObject({ seo: false });
    expect(again.steps.find((step: any) => step.id === "modules").detail).toBe("The module choice was already saved.");
    expect(emitted.filter((entry) => entry.name === "modules.updated")).toHaveLength(1);
  });

  it("is for a board user only", async () => {
    const { call, store } = setup();
    await expect(call("setup.bootstrap-company", {}, asAgent(A))).rejects.toThrow(/board user/);
    await expect(call("setup.bootstrap-company", {}, { companyId: A, actor: { type: "user", userId: null } })).rejects.toThrow(/board user/);
    await expect(call("setup.bootstrap-company", {}, { actor: { type: "user", userId: "u" } })).rejects.toThrow(/Company is required/);
    expect(store.module_choices ?? []).toHaveLength(0);
  });

  it("never touches another company", async () => {
    const { call, store } = setup();
    await call("setup.bootstrap-company", { options: { modules: { seo: false } } }, asUser(A));
    expect(store.module_choices!.map((row) => row.company_id)).toEqual([A]);
    const other = await call("setup.new-company", {}, asUser(B));
    expect(other.run).toBeNull();
    expect(other.steps.every((step: any) => step.status === "pending")).toBe(true);
  });
});

describe("setup.bootstrap-record", () => {
  it("stores a page step with clean items, and refuses what is not a page step, a status or a user", async () => {
    const { call } = setup();
    await call("setup.bootstrap-company", {}, asUser(A));
    const result = await call("setup.bootstrap-record", { stepId: "skills", status: "done", detail: "  Skills are   in.  ", items: [{ key: "crm", label: "CRM", status: "done" }, { key: "x", label: "X", status: "weird" }] }, asUser(A));
    const skills = result.steps.find((step: any) => step.id === "skills");
    expect(skills).toMatchObject({ status: "done", detail: "Skills are in.", items: [{ key: "crm", label: "CRM", status: "done" }] });
    await expect(call("setup.bootstrap-record", { stepId: "modules", status: "done" }, asUser(A))).rejects.toThrow(/run by Setup itself/);
    await expect(call("setup.bootstrap-record", { stepId: "finish-issue", status: "done" }, asUser(A))).rejects.toThrow(/run by Setup itself/);
    await expect(call("setup.bootstrap-record", { stepId: "nope", status: "done" }, asUser(A))).rejects.toThrow(/Unknown bootstrap step/);
    await expect(call("setup.bootstrap-record", { stepId: "skills", status: "fine" }, asUser(A))).rejects.toThrow(/Unknown step status/);
    await expect(call("setup.bootstrap-record", { stepId: "skills", status: "done" }, asAgent(A))).rejects.toThrow(/board user/);
  });

  it("works the run status out as steps report: running, partial, complete", async () => {
    const { call } = setup();
    await call("setup.bootstrap-company", {}, asUser(A));
    const report = (stepId: string, status: string) => call("setup.bootstrap-record", { stepId, status, detail: stepId }, asUser(A));
    expect((await report("setup-settings", "done")).run.status).toBe("running");
    await report("plugin-settings", "done");
    await report("skills", "done");
    await report("roles", "done");
    await report("templates", "done");
    await report("company-wiki", "skipped");
    await report("starter-pack", "skipped");
    const open = await report("owner-list", "needs_owner");
    expect(open.run.status).toBe("complete");
    expect(open.run.completedAt).toBeTruthy();
    const failed = await report("skills", "failed");
    expect(failed.run.status).toBe("partial");
    expect(failed.run.completedAt).toBeNull();
    const fixed = await report("skills", "done");
    expect(fixed.run.status).toBe("complete");
  });

  it("puts the one list of grants on the Finish setup issue, and updates it when the list changes", async () => {
    const { call, issues } = setup();
    await call("setup.bootstrap-company", {}, asUser(A));
    const issue = [...issues.values()][0]!;
    expect(issue.description).not.toMatch(/Needs you/);
    const grants = [{ id: "github-token", title: "Create this company's GitHub token", why: "Only the owner can.", steps: ["Open GitHub."], href: "/company/settings/secrets", hrefLabel: "Open Secrets", command: null, after: "Agents push.", decision: false }];
    await call("setup.bootstrap-record", { stepId: "owner-list", status: "needs_owner", grants }, asUser(A));
    expect(issues.get(issue.id)!.description).toContain("## Needs you (one time)");
    expect(issues.get(issue.id)!.description).toContain("**Create this company's GitHub token**");
    expect(issues.get(issue.id)!.description).toContain("[Open Secrets](/ACM/company/settings/secrets)");
    // An empty list takes the section off again.
    await call("setup.bootstrap-record", { stepId: "owner-list", status: "done", grants: [] }, asUser(A));
    expect(issues.get(issue.id)!.description).not.toContain("Needs you");
  });

  it("drops a grant from the issue and the page once the plugin reports that item done (the list is a snapshot, not a promise)", async () => {
    const { call, ctx, issues } = setup();
    await rememberInstalled(ctx, { [PIB_PLUGINS.crm]: { id: "crm-uuid", status: "ready" } });
    await call("setup.bootstrap-company", {}, asUser(A));
    const issue = [...issues.values()][0]!;
    const grant = (id: string, title: string) => ({ id, title, why: "Only a person can.", steps: ["Do it."], href: "/crm", hrefLabel: "Open", command: null, after: "It carries on.", decision: false });
    const grants = [grant(`${PIB_PLUGINS.crm}:import`, "CRM: Import contacts"), grant(`${PIB_PLUGINS.crm}:gmail`, "CRM: Connect Gmail"), grant("github-token", "Create this company's GitHub token")];
    await call("setup.bootstrap-record", { stepId: "owner-list", status: "needs_owner", grants }, asUser(A));
    expect(issues.get(issue.id)!.description).toContain("CRM: Import contacts");
    // CRM now says it imported the contacts; the Gmail item is still open and the token is not something CRM can report.
    const crm = { plugin: PIB_PLUGINS.crm, module: "crm", title: "CRM", checkedAt: "2026-10-03T10:00:00.000Z", items: [{ key: "import", title: "Import", status: "done", required: true }, { key: "gmail", title: "Gmail", status: "missing", required: true }] };
    await reportStatuses(ctx, A, { [PIB_PLUGINS.crm]: crm as never }, fixedClock("2026-10-03T10:01:00.000Z"));
    const text = issues.get(issue.id)!.description!;
    expect(text).not.toContain("CRM: Import contacts");
    expect(text).toContain("CRM: Connect Gmail");
    expect(text).toContain("Create this company's GitHub token");
    const state = await call("setup.new-company", {}, asUser(A));
    expect(state.run.grants.map((entry: { id: string }) => entry.id)).toEqual([`${PIB_PLUGINS.crm}:gmail`, "github-token"]);
  });

  it("records the starter pack import and shows it on the next read", async () => {
    const { call } = setup();
    await call("setup.bootstrap-company", {}, asUser(A));
    await call("setup.bootstrap-record", { stepId: "starter-pack", status: "done", detail: "Added 12", starterImport: { added: 12, duplicates: 0, invalid: [] } }, asUser(A));
    const state = await call("setup.new-company", {}, asUser(A));
    expect(state.starterPack.importedAt).toBeTruthy();
    const other = await call("setup.new-company", {}, asUser(B));
    expect(other.starterPack.importedAt).toBeNull();
  });

  it("clips a long detail and keeps at most 40 items", async () => {
    const { ctx } = setup();
    const result = await recordStep(ctx, { companyId: A, userId: "u", stepId: "roles", status: "failed", detail: "x".repeat(900), items: Array.from({ length: 70 }, (_v, index) => ({ key: `k${index}`, label: "L", status: "done" })) }, fixedClock("2026-10-03T10:00:00.000Z"));
    const roles = result.steps.find((step) => step.id === "roles")!;
    expect(roles.detail!.length).toBe(500);
    expect(roles.items).toHaveLength(40);
    expect(roles.at).toBe("2026-10-03T10:00:00.000Z");
  });
});

describe("setup.new-company", () => {
  it("reads the state of a company that was never touched", async () => {
    const { call } = setup();
    const state = await call("setup.new-company", {}, asUser(A));
    expect(state).toMatchObject({ run: null, status: "created", pack: { name: "pib-standard-team", version: 1, templates: 11 }, hires: [] });
    expect(state.steps).toHaveLength(10);
    expect(state.starterPack).toMatchObject({ approved: false, needsOwnerOk: true, version: 1 });
    expect(state.starterPack.facts.length).toBe(loadStarterPack().facts.length);
    expect(state.starterPack.factCount).toBe(loadStarterPack().facts.length);
  });

  it("gives an agent the run state and the starter pack's counts, never the facts to read", async () => {
    const { call } = setup();
    const state = await call("setup.new-company", {}, asAgent(A));
    expect(state).toMatchObject({ status: "created", starterPack: { approved: false, needsOwnerOk: true, factCount: loadStarterPack().facts.length, facts: [], excluded: [], reviewNotes: [] } });
    expect(JSON.stringify(state.starterPack)).not.toContain(loadStarterPack().facts[0]!.text);
  });
});

describe("template hire tasks", () => {
  const DEV = { agents: [{ id: "ceo-1", name: "PiB", title: "CEO", role: "general", status: "idle", urlKey: "pib" }] };

  it("renders a draft for a template with the company's names, and refuses an unknown key or an agent", async () => {
    const { call } = setup();
    const draft = await call("setup.template-draft", { key: "planner", ...DEV, ceo: { name: "PiB", urlKey: "pib" }, ownerName: "Jo" }, asUser(A));
    expect(draft).toMatchObject({ key: "planner", kitRole: null, provisioning: "hire", title: "Hire: Planner (team template)", adapterType: "claude_local" });
    expect(draft.description).toContain("You are the Planner / Architect of Acme Ltd's development team.");
    expect(draft.description).toContain("Jo");
    expect(draft.description).toContain("[Delivery Lead](/ACM/agents/delivery-lead)");
    expect(draft.payload).toMatchObject({ name: "Planner", adapterConfig: { model: "claude-fable-5-1", timeoutSec: 3600 } });
    await expect(call("setup.template-draft", { key: "nope" }, asUser(A))).rejects.toThrow(/Unknown template/);
    await expect(call("setup.template-draft", { key: "planner" }, asAgent(A))).rejects.toThrow(/board user/);
  });

  it("opens one hire task for the CEO agent, wakes it, and returns it instead of a second one", async () => {
    const { call, issues, wakes, store } = setup();
    const first = await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444", ownerName: "Jo" }, asUser(A));
    expect(first).toMatchObject({ existed: false, woke: true, identifier: expect.stringMatching(/^ACM-/) });
    expect(first.hire).toMatchObject({ companyId: A, templateKey: "developer", status: "open", packVersion: 1, assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" });
    const issue = issues.get(first.hire.issueId)!;
    expect(issue).toMatchObject({ companyId: A, title: "Hire: Developer (team template)", originKind: `plugin:${PLUGIN_ID}`, originId: "template-hire:developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444", status: "todo" });
    expect(issue.description).toContain("POST /api/companies/{companyId}/agent-hires");
    expect(wakes).toEqual([{ issueId: issue.id, companyId: A, reason: "Hire request for the Developer (team template pack)" }]);
    expect(store.template_hires).toHaveLength(1);

    const again = await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" }, asUser(A));
    expect(again).toMatchObject({ existed: true });
    expect(again.hire.issueId).toBe(first.hire.issueId);
    expect(issues.size).toBe(1);
    expect(store.template_hires).toHaveLength(1);
  });

  it("opens a new task when the old one was closed without the agent appearing", async () => {
    const { call, issues } = setup();
    const first = await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" }, asUser(A));
    issues.get(first.hire.issueId)!.status = "cancelled";
    const second = await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" }, asUser(A));
    expect(second.existed).toBe(false);
    expect(second.hire.issueId).not.toBe(first.hire.issueId);
  });

  it("opens none when an agent already is the template", async () => {
    const { call, issues } = setup();
    const result = await call("setup.start-template-hire", { key: "planner", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444", agents: [{ id: "p-1", name: "Planner", title: "Planner / Architect", status: "idle" }] }, asUser(A));
    expect(result).toMatchObject({ hire: null, staffed: { id: "p-1", name: "Planner" } });
    expect(issues.size).toBe(0);
  });

  it("assigns the CEO's task to a person when the company has no CEO, and refuses a task nobody is assigned", async () => {
    const { call, issues, wakes } = setup();
    const result = await call("setup.start-template-hire", { key: "ceo", assigneeUserId: "user-1" }, asUser(A));
    expect(issues.get(result.hire.issueId)).toMatchObject({ assigneeUserId: "user-1", status: "todo" });
    expect(wakes).toEqual([]);
    await expect(call("setup.start-template-hire", { key: "planner" }, asUser(A))).rejects.toThrow(/Pick who does the hire/);
    await expect(call("setup.start-template-hire", { key: "planner", assigneeAgentId: "not a uuid" }, asUser(A))).rejects.toThrow(/Pick who does the hire/);
  });

  it("sends a template that holds a kit role to that role's plugin, and says why", async () => {
    const { call, issues } = setup();
    await expect(call("setup.start-template-hire", { key: "growth-marketing-lead", assigneeUserId: "user-1" }, asUser(A))).rejects.toThrow(/holds the Social agent role: hire it from Setup -> Team/);
    expect(issues.size).toBe(0);
    const draft = await call("setup.template-draft", { key: "growth-marketing-lead" }, asUser(A));
    expect(draft.kitRole).toBe("social");
    expect(draft.payload.desiredSkills).toContain("plugin/partnersinbiz-social/social-publish");
  });

  it("still creates the task when the wake-up is refused (the capability is missing), and says it did not wake", async () => {
    const fake = fakeCtx({ companies: COMPANIES, wakeFails: true });
    registerSetup(fake.ctx);
    const result = (await fake.actions.get("setup.start-template-hire")!({ key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" }, asUser(A))) as any;
    expect(result.woke).toBe(false);
    expect(fake.issues.size).toBe(1);
  });

  it("keeps the tasks of two companies apart", async () => {
    const { call, store } = setup();
    await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "aaaaaaaa-1111-2222-3333-444444444444" }, asUser(A));
    await call("setup.start-template-hire", { key: "developer", assigneeAgentId: "bbbbbbbb-1111-2222-3333-444444444444" }, asUser(B));
    expect(store.template_hires!.map((row) => row.company_id).sort()).toEqual([A, B]);
    expect((await call("setup.new-company", {}, asUser(A))).hires).toHaveLength(1);
  });
});

describe("the starter pack approval", () => {
  it("is refused for a hash the owner did not see, and by an agent", async () => {
    const { call } = setup();
    await expect(call("setup.approve-starter-pack", { hash: "stale" }, asUser(A))).rejects.toThrow(/changed since you opened it/);
    await expect(call("setup.approve-starter-pack", { hash: starterPackHash(loadStarterPack()) }, asAgent(A))).rejects.toThrow(/board user/);
  });

  it("hands out the import only after the owner approved this exact version", async () => {
    const { call } = setup();
    await expect(call("setup.starter-pack-import", {}, asUser(A))).rejects.toThrow(/needs the owner's OK first/);
    const hash = starterPackHash(loadStarterPack());
    const approved = await call("setup.approve-starter-pack", { hash }, asUser(A, "owner-1"));
    expect(approved).toMatchObject({ approved: true, approvedBy: "owner-1", hash });
    const body = await call("setup.starter-pack-import", {}, asUser(A));
    expect(body).toMatchObject({ version: 1, hash, data: { format: "pib-company-memory", version: 1, companyId: "pib-starter-pack" } });
    expect(body.data.facts).toHaveLength(loadStarterPack().facts.length);
    // Approval is of the pack, not of a company: the next company may use it too, and a changed pack would not be covered.
    expect((await call("setup.new-company", {}, asUser(B))).starterPack.approved).toBe(true);
  });

  it("hashes the facts, not the reviewer's notes", () => {
    const pack = loadStarterPack();
    const base = starterPackHash(pack);
    expect(starterPackHash({ ...pack, reviewNotes: ["changed"], builtFrom: "other" })).toBe(base);
    expect(starterPackHash({ ...pack, facts: pack.facts.map((fact, index) => (index === 0 ? { ...fact, text: `${fact.text} (edited)` } : fact)) })).not.toBe(base);
    expect(starterPackHash({ ...pack, facts: pack.facts.map((fact, index) => (index === 0 ? { ...fact, pinned: !fact.pinned } : fact)) })).not.toBe(base);
    expect(starterPackHash({ ...pack, version: 2 })).not.toBe(base);
  });
});

describe("GET /templates for the ops scripts", () => {
  const route = (companyId: string) => ({ routeKey: "templates", method: "GET", path: "/templates", params: {}, query: { companyId }, body: null, actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId, headers: {} }) as never;

  it("hands over every kit role's run profile and every template rendered for the company, so the script keeps no copy", async () => {
    const { ctx } = setup();
    const response = await handleApiRoute(ctx, route(A));
    expect(response.status).toBe(200);
    const result = response.body as any;
    expect(result.company).toEqual({ id: A, name: "Acme Ltd", prefix: "ACM" });
    expect(result.kitRoles.map((role: any) => role.key)).toEqual(TEAM_ROLES.map((role) => role.key));
    for (const role of result.kitRoles) {
      const kit = RUN_PROFILES[role.key as keyof typeof RUN_PROFILES];
      expect(role.runProfile).toEqual(kit);
      expect(role.profiles.claude_local.adapterConfig).toMatchObject({ model: kit.model, timeoutSec: kit.timeoutSec, maxTurnsPerRun: kit.maxTurnsPerRun });
      expect(role.profiles.claude_local.runtimeConfig).toEqual({ heartbeat: { maxConcurrentRuns: kit.maxConcurrentRuns } });
      // Hermes settings only for a role that has a Hermes model.
      expect(role.profiles.hermes_local === null).toBe(!kit.hermes);
      if (kit.hermes) expect(role.profiles.hermes_local.adapterConfig).toMatchObject({ model: kit.hermes.model, provider: kit.hermes.provider, timeoutSec: kit.timeoutSec });
    }
    expect(result.templates.map((template: any) => template.key)).toEqual(loadPack().templates.map((template) => template.key));
    const planner = result.templates.find((template: any) => template.key === "planner");
    expect(planner.instructions).toContain("Acme Ltd");
    expect(planner.adapterConfig).toMatchObject({ model: "claude-fable-5-1" });
    expect(planner.runtimeConfig).toEqual({ heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 3 } });
    expect(planner.profiles.claude_local.runtimeConfig).toEqual({ heartbeat: { maxConcurrentRuns: 3 } });
    expect(planner.match).toMatchObject({ names: ["Planner"] });
    const critic = result.templates.find((template: any) => template.key === "plan-critic");
    expect(critic.adapterType).toBe("hermes_local");
    expect(critic.profiles.hermes_local.adapterConfig).toMatchObject({ provider: "nous", model: "deepseek/deepseek-v4-flash-0731" });
    expect(result.steps).toHaveLength(10);
    expect(result.skillSyncActions).toMatchObject({ "partnersinbiz.crm": "crm.sync-skills", "partnersinbiz.cockpit": "cockpit.load" });
    // No secret and no company data beyond its name and prefix.
    expect(JSON.stringify(result)).not.toMatch(/secret_ref|ghp_|github_pat_/);
  });

  it("is a read: it creates nothing and changes nothing", async () => {
    const { ctx, issues, store } = setup();
    await handleApiRoute(ctx, route(A));
    expect(issues.size).toBe(0);
    expect(store.bootstrap_runs ?? []).toHaveLength(0);
    expect(store.template_hires ?? []).toHaveLength(0);
  });
});

describe("options", () => {
  it("keeps ids and switches only", () => {
    expect(sanitizeOptions(null)).toEqual({});
    expect(sanitizeOptions({ copyFromCompanyId: "<script>", hiringAgentId: "../x", templates: "developer", includeOptionalRoles: "yes", starterPack: 1 })).toEqual({});
    expect(sanitizeOptions({ templates: ["developer", 5, "nope", "planner"] }).templates).toEqual(["developer", "planner"]);
  });

  it("reads agents as the page sends them, at most 200", () => {
    expect(toAgentLikes("x")).toEqual([]);
    expect(toAgentLikes([{ id: "1", name: "A", title: "T", role: "r", status: "idle", reportsTo: "0", urlKey: "a" }, { name: "no id" }, "x"])).toEqual([{ id: "1", name: "A", title: "T", role: "r", status: "idle", reportsTo: "0", urlKey: "a" }]);
    expect(toAgentLikes(Array.from({ length: 300 }, (_v, index) => ({ id: String(index), name: "A" })))).toHaveLength(200);
  });
});
