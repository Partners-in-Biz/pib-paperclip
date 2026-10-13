import { describe, expect, it, vi } from "vitest";
import { readSettings, secretStatus } from "../src/settings.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const mockCtx = (config: Record<string, unknown> = {}) => ({
  config: { get: vi.fn().mockResolvedValue(config) },
  secrets: { resolve: vi.fn().mockRejectedValue(new Error("not found")) },
} as unknown as PluginContext);

describe("Telephony Settings", () => {
  it("defaults all switches OFF", async () => {
    const result = await readSettings(mockCtx({}), "c1");
    expect(result.recordingEnabled).toBe(false);
    expect(result.whatsappEnabled).toBe(false);
    expect(result.smsEnabled).toBe(false);
  });

  it("defaults numeric caps to 50/200/200/30", async () => {
    const result = await readSettings(mockCtx({}), "c1");
    expect(result.maxCallsPerDay).toBe(50);
    expect(result.maxSmsPerDay).toBe(200);
    expect(result.maxWhatsappPerDay).toBe(200);
    expect(result.recordingRetentionDays).toBe(30);
  });

  it("defaults allowed hours to 08:00-18:00 Africa/Johannesburg", async () => {
    const result = await readSettings(mockCtx({}), "c1");
    expect(result.allowedHours).toEqual({
      start: "08:00",
      end: "18:00",
      timezone: "Africa/Johannesburg",
    });
  });

  it("accepts valid time HH:MM format", async () => {
    const cfg = { allowedHours: { start: "09:30", end: "17:45" } };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.allowedHours.start).toBe("09:30");
    expect(result.allowedHours.end).toBe("17:45");
  });

  it("rejects invalid time formats", async () => {
    const cfg = { allowedHours: { start: "9:30", end: "25:00" } };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.allowedHours.start).toBe("08:00");
    expect(result.allowedHours.end).toBe("18:00");
  });

  it("always uses Africa/Johannesburg timezone, ignoring custom config", async () => {
    const cfg = { allowedHours: { timezone: "UTC" } };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.allowedHours.timezone).toBe("Africa/Johannesburg");
  });

  it("filters invalid E.164 caller IDs", async () => {
    const cfg = { callerIds: ["+27123456789", "0271234", "+12345"] };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.callerIds).toEqual(["+27123456789"]);
  });

  it("deduplicates and limits caller IDs to 10", async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `+2700000000${i}`);
    const result = await readSettings(mockCtx({ callerIds: ids }), "c1");
    expect(result.callerIds).toHaveLength(10);
  });

  it("clamps numeric caps to valid range", async () => {
    const cfg = { maxCallsPerDay: -5, maxSmsPerDay: 999999 };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.maxCallsPerDay).toBe(50);
    expect(result.maxSmsPerDay).toBe(200);
  });

  it("only literal true turns on switches", async () => {
    const cfg = { recordingEnabled: "yes", whatsappEnabled: 1 };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.recordingEnabled).toBe(false);
    expect(result.whatsappEnabled).toBe(false);
  });

  it("garbage config and null fall back to defaults", async () => {
    const ctx1 = { config: { get: vi.fn().mockRejectedValue(new Error()) } };
    const result1 = await readSettings(ctx1 as any, "c1");
    expect(result1.recordingEnabled).toBe(false);

    const ctx2 = { config: { get: vi.fn().mockResolvedValue(null) } };
    const result2 = await readSettings(ctx2 as any, "c1");
    expect(result2.maxCallsPerDay).toBe(50);
  });

  it("secretStatus never returns values or error text", async () => {
    const result = await secretStatus(mockCtx({}), "c1", ["KEY"]);
    expect(result.KEY).toBe("missing");
    expect(JSON.stringify(result)).not.toContain("not found");
  });

  it.each([
    ["none", "none"],
    ["pending", "pending"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["invalid", "none"],
  ])("usSmsCampaignStatus: %s -> %s", async (input, expected) => {
    const result = await readSettings(mockCtx({ usSmsCampaignStatus: input }), "c1");
    expect(result.usSmsCampaignStatus).toBe(expected);
  });

  it("usMessagingServiceSid: defaults to null, accepts valid, rejects invalid", async () => {
    const valid = "MGd3200a283d8d4dd9827e5b6d5f5e5e5a";
    const invalid = ["MG123", "SM1234567890abcdef1234567890abcdef", "twilio"];

    expect((await readSettings(mockCtx({}), "c1")).usMessagingServiceSid).toBeNull();
    expect((await readSettings(mockCtx({ usMessagingServiceSid: valid }), "c1")).usMessagingServiceSid).toBe(valid);

    for (const sid of invalid) {
      const result = await readSettings(mockCtx({ usMessagingServiceSid: sid }), "c1");
      expect(result.usMessagingServiceSid).toBeNull();
    }
  });

  it("smsHolidays: defaults empty, accepts ISO dates, rejects bad formats", async () => {
    expect((await readSettings(mockCtx({}), "c1")).smsHolidays).toEqual([]);

    const valid = { smsHolidays: ["2026-12-25", "2026-01-01"] };
    const r1 = await readSettings(mockCtx(valid), "c1");
    expect(r1.smsHolidays).toContain("2026-12-25");

    const invalid = { smsHolidays: ["2026-12-25", "25/12/2026", "12-25-2026", "2026-02-30"] };
    const r2 = await readSettings(mockCtx(invalid), "c1");
    expect(r2.smsHolidays).toEqual(["2026-12-25"]);

    const dups = { smsHolidays: ["2026-12-25", "2026-12-25", "2026-01-01"] };
    const r3 = await readSettings(mockCtx(dups), "c1");
    expect(r3.smsHolidays).toHaveLength(2);

    const many = { smsHolidays: Array.from({ length: 50 }, (_, i) => `2026-0${(i % 9) + 1}-01`) };
    const r4 = await readSettings(mockCtx(many), "c1");
    expect(r4.smsHolidays.length).toBeLessThanOrEqual(40);
  });
});
