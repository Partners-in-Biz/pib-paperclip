/**
 * Company memory: the contract every PiB agent follows.
 *
 * Saving: agents end a closing comment with **Learned:** bullets and the
 * Cockpit saves them (no tool call needed); memory-add is for pinning,
 * expiry, another client, or replacing a fact.
 *
 * The Cockpit keeps short, tagged facts that agents learn (a client's
 * preference, a fact about their site, a lesson, a warning). When an agent
 * starts a task it asks for a **memory brief**: the Cockpit picks candidate
 * facts for the task's client and area, Jev (when set up) keeps only the ones
 * this task needs, and the brief is capped (at most 12 facts, about 1,500
 * tokens). Agents never load all of memory, so their context stays small no
 * matter how much the company has learned. Without Jev the brief falls back to
 * the best keyword and recency matches, under the same cap.
 *
 * `withFrontmatter` appends `COMPANY_MEMORY_SECTION` to every PiB skill, so a
 * change here reaches every agent through the versioned skill sync.
 */
import { PIB_PLUGINS } from "./contracts.js";

export const MEMORY_PLUGIN_KEY = PIB_PLUGINS.cockpit;

export const MEMORY_AREAS = [
  "seo",
  "social",
  "crm",
  "mailbox",
  "campaigns",
  "billing",
  "accounting",
  "payroll",
  "partners",
  "operations",
  "general",
] as const;
export type MemoryArea = (typeof MEMORY_AREAS)[number];

export const MEMORY_KINDS = ["fact", "preference", "rule", "lesson", "warning"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Hard limits shared by the Cockpit, its page and the skill text. */
export const MEMORY_LIMITS = {
  /** Longest fact, in characters. One fact per entry. */
  factMaxChars: 300,
  factMinChars: 12,
  /** A brief never has more facts than this. */
  briefMaxFacts: 12,
  /** Nor more than about this many tokens. */
  briefMaxTokens: 1500,
  /** Pinned rules per client and area (they are always in the brief). */
  pinnedMaxPerScope: 5,
  /** Search results per call. */
  searchMaxResults: 10,
} as const;

export const MEMORY_TOOLS = {
  recall: "memory-recall",
  add: "memory-add",
  update: "memory-update",
  search: "memory-search",
  feedback: "memory-feedback",
  review: "memory-review",
} as const;

/** `partnersinbiz.cockpit:memory-recall` etc. */
export function memoryTool(name: (typeof MEMORY_TOOLS)[keyof typeof MEMORY_TOOLS]): string {
  return `${MEMORY_PLUGIN_KEY}:${name}`;
}

const AREA_BY_PLUGIN: Record<string, MemoryArea> = {
  [PIB_PLUGINS.seo]: "seo",
  [PIB_PLUGINS.social]: "social",
  [PIB_PLUGINS.crm]: "crm",
  [PIB_PLUGINS.mailbox]: "mailbox",
  [PIB_PLUGINS.campaigns]: "campaigns",
  [PIB_PLUGINS.billing]: "billing",
  [PIB_PLUGINS.accounting]: "accounting",
  [PIB_PLUGINS.payroll]: "payroll",
  [PIB_PLUGINS.partners]: "partners",
  [PIB_PLUGINS.cockpit]: "operations",
  [PIB_PLUGINS.setup]: "operations",
};

/** The memory area of work a plugin's issues belong to, or null. */
export function memoryAreaForPlugin(pluginKey: string | null | undefined): MemoryArea | null {
  return pluginKey ? AREA_BY_PLUGIN[pluginKey] ?? null : null;
}

/** Area from an issue's `originKind`, e.g. `plugin:partnersinbiz.seo` or `plugin:partnersinbiz.cockpit:health`. */
export function memoryAreaForOrigin(originKind: string | null | undefined): MemoryArea | null {
  const match = typeof originKind === "string" ? /^plugin:([a-z0-9.-]+)/i.exec(originKind) : null;
  return match ? memoryAreaForPlugin(match[1]!.toLowerCase()) : null;
}

export function isMemoryArea(value: unknown): value is MemoryArea {
  return typeof value === "string" && (MEMORY_AREAS as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export const COMPANY_MEMORY_HEADING = "## Company memory";

const recall = `\`${memoryTool(MEMORY_TOOLS.recall)}\``;
const add = `\`${memoryTool(MEMORY_TOOLS.add)}\``;
const search = `\`${memoryTool(MEMORY_TOOLS.search)}\``;
const feedback = `\`${memoryTool(MEMORY_TOOLS.feedback)}\``;

export const COMPANY_MEMORY_SECTION = `${COMPANY_MEMORY_HEADING}

The company remembers what its agents learn. You get only what the task needs, never all of it.

- **Start** every task with ${recall} (\`issueId\`, plus \`client\` when the work is for a client). It returns a short brief of at most ${MEMORY_LIMITS.briefMaxFacts} facts picked for this task. Follow them unless the task or a person says otherwise. If you need more, use ${search} with a specific query; never try to read all of memory.
- **Close**: end your closing comment with **Learned:** and one bullet per thing that will matter next time (at most ${MEMORY_LIMITS.factMaxChars} characters each; start a bullet with \`Rule:\`, \`Warning:\` or \`Preference:\` when it is one). They are saved to company memory automatically for this issue's client and area, skipping duplicates and anything that looks like a secret. Write \`**Learned:** none\` when nothing will. Good: a client preference, a fact about their site, accounts or systems, what worked or failed and why, a workaround. Not: routine progress (the issue has it), secrets, tokens, passwords or personal data beyond business contact details.
- Use ${add} instead to pin a must-follow rule, set an expiry date, file a fact under a different client, or replace an older fact (\`supersedes\` with its id).
- **Tune it**: if the brief missed something you needed, or gave you something useless, call ${feedback} once with the ids.
`;

/** Appends the company memory section once. */
export function withCompanyMemory(body: string): string {
  if (body.includes(COMPANY_MEMORY_HEADING)) return body;
  return `${body.trimEnd()}\n\n${COMPANY_MEMORY_SECTION}`;
}

/** One line for a hire's AGENTS.md so the rule is in the agent's own instructions too. */
export const COMPANY_MEMORY_INSTRUCTION =
  `Company memory: start each task with ${recall} and follow the brief; end your closing comment with **Learned:** bullets for anything that will matter next time (saved automatically). Your skills describe how (section "Company memory").`;
