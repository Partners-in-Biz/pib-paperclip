import { describe, it, expect } from "vitest";
import { toFormState, toSavePayload, describeSecretStatus, SECRET_LABELS } from "../src/ui/settings-form.js";
import type { TelephonySettings } from "../src/settings.js";

const baseSettings: TelephonySettings = {
  recordingEnabled: true, smsEnabled: false, whatsappEnabled: true,
  maxCallsPerDay: 50, maxSmsPerDay: 100, maxWhatsappPerDay: 75, recordingRetentionDays: 30,
  allowedHours: { start: "09:00", end: "17:00", timezone: "Africa/Johannesburg" },
  callerIds: ["+27123456789"], voiceAllowedUserIds: ["user1"], usSmsCampaignStatus: "approved",
  usMessagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxx", whatsappFrom: "wa_id", smsHolidays: ["2026-12-25"],
};

describe("Settings form utilities", () => {
  it.each([
    ["booleans", (f: any) => [f.recordingEnabled, f.smsEnabled, f.whatsappEnabled], [true, false, true]],
    ["number strings", (f: any) => [f.maxCallsPerDay, f.maxSmsPerDay], ["50", "100"]],
    ["hours", (f: any) => [f.allowedHoursStart, f.allowedHoursEnd], ["09:00", "17:00"]],
    ["arrays as newline", (f: any) => f.callerIds, "+27123456789"],
    ["null as empty", (f: any) => f.whatsappFrom, "wa_id"],
  ] as const)("toFormState converts %s", (_, selector, expected) => {
    const form = toFormState(baseSettings);
    expect(selector(form)).toEqual(expected);
  });

  it("toFormState handles null optional fields", () => {
    const form = toFormState({ ...baseSettings, whatsappFrom: null, usMessagingServiceSid: null });
    expect(form.whatsappFrom).toBe("");
    expect(form.usMessagingServiceSid).toBe("");
  });

  it.each([
    ["recordingEnabled", true],
    ["smsEnabled", false],
    ["maxCallsPerDay", 50],
    ["usSmsCampaignStatus", "approved"],
  ])("toSavePayload preserves %s", (key, value) => {
    const form = toFormState(baseSettings);
    const result = toSavePayload(form);
    expect(result.payload).toBeDefined();
    expect(result.payload?.[key as keyof typeof result.payload]).toBe(value);
  });

  it("toSavePayload parses lines and nulls empties", () => {
    const form = toFormState(baseSettings);
    form.callerIds = "  +27123  \n\n+27987  ";
    form.whatsappFrom = "   ";
    const result = toSavePayload(form);
    expect(result.payload).toBeDefined();
    expect(result.payload?.callerIds).toEqual(["+27123", "+27987"]);
    expect(result.payload?.whatsappFrom).toBeNull();
  });

  it("toSavePayload round-trips correctly", () => {
    const form = toFormState(baseSettings);
    const result = toSavePayload(form);
    expect(result.payload).toBeDefined();
    expect(result.payload?.maxCallsPerDay).toBe(50);
    expect(result.payload?.callerIds).toEqual(["+27123456789"]);
    expect(result.payload?.voiceAllowedUserIds).toEqual(["user1"]);
  });

  it("describeSecretStatus has all 12 secrets including ANTHROPIC_API_KEY", () => {
    const rows = describeSecretStatus({});
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.name)).toContain("ANTHROPIC_API_KEY");
    expect(rows.every((r) => r.status === "missing")).toBe(true);
  });

  it.each([["TWILIO_ACCOUNT_SID"], ["DEEPGRAM_API_KEY"], ["ANTHROPIC_API_KEY"]] as const)("describeSecretStatus describes %s", (name) => {
    const rows = describeSecretStatus({ [name]: "set" });
    const row = rows.find((r) => r.name === name);
    expect(row).toMatchObject({ name, label: SECRET_LABELS[name], status: "set" });
  });

  it("toSavePayload returns error when maxCallsPerDay is blank", () => {
    const form = toFormState(baseSettings);
    form.maxCallsPerDay = "";
    const result = toSavePayload(form);
    expect(result.errors).toBeDefined();
    expect(result.errors?.maxCallsPerDay).toBe("Required");
    expect(result.payload).toBeUndefined();
  });

  it("toSavePayload returns error when maxCallsPerDay is non-numeric", () => {
    const form = toFormState(baseSettings);
    form.maxCallsPerDay = "abc";
    const result = toSavePayload(form);
    expect(result.errors).toBeDefined();
    expect(result.errors?.maxCallsPerDay).toBe("Enter a number");
    expect(result.payload).toBeUndefined();
  });

  it("toSavePayload returns valid payload with numeric caps", () => {
    const form = toFormState(baseSettings);
    form.maxCallsPerDay = "123";
    const result = toSavePayload(form);
    expect(result.payload).toBeDefined();
    expect(result.errors).toBeUndefined();
    expect(result.payload?.maxCallsPerDay).toBe(123);
  });
});
