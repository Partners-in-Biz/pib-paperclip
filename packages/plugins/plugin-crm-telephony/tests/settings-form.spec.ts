import { describe, it, expect } from "vitest";
import { toFormState, toSavePayload, validateForm, describeSecretStatus, SECRET_LABELS } from "../src/ui/settings-form.js";
import type { TelephonySettings } from "../src/settings.js";

const baseSettings: TelephonySettings = {
  recordingEnabled: true, smsEnabled: false, whatsappEnabled: true,
  maxCallsPerDay: 50, maxSmsPerDay: 100, maxWhatsappPerDay: 75, recordingRetentionDays: 30,
  allowedHours: { start: "09:00", end: "17:00", timezone: "Africa/Johannesburg" },
  callerIds: ["+27123456789"], voiceAllowedUserIds: ["user1"], usSmsCampaignStatus: "approved",
  usMessagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxx", whatsappFrom: "wa_id", smsHolidays: ["2026-12-25"],
  publicBaseUrl: null,
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
    const payload = toSavePayload(form);
    expect(payload[key as keyof typeof payload]).toBe(value);
  });

  it("toSavePayload parses lines and nulls empties", () => {
    const form = toFormState(baseSettings);
    form.callerIds = "  +27123  \n\n+27987  ";
    form.whatsappFrom = "   ";
    const payload = toSavePayload(form);
    expect(payload.callerIds).toEqual(["+27123", "+27987"]);
    expect(payload.whatsappFrom).toBeNull();
  });

  it("toSavePayload round-trips correctly", () => {
    const form = toFormState(baseSettings);
    const payload = toSavePayload(form);
    expect(payload.maxCallsPerDay).toBe(50);
    expect(payload.callerIds).toEqual(["+27123456789"]);
    expect(payload.voiceAllowedUserIds).toEqual(["user1"]);
  });

  it("blank numeric inputs stay undefined in the payload, never 0", () => {
    const form = { ...toFormState(baseSettings), maxCallsPerDay: "", maxSmsPerDay: "  ", recordingRetentionDays: "" };
    const payload = toSavePayload(form);
    expect(payload.maxCallsPerDay).toBeUndefined();
    expect(payload.maxSmsPerDay).toBeUndefined();
    expect(payload.recordingRetentionDays).toBeUndefined();
    expect(payload.maxWhatsappPerDay).toBe(75);
  });

  it("validateForm accepts the base settings", () => {
    expect(validateForm(toFormState(baseSettings))).toEqual({});
  });

  it.each([
    ["blank", "", "Required"],
    ["zero", "0", "Must be a whole number 1-10000"],
    ["fraction", "2.5", "Must be a whole number 1-10000"],
    ["too large", "10001", "Must be a whole number 1-10000"],
    ["not a number", "abc", "Must be a whole number 1-10000"],
  ])("validateForm flags maxCallsPerDay %s", (_label, value, message) => {
    const errors = validateForm({ ...toFormState(baseSettings), maxCallsPerDay: value });
    expect(errors).toEqual({ maxCallsPerDay: message });
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
});

describe("Voice readiness on the settings page", async () => {
  const { publicOrigin, voiceWebhookRows, describeVoiceReadiness, TELEPHONY_PLUGIN_ID } = await import("../src/ui/settings-form.js");
  const { PLUGIN_ID } = await import("../src/namespace.js");

  it("keeps the browser-side plugin id equal to the worker's", () => {
    expect(TELEPHONY_PLUGIN_ID).toBe(PLUGIN_ID);
  });

  it("publicOrigin accepts a bare origin and rejects paths, queries and other schemes", () => {
    expect(publicOrigin(" https://paperclip.example.com/ ")).toBe("https://paperclip.example.com");
    expect(publicOrigin("http://localhost:3100")).toBe("http://localhost:3100");
    expect(publicOrigin("https://paperclip.example.com/PAR/dialer")).toBeNull();
    expect(publicOrigin("https://paperclip.example.com/?x=1")).toBeNull();
    expect(publicOrigin("ftp://host")).toBeNull();
    expect(publicOrigin("not a url")).toBeNull();
    expect(publicOrigin("")).toBeNull();
  });

  it("the form carries the public base URL both ways and validates it", () => {
    const form = toFormState({ ...baseSettings, publicBaseUrl: "https://paperclip.example.com" });
    expect(form.publicBaseUrl).toBe("https://paperclip.example.com");
    expect(toSavePayload(form).publicBaseUrl).toBe("https://paperclip.example.com");
    expect(toSavePayload({ ...form, publicBaseUrl: "  " }).publicBaseUrl).toBeNull();
    expect(validateForm({ ...form, publicBaseUrl: "https://x.example.com/path" }).publicBaseUrl).toMatch(/no path/);
    expect(validateForm(form).publicBaseUrl).toBeUndefined();
  });

  it("lists the three webhook addresses for an origin", () => {
    const rows = voiceWebhookRows("https://paperclip.example.com");
    expect(rows.map((r) => r.key)).toEqual(["call-status", "recording-status", "voice-twiml"]);
    expect(rows[0].url).toBe(`https://paperclip.example.com/api/plugins/${PLUGIN_ID}/webhooks/call-status`);
    expect(rows[2].note).toMatch(/Not used/);
  });

  it("builds the readiness checklist from the worker's view", () => {
    const voice = {
      ready: false, missingSecrets: ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"], numbers: { za: "set", us: "missing" } as const, twimlApp: "missing" as const,
      publicBaseUrl: null, recording: { enabled: true, r2Configured: false, active: false }, voiceUsers: 0, blockers: ["x"],
    };
    const rows = describeVoiceReadiness(voice, { TWILIO_ACCOUNT_SID: "set", TWILIO_AUTH_TOKEN: "set" });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel["Twilio Account SID (TWILIO_ACCOUNT_SID)"].status).toBe("set");
    expect(byLabel["Twilio API Key SID (TWILIO_API_KEY_SID)"].status).toBe("missing");
    expect(byLabel["Twilio number for +27 calls (TWILIO_ZA_NUMBER)"].status).toBe("set");
    expect(byLabel["Twilio number for +1 calls (TWILIO_US_NUMBER)"]).toMatchObject({ status: "missing", hint: expect.stringContaining("Optional") });
    expect(byLabel["TwiML app SID (TWILIO_TWIML_APP_SID)"].status).toBe("optional");
    expect(byLabel["Public base URL"].status).toBe("missing");
    expect(byLabel["Voice user IDs"].status).toBe("missing");
    expect(byLabel["Recording"]).toMatchObject({ status: "missing", hint: expect.stringContaining("R2") });
  });
});
