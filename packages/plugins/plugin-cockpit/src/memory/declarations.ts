/**
 * Memory tool declarations (exposed as `partnersinbiz.cockpit:memory-*`).
 * No worker imports, so the manifest can load them.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { MEMORY_AREAS, MEMORY_KINDS, MEMORY_LIMITS, MEMORY_TOOLS } from "@partnersinbiz/pib-plugin-kit";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const client: JsonSchema = {
  type: "string",
  description: 'The client the work is for: "company:<crm id>" or "contact:<crm id>" (or a client name memory already knows). "own" = the company\'s own work. Omit to let memory detect it from the issue.',
};
const clientName: JsonSchema = { type: "string", description: "The client's name, needed the first time a client is used (e.g. \"Northwind Traders\")." };
const area: JsonSchema = { type: "string", enum: [...MEMORY_AREAS], description: "Area of work. Omit to take it from the issue." };
const issueId: JsonSchema = { type: "string", description: "The issue you are working on (id or identifier, e.g. PIB-23)." };
const ids: JsonSchema = { type: "array", items: { type: "string" }, maxItems: 20 };

export const MEMORY_TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: MEMORY_TOOLS.recall,
    displayName: "Memory brief",
    description: `Start every task with this. Returns a short brief of only the facts this task needs (at most ${MEMORY_LIMITS.briefMaxFacts}), picked from everything the company learned for this client and area. Follow them unless the task or a person says otherwise. The same call within 10 minutes returns the same brief.`,
    parametersSchema: schema([], {
      issueId,
      client,
      clientName,
      area,
      query: { type: "string", description: "Optional focus, e.g. \"tone for LinkedIn posts\". Without issueId it is the whole question." },
      fresh: { type: "boolean", description: "Build a new brief even if one was made in the last 10 minutes." },
    }),
  },
  {
    name: MEMORY_TOOLS.add,
    displayName: "Save to memory",
    description: `Save one lasting fact (at most ${MEMORY_LIMITS.factMaxChars} characters) that will help the next task: a client preference, a fact about their site, accounts or systems, what worked or failed and why, a workaround, a warning. Not routine progress, and never secrets, tokens, passwords, card or ID numbers. Duplicates are detected. Pass supersedes when it replaces an older fact.`,
    parametersSchema: schema(["text"], {
      text: { type: "string", description: "One fact, plain words, one line." },
      client,
      clientName,
      area,
      kind: { type: "string", enum: [...MEMORY_KINDS], description: "fact (default), preference, rule, lesson or warning." },
      issueId,
      supersedes: { type: "string", description: "Id of the fact this one replaces (it stops appearing in briefs)." },
      pinned: { type: "boolean", description: `Rules and warnings only: always include in this client's and area's briefs (max ${MEMORY_LIMITS.pinnedMaxPerScope}). Use for must-follow rules.` },
      expiresAt: { type: "string", description: "ISO date after which the fact no longer applies (e.g. a holiday closure)." },
    }),
  },
  {
    name: MEMORY_TOOLS.update,
    displayName: "Update a memory fact",
    description: "Fix a fact (text, kind, area), pin or unpin a rule, set or clear an expiry, archive it (keeps it but stops using it), restore it, or mark it superseded by a newer fact.",
    parametersSchema: schema(["id"], {
      id: { type: "string" },
      text: { type: "string" },
      kind: { type: "string", enum: [...MEMORY_KINDS] },
      area,
      pinned: { type: "boolean" },
      expiresAt: { type: ["string", "null"], description: "ISO date, or null to clear." },
      status: { type: "string", enum: ["active", "archived", "superseded"] },
      supersededBy: { type: "string", description: "With status superseded: the id of the newer fact." },
    }),
  },
  {
    name: MEMORY_TOOLS.search,
    displayName: "Search memory",
    description: `Look something specific up when the brief did not have it. Returns at most ${MEMORY_LIMITS.searchMaxResults} matching facts. Ask a specific question; do not use it to read all of memory.`,
    parametersSchema: schema(["query"], {
      query: { type: "string", description: "What you need to know, e.g. \"Northwind hosting and deploy\"." },
      client,
      area,
      limit: { type: "integer", minimum: 1, maximum: MEMORY_LIMITS.searchMaxResults },
    }),
  },
  {
    name: MEMORY_TOOLS.feedback,
    displayName: "Memory feedback",
    description: "Tell memory how the brief did, once per task: facts you needed but had to find another way (missing: ids from memory-search, or missingText), facts that were useless for this task (noise: ids from the brief), or facts that are wrong (wrong: ids). It tunes future briefs.",
    parametersSchema: schema([], {
      briefId: { type: "string", description: "From the brief's first line." },
      issueId,
      missing: { ...ids, description: "Ids of stored facts the brief should have included." },
      missingText: { type: "string", description: "Knowledge you needed that memory does not have (then save it with memory-add if it is lasting)." },
      noise: { ...ids, description: "Ids in the brief that did not help with this task." },
      wrong: { ...ids, description: "Ids of facts that are no longer true (fix them with memory-update)." },
    }),
  },
  {
    name: MEMORY_TOOLS.review,
    displayName: "Memory review",
    description: "For the Operator's weekly retro: memory size and growth, briefs this week (Jev vs keyword baseline, average size), feedback (missing and noisy facts), likely duplicates to merge, noisy facts to fix or archive, and stale facts.",
    parametersSchema: schema([], {}),
  },
];

export const MEMORY_TOOL_NAMES = new Set<string>(MEMORY_TOOL_DECLARATIONS.map((t) => t.name));
