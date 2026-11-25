import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PlanningCanvasAgentGrantSource } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { planningCanvases } from "./planning_canvases.js";

/**
 * Server-written grant that lets one agent open one personal board for one
 * issue (plan PAR-13925 Q6). Written only by the canvas comments and links
 * services for the board owner as a session user; no route accepts it.
 */
export const planningCanvasAgentGrants = pgTable(
  "planning_canvas_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => planningCanvases.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").notNull(),
    source: text("source").$type<PlanningCanvasAgentGrantSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    boardAgentIssueUq: uniqueIndex("planning_canvas_agent_grants_board_agent_issue_uq").on(
      table.boardId,
      table.agentId,
      table.issueId,
    ),
    sourceCheck: check("planning_canvas_agent_grants_source_check", sql`${table.source} IN ('mention', 'handoff')`),
  }),
);
