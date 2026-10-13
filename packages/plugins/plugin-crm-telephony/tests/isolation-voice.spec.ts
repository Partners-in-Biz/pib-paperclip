import { describe, expect, it, vi } from "vitest";
import { pickCallerId } from "../src/caller-id.js";
import { readSettings } from "../src/settings.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const A = "company-a";
const B = "company-b";

describe("Isolation: Voice Settings & Caller IDs", () => {
  describe("pickCallerId: company-specific routing", () => {
    it.each([
      { to: "+27821234567", nums: { za: "+27821111111", us: "+12025551234" }, expect: "+27821111111", region: "ZA" },
      { to: "+12125552000", nums: { za: "+27829999999", us: "+12025559999" }, expect: "+12025559999", region: "US" },
      { to: "+27821234567", nums: { us: "+12025551234" }, expect: null, reason: "caller_id_not_configured" },
      { to: "+12125552000", nums: { za: "+27821111111" }, expect: null, reason: "caller_id_not_configured" },
    ])("$region/$reason routing", ({ to, nums, expect: exp, region, reason }) => {
      const result = pickCallerId(to, nums);
      if (exp) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.callerId).toBe(exp);
          expect(result.region).toBe(region);
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(reason);
      }
    });

    it("A's numbers never used for B's region", () => {
      const aNum = { za: "+27821111111", us: "+12025551234" };
      const result = pickCallerId("+12125552000", aNum);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.callerId).toBe("+12025551234");
    });
  });

  describe("readSettings: per-company config only", () => {
    it.each([
      {
        co: A,
        config: { callerIds: ["+27821111111", "+12025551234"], voiceAllowedUserIds: ["user-a1", "user-a2"] },
        want: { cids: ["+27821111111", "+12025551234"], users: ["user-a1", "user-a2"] },
      },
      {
        co: B,
        config: { callerIds: ["+27829999999", "+12025559999"], voiceAllowedUserIds: ["user-b1"] },
        want: { cids: ["+27829999999", "+12025559999"], users: ["user-b1"] },
      },
    ])("$co gets own config", async ({ co, config, want }) => {
      const ctx = {
        config: { get: vi.fn().mockResolvedValue(config) },
        secrets: { resolve: vi.fn() },
      } as unknown as PluginContext;

      const settings = await readSettings(ctx, co);

      expect(settings.callerIds).toEqual(want.cids);
      expect(settings.voiceAllowedUserIds).toEqual(want.users);
    });

    it.each([
      { err: false, config: {} },
      { err: true, config: null },
    ])("empty/error config returns empty lists", async ({ err, config }) => {
      const ctx = {
        config: { get: err ? vi.fn().mockRejectedValue(new Error("failed")) : vi.fn().mockResolvedValue(config) },
        secrets: { resolve: vi.fn() },
      } as unknown as PluginContext;

      const settings = await readSettings(ctx, A);

      expect(settings.callerIds).toEqual([]);
      expect(settings.voiceAllowedUserIds).toEqual([]);
    });
  });
});
