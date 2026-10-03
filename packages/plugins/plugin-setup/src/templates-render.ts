/**
 * Renders a template of the team pack as a hire task (worker side; imports the
 * kit root for the two lines every PiB hire's AGENTS.md carries).
 *
 * The task is what the CEO executes: the full agent table, the skills, the
 * AGENTS.md and a ready `POST /api/companies/:id/agent-hires` payload. Its title
 * starts with "Hire:" so the CEO's instructions for hire tasks apply. Rendering
 * is deterministic: the same inputs give the same text, so a test can read it.
 */
import { runProfileConfig, runProfileRows, withMemoryInstruction, type RunProfile } from "@partnersinbiz/pib-plugin-kit";
import {
  expandBlocks,
  fillVariables,
  manager,
  matchTemplate,
  NO_WIKI_ROOT,
  packSources,
  type AgentLike,
  type AgentTemplate,
  type TemplateVars,
} from "./templates.js";

export interface HireDraft {
  title: string;
  description: string;
  /** The `agent-hires` request body (the AGENTS.md is the `instructions` text below). */
  payload: Record<string, unknown>;
  /** The rendered AGENTS.md. */
  instructions: string;
  adapterType: string;
  /** Things the person should know before creating the hire (an unfilled variable, a required environment). */
  warnings: string[];
}

/** `hermes_local` only when the template has a Hermes profile; otherwise the next adapter the template allows. */
export function pickAdapter(template: Pick<AgentTemplate, "adapterPreference" | "runProfile">): string {
  for (const adapter of template.adapterPreference) {
    if (adapter === "hermes_local" && !template.runProfile.hermes) continue;
    return adapter;
  }
  return "claude_local";
}

/** The agent's AGENTS.md: the file, its shared blocks, the company's names, and (for hired agents) the memory and manual lines. */
export function renderInstructions(template: AgentTemplate, vars: TemplateVars): string {
  const { files, blocks } = packSources();
  const source = files[template.file];
  if (source === undefined) throw new Error(`The template ${template.key} has no instructions file`);
  const text = fillVariables(expandBlocks(source, blocks), vars).trim();
  return template.provisioning === "hire" ? withMemoryInstruction(text) : text;
}

/** Adapter and runtime settings the agent is created with (kit run profile + a heartbeat that wakes on demand only). */
export function templateConfig(template: AgentTemplate, adapterType: string = pickAdapter(template)): { adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown> } {
  const config = runProfileConfig(template.runProfile as RunProfile, adapterType);
  return {
    adapterConfig: config.adapterConfig,
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: template.runProfile.maxConcurrentRuns } },
  };
}

function introFor(template: AgentTemplate): string {
  const lead = `Setup's team template pack (${template.group}) asks for this agent: ${template.capabilities}`;
  const how = "Please hire it the way we hire every agent, so it sits in the right place in the org chart.";
  if (template.provisioning === "host") return `${lead}\n\nPaperclip itself provides this agent. Only hire it from this task if the company does not have it yet (list the agents first). ${how}`;
  if (template.provisioning === "plugin") return `${lead}\n\nThe LLM Wiki plugin normally creates this agent when the company wiki is set up (Setup -> Company wiki -> Set up company memory). Only hire it from this task if the company does not have it yet. ${how}`;
  return `${lead}\n\n${how}`;
}

export function renderHire(template: AgentTemplate, input: { vars: TemplateVars; agents?: readonly AgentLike[] | null; sourceIssueId?: string | null }): HireDraft {
  const adapterType = pickAdapter(template);
  const instructions = renderInstructions(template, input.vars);
  const config = templateConfig(template, adapterType);
  const boss = manager(template);
  const bossAgent = boss && input.agents ? matchTemplate(boss, input.agents) : null;
  const reportsTo = boss ? (bossAgent ? bossAgent.id : `<agent id of ${boss.name}>`) : null;
  const warnings: string[] = [];
  if (template.requires.environment) warnings.push(`Needs: ${template.requires.environment}`);
  if (!input.vars.prefix) warnings.push("The company's issue prefix is not known, so the agent links in the instructions are plain names. Render this task again once the company can be read.");
  if (template.provisioning === "plugin" && input.vars.wikiRoot === NO_WIKI_ROOT) warnings.push("The wiki folder is not known yet: the LLM Wiki plugin writes it into the agent's own AGENTS.md when the wiki is set up.");
  const payload: Record<string, unknown> = {
    name: template.name,
    role: template.role,
    title: template.title,
    icon: template.icon,
    reportsTo,
    capabilities: template.capabilities,
    desiredSkills: template.desiredSkills,
    adapterType,
    adapterConfig: config.adapterConfig,
    instructionsBundle: { files: { "AGENTS.md": "<the AGENTS.md block above, verbatim>" } },
    runtimeConfig: config.runtimeConfig,
    sourceIssueId: input.sourceIssueId ?? "<the id of this task>",
  };
  const reports = boss
    ? (bossAgent ? `${boss.name} (agent id \`${bossAgent.id}\`)` : `${boss.name} (look its agent id up by name; it may not exist yet: hire it first)`)
    : "nobody: this is the head of the org chart";
  const profile = template.runProfile;
  const description = [
    introFor(template),
    "",
    "## The agent",
    "",
    "| | |",
    "|---|---|",
    `| **Name** | ${template.name} |`,
    `| **Title** | ${template.title} |`,
    `| **Role** | \`${template.role}\` |`,
    `| **Icon** | \`${template.icon}\` |`,
    `| **Reports to** | ${reports} |`,
    `| **Adapter** | ${[adapterType, ...template.adapterPreference.filter((adapter) => adapter !== adapterType)].map((adapter) => `\`${adapter}\``).join(", then ")} (first one that has a working model key) |`,
    "| **Budget** | $0: `claude_local` runs record no cost, so the model pin, timeout and concurrency below are the guardrails |",
    ...runProfileRows(profile, template.adapterPreference),
    "| **Start** | paused, until its model key (or Claude login) is checked |",
    "",
    "Set the run profile when you create the agent: it is in the request below. An agent created without a pinned model runs on the host default (Opus) with no time limit, and a plugin cannot change an agent's settings afterwards.",
    "",
    "## Skills to attach",
    "",
    ...template.desiredSkills.map((skill) => `- \`${skill}\``),
    "",
    "Attach them with `skills:sync` in `add` mode (never `replace`). Skills that are not in the company's library yet are skipped by the host: say which ones in your comment.",
    "",
    "## Instructions (AGENTS.md)",
    "",
    "````markdown",
    instructions,
    "````",
    "",
    "## The hire request",
    "",
    "`POST /api/companies/{companyId}/agent-hires` with this body. Replace the AGENTS.md placeholder with the block above, verbatim.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    ...(template.notes.length ? ["", "## Notes", "", ...template.notes.map((note) => `- ${note}`)] : []),
    ...(warnings.length ? ["", "## Check first", "", ...warnings.map((warning) => `- ${warning}`)] : []),
    "",
    "## Done when",
    "",
    "- The agent exists with the skills above, the run profile above and the right manager.",
    "- If the company needs board approval for new agents, you linked the approval in your comment.",
    "- The agent is resumed once its adapter has a working model key.",
  ].join("\n");
  return { title: `Hire: ${template.name} (team template)`, description, payload, instructions, adapterType, warnings };
}
