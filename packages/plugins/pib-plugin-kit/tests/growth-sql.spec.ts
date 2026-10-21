import { describe, expect, it } from "vitest";
import { createGrowthStore, scopeKeyOf, type GrowthDb } from "../src/growth/store.js";

const NS = "plugin_demo_0123456789";

function recorder() {
  const statements: Array<{ sql: string; params: unknown[]; write: boolean }> = [];
  const db: GrowthDb = {
    query: async (sql, params = []) => {
      statements.push({ sql, params, write: false });
      return [];
    },
    execute: async (sql, params = []) => {
      statements.push({ sql, params, write: true });
      return { rowCount: 1 };
    },
  };
  return { db, statements };
}

describe("generic growth store SQL", () => {
  it("every method issues one statement on qualified tables", async () => {
    for (const programApproval of [false, true]) {
      const { db, statements } = recorder();
      const s = createGrowthStore({ db, table: (n) => `${NS}.${n}`, programApproval });
      const program = { id: "p1", companyId: "co", clientKind: "company", clientRef: "c1", clientName: "Acme", channel: "social", objective: "o", metric: "m", constraints: {}, playbook: "# P", playbookVersion: 1, autopilot: "reviewed", scoreboard: {}, featureQuestions: [], ownerUserId: null };
      await s.findProgram("co", "social", null);
      await s.findProgram("co", "social", { kind: "contact", id: "ct1" });
      await s.getProgram("co", "p1");
      await s.insertProgram(program);
      await s.updateProgram("co", "p1", { objective: "o2", approvalIssueId: "i" });
      await s.updateProgram("co", "p1", {});
      await s.savePlaybook("co", "p1", 1, "# P2");
      await s.insertPlaybookVersion({ programId: "p1", version: 2, playbook: "# P2", reason: "r", experimentId: null, createdBy: null });
      await s.listPlaybookVersions("p1", 10);
      await s.insertExperiment({ id: "e1", companyId: "co", programId: "p1", hypothesis: "h", hypothesisType: "t", variable: "v", arms: [], metric: "m", minPerArm: 3, windowDays: 7, status: "proposed", proposedBy: null });
      await s.getExperiment("co", "e1");
      await s.listExperiments("co", "p1");
      await s.listExperiments("co", "p1", ["running"]);
      await s.updateExperiment("co", "e1", ["proposed"], { status: "running" });
      await s.updateExperiment("co", "e1", null, { verdict: "win" });
      await s.companiesWithRunningExperiments();
      await s.runningExperiments("co");
      await s.upsertItem("e1", "control", "post1", null);
      await s.deleteItem("e1", "post1");
      await s.listItems("e1");
      await s.insertChange({ id: "c1", companyId: "co", programId: "p1", experimentId: null, op: "add", section: null, body: "b", diff: "d", reason: "r", baseVersion: 1, proposedBy: null });
      await s.getChange("co", "c1");
      await s.listChanges("co", "p1", "pending");
      await s.updateChange("co", "c1", { status: "kept" }, true);
      expect(statements.length).toBe(24);
      for (const { sql } of statements) {
        expect(sql.replace(/;\s*$/, "")).not.toContain(";");
        const tables = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
        expect(tables.length).toBeGreaterThan(0);
        for (const t of tables) expect(t).toMatch(new RegExp(`^${NS}\\.growth_`));
      }
    }
  });

  it("matches a program by scope_key and falls back to the legacy columns", async () => {
    const { db, statements } = recorder();
    const s = createGrowthStore({ db, table: (n) => `${NS}.${n}` });
    await s.findProgram("co", "social", { kind: "company", id: "c1" });
    await s.findProgram("co", "social", null);
    expect(statements[0]!.sql).toContain("(scope_key = $3 OR (scope_key IS NULL AND client_ref = $5 AND COALESCE(client_kind, 'company') = $4))");
    expect(statements[0]!.params).toEqual(["co", "social", "client:company:c1", "company", "c1"]);
    expect(statements[1]!.sql).toContain("scope_key IS NULL AND client_ref IS NULL");
    expect(statements[1]!.params).toEqual(["co", "social", "own"]);
  });

  it("writes scope_key with the legacy columns, and selects approval columns only when the table has them", async () => {
    const { db, statements } = recorder();
    const base = { id: "p", companyId: "co", channel: "social", objective: "o", metric: "m", playbook: "", playbookVersion: 1, autopilot: "reviewed" };
    const s = createGrowthStore({ db, table: (n) => `${NS}.${n}` });
    await s.insertProgram({ ...base, clientKind: null, clientRef: null });
    await s.insertProgram({ ...base, clientKind: null, clientRef: "c1" });
    expect(statements[0]!.params.slice(2, 5)).toEqual(["own", null, null]);
    expect(statements[1]!.params.slice(2, 5)).toEqual(["client:company:c1", "company", "c1"]);
    await s.getProgram("co", "p");
    expect(statements[2]!.sql).toContain("NULL AS approval_issue_id");
    const withApproval = createGrowthStore({ db, table: (n) => `${NS}.${n}`, programApproval: true });
    await withApproval.getProgram("co", "p");
    expect(statements[3]!.sql).not.toContain("NULL AS approval_issue_id");
    expect(scopeKeyOf(null)).toBe("own");
  });
});
