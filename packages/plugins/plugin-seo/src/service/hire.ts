/**
 * The SEO Specialist as a hire request. "Activate SEO agent" opens a normal
 * Paperclip task with this spec for whoever hires for the company; when a
 * matching agent appears the plugin links it and wires it (service/agent.ts).
 */
import type { HireRole } from "@partnersinbiz/pib-plugin-kit";
import { AGENT_CAPABILITIES, AGENT_DISPLAY_NAME, AGENT_KEY, SKILL_CANONICAL_KEY, SKILL_SLUG } from "../constants.js";
import { PLUGIN_ID } from "../namespace.js";

/** Short AGENTS.md for the hired agent. The procedure lives in the skill. */
export const HIRE_INSTRUCTIONS = `# SEO Specialist, Partners in Biz

You run 90-day SEO sprints for Partners in Biz's own sites and for its clients (one sprint per site) with the \`partnersinbiz.seo\` tools.

- Follow the **${SKILL_SLUG}** skill. It holds the operating procedure, the playbook for every task and the tool reference. Read it before your first run.
- Your work arrives as SEO issues assigned to you and the "Run today's SEO" and "Weekly SEO review" routines.
- Keep each sprint in its scope (pass the sprint's \`client\` on), never mix data between clients or PiB's own sites, and never invent numbers.
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
  skills: [
    {
      key: SKILL_CANONICAL_KEY,
      slug: SKILL_SLUG,
      purpose: "the 90-day sprint procedure, the playbook for all 42 tasks, the weekly optimization loop and the SEO tool reference",
    },
  ],
  // $40 a month. The Company Cockpit alerts at 80% ($32).
  budgetMonthlyCents: 4000,
  suggestedManager: "the marketing / growth lead (or the CEO)",
  instructions: HIRE_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the SEO tools (and the Social and CRM tools for posts and client lookups).",
    "Assigns the \"Run today's SEO\" and \"Weekly SEO review\" routines to it in the SEO project. They stay paused, with schedules off, until someone turns them on.",
    "Points every SEO sprint at the agent and hands it the SEO tasks that were waiting for an agent.",
    `Keeps the \`${SKILL_SLUG}\` skill up to date.`,
    "Budget: $40 a month to start. The Cockpit alerts at 80% ($32), so raise it there if the agent needs more.",
  ],
  toolPlugins: ["partnersinbiz.social", "partnersinbiz.crm"],
};
