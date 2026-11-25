/**
 * `set-rehearsal-preview` (0.52.0, PAR-13387): put a rehearsal sprint's preview in the state a dogfood or acceptance journey needs
 * (the Reviewer's result and the expiry), without a Reviewer.
 *
 * On a real sprint only the Reviewer (review-preview, never on your own preview) or time sets these. A rehearsal sprint (engine/rehearsal.ts:
 * a fixture site on `.invalid`, or the canary client) never opens a review issue, so nobody would ever check its previews; this tool is
 * the one way to give them a result. It refuses every sprint that is not a rehearsal, so it can never pass a client's preview.
 * It only writes the two fields on a pending preview: no comment, no wake, no hand-over. Decisions stay with decide-preview (board users).
 */
import { t } from "../db.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { actorId, num, oneOf, reqStr, SeoError, type Actor, type Env, type Params } from "./common.js";
import { loadSprintContext } from "./context.js";

export const REHEARSAL_ONLY = "set-rehearsal-preview only works on a rehearsal sprint (a fixture site on .invalid, or the canary client). A real preview is checked by the Reviewer with review-preview.";

/** Hours either side of now: up to 30 days ahead (a preview's own life) and 30 days back (already expired). */
export const REHEARSAL_EXPIRY_MAX_HOURS = 720;

const REVIEW_STATUSES = ["passed", "changes_needed", "pending"] as const;

export async function setRehearsalPreview(env: Env, companyId: string, actor: Actor, params: Params) {
  const { sprint } = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  if (!isRehearsalSprint(sprint)) throw new SeoError(REHEARSAL_ONLY);
  const previewId = reqStr(params, "previewId", { max: 80 });
  const reviewStatus = oneOf(params, "reviewStatus", REVIEW_STATUSES);
  const hours = num(params, "expiresInHours", { min: -REHEARSAL_EXPIRY_MAX_HOURS, max: REHEARSAL_EXPIRY_MAX_HOURS, integer: true });
  if (!reviewStatus && hours === undefined) throw new SeoError("Send reviewStatus (passed, changes_needed or pending), expiresInHours, or both.");
  const rows = await env.ctx.db.query(`SELECT id, status FROM ${t("previews")} WHERE id = $1 AND company_id = $2 AND sprint_id = $3 LIMIT 1`, [previewId, companyId, sprint.id]);
  const row = rows[0];
  if (!row) throw new SeoError("No such preview on this sprint.");
  if (String(row.status) !== "pending") throw new SeoError(`This preview is ${String(row.status)}: only a pending preview (no decision yet) can be changed.`);
  const expiresAt = hours === undefined ? null : new Date(env.now().getTime() + hours * 3_600_000).toISOString();
  const note = reviewStatus && reviewStatus !== "pending" ? `Rehearsal: set to ${reviewStatus} with set-rehearsal-preview (no Reviewer check).` : null;
  await env.ctx.db.execute(
    `UPDATE ${t("previews")}
        SET review_status = COALESCE($4, review_status),
            review_note = CASE WHEN $4::text IS NULL THEN review_note ELSE $5 END,
            reviewed_by = CASE WHEN $4::text IS NULL THEN reviewed_by WHEN $4 = 'pending' THEN NULL ELSE $6 END,
            reviewed_at = CASE WHEN $4::text IS NULL THEN reviewed_at WHEN $4 = 'pending' THEN NULL ELSE now() END,
            expires_at = COALESCE($7::text::timestamptz, expires_at)
      WHERE id = $1 AND company_id = $2 AND sprint_id = $3 AND status = 'pending'`,
    [previewId, companyId, sprint.id, reviewStatus ?? null, note, actorId(actor), expiresAt],
  );
  const after = await env.ctx.db.query(`SELECT review_status, expires_at, status FROM ${t("previews")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [previewId, companyId]);
  const read = after[0] ?? {};
  return {
    sprintId: sprint.id,
    previewId,
    reviewStatus: String(read.review_status),
    expiresAt: read.expires_at instanceof Date ? read.expires_at.toISOString() : String(read.expires_at),
    status: String(read.status),
    note: "Rehearsal only: nothing was sent, commented or woken. Decide it with decide-preview (board users) or the cockpit's Previews tab.",
  };
}
