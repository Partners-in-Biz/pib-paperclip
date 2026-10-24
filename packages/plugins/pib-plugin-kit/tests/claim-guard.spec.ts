import { describe, expect, it, vi } from "vitest";
import { createClaimGuard } from "../src/claim-guard.js";

const NONE = {};

describe("createClaimGuard", () => {
  it("a flood of made-up company ids resolves no more than the lookup cap", async () => {
    const guard = createClaimGuard<string>({ lookupsPerMinute: 10, perVisitorPerMinute: 1000 });
    const load = vi.fn(async () => null);
    for (let i = 0; i < 500; i += 1) await guard.resolve(`co-${i}`, NONE, load);
    expect(load).toHaveBeenCalledTimes(10);
  });

  it("remembers a value and a miss for a minute, then asks again", async () => {
    let t = 0;
    const guard = createClaimGuard<string>({ now: () => t });
    const load = vi.fn(async () => null);
    await guard.resolve("a", NONE, load);
    await guard.resolve("a", NONE, load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 61_000;
    await guard.resolve("a", NONE, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failed read", async () => {
    const guard = createClaimGuard<string>();
    const load = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("s");
    expect(await guard.resolve("a", NONE, load)).toBeNull();
    expect(await guard.resolve("a", NONE, load)).toBe("s");
  });

  it("limits a visitor's uncached lookups, not its cached hits, and counts visitors apart", async () => {
    let t = 0;
    const guard = createClaimGuard<string>({ perVisitorPerMinute: 3, now: () => t });
    const a = { "x-forwarded-for": "1.1.1.1, 10.0.0.1" };
    const load = vi.fn(async () => "s");
    const fresh = [1, 2, 3, 4].map((i) => guard.resolve(`co-${i}`, a, load));
    expect(await Promise.all(fresh)).toEqual(["s", "s", "s", null]);
    // Cached ids stay free for the visitor who is over its allowance.
    for (let i = 0; i < 50; i += 1) expect(await guard.resolve("co-1", a, load)).toBe("s");
    expect(await guard.resolve("co-9", { "x-real-ip": "2.2.2.2" }, load)).toBe("s");
    t = 61_000;
    expect(await guard.resolve("co-4", a, load)).toBe("s");
  });
});
