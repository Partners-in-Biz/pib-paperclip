import { describe, expect, it, vi } from "vitest";
import { createClaimGuard } from "../src/claim-guard.js";

describe("createClaimGuard", () => {
  it("a flood of made-up company ids resolves no more than the lookup cap", async () => {
    const guard = createClaimGuard<string>({ lookupsPerMinute: 10, perVisitorPerMinute: 1000 });
    const load = vi.fn(async () => null);
    for (let i = 0; i < 500; i += 1) await guard.resolve(`co-${i}`, load);
    expect(load).toHaveBeenCalledTimes(10);
  });

  it("remembers a value and a miss for a minute, then asks again", async () => {
    let t = 0;
    const guard = createClaimGuard<string>({ now: () => t });
    const load = vi.fn(async () => null);
    await guard.resolve("a", load);
    await guard.resolve("a", load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 61_000;
    await guard.resolve("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failed read", async () => {
    const guard = createClaimGuard<string>();
    const load = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("s");
    expect(await guard.resolve("a", load)).toBeNull();
    expect(await guard.resolve("a", load)).toBe("s");
  });

  it("limits a visitor per minute and counts visitors apart", () => {
    let t = 0;
    const guard = createClaimGuard<string>({ perVisitorPerMinute: 3, now: () => t });
    const a = { "x-forwarded-for": "1.1.1.1, 10.0.0.1" };
    const results = [1, 2, 3, 4].map(() => guard.allow(a));
    expect(results).toEqual([true, true, true, false]);
    expect(guard.allow({ "x-real-ip": "2.2.2.2" })).toBe(true);
    t = 61_000;
    expect(guard.allow(a)).toBe(true);
  });
});
