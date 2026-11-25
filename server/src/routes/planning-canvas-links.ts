import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { planningCanvasHandoffSchema, planningCanvasQueryBodySchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import { assertPlanningCanvasBoardWritable } from "../services/planning-canvas-comments.js";
import { planningCanvasLinksService, type PlanningCanvasLinksDeps } from "../services/planning-canvas-links.js";
import type { PlanningCanvasOpsActor } from "../services/planning-canvas-ops.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCanAssignTasks } from "./task-assignment-guard.js";
import { planningCanvasRefsQuerySchema } from "./openapi-planning-canvas/links.js";
import { logPlanningCanvasActivity, planningCanvasForRequest, planningCanvasNotFound } from "./planning-canvases.js";

/**
 * Planning Canvas refs hydration, handoff and issue query (plan PAR-13925 G,
 * J.4, Q11, Q17; C8). Every handler resolves the board with
 * `planningCanvasForRequest` first, so a denied board answers exactly what an
 * unknown one does. `refs` and `query` need `view`: they only answer what the
 * reader may read anyway, and kanban and timeline nodes must render for
 * viewers. `handoff` needs `edit` plus the Q11 guards on every issue body.
 */

function caller(req: Request): PlanningCanvasOpsActor {
  if (req.actor.type === "agent" && req.actor.agentId) return { type: "agent", id: req.actor.agentId };
  if (req.actor.type === "board" && req.actor.userId) return { type: "user", id: req.actor.userId };
  throw planningCanvasNotFound();
}

export function planningCanvasLinkRoutes(db: Db, deps: PlanningCanvasLinksDeps = {}) {
  const router = Router();
  const svc = planningCanvasLinksService(db, deps);

  router.get("/companies/:companyId/planning-canvases/:boardId/refs", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "view");
    const parsed = planningCanvasRefsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid planning canvas refs query", parsed.error.issues);
    res.json(await svc.refs(board, req.actor, { keys: parsed.data.keys }));
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/query", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "view");
    const parsed = planningCanvasQueryBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    res.json(await svc.query(board, req.actor, parsed.data));
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/handoff", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "edit");
    assertPlanningCanvasBoardWritable(board);
    const parsed = planningCanvasHandoffSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const ctx = {
      board,
      actor: req.actor,
      caller: caller(req),
      // Q11: the guards of `POST /companies/:companyId/issues`, on each body the handoff would create.
      guard: async (body: Record<string, unknown>) => {
        assertCompanyAccess(req, board.companyId);
        await restrictedTaskBody(db, req, board.companyId, "createIssue", body, null);
        if (typeof body.assigneeAgentId === "string") {
          await assertCanAssignTasks(db, req, board.companyId, {
            projectId: typeof body.projectId === "string" ? body.projectId : null,
            assigneeAgentId: body.assigneeAgentId,
          });
        }
      },
    };
    // Over a bucket this throws 409 `canvas_issue_rate_limited` before any write.
    const result = await svc.handoff(ctx, parsed.data);
    if (!result.replayed) {
      await logPlanningCanvasActivity(db, req, board, "planning_canvas.handoff", {
        mode: result.mode,
        assigneeAgentId: parsed.data.assigneeAgentId ?? null,
        issues: result.issues.map((issue) => ({ id: issue.id, itemKeys: issue.itemKeys })),
      });
    }
    res.status(result.replayed ? 200 : 201).json(result);
  });

  return router;
}
