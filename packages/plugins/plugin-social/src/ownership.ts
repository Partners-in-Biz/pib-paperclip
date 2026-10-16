/**
 * Personal scope ownership rules: who can see, edit, approve, schedule, and publish.
 * - Org posts: anyone on the team sees them; approvers and schedulers from the approval policy.
 * - Personal posts: only the owner + co-workers in the team can see them; ONLY the owner can approve/schedule/publish.
 * - Agents: never approve/schedule/publish personal posts (they cannot act on personal drafts at all).
 */

import { SocialError } from "./domain.js";
import type { Space } from "./space.js";

export interface Actor {
  companyId: string;
  userId: string | null;
  isAgent: boolean;
}

export interface ScopedRow {
  scope: "org" | "personal";
  owner_user_id: string | null;
}

/**
 * Check if a row is visible to the actor (in company view, not personal).
 * Org rows are always visible; personal rows only to the owner.
 */
export function rowVisible(actor: Actor, row: ScopedRow): boolean {
  if (row.scope === "org") return true;
  return row.owner_user_id === actor.userId;
}

/**
 * Check if a personal post can be acted on (approved, scheduled, published) by this actor.
 * Only the owner can act; agents cannot act on personal posts.
 * Org posts are not restricted (they follow normal approval policy).
 */
export function canActOnPost(actor: Actor, post: ScopedRow): boolean {
  if (post.scope === "org") return true;
  if (actor.isAgent) return false;
  return post.owner_user_id === actor.userId;
}

/**
 * Require that the actor can act on a personal post; throw if not.
 */
export function requireCanActOnPost(actor: Actor, post: ScopedRow, action: string): void {
  if (!canActOnPost(actor, post)) {
    if (post.scope === "personal" && actor.isAgent) {
      throw new SocialError(`Agents cannot ${action} personal posts`);
    }
    throw new SocialError(`Only the post owner can ${action} this personal post`);
  }
}

/**
 * Filter a list of rows by space (visible to actor).
 * space 'company' = org rows only.
 * space 'me' = personal rows owned by actor only (actor.userId required).
 */
export function filterBySpace<T extends ScopedRow>(rows: T[], space: Space, actor: Actor): T[] {
  if (space === "company") return rows.filter((row) => row.scope === "org");
  if (space === "me") {
    if (!actor.userId) return [];
    return rows.filter((row) => row.scope === "personal" && row.owner_user_id === actor.userId);
  }
  return [];
}

/**
 * SQL WHERE clause to filter by space.
 * tableAlias optional (e.g. 'a' for 'accounts a'); if omitted, bare column names.
 * userId must be SQL-escaped or parameterized.
 */
export function spaceWhereClause(
  space: Space,
  actor: Actor,
  tableAlias?: string,
  userIdParam?: string,
): { clause: string; params: unknown[] } {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if (space === "company") {
    return { clause: `${prefix}scope = $1`, params: ["org"] };
  }
  if (space === "me") {
    if (!actor.userId) return { clause: "FALSE", params: [] };
    const paramNum = userIdParam ?? "$2";
    return {
      clause: `${prefix}scope = $1 AND ${prefix}owner_user_id = ${paramNum}`,
      params: ["personal", actor.userId],
    };
  }
  return { clause: "FALSE", params: [] };
}
