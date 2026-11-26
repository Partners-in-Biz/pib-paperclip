import { Router, type Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { planningCanvasItems, type Db } from "@paperclipai/db";
import {
  PLANNING_CANVAS_UNFURL_ERROR_CODES as CODES,
  planningCanvasUnfurlSchema,
  type PlanningCanvasUnfurlResult,
} from "@paperclipai/shared";
import { HttpError, badRequest } from "../errors.js";
import { assertPlanningCanvasBoardWritable } from "../services/planning-canvas-comments.js";
import { planningCanvasUnfurlOn } from "../services/planning-canvas-switches.js";
import {
  createPlanningCanvasUnfurlGate,
  fetchPlanningCanvasWebLinkPreview,
  type PlanningCanvasUnfurlDeps,
  type PlanningCanvasUnfurlGateOptions,
} from "../services/planning-canvas-unfurl.js";
import { planningCanvasForRequest } from "./planning-canvases.js";

/**
 * Web link preview (plan PAR-14389 C.5 "Preview fetch", D3).
 * `POST .../planning-canvases/:boardId/unfurl { nodeId }` needs `edit` and a
 * signed-in person (agents are refused: the button is the only caller). Order:
 * the board (a denied board answers the unknown-id bytes, as every canvas
 * route), the person, then `PLANNING_CANVAS_UNFURL` (off: nothing is read or
 * fetched), an archived board, the rate limit, then the stored node. The URL is
 * read from the node, never from the body. The browser saves the answer
 * through the ops route; this route writes nothing.
 */

function personOf(req: Request) {
  if (req.actor.type === "agent") throw new HttpError(403, "Agents do not fetch link previews", { code: CODES.agentCaller });
  const userId = req.actor.type === "board" ? req.actor.userId?.trim() : "";
  if (!userId) throw new HttpError(403, "A link preview needs a signed-in person", { code: CODES.personRequired });
  return userId;
}

export function planningCanvasUnfurlRoutes(db: Db, deps: PlanningCanvasUnfurlDeps & { gate?: PlanningCanvasUnfurlGateOptions } = {}) {
  const router = Router();
  const gate = createPlanningCanvasUnfurlGate(deps.gate);

  router.post("/companies/:companyId/planning-canvases/:boardId/unfurl", async (req, res) => {
    if (req.actor.type === "board" && !req.actor.userId?.trim()) {
      throw new HttpError(403, "A link preview needs a signed-in person", { code: CODES.personRequired });
    }
    const { board } = await planningCanvasForRequest(db, req, "edit");
    const userId = personOf(req);
    if (!planningCanvasUnfurlOn()) throw new HttpError(403, "Link previews are switched off", { code: CODES.disabled });
    assertPlanningCanvasBoardWritable(board);
    const parsed = planningCanvasUnfurlSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);

    const [row] = await db
      .select({ itemType: planningCanvasItems.itemType, kind: planningCanvasItems.kind, data: planningCanvasItems.data })
      .from(planningCanvasItems)
      .where(and(
        eq(planningCanvasItems.boardId, board.id),
        eq(planningCanvasItems.companyId, board.companyId),
        eq(planningCanvasItems.itemKey, parsed.data.nodeId),
        isNull(planningCanvasItems.deletedAt),
      ));
    const url = (row?.data as { data?: { url?: unknown } } | undefined)?.data?.url;
    if (!row || row.itemType !== "node" || row.kind !== "weblink" || typeof url !== "string") {
      throw new HttpError(404, "Not a web link on this board", { code: CODES.noWebLink });
    }

    const ticket = gate.tryStart(board.companyId, userId);
    if (!ticket.ok) {
      if (ticket.refusal === "rate") res.setHeader("Retry-After", String(ticket.retryAfterSeconds));
      throw new HttpError(429, ticket.refusal === "rate" ? "Too many link previews; try again later" : "Link previews are busy; try again in a moment", {
        code: ticket.refusal === "rate" ? CODES.rateLimited : CODES.busy,
      });
    }
    try {
      const result: PlanningCanvasUnfurlResult = { preview: await fetchPlanningCanvasWebLinkPreview(url, deps) };
      res.json(result);
    } finally {
      ticket.release();
    }
  });

  return router;
}
