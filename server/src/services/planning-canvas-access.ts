import { and, eq, isNull, notInArray } from "drizzle-orm";
import { agents, issues, planningCanvasAgentGrants, planningCanvases, type Db } from "@paperclipai/db";
import type {
  ActorCompanyMembership,
  PlanningCanvasAccessLevel,
  PlanningCanvasAgentGrant,
  PlanningCanvasAgentGrantSource,
  PlanningCanvasMemberAccess,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { memberRestrictionForMembership } from "./member-restriction/actor-memberships.js";
import { memberRestrictionResolver } from "./member-restriction/resolver.js";

/**
 * The one Planning Canvas access resolver (plan PAR-13925 section D). Every
 * canvas route, and later the WebSocket upgrade (C11), asks
 * `planningCanvasAccess` and nothing else. It answers `none | view | comment |
 * edit | admin`; the routes turn `none` into exactly the unknown-id answer.
 *
 * Agents open a personal board only through a live row of
 * `planning_canvas_agent_grants` (Q6), and only while the kill switch
 * `PLANNING_CANVAS_AGENT_GRANTS` is on (Q14, default off). The switch is read
 * through `planningCanvasAgentGrantsOn` only; the grant writers of C6 and C8
 * use the same helper. A failed restriction read throws 503 (fails closed).
 */

export const PLANNING_CANVAS_AGENT_GRANTS_ENV = "PLANNING_CANVAS_AGENT_GRANTS";

type BoardRow = typeof planningCanvases.$inferSelect;
export type PlanningCanvasAccessBoard = Pick<BoardRow, "id" | "companyId" | "userId" | "scope" | "projectId" | "memberAccess">;
type Membership = Partial<ActorCompanyMembership> & { companyId: string };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const RANK: Record<PlanningCanvasAccessLevel, number> = { none: 0, view: 1, comment: 2, edit: 3, admin: 4 };
const ADMIN_ROLES = new Set(["owner", "admin"]);
/** A grant lapses when its issue reaches one of these (Q6). */
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
const FLAG_ON_VALUES = new Set(["on", "true", "1"]);

export function planningCanvasAccessAtLeast(level: PlanningCanvasAccessLevel, needed: PlanningCanvasAccessLevel) {
  return RANK[level] >= RANK[needed];
}

function lower(a: PlanningCanvasAccessLevel, b: PlanningCanvasAccessLevel): PlanningCanvasAccessLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Rank of a stored `memberAccess`, for the sharing API's "is this a raise" check. */
export function planningCanvasMemberAccessRank(value: PlanningCanvasMemberAccess) {
  return RANK[value];
}

/**
 * The kill switch, read on every call (never cached). On only for `on`, `true`
 * or `1`. When reading it throws, the answer is off: no grant access and no
 * grant written (plan J.3).
 */
export function planningCanvasAgentGrantsOn(): boolean {
  try {
    const raw = process.env[PLANNING_CANVAS_AGENT_GRANTS_ENV];
    return typeof raw === "string" && FLAG_ON_VALUES.has(raw.trim().toLowerCase());
  } catch (err) {
    logger.warn({ err }, "planning canvas agent grant switch unreadable; treating it as off");
    return false;
  }
}

/** True when a live grant lets `agentId` open the personal board: switch on, not revoked, by the current owner, issue open. */
async function hasLiveGrant(db: Db | Tx, board: PlanningCanvasAccessBoard, agentId: string) {
  if (!board.userId || !planningCanvasAgentGrantsOn()) return false;
  const rows = await db
    .select({ id: planningCanvasAgentGrants.id })
    .from(planningCanvasAgentGrants)
    .innerJoin(issues, eq(issues.id, planningCanvasAgentGrants.issueId))
    .where(
      and(
        eq(planningCanvasAgentGrants.boardId, board.id),
        eq(planningCanvasAgentGrants.companyId, board.companyId),
        eq(planningCanvasAgentGrants.agentId, agentId),
        eq(planningCanvasAgentGrants.grantedByUserId, board.userId),
        isNull(planningCanvasAgentGrants.revokedAt),
        eq(issues.companyId, board.companyId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, CLOSED_ISSUE_STATUSES),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

type UserCaller = {
  userId: string;
  memberships: Membership[] | undefined;
  localImplicit: boolean;
  actor: AuthorizationActor;
};

/**
 * Builds a resolver for one actor. Restriction and `project:read` answers are
 * memoized per call of this factory, so a list resolves many boards cheaply.
 */
export function planningCanvasAccessResolver(db: Db, actor: AuthorizationActor) {
  const authz = authorizationService(db);
  const resolveRestriction = memberRestrictionResolver(db);
  const restrictionMemo = new Map<string, Promise<boolean>>();
  const projectMemo = new Map<string, Promise<boolean>>();

  function restricted(personId: string, companyId: string, membership: Membership | null | undefined) {
    const key = `${personId}:${companyId}`;
    let found = restrictionMemo.get(key);
    if (!found) {
      found = memberRestrictionForMembership(resolveRestriction, personId, companyId, membership).then((r) => r.restricted);
      restrictionMemo.set(key, found);
    }
    return found;
  }

  function canReadProject(who: AuthorizationActor, whoKey: string, companyId: string, projectId: string) {
    const key = `${whoKey}:${projectId}`;
    let found = projectMemo.get(key);
    if (!found) {
      found = authz
        .decide({ actor: who, action: "project:read", resource: { type: "project", companyId, projectId } })
        .then((decision) => decision.allowed);
      projectMemo.set(key, found);
    }
    return found;
  }

  /** A person's cell of the matrix: owner, member, viewer, restricted member, company admin. */
  async function userCell(caller: UserCaller, board: PlanningCanvasAccessBoard): Promise<PlanningCanvasAccessLevel> {
    if (caller.localImplicit) {
      if (board.userId === caller.userId) return "admin";
      return board.scope === "personal" ? "none" : "admin";
    }
    // Instance admins who are no member, other companies, and inactive members get nothing.
    const membership = caller.memberships?.find((m) => m.companyId === board.companyId && m.status === "active");
    if (!membership) return "none";
    if (board.userId === caller.userId) return "admin";
    if (board.scope === "personal") return "none";

    const isRestricted = await restricted(caller.userId, board.companyId, membership);
    const isAdmin = !isRestricted && ADMIN_ROLES.has(membership.membershipRole ?? "");
    const isViewer = membership.membershipRole === "viewer";
    const memberCell: PlanningCanvasAccessLevel = isViewer ? "view" : board.memberAccess;

    if (board.scope === "company") {
      if (isRestricted) return "none";
      return isAdmin ? "admin" : memberCell;
    }
    // Project board. A deleted project (`project_id` null): owner and company admins only (Q16).
    if (!board.projectId) return isAdmin ? "admin" : "none";
    if (!(await canReadProject(caller.actor, `user:${caller.userId}`, board.companyId, board.projectId))) return "none";
    return isAdmin ? "admin" : memberCell;
  }

  /** The agent's own cell, before the person it works for is applied. */
  async function agentCell(agentId: string, board: PlanningCanvasAccessBoard): Promise<PlanningCanvasAccessLevel> {
    if (board.scope === "personal") return (await hasLiveGrant(db, board, agentId)) ? "edit" : "none";
    if (board.scope === "company") return "edit";
    if (!board.projectId) return "none";
    return (await canReadProject(actor, `agent:${agentId}`, board.companyId, board.projectId)) ? "edit" : "none";
  }

  return async function resolve(board: PlanningCanvasAccessBoard): Promise<PlanningCanvasAccessLevel> {
    if (actor.type === "board") {
      if (!actor.userId) return "none";
      return userCell(
        { userId: actor.userId, memberships: actor.memberships, localImplicit: actor.source === "local_implicit", actor },
        board,
      );
    }
    if (actor.type !== "agent" || !actor.agentId || actor.companyId !== board.companyId) return "none";
    // Narrow keys (skill tests, task bridges) never open a board.
    if (actor.keyScope && actor.keyScope.kind !== "standard") return "none";

    const personId = actor.onBehalfOfUserId?.trim() || null;
    const own = await agentCell(actor.agentId, board);
    if (!personId) return own;
    const membership = actor.onBehalfOfMemberships?.find((m) => m.companyId === board.companyId) ?? null;
    if (board.scope === "personal") {
      // Grant row only, never the owner's access; a run for a restricted person gets nothing.
      if (own === "none" || !membership || membership.status !== "active") return "none";
      return (await restricted(personId, board.companyId, membership)) ? "none" : own;
    }
    if (own === "none") return "none";
    const person: AuthorizationActor = {
      type: "board",
      userId: personId,
      source: "session",
      memberships: actor.onBehalfOfMemberships,
      companyIds: (actor.onBehalfOfMemberships ?? []).filter((m) => m.status === "active").map((m) => m.companyId),
      isInstanceAdmin: false,
    };
    const personLevel = await userCell(
      { userId: personId, memberships: actor.onBehalfOfMemberships, localImplicit: false, actor: person },
      board,
    );
    return lower(own, personLevel);
  };
}

/** One board, one actor. */
export function planningCanvasAccess(db: Db, actor: AuthorizationActor, board: PlanningCanvasAccessBoard) {
  return planningCanvasAccessResolver(db, actor)(board);
}

// ---------------------------------------------------------------------------
// Agent grants (Q6): one writer, used by the C6 mention and C8 handoff paths
// ---------------------------------------------------------------------------

export interface WritePlanningCanvasAgentGrantInput {
  actor: AuthorizationActor;
  board: PlanningCanvasAccessBoard;
  agentId: string;
  issueId: string;
  source: PlanningCanvasAgentGrantSource;
  now?: Date;
}

function grantOf(row: typeof planningCanvasAgentGrants.$inferSelect): PlanningCanvasAgentGrant {
  return {
    id: row.id,
    companyId: row.companyId,
    boardId: row.boardId,
    agentId: row.agentId,
    issueId: row.issueId,
    grantedByUserId: row.grantedByUserId,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * Writes (or renews) a grant inside the caller's issue-create transaction.
 * Writes only when the switch is on, the board is personal, and the caller is
 * the board owner signed in as himself (a session, not a key, not an agent).
 * Otherwise writes nothing and answers null. No route takes a grant in its body.
 */
export async function writePlanningCanvasAgentGrant(
  tx: Db | Tx,
  input: WritePlanningCanvasAgentGrantInput,
): Promise<PlanningCanvasAgentGrant | null> {
  const { actor, board } = input;
  if (!planningCanvasAgentGrantsOn()) return null;
  if (board.scope !== "personal" || !board.userId) return null;
  if (actor.type !== "board" || actor.source !== "session" || actor.userId !== board.userId) return null;
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, board.companyId)));
  const [issue] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, board.companyId)));
  if (!agent || !issue) return null;
  const [row] = await tx
    .insert(planningCanvasAgentGrants)
    .values({
      companyId: board.companyId,
      boardId: board.id,
      agentId: agent.id,
      issueId: issue.id,
      grantedByUserId: board.userId,
      source: input.source,
      createdAt: input.now ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [planningCanvasAgentGrants.boardId, planningCanvasAgentGrants.agentId, planningCanvasAgentGrants.issueId],
      // A new owner action on a revoked grant renews it.
      set: { revokedAt: null, grantedByUserId: board.userId },
    })
    .returning();
  return row ? grantOf(row) : null;
}

export type PlanningCanvasAgentGrantView = PlanningCanvasAgentGrant & {
  /** True while the grant opens the board: switch on, not revoked, issue not done or cancelled. */
  active: boolean;
};

export async function listPlanningCanvasAgentGrants(db: Db, board: PlanningCanvasAccessBoard): Promise<PlanningCanvasAgentGrantView[]> {
  const enabled = planningCanvasAgentGrantsOn();
  const rows = await db
    .select({ grant: planningCanvasAgentGrants, issueStatus: issues.status, issueHiddenAt: issues.hiddenAt })
    .from(planningCanvasAgentGrants)
    .innerJoin(issues, eq(issues.id, planningCanvasAgentGrants.issueId))
    .where(and(eq(planningCanvasAgentGrants.boardId, board.id), eq(planningCanvasAgentGrants.companyId, board.companyId)))
    .orderBy(planningCanvasAgentGrants.createdAt);
  return rows.map(({ grant, issueStatus, issueHiddenAt }) => ({
    ...grantOf(grant),
    active:
      enabled &&
      !grant.revokedAt &&
      grant.grantedByUserId === board.userId &&
      !issueHiddenAt &&
      !CLOSED_ISSUE_STATUSES.includes(issueStatus),
  }));
}

/** Revokes one grant of the board. Null when the board has no such grant. Revoking twice keeps the first time. */
export async function revokePlanningCanvasAgentGrant(
  db: Db,
  board: PlanningCanvasAccessBoard,
  grantId: string,
  now = new Date(),
): Promise<PlanningCanvasAgentGrant | null> {
  const where = and(
    eq(planningCanvasAgentGrants.id, grantId),
    eq(planningCanvasAgentGrants.boardId, board.id),
    eq(planningCanvasAgentGrants.companyId, board.companyId),
  );
  const [updated] = await db
    .update(planningCanvasAgentGrants)
    .set({ revokedAt: now })
    .where(and(where, isNull(planningCanvasAgentGrants.revokedAt)))
    .returning();
  if (updated) return grantOf(updated);
  const [existing] = await db.select().from(planningCanvasAgentGrants).where(where);
  return existing ? grantOf(existing) : null;
}
