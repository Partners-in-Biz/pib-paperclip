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

  it("defaults voiceAllowedUserIds to empty array", async () => {
    const result = await readSettings(mockCtx({}), "c1");
    expect(result.voiceAllowedUserIds).toEqual([]);
  });

  it("filters non-string entries from voiceAllowedUserIds", async () => {
    const cfg = { voiceAllowedUserIds: ["user-1", 123, null, "user-2"] };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.voiceAllowedUserIds).toEqual(["user-1", "user-2"]);
  });

  it("trims whitespace from voiceAllowedUserIds entries", async () => {
    const cfg = { voiceAllowedUserIds: ["  user-1  ", "user-2\n", "\tuser-3"] };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.voiceAllowedUserIds).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("deduplicates voiceAllowedUserIds", async () => {
    const cfg = { voiceAllowedUserIds: ["user-1", "user-2", "user-1", "user-2"] };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.voiceAllowedUserIds).toEqual(["user-1", "user-2"]);
  });

  it("limits voiceAllowedUserIds to 50 entries", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `user-${i}`);
    const result = await readSettings(mockCtx({ voiceAllowedUserIds: ids }), "c1");
    expect(result.voiceAllowedUserIds).toHaveLength(50);
  });

  it("filters out empty strings from voiceAllowedUserIds", async () => {
    const cfg = { voiceAllowedUserIds: ["user-1", "", "user-2", "   "] };
    const result = await readSettings(mockCtx(cfg), "c1");
    expect(result.voiceAllowedUserIds).toEqual(["user-1", "user-2"]);
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

  it("whatsappFrom: accepts E.164 and whatsapp:E.164, rejects invalid", async () => {
    expect((await readSettings(mockCtx({}), "c1")).whatsappFrom).toBeNull();
    const r1 = await readSettings(mockCtx({ whatsappFrom: "+27123456789" }), "c1");
    expect(r1.whatsappFrom).toBe("+27123456789");
    const r2 = await readSettings(mockCtx({ whatsappFrom: "whatsapp:+27123456789" }), "c1");
    expect(r2.whatsappFrom).toBe("+27123456789");
    const r3 = await readSettings(mockCtx({ whatsappFrom: "invalid" }), "c1");
    expect(r3.whatsappFrom).toBeNull();
  });
});

describe("Telephony Settings: public base URL", async () => {
  const { readSettings, saveSettings, validatePublicBaseUrl } = await import("../src/settings.js");
  const { vi } = await import("vitest");

  function ctxWith(config: Record<string, unknown>, state: Record<string, unknown> | null = null) {
    const store = new Map<string, unknown>();
    return {
      config: { get: vi.fn().mockResolvedValue(config) },
      state: {
        get: vi.fn(async () => state ?? store.get("s") ?? null),
        set: vi.fn(async (_k: unknown, v: unknown) => { store.set("s", v); }),
      },
      secrets: { resolve: vi.fn() },
    } as any;
  }

  it("defaults to null and accepts only a plain http(s) origin", async () => {
    expect((await readSettings(ctxWith({}), "c1")).publicBaseUrl).toBeNull();
    expect((await readSettings(ctxWith({ publicBaseUrl: "https://paperclip.example.com/" }), "c1")).publicBaseUrl).toBe("https://paperclip.example.com");
    expect((await readSettings(ctxWith({ publicBaseUrl: "https://paperclip.example.com/PAR" }), "c1")).publicBaseUrl).toBeNull();
    expect(validatePublicBaseUrl("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100");
    expect(validatePublicBaseUrl("https://user:pw@host")).toBeNull();
    expect(validatePublicBaseUrl("https://host/?q=1")).toBeNull();
    expect(validatePublicBaseUrl(42)).toBeNull();
  });

  it("save stores the origin, clears on empty, and refuses a path", async () => {
    const ctx = ctxWith({});
    const ok = await saveSettings(ctx, "c1", { publicBaseUrl: "https://paperclip.example.com/" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.settings.publicBaseUrl).toBe("https://paperclip.example.com");
    const cleared = await saveSettings(ctx, "c1", { publicBaseUrl: "" });
    if (cleared.ok) expect(cleared.settings.publicBaseUrl).toBeNull();
    const bad = await saveSettings(ctx, "c1", { publicBaseUrl: "https://paperclip.example.com/dialer" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.publicBaseUrl).toMatch(/origin/);
  });
});

describe("Telephony Settings: numbers list", async () => {
  const { readSettings, saveSettings, withSeededNumbers } = await import("../src/settings.js");
  const { vi } = await import("vitest");
  const ZA = { e164: "+27105550100", label: "PiB Cape Town", regions: ["27"], purposes: ["voice" as const], enabled: true, isDefault: true };

  function ctxWith(config: Record<string, unknown>, secrets: Record<string, string> = {}) {
    const store = new Map<string, unknown>();
    return {
      config: { get: vi.fn().mockResolvedValue(config) },
      state: { get: vi.fn(async () => store.get("s") ?? null), set: vi.fn(async (_k: unknown, v: unknown) => { store.set("s", v); }) },
      secrets: { resolve: vi.fn(async (name: string) => { if (secrets[name]) return secrets[name]; throw new Error("not set"); }) },
      store,
    } as any;
  }

  it("reads a saved list as source settings", async () => {
    const s = await readSettings(ctxWith({ numbers: [ZA] }), "c1");
    expect(s.numbers).toEqual([ZA]);
    expect(s.numbersSource).toBe("settings");
  });

  it("readSettings never reads secrets; withSeededNumbers fills an empty list from the old secrets", async () => {
    const ctx = ctxWith({}, { TWILIO_US_NUMBER: "+12025550100" });
    const plain = await readSettings(ctx, "c1");
    expect(plain.numbers).toEqual([]);
    expect(plain.numbersSource).toBe("none");
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    const seeded = await withSeededNumbers(ctx, "c1", plain);
    expect(seeded.numbersSource).toBe("secrets");
    expect(seeded.numbers[0]).toMatchObject({ e164: "+12025550100", regions: ["1"], isDefault: true });
    const none = await withSeededNumbers(ctxWith({}), "c1", plain);
    expect(none.numbers).toEqual([]);
    expect(none.numbersSource).toBe("none");
    const kept = await withSeededNumbers(ctx, "c1", { ...plain, numbers: [ZA], numbersSource: "settings" });
    expect(kept.numbers).toEqual([ZA]);
  });

  it("save validates the list, keeps one default, and stops reading the secrets afterwards", async () => {
    const ctx = ctxWith({}, { TWILIO_US_NUMBER: "+12025550100" });
    const bad = await saveSettings(ctx, "c1", { numbers: [{ e164: "nope", purposes: ["voice"] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.numbers).toMatch(/Number 1: not an E.164/);
    const ok = await saveSettings(ctx, "c1", { numbers: [ZA, { ...ZA, e164: "+12025550101", label: "US", regions: ["US"], isDefault: true }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.settings.numbers.map((n) => [n.e164, n.regions[0], n.isDefault])).toEqual([["+27105550100", "27", true], ["+12025550101", "1", false]]);
      expect(ok.settings.numbersSource).toBe("settings");
    }
    expect("numbersSource" in (ctx.store.get("s") as object)).toBe(false);
    const again = await withSeededNumbers(ctx, "c1", await readSettings(ctx, "c1"));
    expect(again.numbersSource).toBe("settings");
    expect(again.numbers).toHaveLength(2);
  });
});
