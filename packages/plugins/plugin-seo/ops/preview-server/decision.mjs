// The client's answer on the email link (PAR-9131 T1a). Kept apart from server.mjs so the SQL can be tested on a real Postgres
// without starting the service. Needs plugin-seo 0.37.0+ (migration 026) and the pib_preview role's UPDATE grant on the two new columns.

export const SCHEMA = "plugin_seo_8099f8879a";

// One answer per link: only a pending preview takes one. A changed mind is a reply to the email; staff Undo makes it pending again.
// $1 preview id, $2 approved | changes_requested, $3 the note or null.
export const DECISION_SQL = `UPDATE ${SCHEMA}.previews SET status = $2, decision_note = $3, decided_at = now(), notified_at = NULL, decision_source = 'email', decided_by = 'client:email-link'
  WHERE id = $1 AND status = 'pending' AND expires_at > now() AND review_status = 'passed'`;

// Why an answer was not taken: $1 preview id.
export const DECISION_STATE_SQL = `SELECT status FROM ${SCHEMA}.previews WHERE id = $1`;

export const ALREADY_ANSWERED = "This preview has already been answered. To change it, reply to the email.";
export const NOT_READY = "This preview is not ready for an answer yet, or has expired.";
export const DECLINED_PAGE = "This proposal is not going ahead.";

/** The message for an answer that changed no row, from the row's current status (undefined: no such preview). */
export function refusedAnswer(status) {
  return status === "approved" || status === "changes_requested" || status === "declined" ? ALREADY_ANSWERED : NOT_READY;
}
