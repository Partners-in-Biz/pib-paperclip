/**
 * The company brief must answer even when one read hangs (PAR-5959: the host
 * gave 504 after ~30 s): the slow section is cut off, named in `degraded`, and
 * everything else is still returned.
 */
import { describe, expect, it } from "vitest";
import { companyBrief } from "../src/brief.js";
import { briefBudget } from "../src/budget.js";
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

  it("stops waiting for later sections once the deadline has passed", async () => {
    const budget = briefBudget(() => {}, { sectionMs: 5_000, totalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    expect(await budget.guard("late", () => never<number>(), 0)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
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
});
