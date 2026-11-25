/**
 * PAR-13342: background work started by a tool call (the skill sync, rememberCompany)
 * must not carry the calling invocation's id, which the host refuses once it ended.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { createSkillSyncGuard, rememberCompany, resetKnownCompaniesMemo } from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const invocation = new AsyncLocalStorage<{ id: string }>();

describe("background work leaves the invocation", () => {
  it("runs the skill sync outside the caller's invocation", async () => {
    const seen: Array<string | undefined> = [];
    const soon = createSkillSyncGuard(async () => {
      await Promise.resolve();
      seen.push(invocation.getStore()?.id);
      return [{ skillKey: "operator", action: "reconcile" as const }];
    });
    await invocation.run({ id: "inv-1" }, () => soon("c1"));
    expect(seen).toEqual([undefined]);
  });

  it("writes the known-company list outside the caller's invocation", async () => {
    const ctx = fakeCtx() as any;
    resetKnownCompaniesMemo(ctx);
    const seen: Array<string | undefined> = [];
    const get = ctx.state.get.bind(ctx.state);
    ctx.state.get = async (...args: unknown[]) => (seen.push(invocation.getStore()?.id), get(...args));
    await invocation.run({ id: "inv-2" }, () => rememberCompany(ctx, "c9"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === undefined)).toBe(true);
  });
});
