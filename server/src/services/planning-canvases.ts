import { and, desc, eq } from "drizzle-orm";
import { planningCanvases, type Db } from "@paperclipai/db";
import type {
  CreatePlanningCanvas,
  PlanningCanvasBoard,
  PlanningCanvasData,
  UpdatePlanningCanvas,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

const EMPTY_CANVAS_DATA: PlanningCanvasData = {
  nodes: [],
  connectors: [],
  strokes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function serializeBoard(row: typeof planningCanvases.$inferSelect): PlanningCanvasBoard {
  const data = row.data ?? EMPTY_CANVAS_DATA;
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    title: row.title,
    description: row.description ?? "",
    data: {
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      connectors: Array.isArray(data.connectors) ? data.connectors : [],
      strokes: Array.isArray(data.strokes) ? data.strokes : [],
      viewport: data.viewport ?? { x: 0, y: 0, zoom: 1 },
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function planningCanvasService(db: Db) {
  return {
    async list(companyId: string, userId: string): Promise<PlanningCanvasBoard[]> {
      const rows = await db
        .select()
        .from(planningCanvases)
        .where(
          and(
            eq(planningCanvases.companyId, companyId),
            eq(planningCanvases.userId, userId),
          ),
        )
        .orderBy(desc(planningCanvases.updatedAt));
      return rows.map(serializeBoard);
    },

    async getById(companyId: string, userId: string, boardId: string): Promise<PlanningCanvasBoard> {
      const rows = await db
        .select()
        .from(planningCanvases)
        .where(
          and(
            eq(planningCanvases.id, boardId),
            eq(planningCanvases.companyId, companyId),
            eq(planningCanvases.userId, userId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Planning canvas board not found");
      return serializeBoard(rows[0]);
    },

    async create(
      companyId: string,
      userId: string,
      input: CreatePlanningCanvas,
    ): Promise<PlanningCanvasBoard> {
      const now = new Date();
      const [inserted] = await db
        .insert(planningCanvases)
        .values({
          companyId,
          userId,
          title: input.title,
          description: input.description ?? "",
          data: input.data ?? EMPTY_CANVAS_DATA,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return serializeBoard(inserted!);
    },

    async update(
      companyId: string,
      userId: string,
      boardId: string,
      patch: UpdatePlanningCanvas,
    ): Promise<PlanningCanvasBoard> {
      const values: Partial<typeof planningCanvases.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.data !== undefined) values.data = patch.data;

      const updated = await db
        .update(planningCanvases)
        .set(values)
        .where(
          and(
            eq(planningCanvases.id, boardId),
            eq(planningCanvases.companyId, companyId),
            eq(planningCanvases.userId, userId),
          ),
        )
        .returning();
      if (!updated[0]) throw notFound("Planning canvas board not found");
      return serializeBoard(updated[0]);
    },

    async remove(companyId: string, userId: string, boardId: string): Promise<{ deleted: true }> {
      const deleted = await db
        .delete(planningCanvases)
        .where(
          and(
            eq(planningCanvases.id, boardId),
            eq(planningCanvases.companyId, companyId),
            eq(planningCanvases.userId, userId),
          ),
        )
        .returning({ id: planningCanvases.id });
      if (!deleted[0]) throw notFound("Planning canvas board not found");
      return { deleted: true };
    },
  };
}
