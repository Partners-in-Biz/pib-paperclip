/**
 * Issue threads stay small enough to hand an agent. Pure.
 *
 * The host puts a task's whole thread into one string (the agent's prompt and the wake payload) and Linux refuses a
 * single argument or environment string over 128 KB: `spawn E2BIG`. On 2026-10-02 two task issues (PAR-528, PAR-545)
 * reached about 103 KB because this plugin's own comments were unbounded (a Reviewer's 4,000-character note posted
 * again for every round), and every wake on them failed. Two rules keep that from coming back:
 * - every comment the plugin posts is capped (`capComment`), with a pointer to where the full text lives;
 * - a task thread that passes `THREAD_ROLL_BYTES` is moved to a fresh continuation issue (service/thread.ts), which
 *   starts from the summary built here.
 */

/** The longest comment the plugin posts on an issue. */
export const COMMENT_MAX = 1_500;

/** A task thread this big (comment bytes) is rolled into a continuation issue: well under the ~80 KB where wakes started to fail. */
export const THREAD_ROLL_BYTES = 60_000;

/** The same notice is not posted twice in a row on one issue within this window. */
export const COMMENT_DEDUPE_MS = 24 * 3_600_000;

const DEFAULT_POINTER = "the full text is kept in the SEO plugin's record for this task";

/**
 * `body` cut to at most `max` characters (the notice that it was cut included), at a line or word boundary, with a
 * pointer to where the full text is. Text that already fits is returned unchanged.
 */
export function capComment(body: string, opts: { max?: number; pointer?: string } = {}): string {
  const max = Math.max(200, opts.max ?? COMMENT_MAX);
  if (body.length <= max) return body;
  const pointer = opts.pointer?.trim() || DEFAULT_POINTER;
  // Room for the notice and, when a code fence is left open, its closing line.
  const notice = (left: number) => `\n\n… (${left} more characters not shown: ${pointer}.)`;
  const reserve = notice(body.length).length + 5;
  const room = Math.max(1, max - reserve);
  let cut = body.slice(0, room);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (boundary > room * 0.6) cut = cut.slice(0, boundary);
  cut = cut.trimEnd();
  const fence = (cut.match(/```/g) ?? []).length % 2 === 1 ? "\n```" : "";
  return `${cut}${fence}${notice(body.length - cut.length)}`;
}

/** A short stable fingerprint of a comment body (FNV-1a; only compared with itself). */
export function commentFingerprint(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${body.length}`;
}

export interface CommentMemory {
  /** Fingerprint and time of the last comment the plugin posted on the issue. */
  last?: { hash: string; at: string };
  /** Notices posted once per key (key → time). Bounded: the oldest keys drop first. */
  keys?: Record<string, string>;
}

const MAX_KEYS = 24;

/** True when this notice was already posted and should not be posted again. Pure. */
export function isRepeatNotice(memory: CommentMemory | null | undefined, input: { hash: string; key?: string; now: number }): boolean {
  if (!memory) return false;
  if (input.key) return Boolean(memory.keys?.[input.key]);
  const last = memory.last;
  if (!last || last.hash !== input.hash) return false;
  const at = Date.parse(last.at);
  return Number.isFinite(at) && input.now - at < COMMENT_DEDUPE_MS;
}

/** The memory after posting a notice. Pure. */
export function rememberNotice(memory: CommentMemory | null | undefined, input: { hash: string; key?: string; at: string }): CommentMemory {
  const keys = { ...(memory?.keys ?? {}) };
  if (input.key) {
    keys[input.key] = input.at;
    const names = Object.keys(keys);
    if (names.length > MAX_KEYS) {
      for (const name of names.sort((a, b) => Date.parse(keys[a]!) - Date.parse(keys[b]!)).slice(0, names.length - MAX_KEYS)) delete keys[name];
    }
  }
  return { last: { hash: input.hash, at: input.at }, keys };
}

export type RollReason = "size" | "e2big" | "requested";

/**
 * Why a task's issue should move to a continuation issue, or null. `size`: the thread is at or past `minBytes`.
 * `e2big`: the agent's latest run failed with `spawn E2BIG` and the thread is not known to be small. `requested`: a
 * person or tool named the issue and its size cannot be read. Pure.
 */
export function rollReason(input: { bytes: number | null; e2big: boolean; explicit: boolean }, minBytes: number): RollReason | null {
  if (input.bytes != null && input.bytes >= minBytes) return "size";
  if (input.e2big && (input.bytes == null || input.bytes >= minBytes / 2)) return "e2big";
  if (input.explicit && input.bytes == null) return "requested";
  return null;
}

/** A task moved this recently is not moved again by the automatic guard (a loop would only churn issues). */
export const MOVED_COOLDOWN_MS = 2 * 3_600_000;
/** A claim that never got an outcome (the worker died mid-move) holds the task this long. */
export const CLAIM_HOLD_MS = 3_600_000;
/** A named request waits this long for a claim that may still be running. */
export const CLAIM_FRESH_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 3_600_000;
const FAILURE_BACKOFF_MAX_MS = 24 * 3_600_000;

/**
 * What the plugin remembers about moving one task (state `seo-thread-roll:<taskId>`): a claim written before a move
 * starts, then how it ended. The record is what stops a move that keeps failing from being retried every five minutes
 * (each try would open and cancel an issue) and a second job from moving the same task at the same time.
 */
export interface RollMark {
  at: string;
  state: "claimed" | "moved" | "failed";
  /** Moves in a row that failed: kept through a claim, cleared by a success. */
  failures: number;
}

/** Wait after the n-th failure in a row: an hour, then two, four... at most a day. */
export function failureBackoffMs(failures: number): number {
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures, 10) - 1));
}

/** A stored record as a `RollMark`; a bare timestamp (an older shape) means "moved then". Pure. */
export function parseRollMark(value: unknown): RollMark | null {
  if (typeof value === "string") return Number.isFinite(Date.parse(value)) ? { at: value, state: "moved", failures: 0 } : null;
  if (!value || typeof value !== "object") return null;
  const v = value as { at?: unknown; state?: unknown; failures?: unknown };
  if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
  if (v.state !== "claimed" && v.state !== "moved" && v.state !== "failed") return null;
  return { at: v.at, state: v.state, failures: typeof v.failures === "number" && v.failures > 0 ? Math.floor(v.failures) : 0 };
}

/**
 * Why a move of this task must not start now, or null. The automatic guard honours every record: a recent move
 * (2 hours), a claim with no outcome (1 hour), a failed move (1 hour, doubling per failure up to a day). A named
 * request (a person or the orchestrator asking for one issue) ignores the backoff and only waits for a claim that is
 * a few minutes old, which may still be running. Pure.
 */
export function moveHold(mark: RollMark | null, nowMs: number, named: boolean): string | null {
  if (!mark) return null;
  const at = Date.parse(mark.at);
  if (!Number.isFinite(at)) return null;
  const age = nowMs - at;
  if (named) return mark.state === "claimed" && age < CLAIM_FRESH_MS ? "another move of this task is under way" : null;
  if (mark.state === "moved") return age < MOVED_COOLDOWN_MS ? "moved in the last 2 hours already" : null;
  if (mark.state === "claimed") return age < CLAIM_HOLD_MS ? "a move of this task started less than an hour ago and did not finish" : null;
  const wait = failureBackoffMs(mark.failures);
  if (age >= wait) return null;
  const minutes = Math.max(1, Math.ceil((wait - age) / 60_000));
  return `the last move of this task failed${mark.failures > 1 ? ` (${mark.failures} in a row)` : ""}; it is tried again in about ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}`;
}

/** Task statuses whose thread can still be handed to an agent. */
export function rollableIssue(issue: { status: string; assigneeAgentId?: string | null }): { ok: true } | { ok: false; reason: string } {
  if (!issue.assigneeAgentId) return { ok: false, reason: "not assigned to an agent, so no wake can fail on it" };
  if (!["todo", "backlog", "in_progress", "blocked"].includes(issue.status)) return { ok: false, reason: `the issue is ${issue.status.replace(/_/g, " ")}` };
  return { ok: true };
}

/** The status a continuation issue starts in: waiting stays waiting, active work goes back to todo. */
export function continuationStatus(status: string): "todo" | "blocked" {
  return status === "blocked" ? "blocked" : "todo";
}

export interface PreviewLine {
  pageUrl: string;
  title: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
  previewId: string;
}

export interface LastComment {
  author: string;
  at: string;
  body: string;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/**
 * Text copied from other comments, as plain words: links lose their target and `@` mentions their `@`, so a mention
 * of an agent in an old comment (`[@SEO Specialist](agent://…)`) cannot wake anybody from the new issue.
 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:agent|user|project|issue):\/\/[^)]*\)/gi, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:agent|user|project|issue):\/\/\S+/gi, "")
    .replace(/(^|[\s(["'])@(?=[\p{L}\p{N}])/gu, "$1");
}

const oneLine = (text: string) => plainText(text).replace(/\s+/g, " ").trim();

/**
 * What the continuation issue says on top of the task's own description: where the work stands, built from the
 * plugin's records (never from the old thread's text, apart from the last few comments, trimmed). Under ~7,000 characters.
 */
export function continuationSummary(input: {
  oldIdentifier: string | null;
  bytes: number | null;
  comments: number | null;
  reason: string;
  task: { title: string; status: string; blockerReason: string | null; humanAsk: string | null; startedAt: string | null; evidenceSummary: string | null };
  previews: PreviewLine[];
  lastComments: LastComment[];
  sprintId: string;
}): string {
  const old = input.oldIdentifier ?? "the previous issue";
  const size = input.bytes != null ? `${Math.round(input.bytes / 1000)} KB, ${input.comments ?? "many"} comments` : "very long";
  const lines = [
    `> **Continuation of ${old}.** That issue's thread had grown to ${size} (${input.reason}), too long to hand an agent, so the plugin moved the work here. It is closed; its records are linked below. Do not go back to ${old} for history: this issue says where things stand.`,
    "",
    "## Where it stands",
    `- Task: ${input.task.title} (${input.task.status.replace(/_/g, " ")}${input.task.startedAt ? `, started ${input.task.startedAt.slice(0, 10)}` : ""}).`,
  ];
  if (input.task.blockerReason) lines.push(`- Waiting on: ${clip(oneLine(input.task.blockerReason), 400)}`);
  if (input.task.humanAsk) lines.push(`- What was asked of a person: ${clip(oneLine(input.task.humanAsk), 500)}`);
  if (input.task.evidenceSummary) lines.push(`- Recorded so far: ${clip(oneLine(input.task.evidenceSummary), 500)}`);
  if (input.previews.length > 0) {
    lines.push("", `## Previews on this task (${input.previews.length}, newest first)`);
    for (const p of input.previews.slice(0, 12)) {
      const note = p.reviewNote ? ` — ${clip(oneLine(p.reviewNote), 220)}` : "";
      lines.push(`- ${p.pageUrl} · ${p.status.replace(/_/g, " ")}, review ${p.reviewStatus.replace(/_/g, " ")} (previewId \`${p.previewId}\`)${note}`);
    }
    if (input.previews.length > 12) lines.push(`- …and ${input.previews.length - 12} older ones.`);
    lines.push(`Full notes: \`partnersinbiz.seo:list-previews\` with \`sprintId\` \`${input.sprintId}\` and a \`previewId\`.`);
  }
  lines.push("", `Review or build issues opened for this task before the move still name ${old} as their parent: that is only a label (a plugin cannot change an issue's parent). The plugin follows the task, so their results reach this issue.`);
  if (input.lastComments.length > 0) {
    lines.push("", "## The last comments on the old issue (trimmed)");
    for (const c of input.lastComments.slice(0, 3)) lines.push(`- ${c.author}, ${c.at.slice(0, 16).replace("T", " ")}: ${clip(oneLine(c.body), 600)}`);
  }
  return lines.join("\n");
}
