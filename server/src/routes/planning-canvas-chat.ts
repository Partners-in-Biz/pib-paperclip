import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { PLANNING_CANVAS_CHAT_ERROR_CODES as CODES, planningCanvasChatMessageSchema } from "@paperclipai/shared";
import { HttpError, badRequest } from "../errors.js";
import { restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import { planningCanvasChatService } from "../services/planning-canvas-chat.js";
import { assertPlanningCanvasBoardWritable, type PlanningCanvasCommentsDeps } from "../services/planning-canvas-comments.js";
import { planningCanvasChatOn } from "../services/planning-canvas-switches.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCanAssignTasks } from "./task-assignment-guard.js";
import { logPlanningCanvasActivity, planningCanvasForRequest, planningCanvasNotFound } from "./planning-canvases.js";

/**
 * Board chat (plan PAR-14257 C "Interfaces", D 1a; acceptance PAR-14276).
 * `POST .../planning-canvases/:boardId/chat` needs `edit`, because the message
 * makes an agent edit the board. Order: the board (a denied board answers the
 * unknown-id bytes, as every canvas route), then the caller: an agent is
 * refused, and so is a board caller with no person. Then the switch
 * `PLANNING_CANVAS_CHAT`, then an archived board. The asker is the signed-in
 * person only; the body carries no person and no run id, and the caller's run
 * header is never used.
 */

/** A board caller with no person (a service or control-plane actor) is refused before the board is read. */
function assertPersonPresent(req: Request) {
  if (req.actor.type === "board" && !req.actor.userId?.trim()) {
    throw new HttpError(403, "Board chat needs a signed-in person", { code: CODES.personRequired });
  }
}

/** After the board resolved: agents are refused; the asker is the signed-in person. */
function askerOf(req: Request) {
  if (req.actor.type === "agent") {
    throw new HttpError(403, "Agents do not send board chat messages", { code: CODES.agentCaller });
  }
  const userId = req.actor.type === "board" ? req.actor.userId?.trim() : "";
  if (!userId) throw new HttpError(403, "Board chat needs a signed-in person", { code: CODES.personRequired });
  return userId;
}

export function planningCanvasChatRoutes(db: Db, deps: PlanningCanvasCommentsDeps = {}) {
  const router = Router();
  const svc = planningCanvasChatService(db, deps);

  router.post("/companies/:companyId/planning-canvases/:boardId/chat", async (req, res) => {
    assertPersonPresent(req);
    const { board } = await planningCanvasForRequest(db, req, "edit");
    const askerUserId = askerOf(req);
    if (!planningCanvasChatOn()) throw new HttpError(403, "Board chat is switched off", { code: CODES.disabled });
    assertPlanningCanvasBoardWritable(board);
    const parsed = planningCanvasChatMessageSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, board.companyId));
    if (!company) throw planningCanvasNotFound();
    const result = await svc.send(
      {
        board,
        askerUserId,
        issuePrefix: company.issuePrefix,
        // The guards of `POST /companies/:companyId/issues` on the thread body (as the mention path).
        guard: async (body) => {
          assertCompanyAccess(req, board.companyId);
          await restrictedTaskBody(db, req, board.companyId, "createIssue", body, null);
          await assertCanAssignTasks(db, req, board.companyId, {
            projectId: typeof body.projectId === "string" ? body.projectId : null,
            assigneeAgentId: typeof body.assigneeAgentId === "string" ? body.assigneeAgentId : null,
          });
        },
      },
      parsed.data,
    );
    if (!result.repeat) {
      // Ids and counts only: no message text, and no thread id of a personal board in the board's activity.
      await logPlanningCanvasActivity(db, req, board, "planning_canvas.chat_sent", {
        agentId: parsed.data.agentId,
        thread: result.thread,
        contextKeys: parsed.data.context?.itemKeys.length ?? 0,
      });
    }
    res.status(result.repeat ? 200 : 201).json(result);
  });

  return router;
}
