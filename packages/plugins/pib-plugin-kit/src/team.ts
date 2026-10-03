/**
 * The company's PiB team: every agent role a PiB module recommends, in one
 * registry (browser-safe, no node imports; import via
 * `@partnersinbiz/pib-plugin-kit/team`).
 *
 * Roles are staffed in one place, Setup → Team: hire (a prefilled hire task),
 * pick an existing agent, change or remove it. The Cockpit runs the company
 * (no Team tab) and each plugin page shows its agent box only when something
 * is wrong, with a link back to Setup → Team.
 *
 * The actions are the ones each plugin already registers:
 * - plugin roles: `<plugin>.hire-options` → `{ draft, agents, defaultAssigneeAgentId, status }`,
 *   `<plugin>.start-hire` `{ title, description, assigneeAgentId | assigneeUserId }`,
 *   `<plugin>.link-agent` `{ agentId }`, `<plugin>.unlink-agent`, and an optional re-sync;
 * - Cockpit roles (Operator, Reviewer): `cockpit.hire-options` / `cockpit.start-hire`
 *   with `{ role }`, and `cockpit.save-team` with a partial
 *   `{ operatorAgentId, reviewerAgentId, ownerUserId, reviewOutward }`; their
 *   current agents come from `cockpit.load` (`team`, `roles`).
 */
import { PIB_PLUGINS } from "./contracts.js";
import { RUN_PROFILES, type RunProfile } from "./run-profile.js";
import type { ModuleKey } from "./setup.js";

export type TeamRoleKey =
  | "operator"
  | "reviewer"
  | "account-manager"
  | "sales-lead"
  | "inbound-qualifier"
  | "crm-data-steward"
  | "deal-desk"
  | "seo-specialist"
  | "social"
  | "bookkeeper"
  | "payroll-clerk";

export interface TeamRoleActions {
  /** Sent with every action call, e.g. `{ role: "sales-lead" }` when one plugin staffs several roles. */
  params?: Record<string, string>;
  options: string;
  start: string;
  /** Plugin roles only; Cockpit roles save through `cockpit.save-team`. */
  link?: string;
  unlink?: string;
  /** Wires the linked agent again (tools, routines, skills). */
  resync?: string;
}

export interface TeamRole {
  key: TeamRoleKey;
  pluginKey: string;
  /** The Setup module that turns this role on or off. */
  module: ModuleKey;
  title: string;
  /** One line: what the agent does for the company. */
  summary: string;
  /** Recommended for every company that uses the module (false = optional). */
  required: boolean;
  /** While this role has no running agent, its work goes to this role (and on down its chain). */
  coveredBy?: TeamRoleKey;
  /** The item key for this role in the plugin's setup checklist. */
  setupItemKey: string;
  /** Cockpit roles are saved with `cockpit.save-team`. */
  cockpitRole?: "operator" | "reviewer";
  /** Canonical keys of the skills the agent must have (always ends with the company operating manual). */
  skills: string[];
  /** Other modules' skills the agent also uses when those modules are installed; never counted as missing. */
  extraSkills?: string[];
  actions: TeamRoleActions;
  /** The plugin page (no company prefix). */
  pagePath: string;
  /** Model, effort, timeout, turn cap and concurrency the hire task asks for (kit `RUN_PROFILES`). */
  runProfile: RunProfile;
}

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function teamSkillKey(pluginKey: string, skillKey: string): string {
  const slug = pluginKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

/** Paperclip's own core skill (how to use issues, comments and the API); the Operator and Reviewer lean on it. */
export const PAPERCLIP_CORE_SKILL_KEY = "paperclipai/paperclip/paperclip";

/** The company operating manual (Cockpit managed skill) every PiB role carries. */
export const COMPANY_OS_SKILL_KEY = teamSkillKey(PIB_PLUGINS.cockpit, "company-os");

const withOs = (...keys: string[]): string[] => [...keys, COMPANY_OS_SKILL_KEY];

const pluginActions = (prefix: string, resync?: string, params?: Record<string, string>): TeamRoleActions => ({
  ...(params ? { params } : {}),
  options: `${prefix}.hire-options`,
  start: `${prefix}.start-hire`,
  link: `${prefix}.link-agent`,
  unlink: `${prefix}.unlink-agent`,
  ...(resync ? { resync } : {}),
});

const crmSkill = (key: string) => teamSkillKey(PIB_PLUGINS.crm, key);

/** A CRM sales role: optional, and covered by the Account Manager while unstaffed. */
function salesRole(key: TeamRoleKey, title: string, summary: string, skill: string, extraSkills: string[] = []): TeamRole {
  return {
    key,
    pluginKey: PIB_PLUGINS.crm,
    module: "crm",
    title,
    summary,
    required: false,
    coveredBy: "account-manager",
    setupItemKey: key,
    skills: withOs(crmSkill("crm-records"), crmSkill(skill)),
    ...(extraSkills.length ? { extraSkills } : {}),
    actions: pluginActions("crm", "crm.resync-agent", { role: key }),
    pagePath: "/crm",
    runProfile: RUN_PROFILES[key],
  };
}

export const TEAM_ROLES: TeamRole[] = [
  {
    key: "operator",
    pluginKey: PIB_PLUGINS.cockpit,
    module: "cockpit",
    title: "Operator",
    summary: "Chief of staff: reviews every module each morning, keeps agents unblocked and sends you one daily brief.",
    required: true,
    setupItemKey: "operator_agent",
    cockpitRole: "operator",
    skills: withOs(teamSkillKey(PIB_PLUGINS.cockpit, "operator")),
    extraSkills: [PAPERCLIP_CORE_SKILL_KEY],
    actions: { options: "cockpit.hire-options", start: "cockpit.start-hire" },
    pagePath: "/cockpit",
    runProfile: RUN_PROFILES["operator"],
  },
  {
    key: "reviewer",
    pluginKey: PIB_PLUGINS.cockpit,
    module: "cockpit",
    title: "Reviewer",
    summary: "Checks posts, campaign emails, invoice and quote emails and SEO pull requests before you approve them.",
    required: false,
    setupItemKey: "reviewer_agent",
    cockpitRole: "reviewer",
    skills: withOs(teamSkillKey(PIB_PLUGINS.cockpit, "reviewer")),
    extraSkills: [PAPERCLIP_CORE_SKILL_KEY],
    actions: { options: "cockpit.hire-options", start: "cockpit.start-hire" },
    pagePath: "/cockpit",
    runProfile: RUN_PROFILES["reviewer"],
  },
  {
    key: "account-manager",
    pluginKey: PIB_PLUGINS.crm,
    module: "crm",
    title: "Account Manager",
    summary: "Looks after clients once they buy: onboarding, invoices, monthly reports, sequences and campaigns. Covers any sales role with no agent. Not social media: that is the Social agent's job.",
    required: true,
    setupItemKey: "agent",
    skills: withOs(crmSkill("crm-records"), crmSkill("crm-outbound")),
    extraSkills: [
      teamSkillKey(PIB_PLUGINS.billing, "invoice-draft"),
      teamSkillKey(PIB_PLUGINS.campaigns, "campaigns"),
      teamSkillKey(PIB_PLUGINS.mailbox, "mailbox-draft"),
      teamSkillKey(PIB_PLUGINS.partners, "partner-share"),
    ],
    actions: pluginActions("crm", "crm.resync-agent"),
    pagePath: "/crm",
    runProfile: RUN_PROFILES["account-manager"],
  },
  salesRole(
    "sales-lead",
    "Sales Lead",
    "Runs the pipeline: every open deal has an owner, a next step and a date; chases stale deals and sends you a weekly pipeline summary.",
    "sales-lead",
  ),
  salesRole(
    "inbound-qualifier",
    "Inbound Qualifier",
    "Answers new leads fast, qualifies them (need, budget, timeline, decision maker) and books the call or hands them on.",
    "inbound-qualify",
    [crmSkill("crm-outbound"), teamSkillKey(PIB_PLUGINS.mailbox, "mailbox-draft")],
  ),
  salesRole(
    "crm-data-steward",
    "CRM Data Steward",
    "Keeps the CRM clean: one record per person and company, merges exact duplicates, and asks you about likely ones.",
    "data-steward",
  ),
  salesRole(
    "deal-desk",
    "Deal Desk",
    "Writes proposals and quotes within your pricing guardrails and answers quote replies; anything outside them comes to you.",
    "deal-desk",
    [teamSkillKey(PIB_PLUGINS.billing, "invoice-draft")],
  ),
  {
    key: "seo-specialist",
    pluginKey: PIB_PLUGINS.seo,
    module: "seo",
    title: "SEO Specialist",
    summary: "Works the 90-day SEO sprints: site checks, content, backlinks and changes through the site repo or, on WordPress, the PiB Connector.",
    required: true,
    setupItemKey: "agent",
    skills: withOs(teamSkillKey(PIB_PLUGINS.seo, "seo-sprint")),
    extraSkills: [teamSkillKey(PIB_PLUGINS.crm, "wp-sites")],
    actions: pluginActions("seo", "seo.activate-agent"),
    pagePath: "/seo",
    runProfile: RUN_PROFILES["seo-specialist"],
  },
  {
    key: "social",
    pluginKey: PIB_PLUGINS.social,
    module: "social",
    title: "Social agent",
    summary: "Does the social work itself: plans, drafts, schedules and publishes approved posts, answers the social inbox and runs the Growth Lab. Carries out every social task and hand-off; never declines one.",
    required: true,
    setupItemKey: "agent",
    skills: withOs(teamSkillKey(PIB_PLUGINS.social, "social-publish"), teamSkillKey(PIB_PLUGINS.social, "social-content")),
    actions: pluginActions("social", "social.activate-agent"),
    pagePath: "/social",
    runProfile: RUN_PROFILES["social"],
  },
  {
    key: "bookkeeper",
    pluginKey: PIB_PLUGINS.accounting,
    module: "accounting",
    title: "Bookkeeper",
    summary: "Keeps the books: bank matching, journals, VAT and month-end checks.",
    required: true,
    setupItemKey: "bookkeeper",
    skills: withOs(teamSkillKey(PIB_PLUGINS.accounting, "bookkeeping")),
    extraSkills: [teamSkillKey(PIB_PLUGINS.billing, "invoice-draft")],
    actions: pluginActions("accounting", "accounting.resync-agent"),
    pagePath: "/accounting",
    runProfile: RUN_PROFILES["bookkeeper"],
  },
  {
    key: "payroll-clerk",
    pluginKey: PIB_PLUGINS.payroll,
    module: "payroll",
    title: "Payroll Clerk",
    summary: "Prepares pay runs, checks variances and leave, and readies the SARS evidence packs.",
    required: false,
    setupItemKey: "clerk",
    skills: withOs(teamSkillKey(PIB_PLUGINS.payroll, "payroll")),
    actions: pluginActions("payroll", "payroll.sync-skills"),
    pagePath: "/payroll",
    runProfile: RUN_PROFILES["payroll-clerk"],
  },
];

export function teamRole(key: TeamRoleKey): TeamRole {
  const role = TEAM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown team role ${key}`);
  return role;
}

/** The role, then the roles that cover it while it is unstaffed: `["deal-desk", "account-manager"]`. */
export function teamRoleChain(key: TeamRoleKey): TeamRoleKey[] {
  const chain: TeamRoleKey[] = [];
  let next: TeamRoleKey | undefined = key;
  while (next && !chain.includes(next)) {
    chain.push(next);
    next = TEAM_ROLES.find((r) => r.key === next)?.coveredBy;
  }
  return chain;
}

/** The team role behind a plugin's setup checklist item, if any. */
export function teamRoleForSetupItem(pluginKey: string, itemKey: string): TeamRole | null {
  return TEAM_ROLES.find((r) => r.pluginKey === pluginKey && r.setupItemKey === itemKey) ?? null;
}

/** Roles for the company's switched-on modules (a module missing from `modules` counts as on). */
export function activeTeamRoles(modules: Partial<Record<ModuleKey, boolean>> | null | undefined): TeamRole[] {
  return TEAM_ROLES.filter((r) => modules?.[r.module] !== false);
}

/** Where to staff a role: the Setup page's Team section, scrolled to the role. */
export const TEAM_SETUP_PATH = "/setup?section=team";

export function teamSetupPath(role?: TeamRoleKey | null): string {
  return role ? `${TEAM_SETUP_PATH}#team-${role}` : TEAM_SETUP_PATH;
}

/** Agent statuses that mean the role is not really covered. */
export const TEAM_INACTIVE_STATUSES = ["terminated", "archived", "deleted"] as const;
export const TEAM_ATTENTION_STATUSES = ["paused", "error", "pending_approval"] as const;

export type TeamRoleHealth = "missing" | "hiring" | "attention" | "ok";

/**
 * How a role stands: `missing` (no agent, no open hire), `hiring` (a hire
 * task is open), `attention` (agent paused, in error, awaiting approval, or
 * missing a skill), `ok`.
 */
export function teamRoleHealth(input: { agentStatus: string | null | undefined; hireOpen: boolean; missingSkills?: number }): TeamRoleHealth {
  const status = input.agentStatus ?? null;
  if (!status || (TEAM_INACTIVE_STATUSES as readonly string[]).includes(status)) return input.hireOpen ? "hiring" : "missing";
  if ((TEAM_ATTENTION_STATUSES as readonly string[]).includes(status) || (input.missingSkills ?? 0) > 0) return "attention";
  return "ok";
}
