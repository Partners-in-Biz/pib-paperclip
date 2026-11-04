/**
 * Declarations of the reviewer findings tools (W1c H1), exposed as `partnersinbiz.cockpit:<name>`.
 * No worker imports, so the manifest can load them.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

export const FINDING_OUTCOMES = ["fixed", "wrong", "intentional", "did_not_matter"] as const;
export type FindingOutcome = (typeof FINDING_OUTCOMES)[number];

export const REVIEW_FINDING_TOOL_NAMES = {
  record: "review-finding-record",
  outcome: "review-outcome-set",
} as const;

export const REVIEW_FINDING_TOOL_SET = new Set<string>(Object.values(REVIEW_FINDING_TOOL_NAMES));

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const REVIEW_FINDING_TOOLS: PluginToolDeclaration[] = [
  {
    name: REVIEW_FINDING_TOOL_NAMES.record,
    displayName: "Record a review finding",
    description:
      "For the Code Reviewer: write down one finding from a review, so its outcome can be counted later. The same finding recorded again (same hash) stays one row and only counts as seen again. The author of the work is the issue's assignee unless you name them; it can never be you.",
    parametersSchema: schema(["issueId", "summary"], {
      issueId: { type: "string", description: "The reviewed issue: an id or an identifier such as PAR-12." },
      summary: { type: "string", minLength: 1, maxLength: 600, description: "The finding in one or two sentences, as you wrote it in the review." },
      filePath: { type: "string", maxLength: 240, description: "The file the finding is about, if any." },
      tag: { type: "string", maxLength: 40, description: "The finding's tag from your review comment, e.g. bug, security, test, style." },
      prRef: { type: "string", maxLength: 200, description: "The PR link or owner/repo#number." },
      hash: { type: "string", maxLength: 128, description: "Your own stable key for this finding. Leave out: the Cockpit hashes issue, file and summary." },
      authorAgentId: { type: "string", description: "The agent whose work this is (default: the issue's assignee). Pass it when the issue is assigned to you for review." },
    }),
  },
  {
    name: REVIEW_FINDING_TOOL_NAMES.outcome,
    displayName: "Set a review finding's outcome",
    description:
      "For the author of the reviewed work: say what came of one finding. fixed (it was right and you fixed it), wrong (it was not a real problem), intentional (it was on purpose), did_not_matter (true but not worth the change). Only the work's author or the owner can set it, never the reviewer.",
    parametersSchema: schema(["outcome"], {
      findingId: { type: "string", description: "The finding id from review-finding-record." },
      hash: { type: "string", maxLength: 128, description: "Or the finding's hash." },
      outcome: { type: "string", enum: [...FINDING_OUTCOMES], description: "fixed, wrong, intentional or did_not_matter." },
      note: { type: "string", maxLength: 600, description: "One line on why, mostly for wrong and did_not_matter." },
    }),
  },
];
