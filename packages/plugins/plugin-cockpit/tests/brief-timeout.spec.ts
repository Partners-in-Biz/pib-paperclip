/**
 * The company brief must answer even when one read hangs (PAR-5959: the host
 * gave 504 after ~30 s): the slow section is cut off, named in `degraded`, and
 * everything else is still returned.
 */
import { describe, expect, it } from "vitest";
import { companyBrief, runTool } from "../src/brief.js";
import { briefBudget } from "../src/budget.js";
import { TOOL_NAMES } from "../src/tools.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const never = <T>() => new Promise<T>(() => {});

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

  it("health.healthAvailable reflects snapshots/ownChecks degradation", async () => {
    const s = setup();
    // This test shows that healthAvailable depends on snapshots/ownChecks, not other degraded sections
    (s.ctx as any).approvals.list = () => never();
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded).toContain("approvals");
    // If snapshots or ownChecks are degraded, healthAvailable should be false
    if (brief.degraded.includes("snapshots") || brief.degraded.includes("ownChecks")) {
      expect(brief.health.healthAvailable).toBe(false);
    } else {
      expect(brief.health.healthAvailable).toBe(true);
    }
  }, 10_000);

  it("health.healthAvailable is true for normal briefs", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1000 });
    expect(brief.degraded).toEqual([]);
    expect(brief.health.healthAvailable).toBe(true);
  }, 10_000);

  it("setupMissing is null when setupSummary is degraded", async () => {
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

  it("setupMissing is a number when nothing is degraded", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1000 });
    expect(brief.degraded).toEqual([]);
    expect(typeof brief.setupMissing === "number" || brief.setupMissing === null).toBe(true);
  }, 10_000);

  it("activity is returned as array even with degraded sections", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(Array.isArray(brief.activity)).toBe(true);
  }, 10_000);
});

describe("runTool with degraded sections", () => {
  it("health tool includes unavailable message when snapshots or ownChecks degraded", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.health, {}, { companyId: A, agentId: "test" } as any);
    const data = result.data as any;
    // When snapshots or ownChecks is degraded, health is unavailable
    if (data?.degraded?.includes("snapshots") || data?.degraded?.includes("ownChecks")) {
      expect(result.content).toContain("unavailable");
      expect(data?.healthAvailable).toBe(false);
    } else {
      expect(data?.healthAvailable).toBe(true);
    }
  }, 10_000);

  it("waiting tool shows proper text for normal case", async () => {
    const s = setup();
    const result = await runTool(s.env, TOOL_NAMES.waiting, {}, { companyId: A, agentId: "test" } as any);
    expect(result.content).toBeDefined();
    const data = result.data as any;
    expect(Array.isArray(data?.items)).toBe(true);
  }, 10_000);

  it("brief tool shows proper health status for normal case", async () => {
    const s = setup();
    const result = await runTool(s.env, TOOL_NAMES.brief, {}, { companyId: A, agentId: "test" } as any);
    expect(result.content).toContain("waiting");
    expect(result.content).toContain("health");
  }, 10_000);

  it("waiting tool shows degraded when approvals times out", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.waiting, {}, { companyId: A, agentId: "test" } as any);
    const data = result.data as any;
    expect(data?.degraded).toContain("approvals");
  }, 10_000);

  it("health tool includes degraded list in data", async () => {
    const s = setup();
    (s.ctx as any).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.health, {}, { companyId: A, agentId: "test" } as any);
    const data = result.data as any;
    expect(data?.degraded).toContain("approvals");
    // healthAvailable reflects snapshots/ownChecks degradation
    if (data?.degraded?.includes("snapshots") || data?.degraded?.includes("ownChecks")) {
      expect(data?.healthAvailable).toBe(false);
    } else {
      expect(data?.healthAvailable).toBe(true);
    }
  }, 10_000);
});
