import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createPlanningCanvasCommentSchema, resolvePlanningCanvasCommentSchema } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { restrictedTaskBody } from "../services/member-restriction/body-allowlist.js";
import {
  assertPlanningCanvasBoardWritable,
  planningCanvasCommentsService,
  type PlanningCanvasCommentAuthor,
  type PlanningCanvasCommentContext,
  type PlanningCanvasCommentsDeps,
} from "../services/planning-canvas-comments.js";
import { assertCompanyAccess } from "./authz.js";
import { assertCanAssignTasks } from "./task-assignment-guard.js";
import { planningCanvasCommentListQuerySchema, updatePlanningCanvasCommentSchema } from "./openapi-planning-canvas/comments.js";
import { logPlanningCanvasActivity, planningCanvasForRequest, planningCanvasNotFound } from "./planning-canvases.js";

/**
 * Planning Canvas node comments, @agent mentions and thread reads (plan
 * PAR-13925 Q7, Q8, Q11, J.4; C6). Every handler resolves the board with
 * `planningCanvasForRequest` first, so a denied board answers exactly what an
 * unknown one does. Reads need `view`; writes need `comment`. A mention also
 * needs the Q11 guards on the issue body it would create; when they refuse,
 * the comment is still saved and the mention is `not_sent:<reason>`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commentAuthor(req: Request): PlanningCanvasCommentAuthor {
  if (req.actor.type === "agent" && req.actor.agentId) return { type: "agent", agentId: req.actor.agentId };
  if (req.actor.type === "board" && req.actor.userId) return { type: "user", userId: req.actor.userId };
  throw planningCanvasNotFound();
}

function commentIdOf(req: Request) {
  const commentId = req.params.commentId as string;
  if (!UUID.test(commentId)) throw notFound("Planning canvas comment not found");
  return commentId;
}

export function planningCanvasCommentRoutes(db: Db, deps: PlanningCanvasCommentsDeps = {}) {
  const router = Router();
  const svc = planningCanvasCommentsService(db, deps);

  /**
   * A writable board (already resolved at `comment` level by the handler, so
   * the C3 sweep sees the guard) and the Q11 guards bound to this request.
   */
  function writeContext(req: Request, board: PlanningCanvasCommentContext["board"]): PlanningCanvasCommentContext {
    assertPlanningCanvasBoardWritable(board);
    return {
      board,
      actor: req.actor,
      author: commentAuthor(req),
      // Q11: the same guards as `POST /companies/:companyId/issues`, on the body the canvas would create,
      // once per mentioned agent: company access, the restricted-member body check, then the assignment
      // checks that body check leaves to the handler (`tasks:assign` with the strict project read, and
      // the agent on a restricted member's list). Each refusal records its own denial row.
      guard: async (body) => {
        assertCompanyAccess(req, board.companyId);
        await restrictedTaskBody(db, req, board.companyId, "createIssue", body, null);
        await assertCanAssignTasks(db, req, board.companyId, {
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          assigneeAgentId: typeof body.assigneeAgentId === "string" ? body.assigneeAgentId : null,
        });
      },
    };
  }

  router.get("/companies/:companyId/planning-canvases/:boardId/comments", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "view");
    const parsed = planningCanvasCommentListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid planning canvas comment query", parsed.error.issues);
    if (parsed.data.itemKey !== undefined && parsed.data.thread !== undefined) {
      throw badRequest("Use itemKey or thread=board, not both");
    }
    const thread =
      parsed.data.itemKey !== undefined
        ? { itemKey: parsed.data.itemKey }
        : parsed.data.thread === "board"
          ? { itemKey: null }
          : undefined;
    res.json(await svc.list(board, req.actor, { thread }));
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/comments", async (req, res) => {
    const ctx = writeContext(req, (await planningCanvasForRequest(db, req, "comment")).board);
    const parsed = createPlanningCanvasCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const comment = await svc.create(ctx, parsed.data);
    await logPlanningCanvasActivity(db, req, ctx.board, "planning_canvas.comment_created", {
      commentId: comment.id,
      itemKey: comment.itemKey,
      parentId: comment.parentId,
      mentionState: comment.mentionState,
      linkedIssueId: comment.linkedIssueId,
    });
    res.status(201).json(comment);
  });

  router.patch("/companies/:companyId/planning-canvases/:boardId/comments/:commentId", async (req, res) => {
    const ctx = writeContext(req, (await planningCanvasForRequest(db, req, "comment")).board);
    const commentId = commentIdOf(req);
    const parsed = updatePlanningCanvasCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const comment = await svc.update(ctx, commentId, parsed.data.body);
    await logPlanningCanvasActivity(db, req, ctx.board, "planning_canvas.comment_updated", {
      commentId: comment.id,
      mentionState: comment.mentionState,
    });
    res.json(comment);
  });

  router.delete("/companies/:companyId/planning-canvases/:boardId/comments/:commentId", async (req, res) => {
    const { board, access } = await planningCanvasForRequest(db, req, "comment");
    assertPlanningCanvasBoardWritable(board);
    const commentId = commentIdOf(req);
    const comment = await svc.remove(board, commentId, commentAuthor(req), access === "admin");
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.comment_deleted", { commentId: comment.id });
    res.json(comment);
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/comments/:commentId/resolve", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "comment");
    assertPlanningCanvasBoardWritable(board);
    const commentId = commentIdOf(req);
    const parsed = resolvePlanningCanvasCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const author = commentAuthor(req);
    const comment = await svc.setResolved(board, commentId, parsed.data.resolved, author.type === "user" ? author.userId : null);
    await logPlanningCanvasActivity(
      db,
      req,
      board,
      parsed.data.resolved ? "planning_canvas.comment_resolved" : "planning_canvas.comment_reopened",
      { commentId: comment.id },
    );
    res.json(comment);
  });

  return router;
}
