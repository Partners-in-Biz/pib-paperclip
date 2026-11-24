/** The SEO company list comes from the kit's actionable list; unknown falls back to the per-company probe. */
import { describe, expect, it, vi } from "vitest";
import { seoCompanies } from "../src/service/setup-status.js";

function host(actionable: "ok" | "throws") {
  const configCalls: string[] = [];
  const ctx = {
    db: { namespace: "plugin_test", query: vi.fn(async () => []), execute: vi.fn(async () => ({ rowCount: 0 })) },
    config: { get: vi.fn(async (companyId: string) => { configCalls.push(companyId); return companyId === "co-set" ? { x: 1 } : {}; }) },
    companies: {
      list: vi.fn(async (input?: { actionableOnly?: boolean }) => {
        if (input?.actionableOnly) {
          if (actionable === "throws") throw new Error("refused");
          return [{ id: "co-set" }];
        }
        return [{ id: "co-set" }, { id: "co-none" }];
      }),
    },
    logger: { info: () => undefined },
  };
  return { ctx, configCalls, env: { ctx } as never };
}

describe("seoCompanies", () => {
  it("uses the actionable list and makes no config call for the unconfigured company", async () => {
    const h = host("ok");
    expect(await seoCompanies(h.env)).toEqual(["co-set"]);
    expect(h.configCalls).toEqual([]);
  });

  it("builds the list as before when the actionable list throws", async () => {
    const h = host("throws");
    expect(await seoCompanies(h.env)).toEqual(["co-set"]);
    expect(h.configCalls).toEqual(["co-set", "co-none"]);
  });
});
