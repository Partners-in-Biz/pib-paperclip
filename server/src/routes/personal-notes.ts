import { Router } from "express";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import {
  createPersonalNoteSchema,
  openDailyPersonalNoteSchema,
  recordPersonalNoteHandoffSchema,
  schedulePersonalNoteHandoffSchema,
  splitPersonalNoteChecklistSchema,
  updatePersonalNoteSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { personalNoteService } from "../services/personal-notes.js";
import { assertBoard, hasCompanyAccess } from "./authz.js";

export function personalNoteRoutes(db: Db) {
  const router = Router();
  const svc = personalNoteService(db);

  async function assertPersonalNotesAccess(req: import("express").Request, companyId: string) {
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

  router.use("/companies/:companyId/personal-notes", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/companies/:companyId/personal-notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = await assertPersonalNotesAccess(req, companyId);
    res.json(await svc.list(companyId, userId));
  });

  router.post(
    "/companies/:companyId/personal-notes",
    validate(createPersonalNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      const created = await svc.create(companyId, userId, req.body);
      res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/personal-notes/daily",
    validate(openDailyPersonalNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      const note = await svc.openDaily(companyId, userId, req.body.date);
      res.json(note);
    },
  );

  router.get("/companies/:companyId/personal-notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    const userId = await assertPersonalNotesAccess(req, companyId);
    res.json(await svc.getById(companyId, userId, noteId));
  });

  router.patch(
    "/companies/:companyId/personal-notes/:noteId",
    validate(updatePersonalNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(await svc.update(companyId, userId, noteId, req.body));
    },
  );

  router.delete("/companies/:companyId/personal-notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const noteId = req.params.noteId as string;
    const userId = await assertPersonalNotesAccess(req, companyId);
    res.json(await svc.remove(companyId, userId, noteId));
  });

  router.post(
    "/companies/:companyId/personal-notes/:noteId/schedule-handoff",
    validate(schedulePersonalNoteHandoffSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(await svc.scheduleHandoff(companyId, userId, noteId, req.body));
    },
  );

  router.delete(
    "/companies/:companyId/personal-notes/:noteId/schedule-handoff",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(await svc.cancelScheduledHandoff(companyId, userId, noteId));
    },
  );

  router.post(
    "/companies/:companyId/personal-notes/:noteId/dispatch-now",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(await svc.dispatchNow(companyId, userId, noteId));
    },
  );

  router.post(
    "/companies/:companyId/personal-notes/:noteId/record-handoff",
    validate(recordPersonalNoteHandoffSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(
        await svc.recordHandoff(
          companyId,
          userId,
          noteId,
          req.body.issueId,
          req.body.sourceLine ?? null,
        ),
      );
    },
  );

  router.post(
    "/companies/:companyId/personal-notes/:noteId/split-tasks",
    validate(splitPersonalNoteChecklistSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const noteId = req.params.noteId as string;
      const userId = await assertPersonalNotesAccess(req, companyId);
      res.json(await svc.splitChecklistToTasks(companyId, userId, noteId, req.body));
    },
  );

  return router;
}
