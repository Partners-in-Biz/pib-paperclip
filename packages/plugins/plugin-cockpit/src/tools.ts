/**
 * Agent tool declarations (exposed as `partnersinbiz.cockpit:<name>`). They
 * read the Cockpit projection and host records; `post-daily-brief` is the
 * only write (one comment on the week's Daily brief issue).
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const TOOL_NAMES = {
  brief: "company-brief",
  health: "health-issues",
  waiting: "waiting-on-owner",
  scorecards: "agent-scorecards",
  postBrief: "post-daily-brief",
} as const;

export const COCKPIT_TOOLS: PluginToolDeclaration[] = [
  {
    name: TOOL_NAMES.brief,
    displayName: "Company brief",
    description:
      "Everything on the Cockpit in compact JSON: what waits on the owner (money and legal first, with links and why), system health (worst first, with fixes), KPIs by group (money, pipeline, marketing, delivery), recent activity per agent, and every agent with status, last run, spend vs budget and quality metrics. Start every operations review here.",
    parametersSchema: schema([], {
      windowHours: { type: "integer", description: "Activity window in hours (default 24; 168 for the weekly retro)", minimum: 1, maximum: 720 },
    }),
  },
  {
    name: TOOL_NAMES.health,
    displayName: "Health issues",
    description:
      "System health problems across every PiB plugin, worst first: failing jobs, stuck deliveries, expired connections, plugins not reporting, agents in error or at 80%+ of their budget. Each has detail, a link and what to do.",
    parametersSchema: schema([], {
      includeWarnings: { type: "boolean", description: "Include warnings as well as problems (default true)" },
    }),
  },
  {
    name: TOOL_NAMES.waiting,
    displayName: "Waiting on the owner",
    description:
      "What waits on a person right now, deduped and ordered money, legal, grants, judgement, reviews (oldest first): approval issues, open Paperclip approvals, issues assigned to the owner, missing setup items. Check each one: if an agent could do it, hand it to that agent instead.",
    parametersSchema: schema([], {}),
  },
  {
    name: TOOL_NAMES.scorecards,
    displayName: "Agent scorecards",
    description:
      "One scorecard per agent: status, last run, runs and failed runs in the last 7 days, spend vs monthly budget, and quality metrics the plugins report (rejections, corrections, failures). Use it for the weekly retro.",
    parametersSchema: schema([], {}),
  },
  {
    name: TOOL_NAMES.postBrief,
    displayName: "Post the daily brief",
    description:
      "Posts the daily brief as a comment on this week's pinned \"Daily brief\" issue (one issue per week, assigned to the owner; created on first use). Markdown: done yesterday, waiting on you (with links), risks, today's plan. Keep it short.",
    parametersSchema: schema(["body"], {
      body: { type: "string", description: "The brief in markdown (max 8000 characters)" },
    }),
  },
];
