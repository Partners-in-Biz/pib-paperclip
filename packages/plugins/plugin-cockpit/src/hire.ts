/**
 * The Operator and Reviewer as hire requests (kit agent-hire). "Hire" opens a
 * normal Paperclip task with the spec for whoever hires for the company; when
 * a matching agent appears the Cockpit links it and wires it (roles.ts).
 */
import { COMPANY_OS_HIRE_SKILL, type HireRole, type HireSkill } from "@partnersinbiz/pib-plugin-kit";
import { canonicalSkillKey, PAPERCLIP_SKILL, PLUGIN_KEY, ROLE_KEYS, SKILL_KEYS, SKILL_SLUGS, type RoleKind } from "./constants.js";

export const OPERATOR_SKILL_KEY = canonicalSkillKey(PLUGIN_KEY, SKILL_KEYS.operator);
export const REVIEWER_SKILL_KEY = canonicalSkillKey(PLUGIN_KEY, SKILL_KEYS.reviewer);
export const COMPANY_OS_SKILL_KEY = canonicalSkillKey(PLUGIN_KEY, SKILL_KEYS.companyOs);

export const OPERATOR_BUDGET_CENTS = 3000;
export const REVIEWER_BUDGET_CENTS = 2000;

/** Paperclip's own operating skill: both roles work issues, comments and hand-offs through the API. */
export const PAPERCLIP_HIRE_SKILL: HireSkill = {
  key: PAPERCLIP_SKILL.key,
  slug: PAPERCLIP_SKILL.slug,
  purpose: "working in Paperclip itself: reading and updating issues, comments, statuses and hand-offs through the API (Paperclip adds it only to CEO hires by itself)",
};

export const OPERATOR_CAPABILITIES =
  "Runs the company day to day: reviews every module's status each morning, routes and escalates work, keeps agents unblocked, and sends the owner one daily brief.";

export const REVIEWER_CAPABILITIES =
  "Checks outward-facing work (posts, campaign emails, invoice and quote emails, sequence emails, SEO pull requests) against the brand, the playbooks and the facts before a person approves. Comments PASS or CHANGES NEEDED and hands the issue back to the person.";

export const OPERATOR_INSTRUCTIONS = `# Operator (Chief of staff), Partners in Biz

You run this company day to day so the owner only sees what truly needs them.

- Follow the **${SKILL_SLUGS.operator}** skill. It holds the daily routine, how to read the Cockpit with the \`${PLUGIN_KEY}\` tools, who owns what, when to act and when to escalate, and the weekly retro.
- Your work arrives through the "Daily operations review" (07:00) and "Weekly retro" (Mondays 08:00) routines, the "System health" issue when something breaks, and onboarding issues when a client is won.
- Never approve money or legal items, never change budgets, and never send or publish anything yourself. Those stay with a person.
- One daily brief, posted with \`post-daily-brief\`. Keep it short and link everything.
`;

export const REVIEWER_INSTRUCTIONS = `# Reviewer (Quality reviewer), Partners in Biz

You check outward-facing work before a person approves it: social posts, campaign emails, invoice and quote emails, sequence emails and SEO pull requests.

- Follow the **${SKILL_SLUGS.reviewer}** skill: which tool reads each kind of work, and one checklist per kind.
- Work arrives as approval issues assigned to you. Each ends with a "Reviewer" section saying what to check and who to hand it to.
- Comment **PASS** or **CHANGES NEEDED** (one line per problem), then hand the issue to the approver named in that section.
- Never approve, send, publish, merge or mark the issue done yourself.
`;

export const OPERATOR_ROLE: HireRole = {
  pluginKey: PLUGIN_KEY,
  pluginName: "Cockpit",
  roleKey: ROLE_KEYS.operator,
  displayName: "Operator",
  title: "Chief of staff",
  role: "general",
  icon: "compass",
  capabilities: OPERATOR_CAPABILITIES,
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    {
      key: OPERATOR_SKILL_KEY,
      slug: SKILL_SLUGS.operator,
      purpose: "the daily operations routine, reading the Cockpit, who owns what, when to escalate, hand-offs, unblocking agents and the weekly retro",
    },
    PAPERCLIP_HIRE_SKILL,
    COMPANY_OS_HIRE_SKILL,
  ],
  budgetMonthlyCents: OPERATOR_BUDGET_CENTS,
  suggestedManager: "the CEO (it works for the owner)",
  instructions: OPERATOR_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can read the Cockpit (`company-brief`, `health-issues`, `waiting-on-owner`, `agent-scorecards`), ask the owner (`ask-owner`) and post the daily brief.",
    "Creates the \"Daily operations review\" (07:00 SAST) and \"Weekly retro\" (Mondays 08:00 SAST) routines and assigns them to it.",
    "Assigns the System health issue and client onboarding to it, and tells every PiB plugin who the Operator is.",
    `Keeps the \`${SKILL_SLUGS.operator}\` and \`${SKILL_SLUGS.companyOs}\` skills up to date.`,
    "Watches its spend: the Cockpit alerts at 80% of the monthly budget.",
  ],
  toolPlugins: [PLUGIN_KEY],
};

export const REVIEWER_ROLE: HireRole = {
  pluginKey: PLUGIN_KEY,
  pluginName: "Cockpit",
  roleKey: ROLE_KEYS.reviewer,
  displayName: "Reviewer",
  title: "Quality reviewer",
  role: "general",
  icon: "shield-check",
  capabilities: REVIEWER_CAPABILITIES,
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    {
      key: REVIEWER_SKILL_KEY,
      slug: SKILL_SLUGS.reviewer,
      purpose: "which tool reads each kind of work, and the review checklists for social posts, campaign emails, invoice/quote emails, sequence emails and SEO pull requests",
    },
    PAPERCLIP_HIRE_SKILL,
    COMPANY_OS_HIRE_SKILL,
  ],
  budgetMonthlyCents: REVIEWER_BUDGET_CENTS,
  suggestedManager: "the Operator (or the CEO)",
  instructions: REVIEWER_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can read the records behind the work it reviews.",
    "Tells every PiB plugin who the Reviewer is. When \"Review outward-facing work before I approve\" is on, approval issues for outward-facing work go to it first.",
    `Keeps the \`${SKILL_SLUGS.reviewer}\` and \`${SKILL_SLUGS.companyOs}\` skills up to date.`,
    "Watches its spend: the Cockpit alerts at 80% of the monthly budget.",
  ],
  toolPlugins: [PLUGIN_KEY],
};

/** The hire requests (task drafts list every skill to attach). */
export const HIRE_ROLES: Record<RoleKind, HireRole> = { operator: OPERATOR_ROLE, reviewer: REVIEWER_ROLE };

/**
 * The same roles for finding and linking a hired agent. They match on the
 * role's own skill only: the paperclip skill and the company operating
 * manual are on every hire, so matching on them would take any new agent
 * (an SEO Specialist hired the same day) for the Operator.
 */
export const HIRE_MATCH_ROLES: Record<RoleKind, HireRole> = {
  operator: { ...OPERATOR_ROLE, skills: OPERATOR_ROLE.skills.filter((skill) => skill.key === OPERATOR_SKILL_KEY) },
  reviewer: { ...REVIEWER_ROLE, skills: REVIEWER_ROLE.skills.filter((skill) => skill.key === REVIEWER_SKILL_KEY) },
};
