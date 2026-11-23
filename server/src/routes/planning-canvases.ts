import { Router, type Request } from "express";
import { and, eq, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import { companies, planningCanvasAgentGrants, planningCanvases, type Db } from "@paperclipai/db";
import {
  PLANNING_CANVAS_SCOPES,
  createPlanningCanvasSchema,
  planningCanvasReadQuerySchema,
  updatePlanningCanvasSchema,
  type PlanningCanvasAccessLevel,
} from "@paperclipai/shared";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import {
  planningCanvasAccessAtLeast,
  planningCanvasAccessResolver,
  planningCanvasAgentGrantsOn,
} from "../services/planning-canvas-access.js";
import { publishPlanningCanvasEvent } from "../services/planning-canvas-events.js";
import { planningCanvasOpsService, type PlanningCanvasOpsActor } from "../services/planning-canvas-ops.js";
import { planningCanvasService } from "../services/planning-canvases.js";
import { getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Planning Canvas core routes (plan PAR-13925 sections D and G, C3). Every
 * board route resolves access with `planningCanvasAccess`; a caller with no
 * access gets exactly the unknown-id answer (`PLANNING_CANVAS_NOT_FOUND`), and
 * so does another company or an unknown company. A caller who may read the
 * board but not do the action gets 403 (that reveals nothing he cannot see).
 */

export const PLANNING_CANVAS_NOT_FOUND = "Planning canvas board not found";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BoardRow = typeof planningCanvases.$inferSelect;

/** The unknown-id answer. Every denial throws exactly this. */
export function planningCanvasNotFound() {
  return notFound(PLANNING_CANVAS_NOT_FOUND);
}

/** The company of the path, when the caller may reach it at all; else the unknown-id answer. */
export function planningCanvasCompany(req: Request) {
  const companyId = req.params.companyId as string;
  if (!UUID.test(companyId) || !hasCompanyAccess(req, companyId)) throw planningCanvasNotFound();
  return companyId;
}

/**
 * The board of the path and the caller's level on it. `none`, an unknown id,
 * a malformed id and another company's board all throw the same 404; a level
 * below `needed` throws 403.
 */
export async function planningCanvasForRequest(db: Db, req: Request, needed: Exclude<PlanningCanvasAccessLevel, "none">) {
  const companyId = planningCanvasCompany(req);
  const boardId = req.params.boardId as string;
  if (!UUID.test(boardId)) throw planningCanvasNotFound();
  const [board] = await db
    .select()
    .from(planningCanvases)
    .where(and(eq(planningCanvases.id, boardId), eq(planningCanvases.companyId, companyId)))
    .limit(1);
  if (!board) throw planningCanvasNotFound();
  const access = await planningCanvasAccessResolver(db, req.actor)(board);
  if (access === "none") throw planningCanvasNotFound();
  if (!planningCanvasAccessAtLeast(access, needed)) {
    throw forbidden(`Planning canvas ${needed} access required`, { code: "PLANNING_CANVAS_ACCESS_TOO_LOW", access });
  }
  return { board, access };
}

/** Activity entry for a board mutation (AGENTS.md section 8). */
export async function logPlanningCanvasActivity(
  db: Db,
  req: Request,
  board: Pick<BoardRow, "id" | "companyId">,
  action: string,
  details: Record<string, unknown> = {},
) {
  const actor = getActorInfo(req);
  await logActivity(db, {
    companyId: board.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action,
    entityType: "planning_canvas",
    entityId: board.id,
    details,
  });
}

const listQuerySchema = z.strictObject({
  scope: z.enum(PLANNING_CANVAS_SCOPES).optional(),
  projectId: z.string().uuid().optional(),
  archived: z.enum(["true", "false"]).optional(),
});

/** The person a board user is: the only callers who create boards or use the legacy whole-board PATCH. */
function boardUserId(req: Request) {
  return req.actor.type === "board" && req.actor.userId ? req.actor.userId : null;
}

function opsActor(req: Request): PlanningCanvasOpsActor {
  if (req.actor.type === "agent" && req.actor.agentId) return { type: "agent", id: req.actor.agentId };
  const userId = boardUserId(req);
  if (!userId) throw planningCanvasNotFound();
  return { type: "user", id: userId };
}

export function planningCanvasRoutes(db: Db) {
  const router = Router();
  const svc = planningCanvasService(db);
  const ops = planningCanvasOpsService(db);

  router.use("/companies/:companyId/planning-canvases", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/companies/:companyId/planning-canvases", async (req, res) => {
    const companyId = planningCanvasCompany(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid planning canvas list query", parsed.error.issues);
    const query = parsed.data;
    const filters: SQL[] = [query.archived === "true" ? isNotNull(planningCanvases.archivedAt) : isNull(planningCanvases.archivedAt)];
    if (query.scope) filters.push(eq(planningCanvases.scope, query.scope));
    if (query.projectId) filters.push(eq(planningCanvases.projectId, query.projectId));
    // Narrow personal boards up front: a person's own, or an agent's granted ones. The resolver still decides each.
    const userId = boardUserId(req);
    if (req.actor.type === "agent" && req.actor.agentId) {
      const granted = planningCanvasAgentGrantsOn()
        ? db
            .select({ id: planningCanvasAgentGrants.boardId })
            .from(planningCanvasAgentGrants)
            .where(and(eq(planningCanvasAgentGrants.agentId, req.actor.agentId), isNull(planningCanvasAgentGrants.revokedAt)))
        : null;
      filters.push(granted ? or(ne(planningCanvases.scope, "personal"), inArray(planningCanvases.id, granted))! : ne(planningCanvases.scope, "personal"));
    } else if (userId) {
      filters.push(or(ne(planningCanvases.scope, "personal"), eq(planningCanvases.userId, userId))!);
    } else {
      throw planningCanvasNotFound();
    }
    const resolve = planningCanvasAccessResolver(db, req.actor);
    const rows = await svc.listRows(companyId, and(...filters));
    const visible: Array<{ row: (typeof rows)[number]; access: PlanningCanvasAccessLevel }> = [];
    for (const row of rows) {
      const access = await resolve(row.board);
      if (access !== "none") visible.push({ row, access });
    }
    const summaries = await svc.summaries(companyId, visible.map(({ row }) => row), { actor: req.actor });
    res.json(summaries.map((summary, index) => ({ ...summary, access: visible[index]!.access })));
  });

  router.post("/companies/:companyId/planning-canvases", async (req, res) => {
    const companyId = planningCanvasCompany(req);
    const userId = boardUserId(req);
    if (!userId) throw forbidden("Only a signed-in person can create a planning canvas board");
    const membership = req.actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
    if (req.actor.source !== "local_implicit") {
      if (!membership) throw planningCanvasNotFound();
      if (membership.membershipRole === "viewer") throw forbidden("Viewer access is read-only");
    }
    const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!company) throw planningCanvasNotFound();
    const parsed = createPlanningCanvasSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const created = await svc.create(companyId, userId, parsed.data, { actor: req.actor });
    await logPlanningCanvasActivity(db, req, created, "planning_canvas.created", { title: created.title });
    res.status(201).json({ ...created, access: "admin" });
  });

  router.get("/companies/:companyId/planning-canvases/:boardId", async (req, res) => {
    const { board, access } = await planningCanvasForRequest(db, req, "view");
    const parsed = planningCanvasReadQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid planning canvas read query", parsed.error.issues);
    const result = await svc.readResolved(board, parsed.data, { actor: req.actor });
    if (result.kind === "text") {
      res.setHeader("X-Planning-Canvas-Revision", String(result.revision));
      res.type(result.contentType).send(result.body);
      return;
    }
    res.json(result.kind === "board" ? { ...result.body, access } : result.body);
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/ops", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "edit");
    const actor = opsActor(req);
    res.json(await ops.applyOps({ companyId: board.companyId, boardId: board.id, actor, batch: req.body }));
  });

  /** Legacy whole-board PATCH (J.2) for old tabs; people only. Agents use `ops`. */
  router.patch("/companies/:companyId/planning-canvases/:boardId", async (req, res) => {
    const { board, access } = await planningCanvasForRequest(db, req, "edit");
    const userId = boardUserId(req);
    if (!userId) throw forbidden("Use POST .../ops to change a planning canvas board");
    const parsed = updatePlanningCanvasSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    const updated = await svc.updateResolved(board.companyId, board.id, userId, parsed.data, { actor: req.actor });
    if (parsed.data.title !== undefined || parsed.data.description !== undefined) {
      await logPlanningCanvasActivity(db, req, board, "planning_canvas.updated", {
        fields: Object.keys(parsed.data).filter((key) => key !== "data"),
      });
    }
    res.json({ ...updated, access });
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/archive", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "admin");
    const row = await svc.setArchived(board.companyId, board.id, true);
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.archived");
    publishPlanningCanvasEvent({ type: "access.changed", companyId: board.companyId, boardId: board.id, reason: "archived" });
    res.json({ id: row.id, archivedAt: row.archivedAt?.toISOString() ?? null });
  });

  router.post("/companies/:companyId/planning-canvases/:boardId/restore", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "admin");
    const row = await svc.setArchived(board.companyId, board.id, false);
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.restored");
    publishPlanningCanvasEvent({ type: "access.changed", companyId: board.companyId, boardId: board.id, reason: "restored" });
    res.json({ id: row.id, archivedAt: null });
  });

  /** Hard delete: admin only. A shared board is archived first (J.5); a personal one is its owner's to delete. */
  router.delete("/companies/:companyId/planning-canvases/:boardId", async (req, res) => {
    const { board } = await planningCanvasForRequest(db, req, "admin");
    if (board.scope !== "personal" && !board.archivedAt) throw conflict("Archive a shared planning canvas board before deleting it");
    const deleted = await svc.removeResolved(board.companyId, board.id);
    await logPlanningCanvasActivity(db, req, board, "planning_canvas.deleted", { title: board.title, scope: board.scope });
    publishPlanningCanvasEvent({ type: "access.changed", companyId: board.companyId, boardId: board.id, reason: "deleted" });
    res.json(deleted);
  });

  return router;
}
