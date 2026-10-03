import { describe, expect, it } from "vitest";
import { TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit";
import { runStatus, type BootstrapOptions, type StepId, type StepItem, type StepStatus } from "../src/bootstrap.js";
import { AGENT_LIST_UNREADABLE, hiringFor, PLUGIN_LIST_UNREADABLE, runClientSteps, selectedTemplates, stepRoles, stepStarterPack, stepTemplates, summarizeItems, type RunnerEnv, type RunnerPlugin } from "../src/bootstrap-runner.js";
import { MODULE_KEYS, SETUP_PLUGIN, type ModuleKey } from "../src/kit-setup.js";
import { WIKI_PLUGIN } from "../src/memory.js";
import { allModulesOn } from "../src/modules.js";
import { emptyRoleState, type TeamRole, type TeamRoleKey, type TeamRoleState } from "../src/team.js";

const CO = "co-new";
const perms = { canCreateAgents: true };
const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, role: "general", title: null, status: "idle", reportsTo: null, urlKey: name.toLowerCase().replace(/ /g, "-"), permissions: perms, ...extra });

const schemaOf = (extra: Record<string, unknown> = {}) => ({ type: "object", properties: { enabled: { type: "boolean", default: true }, ...extra } });
const JEV = { jev: { type: "object", properties: { enabled: { type: "boolean", default: false }, apiKey: { format: "secret-ref", title: "TypeSafe key" } } } };

const plugin = (pluginKey: string, module: ModuleKey, extra: Partial<RunnerPlugin> = {}): RunnerPlugin => ({ pluginKey, id: `${module}-id`, status: "ready", schema: schemaOf(), module, ...extra });
const INSTALLED = (): Record<string, RunnerPlugin> => ({
  "partnersinbiz.cockpit": plugin("partnersinbiz.cockpit", "cockpit"),
  "partnersinbiz.crm": plugin("partnersinbiz.crm", "crm", { schema: schemaOf(JEV) }),
  "partnersinbiz.seo": plugin("partnersinbiz.seo", "seo"),
  "partnersinbiz.social": plugin("partnersinbiz.social", "social"),
  "partnersinbiz.accounting": plugin("partnersinbiz.accounting", "accounting"),
  [WIKI_PLUGIN]: plugin(WIKI_PLUGIN, "memory"),
});

interface Fake {
  env: RunnerEnv;
  saves: Array<{ target: string; config: Record<string, unknown> }>;
  actions: Array<{ plugin: string; action: string; params?: Record<string, unknown> }>;
  roleHires: Array<{ role: TeamRoleKey; assigneeAgentId: string | null; assigneeUserId: string | null; title: string; description: string }>;
  templateHires: Array<{ key: string; assignee: { assigneeAgentId: string | null; assigneeUserId: string | null } }>;
  drafts: string[];
  recorded: Array<{ id: StepId; status: StepStatus; detail: string; items?: StepItem[]; grants?: unknown; starterImport?: unknown }>;
  wiki: { n: number };
  imports: { n: number };
  configs: Map<string, { saved: boolean; config: Record<string, unknown> }>;
}

function fake(patch: { agents?: unknown[] | null; options?: BootstrapOptions; roles?: Partial<Record<TeamRoleKey, "ok" | "hiring" | "missing" | "attention">>; installed?: Record<string, RunnerPlugin> | null; modules?: Record<ModuleKey, boolean>; hires?: Array<{ templateKey: string; issueId: string; status: string }>; me?: string | null; starter?: { approved: boolean; importedAt: string | null }; configs?: Record<string, { saved: boolean; config: Record<string, unknown> }>; failures?: Record<string, string>; statuses?: RunnerEnv["statuses"] } = {}): Fake {
  const out: Fake = { saves: [], actions: [], roleHires: [], templateHires: [], drafts: [], recorded: [], wiki: { n: 0 }, imports: { n: 0 }, configs: new Map(), env: undefined as unknown as RunnerEnv };
  for (const [key, value] of Object.entries(patch.configs ?? {})) out.configs.set(key, value);
  const failures = patch.failures ?? {};
  const roleState = (role: TeamRole): TeamRoleState => {
    const kind = patch.roles?.[role.key] ?? "missing";
    if (kind === "ok") return emptyRoleState(role, { loaded: true, agent: { id: `a-${role.key}`, name: `${role.title} agent`, title: null, role: null, status: "idle", urlKey: null } });
    if (kind === "attention") return emptyRoleState(role, { loaded: true, agent: { id: `a-${role.key}`, name: `${role.title} agent`, title: null, role: null, status: "paused", urlKey: null } });
    if (kind === "hiring") return emptyRoleState(role, { loaded: true, hire: { issueId: "h", identifier: "X-1", title: "t", status: "open", createdAt: null, assigneeAgentId: null, assigneeUserId: null } });
    return emptyRoleState(role, { loaded: true });
  };
  const agents = patch.agents === undefined ? [agent("ceo", "PiB", { title: "CEO" })] : patch.agents;
  out.env = {
    companyId: CO,
    company: { id: CO, name: "Acme", prefix: "ACM" },
    me: patch.me === undefined ? "user-1" : patch.me,
    ownerName: "Jo",
    modules: patch.modules ?? allModulesOn(),
    installed: patch.installed === undefined ? INSTALLED() : patch.installed,
    options: patch.options ?? {},
    requireApproval: false,
    statuses: patch.statuses ?? {},
    starter: patch.starter ?? { approved: false, importedAt: null },
    hires: patch.hires ?? [],
    getConfig: async (target, company) => {
      if (failures[`get:${target}:${company}`]) throw new Error(failures[`get:${target}:${company}`]!);
      return out.configs.get(`${target}|${company}`) ?? { saved: false, config: {} };
    },
    saveConfig: async (target, company, config) => {
      if (failures[`save:${target}`]) throw new Error(failures[`save:${target}`]!);
      out.saves.push({ target, config });
      out.configs.set(`${target}|${company}`, { saved: true, config });
    },
    runAction: async (pluginKey, action, params) => {
      if (failures[`action:${action}`]) throw new Error(failures[`action:${action}`]!);
      out.actions.push({ plugin: pluginKey, action, ...(params ? { params } : {}) });
      return action === "memory.import" ? { added: 12, duplicates: 1, skippedClient: 0, invalid: [] } : {};
    },
    fetchAgents: async () => agents,
    loadTeam: async (roles) => Object.fromEntries(roles.map((role) => [role.key, roleState(role)])),
    hireOptions: async (role) => {
      if (failures[`options:${role.key}`]) throw new Error(failures[`options:${role.key}`]!);
      return { draft: { title: `Hire: ${role.title}`, description: `Please hire the ${role.title}.` }, agents: [], defaultAssigneeAgentId: null };
    },
    startRoleHire: async (role, task) => {
      out.roleHires.push({ role: role.key, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId, title: task.title, description: task.description });
      return { issueId: `i-${role.key}`, identifier: `ACM-${out.roleHires.length}`, title: task.title, status: "open", createdAt: null, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId };
    },
    templateDraft: async (key) => {
      out.drafts.push(key);
      return { title: `Hire: ${key}`, description: `Description of ${key}` };
    },
    startTemplateHire: async (key, assignee) => {
      if (failures[`template:${key}`]) throw new Error(failures[`template:${key}`]!);
      out.templateHires.push({ key, assignee });
      return { identifier: `ACM-${100 + out.templateHires.length}`, existed: false, staffed: null, woke: true };
    },
    setupWiki: async () => {
      out.wiki.n += 1;
      return ["Created the wiki folder."];
    },
    starterPackImport: async () => {
      out.imports.n += 1;
      return { data: { format: "pib-company-memory", version: 1, facts: [] } };
    },
    record: async (id, status, detail, extra) => {
      out.recorded.push({ id, status, detail, ...(extra ?? {}) });
    },
  };
  return out;
}

const statusOf = (f: Fake, id: StepId) => f.recorded.find((entry) => entry.id === id)!;

describe("a fresh company with a CEO", () => {
  it("saves every setting, syncs every plugin's skills, opens a hire task per required role and per dev-chain template, and lists what only a person can do", async () => {
    const f = fake();
    const results = await runClientSteps(f.env);
    expect(results.map((entry) => entry.id)).toEqual(["setup-settings", "plugin-settings", "skills", "roles", "templates", "company-wiki", "starter-pack", "owner-list"]);

    // Setup's own settings first (Q7-7), then each ready plugin's defaults.
    expect(f.saves[0]).toEqual({ target: SETUP_PLUGIN, config: { weeklyIssue: true } });
    expect(f.saves.map((save) => save.target).sort()).toEqual(["accounting-id", "cockpit-id", "crm-id", "seo-id", "social-id", SETUP_PLUGIN].sort());
    expect(f.saves.find((save) => save.target === "crm-id")!.config).toEqual({ enabled: true, jev: { enabled: false } });
    expect(statusOf(f, "plugin-settings")).toMatchObject({ status: "done" });

    // Skills: each plugin's own sync; the Cockpit's goes without the team views.
    expect(f.actions.filter((entry) => entry.action !== "memory.import").map((entry) => `${entry.plugin}:${entry.action}`).sort()).toEqual([
      "partnersinbiz.accounting:accounting.sync-skills",
      "partnersinbiz.cockpit:cockpit.load",
      "partnersinbiz.crm:crm.sync-skills",
      "partnersinbiz.seo:seo.sync-skills",
      "partnersinbiz.social:social.sync-skills",
    ]);
    expect(f.actions.find((entry) => entry.action === "cockpit.load")!.params).toEqual({ team: false });

    // The five required kit roles, assigned to the CEO agent; no optional role.
    expect(f.roleHires.map((hire) => hire.role).sort()).toEqual(["account-manager", "bookkeeper", "operator", "seo-specialist", "social"]);
    for (const hire of f.roleHires) expect(hire).toMatchObject({ assigneeAgentId: "ceo", assigneeUserId: null });

    // The dev chain: every default template that is not already staffed (the CEO is) and holds no kit role.
    expect(f.templateHires.map((hire) => hire.key)).toEqual(["delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer"]);
    for (const hire of f.templateHires) expect(hire.assignee).toEqual({ assigneeAgentId: "ceo", assigneeUserId: null });
    expect(statusOf(f, "templates").items!.find((item) => item.key === "ceo")).toMatchObject({ status: "done", detail: "PiB already is the CEO." });

    // The wiki is set up, the starter pack stays off.
    expect(f.wiki.n).toBe(1);
    expect(statusOf(f, "starter-pack")).toMatchObject({ status: "skipped" });
    expect(f.imports.n).toBe(0);

    // The one list of grants, recorded with the step.
    const owner = statusOf(f, "owner-list");
    expect(owner.status).toBe("needs_owner");
    expect((owner.grants as Array<{ id: string }>).map((grant) => grant.id)).toEqual(expect.arrayContaining(["plugin-secrets", "github-token", "resume-agents", "tools-grant", "starter-pack"]));
    // Every page step reported itself.
    expect(f.recorded.map((entry) => entry.id)).toEqual(["setup-settings", "plugin-settings", "skills", "roles", "templates", "company-wiki", "starter-pack", "owner-list"]);
  });

  it("changes nothing the second time: settings saved, roles and templates already hiring", async () => {
    const first = fake();
    await runClientSteps(first.env);
    const second = fake({
      configs: Object.fromEntries([...first.configs.entries()].map(([key, value]) => [key, value])),
      roles: { operator: "hiring", "account-manager": "hiring", "seo-specialist": "hiring", social: "hiring", bookkeeper: "hiring" },
      hires: first.templateHires.map((hire, index) => ({ templateKey: hire.key, issueId: `t-${index}`, status: "open" })),
    });
    await runClientSteps(second.env);
    expect(second.saves).toEqual([]);
    expect(second.roleHires).toEqual([]);
    expect(second.templateHires).toEqual([]);
    expect(statusOf(second, "plugin-settings").items!.every((item) => item.status === "done" && /already saved/i.test(item.detail ?? ""))).toBe(true);
    expect(statusOf(second, "templates")).toMatchObject({ status: "done" });
    expect(statusOf(second, "roles")).toMatchObject({ status: "done" });
  });

  it("opens the optional roles only when asked", async () => {
    const f = fake({ options: { includeOptionalRoles: true } });
    await runClientSteps(f.env, ["roles"]);
    expect(f.roleHires.map((hire) => hire.role).sort()).toEqual(["account-manager", "bookkeeper", "crm-data-steward", "deal-desk", "inbound-qualifier", "operator", "reviewer", "sales-lead", "seo-specialist", "social"].sort());
  });

  it("leaves a role alone when its agent is fine, needs attention, or has an open hire task", async () => {
    const f = fake({ roles: { operator: "ok", "account-manager": "attention", "seo-specialist": "hiring" } });
    const outcome = await stepRoles(f.env);
    const by = Object.fromEntries(outcome.items.map((item) => [item.key, item]));
    expect(by.operator).toMatchObject({ status: "done", detail: "Operator agent already holds it." });
    expect(by["account-manager"]).toMatchObject({ status: "skipped" });
    expect(by["account-manager"]!.detail).toMatch(/Setup -> Team/);
    expect(by["seo-specialist"]).toMatchObject({ status: "done", detail: "A hire task is already open." });
    expect(f.roleHires.map((hire) => hire.role).sort()).toEqual(["bookkeeper", "social"]);
  });
});

describe("a company with nobody who can hire", () => {
  it("opens no role task, gives only the CEO's hire task to the person, and waits on the rest", async () => {
    const f = fake({ agents: [], me: "user-1" });
    await runClientSteps(f.env);
    expect(f.roleHires).toEqual([]);
    expect(statusOf(f, "roles")).toMatchObject({ status: "blocked" });
    expect(statusOf(f, "roles").items![0]!.detail).toMatch(/no agent yet/);
    expect(f.templateHires).toEqual([{ key: "ceo", assignee: { assigneeAgentId: null, assigneeUserId: "user-1" } }]);
    const items = Object.fromEntries(statusOf(f, "templates").items!.map((item) => [item.key, item]));
    expect(items.ceo).toMatchObject({ status: "done" });
    expect(items.planner).toMatchObject({ status: "blocked", detail: "Waits for the CEO: there is no agent that can hire yet." });
    const grants = statusOf(f, "owner-list").grants as Array<{ id: string }>;
    expect(grants[0]!.id).toBe("hiring-agent");
  });

  it("says so when the viewer cannot be assigned either (the local board placeholder)", async () => {
    const f = fake({ agents: [], me: null });
    const outcome = await stepTemplates(f.env);
    expect(f.templateHires).toEqual([]);
    expect(outcome.items.find((item) => item.key === "ceo")).toMatchObject({ status: "blocked", detail: "Open Setup while signed in as a board member: the CEO's hire task is assigned to you." });
  });

  it("hires once the CEO exists: repeating after the person created it opens the rest", async () => {
    const f = fake({ agents: [agent("c", "Boss", { title: "CEO" })] });
    await stepTemplates(f.env);
    expect(f.templateHires.map((hire) => hire.key)).toContain("planner");
    expect(f.templateHires.map((hire) => hire.key)).not.toContain("ceo");
  });

  it("counts the head agent as the CEO when its title does not say so (a head like Steve), and hires through it", async () => {
    const f = fake({ agents: [agent("steve", "Steve"), agent("arjun", "Arjun", { title: "Engineering Lead", reportsTo: "steve" })] });
    const outcome = await stepTemplates(f.env);
    expect(outcome.items.find((item) => item.key === "ceo")).toMatchObject({ status: "done" });
    expect(outcome.items.find((item) => item.key === "ceo")!.detail).toMatch(/Steve does the CEO's job/);
    expect(f.templateHires.length).toBeGreaterThan(0);
    for (const hire of f.templateHires) expect(hire.assignee.assigneeAgentId).toBe("steve");
  });
});

describe("a list that cannot be read is not an empty list", () => {
  const STEPS_NEEDING_PLUGINS: StepId[] = ["plugin-settings", "skills", "roles", "company-wiki", "owner-list"];

  for (const [label, installed] of [["could not be fetched (null)", null], ["came back with no PiB plugin ({})", {} as Record<string, RunnerPlugin>]] as const) {
    it(`fails every step that needs the plugins when the plugin list ${label}, changes nothing and never reads as complete`, async () => {
      const f = fake({ installed });
      const results = await runClientSteps(f.env);
      for (const id of STEPS_NEEDING_PLUGINS) {
        expect(statusOf(f, id), id).toMatchObject({ status: "failed", detail: PLUGIN_LIST_UNREADABLE });
        expect(statusOf(f, id).detail, id).not.toMatch(/Nothing to do|No module that needs|not installed/);
      }
      // Nothing was saved (but Setup's own settings), synced, hired or set up behind the failure.
      expect(f.saves.map((save) => save.target)).toEqual([SETUP_PLUGIN]);
      expect(f.actions).toEqual([]);
      expect(f.roleHires).toEqual([]);
      expect(f.wiki.n).toBe(0);
      expect(statusOf(f, "owner-list").grants).toBeUndefined();
      // A step that does not need the plugin list (Setup's own settings) still ran.
      expect(statusOf(f, "setup-settings")).toMatchObject({ status: "done" });
      // The run shows "some steps need attention", never "complete".
      expect(runStatus(f.recorded.map((entry) => ({ status: entry.status })))).toBe("partial");
      expect(results.filter((entry) => entry.outcome.status === "failed").map((entry) => entry.id)).toEqual(expect.arrayContaining(STEPS_NEEDING_PLUGINS));
    });
  }

  it("goes on normally once the list can be read (the failure is not sticky)", async () => {
    const f = fake({ installed: null });
    await runClientSteps(f.env, ["plugin-settings"]);
    expect(statusOf(f, "plugin-settings").status).toBe("failed");
    f.env.installed = INSTALLED();
    f.recorded.length = 0;
    await runClientSteps(f.env, ["plugin-settings", "skills"]);
    expect(statusOf(f, "plugin-settings").status).toBe("done");
    expect(f.saves.map((save) => save.target)).toContain("crm-id");
    expect(statusOf(f, "skills").status).toBe("done");
  });

  it("opens no role task, no template task and no CEO task for the viewer when the agent list cannot be read, and fails the owner list", async () => {
    const f = fake({ agents: null, me: "user-1" });
    const results = await runClientSteps(f.env);
    expect(f.roleHires).toEqual([]);
    expect(f.templateHires).toEqual([]);
    expect(f.drafts).toEqual([]);
    const roles = statusOf(f, "roles");
    expect(roles.status).toBe("failed");
    expect(roles.items!.every((item) => item.status === "failed" && item.detail === AGENT_LIST_UNREADABLE)).toBe(true);
    const templates = statusOf(f, "templates");
    expect(templates.status).toBe("failed");
    // Every template, the CEO included: "no agent found" and "could not look" are different.
    expect(templates.items!.map((item) => item.key)).toEqual(expect.arrayContaining(["ceo", "delivery-lead", "planner"]));
    expect(templates.items!.every((item) => item.status === "failed" && item.detail === AGENT_LIST_UNREADABLE)).toBe(true);
    expect(statusOf(f, "owner-list")).toMatchObject({ status: "failed" });
    expect(statusOf(f, "owner-list").detail).toMatch(/agent list could not be read/);
    expect(statusOf(f, "owner-list").grants).toBeUndefined();
    expect(runStatus(f.recorded.map((entry) => ({ status: entry.status })))).toBe("partial");
    expect(results.find((entry) => entry.id === "roles")!.outcome.status).toBe("failed");
  });

  it("still counts a hire task that is already open, and a role whose agent the team check found, when the agent list cannot be read", async () => {
    const f = fake({ agents: null, roles: { operator: "ok" }, hires: [{ templateKey: "planner", issueId: "t-1", status: "open" }] });
    const templates = await stepTemplates(f.env);
    expect(templates.items.find((item) => item.key === "planner")).toMatchObject({ status: "done", detail: "A hire task is already open." });
    expect(templates.items.find((item) => item.key === "developer")).toMatchObject({ status: "failed" });
    const roles = await stepRoles(f.env);
    expect(roles.items.find((item) => item.key === "operator")).toMatchObject({ status: "done" });
    expect(roles.items.find((item) => item.key === "bookkeeper")).toMatchObject({ status: "failed", detail: AGENT_LIST_UNREADABLE });
    expect(f.roleHires).toEqual([]);
    expect(f.templateHires).toEqual([]);
  });

  it("is told apart from a company that really has no agent: that one gets the CEO's hire task, the unreadable one does not", async () => {
    const empty = fake({ agents: [], me: "user-1" });
    await stepTemplates(empty.env);
    expect(empty.templateHires.map((hire) => hire.key)).toEqual(["ceo"]);
    const unreadable = fake({ agents: null, me: "user-1" });
    await stepTemplates(unreadable.env);
    expect(unreadable.templateHires).toEqual([]);
    expect((await hiringFor(unreadable.env))).toMatchObject({ unreadable: true, agents: null, assigneeAgentId: null, pick: { agent: null, problem: AGENT_LIST_UNREADABLE } });
    expect((await hiringFor(empty.env))).toMatchObject({ unreadable: false, agents: [] });
  });
});

describe("the Wiki Maintainer is made by the LLM Wiki plugin, not by a hire task", () => {
  it("skips a ticked wiki-maintainer template when the Company wiki step will create the agent, so the two do not race into a duplicate", async () => {
    const f = fake({ options: { templates: ["wiki-maintainer"] } });
    const outcome = await stepTemplates(f.env);
    expect(outcome.items).toEqual([expect.objectContaining({ key: "wiki-maintainer", status: "skipped" })]);
    expect(outcome.items[0]!.detail).toMatch(/Company wiki step/);
    expect(f.templateHires).toEqual([]);
  });

  it("says it is waiting when the LLM Wiki plugin is not installed, and fails when the plugin list could not be read", async () => {
    const installed = INSTALLED();
    delete installed[WIKI_PLUGIN];
    const missing = fake({ options: { templates: ["wiki-maintainer"] }, installed });
    expect((await stepTemplates(missing.env)).items[0]).toMatchObject({ key: "wiki-maintainer", status: "blocked" });
    expect(missing.templateHires).toEqual([]);
    const unreadable = fake({ options: { templates: ["wiki-maintainer"] }, installed: null });
    expect((await stepTemplates(unreadable.env)).items[0]).toMatchObject({ key: "wiki-maintainer", status: "failed", detail: PLUGIN_LIST_UNREADABLE });
  });

  it("an agent that already is the Wiki Maintainer (the plugin's own role) counts as staffed", async () => {
    const f = fake({ options: { templates: ["wiki-maintainer"] }, agents: [agent("ceo", "PiB", { title: "CEO" }), agent("w", "Archivist", { role: "knowledge-maintainer" })] });
    expect((await stepTemplates(f.env)).items[0]).toMatchObject({ key: "wiki-maintainer", status: "done" });
  });
});

describe("one failure stays on its row", () => {
  it("fails that plugin, goes on with the rest, and tries only the failed one again", async () => {
    const f = fake({ failures: { [`get:crm-id:${CO}`]: "Could not read settings (500)" } });
    const results = await runClientSteps(f.env, ["plugin-settings"]);
    expect(results[0]!.outcome.status).toBe("failed");
    const items = Object.fromEntries(statusOf(f, "plugin-settings").items!.map((item) => [item.key, item]));
    expect(items["partnersinbiz.crm"]).toMatchObject({ status: "failed", detail: "Could not read settings (500)" });
    expect(items["partnersinbiz.seo"]).toMatchObject({ status: "done" });
    expect(f.saves.map((save) => save.target)).not.toContain("crm-id");

    // The cause is fixed: a repeat saves only what is still missing.
    f.env.getConfig = async (target, company) => f.configs.get(`${target}|${company}`) ?? { saved: false, config: {} };
    f.saves.length = 0;
    await runClientSteps(f.env, ["plugin-settings"]);
    expect(f.saves.map((save) => save.target)).toEqual(["crm-id"]);
  });

  it("tells settings-not-saved, plugin-too-old and a real error apart in the skill sync", async () => {
    const f = fake({ failures: { "action:seo.sync-skills": "company context is required", "action:crm.sync-skills": "No action handler registered for crm.sync-skills", "action:social.sync-skills": "boom" } });
    const outcome = (await runClientSteps(f.env, ["skills"]))[0]!.outcome;
    const items = Object.fromEntries(outcome.items.map((item) => [item.key, item]));
    expect(items["partnersinbiz.seo"]).toMatchObject({ status: "blocked", detail: "Save the plugin's settings first, then run this again." });
    expect(items["partnersinbiz.crm"]).toMatchObject({ status: "skipped" });
    expect(items["partnersinbiz.social"]).toMatchObject({ status: "failed", detail: "boom" });
    expect(outcome.status).toBe("failed");
    expect(items["partnersinbiz.accounting"]).toMatchObject({ status: "done" });
  });

  it("keeps opening role tasks after one role's hire options fail", async () => {
    const f = fake({ failures: { "options:social": "social plugin is down" } });
    const outcome = await stepRoles(f.env);
    expect(outcome.items.find((item) => item.key === "social")).toMatchObject({ status: "failed", detail: "social plugin is down" });
    expect(f.roleHires.map((hire) => hire.role)).not.toContain("social");
    expect(f.roleHires.map((hire) => hire.role)).toContain("bookkeeper");
    expect(outcome.status).toBe("failed");
  });

  it("records a step that throws as failed and still runs the next step", async () => {
    const f = fake();
    f.env.fetchAgents = async () => {
      throw new Error("agents are down");
    };
    const results = await runClientSteps(f.env, ["roles", "company-wiki"]);
    expect(results[0]!.outcome).toMatchObject({ status: "failed", detail: "agents are down" });
    expect(statusOf(f, "roles")).toMatchObject({ status: "failed" });
    expect(statusOf(f, "company-wiki")).toMatchObject({ status: "done" });
  });

  it("does not crash when the worker cannot save a step's report", async () => {
    const f = fake();
    f.env.record = async () => {
      throw new Error("worker unreachable");
    };
    const results = await runClientSteps(f.env, ["setup-settings"]);
    expect(results[0]!.outcome.detail).toMatch(/could not be saved: worker unreachable/);
  });

  it("blocks a plugin that is not ready instead of calling it", async () => {
    const installed = INSTALLED();
    installed["partnersinbiz.seo"] = plugin("partnersinbiz.seo", "seo", { status: "error" });
    const f = fake({ installed });
    const outcome = (await runClientSteps(f.env, ["plugin-settings", "skills"]))[0]!.outcome;
    expect(outcome.items.find((item) => item.key === "partnersinbiz.seo")).toMatchObject({ status: "blocked" });
    expect(f.saves.map((save) => save.target)).not.toContain("seo-id");
    expect(f.actions.map((entry) => entry.action)).not.toContain("seo.sync-skills");
  });

  it("skips a module that is switched off", async () => {
    const f = fake({ modules: { ...allModulesOn(), seo: false, social: false } });
    await runClientSteps(f.env, ["plugin-settings", "skills", "roles"]);
    expect(f.saves.map((save) => save.target)).not.toContain("seo-id");
    expect(f.actions.map((entry) => entry.action)).not.toContain("seo.sync-skills");
    expect(f.roleHires.map((hire) => hire.role)).not.toContain("seo-specialist");
    expect(f.roleHires.map((hire) => hire.role)).not.toContain("social");
  });
});

describe("copying another company's settings", () => {
  it("fills what the target lacks, never copies a secret or another company's id, and says which secrets are still to add", async () => {
    const source = { saved: true, config: { enabled: false, region: "za", jev: { enabled: true, apiKey: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" } }, ownerAgent: "22222222-2222-2222-2222-222222222222", name: "Source Co" } };
    const f = fake({ options: { copyFromCompanyId: "co-source" }, configs: { "crm-id|co-source": source } });
    // Give CRM a schema that has the secret field, so "pick afterwards" can name it.
    f.env.installed!["partnersinbiz.crm"] = plugin("partnersinbiz.crm", "crm", { schema: schemaOf({ region: { type: "string" }, name: { type: "string" }, ownerAgent: { type: "string" }, ...JEV }) });
    const outcome = await runClientSteps(f.env, ["plugin-settings"]);
    const saved = f.saves.find((save) => save.target === "crm-id")!.config;
    // The source's value wins over the schema default; what the source never set falls back to the default.
    expect(saved).toEqual({ enabled: false, region: "za", name: "Source Co", jev: { enabled: true } });
    expect(JSON.stringify(saved)).not.toMatch(/secret_ref|22222222/);
    expect(outcome[0]!.outcome.items.find((item) => item.key === "partnersinbiz.crm")!.detail).toMatch(/Secrets still to add: TypeSafe key/);
  });

  it("changes nothing for a plugin the source never saved", async () => {
    const f = fake({ options: { copyFromCompanyId: "co-source" } });
    await runClientSteps(f.env, ["plugin-settings"]);
    // Only the defaults were saved (nothing to copy).
    expect(f.saves.find((save) => save.target === "seo-id")!.config).toEqual({ enabled: true });
  });
});

describe("the team template pack", () => {
  it("selects the defaults, or the keys asked for, limited to modules that are on", () => {
    expect(selectedTemplates({}, allModulesOn()).map((template) => template.key)).toEqual(["ceo", "delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer"]);
    expect(selectedTemplates({ templates: ["developer", "growth-marketing-lead", "nope"] }, allModulesOn()).map((template) => template.key)).toEqual(["developer", "growth-marketing-lead"]);
    expect(selectedTemplates({ templates: ["growth-marketing-lead", "wiki-maintainer"] }, { ...allModulesOn(), social: false, memory: false })).toEqual([]);
    expect(MODULE_KEYS).toContain("memory");
  });

  it("hires a template that holds a kit role through that role's plugin, with the template's own description, and skips the plain role", async () => {
    const f = fake({ options: { templates: ["growth-marketing-lead"] } });
    await runClientSteps(f.env, ["roles", "templates"]);
    expect(f.drafts).toEqual(["growth-marketing-lead"]);
    const social = f.roleHires.filter((hire) => hire.role === "social");
    expect(social).toHaveLength(1);
    expect(social[0]).toMatchObject({ title: "Hire: growth-marketing-lead", description: "Description of growth-marketing-lead", assigneeAgentId: "ceo" });
    expect(statusOf(f, "roles").items!.find((item) => item.key === "social")).toMatchObject({ status: "skipped" });
    // A template for a kit role never goes through the worker's own template hire.
    expect(f.templateHires).toEqual([]);
  });

  it("does not open a second hire for a kit role that is staffed or already hiring", async () => {
    const f = fake({ options: { templates: ["growth-marketing-lead"] }, roles: { social: "ok" } });
    const outcome = await stepTemplates(f.env);
    expect(outcome.items[0]).toMatchObject({ key: "growth-marketing-lead", status: "done" });
    expect(outcome.items[0]!.detail).toMatch(/already holds the Social agent role/);
    expect(f.roleHires).toEqual([]);
    const hiring = fake({ options: { templates: ["growth-marketing-lead"] }, roles: { social: "hiring" } });
    expect((await stepTemplates(hiring.env)).items[0]!.detail).toMatch(/already open/);
  });

  it("fails one template's task and carries on with the others", async () => {
    const f = fake({ failures: { "template:planner": "assignee not found" } });
    const outcome = await stepTemplates(f.env);
    expect(outcome.items.find((item) => item.key === "planner")).toMatchObject({ status: "failed", detail: "assignee not found" });
    expect(f.templateHires.map((hire) => hire.key)).toContain("developer");
    expect(outcome.status).toBe("failed");
  });

  it("warns when the assignee could not be woken, and says so for an existing task", async () => {
    const f = fake({ options: { templates: ["developer"] } });
    f.env.startTemplateHire = async () => ({ identifier: "ACM-5", existed: false, staffed: null, woke: false });
    const outcome = await stepTemplates(f.env);
    expect(outcome.items[0]!.detail).toBe("Opened hire task ACM-5. The assignee was not woken: open the task.");
    f.env.startTemplateHire = async () => ({ identifier: null, existed: true, staffed: null, woke: false });
    expect((await stepTemplates(f.env)).items[0]!.detail).toBe("A hire task was already open.");
    f.env.startTemplateHire = async () => ({ identifier: null, existed: false, staffed: "Dev", woke: false });
    expect((await stepTemplates(f.env)).items[0]!.detail).toBe("Dev already is the Developer.");
  });
});

describe("the company wiki and the starter pack", () => {
  it("sets the wiki up only when its module is on and the plugin is installed", async () => {
    const off = fake({ modules: { ...allModulesOn(), memory: false } });
    await runClientSteps(off.env, ["company-wiki"]);
    expect(off.wiki.n).toBe(0);
    expect(statusOf(off, "company-wiki")).toMatchObject({ status: "skipped" });
    const installed = INSTALLED();
    delete installed[WIKI_PLUGIN];
    const missing = fake({ installed });
    await runClientSteps(missing.env, ["company-wiki"]);
    expect(statusOf(missing, "company-wiki").detail).toMatch(/not installed/);
    expect(missing.wiki.n).toBe(0);
  });

  it("is off unless chosen, and needs the owner's OK when chosen but not approved", async () => {
    expect((await stepStarterPack(fake().env)).status).toBe("skipped");
    const unapproved = fake({ options: { starterPack: true } });
    const outcome = await stepStarterPack(unapproved.env);
    expect(outcome.status).toBe("needs_owner");
    expect(outcome.detail).toMatch(/Needs the owner's OK/);
    expect(unapproved.imports.n).toBe(0);
    expect(unapproved.actions).toEqual([]);
  });

  it("imports through the Cockpit once approved, records the result, and does not import twice", async () => {
    const f = fake({ options: { starterPack: true }, starter: { approved: true, importedAt: null } });
    const results = await runClientSteps(f.env, ["starter-pack"]);
    expect(f.imports.n).toBe(1);
    expect(f.actions).toEqual([{ plugin: "partnersinbiz.cockpit", action: "memory.import", params: { data: { format: "pib-company-memory", version: 1, facts: [] } } }]);
    expect(results[0]!.outcome.detail).toBe("Added 12 facts, 1 already there.");
    expect(statusOf(f, "starter-pack").starterImport).toMatchObject({ added: 12 });
    const again = fake({ options: { starterPack: true }, starter: { approved: true, importedAt: "2026-10-03T10:00:00.000Z" } });
    const outcome = await stepStarterPack(again.env);
    expect(outcome).toMatchObject({ status: "done", detail: "Already seeded on 2026-10-03." });
    expect(again.imports.n).toBe(0);
  });

  it("fails when the Cockpit refused every fact", async () => {
    const f = fake({ options: { starterPack: true }, starter: { approved: true, importedAt: null } });
    f.env.runAction = async () => ({ added: 0, duplicates: 0, invalid: [{ text: "x", reason: "looks like a secret" }] });
    expect((await stepStarterPack(f.env)).status).toBe("failed");
  });
});

describe("summarising a step", () => {
  it("is failed before blocked before needs-you before done, and skipped when everything was", () => {
    const item = (status: StepItem["status"]): StepItem => ({ key: status, label: status, status });
    expect(summarizeItems([item("done"), item("failed"), item("blocked")]).status).toBe("failed");
    expect(summarizeItems([item("done"), item("blocked")]).status).toBe("blocked");
    expect(summarizeItems([item("done"), item("needs_owner")]).status).toBe("needs_owner");
    expect(summarizeItems([item("done"), item("skipped")]).status).toBe("done");
    expect(summarizeItems([item("skipped")]).status).toBe("skipped");
    expect(summarizeItems([]).status).toBe("done");
    expect(summarizeItems([item("done"), item("failed")], "role").detail).toBe("2 roles: 1 done, 1 failed.");
    expect(TEAM_ROLES.length).toBe(11);
  });
});
