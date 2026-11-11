/**
 * A person decides SEO previews from the cockpit (PAR-9131 T1c): approve, decline or request changes; undo a decision that is not
 * applied yet; confirm a client's email approval on a manual sprint. Page-only actions (UI_ONLY_HANDLERS): the actor comes only from
 * the authenticated context, never from params. The decision lands on the preview row itself (who, when, from where), and the
 * hand-over (client-signoff.ts) takes it to the SEO agent once every preview of the task is decided.
 *
 * Audit: one structured log line per action. `ctx.activity.log` needs the `activity.log.write` capability, and a new capability
 * blocks the plugin upgrade until a board approval (plugin-loader capability escalation), so the plan's fallback applies (Risks).
 */
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { PREVIEW_LIVE_SQL } from "../constants.js";
import * as db from "../db.js";
import { t } from "../db.js";
import { errorMessage, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { commentOn } from "./issues.js";
import { quoted, recheckTaskAnswers } from "./client-signoff.js";
import { syncApplyWindow } from "./signoff.js";

export const BOARD_ONLY = "This action is for board users. Do not retry.";
export const MIN_REASON = 10;
export const MAX_BATCH = 50;
const DECISIONS = ["approved", "declined", "changes_requested"] as const;
type Decision = (typeof DECISIONS)[number];
const DECIDED_SQL = `status IN ('approved', 'declined', 'changes_requested')`;

export interface Skipped {
  id: string;
  reason: string;
}

/** The signed-in person, from the authenticated actor only. Anything else is refused before a row is read. */
function boardUser(actor: Actor): string {
  if (actor.kind !== "user" || !actor.userId?.trim()) throw new SeoError(BOARD_ONLY);
  return actor.userId.trim();
}

function previewIds(params: Params): string[] {
  const raw = params.previewIds;
  if (!Array.isArray(raw) || raw.length === 0) throw new SeoError(`previewIds must be a list of 1 to ${MAX_BATCH} preview ids`);
  const ids = [...new Set(raw.map((v) => (typeof v === "string" ? v.trim() : "")))];
  if (ids.some((id) => !id || id.length > 100)) throw new SeoError("previewIds must be preview ids (strings)");
  if (ids.length > MAX_BATCH) throw new SeoError(`At most ${MAX_BATCH} previews at a time`);
  return ids;
}

/**
 * A unique value for this run's write, so it finds its own rows (the host's execute returns a count only, no RETURNING). Bound as
 * `$n::text::timestamptz`: a `$n::timestamptz` parameter goes through a JS Date in the driver and loses the microseconds.
 */
function stamp(env: Env): string {
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return env.now().toISOString().replace(/Z$/, `${micros}Z`);
}

const isoOf = (v: unknown): string | null => (v == null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString());

/** Who decided a row, in words. */
export function deciderLabel(decidedBy: unknown, source: unknown, me: string): string {
  const by = decidedBy == null ? null : String(decidedBy);
  if (!by || by === "client:email-link" || source === "email") return "the client (email link)";
  return by === me ? "you" : `user ${by}`;
}

interface Row {
  id: string;
  taskId: string | null;
  issueId: string | null;
  pageUrl: string;
  status: string;
  reviewStatus: string;
  open: boolean;
  live: boolean;
  decidedAt: string | null;
  /** decided_at as Postgres prints it (microseconds kept), for the undo CAS. */
  decidedText: string | null;
  decidedBy: string | null;
  decisionSource: string | null;
  confirmedAt: string | null;
  handedAt: string | null;
  /** handed_at as Postgres prints it, for the undo CAS: a hand-over between the read and the UPDATE must lose the undo. */
  handedText: string | null;
  appliedAt: string | null;
}

async function readRows(env: Env, companyId: string, sprintId: string, ids: string[]): Promise<Map<string, Row>> {
  const rows = await env.ctx.db.query(
    `SELECT id, task_id, issue_id, page_url, status, review_status, expires_at > now() AS open, ${PREVIEW_LIVE_SQL} AS live,
        decided_at, decided_at::text AS decided_text, decided_by, decision_source, confirmed_at, handed_at, handed_at::text AS handed_text, applied_at
       FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [companyId, sprintId, JSON.stringify(ids)],
  );
  return new Map(
    rows.map((r) => [
      String(r.id),
      {
        id: String(r.id),
        taskId: r.task_id ? String(r.task_id) : null,
        issueId: r.issue_id ? String(r.issue_id) : null,
        pageUrl: String(r.page_url),
        status: String(r.status),
        reviewStatus: String(r.review_status ?? "pending"),
        open: r.open === true,
        live: r.live === true,
        decidedAt: isoOf(r.decided_at),
        decidedText: r.decided_text ? String(r.decided_text) : null,
        decidedBy: r.decided_by ? String(r.decided_by) : null,
        decisionSource: r.decision_source ? String(r.decision_source) : null,
        confirmedAt: isoOf(r.confirmed_at),
        handedAt: isoOf(r.handed_at),
        handedText: r.handed_text ? String(r.handed_text) : null,
        appliedAt: isoOf(r.applied_at),
      },
    ]),
  );
}

/** Ids of `ids` whose column `col` now holds this run's stamp (and `by`). */
async function ownRows(env: Env, companyId: string, ids: string[], col: "decided_at" | "confirmed_at", by: string, value: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const byCol = col === "decided_at" ? "decided_by" : "confirmed_by";
  const rows = await env.ctx.db.query(
    `SELECT id FROM ${t("previews")} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND ${col} = $3::text::timestamptz AND ${byCol} = $4`,
    [companyId, JSON.stringify(ids), value, by],
  );
  return new Set(rows.map((r) => String(r.id)));
}

/** The hand-over per touched task. A failure is logged: the 5-minute sweep (retryHandovers) hands person decisions over. */
async function handOver(env: Env, sprint: db.Sprint, taskIds: Iterable<string>): Promise<void> {
  for (const taskId of new Set(taskIds)) {
    await recheckTaskAnswers(env, sprint, taskId).catch((error: unknown) =>
      env.ctx.logger.info("SEO hand-over after a cockpit decision failed; the sweep retries it", { taskId, error: errorMessage(error) }),
    );
  }
}

function audit(env: Env, action: string, companyId: string, sprintId: string, userId: string, done: string[], skipped: Skipped[], extra: Record<string, unknown> = {}): void {
  env.ctx.logger.info(`SEO preview ${action}`, { action, companyId, sprintId, actor: { kind: "user", userId }, previewIds: done, skipped: skipped.map((s) => s.id), ...extra });
}

const notOnSprint = (id: string): Skipped => ({ id, reason: "No such preview on this sprint." });

// ---------------------------------------------------------------------------
// decide-preview
// ---------------------------------------------------------------------------

/** `{sprintId, previewIds[1..50], decision, note?}`: one CAS UPDATE on the pending rows, then the hand-over per touched task. */
export async function decidePreview(env: Env, companyId: string, actor: Actor, params: Params) {
  const userId = boardUser(actor);
  const decision = oneOf(params, "decision", DECISIONS) as Decision | undefined;
  if (!decision) throw new SeoError(`decision must be one of: ${DECISIONS.join(", ")}`);
  const note = str(params, "note", { max: 2000 }) ?? null;
  if (decision !== "approved" && (!note || note.length < MIN_REASON)) {
    throw new SeoError(`${decision === "declined" ? "A decline" : "A request for changes"} needs a reason of at least ${MIN_REASON} characters: the SEO agent reads it.`);
  }
  const ids = previewIds(params);
  const { sprint } = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const rows = await readRows(env, companyId, sprint.id, ids);
  const skipped: Skipped[] = [];
  const candidates: string[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) skipped.push(notOnSprint(id));
    else if (DECISIONS.includes(r.status as Decision)) skipped.push({ id, reason: `Already decided by ${deciderLabel(r.decidedBy, r.decisionSource, userId)} at ${r.decidedAt ?? "an unknown time"}. Undo first.` });
    else if (r.status !== "pending") skipped.push({ id, reason: `This preview is ${r.status}.` });
    else if (!r.open) skipped.push({ id, reason: "Expired before a decision." });
    else if (decision === "approved" && r.reviewStatus !== "passed") skipped.push({ id, reason: `The Reviewer has not passed it (review: ${r.reviewStatus}). Approve after a pass, or decline it.` });
    else candidates.push(id);
  }
  const at = stamp(env);
  if (candidates.length > 0) {
    await env.ctx.db.execute(
      `UPDATE ${t("previews")} SET status = $4, decision_note = $5, decided_at = $6::text::timestamptz, decided_by = $7, decision_source = 'cockpit', notified_at = now()
        WHERE company_id = $1 AND sprint_id = $2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb))
          AND status = 'pending' AND expires_at > now() AND ($4 <> 'approved' OR review_status = 'passed')`,
      [companyId, sprint.id, JSON.stringify(candidates), decision, note, at, userId],
    );
  }
  const mine = await ownRows(env, companyId, candidates, "decided_at", userId, at);
  for (const id of candidates) if (!mine.has(id)) skipped.push({ id, reason: "It changed while you decided (someone else answered, or it expired). Reload and try again." });
  const decided = candidates.filter((id) => mine.has(id));
  audit(env, "decide", companyId, sprint.id, userId, decided, skipped, { decision });
  await handOver(env, sprint, decided.map((id) => rows.get(id)!.taskId).filter((x): x is string => Boolean(x)));
  return { sprintId: sprint.id, decision, decided, skipped };
}

// ---------------------------------------------------------------------------
// undo-preview-decision (Q11)
// ---------------------------------------------------------------------------

/**
 * Back to pending while nothing is applied: clears the decision, the confirmation and the hand-over, so the email link (or the
 * cockpit) takes a new answer. A row the agent already had is followed by a comment and a wake telling it not to apply.
 * Each row is its own CAS on the decision this run read, so the comment is only sent for a decision this run undid.
 */
export async function undoPreviewDecision(env: Env, companyId: string, actor: Actor, params: Params) {
  const userId = boardUser(actor);
  const ids = previewIds(params);
  const { sprint } = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const rows = await readRows(env, companyId, sprint.id, ids);
  const skipped: Skipped[] = [];
  const undone: string[] = [];
  const told: string[] = [];
  const handed: Row[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) { skipped.push(notOnSprint(id)); continue; }
    if (!DECISIONS.includes(r.status as Decision)) { skipped.push({ id, reason: "Not decided: nothing to undo." }); continue; }
    if (r.appliedAt) { skipped.push({ id, reason: `The SEO agent started applying it at ${r.appliedAt}, so Undo is closed. Ask it to revert the page with wp-undo.` }); continue; }
    const res = await env.ctx.db.execute(
      `UPDATE ${t("previews")} SET status = 'pending', decision_note = NULL, decided_at = NULL, decided_by = NULL, decision_source = NULL, confirmed_by = NULL, confirmed_at = NULL,
          handed_at = NULL, apply_until = NULL, handover_done_at = NULL, notified_at = NULL, handover_attempts = 0
        WHERE company_id = $1 AND sprint_id = $2 AND id = $3 AND status = $4 AND decided_at IS NOT DISTINCT FROM $5::text::timestamptz
          AND handed_at IS NOT DISTINCT FROM $6::text::timestamptz AND applied_at IS NULL AND ${DECIDED_SQL}`,
      [companyId, sprint.id, id, r.status, r.decidedText, r.handedText],
    );
    if (!res.rowCount) { skipped.push({ id, reason: "It changed while you undid it (applied, handed to the agent, or decided again). Reload and try again." }); continue; }
    undone.push(id);
    if (r.handedAt) handed.push(r);
  }
  // Only a handed-over page can be in the window. Sync before telling the agent, so the page is out of the lock by
  // the time it reads the comment; a failed sync is retried by the 5-minute job (it reads the last sent window).
  if (handed.length > 0) {
    await syncApplyWindow(env, sprint, `preview-undo:${userId}`).catch((error: unknown) =>
      env.ctx.logger.info("SEO undo: window sync failed; the 5-minute job retries it", { sprintId: sprint.id, error: errorMessage(error) }),
    );
  }
  for (const r of handed) await tellAgent(env, sprint, r).then((ok) => ok && told.push(r.id));
  audit(env, "undo", companyId, sprint.id, userId, undone, skipped, { agentTold: told });
  return { sprintId: sprint.id, undone, skipped, agentTold: told };
}

/** The agent had this decision: do not apply it, revert if it already did. The page has left the page window (T3). */
async function tellAgent(env: Env, sprint: db.Sprint, r: Row): Promise<boolean> {
  try {
    const task = r.taskId ? await db.getTask(env.ctx.db, sprint.companyId, r.taskId) : null;
    const issueId = task?.issueId ?? r.issueId;
    if (!issueId) return false;
    const body = [
      `Decision on preview ${r.id} undone: do not apply it. If you already changed ${quoted(r.pageUrl, 300)}, revert it with wp-undo.`,
      "",
      `The decision undone was ${r.status} at ${r.decidedAt ?? "-"}. The write lock no longer lets this page through (at the latest within 5 minutes). You are woken again when it is decided.`,
    ].join("\n");
    if (!(await commentOn(env, sprint.companyId, issueId, body))) return false;
    await wakeIssue(env.ctx, issueId, sprint.companyId, "Preview decision undone");
    return true;
  } catch (error) {
    env.ctx.logger.info("SEO undo: the agent was not told", { previewId: r.id, error: errorMessage(error) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// confirm-preview-approval (Q6)
// ---------------------------------------------------------------------------

/**
 * A person confirms a client's email approval (a manual sprint does not apply one by itself). Sets `confirmed_by` and
 * `confirmed_at` only: the client's answer and its source stay as they are. Then the hand-over per touched task.
 */
export async function confirmPreviewApproval(env: Env, companyId: string, actor: Actor, params: Params) {
  const userId = boardUser(actor);
  const ids = previewIds(params);
  const { sprint } = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const rows = await readRows(env, companyId, sprint.id, ids);
  const skipped: Skipped[] = [];
  const candidates: string[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) skipped.push(notOnSprint(id));
    else if (r.status !== "approved" || (r.decisionSource ?? "email") !== "email") skipped.push({ id, reason: "Only a client's email approval needs a confirmation." });
    else if (r.confirmedAt) skipped.push({ id, reason: `Already confirmed at ${r.confirmedAt}.` });
    else if (r.handedAt) skipped.push({ id, reason: "Already handed to the SEO agent." });
    else if (r.appliedAt) skipped.push({ id, reason: "Already being applied." });
    else if (!r.live) skipped.push({ id, reason: "The approval is too old to apply. Ask for a new decision." });
    else candidates.push(id);
  }
  const at = stamp(env);
  if (candidates.length > 0) {
    await env.ctx.db.execute(
      `UPDATE ${t("previews")} SET confirmed_by = $4, confirmed_at = $5::text::timestamptz
        WHERE company_id = $1 AND sprint_id = $2 AND id IN (SELECT jsonb_array_elements_text($3::jsonb))
          AND status = 'approved' AND decision_source = 'email' AND confirmed_at IS NULL AND applied_at IS NULL AND handed_at IS NULL`,
      [companyId, sprint.id, JSON.stringify(candidates), userId, at],
    );
  }
  const mine = await ownRows(env, companyId, candidates, "confirmed_at", userId, at);
  for (const id of candidates) if (!mine.has(id)) skipped.push({ id, reason: "It changed while you confirmed it. Reload and try again." });
  const confirmed = candidates.filter((id) => mine.has(id));
  audit(env, "confirm", companyId, sprint.id, userId, confirmed, skipped);
  await handOver(env, sprint, confirmed.map((id) => rows.get(id)!.taskId).filter((x): x is string => Boolean(x)));
  return { sprintId: sprint.id, confirmed, skipped };
}
