import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { runDetached } from "../src/detach.js";

describe("runDetached", () => {
  it("drops the caller's async context, like an action's invocation id", async () => {
    const invocation = new AsyncLocalStorage<{ id: string }>();
    const seen = await invocation.run({ id: "action-1" }, async () => {
      expect(invocation.getStore()?.id).toBe("action-1");
      const inherited = await Promise.resolve().then(() => invocation.getStore()?.id);
      const detached = await runDetached(() => Promise.resolve().then(() => invocation.getStore()?.id));
      return { inherited, detached };
    });
    expect(seen.inherited).toBe("action-1");
    expect(seen.detached).toBeUndefined();
  });

  it("returns the work's result", () => {
    expect(runDetached(() => 42)).toBe(42);
  });
});
