import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import { updatePlanningCanvasSharingSchema, type UpdatePlanningCanvasSharing } from "@paperclipai/shared";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { authorizationService } from "../services/authorization.js";
import {
  listPlanningCanvasAgentGrants,
  planningCanvasAgentGrantsOn,
  planningCanvasMemberAccessRank,
  revokePlanningCanvasAgentGrant,
} from "../services/planning-canvas-access.js";
import { publishPlanningCanvasEvent } from "../services/planning-canvas-events.js";
import { planningCanvasService } from "../services/planning-canvases.js";
import { logPlanningCanvasActivity, planningCanvasForRequest } from "./planning-canvases.js";

/**
 * Sharing and agent grants of one board (plan PAR-13925 Q15, Q16, Q6; C3).
 *
 * - Widening (personal to project or company, another project or scope,
 *   raising `memberAccess`) is the owner's alone; a board with no owner is
 *   administered by company admins, who may widen it.
 * - Narrowing, re-homing a project board whose project was deleted, archive
 *   and restore: owner or company admin (the resolver's `admin`).
 * - Leaving `personal` needs an explicit `memberAccess` (validator, Q15).
 * - Grants: list and revoke for the board's admins. No route writes a grant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BoardRow = Awaited<ReturnType<typeof planningCanvasForRequest>>["board"];

/** True when the change shows the board to anyone who could not see it before, or gives them more. */
export function planningCanvasSharingWidens(board: Pick<BoardRow, "scope" | "projectId" | "memberAccess">, next: UpdatePlanningCanvasSharing) {
  if (next.scope === "personal") return false;
  if (board.scope === "personal" || next.scope !== board.scope) return true;
  // Re-homing a project board whose project was deleted (Q16) is not a widening.
  if (next.scope === "project" && board.projectId !== null && next.projectId !== board.projectId) return true;
  const memberAccess = next.memberAccess ?? board.memberAccess;
  return planningCanvasMemberAccessRank(memberAccess) > planningCanvasMemberAccessRank(board.memberAccess);
}

function sharingBody(row: BoardRow) {
  return {
    id: row.id,
    userId: row.userId,
    scope: row.scope,
    projectId: row.projectId ?? null,
    memberAccess: row.memberAccess,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export function planningCanvasSharingRoutes(db: Db) {
  const router = Router();
  const svc = planningCanvasService(db);
  const authz = authorizationService(db);

  async function assertProjectTarget(req: Request, companyId: string, projectId: string) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
    const readable =
      project &&
      (await authz.decide({ actor: req.actor, action: "project:read", resource: { type: "project", companyId, projectId } })).allowed;
    if (!readable) throw unprocessable("Project not found", { field: "projectId" });
  }

  router.patch("/companies/:companyId/planning-canvases/:boardId/sharing", async (req, res) => {
    const { board, access } = await planningCanvasForRequest(db, req, "view");
    const parsed = updatePlanningCanvasSharingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const next = parsed.data;
    const callerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const isOwner = callerUserId !== null && board.userId === callerUserId;
    const widens = planningCanvasSharingWidens(board, next);

    if (widens) {
      const ownerless = board.userId === null;
      if (!isOwner && !(ownerless && access === "admin")) {
        throw forbidden("Only the board owner can widen sharing", { code: "PLANNING_CANVAS_OWNER_ONLY" });
      }
    } else if (access !== "admin") {
      throw forbidden("Planning canvas admin access required", { code: "PLANNING_CANVAS_ACCESS_TOO_LOW", access });
    }
    if (next.scope === "personal" && !board.userId) {
      throw unprocessable("A board without an owner cannot be personal", { field: "scope" });
    }
    const projectId = next.scope === "project" ? next.projectId! : null;
    if (projectId && projectId !== board.projectId) await assertProjectTarget(req, board.companyId, projectId);

    const before = sharingBody(board);
    const row = await svc.setSharing(board, {
      scope: next.scope,
      projectId,
      memberAccess: next.memberAccess ?? board.memberAccess,
    });
    const after = sharingBody(row);
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.sharing_updated", {
      before: { scope: before.scope, projectId: before.projectId, memberAccess: before.memberAccess },
      after: { scope: after.scope, projectId: after.projectId, memberAccess: after.memberAccess },
      widened: widens,
    });
    publishPlanningCanvasEvent({ type: "access.changed", companyId: board.companyId, boardId: board.id, reason: "sharing" });
    res.json(after);
  });

  router.get("/companies/:companyId/planning-canvases/:boardId/agent-grants", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "admin");
    res.json({ enabled: planningCanvasAgentGrantsOn(), grants: await listPlanningCanvasAgentGrants(db, board) });
  });

  router.delete("/companies/:companyId/planning-canvases/:boardId/agent-grants/:grantId", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "admin");
    const grantId = req.params.grantId as string;
    const grant = UUID.test(grantId) ? await revokePlanningCanvasAgentGrant(db, board, grantId) : null;
    if (!grant) throw notFound("Planning canvas agent grant not found");
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.agent_grant_revoked", {
      grantId: grant.id,
      agentId: grant.agentId,
      issueId: grant.issueId,
    });
    publishPlanningCanvasEvent({ type: "access.changed", companyId: board.companyId, boardId: board.id, reason: "grant_revoked" });
    res.json(grant);
  });

  return router;
}
