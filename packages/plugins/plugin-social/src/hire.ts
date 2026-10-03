/**
 * The Social agent as a hire request. Setup → Team opens a normal Paperclip
 * task with this spec (`social.start-hire`); the company's hiring agent (or a
 * person) creates the agent, and the plugin links and wires it (kit
 * agent-hire).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL, type HireRole, type HireSkill, type LegacyAgentLookup } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, SOCIAL_AGENT_KEY } from "./platforms.js";
import { SKILL_KEY_PREFIX, SKILLS } from "./skills.js";

export const SOCIAL_AGENT_NAME = "Social Media Manager";
export const SOCIAL_AGENT_ICON = "megaphone";
export const SOCIAL_AGENT_CAPABILITIES =
  "Plans, drafts and schedules social posts for Partners in Biz's own accounts and for its clients across 12 platforms, fixes failed posts, and works the social inbox through the Social plugin tools.";

/** Short AGENTS.md for the hire. The procedure lives in the two skills. */
export const SOCIAL_HIRE_INSTRUCTIONS = `# Social Media Manager

You run social media for Partners in Biz (its own accounts) and its clients, using the Social plugin tools (\`partnersinbiz.social\`) and the CRM tools (\`partnersinbiz.crm\`).

- Follow the \`pib-social-publish\` skill (drafting, review, scheduling, retries, inbox, analytics) and the \`pib-social-content\` skill (platform-native copy). Read both before your first task.
- One scope per task: PiB's own work (no client) or one CRM client (\`client: "company:<id>"\` or \`"contact:<id>"\` from the issue); never mix accounts or media across scopes.
- Give every draft a proposed time (\`scheduledAt\`). Who approves is the scope's policy (a person by default; for a client it can be the client's own yes). You never approve. Approval schedules it at that time. Never invent metrics or claims; never paste tokens or secrets.
- Plan from the scope's Growth Lab playbook (\`get-playbook\`) and \`performance-review\`; test one change at a time with experiments.
- Need a person (a login, a missing contact link, a judgement call)? Ask once with \`${ASK_OWNER_TOOL}\`, never in a comment.
`;

const PURPOSE: Record<string, string> = {
  "social-publish": "how to use the Social tools: scope, drafts, review, scheduling, retries, inbox and analytics",
  "social-content": "how to write platform-native copy for all 12 platforms",
};

/** The Social plugin's own skills (kept up to date by this plugin). */
export const SOCIAL_SKILLS: HireSkill[] = SKILLS.map((skill) => ({
  key: `${SKILL_KEY_PREFIX}/${skill.skillKey}`,
  slug: skill.slug ?? `pib-${skill.skillKey}`,
  purpose: PURPOSE[skill.skillKey] ?? skill.displayName,
}));

/** Every skill the Social agent needs: its own two, then the company operating manual (kit, always last). */
export const SOCIAL_ROLE_SKILLS: HireSkill[] = [...SOCIAL_SKILLS, COMPANY_OS_HIRE_SKILL];

export const SOCIAL_HIRE_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "Social",
  roleKey: SOCIAL_AGENT_KEY,
  displayName: SOCIAL_AGENT_NAME,
  title: SOCIAL_AGENT_NAME,
  role: "general",
  icon: SOCIAL_AGENT_ICON,
  capabilities: SOCIAL_AGENT_CAPABILITIES,
  adapterPreference: ["hermes_local", "claude_local"],
  skills: SOCIAL_ROLE_SKILLS,
  // $40 a month. The Company Cockpit alerts at 80% ($32).
  budgetMonthlyCents: 4000,
  suggestedManager: "the marketing / growth lead (or the CEO)",
  instructions: SOCIAL_HIRE_INSTRUCTIONS,
  pluginSetup: [
    "Grants it access to plugin tools (`partnersinbiz.social` and `partnersinbiz.crm`).",
    "Assigns it the weekly \"Weekly social review & plan\" routine in the Social project (Mondays 07:00, on from the start; its drafts still need your approval).",
    "Sends it failed posts, the daily inbox reply queue, SEO repurpose tasks and approved posts that still need a time.",
    "Checks it has the social skills and the company operating manual, and says so here if one is missing.",
    "Budget: $40 a month to start. The Cockpit alerts at 80% ($32), so raise it there if the agent needs more.",
  ],
  toolPlugins: ["partnersinbiz.crm"],
};

/**
 * The same role for the kit's hire matching (`hireStatus`, `tryLinkPendingHire`,
 * `registerHireWatch`): without the operating manual. Every PiB agent carries
 * the manual, so matching on it would link any new PiB agent (the SEO or
 * Account Manager hire, say) as the Social agent. The hire task still lists
 * the manual (kit `hireSkills`).
 */
export const SOCIAL_MATCH_ROLE: HireRole = { ...SOCIAL_HIRE_ROLE, skills: SOCIAL_SKILLS };

/** Agents activated before hiring moved to tasks were created by the host from the manifest. */
export function legacySocialAgent(ctx: PluginContext): LegacyAgentLookup {
  return async (companyId: string) => {
    const res = await ctx.agents.managed.get(SOCIAL_AGENT_KEY, companyId);
    return res.agentId ?? null;
  };
}

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
  // Exact canonical key, the frontmatter slug, or either under another prefix (e.g. a company copy).
  return keys.some((raw) => {
    const k = raw.toLowerCase();
    return k === key || k === slug || k.endsWith(`/${slug}`) || k.endsWith(`/${key}`);
  });
}

/** The role skills an agent does not have (by slug), the operating manual included. The plugin cannot attach skills to an agent it did not create. */
export function missingSocialSkills(agent: unknown): string[] {
  const keys = agentSkillKeys(agent);
  return SOCIAL_ROLE_SKILLS.filter((skill) => !hasSkill(keys, skill)).map((skill) => skill.slug);
}

export function skillsHint(name: string, missing: string[]): string | null {
  if (missing.length === 0) return null;
  const quoted = missing.map((slug) => `\`${slug}\``);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}` : quoted[0]!;
  return `${name} does not have ${list} yet. Attach ${missing.length === 1 ? "it" : "them"} on the agent's Skills tab; the plugin cannot attach skills to an agent it did not create.`;
}
