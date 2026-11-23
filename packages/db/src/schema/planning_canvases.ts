import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PlanningCanvasData, PlanningCanvasMemberAccess, PlanningCanvasScope } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const planningCanvases = pgTable(
  "planning_canvases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Owner. Null only on non-personal boards (agent-created or owner removed). */
    userId: text("user_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Legacy blob. Item rows are the source of truth from C2 on (plan PAR-13925 B.1). */
    data: jsonb("data")
      .$type<PlanningCanvasData>()
      .notNull()
      .default(sql`'{"nodes":[],"connectors":[],"viewport":{"x":0,"y":0,"zoom":1}}'::jsonb`),
    scope: text("scope").$type<PlanningCanvasScope>().notNull().default("personal"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    memberAccess: text("member_access").$type<PlanningCanvasMemberAccess>().notNull().default("view"),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    purgedThroughRevision: bigint("purged_through_revision", { mode: "number" }).notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** md5(data::text) at the last item sync; the C2b catch-up compares against it. */
    legacyDataMd5: text("legacy_data_md5"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUpdatedIdx: index("planning_canvases_company_user_updated_idx").on(
      table.companyId,
      table.userId,
      table.updatedAt,
    ),
    companyScopeProjectUpdatedIdx: index("planning_canvases_company_scope_project_updated_idx").on(
      table.companyId,
      table.scope,
      table.projectId,
      table.updatedAt,
    ),
    scopeCheck: check("planning_canvases_scope_check", sql`${table.scope} IN ('personal', 'project', 'company')`),
    memberAccessCheck: check(
      "planning_canvases_member_access_check",
      sql`${table.memberAccess} IN ('edit', 'comment', 'view')`,
    ),
    personalOwnerCheck: check(
      "planning_canvases_personal_owner_check",
      sql`${table.userId} IS NOT NULL OR ${table.scope} <> 'personal'`,
    ),
  }),
);
