import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PlanningCanvasItemFields, PlanningCanvasItemType, PlanningCanvasNodeKind } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { planningCanvases } from "./planning_canvases.js";

/**
 * One row per canvas node, connector or stroke (plan PAR-13925 section C).
 * `data` holds every field of the item; `kind` and `z_index` are copies of
 * `data.kind` and `data.zIndex` written by the same op. Connectors and
 * strokes use `z_index` for draw order.
 */
export const planningCanvasItems = pgTable(
  "planning_canvas_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => planningCanvases.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    itemType: text("item_type").$type<PlanningCanvasItemType>().notNull(),
    kind: text("kind").$type<PlanningCanvasNodeKind>(),
    data: jsonb("data").$type<PlanningCanvasItemFields>().notNull(),
    zIndex: integer("z_index"),
    version: integer("version").notNull().default(1),
    fieldVersions: jsonb("field_versions")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    revision: bigint("revision", { mode: "number" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** The node whose delete tombstoned this connector with it. */
    deletedWithKey: text("deleted_with_key"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardKeyUq: uniqueIndex("planning_canvas_items_board_key_uq").on(table.boardId, table.itemKey),
    boardRevisionIdx: index("planning_canvas_items_board_revision_idx").on(table.boardId, table.revision),
    itemKeyCheck: check("planning_canvas_items_item_key_check", sql`char_length(${table.itemKey}) BETWEEN 1 AND 100`),
    itemTypeCheck: check(
      "planning_canvas_items_item_type_check",
      sql`${table.itemType} IN ('node', 'connector', 'stroke')`,
    ),
  }),
);
