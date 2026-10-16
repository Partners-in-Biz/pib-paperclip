import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMediaPipeline, type PipelineSteps } from "../src/pipeline.js";
import { makeTranscribeStep } from "../src/transcribe.js";
import { makeSummariseStep } from "../src/summarise.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";
import { createSecretsRecorder } from "./helpers/test-utils.js";

interface TestDb {
  db: { execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>; query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> };
  reset(): Promise<void>;
  stop(): Promise<void>;
}

let db: TestDb;

async function seedRec(rid: string, opts?: { callSid?: string; recSid?: string; co?: string; state?: string }) {
  const callSid = opts?.callSid || `call_${Date.now()}`;
  const recSid = opts?.recSid || `rec_${Date.now()}`;
  const state = opts?.state || "received";
  let sql = `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state`;
  const params: unknown[] = [rid, callSid, recSid, "http://ex.com/rec", state];
  if (opts?.co) {
    sql += ", company_id";
    params.push(opts.co);
  }
  sql += ") VALUES ($1::uuid, $2, $3, $4, $5" + (opts?.co ? ", $6::uuid" : "") + ")";
  await db.db.execute(sql, params);
}

async function seedCall(callSid: string, co: string) {
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_calls (id, call_sid, company_id, contact_id, user_id, direction, from_e164, to_e164) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)`,
    [randomUUID(), callSid, co, null, "user", "inbound", "+27123456789", "+27987654321"],
  );
}

async function seedTranscript(rid: string, callSid: string) {
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, provider, language, text, segments) VALUES ($1::uuid, $2, 'deepgram', 'en', 'Test', '[]'::jsonb)`,
    [rid, callSid],
  );
}

describe("credential isolation pipeline", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  describe("per-company key usage", () => {
    it.each([
      { step: "transcribe", secret: "DEEPGRAM_API_KEY", state: "received", step_fn: () => makeTranscribeStep({ audioUrl: async () => "http://example.com/audio.wav" }) },
      { step: "summarise", secret: "ANTHROPIC_API_KEY", state: "transcribed", step_fn: () => makeSummariseStep() },
    ])("$step uses own company secret only", async ({ step, secret, state, step_fn }) => {
      const coA = randomUUID();
      const coB = randomUUID();
      const rid = randomUUID();
      const callSid = `call_${Date.now()}`;

      await seedRec(rid, { callSid, recSid: `rec_${Date.now()}`, co: coA, state });
      await seedCall(callSid, coA);
      if (state === "transcribed") await seedTranscript(rid, callSid);

      const rec = createSecretsRecorder();
      const mockFetch = vi.fn(async (url: string, opts: any) => {
        if (url.includes("deepgram.com")) return new Response(JSON.stringify({ results: { utterances: [{ channel: 0, start: 0, end: 1, transcript: "Test" }] } }), { status: 200 });
        if (url.includes("anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_summary", input: { summary: "Test", next_actions: [], sentiment: "positive" } }] }), { status: 200 });
        throw new Error(`Unexpected: ${url}`);
      });

      const ctx = {
        db: db.db,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        issues: { create: vi.fn(async (i: any) => ({ id: randomUUID(), ...i })) },
        secrets: {
          resolve: vi.fn(async (n: string, opts: any) => {
            rec.record(n, opts.companyId);
            if (n === secret) return opts.companyId === coA ? `key-A-${secret}` : `key-B-${secret}`;
            throw new Error(`${n} not found`);
          }),
        },
        http: { fetch: mockFetch },
      } as any;

      const steps: PipelineSteps = { [state]: step_fn() };
      const result = await runMediaPipeline(ctx, { steps, namespace: NAMESPACE });

      expect(result.processed).toBe(1);
      expect(rec.resolved.every((r) => r.companyId === coA && r.secretName === secret)).toBe(true);
    });
  });

  describe("fail-closed: no fallback", () => {
    it("missing company_id fails closed, no resolve calls", async () => {
      const rid = randomUUID();
      const callSid = `call_${Date.now()}`;

      await db.db.execute(
        `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state) VALUES ($1::uuid, $2, $3, $4, $5)`,
        [rid, callSid, `rec_${Date.now()}`, "http://ex.com/rec", "received"],
      );

      const rec = createSecretsRecorder();
      const ctx = {
        db: db.db,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        issues: { create: vi.fn() },
        secrets: { resolve: vi.fn(async () => { rec.record("ANY", "ANY"); throw new Error("Should not call"); }) },
        http: { fetch: vi.fn() },
      } as any;

      const steps: PipelineSteps = { received: makeTranscribeStep({ audioUrl: async () => "http://ex.com/aud" }) };
      const result = await runMediaPipeline(ctx, { steps, namespace: NAMESPACE });

      expect(result.failed).toBe(1);
      expect(rec.resolved.length).toBe(0);

      const row = await db.db.query<{ last_error: string }>(
        `SELECT last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
        [rid],
      );
      expect(row[0].last_error).toContain("company_id missing");
    });

    it.each([
      { secret: "DEEPGRAM_API_KEY", state: "received", step_fn: () => makeTranscribeStep({ audioUrl: async () => "http://ex.com/aud" }) },
      { secret: "ANTHROPIC_API_KEY", state: "transcribed", step_fn: () => makeSummariseStep() },
    ])("missing $secret fails closed, no fallback", async ({ secret, state, step_fn }) => {
      const coA = randomUUID();
      const coB = randomUUID();
      const rid = randomUUID();
      const callSid = `call_${Date.now()}`;

      await seedRec(rid, { callSid, recSid: `rec_${Date.now()}`, co: coA, state });
      await seedCall(callSid, coA);
      if (state === "transcribed") await seedTranscript(rid, callSid);

      const rec = createSecretsRecorder();
      const ctx = {
        db: db.db,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        issues: { create: vi.fn() },
        secrets: {
          resolve: vi.fn(async (n: string, opts: any) => {
            rec.record(n, opts.companyId);
            if (opts.companyId === coA) throw new Error(`${secret} not set`);
            return "some-key";
          }),
        },
        http: { fetch: vi.fn() },
      } as any;

      const steps: PipelineSteps = { [state]: step_fn() };
      const result = await runMediaPipeline(ctx, { steps, namespace: NAMESPACE });

      expect(result.failed).toBe(1);
      expect(rec.resolved).toContainEqual({ secretName: secret, companyId: coA });
      expect(rec.resolved.some((r) => r.companyId === coB)).toBe(false);
    });
  });
});
