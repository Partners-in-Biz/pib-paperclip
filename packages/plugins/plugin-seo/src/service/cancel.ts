/**
 * `cancel-previews` (0.34.0, PAR-8972 T1b): take duplicate or superseded previews out of the client's sight without deleting them,
 * and the 5-minute follow-up that closes their Reviewer issues and re-checks the tasks that were waiting on them.
 * The tool does database work only (well under the tool RPC timeout); the issue and task work happens in the job.
 */
import { t } from "../db.js";
import * as db from "../db.js";
import { actorId, bool, errorMessage, reqStr, SeoError, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, requireSprint } from "./context.js";
import { isAutoSignoff, recheckTaskAnswers } from "./client-signoff.js";
import { commentOn, getIssue, patchIssue } from "./issues.js";

export const CANCEL_MIN_PREFIX = 8;
export const CANCEL_MAX_INPUTS = 300;
export const CANCEL_FOLLOW_UP = "review issues closed and tasks re-checked within 5 minutes";
export const CANCEL_REVIEW_COMMENT = "Preview replaced by a newer version; nothing to review.";
const FOLLOW_UP_PREVIEWS = 25;
const FOLLOW_UP_TASKS = 10;

type SkipReason = "notFound" | "ambiguous" | "alreadyCancelled" | "approved" | "lastOnPage";
interface Row {
  id: string;
  pageUrl: string;
  status: string;
  reviewStatus: string | null;
  expired: boolean;
  draftKey: string | null;
  createdAt: string;
}

const toRow = (r: Record<string, any>): Row => ({
  id: String(r.id),
  pageUrl: String(r.page_url),
  status: String(r.status),
  reviewStatus: r.review_status == null ? null : String(r.review_status),
  expired: Boolean(r.expired),
  draftKey: r.draft_key == null ? null : String(r.draft_key),
  createdAt: String(r.created_at),
});

const COLUMNS = `p.id, p.page_url, p.status, p.review_status, p.expires_at <= now() AS expired, p.draft_key, p.created_at`;

export async function cancelPreviews(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const inputs = readInputs(params);
  const reason = reqStr(params, "reason", { max: 300 });
  const allowApproved = bool(params, "allowApproved") === true;
  const allowLast = bool(params, "allowLast") === true;
  const dryRun = bool(params, "dryRun") !== false;

  // Resolve: one SELECT, a prefix match by left() (never LIKE: ids contain _ and -), inside this company and sprint.
  const found = await env.ctx.db.query(
    `SELECT i.input, ${COLUMNS} FROM jsonb_array_elements_text($3::jsonb) AS i(input)
       JOIN ${t("previews")} p ON p.company_id = $1 AND p.sprint_id = $2 AND left(p.id, length(i.input)) = i.input`,
    [companyId, sprint.id, JSON.stringify(inputs)],
  );
  const byInput = new Map<string, Row[]>();
  for (const r of found) byInput.set(String(r.input), [...(byInput.get(String(r.input)) ?? []), toRow(r)]);

  const skipped: Array<{ input: string; reason: SkipReason }> = [];
  const candidates = new Map<string, Row>();
  for (const input of inputs) {
    const matches = byInput.get(input) ?? [];
    if (matches.length === 0) skipped.push({ input, reason: "notFound" });
    else if (matches.length > 1) skipped.push({ input, reason: "ambiguous" });
    else {
      const row = matches[0]!;
      if (row.status === "cancelled") skipped.push({ input, reason: "alreadyCancelled" });
      else if (row.status === "approved" && !allowApproved) skipped.push({ input, reason: "approved" });
      else if (!candidates.has(row.id)) candidates.set(row.id, row);
    }
  }

  // Every non-cancelled preview of the pages involved: what is left after the cancel, and the last-live-preview guard.
  const pages = [...new Set([...candidates.values()].map((r) => r.pageUrl))];
  const live = new Map<string, Row[]>();
  if (pages.length > 0) {
    const rows = await env.ctx.db.query(
      `SELECT ${COLUMNS} FROM ${t("previews")} p WHERE p.company_id = $1 AND p.sprint_id = $2 AND p.status <> 'cancelled'
         AND p.page_url IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY p.created_at DESC`,
      [companyId, sprint.id, JSON.stringify(pages)],
    );
    for (const r of rows) {
      const row = toRow(r);
      live.set(row.pageUrl, [...(live.get(row.pageUrl) ?? []), row]);
    }
  }
  const inputById = new Map<string, string>();
  for (const [input, matches] of byInput) if (matches.length === 1) inputById.set(matches[0]!.id, input);
  if (!allowLast) {
    for (const page of pages) {
      const onPage = live.get(page) ?? [];
      const mine = [...candidates.values()].filter((r) => r.pageUrl === page);
      if (onPage.every((r) => candidates.has(r.id))) {
        for (const r of mine) {
          candidates.delete(r.id);
          skipped.push({ input: inputById.get(r.id) ?? r.id, reason: "lastOnPage" });
        }
      }
    }
  }

  // Write: one UPDATE by full ids. The status guards decide a race with a client answer; the read-back says what really changed
  // (the plugin database has no RETURNING, so the batch is recognised by its own timestamp and actor).
  let cancelled = [...candidates.keys()];
  if (!dryRun && cancelled.length > 0) {
    const stamp = env.now().toISOString();
    const by = actorId(actor);
    await env.ctx.db.execute(
      `UPDATE ${t("previews")} SET status = 'cancelled', cancelled_prev_status = status, cancelled_at = $4::timestamptz, cancelled_by = $5, cancel_reason = $6
        WHERE company_id = $1 AND sprint_id = $2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb)) AND status <> 'cancelled'${allowApproved ? "" : " AND status <> 'approved'"}`,
      [companyId, sprint.id, JSON.stringify(cancelled), stamp, by, reason],
    );
    const after = await env.ctx.db.query(
      `SELECT p.id, p.status, (p.status = 'cancelled' AND p.cancelled_at = $4::timestamptz AND p.cancelled_by = $5) AS mine FROM ${t("previews")} p
        WHERE p.company_id = $1 AND p.sprint_id = $2 AND p.id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
      [companyId, sprint.id, JSON.stringify(cancelled), stamp, by],
    );
    const state = new Map<string, Record<string, unknown>>(after.map((r: Record<string, unknown>) => [String(r.id), r]));
    const ids = new Set<string>();
    for (const id of cancelled) {
      const now = state.get(id);
      if (now?.mine) ids.add(id);
      else skipped.push({ input: inputById.get(id) ?? id, reason: now?.status === "approved" ? "approved" : "alreadyCancelled" });
    }
    cancelled = cancelled.filter((id) => ids.has(id));
  }

  const gone = new Set(cancelled);
  const newestByPage = pages.map((pageUrl) => {
    const newest = (live.get(pageUrl) ?? []).find((r) => !gone.has(r.id));
    if (!newest) return { pageUrl, id: null, status: null, reviewStatus: null, expired: null, wouldRevive: false };
    return { pageUrl, id: newest.id, status: newest.status, reviewStatus: newest.reviewStatus, expired: newest.expired, wouldRevive: newest.reviewStatus === "changes_needed" && newest.status === "pending" && !newest.expired };
  });
  return {
    dryRun,
    cancelled,
    skipped,
    inDraft: cancelled.filter((id) => candidates.get(id)?.draftKey).map((id) => ({ previewId: id, draftKey: candidates.get(id)!.draftKey })),
    newestByPage,
    followUp: CANCEL_FOLLOW_UP,
  };
}

function readInputs(params: Params): string[] {
  const raw = params.previewIds;
  if (!Array.isArray(raw) || raw.length === 0) throw new SeoError("previewIds is required: 1 to 300 preview ids (full, or at least 8 characters from the start)");
  if (raw.length > CANCEL_MAX_INPUTS) throw new SeoError(`previewIds has ${raw.length} entries; send at most ${CANCEL_MAX_INPUTS} per call`);
  const out: string[] = [];
  for (const item of raw) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value) throw new SeoError("previewIds must be non-empty strings");
    if (value.length < CANCEL_MIN_PREFIX) throw new SeoError(`"${value}" is too short: send the full id or at least ${CANCEL_MIN_PREFIX} characters from its start`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Follow-up for cancelled previews (5-minute job). Per cancelled row not yet handled (at most 25): close its open Reviewer issue with
 * one comment. Then, per affected task (at most 10), re-check the task's answers so a task that only waited on cancelled previews
 * moves on. A failure leaves the row unmarked and it is retried next run. Returns how many rows were marked handled.
 */
export async function handleCancelledPreviews(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT id, company_id, sprint_id, task_id, review_issue_id, review_status FROM ${t("previews")}
      WHERE status = 'cancelled' AND stats->>'cancelHandled' IS NULL ORDER BY cancelled_at LIMIT ${FOLLOW_UP_PREVIEWS}`,
  );
  const ready: Array<Record<string, any>> = [];
  for (const row of rows) {
    const companyId = String(row.company_id);
    try {
      if (row.review_issue_id && row.review_status === "pending") {
        const issueId = String(row.review_issue_id);
        const issue = await getIssue(env, companyId, issueId);
        if (!issue) throw new Error("review issue not readable");
        if (!["done", "cancelled"].includes(String(issue.status))) {
          if (!(await commentOn(env, companyId, issueId, CANCEL_REVIEW_COMMENT))) throw new Error("comment refused");
          if (!(await patchIssue(env, companyId, issueId, { status: "cancelled" }))) throw new Error("issue not cancelled");
        }
      }
      ready.push(row);
    } catch (error) {
      env.ctx.logger.info("SEO cancelled preview review issue not closed", { previewId: String(row.id), error: errorMessage(error) });
    }
  }
  const tasks = new Map<string, { companyId: string; sprintId: string; taskId: string }>();
  for (const row of ready) {
    if (row.task_id && tasks.size < FOLLOW_UP_TASKS) tasks.set(`${row.company_id}:${row.task_id}`, { companyId: String(row.company_id), sprintId: String(row.sprint_id), taskId: String(row.task_id) });
  }
  const checked = new Set<string>();
  for (const [key, { companyId, sprintId, taskId }] of tasks) {
    try {
      const sprint = await db.getSprint(env.ctx.db, companyId, sprintId);
      if (sprint && isAutoSignoff(sprint)) await recheckTaskAnswers(env, sprint, taskId);
      checked.add(key);
    } catch (error) {
      env.ctx.logger.info("SEO cancelled preview task not re-checked", { taskId, error: errorMessage(error) });
    }
  }
  let handled = 0;
  for (const row of ready) {
    if (row.task_id && !checked.has(`${row.company_id}:${row.task_id}`)) continue; // beyond this run's 10 tasks, or the re-check failed
    await env.ctx.db.execute(`UPDATE ${t("previews")} SET stats = stats || jsonb_build_object('cancelHandled', $2::text) WHERE id = $1`, [String(row.id), env.now().toISOString()]);
    handled += 1;
  }
  return handled;
}
