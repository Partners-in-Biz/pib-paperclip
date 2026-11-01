import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { connectionGrants, toolConnections } from "./tool_access.js";

export const browserUseSessions = pgTable(
  "browser_use_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id),
    grantId: uuid("grant_id").notNull().references(() => connectionGrants.id),
    providerSessionId: uuid("provider_session_id"),
    status: text("status").notNull().default("starting"),
    idleDeadline: timestamp("idle_deadline", { withTimezone: true }),
    stopRequested: text("stop_requested"),
    error: text("error"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("browser_use_sessions_task_idx").on(table.companyId, table.issueId),
    uniqueIndex("browser_use_sessions_provider_uq").on(table.providerSessionId),
  ],
);

export const browserUseRuns = pgTable(
  "browser_use_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sessionId: uuid("session_id").notNull().references(() => browserUseSessions.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    invocationId: uuid("invocation_id").notNull(),
    providerRunId: uuid("provider_run_id"),
    status: text("status").notNull().default("creating"),
    detachedUntil: timestamp("detached_until", { withTimezone: true }),
    recoveryCursor: text("recovery_cursor"),
    eventCursor: integer("event_cursor").notNull().default(0),
    eventsDrained: integer("events_drained").notNull().default(0),
    accountedCents: integer("accounted_cents").notNull().default(0),
    progress: text("progress"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("browser_use_runs_invocation_uq").on(table.invocationId),
    uniqueIndex("browser_use_runs_provider_uq").on(table.providerRunId),
    index("browser_use_runs_session_idx").on(table.sessionId),
  ],
);

export const browserUseBrowsers = pgTable(
  "browser_use_browsers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sessionId: uuid("session_id").notNull().references(() => browserUseSessions.id),
    providerBrowserId: uuid("provider_browser_id").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("browser_use_browsers_provider_uq").on(table.providerBrowserId),
    index("browser_use_browsers_session_idx").on(table.sessionId),
  ],
);

export const browserUseSettings = pgTable("browser_use_settings", {
  grantId: uuid("grant_id").primaryKey().references(() => connectionGrants.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  allowedProfileIds: jsonb("allowed_profile_ids").$type<string[]>().notNull().default([]),
  maxCostUsd: text("max_cost_usd"),
});
