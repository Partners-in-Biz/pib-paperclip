/**
 * Declarations of the acceptance tools (exposed as `partnersinbiz.cockpit:<name>`):
 * `acceptance-run` works a journey on the canary client step by step and
 * `acceptance-report` reads (and, if filing failed, files) what a run found. No
 * worker imports, so the manifest can load them.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { JOURNEYS } from "./journeys.js";

export const ACCEPTANCE_TOOL_NAMES = {
  run: "acceptance-run",
  report: "acceptance-report",
} as const;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const ACCEPTANCE_TOOLS: PluginToolDeclaration[] = [
  {
    name: ACCEPTANCE_TOOL_NAMES.run,
    displayName: "Run an acceptance journey",
    description:
      "Work a scripted customer journey on the CANARY client, one step at a time, the way a customer would, and have the Cockpit check every step. start (journey, client from partnersinbiz.crm:create-canary-client, issueId of your request) gives you step 1; make the call it names with the input it gives (adapt only what its note says), then record (runId, stepId, the input you actually used, the tool's data as output, or error, and evidence) to get the next step, until it says the run is finished. The Cockpit refuses any client that is not the canary, stops the run if a step used a real address or another client, looks up what it can itself (an issue exists, an approval reached somebody, a screenshot is on disk) and writes the report and one issue per failed step for the role that owns it. A step you cannot prove is a failed step: report what happened, never what you expected, and do not work around a failure. skip only where the step says it may be skipped. abort ends a run (a module that is off). next shows the step you are on again; list shows the journeys and recent runs. Never approve, send, publish or pay anything.",
    parametersSchema: schema(["action"], {
      action: { type: "string", enum: ["list", "start", "next", "record", "abort"], description: "What to do." },
      journey: { type: "string", enum: JOURNEYS.map((j) => j.key), description: "start: which journey." },
      client: { type: "string", description: "start: the canary client, company:canary-<id>, exactly as create-canary-client returned it." },
      issueId: { type: "string", description: "start: the acceptance request issue you were woken on (id or identifier). The report is written there." },
      runId: { type: "string", description: "next, record, abort: the run." },
      stepId: { type: "string", description: "record: the step you are recording (the one the Cockpit gave you)." },
      input: { type: "object", description: "record: the input you actually passed to the tool (or the curl command as {curl}). It is checked: a real address or another client fails the step and aborts the run." },
      output: { description: "record: what the step returned, as the tool's data object (or {status, body} for an http step, or {issueId} for a check step), exactly as it came back." },
      error: { type: "string", description: "record: the error the step gave, if it failed. Do not retry to hide it." },
      evidence: {
        type: "array",
        maxItems: 8,
        description: "record: what the step asks you to attach.",
        items: {
          type: "object",
          required: ["kind", "ref"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["screenshot", "curl", "output", "link", "note"], description: "screenshot (a file path from pib-shot), curl (the command), output, link or note." },
            ref: { type: "string", maxLength: 600, description: "The file path, command, link or text." },
            note: { type: "string", maxLength: 300, description: "What it shows." },
          },
        },
      },
      skip: { type: "string", maxLength: 300, description: "record: why the step was skipped. Only a step marked mayBeSkipped may be, and only for a reason the product gave (a module that is off)." },
      reason: { type: "string", maxLength: 300, description: "abort: why." },
    }),
  },
  {
    name: ACCEPTANCE_TOOL_NAMES.report,
    displayName: "Acceptance report",
    description:
      "What an acceptance run found: with runId, the run's report (every step, what was checked, the failures with their issues, the evidence); with journey, that journey's latest run; with neither, the latest run of every journey and how many pass. Read-only, except file true: when a finished run's report or failure issues were not filed, files them (nothing is filed twice). Use it to answer \"does the product work for a customer today?\".",
    parametersSchema: schema([], {
      runId: { type: "string", description: "A run id (from acceptance-run or the list)." },
      journey: { type: "string", enum: JOURNEYS.map((j) => j.key), description: "The latest run of this journey." },
      file: { type: "boolean", description: "True to file a finished run's report and failure issues again if they are missing." },
    }),
  },
];

export const ACCEPTANCE_TOOL_SET = new Set<string>(Object.values(ACCEPTANCE_TOOL_NAMES));
