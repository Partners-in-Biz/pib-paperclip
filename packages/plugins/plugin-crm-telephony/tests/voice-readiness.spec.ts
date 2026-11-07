import { describe, expect, it } from "vitest";
import { describeVoiceReadiness, voiceWebhookUrls, VOICE_REQUIRED_SECRETS } from "../src/voice-readiness.js";
import { PLUGIN_ID } from "../src/namespace.js";
import type { SecretStatus, TelephonySettings } from "../src/settings.js";

const settings: TelephonySettings = {
  recordingEnabled: false, whatsappEnabled: false, smsEnabled: false,
  maxCallsPerDay: 50, maxSmsPerDay: 200, maxWhatsappPerDay: 200, recordingRetentionDays: 30,
  allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
  callerIds: [], voiceAllowedUserIds: ["user-1"], usSmsCampaignStatus: "none", usMessagingServiceSid: null,
  whatsappFrom: null, smsHolidays: [], publicBaseUrl: "https://paperclip.example.com",
  numbers: [{ e164: "+27105550100", label: "PiB Cape Town", regions: ["27"], purposes: ["voice", "sms"], enabled: true, isDefault: true }],
  numbersSource: "settings",
};

const allSet: SecretStatus = Object.fromEntries([...VOICE_REQUIRED_SECRETS].map((n) => [n, "set"]));

describe("describeVoiceReadiness", () => {
  it("is ready with the four secrets, one number, a base URL and a voice user", () => {
    const r = describeVoiceReadiness(allSet, settings, false);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.missingSecrets).toEqual([]);
    expect(r.numbers).toMatchObject({ total: 1, enabled: 1, voice: 1, whatsapp: 0, defaultE164: "+27105550100", voiceRegions: ["27"], source: "settings" });
    expect(r.notes).toEqual([]);
    expect(r.twimlApp).toBe("missing");
    expect(r.webhooks?.callStatus).toBe(`https://paperclip.example.com/api/plugins/${PLUGIN_ID}/webhooks/call-status`);
  });

  it("names every missing secret and the missing number", () => {
    const r = describeVoiceReadiness({ TWILIO_ACCOUNT_SID: "set", TWILIO_AUTH_TOKEN: "set" }, settings, false);
    expect(r.ready).toBe(false);
    expect(r.missingSecrets).toEqual(["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]);
    expect(r.blockers[0]).toContain("TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET");
    expect(r.blockers.some((b) => b.includes("TWILIO_ZA_NUMBER"))).toBe(false);
  });

  it("blocks when no enabled voice number exists, and notes a list still seeded from the old secrets", () => {
    const none = describeVoiceReadiness(allSet, { ...settings, numbers: [], numbersSource: "none" }, false);
    expect(none.ready).toBe(false);
    expect(none.blockers.some((b) => /Numbers on this page/.test(b))).toBe(true);
    const smsOnly = describeVoiceReadiness(allSet, { ...settings, numbers: [{ ...settings.numbers[0], purposes: ["sms"] }] }, false);
    expect(smsOnly.numbers.voice).toBe(0);
    expect(smsOnly.ready).toBe(false);
    const seeded = describeVoiceReadiness(allSet, { ...settings, numbersSource: "secrets" }, false);
    expect(seeded.ready).toBe(true);
    expect(seeded.notes[0]).toMatch(/old secrets/);
    expect(seeded.numbers.lines[0]).toContain("PiB Cape Town +27105550100 (+27; voice, sms; default)");
  });

  it("blocks on a missing base URL and on no voice users", () => {
    const r = describeVoiceReadiness(allSet, { ...settings, publicBaseUrl: null, voiceAllowedUserIds: [] }, false);
    expect(r.ready).toBe(false);
    expect(r.webhooks).toBeNull();
    expect(r.blockers.some((b) => /public base URL/i.test(b))).toBe(true);
    expect(r.blockers.some((b) => /Voice user IDs/.test(b))).toBe(true);
  });

  it("recording is active only when switched on and R2 is filled in", () => {
    expect(describeVoiceReadiness(allSet, { ...settings, recordingEnabled: true }, false).recording).toEqual({ enabled: true, r2Configured: false, active: false });
    expect(describeVoiceReadiness(allSet, { ...settings, recordingEnabled: true }, true).recording.active).toBe(true);
    expect(describeVoiceReadiness(allSet, settings, true).recording.active).toBe(false);
  });

  it("webhook URLs use the public webhook path for each endpoint", () => {
    const urls = voiceWebhookUrls("https://paperclip.example.com/");
    expect(urls.recordingStatus).toBe(`https://paperclip.example.com/api/plugins/${PLUGIN_ID}/webhooks/recording-status`);
    expect(urls.voiceTwiml).toBe(`https://paperclip.example.com/api/plugins/${PLUGIN_ID}/webhooks/voice-twiml`);
  });
});
