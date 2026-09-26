import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decisionsMigration, experimentsMigration } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../src/db.js";
import { sqlGrowthStore } from "../src/growth/sql.js";
import { NAMESPACE } from "../src/namespace.js";
import { createPostRecord, type Viewer } from "../src/service.js";
import { fakeCtx } from "./helpers.js";

const MIGRATION = readFileSync(new URL("../migrations/012_social.sql", import.meta.url), "utf8");
const T = (name: string) => `${NAMESPACE}.${name}`;

describe("migration 012", () => {
  it("pastes the kit decisions and experiments tables with our namespace", () => {
    expect(MIGRATION).toContain(decisionsMigration(NAMESPACE).trim());
    for (const block of experimentsMigration(NAMESPACE).trim().split("\n\n")) expect(MIGRATION).toContain(block.trim());
  });

  it("adds triage, scores, features, playbook changes and experiment tags, without deleting anything", () => {
    for (const text of [
      `ALTER TABLE ${T("inbox_items")}`, "ADD COLUMN IF NOT EXISTS triage jsonb", "triage_attempts integer", "triage_issue_id text",
      `CREATE TABLE ${T("post_features")}`, "PRIMARY KEY (post_id, feature_key)",
      `CREATE TABLE ${T("post_scores")}`, "PRIMARY KEY (destination_id, metric_window)", "baseline_median numeric", "lift numeric",
      `CREATE TABLE ${T("growth_playbook_changes")}`, "owner_user_id text", "approval_week text",
      `ALTER TABLE ${T("posts")}`, "ADD COLUMN IF NOT EXISTS experiment_id text", "ADD COLUMN IF NOT EXISTS experiment_arm text",
    ]) {
      expect(MIGRATION).toContain(text);
    }
    expect(MIGRATION).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION).not.toMatch(/^\s*(DROP|TRUNCATE)\b/im);
  });
});

describe("Growth Lab SQL passes the host guard", () => {
  it("every store method issues guard-compliant statements", async () => {
    const ctx = fakeCtx();
    const store = sqlGrowthStore(ctx);
    const calls: Array<() => Promise<unknown>> = [
      () => store.findProgram("co", "social", null),
      () => store.findProgram("co", "social", { kind: "contact", id: "ct1" }),
      () => store.getProgram("co", "p1"),
      () => store.insertProgram({ id: "p1", companyId: "co", clientKind: "company", clientRef: "c1", clientName: "Acme", channel: "social", objective: "o", metric: "m", constraints: { topics: ["a"] }, playbook: "# P", playbookVersion: 1, autopilot: "safe", scoreboard: {}, featureQuestions: [], ownerUserId: null }),
      () => store.updateProgram("co", "p1", { autopilot: "full", constraints: {}, scoreboard: { "hook:question": { wins: 1, losses: 0, noChange: 0, inconclusive: 0 } }, featureQuestions: [], approvalIssueId: "i", approvalWeek: "2026-W39", clientName: "Acme", objective: "o", ownerUserId: "u" }),
      () => store.updateProgram("co", "p1", {}),
      () => store.savePlaybook("co", "p1", 1, "# P2"),
      () => store.insertPlaybookVersion({ programId: "p1", version: 2, playbook: "# P2", reason: "r", experimentId: null, createdBy: "user:u" }),
      () => store.listPlaybookVersions("p1", 10),
      () => store.insertExperiment({ id: "e1", companyId: "co", programId: "p1", hypothesis: "h", hypothesisType: "hook:question", variable: "v", arms: [{ key: "control", description: "a" }, { key: "variant", description: "b" }], metric: "m", minPerArm: 3, windowDays: 7, status: "proposed", proposedBy: "agent:a" }),
      () => store.getExperiment("co", "e1"),
      () => store.listExperiments("co", "p1"),
      () => store.listExperiments("co", "p1", ["proposed", "running"]),
      () => store.updateExperiment("co", "e1", ["proposed"], { status: "running", approvedAt: new Date().toISOString(), approvedBy: "user:u", startedAt: new Date().toISOString(), measureAfter: new Date().toISOString(), decisionNote: "n" }),
      () => store.updateExperiment("co", "e1", null, { verdict: "win", outcome: { a: 1 }, playbookDiff: "d", playbookDecision: "pending", measuredAt: new Date().toISOString(), approvalIssueId: "i" }),
      () => store.companiesWithRunningExperiments(),
      () => store.runningExperiments("co"),
      () => store.upsertItem("e1", "control", "post1", null),
      () => store.upsertItem("e1", "variant", "post1", 0.25),
      () => store.deleteItem("e1", "post1"),
      () => store.listItems("e1"),
      () => store.experimentPosts("co", "e1", "7d"),
      () => store.setPostExperiment("co", "post1", "e1", "variant"),
      () => store.setPostExperiment("co", "post1", null, null),
      () => store.insertChange({ id: "ch1", companyId: "co", programId: "p1", experimentId: null, op: "add", section: "rules", body: "b", diff: "d", reason: "r", baseVersion: 1, proposedBy: "agent:a" }),
      () => store.getChange("co", "ch1"),
      () => store.listChanges("co", "p1"),
      () => store.listChanges("co", "p1", "pending"),
      () => store.updateChange("co", "ch1", { status: "kept", decidedBy: "user:u", decisionNote: "n" }, true),
      () => store.updateChange("co", "ch1", { resultVersion: 2, approvalIssueId: "i" }, false),
      () => store.companiesWithMetrics("7d", 75),
      () => store.metricRows("co", "7d", 75),
      () => store.existingScores("co", "7d", 75),
      () => store.upsertScore({ destinationId: "d1", window: "7d", companyId: "co", postId: "post1", accountId: "a1", platform: "facebook", programId: "p1", clientKind: null, clientRef: null, engagementRate: 0.12, basis: "reach", baselineMedian: 0.1, baselineN: 4, lift: 0.2, publishedAt: new Date().toISOString() }),
      () => store.postsToTag("co", 90, 300),
      () => store.upsertFeatures("co", "p1", "post1", [{ key: "hook", value: "question", confidence: 0.9, source: "jev", decisionId: "dec" }, { key: "format", value: "video", confidence: 1, source: "code" }], "jev-1.13.0"),
      () => store.upsertFeatures("co", null, "post1", [], null),
      () => store.postFeatures("co", ["post1", "post2"]),
      () => store.scoredPosts("co", null, "7d", 28),
      () => store.scoredPosts("co", { kind: "company", id: "c1" }, "7d", 28),
    ];
    for (const call of calls) await call();
    expect(ctx.fakeDb.executes.length).toBeGreaterThan(15);
    expect(ctx.fakeDb.queries.length).toBeGreaterThan(15);
    const scoped = ctx.fakeDb.queries.find((q) => q.sql.includes(`FROM ${T("post_scores")} s`) && q.params.includes("c1"))!;
    expect(scoped.sql).toContain("s.client_ref = $5 AND COALESCE(s.client_kind, 'company') = $4");
  });

  it("the triage and tag data functions pass too", async () => {
    const ctx = fakeCtx();
    await db.untriagedInboxItems(ctx, "co", 50, 3);
    await db.saveInboxTriage(ctx, "co", "i1", { triage: { action: "queued" }, issueId: "iss" });
    await db.saveInboxTriage(ctx, "co", "i1", { triage: null, failed: true });
    await db.markDecisionsActed(ctx, "co", ["d1", "d2"]);
    await db.markDecisionsActed(ctx, "co", []);
    await db.setPostExperiment(ctx, "co", "p1", "e1", "control");
    expect(ctx.fakeDb.executes).toHaveLength(4);
    expect(ctx.fakeDb.queries[0]!.sql).toContain("triage_attempts < $2");
  });
});

describe("create-post checks the experiment tag before writing", () => {
  const VIEWER: Viewer = { companyId: "co", userId: null, agentId: "agent-1", runId: null, isAgent: true };
  const experimentRow = {
    id: "exp1", company_id: "co", program_id: "prog1", hypothesis: "Question hooks", hypothesis_type: "hook:question", variable: "hook",
    arms: [{ key: "control", description: "Statement" }, { key: "variant", description: "Question" }], metric: "m", min_per_arm: 3, window_days: 7, status: "running",
  };
  const programRow = { id: "prog1", company_id: "co", client_kind: "company", client_ref: "c1", client_name: "Acme", channel: "social", objective: "o", metric: "m", constraints: {}, playbook: "# P", playbook_version: 1, autopilot: "safe", scoreboard: {}, feature_questions: [], status: "active" };

  function world(program = programRow) {
    return fakeCtx({ config: { get: vi.fn(async () => ({})) } }, {
      queryResult: (sql) => {
        if (sql.includes(`FROM ${T("growth_experiments")} WHERE id = $1`)) return [experimentRow];
        if (sql.includes(`FROM ${T("growth_programs")} WHERE id = $1`)) return [program];
        return [];
      },
    });
  }

  it("refuses an experiment of another scope and writes nothing", async () => {
    const ctx = world();
    await expect(createPostRecord(ctx, VIEWER, { body: "Hello", experimentId: "exp1", arm: "variant" })).rejects.toThrow(/belongs to Acme/);
    await expect(createPostRecord(ctx, VIEWER, { body: "Hello", experimentId: "exp1" })).rejects.toThrow(/arm must be/);
    expect(ctx.fakeDb.executes.filter((x) => x.sql.startsWith(`INSERT INTO ${T("posts")}`))).toHaveLength(0);
  });

  it("tags an own-work post with an own experiment arm", async () => {
    const ctx = world({ ...programRow, client_kind: null as never, client_ref: null as never, client_name: null as never });
    await createPostRecord(ctx, VIEWER, { body: "Hello", experimentId: "exp1", arm: "variant" }).catch(() => undefined);
    const tag = ctx.fakeDb.executes.find((x) => x.sql.includes("SET experiment_id = $3, experiment_arm = $4"))!;
    expect(tag.params.slice(2)).toEqual(["exp1", "variant"]);
    expect(ctx.fakeDb.executes.some((x) => x.sql.startsWith(`INSERT INTO ${T("growth_experiment_items")}`))).toBe(true);
  });
});
