// The client's answer on the email link (PAR-9131 T1a). Kept apart from server.mjs so the SQL can be tested on a real Postgres
// without starting the service. Needs plugin-seo 0.37.0+ (migration 026) and the pib_preview role's UPDATE grant on the two new columns.

export const SCHEMA = "plugin_seo_8099f8879a";

// One answer per link: only a pending preview takes one. A changed mind is a reply to the email; staff Undo makes it pending again.
// $1 preview id, $2 approved | changes_requested, $3 the note or null.
export const DECISION_SQL = `UPDATE ${SCHEMA}.previews SET status = $2, decision_note = $3, decided_at = now(), notified_at = NULL, decision_source = 'email', decided_by = 'client:email-link'
  WHERE id = $1 AND status = 'pending' AND expires_at > now() AND review_status = 'passed'`;

// Every column DECISION_SQL writes. The pib_preview role needs UPDATE on each one: a plugin migration may not GRANT, so the
// database owner grants them by hand. One missing column makes Postgres refuse the whole UPDATE, and every client answer
// fails with a 500 (PAR-13038: decision_source and decided_by were never granted after 0.37.0 went live).
export const DECISION_COLUMNS = ["status", "decision_note", "decided_at", "notified_at", "decision_source", "decided_by"];

// The columns of $1 (text[]) the connected role may not UPDATE on previews. Empty: answers can be stored.
export const MISSING_GRANTS_SQL = `SELECT c AS column FROM unnest($1::text[]) AS c WHERE NOT has_column_privilege('${SCHEMA}.previews', c, 'UPDATE') ORDER BY c`;

/** The statement the database owner runs to add the missing column grants. */
export function grantFix(missing) {
  return `GRANT UPDATE (${missing.join(", ")}) ON ${SCHEMA}.previews TO pib_preview;`;
}

// Why an answer was not taken: $1 preview id.
export const DECISION_STATE_SQL = `SELECT status FROM ${SCHEMA}.previews WHERE id = $1`;

export const ALREADY_ANSWERED = "This preview has already been answered. To change it, reply to the email.";
export const NOT_READY = "This preview is not ready for an answer yet, or has expired.";
export const DECLINED_PAGE = "This proposal is not going ahead.";

/** The message for an answer that changed no row, from the row's current status (undefined: no such preview). */
export function refusedAnswer(status) {
  return status === "approved" || status === "changes_requested" || status === "declined" ? ALREADY_ANSWERED : NOT_READY;
}
