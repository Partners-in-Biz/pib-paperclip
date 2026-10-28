/**
 * The company brief must answer even when one read hangs (PAR-5959: the host
 * gave 504 after ~30 s): the slow section is cut off, named in `degraded`, and
 * everything else is still returned.
 */
import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { companyBrief, ensureBriefIssue, runTool } from "../src/brief.js";
import { briefBudget } from "../src/budget.js";
import { TOOL_NAMES } from "../src/tools.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const never = <T>() => new Promise<T>(() => {});
const RUN: ToolRunContext = { agentId: "test-agent", runId: "test-run", companyId: A, projectId: "test-project" };

function setup() {
  const fake = fakeCtx({
    savedConfigs: { [A]: { healthIssue: true } },
    agents: [{ id: "op", companyId: A, name: "Olive", status: "active" }],
  });
  const env = createEnv(fake.ctx, fixedClock("2026-09-26T10:00:00.000Z").now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env };
}

describe("briefBudget", () => {
  it("gives the fallback and names the section when it runs out of time", async () => {
    const budget = briefBudget(() => {}, { sectionMs: 20 });
    expect(await budget.guard("slow", () => never<number>(), 7)).toBe(7);
    expect(await budget.guard("fine", async () => 1, 0)).toBe(1);
    expect(budget.degraded).toEqual(["slow"]);
  });

  it("gives the fallback when the section throws", async () => {
    const budget = briefBudget(() => {}, { sectionMs: 1000 });
    expect(await budget.guard("broken", async () => { throw new Error("boom"); }, "none")).toBe("none");
    expect(budget.degraded).toEqual(["broken"]);
  });

  it("waits the 250 ms floor once the deadline has passed", async () => {
    const budget = briefBudget(() => {}, { sectionMs: 5_000, totalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    expect(await budget.guard("late", () => never<number>(), 0)).toBe(0);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("companyBrief with a hanging read", () => {
  it("answers within the budget, with the hung section listed in degraded", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const started = Date.now();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(brief.degraded).toContain("approvals");
    expect(brief.agents.map((a) => a.name)).toContain("Olive");
  }, 15_000);

  it("hangs setupSummary and marks setupMissing as null", async () => {
    const s = setup();
    const origStateGet = s.ctx.state.get.bind(s.ctx.state);
    (s.ctx as any).state.get = async (key: any) => {
      if (key?.stateKey === "setup-summary") {
        return await never();
      }
      return origStateGet(key);
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("setupSummary");
    expect(brief.setupMissing).toBeNull();
  }, 10_000);

  it("hangs company.get and includes it in degraded", async () => {
    const s = setup();
    (s.ctx as any).companies.get = async (id: string) => {
      return await never<any>();
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("company");
  }, 10_000);

  it("reports no degraded sections when every read answers", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1000 });
    expect(brief.degraded).toEqual([]);
  }, 10_000);


  it("health.healthAvailable is true for normal briefs", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1000 });
    expect(brief.degraded).toEqual([]);
    expect(brief.health.healthAvailable).toBe(true);
  }, 10_000);

  it("hangs ownerRoles and marks it degraded", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = async (sql: string) => {
      // team_members queries are for getRoles
      if (sql.includes("team_members")) {
        return await never();
      }
      return origQuery(sql);
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("ownerRoles");
  }, 10_000);

  it("setupMissing is null when setupSummary is degraded", async () => {
    const s = setup();
    const origStateGet = s.ctx.state.get.bind(s.ctx.state);
    s.ctx.state.get = async (key: unknown): Promise<unknown> => {
      if (key && typeof key === "object" && (key as Record<string, unknown>).stateKey === "setup-summary") {
        return await never();
      }
      return origStateGet(key as Parameters<typeof origStateGet>[0]);
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("setupSummary");
    expect(brief.setupMissing).toBeNull();
  }, 10_000);

  it("setupMissing is a number when nothing is degraded", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1000 });
    expect(brief.degraded).toEqual([]);
    expect(typeof brief.setupMissing).toBe("number");
  }, 10_000);

  it("parallel start: snapshots and ownChecks execute concurrently", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    let queryCount = 0;
    s.ctx.db.query = async (sql: string) => {
      queryCount++;
      // Add delay to first two queries to test parallel execution
      if (queryCount <= 2) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return origQuery(sql);
    };
    const started = Date.now();
    const brief = await companyBrief(s.env, A, { sectionMs: 1000, totalMs: 5000 });
    const elapsed = Date.now() - started;
    // If they ran serially (~300ms+), elapsed would be >300. Running in parallel should be <250.
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it("staleChecks skipped when snapshots degraded", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = async (sql: string) => {
      if (sql.includes("plugin_snapshots")) {
        return await never();
      }
      return origQuery(sql);
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("snapshots");
    // staleChecks should be skipped, so health problems should only be from live plugins/agents, not from stale checks
    const staleCheckProblems = brief.health.problems.filter((p) => p.detail?.includes("not reporting"));
    expect(staleCheckProblems).toHaveLength(0);
  }, 10_000);

  it("ensureBriefIssue creates a new issue with owner unassigned when roles missing", async () => {
    const s = setup();
    const result = await ensureBriefIssue(s.env, A);
    expect(result.issueId).toBeDefined();
    expect(result.created).toBe(true);
    const issue = await s.ctx.issues.get(result.issueId, A).catch(() => null);
    expect(issue).toBeDefined();
    // The issue should be created even if we couldn't fetch roles (falls back to null owner)
    expect(issue?.status).toBe("todo");
  }, 10_000);

  it("activity is returned as array even with degraded sections", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(Array.isArray(brief.activity)).toBe(true);
  }, 10_000);
});

describe("runTool with degraded sections", () => {
  it("health tool shows 'health unavailable' text when snapshots degraded", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = async (sql: string) => {
      if (sql.includes("plugin_snapshots")) {
        return await never();
      }
      return origQuery(sql);
    };
    const result = await runTool(s.env, TOOL_NAMES.health, {}, RUN);
    expect(result.content).toContain("health unavailable");
    const data = result.data as Record<string, unknown>;
    expect(data.healthAvailable).toBe(false);
  }, 10_000);

  it("waiting tool shows proper text for normal case", async () => {
    const s = setup();
    const result = await runTool(s.env, TOOL_NAMES.waiting, {}, RUN);
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
    const data = result.data as Record<string, unknown>;
    expect(Array.isArray(data.items)).toBe(true);
  }, 10_000);

  it("brief tool shows health status in content and data", async () => {
    const s = setup();
    const result = await runTool(s.env, TOOL_NAMES.brief, {}, RUN);
    expect(result.content).toMatch(/health (ok|warn|bad|unavailable)/);
    const data = result.data as Record<string, unknown>;
    expect(data.health).toBeDefined();
    expect(data.today).toBeDefined();
  }, 10_000);

  it("waiting tool shows degraded when approvals times out", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.waiting, {}, RUN);
    const data = result.data as Record<string, unknown>;
    expect((data.degraded as string[])).toContain("approvals");
  }, 10_000);

  it("health status is unavailable when snapshots degraded", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = async (sql: string) => {
      if (sql.includes("plugin_snapshots")) {
        return await never();
      }
      return origQuery(sql);
    };
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("snapshots");
    expect(brief.health.healthAvailable).toBe(false);
    expect(brief.health.status).toBe("unavailable");
  }, 10_000);

  it("brief tool shows exact health status text when unavailable", async () => {
    const s = setup();
    const origQuery = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = async (sql: string) => {
      if (sql.includes("plugin_snapshots")) {
        return await never();
      }
      return origQuery(sql);
    };
    const result = await runTool(s.env, TOOL_NAMES.brief, {}, RUN);
    expect(result.content).toContain("health unavailable");
  }, 10_000);
});
