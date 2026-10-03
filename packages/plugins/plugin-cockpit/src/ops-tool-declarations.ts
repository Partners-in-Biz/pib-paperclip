/**
 * Declarations of the Cockpit's measurement, review, improvement, goal and
 * credential tools (exposed as `partnersinbiz.cockpit:<name>`). No worker
 * imports, so the manifest can load them. Every parameter says what to pass.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { METRIC_KEY_HELP } from "./metrics-keys.js";
import { GOAL_PERIODS } from "./goals-model.js";
import { IMPROVEMENT_KINDS } from "./improvements-model.js";
import { VERIFY_PROVIDERS } from "./credentials-model.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const OPS_TOOL_NAMES = {
  measure: "measure-report",
  closeout: "open-closeout-review",
  improvementPropose: "improvement-propose",
  improvementList: "improvement-list",
  improvementResolve: "improvement-resolve",
  goalSet: "goal-set",
  goalList: "goal-list",
  credentialList: "credential-list",
  credentialRecord: "credential-record",
} as const;

const METRIC_KEY: JsonSchema = { type: "string", maxLength: 120, description: METRIC_KEY_HELP };

export const OPS_TOOLS: PluginToolDeclaration[] = [
  {
    name: OPS_TOOL_NAMES.measure,
    displayName: "Measure report",
    description:
      "What the work cost and how it went, for the weekly retro: per agent, per project and per issue tree. Notional USD from the runs' token usage (list price, not billed: Claude runs on a flat plan record 0 cents, so budgets never move), tokens, run time (typical and slowest 10%), retries, continuation wakes, why runs were cancelled, failures by code, runs that hit the plan limit, cost per finished issue, code-review coverage and latency, and the last day's spend against the usual. Also per client: agent effort against what each customer paid.",
    parametersSchema: schema([], {
      windowHours: { type: "integer", minimum: 1, maximum: 1440, description: "How far back to measure, in hours (default 168, one week)." },
      parts: { type: "array", items: { type: "string", enum: ["agents", "projects", "trees", "review", "limits", "clients"] }, description: "Which parts to read (default all but clients). Ask for \"clients\" for effort against revenue." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.closeout,
    displayName: "Open a close-out review",
    description:
      "Open the close-out review for one finished project or epic now, with the numbers already gathered (cost, retries, who worked on it) and a checklist. The Cockpit opens these by itself when a project is set to completed, an epic closes, a project finishes, or an evergreen project has closed 40 issues of real work (at most one every two weeks; routine runs and plugin housekeeping are not counted); use this for work you judge done, or a milestone you want to look at. One review per project or epic per day.",
    parametersSchema: schema([], {
      projectId: { type: "string", description: "A Paperclip project id (a uuid from the issue or the measure report) or the project's exact name." },
      issueId: { type: "string", description: "An issue id or identifier such as PAR-12: the review covers its whole epic (the top issue and everything under it)." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.improvementPropose,
    displayName: "Record an improvement",
    description:
      "Write down a change to how the system or an agent works (a skill, an instruction, a routine, a plugin, who does what) together with the number it should move: where it stands now, the target, who owns it and when to look again. The Cockpit measures the number again on that date and records improved, no change or worse with both numbers. The baseline is measured now for a metric it reads. Use it for every proposal in the weekly retro and every close-out review.",
    parametersSchema: schema(["title", "metricKey"], {
      title: { type: "string", maxLength: 160, description: "One line saying what changes, e.g. \"Developer skill: run the build before closing\"." },
      kind: { type: "string", enum: [...IMPROVEMENT_KINDS], description: "What kind of change: skill, instruction, routine, plugin, agent or system (default system)." },
      targetRef: { type: "string", maxLength: 120, description: "What is changed: a skill slug, an agent name, a routine, a plugin." },
      summary: { type: "string", maxLength: 600, description: "What exactly changes and why you expect it to move the number." },
      metricKey: METRIC_KEY,
      metricLabel: { type: "string", maxLength: 160, description: "A name for the number, for a manual or module metric (e.g. \"Minutes per client report\")." },
      direction: { type: "string", enum: ["lower", "higher"], description: "Which way is better. Needed for kpi and manual metrics; the built-in company and agent metrics know." },
      baselineValue: { type: "number", description: "Where the number stands now. Leave out for a metric the Cockpit reads: it measures it now. Required for manual." },
      targetValue: { type: "number", description: "The number to reach. It must be on the better side of the baseline." },
      recheckInDays: { type: "integer", minimum: 1, maximum: 120, description: "Days until it is measured again (default 14). Give the change time to show." },
      recheckAt: { type: "string", description: "Or the exact date to measure again, YYYY-MM-DD." },
      ownerAgentId: { type: "string", description: "The agent that owns the change (default: you)." },
      sourceIssueId: { type: "string", description: "The issue the proposal came from (a retro, a close-out review), for the record." },
      sourceFactId: { type: "string", description: "A memory fact that describes how a tool behaves and belongs in its skill: the improvement tracks folding it in, and resolving with archiveFact archives the fact once the skill carries it." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.improvementList,
    displayName: "Improvements",
    description: "The improvements ledger: open ones with their baseline, target and re-check date (overdue first), and recent outcomes. The Operator's brief carries the open and overdue ones; use this for the full list.",
    parametersSchema: schema([], {
      status: { type: "string", enum: ["open", "resolved", "dropped", "all"], description: "Which to list (default open)." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many (default 30)." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.improvementResolve,
    displayName: "Resolve an improvement",
    description:
      "Close an improvement with its verdict. For a metric the Cockpit reads it measures the number now and compares it with the baseline (improved, no change or worse). For a manual metric pass resultValue. Pass drop to close one that was not done or no longer matters. archiveFact archives the memory fact an improvement folded into a skill, once the skill carries it.",
    parametersSchema: schema(["id"], {
      id: { type: "string", description: "The improvement id (from improvement-list or the brief)." },
      resultValue: { type: "number", description: "The number measured now (needed for a manual metric; overrides the Cockpit's own reading)." },
      note: { type: "string", maxLength: 400, description: "One line on what you saw." },
      drop: { type: "boolean", description: "True to close it without a verdict: it was not done or no longer matters." },
      archiveFact: { type: "boolean", description: "True to archive the memory fact this improvement folds into a skill." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.goalSet,
    displayName: "Set a company goal",
    description:
      `Propose or change a business goal: a number a module or the Cockpit reports, the target, which way is better and the period. Your goals are proposals: the Cockpit asks the owner once, for all of them together, and they become active on their yes (do not ask yourself). Changing the target of an active goal makes it a proposal again. For a goal measured by hand (metricKey manual) pass value to record this week's actual. Call goal-list with sources first to see which numbers exist. Aim for about 3 goals.`,
    parametersSchema: schema([], {
      id: { type: "string", description: "The goal id to change (from goal-list). Leave out to propose a new goal." },
      title: { type: "string", maxLength: 120, description: "One line the owner would say, e.g. \"30 new leads a week\"." },
      description: { type: "string", maxLength: 400, description: "Why it matters." },
      metricKey: METRIC_KEY,
      metricLabel: { type: "string", maxLength: 120, description: "A name for the number." },
      unit: { type: "string", maxLength: 20, description: "The unit, e.g. leads, posts, ZAR, %." },
      targetValue: { type: "number", description: "The number to reach (a single number). It must be on the better side of where the number stands now." },
      direction: { type: "string", enum: ["lower", "higher"], description: "Which way is better (default: higher for a module's number, the built-in direction for a company metric)." },
      baselineValue: { type: "number", description: "Where the number stands now (measured for you when the Cockpit can read it)." },
      period: { type: "string", enum: [...GOAL_PERIODS], description: "How often the number is compared with the target (default week)." },
      dueOn: { type: "string", description: "A date, YYYY-MM-DD, for a one-off goal: it is achieved when reached and missed when the date passes first." },
      ownerAgentId: { type: "string", description: "The agent that drives the goal (default: you)." },
      value: { type: "number", description: "For a manual goal: this week's actual number." },
      drop: { type: "boolean", description: "True to drop a goal that is still only a proposal." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.goalList,
    displayName: "Company goals",
    description: "The company's goals with the number each is at now, how far along it is, and the change since last week. With sources, also the numbers you can base a goal on: the Cockpit's own measures and everything the modules report (leads, keyword rank, posts published, revenue).",
    parametersSchema: schema([], {
      sources: { type: "boolean", description: "Also list the metric keys a goal can use, with their current numbers." },
      status: { type: "string", enum: ["active", "proposed", "all"], description: "Which goals (default active and proposed)." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.credentialList,
    displayName: "Credentials register",
    description:
      "The register of credentials and secrets the company depends on: name, system, owner, where it lives, when it expires (30 and 7 days before an expiry the Cockpit raises a health alert), how to rotate it and when it was last checked. It holds names and places only, never a value. With verify the Cockpit calls each provider it has a company secret for, once, and records whether the credential is still accepted (one that was checked in the last 15 minutes is not called again).",
    parametersSchema: schema([], {
      verify: { type: "boolean", description: "True to check the credentials that can be checked now (one cheap call each) before listing." },
      includeRetired: { type: "boolean", description: "Also list retired credentials." },
    }),
  },
  {
    name: OPS_TOOL_NAMES.credentialRecord,
    displayName: "Record a credential",
    description:
      "Add or update one entry of the credentials register: after a rotation (new expiry, still valid), when a new key is created, to mark one retired or burned (exposed), or to note you checked it by hand. Any agent may add an entry and fix its details; marking one verified or changing its status clears alerts, so only the Operator may do those. Never put the secret value in any field: the register holds names and places only, and the tool refuses anything that looks like a key.",
    parametersSchema: schema([], {
      id: { type: "string", description: "The entry to update (from credential-list). Leave out to add a new one (then name and system are required)." },
      name: { type: "string", maxLength: 120, description: "What it is, e.g. \"Resend API key\"." },
      system: { type: "string", maxLength: 120, description: "The service it belongs to, e.g. \"Resend\"." },
      livesIn: { type: "string", maxLength: 200, description: "Where it is kept: which company secret, file or console. Never the value." },
      owner: { type: "string", maxLength: 80, description: "Who owns it and rotates it." },
      expiresAt: { type: "string", description: "The expiry date, YYYY-MM-DD, or an empty string when it has none." },
      expiryNote: { type: "string", maxLength: 300, description: "What is known about the expiry when there is no date (e.g. \"unknown\", \"never\")." },
      rotateHow: { type: "string", maxLength: 300, description: "How to rotate it, in one or two steps." },
      rotateHref: { type: "string", maxLength: 300, description: "A link to where it is rotated: an https address or a Paperclip path." },
      verifyWith: { type: "string", enum: [...VERIFY_PROVIDERS, "none"], description: "A provider the daily check can call it against (needs a company secret under Credential checks in the Cockpit settings), or none." },
      status: { type: "string", enum: ["active", "retired", "burned"], description: "active; retired once replaced and revoked; burned when it was published or leaked and must be rotated. Operator only." },
      notes: { type: "string", maxLength: 300, description: "Anything worth knowing." },
      markVerified: { type: "boolean", description: "True when you just confirmed it still works by hand. Operator only." },
    }),
  },
];

export const OPS_TOOL_SET = new Set<string>(Object.values(OPS_TOOL_NAMES));
