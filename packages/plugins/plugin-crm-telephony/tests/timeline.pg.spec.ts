import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTimeline, getTranscript } from "../src/timeline.js";
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

});
