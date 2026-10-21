/**
 * The golden scenarios, from `evals/*.json` (bundled into the worker at build
 * time, like the journeys), and the committed gate file `evals/results.json`.
 * Validated when this module loads. The Cockpit can name only its own tools here;
 * the tests check every other plugin's tool names against its manifest.
 */
import acceptance from "../evals/acceptance.json" with { type: "json" };
import companyOs from "../evals/company-os.json" with { type: "json" };
import operator from "../evals/operator.json" with { type: "json" };
import resultsJson from "../evals/results.json" with { type: "json" };
import reviewer from "../evals/reviewer.json" with { type: "json" };
import summarizer from "../evals/agents/summarizer.json" with { type: "json" };
import crmDataSteward from "../evals/agents/crm-data-steward.json" with { type: "json" };
import developer from "../evals/agents/developer.json" with { type: "json" };
import seniorDeveloper from "../evals/agents/senior-developer.json" with { type: "json" };
import afrikaansEditor from "../evals/agents/afrikaans-editor.json" with { type: "json" };
import arjun from "../evals/agents/arjun.json" with { type: "json" };
import steve from "../evals/agents/steve.json" with { type: "json" };
import kai from "../evals/agents/kai.json" with { type: "json" };
import ren from "../evals/agents/ren.json" with { type: "json" };
import iris from "../evals/agents/iris.json" with { type: "json" };
import mira from "../evals/agents/mira.json" with { type: "json" };
import revenueLead from "../evals/agents/revenue-lead.json" with { type: "json" };
import planner from "../evals/agents/planner.json" with { type: "json" };
import codeReviewer from "../evals/agents/code-reviewer.json" with { type: "json" };
import planCritic from "../evals/agents/plan-critic.json" with { type: "json" };
import dogfoodTester from "../evals/agents/dogfood-tester.json" with { type: "json" };
import releaseEngineer from "../evals/agents/release-engineer.json" with { type: "json" };
import loyaltyPlusEngineerMac from "../evals/agents/loyalty-plus-engineer-mac.json" with { type: "json" };
import productDesigner from "../evals/agents/product-designer.json" with { type: "json" };
import pib from "../evals/agents/pib.json" with { type: "json" };
import { SKILL_SLUGS, PLUGIN_KEY } from "./constants.js";
import { parseResultsFile, parseScenarioFile, type ResultsFile, type Scenario, type ScenarioFile } from "./eval-model.js";
import { ACCEPTANCE_TOOL_NAMES } from "./acceptance-tool-declarations.js";
import { OPS_TOOL_NAMES } from "./ops-tool-declarations.js";
import { EVAL_TOOL_NAMES } from "./eval-tool-declarations.js";
import { TOOL_NAMES } from "./tools.js";
import { MEMORY_TOOLS } from "@partnersinbiz/pib-plugin-kit";

/**
 * Bundled agent eval templates. Each distilled template's `evals/agents/<key>.json`
 * is imported statically and added here; esbuild inlines it into dist/worker.js.
 */
export const AGENT_EVALS: Record<string, unknown> = {
  summarizer,
  "crm-data-steward": crmDataSteward,
  developer,
  "senior-developer": seniorDeveloper,
  "afrikaans-editor": afrikaansEditor,
  arjun,
  steve,
  kai,
  ren,
  iris,
  mira,
  "revenue-lead": revenueLead,
  planner,
  "code-reviewer": codeReviewer,
  "plan-critic": planCritic,
  "dogfood-tester": dogfoodTester,
  "release-engineer": releaseEngineer,
  "loyalty-plus-engineer-mac": loyaltyPlusEngineerMac,
  "product-designer": productDesigner,
  pib,
};

/** Every tool this plugin registers, as agents name it. */
export function cockpitToolNames(): Set<string> {
  const names = [...Object.values(TOOL_NAMES), ...Object.values(OPS_TOOL_NAMES), ...Object.values(ACCEPTANCE_TOOL_NAMES), ...Object.values(EVAL_TOOL_NAMES), ...Object.values(MEMORY_TOOLS)] as string[];
  return new Set(names.map((n) => `${PLUGIN_KEY}:${n}`));
}

const cockpitTools = cockpitToolNames();
const known = (name: string): boolean => !name.startsWith(`${PLUGIN_KEY}:`) || cockpitTools.has(name);
const slugs = Object.values(SKILL_SLUGS);

export const SCENARIO_FILES: ScenarioFile[] = [operator, reviewer, companyOs, acceptance].map((raw) => parseScenarioFile(raw, slugs, known));
export const RESULTS_FILE: ResultsFile = parseResultsFile(resultsJson);

// Validate agent eval templates at module load
for (const [key, raw] of Object.entries(AGENT_EVALS)) {
  parseScenarioFile(raw, slugs, known);
}

export function scenariosFor(skillSlug: string): Scenario[] {
  return SCENARIO_FILES.find((f) => f.skill === skillSlug)?.scenarios ?? [];
}

export function scenarioSkills(): string[] {
  return SCENARIO_FILES.map((f) => f.skill);
}
