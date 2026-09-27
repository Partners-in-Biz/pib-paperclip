/**
 * Setup → Team: pure helpers shared by the page and the worker (no node
 * imports, no React). The roles themselves are the kit's `TEAM_ROLES`.
 *
 * - which roles to show: switched-on modules whose plugin is installed;
 * - each role's state, from `<plugin>.hire-options` (plugin roles) or
 *   `cockpit.load` with `{ team: true }` (Operator, Reviewer);
 * - checklist items about a role (and the Cockpit's `owner` item) link to
 *   Setup → Team, on the page and in the weekly Finish setup issue;
 * - guided mode walks the missing required roles first;
 * - the partial `cockpit.save-team` payloads.
 */
import {
  activeTeamRoles,
  TEAM_INACTIVE_STATUSES,
  TEAM_SETUP_PATH,
  teamRoleForSetupItem,
  teamRoleHealth,
  teamSetupPath,
  type TeamRole,
  type TeamRoleHealth,
  type TeamRoleKey,
} from "@partnersinbiz/pib-plugin-kit/team";
import type { GuideEntry } from "./guide.js";
import { MODULES, type ModuleKey, type SetupItem, type SetupStatus } from "./kit-setup.js";

export type { TeamRole, TeamRoleHealth, TeamRoleKey };
export { TEAM_SETUP_PATH, teamSetupPath };

export const COCKPIT_PLUGIN_KEY: string = MODULES.cockpit.plugins[0];
/** Anchor of the Team section, and of the "Who gets the daily brief" block. */
export const TEAM_ANCHOR = "team";
export const OWNER_ANCHOR = "team-owner";
export const OWNER_SETUP_PATH = `${TEAM_SETUP_PATH}#${OWNER_ANCHOR}`;
export const TEAM_LINK_LABEL = "Open Team";
/** An open hire task older than this offers "Open a new hire task" again (as the plugin pages did). */
export const HIRE_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export type CockpitRoleKind = "operator" | "reviewer";
export type LinkedBy = "auto" | "manual" | "managed" | null;

export interface TeamAgent {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  urlKey: string | null;
}

export interface TeamHire {
  issueId: string;
  identifier: string | null;
  title: string | null;
  /** open | linked | cancelled */
  status: string;
  createdAt: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface TeamRoleState {
  role: TeamRole;
  /** False until the role's plugin answered (or failed). */
  loaded: boolean;
  /** Why the role could not be checked: plugin not running, action failed, not a board user. */
  error: string | null;
  agent: TeamAgent | null;
  linkedBy: LinkedBy;
  /** The latest hire task the plugin opened for the role. */
  hire: TeamHire | null;
  /** New agents that look like an open hire (more than one matched, so none was linked). */
  candidates: TeamAgent[];
  /** Role skills (canonical keys) the agent lacks; null until checked. */
  missingSkills: string[] | null;
  /** Other modules' skills the role also uses (kit `extraSkills`), and whether the agent has each; null until checked. */
  extras?: ExtraSkillState[] | null;
}

/** One of a role's extra skills: never counted as missing; attached when it exists in the company. */
export interface ExtraSkillState {
  key: string;
  slug: string;
  /** The plugin that provides it, when it is a PiB plugin. */
  pluginKey: string | null;
  /** Its plugin is installed for this instance. */
  installed: boolean;
  /** It is in the company's skill library; null when the library could not be read. */
  exists: boolean | null;
  /** The agent has it; null when unknown (no agent, or its skills could not be read). */
  attached: boolean | null;
}

/** `teamRoleHealth`, plus "loading" (not answered yet) and "unknown" (could not check). */
export type TeamRowHealth = TeamRoleHealth | "loading" | "unknown";

export interface HireOptionsLite {
  draft: { title: string; description: string };
  /** Agents the hire task can go to. */
  agents: TeamAgent[];
  defaultAssigneeAgentId: string | null;
}

export interface CockpitRoles {
  operatorAgentId: string | null;
  reviewerAgentId: string | null;
  ownerUserId: string | null;
  reviewOutward: boolean;
}

export interface CockpitRoleView {
  agent: TeamAgent | null;
  hire: TeamHire | null;
  candidates: TeamAgent[];
  linkedBy: LinkedBy;
}

/** What `cockpit.load` says about the team. */
export interface CockpitTeam {
  /** null until the team is saved once. */
  roles: CockpitRoles | null;
  /** Cockpit settings saved for this company (its hourly jobs need them). */
  settingsSaved: boolean;
  views: Partial<Record<CockpitRoleKind, CockpitRoleView>>;
}

export interface BoardUser {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Small parsers (the bodies come from other plugins and the host)
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function list(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  const root = rec(value);
  const inner = root ? (key ? root[key] : undefined) ?? root.data ?? root.items : null;
  return Array.isArray(inner) ? inner : [];
}

/** "pending_approval" → "pending approval". */
export function words(value: string | null | undefined): string {
  return (value ?? "").replace(/[_-]+/g, " ").trim();
}

export function parseTeamAgent(raw: unknown): TeamAgent | null {
  const row = rec(raw);
  const id = str(row?.id);
  if (!row || !id) return null;
  return {
    id,
    name: str(row.name) ?? "Agent",
    title: str(row.title),
    role: str(row.role),
    status: str(row.status) ?? "",
    urlKey: str(row.urlKey),
  };
}

/** `GET /api/companies/:id/agents` (a plain array, or wrapped in `{ data }`). */
export function parseCompanyAgents(body: unknown): TeamAgent[] {
  return list(body).map(parseTeamAgent).filter((agent): agent is TeamAgent => agent !== null);
}

/** `GET /api/companies/:id/user-directory`: `{ users: [{ principalId, user: { id, name, email } }] }`. */
export function parseBoardUsers(body: unknown): BoardUser[] {
  const out: BoardUser[] = [];
  for (const raw of list(body, "users")) {
    const row = rec(raw);
    if (!row) continue;
    const user = rec(row.user) ?? (str(row.id) ? row : null);
    const id = str(user?.id) ?? str(row.principalId);
    if (!id || out.some((existing) => existing.id === id)) continue;
    out.push({ id, name: str(user?.name) ?? str(user?.email) ?? id });
  }
  return out;
}

export function parseHire(raw: unknown): TeamHire | null {
  const row = rec(raw);
  const issueId = str(row?.issueId);
  if (!row || !issueId) return null;
  return {
    issueId,
    identifier: str(row.identifier),
    title: str(row.title),
    status: str(row.status) ?? "open",
    createdAt: str(row.createdAt),
    assigneeAgentId: str(row.assigneeAgentId),
    assigneeUserId: str(row.assigneeUserId),
  };
}

function parseLinkedBy(value: unknown): LinkedBy {
  return value === "auto" || value === "manual" || value === "managed" ? value : null;
}

/** An agent that can still hold a role (not terminated, archived or deleted). */
export function usableAgent(agent: TeamAgent | null | undefined): TeamAgent | null {
  if (!agent) return null;
  return (TEAM_INACTIVE_STATUSES as readonly string[]).includes(agent.status) ? null : agent;
}

function byId(agents: TeamAgent[] | null | undefined): Map<string, TeamAgent> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent]));
}

/** Fill in what the company agent list knows (URL key; the fresher record wins where both have a value). */
function enrich(agent: TeamAgent | null, known: Map<string, TeamAgent>): TeamAgent | null {
  if (!agent) return null;
  const listed = known.get(agent.id);
  return listed ? { ...agent, urlKey: listed.urlKey ?? agent.urlKey, title: agent.title ?? listed.title, role: agent.role ?? listed.role } : agent;
}

// ---------------------------------------------------------------------------
// Roles and their state
// ---------------------------------------------------------------------------

/** The plugin's short name in messages. */
export function pluginName(role: Pick<TeamRole, "module">): string {
  const names: Partial<Record<ModuleKey, string>> = { cockpit: "Cockpit", crm: "CRM", seo: "SEO", social: "Social", accounting: "Accounting", payroll: "Payroll" };
  return names[role.module] ?? MODULES[role.module]?.title ?? "plugin";
}

/** The PiB plugin behind a canonical skill key (`plugin/partnersinbiz-billing/invoice-draft` → `partnersinbiz.billing`). */
export function skillPluginKey(key: string): string | null {
  const slug = key.split("/")[1] ?? "";
  for (const module of Object.values(MODULES)) {
    for (const plugin of module.plugins as readonly string[]) if (plugin.replace(/[^a-z0-9]+/g, "-") === slug) return plugin;
  }
  return null;
}

/**
 * A role's extra skills with their state: installed when the module's plugin
 * is (unknown installs count as installed), existing when the company's
 * skill library has it (null = library not read), attached when the agent's
 * skills (null = not known) include it.
 */
export function extraSkillStates(
  role: Pick<TeamRole, "extraSkills">,
  installed: Record<string, unknown> | null | undefined,
  agentSkills: string[] | null,
  library: ReadonlySet<string> | null = null,
): ExtraSkillState[] {
  return (role.extraSkills ?? []).map((key) => {
    const pluginKey = skillPluginKey(key);
    return {
      key,
      slug: skillSlug(key),
      pluginKey,
      installed: !installed || (pluginKey ? !!installed[pluginKey] : false),
      exists: library ? library.has(key) : null,
      attached: agentSkills ? agentSkills.includes(key) : null,
    };
  });
}

/**
 * Extra skills the agent should get now: they exist in the company and it
 * does not have them. An unread library attaches nothing (never guess).
 */
export function extrasToAttach(extras: ExtraSkillState[] | null | undefined): string[] {
  return (extras ?? []).filter((extra) => extra.installed && extra.exists === true && extra.attached === false).map((extra) => extra.key);
}

/**
 * Roles for the company's switched-on modules, skipping a role whose plugin is
 * not installed. `installed` null (unknown) keeps every switched-on role.
 */
export function teamRolesFor(input: { modules: Partial<Record<ModuleKey, boolean>> | null | undefined; installed: Record<string, unknown> | null | undefined }): TeamRole[] {
  return activeTeamRoles(input.modules).filter((role) => !input.installed || !!input.installed[role.pluginKey]);
}

/** Why a role's plugin cannot answer (installed but not running), or null. */
export function pluginProblem(role: TeamRole, installed: Record<string, { status?: string | null }> | null | undefined): string | null {
  const record = installed?.[role.pluginKey];
  if (!record) return null;
  const status = record.status ?? "unknown";
  if (status === "ready") return null;
  return `The ${pluginName(role)} plugin is ${words(status) || "not running"}. Enable or upgrade it in Settings → Plugins, then check again.`;
}

export function emptyRoleState(role: TeamRole, patch: Partial<TeamRoleState> = {}): TeamRoleState {
  return { role, loaded: false, error: null, agent: null, linkedBy: null, hire: null, candidates: [], missingSkills: null, extras: null, ...patch };
}

export function failedRoleState(role: TeamRole, error: string): TeamRoleState {
  return emptyRoleState(role, { loaded: true, error });
}

/** True when the plugin is older than its Setup → Team actions (the host has no handler for the action). */
export function missingActionError(message: string): boolean {
  return /no action handler|action handler registered|not registered|unknown action|action not found/i.test(message);
}

/** What to say when a role's plugin cannot do a Team action yet. */
export function roleNotReady(role: TeamRole): string {
  return `The ${pluginName(role)} plugin cannot staff the ${role.title} yet. Upgrade the ${pluginName(role)} plugin in Settings → Plugins, then check again.`;
}

/** A readable reason when a role's plugin action failed. */
export function roleLoadError(role: TeamRole, message: string): string {
  if (/board users?|board user can|only a board/i.test(message)) return `Only a signed-in board member can staff the ${role.title}.`;
  if (missingActionError(message)) return roleNotReady(role);
  return `Could not check the ${role.title}: ${message}`;
}

/** `<plugin>.hire-options` → `{ draft, agents, defaultAssigneeAgentId }` (Cockpit roles get the same from `cockpit.hire-options`). */
export function parseHireOptions(body: unknown): HireOptionsLite | null {
  const root = rec(body);
  const draft = rec(root?.draft);
  if (!root || !draft) return null;
  return {
    draft: { title: str(draft.title) ?? "", description: typeof draft.description === "string" ? draft.description : "" },
    agents: parseCompanyAgents(root.agents).filter((agent) => usableAgent(agent) !== null),
    defaultAssigneeAgentId: str(root.defaultAssigneeAgentId),
  };
}

/**
 * A plugin role's state from its `hire-options` answer:
 * `{ draft, agents, defaultAssigneeAgentId, status: { agent, linkedBy, hire, candidates } }`.
 * `agents` is the company agent list (for URL keys), when it loaded.
 */
export function roleStateFromHireOptions(role: TeamRole, body: unknown, agents: TeamAgent[] | null = null): TeamRoleState {
  const status = rec(rec(body)?.status);
  if (!status) return failedRoleState(role, `The ${pluginName(role)} plugin did not say who the ${role.title} is. Upgrade it, then check again.`);
  const known = byId(agents);
  return emptyRoleState(role, {
    loaded: true,
    agent: usableAgent(enrich(parseTeamAgent(status.agent), known)),
    linkedBy: parseLinkedBy(status.linkedBy),
    hire: parseHire(status.hire),
    candidates: list(status.candidates).map(parseTeamAgent).filter((agent): agent is TeamAgent => !!usableAgent(agent)).map((agent) => enrich(agent, known)!),
  });
}

/** `cockpit.load` (with `{ team: true }`) → roles, settings saved, and the Operator and Reviewer views. */
export function parseCockpitTeam(body: unknown): CockpitTeam | null {
  const root = rec(body);
  if (!root) return null;
  const roles = rec(root.roles);
  const team = rec(root.team);
  const views: CockpitTeam["views"] = {};
  for (const kind of ["operator", "reviewer"] as const) {
    const view = rec(team?.[kind]);
    if (!view) continue;
    views[kind] = {
      agent: parseTeamAgent(view.agent),
      hire: parseHire(view.hire),
      candidates: list(view.candidates).map(parseTeamAgent).filter((agent): agent is TeamAgent => agent !== null),
      linkedBy: parseLinkedBy(view.linkedBy),
    };
  }
  return {
    roles: roles
      ? {
        operatorAgentId: str(roles.operatorAgentId),
        reviewerAgentId: str(roles.reviewerAgentId),
        ownerUserId: str(roles.ownerUserId),
        reviewOutward: roles.reviewOutward === true,
      }
      : null,
    settingsSaved: root.settingsSaved === true,
    views,
  };
}

/**
 * The Operator's or Reviewer's state. The saved role (what the Cockpit acts
 * on) comes first, then the agent its hire linked.
 */
export function roleStateFromCockpit(role: TeamRole, cockpit: CockpitTeam, agents: TeamAgent[] | null = null): TeamRoleState {
  const kind = role.cockpitRole;
  if (!kind) return failedRoleState(role, `${role.title} is not a Cockpit role.`);
  const view = cockpit.views[kind] ?? null;
  const known = byId(agents);
  const savedId = kind === "operator" ? cockpit.roles?.operatorAgentId ?? null : cockpit.roles?.reviewerAgentId ?? null;
  let agent: TeamAgent | null = null;
  if (savedId) agent = usableAgent(enrich(known.get(savedId) ?? (view?.agent?.id === savedId ? view.agent : null), known));
  if (!agent) agent = usableAgent(enrich(view?.agent ?? null, known));
  return emptyRoleState(role, {
    loaded: true,
    agent,
    linkedBy: view?.agent && agent && view.agent.id === agent.id ? view.linkedBy : null,
    hire: view?.hire ?? null,
    candidates: (view?.candidates ?? []).filter((candidate) => usableAgent(candidate) !== null).map((candidate) => enrich(candidate, known)!),
  });
}

export function roleHealth(state: TeamRoleState | null | undefined): TeamRowHealth {
  if (!state || !state.loaded) return "loading";
  if (state.error) return "unknown";
  return teamRoleHealth({ agentStatus: state.agent?.status ?? null, hireOpen: state.hire?.status === "open", missingSkills: state.missingSkills?.length ?? 0 });
}

/** A role row that needs a person: a missing required role, an agent that needs attention, or a role that could not be checked. */
export function needsYou(role: Pick<TeamRole, "required">, health: TeamRowHealth): boolean {
  return (health === "missing" && role.required) || health === "attention" || health === "unknown";
}

/** Header counts for the Team section. */
export function teamSummary(states: Array<TeamRoleState | undefined>): { total: number; needYou: number; hiring: number; ok: number; loading: boolean } {
  const out = { total: states.length, needYou: 0, hiring: 0, ok: 0, loading: false };
  for (const state of states) {
    const health = roleHealth(state);
    if (health === "loading") out.loading = true;
    else if (health === "hiring") out.hiring += 1;
    else if (health === "ok") out.ok += 1;
    else if (state && needsYou(state.role, health)) out.needYou += 1;
  }
  return out;
}

/** Rows that need something open up; ok rows (and optional roles nobody hired) stay one line. */
export function rowOpenByDefault(role: Pick<TeamRole, "required">, health: TeamRowHealth): boolean {
  if (health === "missing") return role.required;
  return health === "hiring" || health === "attention" || health === "unknown";
}

export function hireStale(hire: TeamHire | null | undefined, now: number = Date.now()): boolean {
  if (!hire || hire.status !== "open" || !hire.createdAt) return false;
  const created = Date.parse(hire.createdAt);
  return Number.isFinite(created) && now - created > HIRE_STALE_DAYS * DAY_MS;
}

/** "SEO Specialist" / "General": what to show after an agent's name, if it adds anything. */
export function agentDetail(agent: Pick<TeamAgent, "name" | "title" | "role">): string | null {
  if (agent.title && agent.title !== agent.name) return agent.title;
  return agent.role ? words(agent.role).replace(/^./, (c) => c.toUpperCase()) : null;
}

/** Host paths for the agent and the hire task (no company prefix). */
export function agentPath(agent: Pick<TeamAgent, "id" | "urlKey">): string {
  return `/agents/${agent.urlKey ?? agent.id}`;
}

export function hirePath(hire: Pick<TeamHire, "issueId" | "identifier">): string {
  return `/issues/${hire.identifier ?? hire.issueId}`;
}

/** The `pib-` slug the host lists for a canonical skill key (`plugin/partnersinbiz-seo/seo-sprint` → `pib-seo-sprint`). Matching only: people see `skillLabel`. */
export function skillSlug(key: string): string {
  const last = key.split("/").pop() || key;
  return last.startsWith("pib-") ? last : `pib-${last}`;
}

/** What each role skill is for, in plain words (by its last key segment). */
const SKILL_PURPOSE: Record<string, string> = {
  "company-os": "company operating manual",
  operator: "daily operations",
  reviewer: "reviewing work",
  "crm-records": "client records",
  "crm-outbound": "outreach",
  "seo-sprint": "SEO sprints",
  "social-publish": "publishing",
  "social-content": "writing posts",
  bookkeeping: "bookkeeping",
  payroll: "payroll",
  "invoice-draft": "invoice drafting",
  campaigns: "email campaigns",
  "mailbox-draft": "email drafting",
  "partner-share": "partner sharing",
};

const MODULE_SHORT: Partial<Record<ModuleKey, string>> = { cockpit: "Cockpit", memory: "Company wiki", mailbox: "Mailbox", social: "Social", campaigns: "Campaigns" };

/** Paperclip's own core skill (issues, comments, the API). */
const PAPERCLIP_CORE_SKILL = "paperclipai/paperclip/paperclip";

/**
 * A skill as people read it: "Billing: invoice drafting" (with its module) or
 * "invoice drafting". Never the plugin id or the `pib-` slug.
 */
export function skillLabel(key: string, withModule = true): string {
  if (key === PAPERCLIP_CORE_SKILL) return withModule ? "Paperclip: issues and comments" : "Paperclip basics";
  const last = (key.split("/").pop() || key).replace(/^pib-/, "");
  const purpose = SKILL_PURPOSE[last] ?? words(last);
  if (!withModule) return purpose;
  const plugin = skillPluginKey(key);
  const module = plugin ? (Object.keys(MODULES) as ModuleKey[]).find((m) => (MODULES[m].plugins as readonly string[]).includes(plugin)) ?? null : null;
  if (!module) return purpose.charAt(0).toUpperCase() + purpose.slice(1);
  return `${MODULE_SHORT[module] ?? MODULES[module].title}: ${purpose}`;
}

/** "the client records skill" / "the client records, outreach and company operating manual skills". */
export function skillNames(keys: string[]): string {
  const names = keys.map((key) => skillLabel(key, false));
  if (names.length <= 1) return `the ${names[0] ?? "role"} skill`;
  return `the ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} skills`;
}

/** What is wrong with a linked agent, one line each (attention health). */
export function attentionLines(state: TeamRoleState): string[] {
  const agent = state.agent;
  if (!agent) return [];
  const lines: string[] = [];
  if (agent.status === "pending_approval") lines.push("Waiting for approval. Approve the hire in Approvals, then resume the agent once its adapter has a working model key.");
  else if (agent.status === "paused") lines.push(`Paused, so it picks up no ${state.role.title} work. Open the agent, check its adapter has a working model key, then click Resume.`);
  else if (agent.status === "error") lines.push("In error. Open the agent to see what failed, fix it, then resume it.");
  if (state.missingSkills?.length) lines.push(`Missing ${skillNames(state.missingSkills)}, so it does not know the ${state.role.title} procedure.`);
  return lines;
}

/**
 * Drops a worker's "attach the skill by hand" lines once the page attached
 * the role's skills itself (same rule as the plugin pages).
 */
export function dropSkillAsks(lines: string[], skillKeys: string[]): string[] {
  const slugs = skillKeys.map(skillSlug);
  return lines.filter((line) => !(slugs.some((slug) => line.includes(slug)) && /\battach\b|does not have| has the /i.test(line)));
}

/** Steps and next steps from a link, re-sync or save answer (each plugin words it a little differently). */
export function actionSummary(body: unknown): { steps: string[]; instructions: string[] } {
  const root = rec(body);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((line): line is string => typeof line === "string" && line.trim() !== "") : []);
  let steps = strings(root?.steps);
  if (steps.length === 0 && str(root?.message)) steps = [root!.message as string];
  if (steps.length === 0 && Array.isArray(root?.results)) {
    const results = (root!.results as unknown[]).map(rec).filter((row): row is Record<string, unknown> => row !== null);
    const failed = results.filter((row) => row.action === "failed");
    steps = failed.length
      ? failed.map((row) => `The ${skillLabel(String(row.skillKey ?? "skill"), false)} skill did not sync${str(row.error) ? ` (${row.error})` : ""}.`)
      : ["Synced the role's skills."];
  }
  return { steps, instructions: strings(root?.instructions) };
}

// ---------------------------------------------------------------------------
// Checklist items point at Setup → Team
// ---------------------------------------------------------------------------

/** Where a checklist item is fixed in Setup → Team, or null when it is not about the team. */
export function teamItemPath(pluginKey: string, itemKey: string): string | null {
  const role = teamRoleForSetupItem(pluginKey, itemKey);
  if (role) return teamSetupPath(role.key);
  if (pluginKey === COCKPIT_PLUGIN_KEY && itemKey === "owner") return OWNER_SETUP_PATH;
  return null;
}

export function isTeamPath(href: string | null | undefined): boolean {
  return !!href && (href === TEAM_SETUP_PATH || href.startsWith(`${TEAM_SETUP_PATH}#`) || href.startsWith(`${TEAM_SETUP_PATH}&`));
}

function teamSteps(role: TeamRole | null): string[] {
  if (!role) return ["Open Setup → Team.", "Under \"Who gets the daily brief\", pick the person the Operator reports to."];
  return [
    "Open Setup → Team.",
    `Click Hire to open a prefilled hire task for whoever hires for this company (usually the CEO), or Pick existing to use an agent you already have.`,
    `Once the ${role.title} exists, approve it if asked and resume it when its adapter has a working model key.`,
  ];
}

/**
 * A role's checklist item (or the Cockpit's owner item) pointed at Setup →
 * Team. Its own "Open a hire task" action is dropped: from the checklist it
 * would open an unassigned task, while the Team row's Hire asks who hires.
 */
export function withTeamLink(pluginKey: string, item: SetupItem): SetupItem {
  const path = teamItemPath(pluginKey, item.key);
  if (!path) return item;
  const role = teamRoleForSetupItem(pluginKey, item.key);
  const hireAction = !!role && !!item.action && item.action.plugin === role.pluginKey && item.action.key === role.actions.start;
  return {
    ...item,
    href: path,
    hrefLabel: TEAM_LINK_LABEL,
    action: hireAction ? null : item.action ?? null,
    steps: item.status === "done" ? item.steps : teamSteps(role),
  };
}

/** Every team item of a status pointed at Setup → Team (idempotent). */
export function withTeamLinks(status: SetupStatus, pluginKey: string = status.plugin): SetupStatus {
  const items = status.items ?? [];
  if (!items.some((item) => teamItemPath(pluginKey, item.key))) return status;
  return { ...status, items: items.map((item) => withTeamLink(pluginKey, item)) };
}

// ---------------------------------------------------------------------------
// Guided mode: the team first
// ---------------------------------------------------------------------------

export type GuidedStep =
  | { kind: "team"; id: string; state: TeamRoleState }
  | { kind: "owner"; id: string }
  | { kind: "item"; id: string; entry: GuideEntry };

export function teamStepId(role: TeamRoleKey | "owner"): string {
  return `team:${role}`;
}

/**
 * Guided setup order: missing required roles (Team order), then who gets the
 * daily brief, then the checklist. A checklist item about a role the Team
 * section already settles (missing: its own step; hiring: waiting on the
 * hirer; ok) is left out, so nothing is asked twice. One about a role whose
 * agent needs attention, or that could not be checked, stays: its link goes
 * to the Team row with the fixes.
 */
export function guidedSteps(input: {
  team: TeamRoleState[];
  /** The owner step: shown when the Cockpit has no owner and someone can be picked. */
  ownerNeeded?: boolean;
  items: GuideEntry[];
  skipped?: ReadonlySet<string>;
}): GuidedStep[] {
  const skipped = input.skipped ?? new Set<string>();
  const steps: GuidedStep[] = [];
  const covered = new Set<string>();
  for (const state of input.team) {
    const health = roleHealth(state);
    if (health !== "missing" && health !== "hiring" && health !== "ok") continue;
    covered.add(state.role.key);
    const id = teamStepId(state.role.key);
    if (state.role.required && health === "missing" && !skipped.has(id)) steps.push({ kind: "team", id, state });
  }
  const ownerId = teamStepId("owner");
  if (input.ownerNeeded && !skipped.has(ownerId)) steps.push({ kind: "owner", id: ownerId });
  for (const entry of input.items) {
    const role = teamRoleForSetupItem(entry.pluginKey, entry.item.key);
    if (role && covered.has(role.key)) continue;
    // The owner step covers the Cockpit's "owner" item (skipping one skips both).
    if (input.ownerNeeded && entry.pluginKey === COCKPIT_PLUGIN_KEY && entry.item.key === "owner") continue;
    steps.push({ kind: "item", id: entry.id, entry });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Who gets the daily brief
// ---------------------------------------------------------------------------

/** The trusted local board placeholder: not a person the Cockpit can report to or assign. */
export const LOCAL_BOARD_USER_ID = "local-board";

export function assignableUser(userId: string | null | undefined): string | null {
  return userId && userId !== LOCAL_BOARD_USER_ID ? userId : null;
}

/** People the daily brief can go to: the board members, the viewer, and the saved owner even if they left. */
export function ownerChoices(input: { users: BoardUser[] | null; me: string | null; ownerUserId: string | null }): Array<BoardUser & { me: boolean }> {
  const me = assignableUser(input.me);
  const out: Array<BoardUser & { me: boolean }> = [];
  for (const user of input.users ?? []) {
    if (!assignableUser(user.id) || out.some((existing) => existing.id === user.id)) continue;
    out.push({ ...user, me: user.id === me });
  }
  if (me && !out.some((user) => user.id === me)) out.unshift({ id: me, name: "Me", me: true });
  const owner = assignableUser(input.ownerUserId);
  if (owner && !out.some((user) => user.id === owner)) out.push({ id: owner, name: "Someone no longer in this company", me: false });
  return out;
}

export function ownerLabel(choice: BoardUser & { me: boolean }): string {
  return choice.me && choice.name !== "Me" ? `${choice.name} (me)` : choice.name;
}

// ---------------------------------------------------------------------------
// `cockpit.save-team` payloads (partial: only what changes)
// ---------------------------------------------------------------------------

export type CockpitTeamPatch = Partial<{ operatorAgentId: string | null; reviewerAgentId: string | null; ownerUserId: string | null; reviewOutward: boolean }>;

/** Set or clear (null) the Operator or Reviewer. */
export function cockpitRolePatch(kind: CockpitRoleKind, agentId: string | null | undefined): CockpitTeamPatch {
  const id = agentId?.trim() || null;
  return kind === "operator" ? { operatorAgentId: id } : { reviewerAgentId: id };
}

/** Who gets the daily brief ("" or null clears it). */
export function ownerPatch(userId: string | null | undefined): CockpitTeamPatch {
  return { ownerUserId: userId?.trim() || null };
}

export function reviewPatch(reviewOutward: boolean): CockpitTeamPatch {
  return { reviewOutward: reviewOutward === true };
}

export interface PickChoice {
  agent: TeamAgent;
  /** Looks like the agent an open hire asked for. */
  candidate: boolean;
  /** Holds this role now. */
  current: boolean;
  /** Other Team roles the agent holds. */
  holds: string[];
  /** Why it cannot take this role (the Operator and the Reviewer must differ). */
  blocked: string | null;
}

/** The agents a person can pick for a role: hire candidates first, then everyone else by name. */
export function pickChoices(input: { role: TeamRole; agents: TeamAgent[] | null; states: Partial<Record<TeamRoleKey, TeamRoleState>> }): PickChoice[] {
  const state = input.states[input.role.key];
  const candidates = state?.candidates ?? [];
  const pool = new Map<string, TeamAgent>();
  for (const agent of [...candidates, ...(input.agents ?? [])]) if (usableAgent(agent) && !pool.has(agent.id)) pool.set(agent.id, agent);
  const kind = input.role.cockpitRole;
  const choices = [...pool.values()].map((agent): PickChoice => ({
    agent,
    candidate: candidates.some((c) => c.id === agent.id),
    current: state?.agent?.id === agent.id,
    holds: Object.values(input.states)
      .filter((other): other is TeamRoleState => !!other && other.role.key !== input.role.key && other.agent?.id === agent.id)
      .map((other) => other.role.title),
    blocked: kind
      ? cockpitConflict({ kind, agentId: agent.id, operator: input.states.operator?.agent ?? null, reviewer: input.states.reviewer?.agent ?? null })
      : null,
  }));
  return choices.sort((a, b) => Number(b.candidate) - Number(a.candidate) || a.agent.name.localeCompare(b.agent.name));
}

export function pickLabel(choice: PickChoice): string {
  const detail = agentDetail(choice.agent);
  const shown = detail && !choice.holds.includes(detail) ? detail : null;
  const status = ["paused", "error", "pending_approval"].includes(choice.agent.status) ? ` (${words(choice.agent.status)})` : "";
  const now = choice.current ? " (now)" : "";
  const holds = choice.holds.length ? ` · already ${choice.holds.join(", ")}` : "";
  return `${choice.agent.name}${shown ? ` · ${shown}` : ""}${status}${now}${holds}`;
}

/** The Operator and the Reviewer must be different agents: the reason a pick is refused, or null. */
export function cockpitConflict(input: { kind: CockpitRoleKind; agentId: string | null; operator: TeamAgent | null; reviewer: TeamAgent | null }): string | null {
  if (!input.agentId) return null;
  const other = input.kind === "operator" ? input.reviewer : input.operator;
  if (!other || other.id !== input.agentId) return null;
  return `${other.name} is already the ${input.kind === "operator" ? "Reviewer" : "Operator"}. The Operator and the Reviewer must be different agents.`;
}

// ---------------------------------------------------------------------------
// Address: `?section=team#team-<role>`
// ---------------------------------------------------------------------------

export type SetupSection = "team" | "modules" | "checklist";

/** Which section the address asks for, and the element to scroll to. */
export function setupFocus(search: string | null | undefined, hash: string | null | undefined): { section: SetupSection | null; anchor: string | null } {
  const value = new URLSearchParams(search ?? "").get("section");
  const section = value === "team" || value === "modules" || value === "checklist" ? value : null;
  const raw = (hash ?? "").replace(/^#/, "");
  let anchor: string | null = null;
  try {
    anchor = raw ? decodeURIComponent(raw) : null;
  } catch {
    anchor = raw || null;
  }
  if (anchor && anchor !== TEAM_ANCHOR && !anchor.startsWith("team-")) anchor = null;
  if (!anchor && section === "team") anchor = TEAM_ANCHOR;
  return { section: section ?? (anchor ? "team" : null), anchor };
}

/** The role a `#team-<role>` anchor names, if any. */
export function anchorRole(anchor: string | null | undefined): string | null {
  return anchor && anchor.startsWith("team-") && anchor !== OWNER_ANCHOR ? anchor.slice("team-".length) : null;
}
