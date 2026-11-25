import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { PLANNING_CANVAS_SOURCE_ERROR_CODES as CODES, planningCanvasItemKeySchema, planningCanvasSourceRefreshSchema } from "@paperclipai/shared";
import { HttpError, badRequest } from "../errors.js";
import { restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import { assertPlanningCanvasBoardWritable } from "../services/planning-canvas-comments.js";
import { planningCanvasSourcesService, type PlanningCanvasSourcesDeps } from "../services/planning-canvas-sources.js";
import { planningCanvasChatOn } from "../services/planning-canvas-switches.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCanAssignTasks } from "./task-assignment-guard.js";
import { logPlanningCanvasActivity, planningCanvasForRequest, planningCanvasNotFound } from "./planning-canvases.js";

/**
 * Connector nodes (plan PAR-14257 D 4a; acceptance PAR-14282).
 *
 * `GET .../planning-canvases/:boardId/agents/:agentId/read-actions`: the
 * read-only connector actions the agent may use, for the picker. Needs `edit`
 * on the board (board editors lack `connections:read`, so the effective-profile
 * route is not theirs). Names and descriptions only.
 *
 * `POST .../planning-canvases/:boardId/items/:itemKey/refresh`: a person asks
 * the source's agent to fetch again. Needs `edit`, a signed-in person, and
 * `PLANNING_CANVAS_CHAT`. The body carries only `clientRequestId`: no person,
 * agent or run id is read from it.
 */

function personOf(req: Request) {
  if (req.actor.type === "agent") throw new HttpError(403, "Agents do not refresh board sources", { code: CODES.agentCaller });
  const userId = req.actor.type === "board" ? req.actor.userId?.trim() : "";
  if (!userId) throw new HttpError(403, "Refreshing a source needs a signed-in person", { code: CODES.personRequired });
  return userId;
}

export function planningCanvasSourceRoutes(db: Db, deps: PlanningCanvasSourcesDeps = {}) {
  const router = Router();
  const svc = planningCanvasSourcesService(db, deps);

  router.get("/companies/:companyId/planning-canvases/:boardId/agents/:agentId/read-actions", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "edit");
    const agentId = String(req.params.agentId ?? "");
    res.json({ actions: await svc.readActions(board.companyId, agentId) });
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/items/:itemKey/refresh", async (req, res) => {
    // A board caller with no person is refused before the board is read.
    if (req.actor.type === "board" && !req.actor.userId?.trim()) {
      throw new HttpError(403, "Refreshing a source needs a signed-in person", { code: CODES.personRequired });
    }
    const { board } = await planningCanvasForRequest(db, req, "edit");
    const refresherUserId = personOf(req);
    if (!planningCanvasChatOn()) throw new HttpError(403, "Source refresh is switched off", { code: CODES.refreshDisabled });
    assertPlanningCanvasBoardWritable(board);
    const itemKey = planningCanvasItemKeySchema.safeParse(req.params.itemKey);
    if (!itemKey.success) throw badRequest("Invalid item key", itemKey.error.issues);
    const parsed = planningCanvasSourceRefreshSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, board.companyId));
    if (!company) throw planningCanvasNotFound();
    const result = await svc.refresh(
      {
        board,
        refresherUserId,
        issuePrefix: company.issuePrefix,
        // The guards of `POST /companies/:companyId/issues` on the thread body (as chat).
        guard: async (body) => {
          assertCompanyAccess(req, board.companyId);
          await restrictedTaskBody(db, req, board.companyId, "createIssue", body, null);
          await assertCanAssignTasks(db, req, board.companyId, {
            projectId: typeof body.projectId === "string" ? body.projectId : null,
            assigneeAgentId: typeof body.assigneeAgentId === "string" ? body.assigneeAgentId : null,
          });
        },
      },
      itemKey.data,
      parsed.data,
    );
    if (!result.repeat) {
      await logPlanningCanvasActivity(db, req, board, "planning_canvas.source_refresh_requested", {
        agentId: result.agentId,
        itemKey: result.itemKey,
        thread: result.thread,
      });
    }
    res.status(result.repeat ? 200 : 201).json(result);
  });

  return router;
}
