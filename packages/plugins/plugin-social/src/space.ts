/**
 * Personal vs company space: a viewer filter for lists and snapshots.
 * 'company' = org rows only (what the team sees).
 * 'me' = personal rows owned by the viewer only (requires viewer.userId).
 */

export type Space = "company" | "me";

export interface Viewer {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  isAgent: boolean;
}

export interface ScopedRow {
  scope: "org" | "personal";
  owner_user_id: string | null;
}

/**
 * Check if a row matches the requested space for this viewer.
 * 'company' = org rows only.
 * 'me' = personal rows owned by viewer (requires viewer.userId).
 */
export function spaceMatches(space: Space, viewer: Viewer, row: ScopedRow): boolean {
  if (space === "company") return row.scope === "org";
  if (space === "me") {
    if (!viewer.userId) return false;
    return row.scope === "personal" && row.owner_user_id === viewer.userId;
  }
  return false;
}

/**
 * SQL WHERE clause to filter by space for a row that has scope and owner_user_id columns.
 * table_alias (e.g. 'a' for 'accounts a') is optional; if omitted, bare 'scope' is used.
 */
export function spaceSql(space: Space, viewer: Viewer, tableAlias?: string): string {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if (space === "company") return `${prefix}scope = 'org'`;
  if (space === "me") return `${prefix}scope = 'personal' AND ${prefix}owner_user_id = $X`.replace("$X", viewer.userId ? `'${viewer.userId.replace(/'/g, "''")}'` : "NULL");
  return "FALSE";
}
