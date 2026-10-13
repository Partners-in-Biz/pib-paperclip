import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings } from "../src/settings.js";

describe("Telephony settings", () => {
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
