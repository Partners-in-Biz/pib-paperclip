import { foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { toolConnections } from "./tool_access.js";

export const toolConnectionAppSnapshots = pgTable(
  "tool_connection_app_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    userId: text("user_id").notNull(),
    credentialKey: text("credential_key").notNull(),
    toolkit: text("toolkit").notNull(),
    status: text("status").notNull(),
    accounts: jsonb("accounts").$type<unknown[]>().notNull().default([]),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    errorAt: timestamp("error_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId, table.connectionId],
      foreignColumns: [toolConnections.companyId, toolConnections.id],
      name: "tool_connection_app_snapshots_company_connection_fk",
    }).onDelete("cascade"),
    uniqueIndex("tool_connection_app_snapshots_owner_toolkit_uq").on(
      table.companyId,
      table.connectionId,
      table.userId,
      table.toolkit,
    ),
  ],
);

export const toolConnectionAppSyncs = pgTable(
  "tool_connection_app_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    userId: text("user_id").notNull(),
    credentialKey: text("credential_key").notNull(),
    leaseId: uuid("lease_id").notNull(),
    status: text("status").notNull(),
    checked: integer("checked").notNull().default(0),
    total: integer("total").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId, table.connectionId],
      foreignColumns: [toolConnections.companyId, toolConnections.id],
      name: "tool_connection_app_syncs_company_connection_fk",
    }).onDelete("cascade"),
    uniqueIndex("tool_connection_app_syncs_owner_key_uq").on(
      table.companyId,
      table.connectionId,
      table.userId,
      table.credentialKey,
    ),
  ],
);
