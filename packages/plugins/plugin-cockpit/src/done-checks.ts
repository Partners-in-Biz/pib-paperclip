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
  return [
    { originPrefix: ORIGIN_ID.onboarding, label: "Client onboarding", check: onboarding },
    { originPrefix: ORIGIN_ID.health, label: "System health", check: health },
    { originPrefix: LEGACY_ORIGIN_ID.onboarding, label: "Client onboarding", check: onboarding },
    { originPrefix: LEGACY_ORIGIN_ID.health, label: "System health", check: health },
  ];
}

/** Checks one `issue.updated` event against the Cockpit's rules (call it from the one `issue.updated` handler). */
export function doneCheckFor(env: Env): (event: Parameters<typeof runDoneCheck>[2]) => Promise<DoneCheckOutcome> {
  const rules = cockpitDoneRules(env);
  return (event) => runDoneCheck(env.ctx, rules, event);
}
