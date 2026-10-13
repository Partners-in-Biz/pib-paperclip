import { describe, expect, it } from "vitest";
import { boot, CO, contact, seed } from "./helpers/crm.js";
import { buildCallNoteBody, parseCallNoted } from "../src/call-noted.js";

const TELEPHONY_PLUGIN_ID = "partnersinbiz.crm-telephony";
const CALL_NOTED_EVENT = "call.noted";

describe("call-noted", () => {
  describe("parseCallNoted", () => {
    it("parses valid call.noted payload", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Discussed pricing",
        nextActions: ["Send quote", "Follow up Monday"],
        transcript: "Customer: Hello... Agent: Hi there!",
        durationSec: 300,
        recordingUrl: "https://example.com/recording.mp3",
        language: "en",
      };
      const parsed = parseCallNoted(payload);
      expect(parsed).toEqual(payload);
    });

    it("accepts null summary", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: null,
        nextActions: [],
        transcript: "Customer called",
        durationSec: 120,
        recordingUrl: null,
        language: "en",
      };
      const parsed = parseCallNoted(payload);
      expect(parsed).toEqual(payload);
    });

    it("rejects malformed payload (missing required fields)", () => {
      expect(parseCallNoted({})).toBeNull();
      expect(parseCallNoted({ companyId: CO })).toBeNull();
      expect(parseCallNoted({ companyId: CO, contactId: "ada" })).toBeNull();
      expect(parseCallNoted({ companyId: CO, contactId: "ada", callSid: "call-123" })).not.toBeNull();
    });

    it("filters invalid nextActions and converts to array", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Test",
        nextActions: ["Valid", 123, null, "Also valid"],
        transcript: "Test",
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };
      const parsed = parseCallNoted(payload);
      expect(parsed?.nextActions).toEqual(["Valid", "Also valid"]);
    });

    it("handles missing nextActions as empty array", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Test",
        transcript: "Test",
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };
      const parsed = parseCallNoted(payload);
      expect(parsed?.nextActions).toEqual([]);
    });
  });

  describe("buildCallNoteBody", () => {
    it("uses summary when present", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Discussed requirements and pricing",
        nextActions: ["Send proposal", "Schedule follow-up"],
        transcript: "Long transcript that should be ignored",
        durationSec: 300,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body).toContain("Discussed requirements and pricing");
      expect(body).toContain("Next actions:");
      expect(body).toContain("• Send proposal");
      expect(body).toContain("• Schedule follow-up");
      expect(body).not.toContain("Long transcript");
    });

    it("falls back to truncated transcript when summary is null", () => {
      const longTranscript = "A".repeat(5000);
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: null,
        nextActions: [],
        transcript: longTranscript,
        durationSec: 300,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body.length).toBeLessThanOrEqual(4000);
      expect(body).toMatch(/…$/);
    });

    it("uses full transcript when shorter than 4000 chars", () => {
      const shortTranscript = "Customer asked about pricing. Agent explained the packages.";
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: null,
        nextActions: [],
        transcript: shortTranscript,
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body).toEqual(shortTranscript);
    });

    it("includes next actions as bullet list", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Discussed next steps",
        nextActions: ["Email contract", "Follow up Friday", "Get sign-off"],
        transcript: "ignored",
        durationSec: 120,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body).toMatch(/Next actions:\n• Email contract\n• Follow up Friday\n• Get sign-off/);
    });

    it("filters empty next actions", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Test",
        nextActions: ["Valid action", "  ", "Another action"],
        transcript: "test",
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body).toContain("• Valid action");
      expect(body).toContain("• Another action");
      expect(body).not.toMatch(/•\s+$/);
    });

    it("returns empty string when no summary, transcript, or actions", () => {
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: null,
        nextActions: [],
        transcript: "",
        durationSec: 0,
        recordingUrl: null,
        language: "en",
      };
      const body = buildCallNoteBody(payload);
      expect(body).toBe("");
    });
  });

  describe("call.noted event handling", () => {
    it("creates activity on call.noted event and emits ack with activityId", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"] })];
      const { harness, emit, store } = await boot({ store: storeData });

      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "Quick sync call",
        nextActions: ["Send update"],
        transcript: "Discussed project status",
        durationSec: 600,
        recordingUrl: "https://example.com/rec.mp3",
        language: "en",
      };

      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });

      // Activity should be created
      const activities = store.activities!.filter((a) => a.kind === "call");
      expect(activities).toHaveLength(1);
      expect(activities[0]?.body).toContain("Quick sync call");
      expect(activities[0]?.meta).toMatchObject({
        callSid: "call-123",
        durationSec: 600,
        source: "telephony",
      });

      // Ack event should be emitted with activityId
      expect(emit).toHaveBeenCalledWith("activity.logged", CO, expect.objectContaining({
        companyId: CO,
        sourceKey: "telephony:call:call-123",
        activityId: activities[0]?.id,
      }));
    });

    it("replays same callSid idempotently and still emits ack", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [contact("ada", "Ada Lovelace")];
      const { harness, emit, store } = await boot({ store: storeData });

      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: "First call",
        nextActions: [],
        transcript: "Test",
        durationSec: 300,
        recordingUrl: null,
        language: "en",
      };

      // First emit
      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });
      const firstActivities = store.activities!.filter((a) => a.kind === "call");
      expect(firstActivities).toHaveLength(1);
      const firstActivityId = firstActivities[0]?.id;

      emit.mockClear();

      // Second emit (replay)
      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });
      const secondActivities = store.activities!.filter((a) => a.kind === "call");
      expect(secondActivities).toHaveLength(1); // Still only one
      expect(secondActivities[0]?.id).toBe(firstActivityId);

      // Ack should still be emitted
      expect(emit).toHaveBeenCalledWith("activity.logged", CO, expect.objectContaining({
        activityId: firstActivityId,
      }));
    });

    it("skips event when contact does not exist", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [];
      const { harness, emit, store } = await boot({ store: storeData });

      const payload = {
        companyId: CO,
        contactId: "nonexistent",
        callSid: "call-123",
        summary: "Test",
        nextActions: [],
        transcript: "Test",
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };

      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });

      // No activity should be created
      const activities = store.activities!.filter((a) => a.kind === "call");
      expect(activities).toHaveLength(0);

      // No ack should be emitted
      expect(emit).not.toHaveBeenCalledWith("activity.logged", expect.anything(), expect.anything());
    });

    it("skips event when company ID mismatches", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [contact("ada", "Ada Lovelace")];
      const { harness, emit, store } = await boot({ store: storeData });

      const payload = {
        companyId: "different-company",
        contactId: "ada",
        callSid: "call-123",
        summary: "Test",
        nextActions: [],
        transcript: "Test",
        durationSec: 60,
        recordingUrl: null,
        language: "en",
      };

      // Event comes with CO company but payload says different
      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });

      // No activity should be created
      const activities = store.activities!.filter((a) => a.kind === "call");
      expect(activities).toHaveLength(0);

      // No ack should be emitted
      expect(emit).not.toHaveBeenCalledWith("activity.logged", expect.anything(), expect.anything());
    });

    it("uses truncated transcript when summary is null", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [contact("ada", "Ada Lovelace")];
      const { harness, store } = await boot({ store: storeData });

      const longTranscript = "Word ".repeat(1000); // ~5000 chars
      const payload = {
        companyId: CO,
        contactId: "ada",
        callSid: "call-123",
        summary: null,
        nextActions: [],
        transcript: longTranscript,
        durationSec: 300,
        recordingUrl: null,
        language: "en",
      };

      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, payload, { companyId: CO });

      const activities = store.activities!.filter((a) => a.kind === "call");
      expect(activities).toHaveLength(1);
      expect(activities[0]?.body.length).toBeLessThanOrEqual(4000);
      expect(activities[0]?.body).toMatch(/…$/);
    });

    it("ignores malformed payload gracefully", async () => {
      const storeData = { ...seed() };
      storeData.contacts = [contact("ada", "Ada Lovelace")];
      const { harness, emit, store } = await boot({ store: storeData });

      const malformed = {
        companyId: "incomplete",
        // Missing contactId and callSid
        transcript: "Test",
      };

      await harness.emit(`plugin.${TELEPHONY_PLUGIN_ID}.${CALL_NOTED_EVENT}`, malformed, { companyId: CO });

      // No activity should be created
      const activities = store.activities!.filter((a) => a.kind === "call");
      expect(activities).toHaveLength(0);

      // No ack should be emitted
      expect(emit).not.toHaveBeenCalledWith("activity.logged", expect.anything(), expect.anything());
    });
  });
});
