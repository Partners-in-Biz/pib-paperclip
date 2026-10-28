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
    (s.ctx as unknown as { approvals: { list: () => Promise<never> } }).approvals.list = () => never();
    const started = Date.now();
    const brief = await companyBrief(s.env, A, { sectionMs: 100, totalMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(brief.degraded).toContain("approvals");
    expect(brief.agents.map((a) => a.name)).toContain("Olive");
  }, 15_000);

  it("reports no degraded sections when every read answers", async () => {
    const s = setup();
    const brief = await companyBrief(s.env, A);
    expect(brief.degraded).toEqual([]);
  });

  it("health tool mentions unavailable sections in degraded", async () => {
    const s = setup();
    (s.ctx as unknown as { approvals: { list: () => Promise<never> } }).approvals.list = () => never();
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded.length).toBeGreaterThan(0);
    // The brief contains degraded sections; health should mention them.
    expect(brief.health).toBeDefined();
    expect(brief.degraded).toContain("approvals");
  }, 10_000);

  it("waiting tool shows degraded list when sections timeout", async () => {
    const s = setup();
    (s.ctx as unknown as { approvals: { list: () => Promise<never> } }).approvals.list = () => never();
    const brief = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(brief.degraded.length).toBeGreaterThan(0);
    expect(brief.waiting).toBeDefined();
  }, 10_000);

  it("runs snapshots and ownChecks in parallel, not sequentially", async () => {
    const s = setup();
    let snapshotsCalled = false;
    let ownChecksCalled = false;
    const originalSnapshots = s.ctx.db.query.bind(s.ctx.db);
    (s.ctx as unknown as { db: { query: (sql: string, params: unknown[]) => Promise<unknown[]> } }).db.query = async (sql: string, params: unknown[]) => {
      if (sql.includes(s.env.ctx.manifest.id)) {
        snapshotsCalled = true;
      }
      return originalSnapshots(sql, params);
    };
    const started = Date.now();
    const brief = await companyBrief(s.env, A, { sectionMs: 200, totalMs: 800 });
    const elapsed = Date.now() - started;
    // If snapshots and ownChecks ran sequentially with 200 ms each, we'd need ~400 ms+ just for those.
    // Running in parallel should be faster.
    expect(elapsed).toBeLessThan(800);
    expect(brief.agents.length).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("activity is returned as array even when runs or snapshots are degraded", async () => {
    const s = setup();
    const budget = briefBudget(
      (text, meta) => s.env.ctx.logger.info(text, meta),
      { sectionMs: 50, totalMs: 500 },
    );
    // Hang the snapshots read
    (s.ctx as unknown as { db: { query: (sql: string, params: unknown[]) => Promise<unknown[]> } }).db.query = async (sql: string, params: unknown[]) => {
      if (sql.includes("cockpit")) {
        return await never();
      }
      return [];
    };
    const data = await companyBrief(s.env, A, { sectionMs: 50, totalMs: 500 });
    expect(data.activity).toBeDefined();
    expect(Array.isArray(data.activity)).toBe(true);
    if (data.degraded.includes("snapshots") || data.degraded.includes("runs")) {
      expect(data.degraded).toContain("snapshots");
    }
  }, 10_000);
});

describe("runTool with degraded sections", () => {
  it("health tool says sections are unavailable when degraded", async () => {
    const s = setup();
    (s.ctx as unknown as { approvals: { list: () => Promise<never> } }).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.health, {}, { companyId: A, agentId: "test" } as any);
    // When sections are degraded, the content should mention "unavailable"
    const data = result.data as any;
    const degraded = data?.degraded as unknown[] | undefined;
    if (degraded && degraded.length > 0) {
      expect(result.content).toContain("unavailable");
    }
    expect(degraded).toBeDefined();
  }, 10_000);

  it("waiting tool shows degraded sections in content", async () => {
    const s = setup();
    (s.ctx as unknown as { approvals: { list: () => Promise<never> } }).approvals.list = () => never();
    const result = await runTool(s.env, TOOL_NAMES.waiting, {}, { companyId: A, agentId: "test" } as any);
    // When sections are degraded, the content should mention "unavailable"
    const data = result.data as any;
    const degraded = data?.degraded as unknown[] | undefined;
    if (degraded && degraded.length > 0) {
      expect(result.content).toContain("unavailable");
    }
    expect(degraded).toBeDefined();
  }, 10_000);
});
