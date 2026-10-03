/**
 * The steps of Setup -> New company that run from the page (the board session
 * can call other plugins and save their settings; a worker cannot). Pure: every
 * host or plugin call goes through `RunnerEnv`, so the whole run is tested with
 * fakes and the page only wires `fetch` into it.
 *
 * Rules every step follows:
 * - Look first, act second. A step that finds its work done says so and changes
 *   nothing, so the run can be repeated or resumed after a failure.
 * - One failure stays on its row. A plugin that cannot be reached, a role that
 *   cannot be hired, fails that item and the run goes on; the step then reports
 *   `failed` and a repeat retries only what is left.
 * - Nothing here grants anything, copies a secret, or types a credential.
 */
import { TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit/team";
import { defaultsFromSchema, missingHandlerError, needsSettingsError, ownerGrants, SKILL_SYNC_ACTIONS, type BootstrapOptions, type OwnerGrant, type StepId, type StepItem, type StepStatus } from "./bootstrap.js";
import { mergeMissing, planCopy, previewValue } from "./copy.js";
import { hiringLine, pickHiringAgent, toHiringCandidates, type HiringPick } from "./hiring.js";
import { MODULES, type ModuleKey, type SetupStatus } from "./kit-setup.js";
import { WIKI_PLUGIN } from "./memory.js";
import { SETUP_PLUGIN } from "./kit-setup.js";
import { roleHealth, teamRolesFor, type HireOptionsLite, type TeamHire, type TeamRole, type TeamRoleKey, type TeamRoleState } from "./team.js";
import { hireOrder, loadPack, templateByKey, templateStaffing, type AgentLike, type AgentTemplate, type TemplateHireLike } from "./templates.js";

export const COCKPIT_KEY = "partnersinbiz.cockpit";

export interface RunnerPlugin {
  pluginKey: string;
  id: string;
  status: string;
  schema: unknown;
  module: ModuleKey;
}

export interface HireTaskInput {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface StarterState {
  approved: boolean;
  importedAt: string | null;
}

export interface RunnerEnv {
  companyId: string;
  company: { id: string; name: string; prefix: string | null };
  /** The viewer's user id when they can be assigned a task (not the local board placeholder). */
  me: string | null;
  ownerName: string | null;
  modules: Record<ModuleKey, boolean>;
  /** Installed PiB plugins by key (every state), or null when the plugin list could not be read. Unknown is never the same as empty: see `pluginList`. */
  installed: Record<string, RunnerPlugin> | null;
  options: BootstrapOptions;
  requireApproval: boolean | null;
  /** Stored setup statuses per plugin (for the owner list). */
  statuses: Record<string, SetupStatus | null | undefined>;
  starter: StarterState;
  hires: TemplateHireLike[];
  // --- host and plugin calls (board session) ---
  getConfig(pluginIdOrKey: string, companyId: string): Promise<{ saved: boolean; config: Record<string, unknown> }>;
  saveConfig(pluginIdOrKey: string, companyId: string, config: Record<string, unknown>): Promise<void>;
  runAction(pluginKey: string, actionKey: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Raw `GET /api/companies/:id/agents`, or null when it cannot be read. */
  fetchAgents(): Promise<unknown[] | null>;
  /** Each role's state (kit roles of the switched-on modules). */
  loadTeam(roles: TeamRole[]): Promise<Partial<Record<TeamRoleKey, TeamRoleState>>>;
  hireOptions(role: TeamRole): Promise<HireOptionsLite>;
  startRoleHire(role: TeamRole, task: HireTaskInput): Promise<TeamHire | null>;
  templateDraft(key: string, hiring: HiringPick): Promise<{ title: string; description: string }>;
  startTemplateHire(key: string, assignee: { assigneeAgentId: string | null; assigneeUserId: string | null }, hiring: HiringPick): Promise<{ identifier: string | null; existed: boolean; staffed: string | null; woke: boolean }>;
  setupWiki(): Promise<string[]>;
  starterPackImport(): Promise<{ data: unknown }>;
  /** Tells the worker where a step stands. */
  record(stepId: StepId, status: StepStatus, detail: string, extra?: { items?: StepItem[]; grants?: OwnerGrant[]; starterImport?: unknown }): Promise<void>;
}

export interface StepOutcome {
  status: StepStatus;
  detail: string;
  items: StepItem[];
  extra?: { grants?: OwnerGrant[]; starterImport?: unknown };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : "failed");

/** What a step says when it could not look at the plugins: it checked nothing and changed nothing, so it must not read as done. */
export const PLUGIN_LIST_UNREADABLE = "The plugin list could not be read (or no PiB plugin is installed), so nothing was checked and nothing was changed. Try again.";
/** Same for the agents: without the list nobody can say who is already hired, so no hire task is opened. */
export const AGENT_LIST_UNREADABLE = "The company's agent list could not be read, so nobody can say who is already hired: no hire task was opened. Try again.";

/**
 * The installed plugins when the page could read them. Null (the read failed) and `{}` (no PiB plugin in the answer:
 * the page itself runs inside a host that has them) are both "could not look", never "nothing to do".
 */
function pluginList(env: RunnerEnv): Record<string, RunnerPlugin> | null {
  return env.installed && Object.keys(env.installed).length > 0 ? env.installed : null;
}

const pluginsUnreadable = (): StepOutcome => ({ status: "failed", detail: PLUGIN_LIST_UNREADABLE, items: [] });

/** One status and sentence for a step from its items. */
export function summarizeItems(items: StepItem[], noun = "item"): { status: StepStatus; detail: string } {
  if (items.length === 0) return { status: "done", detail: "Nothing to do." };
  const count = (status: StepItem["status"]) => items.filter((item) => item.status === status).length;
  const failed = count("failed");
  const blocked = count("blocked");
  const owner = count("needs_owner");
  const done = count("done");
  const parts = [done ? `${done} done` : "", count("skipped") ? `${count("skipped")} skipped` : "", failed ? `${failed} failed` : "", blocked ? `${blocked} waiting` : "", owner ? `${owner} need you` : ""].filter(Boolean);
  const detail = `${items.length} ${noun}${items.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  if (failed) return { status: "failed", detail };
  if (blocked) return { status: "blocked", detail };
  if (owner) return { status: "needs_owner", detail };
  return { status: items.every((item) => item.status === "skipped") ? "skipped" : "done", detail };
}

function pluginsToRun(env: RunnerEnv): { ready: RunnerPlugin[]; problems: StepItem[]; unreadable: boolean } {
  const ready: RunnerPlugin[] = [];
  const problems: StepItem[] = [];
  const list = pluginList(env);
  if (!list) return { ready, problems, unreadable: true };
  for (const [pluginKey, plugin] of Object.entries(list)) {
    if (pluginKey === WIKI_PLUGIN) continue;
    if (!env.modules[plugin.module]) continue;
    const label = MODULES[plugin.module].title;
    if (plugin.status !== "ready") problems.push({ key: pluginKey, label, status: "blocked", detail: `The plugin is ${plugin.status}. Enable or upgrade it in Settings -> Plugins, then run this again.` });
    else ready.push(plugin);
  }
  return { ready, problems, unreadable: false };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export async function stepSetupSettings(env: RunnerEnv): Promise<StepOutcome> {
  const current = await env.getConfig(SETUP_PLUGIN, env.companyId);
  if (current.saved) return { status: "done", detail: "Setup's settings were already saved.", items: [] };
  await env.saveConfig(SETUP_PLUGIN, env.companyId, { weeklyIssue: true });
  return { status: "done", detail: "Saved. Setup's hourly and weekly jobs now act for this company.", items: [] };
}

export async function stepPluginSettings(env: RunnerEnv): Promise<StepOutcome> {
  const { ready, problems, unreadable } = pluginsToRun(env);
  if (unreadable) return pluginsUnreadable();
  const items: StepItem[] = [...problems];
  const source = env.options.copyFromCompanyId ?? null;
  for (const plugin of ready) {
    const label = MODULES[plugin.module].title;
    try {
      const target = await env.getConfig(plugin.id, env.companyId);
      let desired = target.config;
      const added: string[] = [];
      let pick: string[] = [];
      if (source) {
        const from = await env.getConfig(plugin.id, source);
        if (from.saved) {
          const plan = planCopy({ source: from.config, target: desired, schema: plugin.schema });
          desired = plan.merged;
          added.push(...plan.added.map((entry) => entry.path));
          pick = plan.secretsToPick.map((field) => field.title);
        }
      }
      const defaults = mergeMissing(desired, defaultsFromSchema(plugin.schema));
      desired = defaults.merged;
      added.push(...defaults.added.map((entry) => entry.path));
      if (target.saved && added.length === 0) {
        items.push({ key: plugin.pluginKey, label, status: "done", detail: "Settings were already saved." });
        continue;
      }
      await env.saveConfig(plugin.id, env.companyId, desired);
      const secrets = pick.length ? ` Secrets still to add: ${pick.join(", ")}.` : "";
      items.push({ key: plugin.pluginKey, label, status: "done", detail: `Saved${added.length ? ` (${added.slice(0, 6).map((path) => previewValue(path)).join(", ")}${added.length > 6 ? ", ..." : ""})` : ""}.${secrets}` });
    } catch (error) {
      items.push({ key: plugin.pluginKey, label, status: "failed", detail: message(error) });
    }
  }
  return { ...summarizeItems(items, "plugin"), items };
}

export async function stepSkills(env: RunnerEnv): Promise<StepOutcome> {
  const { ready, problems, unreadable } = pluginsToRun(env);
  if (unreadable) return pluginsUnreadable();
  const items: StepItem[] = [...problems];
  for (const plugin of ready) {
    const action = SKILL_SYNC_ACTIONS[plugin.pluginKey];
    const label = MODULES[plugin.module].title;
    if (!action) continue;
    try {
      await env.runAction(plugin.pluginKey, action, plugin.pluginKey === COCKPIT_KEY ? { team: false } : {});
      items.push({ key: plugin.pluginKey, label, status: "done", detail: "Skills are in the company's library." });
    } catch (error) {
      const text = message(error);
      if (needsSettingsError(text)) items.push({ key: plugin.pluginKey, label, status: "blocked", detail: "Save the plugin's settings first, then run this again." });
      else if (missingHandlerError(text)) items.push({ key: plugin.pluginKey, label, status: "skipped", detail: "This version of the plugin has no skill sync yet. Upgrade it." });
      else items.push({ key: plugin.pluginKey, label, status: "failed", detail: text });
    }
  }
  return { ...summarizeItems(items, "plugin"), items };
}

/**
 * The hiring agent: the one the page chose, else the best match in the company.
 * `unreadable` is true when the agent list could not be read: then `agents` is null and nothing may be concluded
 * from it (an empty company and an unreadable one are different), so callers open no hire task.
 */
export async function hiringFor(env: RunnerEnv): Promise<{ pick: HiringPick; agents: AgentLike[] | null; assigneeAgentId: string | null; unreadable: boolean }> {
  const fetched = await env.fetchAgents();
  if (fetched === null) return { pick: { agent: null, source: null, alternatives: [], problem: AGENT_LIST_UNREADABLE, fix: null }, agents: null, assigneeAgentId: null, unreadable: true };
  const raw = fetched;
  const pick = pickHiringAgent(toHiringCandidates(raw));
  const agents = raw
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
    .filter((row): row is Record<string, unknown> => !!row && typeof row.id === "string")
    .map((row): AgentLike => ({ id: String(row.id), name: String(row.name ?? "Agent"), title: typeof row.title === "string" ? row.title : null, role: typeof row.role === "string" ? row.role : null, status: String(row.status ?? ""), reportsTo: typeof row.reportsTo === "string" ? row.reportsTo : null, urlKey: typeof row.urlKey === "string" ? row.urlKey : null }));
  const chosen = env.options.hiringAgentId && pick.alternatives.concat(pick.agent ? [pick.agent] : []).some((candidate) => candidate.id === env.options.hiringAgentId) ? env.options.hiringAgentId : null;
  return { pick, agents, assigneeAgentId: chosen ?? pick.agent?.id ?? null, unreadable: false };
}

/** Template keys the run opens hire tasks for: the options, else the pack's defaults, limited to templates whose modules are on. */
export function selectedTemplates(options: BootstrapOptions, modules: Record<ModuleKey, boolean>): AgentTemplate[] {
  const pack = loadPack();
  const keys = options.templates ?? pack.templates.filter((template) => template.defaultOn).map((template) => template.key);
  return keys
    .map((key) => templateByKey(key))
    .filter((template): template is AgentTemplate => !!template)
    .filter((template) => template.requires.modules.every((module) => modules[module as ModuleKey] !== false));
}

export async function stepRoles(env: RunnerEnv): Promise<StepOutcome> {
  const list = pluginList(env);
  if (!list) return pluginsUnreadable();
  const roles = teamRolesFor({ modules: env.modules, installed: list }).filter((role) => role.required || env.options.includeOptionalRoles);
  if (roles.length === 0) return { status: "skipped", detail: "No module that needs an agent is switched on.", items: [] };
  const { pick, assigneeAgentId, unreadable } = await hiringFor(env);
  // A role a selected template holds (the Growth Marketing Lead holds Social) is hired by the templates step.
  const heldByTemplate = new Set(selectedTemplates(env.options, env.modules).flatMap((template) => (template.kitRole ? [template.kitRole] : [])));
  const states = await env.loadTeam(roles);
  const items: StepItem[] = [];
  for (const role of roles) {
    if (heldByTemplate.has(role.key)) {
      items.push({ key: role.key, label: role.title, status: "skipped", detail: "Hired with its team template (templates step)." });
      continue;
    }
    const state = states[role.key];
    const health = roleHealth(state);
    if (health === "ok") items.push({ key: role.key, label: role.title, status: "done", detail: `${state?.agent?.name ?? "An agent"} already holds it.` });
    else if (health === "hiring") items.push({ key: role.key, label: role.title, status: "done", detail: "A hire task is already open." });
    else if (health === "attention") items.push({ key: role.key, label: role.title, status: "skipped", detail: `${state?.agent?.name ?? "The agent"} needs attention: open Setup -> Team.` });
    else if (health === "unknown" || health === "loading") items.push({ key: role.key, label: role.title, status: "failed", detail: state?.error ?? "The role could not be checked." });
    else if (unreadable) items.push({ key: role.key, label: role.title, status: "failed", detail: AGENT_LIST_UNREADABLE });
    else if (!assigneeAgentId) items.push({ key: role.key, label: role.title, status: "blocked", detail: pick.problem ?? "Nobody can do the hiring yet." });
    else {
      try {
        const options = await env.hireOptions(role);
        const hire = await env.startRoleHire(role, { title: options.draft.title, description: options.draft.description, assigneeAgentId, assigneeUserId: null });
        items.push({ key: role.key, label: role.title, status: "done", detail: `Opened ${hire?.identifier ? `hire task ${hire.identifier}` : "a hire task"} for ${pick.agent && pick.agent.id === assigneeAgentId ? pick.agent.name : "the hiring agent"}.` });
      } catch (error) {
        items.push({ key: role.key, label: role.title, status: "failed", detail: message(error) });
      }
    }
  }
  const summary = summarizeItems(items, "role");
  return { ...summary, items };
}

export async function stepTemplates(env: RunnerEnv): Promise<StepOutcome> {
  const selected = hireOrder(selectedTemplates(env.options, env.modules));
  if (selected.length === 0) return { status: "skipped", detail: "No template is selected.", items: [] };
  const { pick, agents, assigneeAgentId, unreadable } = await hiringFor(env);
  const list = pluginList(env);
  const items: StepItem[] = [];
  for (const template of selected) {
    const label = template.name;
    // With no agent list "missing" means "unknown": templateStaffing still sees an open hire task, nothing else.
    const staffing = templateStaffing(template, { agents, hires: env.hires });
    // The head agent (a CEO whose title does not say so, like Steve) already does the CEO's job.
    if (staffing.state === "missing" && template.key === "ceo" && pick.agent) {
      items.push({ key: template.key, label, status: "done", detail: `${pick.agent.name} does the CEO's job (${hiringLine(pick)}).` });
      continue;
    }
    if (staffing.state === "staffed") {
      items.push({ key: template.key, label, status: "done", detail: `${staffing.agent?.name ?? "An agent"} already is the ${template.name}.` });
      continue;
    }
    if (staffing.state === "hiring") {
      items.push({ key: template.key, label, status: "done", detail: "A hire task is already open." });
      continue;
    }
    // The LLM Wiki plugin makes the Wiki Maintainer itself when the company wiki is set up (the company-wiki step, next): a hire task now would race it.
    if (template.provisioning === "plugin" && env.modules.memory) {
      if (!list) items.push({ key: template.key, label, status: "failed", detail: PLUGIN_LIST_UNREADABLE });
      else if (list[WIKI_PLUGIN]) items.push({ key: template.key, label, status: "skipped", detail: "The LLM Wiki plugin creates this agent in the Company wiki step, so no hire task is opened." });
      else items.push({ key: template.key, label, status: "blocked", detail: "The LLM Wiki plugin is not installed, so it cannot create this agent." });
      continue;
    }
    if (unreadable) {
      items.push({ key: template.key, label, status: "failed", detail: AGENT_LIST_UNREADABLE });
      continue;
    }
    // The CEO is hired by a person: nobody else can hire before it exists.
    const assignee = template.key === "ceo" && !assigneeAgentId ? { assigneeAgentId: null, assigneeUserId: env.me } : { assigneeAgentId, assigneeUserId: null };
    if (!assignee.assigneeAgentId && !assignee.assigneeUserId) {
      items.push({ key: template.key, label, status: "blocked", detail: template.key === "ceo" ? "Open Setup while signed in as a board member: the CEO's hire task is assigned to you." : "Waits for the CEO: there is no agent that can hire yet." });
      continue;
    }
    try {
      if (template.kitRole) {
        const role = TEAM_ROLES.find((entry) => entry.key === template.kitRole);
        if (!role) throw new Error(`${template.kitRole} is not a team role`);
        const states = await env.loadTeam([role]);
        const health = roleHealth(states[role.key]);
        if (health === "ok" || health === "hiring") {
          items.push({ key: template.key, label, status: "done", detail: health === "ok" ? `${states[role.key]?.agent?.name ?? "An agent"} already holds the ${role.title} role.` : "A hire task for the role is already open." });
          continue;
        }
        const draft = await env.templateDraft(template.key, pick);
        const hire = await env.startRoleHire(role, { title: draft.title, description: draft.description, ...assignee });
        items.push({ key: template.key, label, status: "done", detail: `Opened ${hire?.identifier ? `hire task ${hire.identifier}` : "a hire task"} (it holds the ${role.title} role).` });
        continue;
      }
      const result = await env.startTemplateHire(template.key, assignee, pick);
      if (result.staffed) items.push({ key: template.key, label, status: "done", detail: `${result.staffed} already is the ${template.name}.` });
      else items.push({ key: template.key, label, status: "done", detail: `${result.existed ? "A hire task was already open" : `Opened ${result.identifier ? `hire task ${result.identifier}` : "a hire task"}`}${assignee.assigneeAgentId ? "" : " for you"}${result.woke || result.existed || !assignee.assigneeAgentId ? "" : ". The assignee was not woken: open the task"}.` });
    } catch (error) {
      items.push({ key: template.key, label, status: "failed", detail: message(error) });
    }
  }
  return { ...summarizeItems(items, "template"), items };
}

export async function stepCompanyWiki(env: RunnerEnv): Promise<StepOutcome> {
  if (!env.modules.memory) return { status: "skipped", detail: "The company wiki module is switched off.", items: [] };
  const list = pluginList(env);
  if (!list) return pluginsUnreadable();
  if (!list[WIKI_PLUGIN]) return { status: "skipped", detail: "The LLM Wiki plugin is not installed.", items: [] };
  const lines = await env.setupWiki();
  return { status: "done", detail: lines.length ? lines.join(" ") : "The wiki was already set up.", items: [] };
}

export async function stepStarterPack(env: RunnerEnv): Promise<StepOutcome> {
  if (!env.options.starterPack) return { status: "skipped", detail: "Not selected. The starter pack is off unless you choose it and approve it.", items: [] };
  if (!env.starter.approved) return { status: "needs_owner", detail: "Needs the owner's OK: read the pack in the Memory starter pack card and approve this version.", items: [] };
  if (env.starter.importedAt) return { status: "done", detail: `Already seeded on ${env.starter.importedAt.slice(0, 10)}.`, items: [] };
  const pack = await env.starterPackImport();
  const result = await env.runAction(COCKPIT_KEY, "memory.import", { data: pack.data });
  const body = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const added = typeof body.added === "number" ? body.added : 0;
  const duplicates = typeof body.duplicates === "number" ? body.duplicates : 0;
  const invalid = Array.isArray(body.invalid) ? body.invalid.length : 0;
  return { status: invalid && !added ? "failed" : "done", detail: `Added ${added} fact${added === 1 ? "" : "s"}, ${duplicates} already there${invalid ? `, ${invalid} refused by the Cockpit` : ""}.`, items: [], extra: { starterImport: body } };
}

export async function stepOwnerList(env: RunnerEnv): Promise<StepOutcome> {
  // The list depends on which plugins exist and who can hire: from an unreadable answer it would be wrong either way (empty, or full of things that do not apply).
  const list = pluginList(env);
  if (!list) return pluginsUnreadable();
  const { pick, unreadable } = await hiringFor(env);
  if (unreadable) return { status: "failed", detail: `${AGENT_LIST_UNREADABLE} The list of what only you can do depends on it.`, items: [] };
  const grants = ownerGrants({
    company: env.company,
    modules: env.modules,
    installed: list,
    hiring: pick,
    requireApproval: env.requireApproval,
    statuses: env.statuses,
    starterPackApproved: env.starter.approved,
  });
  return { status: grants.length ? "needs_owner" : "done", detail: grants.length ? `${grants.length} one-time ${grants.length === 1 ? "step" : "steps"} for you.` : "Nothing needs you.", items: [], extra: { grants } };
}

export const CLIENT_STEPS: ReadonlyArray<{ id: StepId; run: (env: RunnerEnv) => Promise<StepOutcome> }> = [
  { id: "setup-settings", run: stepSetupSettings },
  { id: "plugin-settings", run: stepPluginSettings },
  { id: "skills", run: stepSkills },
  { id: "roles", run: stepRoles },
  { id: "templates", run: stepTemplates },
  { id: "company-wiki", run: stepCompanyWiki },
  { id: "starter-pack", run: stepStarterPack },
  { id: "owner-list", run: stepOwnerList },
];

/**
 * Runs the page's steps in order (or just `only`), reporting each to the worker.
 * A step that throws is recorded as failed and the run goes on, so one broken
 * plugin never hides the rest. Returns what each step did.
 */
export async function runClientSteps(env: RunnerEnv, only?: readonly StepId[]): Promise<Array<{ id: StepId; outcome: StepOutcome }>> {
  const results: Array<{ id: StepId; outcome: StepOutcome }> = [];
  for (const step of CLIENT_STEPS) {
    if (only && !only.includes(step.id)) continue;
    let outcome: StepOutcome;
    try {
      outcome = await step.run(env);
    } catch (error) {
      outcome = { status: "failed", detail: message(error), items: [] };
    }
    try {
      await env.record(step.id, outcome.status, outcome.detail, { items: outcome.items, ...(outcome.extra?.grants ? { grants: outcome.extra.grants } : {}), ...(outcome.extra?.starterImport ? { starterImport: outcome.extra.starterImport } : {}) });
    } catch (error) {
      outcome = { ...outcome, detail: `${outcome.detail} (could not be saved: ${message(error)})` };
    }
    results.push({ id: step.id, outcome });
  }
  return results;
}
