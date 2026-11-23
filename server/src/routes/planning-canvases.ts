import { Router } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import {
  createPlanningCanvasSchema,
  updatePlanningCanvasSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { planningCanvasService } from "../services/planning-canvases.js";
import { assertBoard, hasCompanyAccess } from "./authz.js";

export function planningCanvasRoutes(db: Db) {
  const router = Router();
  const svc = planningCanvasService(db);

  async function assertCanvasAccess(req: import("express").Request, companyId: string) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    if (!hasCompanyAccess(req, companyId)) {
      throw forbidden("User does not have access to this company");
    }
    if (
      req.actor.source !== "local_implicit" &&
      !req.actor.isInstanceAdmin &&
      !req.actor.memberships?.some(
        (member) => member.companyId === companyId && member.status === "active",
      )
    ) {
      throw forbidden("User does not have active company access");
    }
    const company = await db.query.companies.findFirst({
      where: eq(companies.id, companyId),
      columns: { id: true },
    });
    if (!company) throw notFound("Company not found");
    return req.actor.userId;
  }

  router.use("/companies/:companyId/planning-canvases", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/companies/:companyId/planning-canvases", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = await assertCanvasAccess(req, companyId);
    res.json(await svc.list(companyId, userId, { actor: req.actor }));
  });

  router.post(
    "/companies/:companyId/planning-canvases",
    validate(createPlanningCanvasSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = await assertCanvasAccess(req, companyId);
      const created = await svc.create(companyId, userId, req.body, { actor: req.actor });
      res.status(201).json(created);
    },
  );

  router.get("/companies/:companyId/planning-canvases/:boardId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const boardId = req.params.boardId as string;
    const userId = await assertCanvasAccess(req, companyId);
    res.json(await svc.getById(companyId, userId, boardId, { actor: req.actor }));
  });

  router.patch(
    "/companies/:companyId/planning-canvases/:boardId",
    validate(updatePlanningCanvasSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const boardId = req.params.boardId as string;
      const userId = await assertCanvasAccess(req, companyId);
      res.json(await svc.update(companyId, userId, boardId, req.body, { actor: req.actor }));
    },
  );

  router.delete("/companies/:companyId/planning-canvases/:boardId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const boardId = req.params.boardId as string;
    const userId = await assertCanvasAccess(req, companyId);
    res.json(await svc.remove(companyId, userId, boardId));
  });

  return router;
}
