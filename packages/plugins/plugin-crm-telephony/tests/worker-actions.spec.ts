import { describe, it, expect, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

describe("Telephony worker actions", () => {
  let h: ReturnType<typeof createTestHarness>;

  beforeEach(async () => {
    h = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(h.ctx);
  });

  it("get returns defaults when no settings are saved", async () => {
    const result = (await h.performAction("telephony.settings.get", {}, { companyId: "co-1", actor: { type: "user" } })) as any;
    expect(result.settings).toMatchObject(DEFAULT_SETTINGS);
  });

  it("get reports secret presence without returning values", async () => {
    const result: any = await h.performAction("telephony.settings.get", {}, { companyId: "co-1", actor: { type: "user" } });
    expect(result.secretPresence).toBeDefined();
    expect(result.secretPresence).toBeInstanceOf(Array);
    expect(result.secretPresence[0]).toHaveProperty("key");
    expect(result.secretPresence[0]).toHaveProperty("set");
    expect(typeof result.secretPresence[0].set).toBe("boolean");
  });

  it("save rejects invalid input without writing", async () => {
    const result: any = await h.performAction(
      "telephony.settings.save",
      { caps: { callsPerDay: 50000 } }, // Over limit
      { companyId: "co-1", actor: { type: "user" } },
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "caps.callsPerDay" }));

    // Verify nothing was saved
    const getResult = (await h.performAction("telephony.settings.get", {}, { companyId: "co-1", actor: { type: "user" } })) as any;
    expect(getResult.settings).toMatchObject(DEFAULT_SETTINGS);
  });

  it("save valid settings atomically", async () => {
    const input = {
      recordingEnabled: true,
      allowedHours: { monday: { start: "09:00", end: "17:00" } },
      callerIds: { za: "+27123456789" },
      caps: { callsPerDay: 100, messagesPerDay: 150 },
      allowlistUserIds: ["u1", "u2"],
      tenDlcStatus: "approved",
    };
    const saveResult: any = await h.performAction("telephony.settings.save", input, { companyId: "co-1", actor: { type: "user" } });
    expect(saveResult.ok).toBe(true);

    const getResult: any = await h.performAction("telephony.settings.get", {}, { companyId: "co-1", actor: { type: "user" } });
    expect(getResult.settings).toMatchObject(input);
  });

  it("sync-templates sets timestamp without overwriting settings", async () => {
    const settings = { recordingEnabled: true, caps: { callsPerDay: 75, messagesPerDay: 200 } };
    const saveResult: any = await h.performAction("telephony.settings.save", settings, { companyId: "co-1", actor: { type: "user" } });
    expect(saveResult.ok).toBe(true);

    const syncResult: any = await h.performAction("telephony.settings.sync-templates", {}, { companyId: "co-1", actor: { type: "user" } });
    expect(syncResult.ok).toBe(true);
    expect(syncResult.syncRequestedAt).toBeDefined();

    const getResult: any = await h.performAction("telephony.settings.get", {}, { companyId: "co-1", actor: { type: "user" } });
    expect(getResult.settings.recordingEnabled).toBe(true);
    expect(getResult.settings.caps.callsPerDay).toBe(75);
  });

  it("requires company ID", async () => {
    await expect(h.performAction("telephony.settings.get", {}, { actor: { type: "user" } })).rejects.toThrow(/Company is required/);
  });
});
