import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTranscribeStep, type TranscribeDeps } from "../src/transcribe.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

const here = dirname(fileURLToPath(import.meta.url));
const deepgramFixture = JSON.parse(readFileSync(join(here, "fixtures/deepgram-listen-dual.json"), "utf8"));

let db: Awaited<ReturnType<typeof startHostDb>>;

async function seedCall(callId: string, opts?: { callSid?: string; companyId?: string; contactId?: string }) {
  const callSid = opts?.callSid || `call_${Date.now()}`;
  const companyId = opts?.companyId || randomUUID();
  const contactId = opts?.contactId || `contact_${Date.now()}`;
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_calls (id, call_sid, company_id, contact_id, user_id, direction, from_e164, to_e164)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [callId, callSid, companyId, contactId, "user_123", "inbound", "+27123456789", "+27987654321"],
  );
  return { callSid, companyId, contactId };
}

async function seedRecording(recordingId: string, callSid: string, opts?: { companyId?: string; erasedAt?: boolean }) {
  const recordingSid = `rec_${Date.now()}`;
  const columns = ["id", "call_sid", "recording_sid", "twilio_url", "state", "company_id"];
  const values = [recordingId, callSid, recordingSid, "http://ex.com/rec", "twilio_deleted", opts?.companyId];
  const params: (string | boolean | undefined)[] = ["$1::uuid", "$2", "$3", "$4", "$5", "$6"];
  if (opts?.erasedAt) {
    columns.push("erased_at");
    params.push("now()");
  }
  const sql = `INSERT INTO ${NAMESPACE}.tel_recordings (${columns.join(", ")}) VALUES (${params.join(", ")})`;
  await db.db.execute(sql, values);
}

async function seedContactPrefs(companyId: string, contactId: string, language: string) {
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, language) VALUES ($1, $2, $3) ON CONFLICT (company_id, contact_id) DO UPDATE SET language = $3`,
    [companyId, contactId, language],
  );
}

describe("transcribe step", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  function makeMockCtx(fetchMock?: any, secretResolve?: (name: string) => any) {
    return {
      ctx: {
        db: db.db,
        logger: { debug: () => {}, warn: () => {} },
        secrets: { resolve: vi.fn(secretResolve || (async () => "dg_test_key")) },
        http: { fetch: fetchMock || vi.fn() },
      } as any,
    };
  }

  it("(a) happy path: Authorization=Token <key>, URL has model=nova-3&multichannel=true&smart_format=true", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });

    let capturedUrl = "", capturedOpts: any;
    const fetchMock = vi.fn(async (url: string, opts: any) => {
      capturedUrl = url;
      capturedOpts = opts;
      return { ok: true, json: async () => deepgramFixture };
    });

    const ctx = makeMockCtx(fetchMock);
    const deps: TranscribeDeps = { audioUrl: vi.fn(async () => "https://r2.ex.com/audio.wav") };
    const step = makeTranscribeStep(deps);
    const result = await step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false });

    expect(result.state).toBe("transcribed");
    expect(capturedOpts.headers.Authorization).toBe("Token dg_test_key");
    expect(capturedUrl).toContain("model=nova-3");
    expect(capturedUrl).toContain("multichannel=true");
    expect(capturedUrl).toContain("smart_format=true");

    const transcripts = await db.db.query<{ text: string; language: string }>(
      `SELECT text, language FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`,
      [recordingId],
    );
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].language).toBe("en");
  });

  it("(b) af language preference => language=af in request", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId, contactId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });
    await seedContactPrefs(companyId, contactId, "af");

    let capturedUrl = "";
    const ctx = makeMockCtx(vi.fn(async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => deepgramFixture };
    }));

    const deps: TranscribeDeps = { audioUrl: vi.fn(async () => "https://r2.ex.com/audio.wav") };
    const step = makeTranscribeStep(deps);
    await step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false });

    expect(capturedUrl).toContain("language=af");
    const transcripts = await db.db.query<{ language: string }>(`SELECT language FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`, [recordingId]);
    expect(transcripts[0].language).toBe("af");
  });

  it("(c) HTTP 500 => throws, no key/URL leak", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });

    const ctx = makeMockCtx(vi.fn(async () => ({ ok: false, status: 500 })), async () => "secret_key_xyz");
    const deps: TranscribeDeps = { audioUrl: vi.fn(async () => "https://r2.ex.com/secret.wav") };
    const step = makeTranscribeStep(deps);

    try {
      await step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).toContain("deepgram http 500");
      expect(e.message).not.toContain("secret_key_xyz");
      expect(e.message).not.toContain("https://r2.ex.com/secret.wav");
    }
  });

  it("(d) missing DEEPGRAM_API_KEY => throws", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });

    const ctx = makeMockCtx(undefined, async () => null);
    const deps: TranscribeDeps = { audioUrl: vi.fn() };
    const step = makeTranscribeStep(deps);

    await expect(step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false }))
      .rejects.toThrow("DEEPGRAM_API_KEY not set");
  });

  it("(e) erased recording => returns erased, no HTTP call", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId, erasedAt: true });

    const fetchMock = vi.fn();
    const ctx = makeMockCtx(fetchMock);
    const deps: TranscribeDeps = { audioUrl: vi.fn() };
    const step = makeTranscribeStep(deps);
    const result = await step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false });

    expect(result.state).toBe("erased");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(f) idempotent => re-run twice, one row", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });

    const ctx = makeMockCtx(vi.fn(async () => ({ ok: true, json: async () => deepgramFixture })));
    const deps: TranscribeDeps = { audioUrl: vi.fn(async () => "https://r2.ex.com/audio.wav") };
    const step = makeTranscribeStep(deps);
    const row = { id: recordingId, call_sid: callSid, company_id: companyId } as any;

    await step({ ctx: ctx.ctx, namespace: NAMESPACE, row, extendLease: vi.fn(), isErased: async () => false });
    await step({ ctx: ctx.ctx, namespace: NAMESPACE, row, extendLease: vi.fn(), isErased: async () => false });

    const transcripts = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`, [recordingId]);
    expect(transcripts).toHaveLength(1);
  });

  it("(g) empty utterances => text='', still transcribed", async () => {
    const callId = randomUUID(), recordingId = randomUUID();
    const { callSid, companyId } = await seedCall(callId);
    await seedRecording(recordingId, callSid, { companyId });

    const ctx = makeMockCtx(vi.fn(async () => ({ ok: true, json: async () => ({ results: {} }) })));
    const deps: TranscribeDeps = { audioUrl: vi.fn(async () => "https://r2.ex.com/audio.wav") };
    const step = makeTranscribeStep(deps);
    const result = await step({ ctx: ctx.ctx, namespace: NAMESPACE, row: { id: recordingId, call_sid: callSid, company_id: companyId } as any, extendLease: vi.fn(), isErased: async () => false });

    expect(result.state).toBe("transcribed");
    const transcripts = await db.db.query<{ text: string; segments: string }>(`SELECT text, segments FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`, [recordingId]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("");
    const segments = typeof transcripts[0].segments === "string" ? JSON.parse(transcripts[0].segments) : transcripts[0].segments;
    expect(segments).toEqual([]);
  });
});
