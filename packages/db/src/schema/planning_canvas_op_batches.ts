import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PlanningCanvasOpResult } from "@paperclipai/shared";
import { planningCanvases } from "./planning_canvases.js";

/**
 * Idempotent op batches (plan PAR-13925 B.4): a replayed clientBatchId returns
 * the stored results and applies nothing. Rows older than 24 h are purged.
 */
export const planningCanvasOpBatches = pgTable(
  "planning_canvas_op_batches",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => planningCanvases.id, { onDelete: "cascade" }),
    /** `user:<id>` or `agent:<id>`. */
    actorKey: text("actor_key").notNull(),
    clientBatchId: text("client_batch_id").notNull(),
    results: jsonb("results").$type<PlanningCanvasOpResult[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: "planning_canvas_op_batches_pk", columns: [table.boardId, table.actorKey, table.clientBatchId] }),
    boardCreatedIdx: index("planning_canvas_op_batches_board_created_idx").on(table.boardId, table.createdAt),
    clientBatchIdCheck: check(
      "planning_canvas_op_batches_client_batch_id_check",
      sql`char_length(${table.clientBatchId}) BETWEEN 1 AND 100`,
    ),
  }),
);
