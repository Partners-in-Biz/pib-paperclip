import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTimeline, getTranscript, listUnmatched, setContactPrefs } from "../src/timeline.js";
import { writeAudit } from "../src/audit.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

let db: any;

const companyId1 = "company-1";
const companyId2 = "company-2";
const contactId = "contact-123";
const contactId2 = "contact-456";
const userId = "user-789";

describe("timeline", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  describe("getTimeline: merge and order", () => {
    it("merges calls and messages, sorted by timestamp descending", async () => {
      const callId = randomUUID();
      const msgId = randomUUID();

      const callSid = "call_001";
      const earlier = new Date("2025-01-01T10:00:00Z").toISOString();
      const later = new Date("2025-01-01T11:00:00Z").toISOString();

      // Insert call (earlier)
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+1234567890', '+0987654321', $5, 'completed', $6, true)`,
        [callId, companyId1, contactId, userId, callSid, earlier],
      );

      // Insert message (later)
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, provider_msg_id, contact_id, from_e164, to_e164, created_at, status)
         VALUES ($1, $2, 'sms', 'outbound', 'msg_001', $3, '+0987654321', '+1234567890', $4, 'sent')`,
        [msgId, companyId1, contactId, later],
      );

      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].type).toBe("message");
      expect(result.items[0].timestamp).toBe(later);
      expect(result.items[1].type).toBe("call");
      expect(result.items[1].timestamp).toBe(earlier);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await db.db.execute(
          `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
           VALUES ($1, $2, $3, $4, 'inbound', '+1234567890', '+0987654321', $5, 'completed', now() - interval '${i} minutes', false)`,
          [randomUUID(), companyId1, contactId, userId, `call_${i}`, false],
        );
      }

      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId, limit: 2 });
      expect(result.items).toHaveLength(2);
    });
  });

  describe("getTimeline: company isolation", () => {
    it("returns only items for the specified company", async () => {
      const callId1 = randomUUID();
      const callId2 = randomUUID();

      // Company 1 call
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+1111111111', '+2222222222', 'call_c1', 'completed', now(), true)`,
        [callId1, companyId1, contactId, userId, true],
      );

      // Company 2 call (same contact id)
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+3333333333', '+4444444444', 'call_c2', 'completed', now(), false)`,
        [callId2, companyId2, contactId, userId, false],
      );

      const result1 = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });
      expect(result1.items).toHaveLength(1);
      expect(result1.items[0].from).toBe("+1111111111");

      const result2 = await getTimeline(db.db, NAMESPACE, { companyId: companyId2, contactId });
      expect(result2.items).toHaveLength(1);
      expect(result2.items[0].from).toBe("+3333333333");
    });
  });

  describe("getTimeline: no secret columns", () => {
    it("does not expose twilio_url, r2_key, or lease_token", async () => {
      const callId = randomUUID();
      const callSid = "call_001";

      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+1234567890', '+0987654321', $5, 'completed', now(), true)`,
        [callId, companyId1, contactId, userId, callSid, true],
      );

      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });

      const json = JSON.stringify(result);
      expect(json).not.toContain("twilio_url");
      expect(json).not.toContain("r2_key");
      expect(json).not.toContain("lease_token");
      expect(json).not.toContain("call_sid");
    });
  });

  describe("getTimeline: contact prefs", () => {
    it("returns default prefs if no row exists", async () => {
      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });

      expect(result.contactPrefs).toEqual({
        do_not_record: false,
        language: "en",
      });
    });

    it("returns prefs from database, defaulting language to en", async () => {
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, do_not_record, language)
         VALUES ($1, $2, true, NULL)`,
        [companyId1, contactId],
      );

      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });

      expect(result.contactPrefs).toEqual({
        do_not_record: true,
        language: "en",
      });
    });

    it("returns custom language when set", async () => {
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, do_not_record, language)
         VALUES ($1, $2, false, 'af')`,
        [companyId1, contactId],
      );

      const result = await getTimeline(db.db, NAMESPACE, { companyId: companyId1, contactId });

      expect(result.contactPrefs).toEqual({
        do_not_record: false,
        language: "af",
      });
    });
  });

  describe("getTranscript", () => {
    it("returns transcript with company isolation", async () => {
      const callSid = "call_t001";
      const transcriptId = randomUUID();
      const recordingId = randomUUID();
      const callId = randomUUID();

      // Create call
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+1111111111', '+2222222222', $5, 'completed', now(), true)`,
        [callId, companyId1, contactId, userId, callSid, true],
      );

      // Create recording
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state)
         VALUES ($1, $2, 'rec_001', 'https://secret.url', 'transcribed')`,
        [recordingId, callSid],
      );

      // Create transcript
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_transcripts (id, recording_id, call_sid, provider, language, text, segments, summary)
         VALUES ($1, $2, $3, 'deepgram', 'en', 'Hello world', '[]'::jsonb, 'Summary text')`,
        [transcriptId, recordingId, callSid],
      );

      const result = await getTranscript(db.db, NAMESPACE, { companyId: companyId1, callSid });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(transcriptId);
      expect(result!.text).toBe("Hello world");
      expect(result!.language).toBe("en");
      expect(result!.summary).toBe("Summary text");
    });

    it("returns null for non-existent transcript", async () => {
      const result = await getTranscript(db.db, NAMESPACE, { companyId: companyId1, callSid: "nonexistent" });
      expect(result).toBeNull();
    });

    it("does not return transcript from different company", async () => {
      const callSid = "call_t002";
      const callId = randomUUID();
      const recordingId = randomUUID();
      const transcriptId = randomUUID();

      // Company 1 call
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', '+1111111111', '+2222222222', $5, 'completed', now(), true)`,
        [callId, companyId1, contactId, userId, callSid, true],
      );

      // Create recording + transcript
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state)
         VALUES ($1, $2, 'rec_001', 'https://secret.url', 'transcribed')`,
        [recordingId, callSid],
      );

      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_transcripts (id, recording_id, call_sid, provider, language, text)
         VALUES ($1, $2, $3, 'deepgram', 'en', 'Test')`,
        [transcriptId, recordingId, callSid],
      );

      // Query from company 2 should return nothing
      const result = await getTranscript(db.db, NAMESPACE, { companyId: companyId2, callSid });
      expect(result).toBeNull();
    });
  });

  describe("listUnmatched", () => {
    it("groups unmatched calls and messages by number", async () => {
      const number1 = "+1234567890";
      const number2 = "+0987654321";

      // Call 1 inbound
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, NULL, $3, 'inbound', $4, '+5555555555', 'call_1', 'completed', now(), false)`,
        [randomUUID(), companyId1, userId, number1, false],
      );

      // Call 2 outbound to same number
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, NULL, $3, 'outbound', '+5555555555', $4, 'call_2', 'completed', now(), false)`,
        [randomUUID(), companyId1, userId, number1, false],
      );

      // Message from different number
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, provider_msg_id, contact_id, from_e164, to_e164, created_at, status)
         VALUES ($1, $2, 'sms', 'inbound', 'msg_1', NULL, $3, '+5555555555', now(), 'received')`,
        [randomUUID(), companyId1, number2],
      );

      const result = await listUnmatched(db.db, NAMESPACE, { companyId: companyId1 });

      // Should have 3 items: inbound_call and outbound_call for number1, plus inbound_message for number2
      expect(result.length).toBe(3);
      const number1Items = result.filter((r) => r.number === number1);
      const number2Items = result.filter((r) => r.number === number2);
      expect(number1Items).toHaveLength(2);
      expect(number2Items).toHaveLength(1);
      expect(number1Items.map((r) => r.type).sort()).toEqual(["inbound_call", "outbound_call"]);
      expect(number2Items[0].type).toBe("inbound_message");
    });

    it("respects company isolation", async () => {
      const number = "+1234567890";

      // Company 1
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, NULL, $3, 'inbound', $4, '+5555555555', 'call_1', 'completed', now(), false)`,
        [randomUUID(), companyId1, userId, number, false],
      );

      // Company 2
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, NULL, $3, 'inbound', '+9999999999', '+5555555555', 'call_2', 'completed', now(), false)`,
        [randomUUID(), companyId2, userId, false],
      );

      const result1 = await listUnmatched(db.db, NAMESPACE, { companyId: companyId1 });
      expect(result1).toHaveLength(1);
      expect(result1[0].number).toBe(number);

      const result2 = await listUnmatched(db.db, NAMESPACE, { companyId: companyId2 });
      expect(result2).toHaveLength(1);
      expect(result2[0].number).toBe("+9999999999");
    });

    it("excludes items with contact_id set", async () => {
      const number = "+1234567890";

      // Unmatched
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, NULL, $3, 'inbound', $4, '+5555555555', 'call_1', 'completed', now(), false)`,
        [randomUUID(), companyId1, userId, number, false],
      );

      // Matched (with contact_id)
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_calls (id, company_id, contact_id, user_id, direction, from_e164, to_e164, call_sid, status, created_at, recorded)
         VALUES ($1, $2, $3, $4, 'inbound', $5, '+5555555555', 'call_2', 'completed', now(), false)`,
        [randomUUID(), companyId1, contactId, userId, "+0000000000", false],
      );

      const result = await listUnmatched(db.db, NAMESPACE, { companyId: companyId1 });

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(number);
    });
  });

  describe("setContactPrefs", () => {
    it("inserts new preference row", async () => {
      await setContactPrefs(db.db, NAMESPACE, {
        companyId: companyId1,
        contactId,
        userId,
        doNotRecord: true,
        language: "af",
      });

      const rows = await db.db.query(
        `SELECT do_not_record, language, updated_by FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
        [companyId1, contactId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].do_not_record).toBe(true);
      expect(rows[0].language).toBe("af");
      expect(rows[0].updated_by).toBe(userId);
    });

    it("updates existing preference row", async () => {
      // Insert initial
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, do_not_record, language, updated_by)
         VALUES ($1, $2, false, 'en', 'old_user')`,
        [companyId1, contactId],
      );

      // Update
      await setContactPrefs(db.db, NAMESPACE, {
        companyId: companyId1,
        contactId,
        userId: "new_user",
        doNotRecord: true,
        language: "af",
      });

      const rows = await db.db.query(
        `SELECT do_not_record, language, updated_by FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
        [companyId1, contactId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].do_not_record).toBe(true);
      expect(rows[0].language).toBe("af");
      expect(rows[0].updated_by).toBe("new_user");
    });

    it("writes audit record with changed fields", async () => {
      await setContactPrefs(db.db, NAMESPACE, {
        companyId: companyId1,
        contactId,
        userId,
        doNotRecord: true,
        language: "af",
      });

      const auditRows = await db.db.query(
        `SELECT action, contact_id, detail FROM ${NAMESPACE}.tel_audit WHERE company_id = $1 AND action = 'contact.prefs.update'`,
        [companyId1],
      );

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].action).toBe("contact.prefs.update");
      expect(auditRows[0].contact_id).toBe(contactId);
      expect(auditRows[0].detail).toEqual({
        do_not_record: true,
        language: "af",
      });
    });

    it("defaults missing fields to NULL when updating", async () => {
      // Insert with both fields
      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, do_not_record, language)
         VALUES ($1, $2, true, 'af')`,
        [companyId1, contactId],
      );

      // Update only language
      await setContactPrefs(db.db, NAMESPACE, {
        companyId: companyId1,
        contactId,
        userId,
        language: "en",
      });

      const rows = await db.db.query(
        `SELECT do_not_record, language FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
        [companyId1, contactId],
      );

      expect(rows[0].do_not_record).toBe(true); // Unchanged
      expect(rows[0].language).toBe("en"); // Updated
    });
  });
});
