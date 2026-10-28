/**
 * Done-checks for the issues the Cockpit opens for agents (kit done-checks).
 * When an agent closes one, the Cockpit checks the outcome in its own
 * records; when the work is not finished the issue reopens with exactly what
 * is missing. A person's close is never checked.
 *
 * The rules run from the Cockpit's one `issue.updated` handler (kit
 * `runDoneCheck`), not kit `registerDoneChecks`: a second subscription to the
 * same event makes the host deliver each event twice, and the worker runs
 * every handler on each delivery, at the same time.
 *
 * - Onboarding (`cockpit:onboarding:<client>`): every checklist line in the
 *   description is ticked (`- [x]`), or a comment ticks it or says why it was
 *   skipped (`Skipped: <item>, because <why>`). The last line ("Close this
 *   issue with links…") is the close itself.
 * - System health (`cockpit:health:<companyId>`): nothing is left on it. The
 *   Cockpit closes it itself once every check is ok, so an early close reopens.
 *
 * - Close-out review (`cockpit:closeout:`) and weekly business review
 *   (`cockpit:business-review:`): the same checklist rule as onboarding.
 *
 * - Spike (any issue with `spike` in the title or `pib:spike` in the description):
 *   needs an `**Evidence:**` comment (or attachment) posted after the plugin deploy
 *   time (plugin_versions.seen_at) and after the issue started. A merged PR is
 *   not a deploy and does not move that time.
 *
 * Issues opened before 0.4.0 carry the same kinds without the plugin part
 * (`onboarding:…`, `health:…`) and are checked the same way.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { runDoneCheck, type DoneCheckIssue, type DoneCheckOutcome, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { LEGACY_ORIGIN_ID, ORIGIN_ID } from "./constants.js";
import type { Env } from "./env.js";
import { collectProblems } from "./health.js";
import type { HealthEntry } from "./merge.js";
import { refreshKitRoles } from "./roles.js";
import { pluginSeenAt } from "./acceptance.js";

// ---------------------------------------------------------------------------
// The onboarding checklist (pure)
// ---------------------------------------------------------------------------

/** A task-list line: `- [ ] text`, `* [x] text`, `1. [X] text`. */
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;

/** Words that mark an item as skipped, in `plainWords` form. */
const SKIP_MARK = /(?:^| )(skip|skipped|skipping|n\/a|not needed|not applicable|not required|no longer needed|does not apply|doesn t apply)(?= |$)/;

/** Words that do not make a reason on their own ("skipped for now" explains nothing). */
const FILLER = new Set(["a", "an", "the", "this", "that", "it", "its", "is", "was", "be", "for", "now", "to", "of", "and", "or", "as", "per", "step", "item", "task", "line", "here", "there", "too", "also", "just", "so", "because", "since", "we", "i", "yet"]);

export interface ChecklistItem {
  /** The line's text after the checkbox. */
  text: string;
  ticked: boolean;
  /** How comments name it: its bold label, else its first six words (plain, lower case). */
  key: string;
  /** How the reopen comment names it. */
  label: string;
  /** "Close this issue …": the close itself, never missing. */
  closing: boolean;
}

/** Lower-case words without markdown (links keep their text, `n/a` keeps its slash). */
export function plainWords(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readable(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

/** The checklist lines of a markdown text, in order. */
export function checklistItems(markdown: string | null | undefined): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const text = match[2]!;
    const bold = /^\*\*(.+?)\*\*/.exec(text.trim())?.[1] ?? null;
    const words = plainWords(text);
    const key = bold ? plainWords(bold) : words.split(" ").slice(0, 6).join(" ");
    if (!key) continue;
    const plain = readable(text);
    const label = bold ? readable(bold) : plain.split(" ").length > 8 ? `${plain.split(" ").slice(0, 8).join(" ")}…` : plain;
    out.push({ text, ticked: match[1] !== " ", key, label, closing: /^close this issue\b/.test(words) });
  }
  return out;
}

function mentions(words: string, key: string): boolean {
  return ` ${words} `.includes(` ${key} `);
}

/** Words of a skip note that explain why, beyond the item's name, the skip word and filler. */
export function reasonWords(words: string, key: string): number {
  const rest = ` ${words} `.replace(` ${key} `, " ").replace(SKIP_MARK, " ");
  return rest.split(" ").filter((word) => word.length > 1 && !FILLER.has(word)).length;
}

/**
 * How a comment settles an item: a ticked line naming it (`- [x] SEO
 * Specialist: sprint created`), or a skip note naming it with a reason of at
 * least two words (`Skipped: SEO Specialist, because the client has no website`).
 */
export function settledIn(body: string, item: Pick<ChecklistItem, "key">): "ticked" | "skipped" | null {
  for (const line of body.split(/\r?\n/)) {
    const task = TASK_LINE.exec(line);
    if (task && task[1] !== " " && mentions(plainWords(task[2]!), item.key)) return "ticked";
    const words = plainWords(line);
    if (SKIP_MARK.test(words) && mentions(words, item.key) && reasonWords(words, item.key) >= 2) return "skipped";
  }
  return null;
}

/** The skip note agents are told to write. */
export const SKIP_HINT = "Tick each one in the checklist (`- [x]`) when it is done, or comment `Skipped: <item>, because <why>` when it does not apply.";

/**
 * The onboarding rule: done when every checklist line is ticked in the
 * description, or ticked or skipped (with a reason) in a comment. No
 * checklist at all is done (a person rewrote the issue).
 */
export function checklistResult(description: string | null | undefined, comments: Array<{ body?: unknown; deletedAt?: unknown }>): DoneCheckResult {
  const bodies = comments.filter((c) => !c.deletedAt && typeof c.body === "string").map((c) => c.body as string);
  const open = checklistItems(description).filter((item) => !item.ticked && !item.closing && !bodies.some((body) => settledIn(body, item)));
  if (open.length === 0) return { done: true };
  return { done: false, missing: [...open.map((item) => `Not ticked: ${item.label}`), SKIP_HINT] };
}

// ---------------------------------------------------------------------------
// System health (pure)
// ---------------------------------------------------------------------------

/** Done when nothing is left on the System health issue. */
export function healthResult(entries: Array<Pick<HealthEntry, "status" | "title">>): DoneCheckResult {
  if (entries.length === 0) return { done: true };
  const lines = entries.slice(0, 5).map((entry) => `${entry.status === "bad" ? "Problem" : "Warning"}: ${entry.title}`);
  if (entries.length > 5) lines.push(`And ${entries.length - 5} more, listed on this issue.`);
  lines.push("Leave this issue open: the Cockpit closes it itself once every check is ok (it updates every hour).");
  return { done: false, missing: lines };
}

// ---------------------------------------------------------------------------
// Spikes (pure)
// ---------------------------------------------------------------------------

export const SPIKE_HINT = "Post a comment that starts with `**Evidence:**` with the live check (tool output or a screenshot from the live host), made after the plugin was deployed. Then close the issue again.";

/** True if the issue is marked as a spike. */
export function isSpike(issue: { title?: string | null; description?: string | null }): boolean {
  const text = `${issue.title ?? ""}\n${issue.description ?? ""}`.toLowerCase();
  return /\bspike\b/.test(text) || /pib:spike\b/.test(text);
}

const SPIKE_PLUGINS = ["crm", "social", "billing", "mailbox", "seo", "partners", "campaigns", "accounting", "payroll", "cockpit", "setup", "ads"];

/** Plugin keys found in text that are known spike plugins, deduplicated. */
export function spikePlugins(text: string): string[] {
  const found = new Set<string>();
  for (const plugin of SPIKE_PLUGINS) {
    if (new RegExp(`\\b(?:plugin-|partnersinbiz\\.)${plugin}\\b`, "i").test(text)) {
      found.add(`partnersinbiz.${plugin}`);
    }
  }
  return Array.from(found);
}

/** The result of a spike done-check. */
export function spikeResult(input: {
  startedAt: string | null;
  comments: Array<{ body?: unknown; deletedAt?: unknown; createdAt?: unknown }>;
  attachments: Array<{ createdAt?: unknown }>;
  deployedAt: Array<{ plugin: string; at: string | null }>;
}): DoneCheckResult {
  const parse = (value: unknown): number | null => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
      const t = Date.parse(value);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  };

  const startedMs = parse(input.startedAt);
  const timestamps: Array<{ ms: number; label: string }> = [];

  if (startedMs) timestamps.push({ ms: startedMs, label: `the issue started at ${new Date(startedMs).toISOString()}` });

  // A merged repo PR is not a deploy: only the plugin's recorded deploy time (below) and the start raise the bar.

  for (const deployed of input.deployedAt) {
    if (deployed.at) {
      const ms = parse(deployed.at);
      if (ms) timestamps.push({ ms, label: `${deployed.plugin.replace("partnersinbiz.", "")} was deployed (${new Date(ms).toISOString()})` });
    }
  }

  const threshold = timestamps.length > 0 ? Math.max(...timestamps.map((t) => t.ms)) : null;
  const thresholdLabel = threshold !== null ? timestamps.find((t) => t.ms === threshold)?.label ?? "" : "";

  // Check for evidence (comment starting with **Evidence:** or any attachment) after the threshold
  const hasEvidence = input.comments.some((c) => {
    if (c.deletedAt || typeof c.body !== "string") return false;
    if (!/\*\*Evidence:\*\*/i.test(c.body as string)) return false;
    const ms = parse(c.createdAt);
    if (!ms) return false;
    return threshold === null || ms > threshold;
  }) || input.attachments.some((a) => {
    const ms = parse(a.createdAt);
    if (!ms) return false;
    return threshold === null || ms > threshold;
  });

  if (hasEvidence) return { done: true };

  const missing: string[] = [];
  if (threshold === null) {
    missing.push("No evidence yet: no comment starting with `**Evidence:**` (or attachment).");
  } else {
    missing.push(`No evidence yet: no comment starting with \`**Evidence:**\` (or attachment) posted after ${thresholdLabel}.`);
  }
  missing.push(SPIKE_HINT);
  // An empty list is "no name matched". A named plugin with no seen_at is a missing
  // record, not a missed name — saying "Name the plugin" here sent a false fix.
  if (input.deployedAt.length === 0) {
    missing.push("The deploy time of the plugin is not known here, so this was checked against the start and merge times only. Name the plugin in the title or description (e.g. `plugin-crm`) so the check can use its deploy time.");
  } else if (input.deployedAt.every((d) => !d.at)) {
    const keys = input.deployedAt.map((d) => d.plugin).join(", ");
    missing.push(`The deploy time of ${keys} is not recorded, so this was checked against the start and merge times only.`);
  }
  return { done: false, missing };
}

/** Checks if a spike issue has evidence, via issue comments and attachments, after the plugin was deployed. */
export async function spikeCheck(env: Env, issue: Pick<DoneCheckIssue, "id" | "companyId">, ctx: PluginContext): Promise<DoneCheckResult> {
  const full = await ctx.issues.get(issue.id, issue.companyId);
  if (!full) return { done: false, missing: ["Issue not found"] };

  const title = full.title ?? "";
  const description = (full as { description?: string | null }).description ?? null;
  const comments = await ctx.issues.listComments(issue.id, issue.companyId);

  let attachments: Array<{ createdAt?: unknown }> = [];
  try {
    const listed = await ctx.issues.listAttachments?.(issue.id, issue.companyId);
    attachments = listed ?? [];
  } catch {
    // Guard against optional capability or test context lacking it
  }

  const pluginNames = spikePlugins(`${title}\n${description}`);
  const deployedAt = await Promise.all(
    pluginNames.map(async (pluginKey) => ({ plugin: pluginKey, at: await pluginSeenAt(env, issue.companyId, pluginKey).catch(() => null) })),
  );

  // Use startedAt if available (the time the issue moved to in_progress), else fall back to createdAt
  const startAtValue = (full as { startedAt?: unknown }).startedAt ?? full.createdAt;
  const startedAt = startAtValue ? (typeof startAtValue === "string" ? startAtValue : new Date(startAtValue as unknown as Date).toISOString()) : null;

  if (deployedAt.length === 0 || deployedAt.some((d) => d.at === null)) {
    ctx.logger.info("Spike done-check: deploy time unknown, used start and merge times", { issueId: issue.id });
  }

  return spikeResult({
    startedAt,
    comments: comments as Array<{ body?: unknown; deletedAt?: unknown; createdAt?: unknown }>,
    attachments,
    deployedAt,
  });
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Reads the onboarding issue's description and comments (host records only). */
export async function onboardingCheck(ctx: PluginContext, issue: Pick<DoneCheckIssue, "id" | "companyId">): Promise<DoneCheckResult> {
  const full = await ctx.issues.get(issue.id, issue.companyId);
  const comments = await ctx.issues.listComments(issue.id, issue.companyId);
  return checklistResult(full?.description ?? null, comments as Array<{ body?: unknown; deletedAt?: unknown }>);
}

/**
 * The Cockpit's rules. Before an unfinished close is reopened (and, the third
 * time, handed to the Operator), the kit's copy of the team is refreshed so
 * the hand-over reaches the right agent.
 */
export function cockpitDoneRules(env: Env): DoneCheckRule[] {
  const guarded = (check: (issue: DoneCheckIssue, ctx: PluginContext) => Promise<DoneCheckResult>) => async (issue: DoneCheckIssue, ctx: PluginContext) => {
    const result = await check(issue, ctx);
    if (!result.done) await refreshKitRoles(env, issue.companyId).catch(() => undefined);
    return result;
  };
  const onboarding = guarded((issue, ctx) => onboardingCheck(ctx, issue));
  const health = guarded(async (issue) => healthResult((await collectProblems(env, issue.companyId)).entries));
  // The close-out and business reviews carry a checklist like onboarding: closed with lines unticked and unexplained, they reopen.
  return [
    { originPrefix: ORIGIN_ID.onboarding, label: "Client onboarding", check: onboarding },
    { originPrefix: ORIGIN_ID.closeout, label: "Close-out review", check: onboarding },
    { originPrefix: ORIGIN_ID.businessReview, label: "Weekly business review", check: onboarding },
    { originPrefix: ORIGIN_ID.growthReview, label: "Weekly growth review", check: onboarding },
    { originPrefix: ORIGIN_ID.health, label: "System health", check: health },
    { originPrefix: LEGACY_ORIGIN_ID.onboarding, label: "Client onboarding", check: onboarding },
    { originPrefix: LEGACY_ORIGIN_ID.health, label: "System health", check: health },
    { originPrefix: "", label: "Spike", match: (issue) => isSpike(issue), check: guarded((issue, ctx) => spikeCheck(env, issue, ctx)) },
  ];
}

/** Checks one `issue.updated` event against the Cockpit's rules (call it from the one `issue.updated` handler). */
export function doneCheckFor(env: Env): (event: Parameters<typeof runDoneCheck>[2]) => Promise<DoneCheckOutcome> {
  const rules = cockpitDoneRules(env);
  return (event) => runDoneCheck(env.ctx, rules, event);
}
