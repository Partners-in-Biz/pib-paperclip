import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PlanningCanvasData } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const planningCanvases = pgTable(
  "planning_canvases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    data: jsonb("data")
      .$type<PlanningCanvasData>()
      .notNull()
      .default(sql`'{"nodes":[],"connectors":[],"viewport":{"x":0,"y":0,"zoom":1}}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUpdatedIdx: index("planning_canvases_company_user_updated_idx").on(
      table.companyId,
      table.userId,
      table.updatedAt,
    ),
  }),
);
