import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";

export const personalNotes = pgTable(
  "personal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    color: text("color").notNull().default("default"),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    dailyDate: text("daily_date"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    scheduledAgentId: uuid("scheduled_agent_id").references(() => agents.id, { onDelete: "set null" }),
    scheduledProjectId: uuid("scheduled_project_id").references(() => projects.id, { onDelete: "set null" }),
    scheduledPriority: text("scheduled_priority").notNull().default("medium"),
    scheduledIssueStatus: text("scheduled_issue_status").notNull().default("todo"),
    scheduledInstructions: text("scheduled_instructions"),
    scheduledRecurrence: text("scheduled_recurrence").notNull().default("none"),
    scheduledStatus: text("scheduled_status").notNull().default("none"),
    scheduledError: text("scheduled_error"),
    handedOffIssueId: uuid("handed_off_issue_id").references(() => issues.id, { onDelete: "set null" }),
    handedOffAt: timestamp("handed_off_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUpdatedIdx: index("personal_notes_company_user_updated_idx").on(
      table.companyId,
      table.userId,
      table.updatedAt,
    ),
    companyUserDailyIdx: index("personal_notes_company_user_daily_idx").on(
      table.companyId,
      table.userId,
      table.dailyDate,
    ),
    scheduledPendingIdx: index("personal_notes_scheduled_pending_idx").on(
      table.scheduledStatus,
      table.scheduledFor,
    ),
  }),
);

export const personalNoteIssueLinks = pgTable(
  "personal_note_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => personalNotes.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    sourceLine: text("source_line"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    noteCreatedIdx: index("personal_note_issue_links_note_created_idx").on(
      table.noteId,
      table.createdAt,
    ),
    companyIssueIdx: index("personal_note_issue_links_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
  }),
);
