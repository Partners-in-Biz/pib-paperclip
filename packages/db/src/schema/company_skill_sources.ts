import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";
import { toolConnections } from "./tool_access.js";

export const companySkillSources = pgTable(
  "company_skill_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id"),
    repositoryUrl: text("repository_url").notNull(),
    fullName: text("full_name").notNull(),
    trackingRef: text("tracking_ref").notNull(),
    connectionId: uuid("connection_id").references(() => toolConnections.id, { onDelete: "set null" }),
    excludedFolders: jsonb("excluded_folders").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastScanCommit: text("last_scan_commit"),
    lastError: text("last_error"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("company_skill_sources_repository_ref_idx").on(
      table.companyId,
      table.repositoryUrl,
      table.trackingRef,
    ),
    uniqueIndex("company_skill_sources_identity_ref_idx").on(
      table.companyId,
      table.repositoryId,
      table.trackingRef,
    ),
  ],
);

export const companySkillSourceEntries = pgTable(
  "company_skill_source_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => companySkillSources.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    skillId: uuid("skill_id").references(() => companySkills.id, { onDelete: "set null" }),
    selection: text("selection").notNull().default("new"),
    present: boolean("present").notNull().default(true),
    error: text("error"),
    inspection: jsonb("inspection").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("company_skill_source_entries_source_path_idx").on(table.sourceId, table.path),
    index("company_skill_source_entries_company_skill_idx").on(table.companyId, table.skillId),
  ],
);
