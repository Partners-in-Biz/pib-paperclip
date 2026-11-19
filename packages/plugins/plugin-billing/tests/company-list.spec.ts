/** The Cockpit push list comes from the kit's actionable list; unknown falls back to the host list. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { reportingCompanyIds } from "../src/cockpit.js";

function ctxWith(actionable: "ok" | "throws") {
  const list = vi.fn(async (input?: { actionableOnly?: boolean }) => {
    if (input?.actionableOnly) {
      if (actionable === "throws") throw new Error("refused");
      return [{ id: "co-set" }];
    }
    return [{ id: "co-set" }, { id: "co-none" }];
  });
  const ctx = { state: { get: async () => null }, companies: { list }, logger: { info: () => undefined } } as unknown as PluginContext;
  return { ctx, list };
}

describe("reportingCompanyIds", () => {
  it("uses the actionable list and never lists the unconfigured company", async () => {
    const { ctx, list } = ctxWith("ok");
    expect(await reportingCompanyIds(ctx)).toEqual(["co-set"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("builds the list as before when the actionable list throws", async () => {
    const { ctx, list } = ctxWith("throws");
    expect((await reportingCompanyIds(ctx)).sort()).toEqual(["co-none", "co-set"]);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
