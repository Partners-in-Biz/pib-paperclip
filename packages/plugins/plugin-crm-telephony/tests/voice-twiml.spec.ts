import { describe, it, expect } from "vitest";
import { decideRecording, buildVoiceTwiml } from "../src/voice-twiml.js";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

describe("decideRecording", () => {
  it("ignores client ContactId; normalizes To", async () => {
    const res = await decideRecording({ lookup: async () => ["contact1"], prefs: async () => [{ do_not_record: false, erased_at: null }] }, "company1", "27821234567");
    expect(res.toE164).toBe("+27821234567");
    expect(res.record).toBe(true);
  });

  it("returns invalid for malformed number", async () => {
    const res = await decideRecording({ lookup: async () => [], prefs: async () => [] }, "company1", "not-a-number");
    expect(res.toE164).toBeNull();
    expect(res.record).toBe(false);
  });

  it("returns no-record for unknown number", async () => {
    const res = await decideRecording({ lookup: async () => [], prefs: async () => [] }, "company1", "+27821234567");
    expect(res.record).toBe(false);
    expect(res.reason).toBe("unknown_number");
  });

  it("returns no-record if ANY contact has do_not_record=true", async () => {
    const res = await decideRecording(
      { lookup: async () => ["c1", "c2"], prefs: async () => [{ do_not_record: false, erased_at: null }, { do_not_record: true, erased_at: null }] },
      "company1",
      "+27821234567",
    );
    expect(res.record).toBe(false);
  });

  it("returns no-record if ANY contact is erased", async () => {
    const res = await decideRecording(
      { lookup: async () => ["c1", "c2"], prefs: async () => [{ do_not_record: false, erased_at: null }, { do_not_record: false, erased_at: "2024-01-01T00:00:00Z" }] },
      "company1",
      "+27821234567",
    );
    expect(res.record).toBe(false);
  });

  it("returns record=true for known number with no DNR", async () => {
    const res = await decideRecording({ lookup: async () => ["contact1"], prefs: async () => [{ do_not_record: false, erased_at: null }] }, "company1", "+27821234567");
    expect(res.record).toBe(true);
    expect(res.reason).toBe("allowed");
  });

  it("returns no-record on lookup error (fail closed)", async () => {
    const res = await decideRecording({ lookup: async () => { throw new Error("DB"); }, prefs: async () => [] }, "company1", "+27821234567");
    expect(res.record).toBe(false);
  });

  it("returns no-record on prefs error (fail closed)", async () => {
    const res = await decideRecording({ lookup: async () => ["c1"], prefs: async () => { throw new Error("DB"); } }, "company1", "+27821234567");
    expect(res.record).toBe(false);
  });
});

describe("buildVoiceTwiml", () => {
  it("returns Reject for null number", () => {
    const xml = buildVoiceTwiml({ toE164: null, callerId: "+27821234567", record: false, xmlEscape });
    expect(xml).toBe("<Response><Reject/></Response>");
  });

  it("builds Dial with record and notice URL", () => {
    const xml = buildVoiceTwiml({
      toE164: "+27821234567",
      callerId: "+27829999999",
      record: true,
      noticeUrl: "https://example.com/notice",
      recordingStatusUrl: "https://example.com/status",
      xmlEscape,
    });
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('url="https://example.com/notice"');
    expect(xml).toContain("recordingStatusCallback=");
  });

  it("builds plain Dial without record", () => {
    const xml = buildVoiceTwiml({ toE164: "+27821234567", callerId: "+27829999999", record: false, xmlEscape });
    expect(xml).not.toContain("record=");
    expect(xml).toContain("<Dial");
  });

  it("escapes special characters in attributes", () => {
    const xml = buildVoiceTwiml({ toE164: "+27821234567", callerId: 'test"value&<>', record: false, xmlEscape });
    expect(xml).toContain("test&quot;value&amp;&lt;&gt;");
  });
});
