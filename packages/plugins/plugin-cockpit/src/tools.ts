/**
 * Agent tool declarations (exposed as `partnersinbiz.cockpit:<name>`). They
 * read the Cockpit projection and host records. Writes: `post-daily-brief`
 * (a comment on the week's Daily brief issue), `ask-owner` (a question to
 * the owner on the agent's issue) and `update-company-profile` (empty
 * fields only).
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_KINDS, ASK_LIMITS } from "./ask-model.js";
import { MEMORY_TOOL_DECLARATIONS } from "./memory/declarations.js";
import { BANNED_WORDS_MAX, PROFILE_FIELDS } from "./profile-model.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const TOOL_NAMES = {
  brief: "company-brief",
  health: "health-issues",
  waiting: "waiting-on-owner",
  scorecards: "agent-scorecards",
  postBrief: "post-daily-brief",
  askOwner: "ask-owner",
  profile: "company-profile",
  updateProfile: "update-company-profile",
} as const;

const PROFILE_PROPERTIES: Record<string, JsonSchema> = Object.fromEntries(
  PROFILE_FIELDS.map((field) => [
    field.key,
    field.kind === "list"
      ? { type: "array", items: { type: "string", maxLength: field.max }, maxItems: BANNED_WORDS_MAX, description: `${field.label}: ${field.hint}` }
      : { type: "string", maxLength: field.max, description: `${field.label}: ${field.hint}` },
  ]),
);

export const COCKPIT_TOOLS: PluginToolDeclaration[] = [
  {
    name: TOOL_NAMES.brief,
    displayName: "Company brief",
    description:
      "Everything on the Cockpit in compact JSON: what waits on the owner (questions agents asked first, then money and legal, with links and why), asks (each open question with its age), stuckFlows (the 5 stages of the company graph where work is stuck, with who it waits on), unassigned (open issues nobody holds, older than a day), team (the agent in each role), system health (worst first, with fixes), KPIs by group, recent activity per agent, and every agent with status, last run, spend vs budget and quality metrics. Start every operations review here.",
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
      "What waits on a person right now, deduped: questions agents asked the owner first, then money, legal, grants, judgement, reviews (oldest first): approval issues, open Paperclip approvals, issues assigned to the owner, unassigned work, missing setup items. Check each one: if an agent could do it, hand it to that agent instead.",
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
  {
    name: TOOL_NAMES.askOwner,
    displayName: "Ask the owner",
    description:
      "Ask the owner for a decision, a one-time grant (a login consent, a key, a DNS record), money, legal or information you cannot get elsewhere. Once per issue; asking again updates the question. The issue goes to the owner (in review), shows first in the Cockpit's Waiting on you and the daily brief, and comes back to you with the answer (you are woken on it). Not for sending, publishing or paying: those go through the module's approval tool. Returns askId, the issue link and what happens next.",
    parametersSchema: schema(["issueId", "question", "why", "kind"], {
      issueId: { type: "string", description: "The issue you are working on, which waits for the answer (id or identifier, e.g. PIB-23)." },
      question: { type: "string", maxLength: ASK_LIMITS.question, description: `One clear question (at most ${ASK_LIMITS.question} characters).` },
      options: { type: "array", items: { type: "string", maxLength: ASK_LIMITS.optionChars }, maxItems: ASK_LIMITS.options, description: `Up to ${ASK_LIMITS.options} choices, your recommendation first. Omit for an open question.` },
      why: { type: "string", maxLength: ASK_LIMITS.why, description: `Why it matters and what waits on it (at most ${ASK_LIMITS.why} characters).` },
      kind: { type: "string", enum: [...ASK_KINDS], description: "decision (a judgement call), grant (a login, key or DNS record only they can give), money, legal, or info (a fact only they know)." },
      links: {
        type: "array",
        maxItems: ASK_LIMITS.links,
        description: "Where to act or read: Paperclip paths (/PIB/issues/PIB-3, /PIB/social?client=company:<id>&tab=accounts) or https addresses.",
        items: {
          type: "object",
          required: ["label", "href"],
          additionalProperties: false,
          properties: {
            label: { type: "string", maxLength: ASK_LIMITS.linkLabel, description: "What the link opens, e.g. \"Connect Instagram\"." },
            href: { type: "string", maxLength: ASK_LIMITS.linkHref, description: "A Paperclip path or an https address." },
          },
        },
      },
      steps: { type: "array", items: { type: "string", maxLength: ASK_LIMITS.stepChars }, maxItems: ASK_LIMITS.steps, description: `Exact steps for anything they must do themselves, in order (up to ${ASK_LIMITS.steps}).` },
      client: { type: "string", pattern: "^(company|contact):[A-Za-z0-9_-]{1,128}$", description: "The client it is about: \"company:<crm id>\" or \"contact:<crm id>\". Omit for own work." },
      dueBy: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "When you need the answer by, YYYY-MM-DD." },
    }),
  },
  {
    name: TOOL_NAMES.profile,
    displayName: "Company profile",
    description:
      "The company's own profile: legal and trading name, VAT number, address, website, booking link, sender name and email, what we sell, audience, brand voice and banned words. Read it before writing anything in the company's name (posts, emails, invoices, replies). For a client's details use the CRM's client profile. Returns the profile, the missing fields and the page where the owner edits it.",
    parametersSchema: schema([], {}),
  },
  {
    name: TOOL_NAMES.updateProfile,
    displayName: "Fill in the company profile",
    description:
      "Fill EMPTY fields of the company profile from what you found (the website, past work). Fields that already have a value are never changed: to change one, ask the owner with ask-owner (kind decision) and quote the new value. Returns which fields were filled, which were kept and why.",
    parametersSchema: schema([], {
      ...PROFILE_PROPERTIES,
      issueId: { type: "string", description: "The issue you are working on, for the record (optional)." },
    }),
  },
  ...MEMORY_TOOL_DECLARATIONS,
];
