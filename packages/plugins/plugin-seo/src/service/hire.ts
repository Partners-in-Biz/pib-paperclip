/**
 * The SEO Specialist as a hire request. Setup → Team opens a normal Paperclip
 * task with this spec (`seo.start-hire`) for whoever hires for the company;
 * when a matching agent appears the plugin links it and wires it
 * (service/agent.ts).
 */
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL, type HireRole } from "@partnersinbiz/pib-plugin-kit";
import { AGENT_CAPABILITIES, AGENT_DISPLAY_NAME, AGENT_KEY, SKILL_CANONICAL_KEY, SKILL_SLUG } from "../constants.js";
import { PLUGIN_ID } from "../namespace.js";

/** Short AGENTS.md for the hired agent. The procedure lives in the skill. */
export const HIRE_INSTRUCTIONS = `# SEO Specialist, Partners in Biz

You run 90-day SEO sprints for Partners in Biz's own sites and for its clients (one sprint per site) with the \`partnersinbiz.seo\` tools.

- Follow the **${SKILL_SLUG}** skill. It holds the operating procedure, the playbook for every task and the tool reference. Read it before your first run.
- Your work arrives as SEO issues assigned to you and the "Run today's SEO" and "Weekly SEO review" routines.
- Keep each sprint in its scope (pass the sprint's \`client\` on), never mix data between clients or PiB's own sites, and never invent numbers.
- A person only for a one-time grant or judgement: sprint items go on its weekly Needs you issue (\`block-task\`, \`needs-you-add\`); anything else once with \`${ASK_OWNER_TOOL}\`. Never ask in a comment.
- The Social agent owns repurposing: mark pages live and link its drafts (\`link-social-post\`); do not draft social versions yourself.
`;

export const SEO_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "SEO",
  roleKey: AGENT_KEY,
  displayName: AGENT_DISPLAY_NAME,
  title: AGENT_DISPLAY_NAME,
  role: "general",
  icon: "search",
  capabilities: AGENT_CAPABILITIES,
  adapterPreference: ["hermes_local", "claude_local"],
  // The SEO skill, then the company operating manual (every PiB role ends with it).
  skills: [
    {
      key: SKILL_CANONICAL_KEY,
      slug: SKILL_SLUG,
      purpose: "the 90-day sprint procedure, the playbook for all 42 tasks, the weekly optimization loop and the SEO tool reference",
    },
    COMPANY_OS_HIRE_SKILL,
  ],
  // $40 a month. The Company Cockpit alerts at 80% ($32).
  budgetMonthlyCents: 4000,
  suggestedManager: "the marketing / growth lead (or the CEO)",
  instructions: HIRE_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the SEO tools (and the Social and CRM tools for posts and client lookups).",
    "Assigns the \"Run today's SEO\" (daily 06:30) and \"Weekly SEO review\" (Mondays 07:00) routines to it in the SEO project and switches them on, so it works every day without anyone starting it.",
    "Points every SEO sprint at the agent and hands it the SEO tasks that were waiting for an agent.",
    `Keeps the \`${SKILL_SLUG}\` skill up to date and checks the agent has it and the company operating manual (\`${COMPANY_OS_HIRE_SKILL.slug}\`).`,
    "Budget: $40 a month to start. The Cockpit alerts at 80% ($32), so raise it there if the agent needs more.",
  ],
  toolPlugins: ["partnersinbiz.social", "partnersinbiz.crm"],
};

/**
 * The same role for the kit's hire matching (`hireStatus`, `tryLinkPendingHire`,
 * `registerHireWatch`): without the operating manual. Every PiB agent carries
 * the manual, so matching on it would link any new PiB agent as the SEO
 * Specialist. The hire task still lists the manual (kit `hireSkills`).
 */
export const SEO_MATCH_ROLE: HireRole = { ...SEO_ROLE, skills: SEO_ROLE.skills.filter((skill) => skill.key !== COMPANY_OS_HIRE_SKILL.key) };
