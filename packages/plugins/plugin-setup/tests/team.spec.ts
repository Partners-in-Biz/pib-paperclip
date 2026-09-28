import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { teamRole } from "@partnersinbiz/pib-plugin-kit/team";
import type { SetupItem, SetupStatus } from "../src/kit-setup.js";
import { finishSetupContent } from "../src/finish-issue.js";
import { guidedOrder } from "../src/guide.js";
import { allModulesOn } from "../src/modules.js";
import {
  actionSummary,
  anchorRole,
  cockpitConflict,
  cockpitRolePatch,
  dropSkillAsks,
  emptyRoleState,
  extraSkillStates,
  extrasToAttach,
  failedRoleState,
  guidedSteps,
  hireStale,
  missingActionError,
  roleLoadError,
  ownerChoices,
  ownerPatch,
  parseBoardUsers,
  parseCockpitTeam,
  parseCompanyAgents,
  parseHireOptions,
  pickChoices,
  pickLabel,
  pluginProblem,
  reviewPatch,
  roleHealth,
  roleStateFromCockpit,
  roleStateFromHireOptions,
  rowOpenByDefault,
  setupFocus,
  skillLabel,
  skillNames,
  teamItemPath,
  teamRolesFor,
  teamSummary,
  withTeamLink,
  withTeamLinks,
  type TeamRoleState,
} from "../src/team.js";
import { resolveModuleViews } from "../src/ui/data.js";
import { GuideOwnerStep, GuideTeamStep, TeamRoleRow, TeamSettings, teamLinkAnchor } from "../src/ui/team.js";
import { attachRoleSkills, checkSkills, fetchHireOptions, loadTeam } from "../src/ui/team-client.js";

const linkFor = (href: string) => ({ href: `/PIB${href}` });
const NOW = Date.parse("2026-09-27T10:00:00.000Z");

const companyAgents = parseCompanyAgents([
  { id: "a-ceo", name: "CEO", role: "ceo", title: null, status: "idle", urlKey: "ceo" },
  { id: "a-sam", name: "Sam", role: "general", title: "SEO Specialist", status: "paused", urlKey: "sam" },
  { id: "a-ops", name: "Olive", role: "general", title: "Chief of staff", status: "active", urlKey: "olive" },
  { id: "a-rev", name: "Rex", role: "general", title: "Quality reviewer", status: "active", urlKey: "rex" },
  { id: "a-gone", name: "Gone", role: "general", title: null, status: "terminated", urlKey: "gone" },
]);

const summary = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({ id, name, title: null, role: "general", status, icon: null, createdAt: "2026-09-20T10:00:00.000Z", ...extra });
const hireRecord = (status: string, extra: Record<string, unknown> = {}) => ({
  issueId: "11111111-1111-4111-8111-111111111111",
  identifier: "PIB-12",
  title: "Hire: SEO Specialist (SEO agent)",
  assigneeAgentId: "a-ceo",
  assigneeUserId: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  status,
  ...extra,
});
const hireOptions = (status: Record<string, unknown>) => ({
  draft: { title: "Hire: SEO Specialist (SEO agent)", description: "## The agent" },
  agents: [summary("a-ceo", "CEO", "idle", { role: "ceo" }), summary("a-sam", "Sam", "paused")],
  defaultAssigneeAgentId: "a-ceo",
  status,
});

const seo = teamRole("seo-specialist");
const operator = teamRole("operator");
const reviewer = teamRole("reviewer");
const bookkeeper = teamRole("bookkeeper");

describe("team roles", () => {
  it("lists the roles of switched-on modules whose plugin is installed", () => {
    expect(teamRolesFor({ modules: null, installed: null }).map((r) => r.key)).toEqual(["operator", "reviewer", "account-manager", "sales-lead", "inbound-qualifier", "crm-data-steward", "deal-desk", "seo-specialist", "social", "bookkeeper", "payroll-clerk"]);
    const installed = {
      "partnersinbiz.cockpit": { status: "ready" },
      "partnersinbiz.seo": { status: "ready" },
      "partnersinbiz.accounting": { status: "error" },
      "partnersinbiz.payroll": { status: "ready" },
    };
    // Social and the CRM are not installed; Payroll is switched off.
    expect(teamRolesFor({ modules: { ...allModulesOn(), payroll: false }, installed }).map((r) => r.key)).toEqual(["operator", "reviewer", "seo-specialist", "bookkeeper"]);
    expect(teamRolesFor({ modules: null, installed: { ...installed, "partnersinbiz.crm": { status: "ready" } } }).map((r) => r.key)).toContain("account-manager");
    expect(pluginProblem(bookkeeper, installed)).toBe("The Accounting plugin is error. Enable or upgrade it in Settings → Plugins, then check again.");
    expect(pluginProblem(seo, installed)).toBeNull();
    expect(pluginProblem(seo, null)).toBeNull();
  });

  it("maps a plugin's hire-options to the role state", () => {
    const linked = roleStateFromHireOptions(seo, hireOptions({ agent: summary("a-sam", "Sam", "paused"), linkedBy: "manual", hire: hireRecord("linked"), candidates: [] }), companyAgents);
    expect(linked).toMatchObject({ loaded: true, error: null, linkedBy: "manual", agent: { id: "a-sam", name: "Sam", status: "paused", urlKey: "sam" }, hire: { status: "linked", identifier: "PIB-12" } });
    expect(roleHealth(linked)).toBe("attention");
    expect(roleHealth({ ...linked, agent: { ...linked.agent!, status: "idle" }, missingSkills: [] })).toBe("ok");
    expect(roleHealth({ ...linked, agent: { ...linked.agent!, status: "idle" }, missingSkills: seo.skills })).toBe("attention");

    const hiring = roleStateFromHireOptions(seo, hireOptions({ agent: null, linkedBy: null, hire: hireRecord("open"), candidates: [summary("a-n1", "SEO Specialist", "paused"), summary("a-n2", "SEO Specialist 2", "paused")] }), companyAgents);
    expect(roleHealth(hiring)).toBe("hiring");
    expect(hiring.candidates.map((c) => c.id)).toEqual(["a-n1", "a-n2"]);

    const gone = roleStateFromHireOptions(seo, hireOptions({ agent: summary("a-gone", "Gone", "terminated"), linkedBy: "manual", hire: null, candidates: [] }), companyAgents);
    expect(gone.agent).toBeNull();
    expect(roleHealth(gone)).toBe("missing");

    const old = roleStateFromHireOptions(seo, { draft: { title: "x", description: "" }, agents: [] }, null);
    expect(old.error).toMatch(/did not say who the SEO Specialist is/);
    expect(roleHealth(old)).toBe("unknown");
    expect(roleHealth(emptyRoleState(seo))).toBe("loading");

    expect(parseHireOptions(hireOptions({}))).toEqual({
      draft: { title: "Hire: SEO Specialist (SEO agent)", description: "## The agent" },
      agents: [expect.objectContaining({ id: "a-ceo", role: "ceo" }), expect.objectContaining({ id: "a-sam" })],
      defaultAssigneeAgentId: "a-ceo",
    });
    expect(parseHireOptions({ error: "nope" })).toBeNull();
  });

  it("maps cockpit.load to the Operator and Reviewer, the saved role first", () => {
    const cockpit = parseCockpitTeam({
      roles: { companyId: "c1", operatorAgentId: "a-ops", reviewerAgentId: null, ownerUserId: "u1", reviewOutward: true, updatedAt: "x" },
      settingsSaved: false,
      team: {
        operator: { agent: summary("a-ops", "Olive", "active"), hire: null, candidates: [], linkedBy: "manual" },
        reviewer: { agent: null, hire: hireRecord("open", { title: "Hire: Reviewer (Cockpit agent)" }), candidates: [], linkedBy: null },
      },
      snapshots: {},
    })!;
    expect(cockpit).toMatchObject({ settingsSaved: false, roles: { operatorAgentId: "a-ops", ownerUserId: "u1", reviewOutward: true } });
    const op = roleStateFromCockpit(operator, cockpit, companyAgents);
    expect(op).toMatchObject({ agent: { id: "a-ops", urlKey: "olive", title: "Chief of staff" }, linkedBy: "manual" });
    expect(roleHealth({ ...op, missingSkills: [] })).toBe("ok");
    expect(roleHealth(roleStateFromCockpit(reviewer, cockpit, companyAgents))).toBe("hiring");

    // The saved agent was terminated: fall back to the one the hire linked.
    const fallback = parseCockpitTeam({ roles: { operatorAgentId: "a-gone" }, team: { operator: { agent: summary("a-rev", "Rex", "active"), linkedBy: "auto" } } })!;
    expect(roleStateFromCockpit(operator, fallback, companyAgents)).toMatchObject({ agent: { id: "a-rev" }, linkedBy: "auto" });
    // Never saved: nobody yet.
    const fresh = parseCockpitTeam({ roles: null, settingsSaved: false, team: { operator: { agent: null, hire: null, candidates: [], linkedBy: null } } })!;
    expect(fresh.roles).toBeNull();
    expect(roleHealth(roleStateFromCockpit(operator, fresh, null))).toBe("missing");
    expect(parseCockpitTeam(null)).toBeNull();
  });

  it("opens rows that need something and counts them", () => {
    expect(rowOpenByDefault(seo, "missing")).toBe(true);
    expect(rowOpenByDefault(reviewer, "missing")).toBe(false);
    expect(rowOpenByDefault(seo, "ok")).toBe(false);
    for (const health of ["hiring", "attention", "unknown"] as const) expect(rowOpenByDefault(reviewer, health)).toBe(true);
    const states: TeamRoleState[] = [
      { ...emptyRoleState(operator), loaded: true },
      { ...emptyRoleState(reviewer), loaded: true },
      { ...emptyRoleState(seo), loaded: true, hire: roleStateFromHireOptions(seo, hireOptions({ hire: hireRecord("open") })).hire },
      { ...emptyRoleState(bookkeeper), loaded: true, error: "down" },
    ];
    expect(teamSummary(states)).toEqual({ total: 4, needYou: 2, hiring: 1, ok: 0, loading: false });
    expect(teamSummary([emptyRoleState(seo)]).loading).toBe(true);
  });

  it("says when an open hire is stale", () => {
    expect(hireStale({ status: "open", createdAt: "2026-09-25T10:00:00.000Z" } as never, NOW)).toBe(false);
    expect(hireStale({ status: "open", createdAt: "2026-09-10T10:00:00.000Z" } as never, NOW)).toBe(true);
    expect(hireStale({ status: "linked", createdAt: "2026-09-10T10:00:00.000Z" } as never, NOW)).toBe(false);
  });

  it("reads board members and offers the owner choices", () => {
    const users = parseBoardUsers({ users: [
      { principalId: "u1", status: "active", user: { id: "u1", name: "Peet", email: "p@x" } },
      { principalId: "u2", status: "active", user: { id: "u2", name: null, email: "anna@x" } },
      { principalId: "local-board", status: "active", user: { id: "local-board", name: "Board" } },
      { principalId: "u3", status: "active", user: null },
    ] });
    expect(users).toEqual([{ id: "u1", name: "Peet" }, { id: "u2", name: "anna@x" }, { id: "local-board", name: "Board" }, { id: "u3", name: "u3" }]);
    const choices = ownerChoices({ users, me: "u2", ownerUserId: "u9" });
    expect(choices.map((c) => [c.id, c.me])).toEqual([["u1", false], ["u2", true], ["u3", false], ["u9", false]]);
    // The local board placeholder is never a choice; nobody to pick in trusted local mode.
    expect(ownerChoices({ users: [{ id: "local-board", name: "Board" }], me: "local-board", ownerUserId: null })).toEqual([]);
    expect(ownerChoices({ users: [], me: "u5", ownerUserId: null })).toEqual([{ id: "u5", name: "Me", me: true }]);
  });

  it("summarises link, re-sync and save answers, and drops skill asks once the page attached the skill", () => {
    expect(actionSummary({ agent: {}, steps: ["Granted tools."], instructions: ["Resume it."] })).toEqual({ steps: ["Granted tools."], instructions: ["Resume it."] });
    expect(actionSummary({ ok: true, message: "Linked." })).toEqual({ steps: ["Linked."], instructions: [] });
    expect(actionSummary({ results: [{ skillKey: "plugin/partnersinbiz-payroll/payroll", action: "updated" }] }).steps).toEqual(["Synced the role's skills."]);
    expect(actionSummary({ results: [{ skillKey: "plugin/partnersinbiz-payroll/payroll", action: "failed", error: "boom" }] }).steps).toEqual(["The payroll skill did not sync (boom)."]);
    expect(dropSkillAsks(["Attach the pib-seo-sprint skill to Sam.", "Granted plugin tool access."], seo.skills)).toEqual(["Granted plugin tool access."]);
    // Plain names, never the pib- slug or the plugin id.
    expect(skillNames(teamRole("social").skills)).toBe("the publishing, writing posts and company operating manual skills");
    expect(skillNames(seo.skills)).toBe("the SEO sprints and company operating manual skills");
    expect(skillLabel("plugin/partnersinbiz-billing/invoice-draft")).toBe("Billing: invoice drafting");
    expect(skillLabel("plugin/partnersinbiz-mailbox/mailbox-draft")).toBe("Mailbox: email drafting");
    expect(skillLabel("paperclipai/paperclip/paperclip")).toBe("Paperclip: issues and comments");
    expect(skillLabel("plugin/partnersinbiz-seo/some-new-skill")).toBe("SEO: some new skill");
  });
});

describe("checklist links go to Setup → Team", () => {
  const item = (key: string, extra: Partial<SetupItem> = {}): SetupItem => ({ key, title: key, status: "missing", required: true, ...extra });

  it("points every role item and the Cockpit owner item at the Team section", () => {
    expect(teamItemPath("partnersinbiz.seo", "agent")).toBe("/setup?section=team#team-seo-specialist");
    expect(teamItemPath("partnersinbiz.social", "agent")).toBe("/setup?section=team#team-social");
    expect(teamItemPath("partnersinbiz.accounting", "bookkeeper")).toBe("/setup?section=team#team-bookkeeper");
    expect(teamItemPath("partnersinbiz.payroll", "clerk")).toBe("/setup?section=team#team-payroll-clerk");
    expect(teamItemPath("partnersinbiz.cockpit", "operator_agent")).toBe("/setup?section=team#team-operator");
    expect(teamItemPath("partnersinbiz.cockpit", "reviewer_agent")).toBe("/setup?section=team#team-reviewer");
    expect(teamItemPath("partnersinbiz.cockpit", "owner")).toBe("/setup?section=team#team-owner");
    expect(teamItemPath("partnersinbiz.cockpit", "routines")).toBeNull();
    expect(teamItemPath("partnersinbiz.seo", "settings")).toBeNull();
  });

  it("rewrites the link, drops the unassigned hire action and swaps the steps", () => {
    const status: SetupStatus = {
      plugin: "partnersinbiz.seo",
      module: "seo",
      title: "SEO",
      checkedAt: "2026-09-27T10:00:00.000Z",
      items: [
        item("settings", { status: "done", href: "/company/settings/instance/plugins/x" }),
        item("agent", { title: "Hire or link the SEO agent", href: "/seo", hrefLabel: "Open SEO", steps: ["Open SEO and click Activate SEO agent."], action: { plugin: "partnersinbiz.seo", key: "seo.start-hire", label: "Open a hire task" }, agentNext: "Works the sprints." }),
      ],
    };
    const linked = withTeamLinks(status);
    expect(linked.items[0]).toEqual(status.items[0]);
    expect(linked.items[1]).toMatchObject({ href: "/setup?section=team#team-seo-specialist", hrefLabel: "Open Team", action: null, agentNext: "Works the sprints." });
    expect(linked.items[1]!.steps?.[0]).toBe("Open Setup → Team.");
    expect(withTeamLinks(linked)).toEqual(linked);
    // Unrelated statuses are returned as they are (Billing staffs no role).
    const billing: SetupStatus = { ...status, plugin: "partnersinbiz.billing", module: "billing", items: [item("agent")] };
    expect(withTeamLinks(billing)).toBe(billing);
    // The CRM's agent item is the Account Manager's.
    expect(withTeamLink("partnersinbiz.crm", item("agent"))).toMatchObject({ href: "/setup?section=team#team-account-manager", hrefLabel: "Open Team" });
    // Another action on a role item stays; a done item keeps its (unshown) steps.
    const other = withTeamLink("partnersinbiz.payroll", item("clerk", { status: "done", action: { plugin: "partnersinbiz.payroll", key: "payroll.sync-skills", label: "Sync" }, steps: undefined }));
    expect(other).toMatchObject({ href: "/setup?section=team#team-payroll-clerk", action: { key: "payroll.sync-skills" }, steps: undefined });
    const owner = withTeamLink("partnersinbiz.cockpit", item("owner", { href: "/cockpit?tab=team", hrefLabel: "Open Team", steps: ["Open the Cockpit → Team."] }));
    expect(owner).toMatchObject({ href: "/setup?section=team#team-owner", hrefLabel: "Open Team" });
    expect(owner.steps?.[1]).toMatch(/Who gets the daily brief/);
  });

  it("rewrites the statuses the page shows", () => {
    const cockpit: SetupStatus = { plugin: "partnersinbiz.cockpit", module: null, title: "Cockpit", checkedAt: "2026-09-27T10:00:00.000Z", items: [item("operator_agent", { href: "/cockpit?tab=team" }), item("routines", { href: "/routines" })] };
    const view = resolveModuleViews({ modules: null, installed: null, live: { "partnersinbiz.cockpit": { ok: true, status: cockpit } }, stored: {} }).find((v) => v.pluginKey === "partnersinbiz.cockpit")!;
    expect(view.status!.items.map((i) => i.href)).toEqual(["/setup?section=team#team-operator", "/routines"]);
    // Stored statuses from before this version are rewritten too.
    const stored = resolveModuleViews({ modules: null, installed: null, live: {}, stored: { "partnersinbiz.cockpit": { status: cockpit, receivedAt: "x" } } }).find((v) => v.pluginKey === "partnersinbiz.cockpit")!;
    expect(stored.status!.items[0]!.href).toBe("/setup?section=team#team-operator");
  });

  it("links role items in the weekly Finish setup issue to Setup → Team", () => {
    const modules = { ...Object.fromEntries(Object.keys(allModulesOn()).map((key) => [key, false])), seo: true };
    const content = finishSetupContent({
      modules,
      statuses: {
        "partnersinbiz.seo": {
          plugin: "partnersinbiz.seo",
          module: "seo",
          title: "SEO",
          checkedAt: "2026-09-27T10:00:00.000Z",
          items: [item("agent", { title: "Hire or link the SEO agent", href: "/seo", hrefLabel: "Open SEO", action: { plugin: "partnersinbiz.seo", key: "seo.start-hire", label: "Open a hire task" } }), item("bing_key", { title: "Add the Bing key", href: "/seo" })],
        },
      },
      installed: null,
      prefix: "PIB",
    })!;
    expect(content.description).toContain("- [ ] **Hire or link the SEO agent** [Open Team](/PIB/setup?section=team#team-seo-specialist)");
    expect(content.description).not.toContain("Open a hire task");
    expect(content.description).toContain("**Add the Bing key** [Open](/PIB/seo)");
  });
});

describe("guided setup: the team first", () => {
  const status = (plugin: string, items: SetupItem[]): SetupStatus => ({ plugin, module: null, title: plugin, items, checkedAt: "2026-09-27T10:00:00.000Z" });
  const missing = (key: string, title = key): SetupItem => ({ key, title, status: "missing", required: true });

  it("walks missing required roles, then the owner, then the checklist without asking twice", () => {
    const items = guidedOrder([
      { module: "cockpit", pluginKey: "partnersinbiz.cockpit", status: status("partnersinbiz.cockpit", [missing("settings"), missing("owner", "Choose who the Cockpit reports to"), missing("operator_agent", "Link the Operator agent")]) },
      { module: "seo", pluginKey: "partnersinbiz.seo", status: status("partnersinbiz.seo", [missing("agent", "Hire or link the SEO agent"), missing("bing_key", "Add the Bing Webmaster API key")]) },
      { module: "accounting", pluginKey: "partnersinbiz.accounting", status: status("partnersinbiz.accounting", [missing("bookkeeper", "Hire or link the Bookkeeper")]) },
    ]);
    const team: TeamRoleState[] = [
      { ...emptyRoleState(operator), loaded: true },
      { ...emptyRoleState(reviewer), loaded: true },
      { ...emptyRoleState(seo), loaded: true, hire: roleStateFromHireOptions(seo, hireOptions({ hire: hireRecord("open") })).hire },
      { ...emptyRoleState(bookkeeper), loaded: true, error: "The Accounting plugin is error." },
    ];
    const steps = guidedSteps({ team, ownerNeeded: true, items });
    // Operator (required, missing) first, then the owner. The Reviewer is optional; SEO is hiring;
    // the Bookkeeper could not be checked, so its checklist item stays.
    expect(steps.map((s) => s.id)).toEqual([
      "team:operator",
      "team:owner",
      "partnersinbiz.cockpit:settings",
      "partnersinbiz.seo:bing_key",
      "partnersinbiz.accounting:bookkeeper",
    ]);
    const skipped = new Set(["team:operator", "team:owner"]);
    expect(guidedSteps({ team, ownerNeeded: true, items: guidedOrder([], skipped), skipped }).map((s) => s.id)).toEqual([]);
    // No owner step: the Cockpit's owner item stays in the checklist order.
    expect(guidedSteps({ team, ownerNeeded: false, items }).map((s) => s.id)).toContain("partnersinbiz.cockpit:owner");
    // Before the team is checked, nothing about it is dropped.
    expect(guidedSteps({ team: [emptyRoleState(seo)], items }).map((s) => s.id)).toContain("partnersinbiz.seo:agent");
    // An agent that needs attention keeps its checklist item (it links to the Team row with the fixes).
    const paused = { ...emptyRoleState(seo), loaded: true, agent: companyAgents.find((a) => a.id === "a-sam")!, missingSkills: [] };
    expect(roleHealth(paused)).toBe("attention");
    expect(guidedSteps({ team: [paused], items }).map((s) => s.id)).toContain("partnersinbiz.seo:agent");
    // Staffed and fine: its item is not asked again.
    expect(guidedSteps({ team: [{ ...paused, agent: { ...paused.agent, status: "active" } }], items }).map((s) => s.id)).not.toContain("partnersinbiz.seo:agent");
  });
});

describe("saving the Cockpit team", () => {
  it("sends only what changes", () => {
    expect(cockpitRolePatch("operator", "a-ops")).toEqual({ operatorAgentId: "a-ops" });
    expect(cockpitRolePatch("reviewer", null)).toEqual({ reviewerAgentId: null });
    expect(cockpitRolePatch("reviewer", " ")).toEqual({ reviewerAgentId: null });
    expect(ownerPatch("u1")).toEqual({ ownerUserId: "u1" });
    expect(ownerPatch("")).toEqual({ ownerUserId: null });
    expect(reviewPatch(true)).toEqual({ reviewOutward: true });
    expect(reviewPatch(false)).toEqual({ reviewOutward: false });
  });

  it("keeps the Operator and the Reviewer different", () => {
    const ops = companyAgents.find((a) => a.id === "a-ops")!;
    const rev = companyAgents.find((a) => a.id === "a-rev")!;
    expect(cockpitConflict({ kind: "reviewer", agentId: "a-ops", operator: ops, reviewer: null })).toBe("Olive is already the Operator. The Operator and the Reviewer must be different agents.");
    expect(cockpitConflict({ kind: "operator", agentId: "a-ops", operator: ops, reviewer: rev })).toBeNull();
    const states = {
      operator: { ...emptyRoleState(operator), loaded: true, agent: ops },
      "seo-specialist": { ...emptyRoleState(seo), loaded: true, agent: companyAgents.find((a) => a.id === "a-sam")!, candidates: [] },
      reviewer: { ...emptyRoleState(reviewer), loaded: true, candidates: [companyAgents.find((a) => a.id === "a-rev")!] },
    };
    const choices = pickChoices({ role: reviewer, agents: companyAgents, states });
    expect(choices.map((c) => c.agent.id)).toEqual(["a-rev", "a-ceo", "a-ops", "a-sam"]);
    expect(choices.find((c) => c.agent.id === "a-ops")!.blocked).toMatch(/already the Operator/);
    expect(pickLabel(choices.find((c) => c.agent.id === "a-sam")!)).toBe("Sam (paused) · already SEO Specialist");
    expect(pickLabel(choices.find((c) => c.agent.id === "a-ceo")!)).toBe("CEO · Ceo");
  });
});

describe("the address", () => {
  it("opens the Team section and names the role to scroll to", () => {
    expect(setupFocus("?section=team", "#team-bookkeeper")).toEqual({ section: "team", anchor: "team-bookkeeper" });
    expect(setupFocus("?section=team", "")).toEqual({ section: "team", anchor: "team" });
    expect(setupFocus("", "#team-owner")).toEqual({ section: "team", anchor: "team-owner" });
    expect(setupFocus("?section=checklist", "")).toEqual({ section: "checklist", anchor: null });
    expect(setupFocus("?section=nope", "#elsewhere")).toEqual({ section: null, anchor: null });
    expect(anchorRole("team-payroll-clerk")).toBe("payroll-clerk");
    expect(anchorRole("team-owner")).toBeNull();
    expect(anchorRole("team")).toBeNull();
    expect(teamLinkAnchor("/setup?section=team#team-bookkeeper")).toBe("team-bookkeeper");
    expect(teamLinkAnchor("/setup?section=team")).toBe("team");
    expect(teamLinkAnchor("/seo")).toBeNull();
  });
});

describe("Team rows render", () => {
  const render = (state: TeamRoleState, open = true, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(TeamRoleRow, { state, open, linkFor, now: NOW, onToggle: () => undefined, onRetry: () => undefined, ...extra }));
  const sam = companyAgents.find((a) => a.id === "a-sam")!;

  it("missing: says so and offers Hire and Pick existing", () => {
    const html = render({ ...emptyRoleState(seo), loaded: true });
    expect(html).toContain('id="team-seo-specialist"');
    expect(html).toContain('data-health="missing"');
    expect(html).toContain("Missing");
    expect(html).toContain("Hire opens a ready-made hire task");
    expect(html).toContain("Hire SEO Specialist");
    expect(html).toContain("Pick existing");
    expect(html).not.toContain("Remove");
  });

  it("optional and missing: one compact line", () => {
    const html = render({ ...emptyRoleState(reviewer), loaded: true }, false);
    expect(html).toContain("Not hired");
    expect(html).toContain("optional");
    expect(html).toContain("Set up");
    expect(html).not.toContain("Hire Reviewer");
  });

  it("hiring: links the open hire task and lists look-alikes", () => {
    const state = roleStateFromHireOptions(seo, hireOptions({ agent: null, linkedBy: null, hire: hireRecord("open"), candidates: [summary("a-n1", "SEO A", "paused"), summary("a-n2", "SEO B", "paused")] }), companyAgents);
    const html = render(state);
    expect(html).toContain("Hiring");
    expect(html).toContain('href="/PIB/issues/PIB-12"');
    expect(html).toContain("links the new agent automatically");
    expect(html).toContain("(SEO A, SEO B)");
    expect(html).toContain("Pick the new agent");
    expect(html).not.toContain("Open a new hire task");
    const stale = render({ ...state, hire: { ...state.hire!, createdAt: "2026-09-01T10:00:00.000Z" } });
    expect(stale).toContain("Open a new hire task");
  });

  it("attention: the agent, what is wrong, and the fixes", () => {
    const html = render({ ...emptyRoleState(seo), loaded: true, agent: sam, linkedBy: "manual", missingSkills: seo.skills }, true, { note: { tone: "ok", title: "Linked Sam", lines: ["Synced the `pib-seo-sprint` skill."] } });
    expect(html).toContain("Needs attention");
    expect(html).toContain('href="/PIB/agents/sam"');
    expect(html).toContain("Paused, so it picks up no SEO Specialist work.");
    // The agent's title is the role title: not repeated.
    expect(html).not.toContain("· SEO Specialist</span> is the SEO Specialist");
    expect(html).toContain(" is the SEO Specialist (paused)");
    expect(html).toContain("Missing the SEO sprints and company operating manual skills");
    expect(html).toContain("Attach missing skills");
    expect(html).toContain("Re-sync");
    expect(html).toContain("Change");
    expect(html).toContain("Remove");
    expect(html).toContain("<code");
  });

  it("ok: one compact line with the agent, the actions behind Manage", () => {
    const ok = { ...emptyRoleState(operator), loaded: true, agent: companyAgents.find((a) => a.id === "a-ops")!, linkedBy: "auto" as const, missingSkills: [] };
    const compact = render(ok, false);
    expect(compact).toContain('data-health="ok"');
    expect(compact).toContain(">OK<");
    expect(compact).toContain('href="/PIB/agents/olive"');
    expect(compact).toContain("Manage");
    expect(compact).not.toContain("Remove");
    const open = render(ok, true);
    // The Cockpit roles have no re-sync; they can be changed or removed.
    expect(open).not.toContain("Re-sync");
    expect(open).toContain("Change");
    expect(open).toContain("Remove");
    expect(open).toContain("linked from the hire task");
    // A legacy host-managed agent cannot be removed here.
    expect(render({ ...ok, role: seo, linkedBy: "managed" }, true)).not.toContain("Remove");
  });

  it("unknown and loading", () => {
    const unknown = render({ ...emptyRoleState(bookkeeper), loaded: true, error: "The Accounting plugin is error. Enable or upgrade it in Settings → Plugins, then check again." });
    expect(unknown).toContain("Can&#x27;t check");
    expect(unknown).toContain("Enable or upgrade it");
    expect(unknown).toContain("Check again");
    const loading = render(emptyRoleState(bookkeeper), true);
    expect(loading).toContain("Checking…");
    expect(loading).not.toContain("Hire Bookkeeper");
  });

  it("renders who gets the daily brief, and the review switch only with a Reviewer", () => {
    const users = [{ id: "u1", name: "Peet" }, { id: "u2", name: "Anna" }];
    const without = renderToStaticMarkup(createElement(TeamSettings, { users, me: "u1", ownerUserId: "u2", reviewOutward: false, reviewer: null, onOwner: () => undefined, onReview: () => undefined }));
    expect(without).toContain('id="team-owner"');
    expect(without).toContain("Who gets the daily brief");
    expect(without).toContain("Peet (me)");
    expect(without).toMatch(/<option value="u2" selected="">Anna<\/option>/);
    expect(without).not.toContain('role="switch"');
    const withReviewer = renderToStaticMarkup(createElement(TeamSettings, { users, me: "u1", ownerUserId: null, reviewOutward: true, reviewer: companyAgents.find((a) => a.id === "a-rev")!, onOwner: () => undefined, onReview: () => undefined }));
    expect(withReviewer).toContain('role="switch"');
    expect(withReviewer).toContain('aria-checked="true"');
    expect(withReviewer).toContain("Reviewer checks outward-facing work before you approve");
    expect(withReviewer).toContain("go to Rex first");
  });

  it("says why nobody can get the daily brief and links to inviting a person, never a dead dropdown", () => {
    // Local board placeholder and no members: nobody to pick.
    const empty = renderToStaticMarkup(createElement(TeamSettings, { users: [], me: "local-board", ownerUserId: null, reviewOutward: false, reviewer: null, linkFor, onOwner: () => undefined, onReview: () => undefined }));
    expect(empty).toContain("Nobody can get the daily brief yet");
    expect(empty).toContain("Invite a person under Company settings → Members");
    expect(empty).toContain('href="/PIB/company/settings/members?tab=invites"');
    expect(empty).not.toContain("<select");
    // The member list could not be read: says so, still no dead dropdown.
    const unread = renderToStaticMarkup(createElement(TeamSettings, { users: null, me: null, ownerUserId: null, reviewOutward: false, reviewer: null, linkFor, onOwner: () => undefined, onReview: () => undefined }));
    expect(unread).toContain("could not be read just now");
    expect(unread).not.toContain("<select");
  });

  it("renders the guided team steps", () => {
    const hire = renderToStaticMarkup(createElement(GuideTeamStep, { state: { ...emptyRoleState(operator), loaded: true }, onHire: () => undefined, onPick: () => undefined, onSkip: () => undefined }));
    expect(hire).toContain("Step 1 · Team");
    expect(hire).toContain("Hire the Operator");
    expect(hire).toContain("Pick existing");
    expect(hire).toContain("Skip for now");
    const owner = renderToStaticMarkup(createElement(GuideOwnerStep, { users: [{ id: "u1", name: "Peet" }], me: "u1", ownerUserId: null, onSave: () => undefined, onSkip: () => undefined }));
    expect(owner).toContain("Who gets the daily brief?");
    expect(owner).toMatch(/<option value="u1" selected="">Peet \(me\)<\/option>/);
  });
});

describe("the Account Manager (CRM) row", () => {
  const am = teamRole("account-manager");
  const render = (state: TeamRoleState, open = true) =>
    renderToStaticMarkup(createElement(TeamRoleRow, { state, open, linkFor, now: NOW, onToggle: () => undefined, onRetry: () => undefined, onAttachExtras: () => undefined }));
  const installed = { "partnersinbiz.crm": { status: "ready" }, "partnersinbiz.billing": { status: "ready" }, "partnersinbiz.mailbox": { status: "ready" } };

  it("uses the CRM's Team actions and extra skills from the kit", () => {
    expect(am.actions).toEqual({ options: "crm.hire-options", start: "crm.start-hire", link: "crm.link-agent", unlink: "crm.unlink-agent", resync: "crm.resync-agent" });
    expect(am.setupItemKey).toBe("agent");
    expect(teamItemPath("partnersinbiz.crm", "agent")).toBe("/setup?section=team#team-account-manager");
    expect(am.skills.at(-1)).toBe("plugin/partnersinbiz-cockpit/company-os");
  });

  it("says plainly when the CRM plugin does not have them yet", () => {
    const error = 'No action handler registered for key "crm.hire-options"';
    expect(missingActionError(error)).toBe(true);
    expect(missingActionError("Only a board user can hire")).toBe(false);
    expect(roleLoadError(am, error)).toBe("The CRM plugin cannot staff the Account Manager yet. Upgrade the CRM plugin in Settings → Plugins, then check again.");
    const html = renderToStaticMarkup(createElement(TeamRoleRow, { state: failedRoleState(am, roleLoadError(am, error)), open: true, linkFor, now: NOW, onToggle: () => undefined, onRetry: () => undefined }));
    expect(html).toContain("Can&#x27;t check");
    expect(html).toContain("The CRM plugin cannot staff the Account Manager yet.");
    expect(html).toContain("Check again");
  });

  it("loads the CRM role like any plugin role, and a CRM without the actions is one clear error", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/actions/crm.hire-options")) return new Response(JSON.stringify({ error: 'No action handler registered for key "crm.hire-options"' }), { status: 502 });
      if (String(url).includes("/actions/seo.hire-options")) return new Response(JSON.stringify({ data: hireOptions({ agent: null, linkedBy: null, hire: null, candidates: [] }) }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    try {
      const loaded = await loadTeam({ companyId: "c1", roles: [am, seo], installed: null });
      expect(loaded.states["account-manager"]).toMatchObject({ loaded: true, error: "The CRM plugin cannot staff the Account Manager yet. Upgrade the CRM plugin in Settings → Plugins, then check again." });
      expect(roleHealth(loaded.states["account-manager"])).toBe("unknown");
      expect(roleHealth(loaded.states["seo-specialist"])).toBe("missing");
      expect(calls.some((u) => u.includes("/api/plugins/partnersinbiz.crm/actions/crm.hire-options"))).toBe(true);
      await expect(fetchHireOptions("c1", am)).rejects.toThrow("The CRM plugin cannot staff the Account Manager yet.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a sales role sends its role with every call, and shows as covered until staffed", async () => {
    const dealDesk = teamRole("deal-desk");
    const bodies: Array<{ url: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/actions/")) bodies.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/actions/crm.hire-options")) return new Response(JSON.stringify({ data: hireOptions({ agent: null, linkedBy: null, hire: null, candidates: [] }) }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    try {
      const loaded = await loadTeam({ companyId: "c1", roles: [dealDesk], installed: null });
      expect(JSON.stringify(bodies[0]!.body)).toContain('"role":"deal-desk"');
      const state = loaded.states["deal-desk"]!;
      expect(roleHealth(state)).toBe("missing");
      const html = renderToStaticMarkup(createElement(TeamRoleRow, { state, open: true, linkFor, now: NOW, onToggle: () => undefined }));
      for (const text of ["Covered", "The Account Manager covers it", "Until you hire one, the Account Manager does this work."]) expect(html, text).toContain(text);
      expect(html).not.toContain("Not hired");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("shows its extra skills as \"Also uses, when installed\", never as missing", () => {
    const library = new Set(["plugin/partnersinbiz-billing/invoice-draft", "plugin/partnersinbiz-mailbox/mailbox-draft"]);
    const extras = extraSkillStates(am, { ...installed, "partnersinbiz.partners": { status: "ready" } }, ["plugin/partnersinbiz-crm/crm-records", "plugin/partnersinbiz-billing/invoice-draft"], library);
    expect(extras.map((e) => [e.slug, e.pluginKey, e.installed, e.exists, e.attached])).toEqual([
      ["pib-invoice-draft", "partnersinbiz.billing", true, true, true],
      ["pib-campaigns", "partnersinbiz.campaigns", false, false, false],
      ["pib-mailbox-draft", "partnersinbiz.mailbox", true, true, false],
      ["pib-partner-share", "partnersinbiz.partners", true, false, false],
    ]);
    // Only what exists in the company and the agent lacks; an unread library attaches nothing.
    expect(extrasToAttach(extras)).toEqual(["plugin/partnersinbiz-mailbox/mailbox-draft"]);
    expect(extrasToAttach(extraSkillStates(am, installed, [], null))).toEqual([]);
    expect(extraSkillStates(am, null, null).every((e) => e.installed && e.attached === null && e.exists === null)).toBe(true);
    const agent = companyAgents.find((a) => a.id === "a-ops")!;
    // All role skills there (missing []): the row is OK even though extras are not all attached.
    const state = { ...emptyRoleState(am), loaded: true, agent, missingSkills: [], extras };
    expect(roleHealth(state)).toBe("ok");
    const html = render(state, true);
    for (const text of ["Also works in", "Billing: invoice drafting", "· attached", "Mailbox: email drafting", "· not attached", "Campaigns: email campaigns", "· module not installed", "Partners: partner sharing", "· not in this company yet", "Attach it", "never count as missing"]) expect(html, text).toContain(text);
    // No plugin ids or pib- slugs on screen.
    for (const slug of ["pib-invoice-draft", "pib-mailbox-draft", "pib-campaigns", "pib-partner-share", "partnersinbiz."]) expect(html).not.toContain(slug);
    // Before an agent holds the role there is nothing to attach them to: no chips.
    expect(render({ ...emptyRoleState(am), loaded: true }, true)).not.toContain("Also works in");
    // Nothing to attach: no button.
    expect(render({ ...state, extras: extras.map((e) => ({ ...e, attached: e.exists ? true : e.attached })) }, true)).not.toContain("Attach it");
  });

  it("attaches the role skills (with the manual) and installed extras when an agent is picked", async () => {
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      // The company's skill library: the Billing and Mailbox skills exist; Campaigns and Partners do not yet.
      if (String(url).startsWith("/api/companies/c1/skills")) return new Response(JSON.stringify([{ key: "plugin/partnersinbiz-billing/invoice-draft" }, { key: "plugin/partnersinbiz-mailbox/mailbox-draft" }, { key: "plugin/partnersinbiz-crm/crm-records" }]), { status: 200 });
      return new Response(JSON.stringify({ desiredSkills: ["plugin/partnersinbiz-crm/crm-records"] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await attachRoleSkills({ companyId: "c1", agentId: "a1", agentName: "Ama", role: am, installed });
      expect(result.ok).toBe(true);
      expect(bodies).toEqual([{ mode: "add", desiredSkills: ["plugin/partnersinbiz-crm/crm-outbound", "plugin/partnersinbiz-cockpit/company-os", "plugin/partnersinbiz-billing/invoice-draft", "plugin/partnersinbiz-mailbox/mailbox-draft"] }]);
      const checks = await checkSkills("c1", [{ ...emptyRoleState(am), loaded: true, agent: companyAgents[0]! }], installed);
      expect(checks["account-manager"]!.missing).toEqual(["plugin/partnersinbiz-crm/crm-outbound", "plugin/partnersinbiz-cockpit/company-os"]);
      expect(checks["account-manager"]!.extras.find((e) => e.slug === "pib-invoice-draft")).toMatchObject({ installed: true, exists: true, attached: false });
      expect(checks["account-manager"]!.extras.find((e) => e.slug === "pib-campaigns")).toMatchObject({ exists: false });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("guided setup asks for the Account Manager once, as a Team step", () => {
    const items = guidedOrder([
      { module: "crm", pluginKey: "partnersinbiz.crm", status: { plugin: "partnersinbiz.crm", module: "crm", title: "CRM", checkedAt: "x", items: [{ key: "agent", title: "Hire or link the Account Manager", status: "missing", required: true }, { key: "settings", title: "Save the settings", status: "missing", required: true }] } },
    ]);
    const steps = guidedSteps({ team: [{ ...emptyRoleState(am), loaded: true }], items });
    expect(steps.map((s) => s.id)).toEqual(["team:account-manager", "partnersinbiz.crm:settings"]);
    const html = renderToStaticMarkup(createElement(GuideTeamStep, { state: { ...emptyRoleState(am), loaded: true }, onHire: () => undefined, onPick: () => undefined, onSkip: () => undefined }));
    expect(html).toContain("Hire the Account Manager");
    expect(html).toContain("the CRM plugin links it");
    // Hired and fine: its checklist item is not asked again; could not be checked: it stays.
    expect(guidedSteps({ team: [{ ...emptyRoleState(am), loaded: true, agent: companyAgents[2]!, missingSkills: [] }], items }).map((s) => s.id)).toEqual(["partnersinbiz.crm:settings"]);
    expect(guidedSteps({ team: [failedRoleState(am, "down")], items }).map((s) => s.id)).toContain("partnersinbiz.crm:agent");
  });
});
