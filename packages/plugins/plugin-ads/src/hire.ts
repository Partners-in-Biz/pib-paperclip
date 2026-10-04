/**
 * The ads agent as a hire request. Setup -> Team opens a normal Paperclip task with this spec (`ads.start-hire`); the company's hiring agent
 * (or a person) creates the agent, and the plugin links and wires it (kit agent-hire). The agent never holds a credential and can never
 * approve anything: it proposes, checks and reports; a person approves; the plugin runs only what was approved.
 */
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL, DEFAULT_RUN_PROFILE, type HireRole, type HireSkill } from "@partnersinbiz/pib-plugin-kit";
import { ADS_ROLE_KEY, PLUGIN_ID } from "./platforms.js";

export const ADS_AGENT_NAME = "Paid Ads Manager";
export const ADS_AGENT_ICON = "megaphone";
export const ADS_SKILL_KEY_PREFIX = "plugin/partnersinbiz-ads";
export const ADS_SKILL_KEY = "ads";
export const ADS_SKILL_SLUG = "pib-ads";

export const ADS_AGENT_CAPABILITIES =
  "Reads paid-ads performance from Meta and Google into one picture, watches budgets and anomalies, and prepares campaign and budget changes as proposals with the numbers. A person approves; the plugin runs only what was approved.";

/** Short AGENTS.md for the hire. The procedure lives in the skill. */
export const ADS_HIRE_INSTRUCTIONS = `# Paid Ads Manager

You run paid advertising for Partners in Biz (its own ads) and its clients through the Paid ads plugin tools (\`partnersinbiz.ads\`), with the CRM tools (\`partnersinbiz.crm\`) for the client's brand profile and for asking the client.

- Follow the \`${ADS_SKILL_SLUG}\` skill. Read it before your first task.
- One scope per task: PiB's own ads, or one CRM client (\`client: "company:<id>"\` or \`"contact:<id>"\`). Never mix scopes.
- You never spend money by yourself. Every campaign or budget change is a proposal with the numbers; the Reviewer checks it, a person approves it (a client's own yes too, when the scope needs it), and only then \`execute-ad-change\` may run, with the approval id. Never change the budget caps or the switches: they are people's.
- Never paste tokens, keys or secrets anywhere. You never see them.
- Need a person (a login, a grant, a judgement call)? Ask once with \`${ASK_OWNER_TOOL}\`, never in a comment.
`;

export const ADS_HIRE_SKILLS: HireSkill[] = [
  { key: `${ADS_SKILL_KEY_PREFIX}/${ADS_SKILL_KEY}`, slug: ADS_SKILL_SLUG, purpose: "how to read ads performance, work within budget caps, and propose, check and run approved changes" },
];

/** Every skill the ads agent needs: its own, then the company operating manual (kit, always last). */
export const ADS_ROLE_SKILLS: HireSkill[] = [...ADS_HIRE_SKILLS, COMPANY_OS_HIRE_SKILL];

export const ADS_HIRE_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "Paid ads",
  roleKey: ADS_ROLE_KEY,
  displayName: ADS_AGENT_NAME,
  title: ADS_AGENT_NAME,
  role: "general",
  icon: ADS_AGENT_ICON,
  capabilities: ADS_AGENT_CAPABILITIES,
  adapterPreference: ["claude_local", "hermes_local"],
  skills: ADS_ROLE_SKILLS,
  // $30 a month. The Company Cockpit alerts at 80%.
  budgetMonthlyCents: 3000,
  suggestedManager: "the marketing / growth lead (or the CEO)",
  instructions: ADS_HIRE_INSTRUCTIONS,
  pluginSetup: [
    "Grants it access to plugin tools (`partnersinbiz.ads` and `partnersinbiz.crm`).",
    "Creates the Ads project for PiB's own ads issues (a client's issues open in the client's own project).",
    "Sends it anomaly alerts (spend spikes, no delivery, cost per result over target) and the proposals it must revise.",
    "Checks it has the ads skill and the company operating manual, and says so here if one is missing.",
    "Budget: $30 a month to start. The Cockpit alerts at 80%, so raise it there if the agent needs more.",
  ],
  toolPlugins: ["partnersinbiz.crm"],
  // Runs on Sonnet like every role that touches money; two at once is plenty (it works one scope at a time).
  runProfile: { ...DEFAULT_RUN_PROFILE, maxConcurrentRuns: 2 },
};

/** The role for the kit's hire matching: without the operating manual every PiB agent carries (it would link any new PiB agent). */
export const ADS_MATCH_ROLE: HireRole = { ...ADS_HIRE_ROLE, skills: ADS_HIRE_SKILLS };

/** Skill keys the host syncs to the agent (`adapterConfig.paperclipSkillSync.desiredSkills`). */
export function agentSkillKeys(agent: unknown): string[] {
  if (!agent || typeof agent !== "object") return [];
  const config = (agent as Record<string, unknown>).adapterConfig;
  if (!config || typeof config !== "object") return [];
  const sync = (config as Record<string, unknown>).paperclipSkillSync;
  if (!sync || typeof sync !== "object") return [];
  const list = (sync as Record<string, unknown>).desiredSkills;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

function hasSkill(keys: string[], skill: HireSkill): boolean {
  const key = skill.key.toLowerCase();
  const slug = skill.slug.toLowerCase();
  return keys.some((raw) => {
    const k = raw.toLowerCase();
    return k === key || k === slug || k.endsWith(`/${slug}`) || k.endsWith(`/${key}`);
  });
}

/** The role skills an agent does not have (by slug), the operating manual included. The plugin cannot attach skills to an agent it did not create. */
export function missingAdsSkills(agent: unknown): string[] {
  const keys = agentSkillKeys(agent);
  return ADS_ROLE_SKILLS.filter((skill) => !hasSkill(keys, skill)).map((skill) => skill.slug);
}

export function skillsHint(name: string, missing: string[]): string | null {
  if (missing.length === 0) return null;
  const quoted = missing.map((slug) => `\`${slug}\``);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}` : quoted[0]!;
  return `${name} does not have ${list} yet. Attach ${missing.length === 1 ? "it" : "them"} on the agent's Skills tab; the plugin cannot attach skills to an agent it did not create.`;
}
