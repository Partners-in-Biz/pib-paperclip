import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { PlanningCanvasMentionState } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { planningCanvases } from "./planning_canvases.js";

/** Board- and node-level comment threads (plan PAR-13925 section C, C6). */
export const planningCanvasComments = pgTable(
  "planning_canvas_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => planningCanvases.id, { onDelete: "cascade" }),
    /** Null for a board-level comment. */
    itemKey: text("item_key"),
    parentId: uuid("parent_id").references((): AnyPgColumn => planningCanvasComments.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    /** Per mentioned agent id: `sent`, `added_to_open` or `not_sent:<reason>`. */
    mentionState: jsonb("mention_state")
      .$type<Record<string, PlanningCanvasMentionState>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    boardItemCreatedIdx: index("planning_canvas_comments_board_item_created_idx").on(
      table.boardId,
      table.itemKey,
      table.createdAt,
    ),
    bodyCheck: check("planning_canvas_comments_body_check", sql`char_length(${table.body}) BETWEEN 1 AND 10000`),
  }),
);
