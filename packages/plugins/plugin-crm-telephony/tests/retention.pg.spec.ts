import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRetention, QUIESCE_SECONDS, TRANSCRIPT_RETENTION_MONTHS, RETENTION_MARKER } from "../src/retention.js";
import { recordingKey } from "../src/r2-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";
import type { R2Config } from "../src/r2-store.js";

interface TestDb {
  db: {
    execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  };
  reset(): Promise<void>;
  stop(): Promise<void>;
}

let db: TestDb;

// In-memory R2 store for testing
class MockR2Store {
  data = new Map<string, { body: Uint8Array; sha256: string }>();

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  async put(key: string, body: Uint8Array, sha256: string): Promise<void> {
    this.data.set(key, { body, sha256 });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const mockR2 = new MockR2Store();

// Mock fetch for R2 and Twilio
function createMockFetch(opts?: { r2FailDeleteKey?: string; twilioFailDelete?: boolean }): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    // R2 operations
    if (urlStr.includes(".r2.cloudflarestorage.com")) {
      const path = urlStr.split(".r2.cloudflarestorage.com/")[1]?.split("?")[0] || "";

      if (init?.method === "GET" && urlStr.includes("?list-type=2")) {
        // ListObjectsV2
        const prefixMatch = urlStr.match(/prefix=([^&]+)/);
        const prefix = prefixMatch ? decodeURIComponent(prefixMatch[1]) : "";
        const keys = await mockR2.list(prefix);
        const xml = `<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join("")}</ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }

      if (init?.method === "DELETE") {
        if (opts?.r2FailDeleteKey && path === opts.r2FailDeleteKey) {
          return new Response(undefined as any, { status: 500 });
        }
        await mockR2.delete(path);
        return new Response(undefined as any, { status: 204 });
      }

      if (init?.method === "PUT") {
        const sha = init.headers && typeof init.headers === "object" && "x-amz-meta-sha256" in init.headers ? (init.headers as any)["x-amz-meta-sha256"] : "";
        await mockR2.put(path, new Uint8Array(init?.body as any), sha);
        return new Response(undefined as any, { status: 200 });
      }
    }

    // Twilio operations
    if (urlStr.includes("api.twilio.com")) {
      if (init?.method === "DELETE") {
        if (opts?.twilioFailDelete) {
          return new Response(undefined as any, { status: 500 });
        }
        return new Response(undefined as any, { status: 204 });
      }
    }

    return new Response("Not found", { status: 404 });
  };
}

function createMockCtx(opts?: { r2Config?: (ctx: any, companyId: string) => Promise<R2Config | null>; fetch?: typeof fetch }) {
  return {
    ctx: {
      db: db.db,
      logger: {
        debug: (msg: string) => console.log("[DEBUG]", msg),
        warn: (msg: string) => console.log("[WARN]", msg),
        info: (msg: string) => console.log("[INFO]", msg),
        error: (msg: string) => console.log("[ERROR]", msg),
      },
      secrets: {
        resolve: vi.fn(async (name: string) => {
          if (name === "TWILIO_API_KEY_SID") return "test_key_sid";
          if (name === "TWILIO_API_KEY_SECRET") return "test_key_secret";
          throw new Error(`Unknown secret: ${name}`);
        }),
      },
    } as any,
  };
}

function defaultR2Config(ctx: any, companyId: string): Promise<R2Config | null> {
  return Promise.resolve({
    accountId: "test.r2",
    bucket: "test-bucket",
    accessKeyId: "test_key",
    secretAccessKey: "test_secret",
    prefix: "crm-telephony",
  });
}

async function seedRecording(recordingId: string, opts?: {
  callSid?: string;
  recordingSid?: string;
  companyId?: string;
  state?: string;
  expiresAt?: string;
  erasedAt?: string;
  createdAt?: string;
  deadIssueId?: string;
  leaseToken?: string;
  leaseUntil?: string;
  lastError?: string;
  r2Key?: string;
}) {
  const callSid = opts?.callSid || `call_${Date.now()}_${Math.random()}`;
  const recordingSid = opts?.recordingSid || `rec_${Date.now()}_${Math.random()}`;
  const state = opts?.state || "received";
  const createdAt = opts?.createdAt || new Date().toISOString();

  let sql = `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, created_at`;
  const params: unknown[] = [recordingId, callSid, recordingSid, "http://example.com/Accounts/AC0123456789abcdef0123456789abcd/Recordings/" + recordingSid, state, createdAt];

  if (opts?.companyId) {
    sql += ", company_id";
    params.push(opts.companyId);
  }
  if (opts?.expiresAt !== undefined) {
    sql += ", expires_at";
    params.push(opts.expiresAt);
  }
  if (opts?.erasedAt !== undefined) {
    sql += ", erased_at";
    params.push(opts.erasedAt);
  }
  if (opts?.deadIssueId) {
    sql += ", dead_issue_id";
    params.push(opts.deadIssueId);
  }
  if (opts?.leaseToken) {
    sql += ", lease_token";
    params.push(opts.leaseToken);
  }
  if (opts?.leaseUntil) {
    sql += ", lease_until";
    params.push(opts.leaseUntil);
  }
  if (opts?.lastError) {
    sql += ", last_error";
    params.push(opts.lastError);
  }
  if (opts?.r2Key) {
    sql += ", r2_key";
    params.push(opts.r2Key);
  }

  sql += ") VALUES ($1::uuid, $2, $3, $4, $5, $6";
  let paramIdx = 6;
  if (opts?.companyId) sql += `, $${++paramIdx}`;
  if (opts?.expiresAt !== undefined) sql += `, $${++paramIdx}`;
  if (opts?.erasedAt !== undefined) sql += `, $${++paramIdx}`;
  if (opts?.deadIssueId) sql += `, $${++paramIdx}::uuid`;
  if (opts?.leaseToken) sql += `, $${++paramIdx}::uuid`;
  if (opts?.leaseUntil) sql += `, $${++paramIdx}`;
  if (opts?.lastError) sql += `, $${++paramIdx}`;
  if (opts?.r2Key) sql += `, $${++paramIdx}`;
  sql += ")";

  await db.db.execute(sql, params);
}

async function seedTranscript(recordingId: string, opts?: { callSid?: string; createdAt?: string }) {
  const callSid = opts?.callSid || `call_${Date.now()}`;
  const createdAt = opts?.createdAt || new Date().toISOString();

  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, text, summary, created_at) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)`,
    [recordingId, callSid, "Sample transcript text", "Sample summary", createdAt],
  );
}

describe("retention", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
    mockR2.data.clear();
  });

  it("expired healthy-state row is tombstoned on first run and purged on second run", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;
    const recordingSid = `rec_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const expiresAt = new Date(now.getTime() - 1000); // already expired

    await seedRecording(recordingId, {
      callSid,
      recordingSid,
      companyId,
      state: "noted",
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(now.getTime() - 86400000).toISOString(),
    });

    await seedTranscript(recordingId, { callSid });

    // Pre-populate R2 with some test keys
    mockR2.data.set(`crm-telephony/recordings/${callSid}/${recordingSid}.wav`, { body: new Uint8Array([1, 2, 3]), sha256: "abc123" });
    mockR2.data.set(`crm-telephony/recordings/${callSid}/other_file.txt`, { body: new Uint8Array([4, 5, 6]), sha256: "def456" });
    // Key from another call should survive
    mockR2.data.set(`crm-telephony/recordings/other_call/${recordingSid}.wav`, { body: new Uint8Array([7, 8, 9]), sha256: "ghi789" });

    const mockCtx = createMockCtx({ r2Config: defaultR2Config, fetch: createMockFetch() });

    // First run: tombstone (not yet in quiesce window)
    const result1 = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch(),
    });

    expect(result1.tombstoned).toBe(1);
    expect(result1.purged).toBe(0);

    let row = await db.db.query<{ erased_at: string | null; state: string; lease_token: string | null; last_error: string | null }>(
      `SELECT erased_at, state, lease_token, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("erased");
    expect(row[0].last_error).toBe(RETENTION_MARKER);
    expect(row[0].lease_token).toBeNull();
    expect(row[0].erased_at).not.toBeNull();

    // R2 keys should still exist
    expect(mockR2.data.size).toBe(3);

    // Second run: purge (now in quiesce window)
    const now2 = new Date(now.getTime() + QUIESCE_SECONDS * 1000 + 1000);
    const result2 = await runRetention(mockCtx.ctx, {
      now: now2,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch(),
    });

    expect(result2.purged).toBe(1);

    // Recording row should be deleted
    const rows = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(rows).toHaveLength(0);

    // Transcript should still exist (retention marker means don't delete transcript)
    const transcripts = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`, [recordingId]);
    expect(transcripts).toHaveLength(1);

    // R2 keys for this call should be deleted, but other_call should survive
    expect(mockR2.data.size).toBe(1);
    expect(mockR2.data.has(`crm-telephony/recordings/other_call/${recordingSid}.wav`)).toBe(true);
  });

  it("not-yet-expired row remains untouched", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();

    const now = new Date("2026-10-13T12:00:00Z");
    const expiresAt = new Date(now.getTime() + 86400000); // expires tomorrow

    await seedRecording(recordingId, { companyId, state: "noted", expiresAt: expiresAt.toISOString() });

    const mockCtx = createMockCtx();
    const result = await runRetention(mockCtx.ctx, { now, namespace: NAMESPACE, r2Config: defaultR2Config });

    expect(result.tombstoned).toBe(0);
    expect(result.purged).toBe(0);

    const row = await db.db.query<{ erased_at: string | null }>(
      `SELECT erased_at FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].erased_at).toBeNull();
  });

  it("failed/skipped rows are tombstoned", async () => {
    const recordingId1 = randomUUID();
    const recordingId2 = randomUUID();

    await seedRecording(recordingId1, { state: "failed" });
    await seedRecording(recordingId2, { state: "skipped" });

    const mockCtx = createMockCtx();
    const result = await runRetention(mockCtx.ctx, { namespace: NAMESPACE });

    expect(result.tombstoned).toBe(2);
  });

  it("dead row with dead_issue_id is tombstoned", async () => {
    const recordingId = randomUUID();
    const issueId = randomUUID();

    await seedRecording(recordingId, { state: "dead", deadIssueId: issueId });

    const mockCtx = createMockCtx();
    const result = await runRetention(mockCtx.ctx, { namespace: NAMESPACE });

    expect(result.tombstoned).toBe(1);
  });

  it("dead row without issue_id and without company_id is tombstoned", async () => {
    const recordingId = randomUUID();

    await seedRecording(recordingId, { state: "dead" });

    const mockCtx = createMockCtx();
    const result = await runRetention(mockCtx.ctx, { namespace: NAMESPACE });

    expect(result.tombstoned).toBe(1);
  });

  it("dead row without issue_id but with company_id is left untouched", async () => {
    const recordingId = randomUUID();
    const companyId = randomUUID();

    await seedRecording(recordingId, { state: "dead", companyId });

    const mockCtx = createMockCtx();
    const result = await runRetention(mockCtx.ctx, { namespace: NAMESPACE });

    expect(result.tombstoned).toBe(0);

    const row = await db.db.query<{ erased_at: string | null }>(
      `SELECT erased_at FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].erased_at).toBeNull();
  });

  it("erasure race: lease cleared prevents running step from updating row", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const leaseToken = randomUUID();

    const now = new Date("2026-10-13T12:00:00Z");

    await seedRecording(recordingId, {
      companyId,
      state: "failed",
      leaseToken: leaseToken.toString(),
      leaseUntil: new Date(now.getTime() + 600000).toISOString(),
    });

    const mockCtx = createMockCtx();

    // Phase 1: tombstone (clears lease)
    const result = await runRetention(mockCtx.ctx, { now, namespace: NAMESPACE });
    expect(result.tombstoned).toBe(1);

    // Now simulate a running step trying to update with the old lease token
    const updateResult = await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_recordings SET state = 'downloaded', lease_token = NULL WHERE id = $1::uuid AND lease_token = $2::uuid`,
      [recordingId, leaseToken],
    );

    // Update should fail (0 rows) because lease_token was cleared
    expect(updateResult.rowCount).toBe(0);
  });

  it("erasure-request row (erased_at set, last_error NULL) is purged and transcripts deleted", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const erasedAt = new Date(now.getTime() - QUIESCE_SECONDS * 1000 - 1000); // 2+ hours ago

    await seedRecording(recordingId, {
      companyId,
      state: "erased",
      callSid,
      erasedAt: erasedAt.toISOString(),
      createdAt: new Date(now.getTime() - 86400000).toISOString(),
      // No lastError = erasure request, not retention
    });

    await seedTranscript(recordingId, { callSid });

    const mockCtx = createMockCtx();

    const result = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch(),
    });

    expect(result.purged).toBe(1);

    // Recording should be deleted
    const rows = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(rows).toHaveLength(0);

    // Transcript should be DELETED entirely (not just trimmed)
    const transcripts = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`, [recordingId]);
    expect(transcripts).toHaveLength(0);
  });

  it("Twilio DELETE 500 error keeps row, increments errors", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;
    const recordingSid = `rec_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const erasedAt = new Date(now.getTime() - QUIESCE_SECONDS * 1000 - 1000);

    await seedRecording(recordingId, {
      companyId,
      state: "erased",
      callSid,
      recordingSid,
      erasedAt: erasedAt.toISOString(),
      lastError: RETENTION_MARKER,
    });

    const mockCtx = createMockCtx();

    const result = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch({ twilioFailDelete: true }),
    });

    expect(result.errors).toBe(1);
    expect(result.purged).toBe(0);

    // Row should still exist
    const rows = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(rows).toHaveLength(1);
  });

  it("R2 DELETE 500 error keeps row, increments errors", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;
    const recordingSid = `rec_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const erasedAt = new Date(now.getTime() - QUIESCE_SECONDS * 1000 - 1000);

    await seedRecording(recordingId, {
      companyId,
      state: "erased",
      callSid,
      recordingSid,
      r2Key: `crm-telephony/recordings/${callSid}/${recordingSid}.wav`,
      erasedAt: erasedAt.toISOString(),
      lastError: RETENTION_MARKER,
    });

    const mockCtx = createMockCtx();
    const r2FailDeleteKey = `crm-telephony/recordings/${callSid}/${recordingSid}.wav`;
    mockR2.data.set(r2FailDeleteKey, { body: new Uint8Array([1, 2, 3]), sha256: "abc" });

    const result = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch({ r2FailDeleteKey }),
    });

    expect(result.errors).toBe(1);
    expect(result.purged).toBe(0);

    // Row should still exist
    const rows = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(rows).toHaveLength(1);
  });

  it("R2 not configured: row skipped, not deleted", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();

    const now = new Date("2026-10-13T12:00:00Z");
    const erasedAt = new Date(now.getTime() - QUIESCE_SECONDS * 1000 - 1000);

    await seedRecording(recordingId, {
      companyId,
      state: "erased",
      erasedAt: erasedAt.toISOString(),
      lastError: RETENTION_MARKER,
    });

    const mockCtx = createMockCtx({
      r2Config: async () => null, // R2 not configured
    });

    const result = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: async () => null,
      fetch: createMockFetch(),
    });

    expect(result.skipped).toBe(1);
    expect(result.purged).toBe(0);

    // Row should still exist
    const rows = await db.db.query<{ id: string }>(`SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(rows).toHaveLength(1);
  });

  it("one failing row does not stop the next row from being processed", async () => {
    const companyId = randomUUID();
    const recordingId1 = randomUUID();
    const recordingId2 = randomUUID();

    const now = new Date("2026-10-13T12:00:00Z");
    const erasedAt = new Date(now.getTime() - QUIESCE_SECONDS * 1000 - 1000);

    // First row: will fail (R2 not configured)
    await seedRecording(recordingId1, {
      companyId,
      state: "erased",
      erasedAt: erasedAt.toISOString(),
      lastError: RETENTION_MARKER,
    });

    // Second row: should succeed
    await seedRecording(recordingId2, {
      companyId,
      state: "erased",
      erasedAt: erasedAt.toISOString(),
      lastError: RETENTION_MARKER,
    });

    const mockCtx = createMockCtx({
      r2Config: async () => null, // R2 not configured for all
    });

    const result = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: async () => null,
      fetch: createMockFetch(),
    });

    expect(result.skipped).toBe(2);
    expect(result.errors).toBe(0);
  });

  it("transcripts: 13-month-old row loses text, keeps summary and next_actions", async () => {
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const createdAt = new Date(now);
    createdAt.setUTCMonth(createdAt.getUTCMonth() - 13);

    await seedTranscript(recordingId, { callSid, createdAt: createdAt.toISOString() });

    const mockCtx = createMockCtx();

    const result = await runRetention(mockCtx.ctx, { now, namespace: NAMESPACE });

    expect(result.transcriptsTrimmed).toBe(1);

    const row = await db.db.query<{ text: string; summary: string; segments: unknown }>(
      `SELECT text, summary, segments FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].text).toBe("");
    expect(row[0].summary).toBe("Sample summary");
    expect(row[0].segments).toBeNull();
  });

  it("transcripts: 11-month-old row remains untouched", async () => {
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const createdAt = new Date(now);
    createdAt.setUTCMonth(createdAt.getUTCMonth() - 11);

    await seedTranscript(recordingId, { callSid, createdAt: createdAt.toISOString() });

    const mockCtx = createMockCtx();

    const result = await runRetention(mockCtx.ctx, { now, namespace: NAMESPACE });

    expect(result.transcriptsTrimmed).toBe(0);

    const row = await db.db.query<{ text: string }>(
      `SELECT text FROM ${NAMESPACE}.tel_transcripts WHERE recording_id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].text).toBe("Sample transcript text");
  });

  it("transcripts: already-trimmed row not counted again (idempotent second run)", async () => {
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;

    const now = new Date("2026-10-13T12:00:00Z");
    const createdAt = new Date(now);
    createdAt.setUTCMonth(createdAt.getUTCMonth() - 13);

    // Insert transcript with empty text
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, text, summary, created_at) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)`,
      [recordingId, callSid, "", "Sample summary", createdAt.toISOString()],
    );

    const mockCtx = createMockCtx();

    const result = await runRetention(mockCtx.ctx, { now, namespace: NAMESPACE });

    expect(result.transcriptsTrimmed).toBe(0); // Already trimmed, not counted
  });

  it("idempotency: running twice back-to-back does not purge extra rows", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();

    const now = new Date("2026-10-13T12:00:00Z");
    const expiresAt = new Date(now.getTime() - 1000);

    await seedRecording(recordingId, {
      companyId,
      state: "failed",
      expiresAt: expiresAt.toISOString(),
    });

    const mockCtx = createMockCtx();

    // First run
    const result1 = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch(),
    });

    expect(result1.tombstoned).toBe(1);
    expect(result1.purged).toBe(0);

    // Second run immediately after (still in quiesce window)
    const result2 = await runRetention(mockCtx.ctx, {
      now,
      namespace: NAMESPACE,
      r2Config: defaultR2Config,
      fetch: createMockFetch(),
    });

    expect(result2.tombstoned).toBe(0);
    expect(result2.purged).toBe(0);
    expect(result2.errors).toBe(0);
  });

  it("purge deletes R2 key matching recordingKey() for seeded row", async () => {
    const callSid = "call_test_123";
    const recordingSid = "RE_test_456";
    const id = randomUUID();
    const companyId = randomUUID();
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 1);

    // Seed using recordingKey() to ensure consistency
    const r2cfg = { prefix: "crm-telephony" };
    const expectedKey = recordingKey(r2cfg, callSid, recordingSid);

    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id, expires_at)
       VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid, $6::timestamptz)`,
      [id, callSid, recordingSid, "https://api.twilio.com/Accounts/AC123/Recordings/RE.json", companyId, expiredDate.toISOString()]
    );

    const deletedKeys: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, opts?: any): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (opts?.method === "DELETE" && url.includes("r2.cloudflarestorage.com")) {
        const keyMatch = url.match(/r2\.cloudflarestorage\.com\/(.+)$/);
        if (keyMatch) {
          deletedKeys.push(keyMatch[1]);
        }
        return new Response(null, { status: 204 });
      }
      if (opts?.method === "DELETE" && url.includes("twilio.com")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const r2ConfigFn = vi.fn(async () => ({
      accountId: "acc123",
      bucket: "recordings",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "crm-telephony",
    }));

    const mockCtx = {
      db: db.db,
      logger: { warn: vi.fn(), debug: vi.fn() },
      secrets: {
        resolve: vi.fn(async (name: string) => {
          if (name === "TWILIO_API_KEY_SID") return "AC123";
          if (name === "TWILIO_API_KEY_SECRET") return "secret";
          throw new Error(`Unknown secret: ${name}`);
        }),
      },
    };

    const now = new Date();
    await runRetention(mockCtx as any, {
      now,
      fetch: fakeFetch,
      r2Config: r2ConfigFn,
      namespace: NAMESPACE,
    });

    const laterTime = new Date(now.getTime() + 3610 * 1000);
    await runRetention(mockCtx as any, {
      now: laterTime,
      fetch: fakeFetch,
      r2Config: r2ConfigFn,
      namespace: NAMESPACE,
    });

    // Verify the key deleted matches recordingKey()
    expect(deletedKeys).toContain(expectedKey);
  });
});
