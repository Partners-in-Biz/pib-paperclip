import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { readSettings, secretStatus } from "../src/settings.js";

const CO = "co-test";

describe("Settings defaults", () => {
  it("all boolean switches default to false", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.recordingEnabled).toBe(false);
    expect(settings.whatsappEnabled).toBe(false);
    expect(settings.smsEnabled).toBe(false);
  });

  it("rate limits default correctly", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.maxCallsPerDay).toBe(50);
    expect(settings.maxMessagesPerDay).toBe(200);
  });

  it("allowedHours defaults are set", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.allowedHours.startHour).toBe(8);
    expect(settings.allowedHours.endHour).toBe(20);
    expect(settings.allowedHours.timezone).toBe("Africa/Johannesburg");
    expect(settings.allowedHours.days).toEqual(["mon", "tue", "wed", "thu", "fri", "sat"]);
  });

  it("caller IDs default to null", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.callerIds.za).toBeNull();
    expect(settings.callerIds.us).toBeNull();
  });

  it("rejects invalid caller IDs", async () => {
    const harness = createTestHarness({ manifest, config: { callerIds: { za: "invalid", us: "555-1234" } } });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.callerIds.za).toBeNull();
    expect(settings.callerIds.us).toBeNull();
  });

  it("accepts valid E.164 caller IDs", async () => {
    const harness = createTestHarness({ manifest, config: { callerIds: { za: "+27123456789", us: "+12025551234" } } });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.callerIds.za).toBe("+27123456789");
    expect(settings.callerIds.us).toBe("+12025551234");
  });

  it("clamps rate limits to valid ranges", async () => {
    const harness = createTestHarness({ manifest, config: { maxCallsPerDay: 99999, maxMessagesPerDay: 0 } });
    const settings = await readSettings(harness.ctx, CO);
    expect(settings.maxCallsPerDay).toBe(50); // Out of range, uses default
    expect(settings.maxMessagesPerDay).toBe(200); // Out of range, uses default
  });
});

describe("secretStatus", () => {
  it("returns only 'set' or 'missing' values", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    const status = await secretStatus(harness.ctx, CO, settings);
    const values = Object.values(status);
    for (const v of values) {
      expect(["set", "missing"]).toContain(v);
    }
  });

  it("never includes resolved secret values in output", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    const status = await secretStatus(harness.ctx, CO, settings);
    const stringified = JSON.stringify(status);
    // Check that no actual secret patterns appear (not just key names)
    expect(stringified).not.toMatch(/SK[0-9a-f]{32}/);
    expect(stringified).not.toMatch(/AC[0-9a-f]{32}/);
    // Verify status values are only "set" or "missing"
    for (const v of Object.values(status)) {
      expect(["set", "missing"]).toContain(v);
    }
  });

  it("reports all expected secret names", async () => {
    const harness = createTestHarness({ manifest });
    const settings = await readSettings(harness.ctx, CO);
    const status = await secretStatus(harness.ctx, CO, settings);
    const names = Object.keys(status);
    const expected = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_API_KEY_SID",
      "TWILIO_API_KEY_SECRET",
      "TWILIO_TWIML_APP_SID",
      "DEEPGRAM_API_KEY",
      "SMS_PROVIDER_API_KEY",
      "ANTHROPIC_API_KEY",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ];
    expect(names.sort()).toEqual(expected.sort());
  });
});

describe("telephony-status tool", () => {
  it("returns settings and secret status", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool<{ data: { settings: Record<string, unknown>; secretStatus: Record<string, unknown> } }>("telephony-status", {}, { companyId: CO, agentId: "agent-1" });
    expect(result.data).toBeDefined();
    expect(result.data.settings).toBeDefined();
    expect(result.data.secretStatus).toBeDefined();
    expect((result.data.settings as Record<string, unknown>).recordingEnabled).toBe(false);
    expect((result.data.settings as Record<string, unknown>).maxCallsPerDay).toBe(50);
  });

  it("never returns secret values", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool<{ data: { settings: Record<string, unknown>; secretStatus: Record<string, unknown> } }>("telephony-status", {}, { companyId: CO, agentId: "agent-1" });
    const stringified = JSON.stringify(result);
    expect(stringified).not.toMatch(/SK[0-9a-f]{32}/);
    expect(stringified).not.toMatch(/AC[0-9a-f]{32}/);
  });
});
