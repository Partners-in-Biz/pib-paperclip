/**
 * Declarations of the Cockpit's growth ledger and metric tools (exposed as
 * `partnersinbiz.cockpit:<name>`). No worker imports, so the manifest can load them.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const GROWTH_TOOL_NAMES = {
  recordMetric: "record-metric",
  ledger: "growth-ledger",
  ledgerUpsert: "ledger-upsert",
} as const;

const SCOPE = "A scope key: own, client:company:<id>, client:contact:<id>, product:<projectId> or book:<projectId>.";
const VERDICT: JsonSchema = { type: "string", enum: ["win", "loss", "no_change", "inconclusive"], description: "The experiment's verdict." };
const DECISION: JsonSchema = { type: "string", enum: ["kept", "discarded", "pending"], description: "What was decided about the playbook change." };

export const GROWTH_TOOLS: PluginToolDeclaration[] = [
  {
    name: GROWTH_TOOL_NAMES.recordMetric,
    displayName: "Record a growth metric",
    description:
      "Record one channel number for one scope and window (e.g. website conversions for client:company:<id> in 2026-W41). The same channel, scope, metric and window keeps one number: calling again replaces it, so a retry never double counts.",
    parametersSchema: schema(["channel", "subject", "metric", "window", "value"], {
      channel: { type: "string", maxLength: 60, description: "The channel, e.g. website, aso, book, revenue, social, seo, campaigns." },
      subject: { type: "string", description: SCOPE },
      metric: { type: "string", maxLength: 80, description: "The metric name, e.g. conversions." },
      window: { type: "string", maxLength: 40, description: "The window the number covers, e.g. 2026-W41 or 2026-10." },
      value: { type: "number", description: "The number." },
      source: { type: "string", enum: ["tool", "csv"], description: "Where it came from (default tool)." },
    }),
  },
  {
    name: GROWTH_TOOL_NAMES.ledger,
    displayName: "Growth ledger",
    description:
      "The growth ledger: every experiment verdict and playbook decision the channels reported, newest first, for this company. Filter by channel, scope or experiment. Read it before proposing a new experiment so a lost idea is not run again.",
    parametersSchema: schema([], {
      channel: { type: "string", maxLength: 60, description: "Only this channel." },
      scope: { type: "string", description: SCOPE },
      experimentId: { type: "string", maxLength: 80, description: "Only this experiment." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "How many rows (default 50)." },
    }),
  },
  {
    name: GROWTH_TOOL_NAMES.ledgerUpsert,
    displayName: "Add a verdict to the growth ledger",
    description:
      "Add an experiment verdict the ledger is missing. Verdict events are best effort, so the weekly review reads each channel's list-experiments and adds any verdict that is not in growth-ledger. Safe to repeat: a verdict and decision already recorded for the experiment is left as it is (the reply says created: false).",
    parametersSchema: schema(["channel", "scope", "experimentId"], {
      channel: { type: "string", maxLength: 60, description: "The channel that ran the experiment." },
      scope: { type: "string", description: SCOPE },
      experimentId: { type: "string", maxLength: 80, description: "The experiment id from the channel's list-experiments." },
      verdict: VERDICT,
      relativeChange: { type: "number", description: "The relative change of the winning arm against the control (0.12 is 12% better)." },
      items: { type: "integer", description: "How many items were measured." },
      minPerArm: { type: "integer", description: "The minimum per arm the experiment required." },
      playbookDecision: DECISION,
      decidedBy: { type: "string", maxLength: 120, description: "Who decided." },
      decidedAt: { type: "string", description: "When it was decided (ISO date and time; default now). Use the experiment's own time so a repeat is recognised." },
    }),
  },
];

export const GROWTH_TOOL_SET = new Set<string>(Object.values(GROWTH_TOOL_NAMES));
