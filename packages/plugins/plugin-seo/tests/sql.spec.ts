import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crmProjectionMigration } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import {
  splitSqlStatements,
  validateMigrationStatement,
  validateParams,
  validateRuntimeExecute,
  validateRuntimeQuery,
} from "./helpers/sql-guard.js";

const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("keeps 001–002 and adds 003+", () => {
    expect(NAMESPACE).toBe("plugin_seo_8099f8879a");
    expect(files.slice(0, 2)).toEqual(["001_seo.sql", "002_seo.sql"]);
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it("pass the host migration guard statement by statement", () => {
    for (const file of files.slice(2)) {
      const sql = readFileSync(new URL(file, migrationsDir), "utf8");
      const statements = splitSqlStatements(sql);
      expect(statements.length, file).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(() => validateMigrationStatement(statement, NAMESPACE), `${file}: ${statement.slice(0, 80)}`).not.toThrow();
      }
    }
  });

  it("creates every table the worker uses and the CRM projection from the kit", () => {
    const all = files.map((f) => readFileSync(new URL(f, migrationsDir), "utf8")).join("\n");
    for (const table of ["sprint_tasks", "backlinks", "content", "page_health", "audit_snapshots", "optimizations", "integrations", "oauth_sessions", "crm_companies"]) {
      expect(all).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    }
    expect(readFileSync(new URL("009_seo.sql", migrationsDir), "utf8").trim()).toBe(crmProjectionMigration(NAMESPACE).trim());
    expect(all).toContain(`ADD COLUMN IF NOT EXISTS created_at`);
    expect(all).toContain("keywords_sprint_phrase");
  });
});

interface Call {
  kind: "query" | "execute";
  sql: string;
  params: unknown[];
}

function guardedDb(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const fake: db.SeoDb = {
    namespace: NAMESPACE,
    async query<T>(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
      validateParams(sql, params);
      calls.push({ kind: "query", sql, params });
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      calls.push({ kind: "execute", sql, params });
      return { rowCount: 1 };
    },
  };
  return { fake, calls };
}

describe("runtime SQL passes the host guard", () => {
  it("covers every data-access function", async () => {
    const { fake, calls } = guardedDb();
    const c = "co-1";
    const s = "sp-1";
    await db.listSprints(fake, c, { status: "active", scope: { kind: "company", id: "crm-1" } });
    await db.listSprints(fake, c, { scope: { kind: "contact", id: "ct-1" } });
    await db.listSprints(fake, c, { scope: null });
    await db.listSprints(fake, c);
    await db.getSprint(fake, c, s);
    await db.listRunnableSprints(fake);
    await db.listSprintCompanies(fake);
    await db.insertSprint(fake, { id: s, companyId: c, name: "n", siteUrl: "https://a", siteName: "n", clientKind: null, clientRef: null, clientName: null, status: "active", startDate: "2026-09-26", templateId: "outrank-90", templateVersion: 2, autopilotMode: "safe", ownerUserId: null, notes: null });
    await db.insertSprint(fake, { id: s, companyId: c, name: "n", siteUrl: "https://a", siteName: "n", clientKind: "contact", clientRef: "ct-1", clientName: "Jo", status: "active", startDate: "2026-09-26", templateId: "outrank-90", templateVersion: 2, autopilotMode: "safe", ownerUserId: null, notes: null });
    await db.updateSprint(fake, c, s, { status: "paused", health: { score: 90 }, audit_days_done: [0, 30], last_daily_on: "2026-09-26", current_day: 3, seeded_at: new Date().toISOString() });
    await db.setAgentForCompany(fake, c, "agent");
    await db.insertTasks(fake, [
      { id: "t1", companyId: c, sprintId: s, templateKey: "w0-schema", week: 0, phase: 0, dueDay: null, focus: "f", title: "t", description: null, taskType: "schema-add", owner: "agent", autopilotEligible: true, playbookKey: "w0-schema", source: "template", parentOptimizationId: null, context: null },
      { id: "t2", companyId: c, sprintId: s, templateKey: null, week: 3, phase: 1, dueDay: 15, focus: "f", title: "t2", description: "d", taskType: "custom", owner: "human", autopilotEligible: false, playbookKey: null, source: "manual", parentOptimizationId: null, context: "c" },
    ]);
    await db.listTasks(fake, c, s, { status: ["not_started", "blocked"], week: 2, owner: "agent", source: "template", limit: 10 });
    await db.getTask(fake, c, "t1");
    await db.getTaskByIssue(fake, c, "iss");
    await db.updateTask(fake, c, "t1", { status: "done", evidence: { summary: "x", links: ["a"] }, completed_at: new Date().toISOString(), blocker_reason: null });
    await db.claimTaskForIssue(fake, c, "t1");
    await db.releaseTaskClaim(fake, c, "t1");
    await db.taskStats(fake, s);
    await db.listKeywords(fake, c, s, { includeRetired: true });
    await db.listKeywords(fake, c, s);
    await db.getKeyword(fake, c, "k");
    await db.findKeyword(fake, c, s, "Phrase");
    await db.insertKeyword(fake, { id: "k", companyId: c, sprintId: s, phrase: "p", volume: null, intent: "solution", targetUrl: null, difficultyDr: 20, isPriority: true, notes: null, source: "manual" });
    await db.updateKeyword(fake, c, "k", { current_position: 12.5, rank: 13, is_priority: false, retired_at: null });
    await db.keywordHistory(fake, c, "k", 30);
    await db.sprintHistory(fake, s, "2026-01-01");
    await db.recordPosition(fake, { id: "h1", companyId: c, sprintId: s, keywordId: "k", position: 12.3, impressions: 10, clicks: 1, ctr: 0.1, source: "gsc", recordedOn: "2026-09-25" });
    await db.recordPosition(fake, { id: "h2", companyId: c, sprintId: s, keywordId: "k", position: null, impressions: null, clicks: null, ctr: null, source: "manual", recordedOn: "2026-09-25" });
    await db.insertBacklinks(fake, [{ id: "b", companyId: c, sprintId: s, source: "g2", domain: "g2.com", url: null, submitUrl: null, type: "directory", dr: 90, status: "not_started", notes: null, discoveredVia: "template" }]);
    await db.listBacklinks(fake, c, s, { status: "live", type: "directory" });
    await db.getBacklink(fake, c, "b");
    await db.updateBacklink(fake, c, "b", { status: "live", live_at: new Date().toISOString(), evidence: { a: 1 } });
    await db.insertContent(fake, { id: "ct", companyId: c, sprintId: s, title: "t", type: "post", status: "idea", targetKeywordId: null, targetUrl: null, publishOn: null, publishedOn: null, taskId: null, notes: null });
    await db.listContent(fake, c, s, { status: "live", type: "pillar" });
    await db.getContent(fake, c, "ct");
    await db.updateContent(fake, c, "ct", { links_to_pillar_ids: ["p"], social_post_ids: ["x|linkedin|u"], published_on: "2026-09-26", internal_links_added: true });
    await db.insertPage(fake, { id: "pg", companyId: c, sprintId: s, url: "https://a/x", title: "" });
    await db.listPages(fake, c, s);
    await db.upsertPageHealth(fake, { id: "ph", companyId: c, sprintId: s, url: "https://a/", strategy: "mobile", performance: 90, seo: 100, accessibility: 90, bestPractices: 100, lcpMs: 2000, cls: 0.01, inpMs: null, labLcpMs: 2000, labCls: 0.01, labInpMs: null, fieldLcpMs: null, fieldCls: null, fieldInpMs: null, fieldScope: null, source: "lab", opportunities: [], pulledOn: "2026-09-26" });
    await db.latestPageHealth(fake, s);
    await db.pageHealthHistory(fake, s, "https://a/");
    await db.insertSnapshot(fake, { id: "sn", companyId: c, sprintId: s, day: 0, kind: "scheduled", capturedOn: "2026-09-26", traffic: {}, rankings: {}, authority: {}, content: {}, cwv: {}, tasks: {}, source: "none", notes: null });
    await db.insertSnapshot(fake, { id: "sn2", companyId: c, sprintId: s, day: 3, kind: "manual", capturedOn: "2026-09-26", traffic: {}, rankings: {}, authority: {}, content: {}, cwv: {}, tasks: {}, source: "none", notes: "n" });
    await db.listSnapshots(fake, c, s);
    await db.upsertFinding(fake, { id: "f", companyId: c, sprintId: s, finding: "Missing canonical", severity: "medium", category: "canonical", url: null, source: "check-canonical" });
    await db.resolveStaleFindings(fake, { sprintId: s, category: "meta", url: "https://a/", source: "check-meta", current: ["x"] });
    await db.resolveStaleFindings(fake, { sprintId: s, category: "meta", url: null, source: "check-meta", current: [] });
    await db.listFindings(fake, c, s, { status: "open", limit: 10 });
    await db.resolveFinding(fake, c, "f");
    await db.insertOptimization(fake, { id: "o", companyId: c, sprintId: s, signalType: "stuck_page", severity: "medium", subject: "k", evidence: { a: 1 }, hypothesis: "h", hypothesisType: "t", proposedAction: "a", proposedTasks: [{ title: "x" }], targetKeywordIds: ["k"], targetUrl: null, detectedOn: "2026-09-26" });
    await db.listOptimizations(fake, c, s, { status: "proposed" });
    await db.getOptimization(fake, c, "o");
    await db.updateOptimization(fake, c, "o", { status: "approved", generated_task_ids: ["t"], baseline: { a: 1 }, measure_on: "2026-10-10" });
    await db.countOptimizationsSince(fake, s, "2026-09-20");
    await db.dueMeasurements(fake, s, "2026-10-10");
    await db.ensureIntegration(fake, { id: "i", companyId: c, sprintId: s, provider: "gsc", status: "disconnected" });
    await db.listIntegrations(fake, c, s);
    await db.getIntegration(fake, c, s, "gsc");
    await db.updateIntegration(fake, c, "i", { status: "connected", scopes: ["a"], stats: { rows: 1 }, token_sealed: "v1.x", key_version: 1, expires_at: new Date().toISOString() });
    await db.insertOAuthSession(fake, { state: "st", companyId: c, sprintId: s, provider: "gsc", createdByUserId: "u", returnTo: null, ttlSeconds: 900 });
    await db.getOAuthSession(fake, "st");
    await db.deleteOAuthSession(fake, "st");
    await db.deleteExpiredOAuthSessions(fake);
    await db.completionFacts(fake, s);
    await db.sprintCounts(fake, c);
    expect(calls.length).toBeGreaterThan(60);
    expect(calls.every((call) => !/\bundefined\b/.test(call.sql))).toBe(true);
  });

  it("filters sprints by scope in SQL", async () => {
    const { fake, calls } = guardedDb();
    await db.listSprints(fake, "co-1", { scope: null });
    expect(calls[0]!.sql).toContain("client_ref IS NULL");
    expect(calls[0]!.params).toEqual(["co-1"]);
    await db.listSprints(fake, "co-1", { status: "active", scope: { kind: "contact", id: "ct-1" } });
    expect(calls[1]!.sql).toContain("client_ref = $4 AND COALESCE(client_kind, 'company') = $3");
    expect(calls[1]!.params).toEqual(["co-1", "active", "contact", "ct-1"]);
    await db.listSprints(fake, "co-1");
    expect(calls[2]!.sql).toMatch(/WHERE company_id = \$1 ORDER BY/);
  });

  it("reads the client kind and hides a legacy free-text client on own sprints", async () => {
    const base = { id: "s", company_id: "c", name: "n", site_url: "https://a", site_name: "n", status: "active", start_date: "2026-09-01" };
    const own = await db.getSprint(guardedDb([{ ...base, client_ref: null, client_kind: null, client_name: "Acme Ltd" }]).fake, "c", "s");
    expect(own).toMatchObject({ clientKind: null, clientRef: null, clientName: null, legacyClientName: "Acme Ltd" });
    const contact = await db.getSprint(guardedDb([{ ...base, client_ref: "ct-1", client_kind: "contact", client_name: "Jo" }]).fake, "c", "s");
    expect(contact).toMatchObject({ clientKind: "contact", clientRef: "ct-1", clientName: "Jo", legacyClientName: null });
    const older = await db.getSprint(guardedDb([{ ...base, client_ref: "crm-1", client_kind: null, client_name: "Acme" }]).fake, "c", "s");
    expect(older?.clientKind).toBe("company");
  });

  it("sends lists and objects as JSON strings", async () => {
    const { fake, calls } = guardedDb();
    await db.updateSprint(fake, "c", "s", { audit_days_done: [0, 30] });
    expect(calls[0]!.params[0]).toBe("[0,30]");
    expect(calls[0]!.sql).toContain("audit_days_done = $1::jsonb");
  });

  it("rejects unknown columns in patches", async () => {
    const { fake } = guardedDb();
    await expect(db.updateTask(fake, "c", "t", { "status; drop": "x" })).rejects.toThrow(/Unknown column/);
  });
});
