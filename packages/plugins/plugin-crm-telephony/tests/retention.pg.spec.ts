import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRetention } from "../src/retention.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

let db: any;

describe("retention purge", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  it("deletes only the expired recording's R2 key when multiple recordings share same call_sid", async () => {
    const callSid = "call_12345";
    const recordingSid1 = "RE00000000000000000000001";
    const recordingSid2 = "RE00000000000000000000002";
    const id1 = randomUUID();
    const id2 = randomUUID();
    const companyId = randomUUID();

    // Insert two recordings under the same call_sid
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 1);

    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id, expires_at)
       VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid, $6::timestamptz)`,
      [id1, callSid, recordingSid1, "https://api.twilio.com/Accounts/AC123/Recordings/RE1.json", companyId, expiredDate.toISOString()]
    );

    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id)
       VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid)`,
      [id2, callSid, recordingSid2, "https://api.twilio.com/Accounts/AC123/Recordings/RE2.json", companyId]
    );

    // Mock fetch to track R2 delete calls
    const deletedKeys: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, opts?: any): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (opts?.method === "DELETE" && url.includes("r2.cloudflarestorage.com")) {
        deletedKeys.push(url);
        return new Response(null, { status: 204 });
      }
      if (opts?.method === "DELETE" && url.includes("twilio.com")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    // Mock R2 config
    const r2ConfigFn = vi.fn(async () => ({
      accountId: "acc123",
      bucket: "recordings",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "crm-telephony",
    }));

    // Mock secrets
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

    // Run retention job in two phases:
    // Phase 1: Tombstone the expired rows
    const now = new Date();
    let result = await runRetention(mockCtx as any, {
      now,
      fetch: fakeFetch,
      r2Config: r2ConfigFn,
      namespace: NAMESPACE,
    });

    // Verify that the first recording was tombstoned
    expect(result.tombstoned).toBeGreaterThan(0);

    // Phase 2: Purge the tombstoned rows (must wait QUIESCE_SECONDS after tombstone)
    const laterTime = new Date(now.getTime() + 3610 * 1000);  // 1 hour and 10 seconds later
    result = await runRetention(mockCtx as any, {
      now: laterTime,
      fetch: fakeFetch,
      r2Config: r2ConfigFn,
      namespace: NAMESPACE,
    });

    // Verify that the expired recording's key was deleted
    const expectedKey1 = `https://recordings.acc123.r2.cloudflarestorage.com/crm-telephony/recordings/${callSid}/${recordingSid1}.wav`;
    expect(deletedKeys.some(k => k === expectedKey1)).toBe(true);

    // Verify that the second recording's key was NOT deleted (it's not expired)
    const expectedKey2 = `https://recordings.acc123.r2.cloudflarestorage.com/crm-telephony/recordings/${callSid}/${recordingSid2}.wav`;
    expect(deletedKeys.some(k => k === expectedKey2)).toBe(false);

    // Verify that only the expired recording was purged from DB
    const remaining = await db.db.query(
      `SELECT id FROM ${NAMESPACE}.tel_recordings WHERE erased_at IS NULL`,
      []
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(id2);
  });

  it("keeps row and counts error when Twilio URL is unparseable", async () => {
    const id = randomUUID();
    const companyId = randomUUID();
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 1);

    // Insert recording with unparseable Twilio URL
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id, expires_at)
       VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid, $6::timestamptz)`,
      [id, "call_xyz", "rec_xyz", "https://invalid.example.com/no-accounts-path", companyId, expiredDate.toISOString()]
    );

    // First tombstone it
    const now = new Date();
    const quiesceTime = new Date(now.getTime() - 3600 * 1000);

    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_recordings SET erased_at = $1::timestamptz, state = 'erased' WHERE id = $2::uuid`,
      [quiesceTime.toISOString(), id]
    );

    // Mock fetch for R2
    const fakeFetch = vi.fn(async (input: string | URL | Request, opts?: any): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (opts?.method === "DELETE" && url.includes("r2.cloudflarestorage.com")) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    // Mock R2 config
    const r2ConfigFn = vi.fn(async () => ({
      accountId: "acc123",
      bucket: "recordings",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "crm-telephony",
    }));

    const warningLogs: string[] = [];
    const mockCtx = {
      db: db.db,
      logger: {
        warn: (msg: string) => warningLogs.push(msg),
        debug: vi.fn(),
      },
      secrets: {
        resolve: vi.fn(async (name: string) => {
          if (name === "TWILIO_API_KEY_SID") return "AC123";
          if (name === "TWILIO_API_KEY_SECRET") return "secret";
          throw new Error(`Unknown secret: ${name}`);
        }),
      },
    };

    // Run purge
    const result = await runRetention(mockCtx as any, {
      now,
      fetch: fakeFetch,
      r2Config: r2ConfigFn,
      namespace: NAMESPACE,
    });

    // Verify error was counted
    expect(result.errors).toBeGreaterThan(0);

    // Verify row was NOT purged
    expect(result.purged).toBe(0);

    // Verify row still exists in DB
    const remaining = await db.db.query(
      `SELECT id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [id]
    );
    expect(remaining).toHaveLength(1);

    // Verify warning was logged
    expect(warningLogs.some(w => w.includes("Unparseable Twilio URL"))).toBe(true);
  });
});
