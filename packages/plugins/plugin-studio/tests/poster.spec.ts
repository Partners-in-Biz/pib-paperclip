import { describe, expect, it, vi } from "vitest";
import { ensurePoster, posterArgs, posterKeyFor } from "../src/video-edit/poster.js";

const co = "co1";
const videoKey = "studio/co1/own/asset1/v2.mp4";

describe("poster", () => {
  it("keys sit in the asset folder, per version, and pass assertOwnKey", () => {
    expect(posterKeyFor(co, videoKey, 2)).toBe("studio/co1/own/asset1/poster-v2.jpg");
    expect(posterKeyFor(co, videoKey, 3)).not.toBe(posterKeyFor(co, videoKey, 2));
    expect(() => posterKeyFor("other", videoKey, 2)).toThrow();
    expect(() => posterKeyFor(co, "x/y.mp4", 1)).toThrow();
  });
  it("cuts one frame", () => {
    expect(posterArgs("a.mp4", "p.jpg")).toEqual(expect.arrayContaining(["-frames:v", "1"]));
  });
  it("is made once per version", async () => {
    const store = new Map<string, Uint8Array>();
    const make = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const deps = { read: async (k: string) => store.get(k) ?? null, make, write: async (k: string, b: Uint8Array) => void store.set(k, b) };
    await ensurePoster(co, videoKey, 2, deps);
    await ensurePoster(co, videoKey, 2, deps);
    expect(make).toHaveBeenCalledTimes(1);
    await ensurePoster(co, videoKey, 3, deps);
    expect(make).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual(["studio/co1/own/asset1/poster-v2.jpg", "studio/co1/own/asset1/poster-v3.jpg"]);
  });
});
