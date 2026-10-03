/**
 * Declarations of the skill-quality tools (exposed as `partnersinbiz.cockpit:<name>`):
 * `skill-eval` runs the golden scenarios against the real skills and gates a
 * change, and `propose-skill-change` turns a reviewed proposal (the host's
 * Reflection Coach, or anyone) into a pull-request package. No worker imports, so
 * the manifest can load them.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { IMPROVEMENT_KINDS } from "./improvements-model.js";
import { SKILL_SLUGS } from "./constants.js";

export const EVAL_TOOL_NAMES = {
  eval: "skill-eval",
  change: "propose-skill-change",
} as const;
export const SKILL_EVAL_TOOL_NAME = EVAL_TOOL_NAMES.eval;
export const SKILL_CHANGE_TOOL_NAME = EVAL_TOOL_NAMES.change;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const SKILLS = Object.values(SKILL_SLUGS);

export const EVAL_TOOLS: PluginToolDeclaration[] = [
  {
    name: EVAL_TOOL_NAMES.eval,
    displayName: "Skill evals",
    description:
      "Golden-scenario tests of the Cockpit's own skills (pib-operator, pib-reviewer, pib-company-os, pib-acceptance): real recurring situations with what the skill must make an agent do, run on paper against the REAL skill through the host's skill-test harness. plan gives the exact harness requests (POST /api/companies/{companyId}/skills/{skillId}/test-runs with the agent that runs them) for the live skill, or for a candidate text you install as a test copy first; you make those calls (they need the skills.test and tasks:assign grants) and wait for each harness task to finish. record then grades each finished harness task from its output document (pass \"issueId\" per scenario): every check is a plain rule, no model judges a model. report shows pass rates per skill version (content hash) next to the baseline and what regressed. baseline marks the live skill's latest full result set as the one to beat and prints the entry to commit in evals/results.json. gate answers whether a skill version may ship: no, if a scenario that passed at the baseline now fails, if under 80% pass, or if scenarios were not run on this text. scenarios lists them. Never run these on a real client's work: the scenarios are made-up.",
    parametersSchema: schema(["action"], {
      action: { type: "string", enum: ["scenarios", "plan", "record", "report", "baseline", "gate"], description: "What to do." },
      skill: { type: "string", enum: SKILLS, description: "Which skill (all of them when left out, for scenarios, report and gate)." },
      scenarioIds: { type: "array", items: { type: "string" }, maxItems: 30, description: "plan: only these scenarios (default: all of the skill's)." },
      mode: { type: "string", enum: ["live", "candidate"], description: "plan and record: live (the skill as deployed, the default) or candidate (a changed text installed as a test copy, to be checked before it ships)." },
      agentId: { type: "string", description: "plan: the agent that runs the harness tasks (default: you). It must not be paused." },
      candidateMarkdown: { type: "string", maxLength: 40000, description: "plan, mode candidate: the candidate skill's full SKILL.md text." },
      candidateFiles: { type: "array", maxItems: 12, items: { type: "object", required: ["path", "content"], additionalProperties: false, properties: { path: { type: "string", maxLength: 200 }, content: { type: "string", maxLength: 30000 } } }, description: "plan, mode candidate: the candidate's reference files (path and content), if the change touches them." },
      items: {
        type: "array",
        maxItems: 30,
        description: "record: the finished harness tasks to grade.",
        items: { type: "object", required: ["scenarioId", "issueId"], additionalProperties: false, properties: { scenarioId: { type: "string" }, issueId: { type: "string", description: "The harness issue (id or identifier) the test run created. It must be a run of this skill (live) or of the candidate's test copy (candidate): the Cockpit checks the task's title." } } },
      },
      candidateHash: { type: "string", maxLength: 40, description: "record (mode candidate) and gate: the hash plan gave for the candidate text. With gate it asks whether that candidate may ship." },
    }),
  },
  {
    name: EVAL_TOOL_NAMES.change,
    displayName: "Propose a skill change",
    description:
      "Turn a reviewed proposal to change a plugin-managed skill (from the host's Reflection Coach, a close-out review or the retro) into a pull-request package: the Cockpit applies your unified diff to the skill's current text and refuses what does not apply, is over the size budget, drops a \"never\" rule or carries a secret; names the source files to edit; lists the eval commands that must pass before merge; writes the branch name, PR title and PR body (the evidence, the diff, the gate, the rollback); and records an improvement in the ledger with the number the change should move, so it is measured again after it ships. Skills live in plugin source and the plugin overwrites in-company edits at every sync, so a change reaches agents only through a merged and deployed pull request: you or a Developer opens it (into development, never main) with the GitHub tools you already have. Never apply a coach's proposal to the company's skill copy: it is overwritten and nothing is measured.",
    parametersSchema: schema(["skill", "diff", "reason", "metricKey"], {
      skill: { type: "string", description: "The skill: pib-operator, pib-reviewer, pib-company-os or pib-acceptance for a full check; another PiB skill's slug (for example pib-crm-records) gets a package without the apply check." },
      diff: { type: "string", maxLength: 40000, description: "The change as a unified diff against the skill's current text (the coach's proposal document has it), one or more hunks." },
      file: { type: "string", maxLength: 200, description: "Which file of the skill the diff is for: SKILL.md (the default) or a reference path such as references/health-checks.md." },
      reason: { type: "string", maxLength: 600, description: "Why: the pattern, in a sentence or two." },
      evidence: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 }, description: "The issues and comments that show the pattern (identifiers or links). A change with no evidence is a wish." },
      sourceIssueId: { type: "string", description: "The proposal's issue (the reflection issue or the retro): the ledger entry links to it." },
      metricKey: { type: "string", maxLength: 120, description: "The number this change should move, as for improvement-propose (for example agent:<id>:failed_runs or company:reopen_rate)." },
      direction: { type: "string", enum: ["lower", "higher"], description: "Which way is better, for a metric the Cockpit does not know the direction of." },
      baselineValue: { type: "number", description: "Where the number stands now, for a metric the Cockpit cannot read itself." },
      targetValue: { type: "number", description: "The number to reach." },
      recheckInDays: { type: "integer", minimum: 7, maximum: 120, description: "Days until it is measured again, counted from now: allow for review and deploy (default 28)." },
      kind: { type: "string", enum: [...IMPROVEMENT_KINDS], description: "What the change is (default skill)." },
    }),
  },
];

export const EVAL_TOOL_SET = new Set<string>(Object.values(EVAL_TOOL_NAMES));
