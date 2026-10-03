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
import { SKILL_SLUGS, PLUGIN_KEY } from "./constants.js";
import { parseResultsFile, parseScenarioFile, type ResultsFile, type Scenario, type ScenarioFile } from "./eval-model.js";
import { ACCEPTANCE_TOOL_NAMES } from "./acceptance-tool-declarations.js";
import { OPS_TOOL_NAMES } from "./ops-tool-declarations.js";
import { EVAL_TOOL_NAMES } from "./eval-tool-declarations.js";
import { TOOL_NAMES } from "./tools.js";
import { MEMORY_TOOLS } from "@partnersinbiz/pib-plugin-kit";

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

export function scenariosFor(skillSlug: string): Scenario[] {
  return SCENARIO_FILES.find((f) => f.skill === skillSlug)?.scenarios ?? [];
}

export function scenarioSkills(): string[] {
  return SCENARIO_FILES.map((f) => f.skill);
}
