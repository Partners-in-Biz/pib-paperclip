import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { planningCanvasFromBlueprintSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import { planningCanvasBlueprintsService, type PlanningCanvasBlueprintsDeps } from "../services/planning-canvas-blueprints.js";
import { assertCompanyAccess } from "./authz.js";
import { logPlanningCanvasActivity, planningCanvasCompany, planningCanvasNotFound } from "./planning-canvases.js";
import { assertCanAssignTasks } from "./task-assignment-guard.js";

/**
 * Planning Canvas blueprint apply (plan PAR-13925 G, J.4, Q11; C14). The six
 * built-ins live in `@paperclipai/shared` (`PLANNING_CANVAS_BLUEPRINTS`), so
 * the gallery and preview need no route. Apply creates a board, so it has the
 * board-create rules: a signed-in person who is an active, non-viewer member
 * (another company or a non-member gets the unknown-id answer), plus the Q11
 * issue guards on every issue it would create.
 */

export function planningCanvasBlueprintRoutes(db: Db, deps: PlanningCanvasBlueprintsDeps = {}) {
  const router = Router();
  const svc = planningCanvasBlueprintsService(db, deps);

  router.post("/companies/:companyId/planning-canvases/from-blueprint", async (req, res) => {
    const companyId = planningCanvasCompany(req);
    const userId = req.actor.type === "board" && req.actor.userId ? req.actor.userId : null;
    if (!userId) throw forbidden("Only a signed-in person can create a planning canvas board");
    if (req.actor.source !== "local_implicit") {
      const membership = req.actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
      if (!membership) throw planningCanvasNotFound();
      if (membership.membershipRole === "viewer") throw forbidden("Viewer access is read-only");
    }
    const parsed = planningCanvasFromBlueprintSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const result = await svc.apply(
      {
        companyId,
        userId,
        actor: req.actor,
        // Q11: the guards of `POST /companies/:companyId/issues`, on each body the apply would create.
        guard: async (body) => {
          assertCompanyAccess(req, companyId);
          await restrictedTaskBody(db, req, companyId, "createIssue", body, null);
          if (typeof body.assigneeAgentId === "string") {
            await assertCanAssignTasks(db, req, companyId, { projectId: null, assigneeAgentId: body.assigneeAgentId });
          }
        },
      },
      parsed.data,
    );
    if (!result.replayed) {
      await logPlanningCanvasActivity(db, req, { id: result.board.id, companyId }, "planning_canvas.created_from_blueprint", {
        blueprintId: result.blueprintId,
        title: result.board.title,
        parentIssueId: result.parentIssue?.id ?? null,
        issues: result.issues.map((issue) => ({ id: issue.id, itemKey: issue.itemKey })),
      });
    }
    res.status(result.replayed ? 200 : 201).json({ ...result, access: "admin" });
  });

  return router;
}
