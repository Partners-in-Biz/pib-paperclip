import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings, secretStatus } from "../src/settings.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

describe("Telephony settings validation and normalization", () => {
  it("defaults are valid", () => {
    const errors = validateSettings(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
    expect(errors).toHaveLength(0);
  });

  it("normalizes valid input", () => {
    const raw = {
      recordingEnabled: true,
      allowedHours: { monday: { start: "08:00", end: "20:00" } },
      callerIds: { za: "+27123456789", us: "+11234567890" },
      caps: { callsPerDay: 100, messagesPerDay: 300 },
      allowlistUserIds: ["user1", "user2"],
      tenDlcStatus: "approved",
    };
    const normalized = normalizeSettings(raw);
    expect(normalized.recordingEnabled).toBe(true);
    expect(normalized.callerIds.za).toBe("+27123456789");
    expect(normalized.caps.callsPerDay).toBe(100);
    expect(normalized.tenDlcStatus).toBe("approved");
  });

  it("rejects invalid HH:MM times", () => {
    const raw = { allowedHours: { monday: { start: "25:00", end: "20:00" } } };
    const errors = validateSettings(raw);
    expect(errors.some((e) => e.field.includes("start"))).toBe(true);
  });

  it("rejects invalid E.164 caller IDs", () => {
    const raw = { callerIds: { za: "27123456789" } }; // Missing +
    const errors = validateSettings(raw);
    expect(errors.some((e) => e.field.includes("callerIds"))).toBe(true);
  });

  it("rejects caps out of range", () => {
    const raw = { caps: { callsPerDay: 50000, messagesPerDay: 100 } };
    const errors = validateSettings(raw);
    expect(errors.some((e) => e.field.includes("callsPerDay"))).toBe(true);
  });

  it("rejects start >= end times", () => {
    const raw = { allowedHours: { monday: { start: "20:00", end: "08:00" } } };
    const errors = validateSettings(raw);
    expect(errors.some((e) => e.field === "allowedHours.monday")).toBe(true);
  });

  it("deduplicates and trims allowlist user IDs", () => {
    const raw = { allowlistUserIds: ["user1", "user1", " user2 "] };
    const normalized = normalizeSettings(raw);
    expect(normalized.allowlistUserIds).toEqual(["user1", "user2"]);
  });

  it("defaults tenDlcStatus to unknown", () => {
    const raw = { tenDlcStatus: "invalid" };
    const normalized = normalizeSettings(raw);
    expect(normalized.tenDlcStatus).toBe("unknown");
  });

  it("preserves valid status values", () => {
    for (const status of ["not_started", "pending", "approved", "rejected"]) {
      const raw = { tenDlcStatus: status };
      const normalized = normalizeSettings(raw);
      expect(normalized.tenDlcStatus).toBe(status);
    }
  });
});

describe("Secret status resolution", () => {
  const mockCtx = (resolveMap: Record<string, string | null> = {}) => ({
    secrets: {
      resolve: vi.fn(async (ref: string) => {
        if (ref in resolveMap) {
          const val = resolveMap[ref];
          if (val === null) throw new Error("not found");
          return val;
        }
        throw new Error("not found");
      }),
    },
  } as unknown as PluginContext);

  it("returns 'set' for resolved secrets", async () => {
    const ctx = mockCtx({ TWILIO_ACCOUNT_SID: "ACxxxxxxxx" });
    const status = await secretStatus(ctx, "c1", ["TWILIO_ACCOUNT_SID"]);
    expect(status).toEqual({ TWILIO_ACCOUNT_SID: "set" });
  });

  it("returns 'missing' for unresolved secrets", async () => {
    const ctx = mockCtx({});
    const status = await secretStatus(ctx, "c1", ["TWILIO_AUTH_TOKEN"]);
    expect(status).toEqual({ TWILIO_AUTH_TOKEN: "missing" });
  });

  it("returns 'missing' when resolve throws", async () => {
    const ctx = mockCtx({ TWILIO_ACCOUNT_SID: null });
    const status = await secretStatus(ctx, "c1", ["TWILIO_ACCOUNT_SID"]);
    expect(status).toEqual({ TWILIO_ACCOUNT_SID: "missing" });
  });

  it("handles multiple refs", async () => {
    const ctx = mockCtx({ TWILIO_ACCOUNT_SID: "ACxxxxxxxx" });
    const status = await secretStatus(ctx, "c1", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
    expect(status).toEqual({ TWILIO_ACCOUNT_SID: "set", TWILIO_AUTH_TOKEN: "missing" });
  });

  it("never returns secret values, only presence", async () => {
    const ctx = mockCtx({ TWILIO_API_KEY_SID: "SKsuperSecret123" });
    const status = await secretStatus(ctx, "c1", ["TWILIO_API_KEY_SID"]);
    expect(status.TWILIO_API_KEY_SID).toBe("set");
    expect(JSON.stringify(status)).not.toMatch(/superSecret/);
  });
});
