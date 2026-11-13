/**
 * A tool call or a page load never waits long for the managed-skill sync
 * (the host can take more than 30 seconds for it), and a failed sync is not
 * tried again on every call.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { SKILL_SYNC_RETRY_MS, skillsSoon } from "../src/skill-sync.js";

type Sync = Array<{ skillKey: string; action: "ok" | "failed" }>;

function setup(ensure: () => Promise<Sync>) {
  let now = Date.parse("2026-11-13T06:20:00.000Z");
  const calls: string[] = [];
  const logs: string[] = [];
  const env = {
    ctx: { logger: { info: (text: string) => logs.push(text) } },
    skills: { ensure: (companyId: string) => (calls.push(companyId), ensure()), force: async () => [] },
    now: () => new Date(now),
  } as unknown as Env;
  return { env, calls, logs, advance: (ms: number) => (now += ms) };
}

describe("skillsSoon", () => {
  it("waits for a sync that answers at once", async () => {
    let done = false;
    const s = setup(async () => ((done = true), [{ skillKey: "operator", action: "ok" }]));
    await skillsSoon(s.env, "c1");
    expect(done).toBe(true);
    await skillsSoon(s.env, "c1");
    expect(s.calls).toEqual(["c1", "c1"]);
  });

  it("goes on after a moment when the host is slow, and lets the sync finish behind it", async () => {
    let finish!: (value: Sync) => void;
    const s = setup(() => new Promise<Sync>((resolve) => (finish = resolve)));
    const started = Date.now();
    await skillsSoon(s.env, "c1", 30);
    expect(Date.now() - started).toBeLessThan(1000);
    finish([{ skillKey: "operator", action: "ok" }]);
  });

  it("does not try again for five minutes after a failed sync, for that company only", async () => {
    let mode: "failed" | "throw" | "ok" = "failed";
    const s = setup(async () => {
      if (mode === "throw") throw new Error("skills.managed.reset timed out after 30000ms");
      return [{ skillKey: "operator", action: mode }];
    });
    await skillsSoon(s.env, "c1");
    await skillsSoon(s.env, "c1");
    await skillsSoon(s.env, "c2");
    expect(s.calls).toEqual(["c1", "c2"]);
    s.advance(SKILL_SYNC_RETRY_MS);
    mode = "throw";
    await skillsSoon(s.env, "c1");
    expect(s.calls).toEqual(["c1", "c2", "c1"]);
    expect(s.logs).toContain("Managed skill sync failed");
    await skillsSoon(s.env, "c1");
    expect(s.calls).toHaveLength(3);
    s.advance(SKILL_SYNC_RETRY_MS);
    mode = "ok";
    await skillsSoon(s.env, "c1");
    await skillsSoon(s.env, "c1");
    expect(s.calls).toHaveLength(5);
  });
});
