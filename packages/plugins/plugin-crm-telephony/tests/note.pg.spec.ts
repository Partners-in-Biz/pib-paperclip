import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitCallNoted,
  makeNoteStep,
  registerNoteAck,
  sweepUnackedNotes,
  NOTE_EVENT,
  MAX_NOTE_TRANSCRIPT_CHARS,
  NOTE_REEMIT_AFTER_MS,
  NOTE_MAX_EMITS,
} from "../src/note.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

let db: Awaited<ReturnType<typeof startHostDb>>;

async function seedData(opts: { callSid?: string; companyId?: string; contactId?: string; transcript?: string; summary?: string | null; nextActions?: string[]; language?: string; noticePlayed?: boolean; erasedAt?: boolean }) {
  const callId = randomUUID(), recordingId = randomUUID();
  const callSid = opts.callSid || `call_${Date.now()}`, companyId = opts.companyId || randomUUID(), contactId = opts.contactId || `contact_${Date.now()}`;

  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_calls (id, call_sid, company_id, contact_id, user_id, direction, from_e164, to_e164, duration_s, consent_notice_played)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [callId, callSid, companyId, contactId, "user_123", "inbound", "+27123456789", "+27987654321", 120, opts.noticePlayed ?? false],
  );

  const recordingSid = `rec_${Date.now()}`;
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [recordingId, callSid, recordingSid, "http://ex.com/rec", "noted", companyId],
  );

  const text = opts.transcript || "Test", lang = opts.language || "en";
  const nextActionsJson = opts.nextActions ? JSON.stringify({ items: opts.nextActions, sentiment: "neutral" }) : null;
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, text, summary, next_actions, language, note_status, note_emits)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [recordingId, callSid, text, opts.summary ?? null, nextActionsJson, lang, "pending", 0],
  );

  if (opts.erasedAt || lang !== "en") {
    const erasedAtSql = opts.erasedAt ? "now()" : "NULL";
    const sql = `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, language, erased_at) VALUES ($1, $2, $3, ${erasedAtSql})`;
    await db.db.execute(sql, [companyId, contactId, lang]);
  }

  return { callSid, companyId, contactId, recordingId };
}

function createMockCtx(mockEvents?: { emit: any; on: any }) {
  const events = mockEvents || { emit: vi.fn(), on: vi.fn() };
  return {
    db: { ...db.db, namespace: NAMESPACE },
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    events,
  } as any;
}

describe("call note emission and acking", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  it("(1) happy path: emits with event name/company/payload shape, row=emitted note_emits=1", async () => {
    const { callSid, companyId, contactId } = await seedData({ transcript: "Customer called about billing.", summary: "Billing inquiry", nextActions: ["Follow up on Monday"] });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);

    const result = await emitCallNoted(ctx, NAMESPACE, callSid);
    expect(result).toBe("emitted");
    expect(mockEvents.emit).toHaveBeenCalledOnce();
    const [event, cid, payload] = mockEvents.emit.mock.calls[0];
    expect(event).toBe(NOTE_EVENT);
    expect(cid).toBe(companyId);
    expect(payload.companyId).toBe(companyId);
    expect(payload.contactId).toBe(contactId);
    expect(payload.callSid).toBe(callSid);
    expect(payload.summary).toBe("Billing inquiry");
    expect(payload.nextActions).toEqual(["Follow up on Monday"]);
    expect(payload.transcript).toBe("Customer called about billing.");
    expect(payload.recordingUrl).toBeNull();
    expect(payload.language).toBe("en");
    expect(payload.consent).toEqual({ noticePlayed: false });

    const rows = await db.db.query<{ note_status: string; note_emits: number }>(
      `SELECT note_status, note_emits FROM ${NAMESPACE}.tel_transcripts WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ note_status: "emitted", note_emits: 1 });
  });

  it.each([
    { summary: null, expect: null },
    { summary: "Billing inquiry", expect: "Billing inquiry" },
  ])("(2) summary=$summary -> payload.summary=$expect", async ({ summary, expect: expected }) => {
    const { callSid } = await seedData({ summary });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    await emitCallNoted(ctx, NAMESPACE, callSid);
    expect(mockEvents.emit.mock.calls[0][2].summary).toBe(expected);
  });

  it("(3) long transcript truncated to cap", async () => {
    const longTranscript = "x".repeat(MAX_NOTE_TRANSCRIPT_CHARS + 1000);
    const { callSid } = await seedData({ transcript: longTranscript });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    await emitCallNoted(ctx, NAMESPACE, callSid);
    expect(mockEvents.emit.mock.calls[0][2].transcript.length).toBe(MAX_NOTE_TRANSCRIPT_CHARS);
  });

  it("(4) no contact_id => 'no_contact', no emit", async () => {
    const callId = randomUUID(), companyId = randomUUID(), callSid = `call_${Date.now()}`;
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_calls (id, call_sid, company_id, contact_id, user_id, direction, from_e164, to_e164)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [callId, callSid, companyId, null, "user_123", "inbound", "+27123456789", "+27987654321"],
    );
    const recordingId = randomUUID(), recordingSid = `rec_${Date.now()}`;
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [recordingId, callSid, recordingSid, "http://ex.com/rec", "noted", companyId],
    );
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, text, summary, next_actions, language, note_status, note_emits)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [recordingId, callSid, "Test", null, null, "en", "pending", 0],
    );
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    expect(await emitCallNoted(ctx, NAMESPACE, callSid)).toBe("no_contact");
    expect(mockEvents.emit).not.toHaveBeenCalled();
  });

  it("(5) erased contact => 'erased', no emit", async () => {
    const { callSid } = await seedData({ erasedAt: true });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    expect(await emitCallNoted(ctx, NAMESPACE, callSid)).toBe("erased");
    expect(mockEvents.emit).not.toHaveBeenCalled();
  });

  it.each([["af"], ["en"]])("(6) language=%s from prefs or default", async (lang) => {
    const companyId = randomUUID(), contactId = `contact_${Date.now()}`, callSid = `call_${Date.now()}`;
    const { callSid: _, companyId: __, contactId: ___ } = await seedData({ companyId, contactId, callSid, language: lang });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    await emitCallNoted(ctx, NAMESPACE, callSid);
    expect(mockEvents.emit.mock.calls[0][2].language).toBe(lang);
  });

  it("(7) logs contain no transcript text", async () => {
    const { callSid } = await seedData({ transcript: "Customer credit card 1234-5678-9012-3456" });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    await emitCallNoted(ctx, NAMESPACE, callSid);
    const loggedMessages = [...(ctx.logger.debug as any).mock.calls, ...(ctx.logger.warn as any).mock.calls, ...(ctx.logger.info as any).mock.calls]
      .map((c: any[]) => c[0]).join(" ");
    expect(loggedMessages).not.toContain("credit card");
    expect(loggedMessages).not.toContain("1234-5678");
  });

  it("(7b) emit rejecting => emitCallNoted rejects and row not marked emitted", async () => {
    const { callSid } = await seedData({ transcript: "Test transcript" });
    const emitError = new Error("emit failed");
    const mockEvents = { emit: vi.fn().mockRejectedValue(emitError), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);

    await expect(emitCallNoted(ctx, NAMESPACE, callSid)).rejects.toThrow("emit failed");

    const rows = await db.db.query<{ note_status: string; note_emits: number }>(
      `SELECT note_status, note_emits FROM ${NAMESPACE}.tel_transcripts WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows[0].note_status).toBe("pending");
    expect(rows[0].note_emits).toBe(0);
  });

  it("(8) ack handler: right company sets crm_activity_id + acked; wrong company unchanged", async () => {
    const { callSid, companyId } = await seedData({});
    const activityId = "activity_123";
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);

    registerNoteAck(ctx);
    const handler = (ctx.events.on as any).mock.calls[0][1];

    // Correct company
    await handler({ payload: { companyId, sourceKey: `telephony:call:${callSid}`, activityId } });
    let rows = await db.db.query<{ crm_activity_id: string; note_status: string }>(
      `SELECT crm_activity_id, note_status FROM ${NAMESPACE}.tel_transcripts WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows[0]).toEqual({ crm_activity_id: activityId, note_status: "acked" });

    // Wrong company - no change
    await handler({ payload: { companyId: randomUUID(), sourceKey: `telephony:call:${callSid}`, activityId: "activity_wrong" } });
    rows = await db.db.query<{ crm_activity_id: string; note_status: string }>(
      `SELECT crm_activity_id, note_status FROM ${NAMESPACE}.tel_transcripts WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows[0]).toEqual({ crm_activity_id: activityId, note_status: "acked" });
  });

  it("(8b) ack handler: malformed/non-telephony ignored, replay safe", async () => {
    const { callSid, companyId } = await seedData({});
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);

    registerNoteAck(ctx);
    const handler = (ctx.events.on as any).mock.calls[0][1];

    // Malformed and non-telephony ignored
    await handler({ payload: { companyId: randomUUID() } });
    await handler({ payload: { companyId: randomUUID(), sourceKey: "other:key", activityId: "act_1" } });
    expect(ctx.logger.debug).toHaveBeenCalled();

    // Replay safe
    const activityId = "activity_123";
    await handler({ payload: { companyId, sourceKey: `telephony:call:${callSid}`, activityId } });
    await handler({ payload: { companyId, sourceKey: `telephony:call:${callSid}`, activityId } });
    const rows = await db.db.query<{ crm_activity_id: string; note_status: string }>(
      `SELECT crm_activity_id, note_status FROM ${NAMESPACE}.tel_transcripts WHERE call_sid = $1`,
      [callSid],
    );
    expect(rows[0]).toEqual({ crm_activity_id: activityId, note_status: "acked" });
  });

  it("(9) sweep: stale=re-emitted, fresh=not, acked=not, maxEmits=gaveUp, error doesn't stop others", async () => {
    const oldTime = new Date(Date.now() - NOTE_REEMIT_AFTER_MS - 60000);
    const recentTime = new Date(Date.now() - 60000);

    // Stale emitted
    const { callSid: staleSid } = await seedData({});
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts SET note_status='emitted', note_emitted_at=$1, note_emits=2 WHERE call_sid=$2`,
      [oldTime.toISOString(), staleSid],
    );

    // Fresh emitted
    const { callSid: freshSid } = await seedData({});
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts SET note_status='emitted', note_emitted_at=$1, note_emits=1 WHERE call_sid=$2`,
      [recentTime.toISOString(), freshSid],
    );

    // Acked
    const { callSid: ackedSid } = await seedData({});
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts SET note_status='acked', note_emitted_at=$1 WHERE call_sid=$2`,
      [oldTime.toISOString(), ackedSid],
    );

    // At max emits
    const { callSid: maxSid } = await seedData({});
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts SET note_status='emitted', note_emitted_at=$1, note_emits=$2 WHERE call_sid=$3`,
      [oldTime.toISOString(), NOTE_MAX_EMITS, maxSid],
    );

    // Broken (no transcript) and one good
    const callId = randomUUID(), companyId = randomUUID(), brokenSid = `call_broken_${Date.now()}`;
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_calls (id, call_sid, company_id, contact_id, user_id, direction, from_e164, to_e164)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [callId, brokenSid, companyId, "contact_x", "user_123", "inbound", "+1111111111", "+2222222222"],
    );
    const recordingId = randomUUID();
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [recordingId, brokenSid, `rec_${Date.now()}`, "http://ex.com/rec", "noted", companyId],
    );
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_transcripts SET note_status='emitted', note_emitted_at=$1, note_emits=1 WHERE call_sid=$2`,
      [oldTime.toISOString(), brokenSid],
    );

    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);

    const result = await sweepUnackedNotes(ctx, NAMESPACE);

    // Stale re-emitted, fresh/acked/max not, broken fails but doesn't stop stale
    expect(result.reemitted).toBe(1);
    expect(mockEvents.emit.mock.calls[0][2].callSid).toBe(staleSid);
    const staleRow = (await db.db.query(`SELECT note_emits FROM ${NAMESPACE}.tel_transcripts WHERE call_sid=$1`, [staleSid]))[0];
    expect(staleRow.note_emits).toBe(3);
    expect(result.gaveUp).toBe(1); // maxSid
  });

  it("(10) makeNoteStep: returns right states", async () => {
    const { callSid, recordingId, companyId } = await seedData({});
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    const step = makeNoteStep();
    const row = { id: recordingId, call_sid: callSid, company_id: companyId, recording_sid: `rec_${Date.now()}` } as any;
    const result = await step({ ctx, namespace: NAMESPACE, row, extendLease: vi.fn(), isErased: async () => false });
    expect(result.state).toBe("noted");
    expect(mockEvents.emit).toHaveBeenCalled();
  });

  it("(10b) makeNoteStep: erased contact returns erased", async () => {
    const { callSid, recordingId, companyId } = await seedData({ erasedAt: true });
    const mockEvents = { emit: vi.fn(), on: vi.fn() };
    const ctx = createMockCtx(mockEvents);
    const step = makeNoteStep();
    const row = { id: recordingId, call_sid: callSid, company_id: companyId, recording_sid: `rec_${Date.now()}` } as any;
    const result = await step({ ctx, namespace: NAMESPACE, row, extendLease: vi.fn(), isErased: async () => false });
    expect(result.state).toBe("erased");
    expect(mockEvents.emit).not.toHaveBeenCalled();
  });
});
