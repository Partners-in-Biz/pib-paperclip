/**
 * The job company list comes from the kit's actionable list (companies with saved
 * settings); when that list is unknown it falls back to the per-company probe.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const { payrollCompanies } = await import("../src/service/jobs.js");

function host(options: { actionable: "ok" | "throws" }) {
  const configCalls: string[] = [];
  const ctx = {
    config: { get: vi.fn(async (companyId: string) => { configCalls.push(companyId); return companyId === "co-set" ? { x: 1 } : {}; }) },
    companies: {
      list: vi.fn(async (input?: { actionableOnly?: boolean }) => {
        if (input?.actionableOnly) {
          if (options.actionable === "throws") throw new Error("refused");
          return [{ id: "co-set" }];
        }
        return [{ id: "co-set" }, { id: "co-none" }];
      }),
    },
    logger: { info: () => undefined },
  };
  return { ctx, configCalls, e: { ctx } as never };
}

describe("payrollCompanies", () => {
  it("uses the actionable list and makes no config call for the unconfigured company", async () => {
    const h = host({ actionable: "ok" });
    expect(await payrollCompanies(h.e)).toEqual(["company-1", "co-set"]);
    expect(h.configCalls).toEqual([]);
    expect(h.ctx.companies.list).toHaveBeenCalledTimes(1);
  });

  it("builds the list as before when the actionable list throws", async () => {
    const h = host({ actionable: "throws" });
    expect(await payrollCompanies(h.e)).toEqual(["company-1", "co-set"]);
    expect(h.configCalls).toEqual(["co-set", "co-none"]);
  });
});
