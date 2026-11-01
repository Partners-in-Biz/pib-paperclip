import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const resourceLifecycleEvents = pgTable(
  "resource_lifecycle_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("resource_lifecycle_events_resource_type_check", sql`${table.resourceType} IN ('agent', 'project')`),
    check(
      "resource_lifecycle_events_action_check",
      sql`${table.action} = 'create' OR (${table.resourceType} = 'project' AND ${table.action} = 'update') OR (${table.resourceType} = 'agent' AND ${table.action} IN ('pause', 'resume', 'terminate'))`,
    ),
    uniqueIndex("resource_lifecycle_events_creation_idx")
      .on(table.companyId, table.resourceType, table.resourceId)
      .where(sql`${table.action} = 'create'`),
    index("resource_lifecycle_events_company_idx").on(table.companyId, table.id),
  ],
);
