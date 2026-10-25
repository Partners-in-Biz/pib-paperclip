/**
 * Personal vs company space: a viewer filter for lists and snapshots.
 * 'company' = org rows only (what the team sees).
 * 'me' = personal rows owned by the viewer only (requires viewer.userId).
 */

import { SocialError } from "./domain.js";

export type Space = "company" | "me";

/** The space an action or page asks for: `space: "me"` is the signed-in user's own socials, anything else is the company. */
export function spaceOf(params: Record<string, unknown>): Space {
  const value = params.space;
  if (value === undefined || value === null || value === "" || value === "company") return "company";
  if (value === "me") return "me";
  throw new SocialError(`space must be 'company' or 'me', not '${String(value)}'`);
}

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

