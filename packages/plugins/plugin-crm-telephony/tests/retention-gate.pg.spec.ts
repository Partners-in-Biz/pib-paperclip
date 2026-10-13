import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRetention, retentionEnabledCompanyIds, RETENTION_MARKER } from "../src/retention.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";
import type { R2Config } from "../src/r2-store.js";

let db: Awaited<ReturnType<typeof startHostDb>>;

const NOW = new Date("2026-10-13T12:00:00Z");
const LONG_AGO = "2024-01-01T00:00:00Z";

async function seedRecording(opts: { companyId: string; state?: string; erasedAt?: string; lastError?: string }) {
  const id = randomUUID();
  const sid = `RE${id.replace(/-/g, "").slice(0, 20)}`;
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, company_id, erased_at, last_error)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::timestamptz, $8)`,
    [
      id,
      `CA${sid}`,
      sid,
      `https://api.twilio.com/2010-04-01/Accounts/AC0123456789abcdef0123456789abcd/Recordings/${sid}`,
      opts.state ?? "failed",
      opts.companyId,
      opts.erasedAt ?? null,
      opts.lastError ?? null,
    ],
  );
  await db.db.execute(
    `INSERT INTO ${NAMESPACE}.tel_transcripts (recording_id, call_sid, text, summary, created_at) VALUES ($1::uuid, $2, 'old text', 'summary', $3::timestamptz)`,
    [id, `CA${sid}`, LONG_AGO],
  );
  return id;
}

const r2Config = async (): Promise<R2Config | null> => ({
  accountId: "test.r2",
  bucket: "test-bucket",
  accessKeyId: "key",
  secretAccessKey: "secret",
  prefix: "crm-telephony",
});

const fakeFetch = (async () => new Response(undefined as any, { status: 204 })) as unknown as typeof fetch;

function ctxWith(configs: Record<string, Record<string, unknown>>) {
  return {
    db: db.db,
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    config: { get: async (companyId: string) => configs[companyId] ?? {} },
    secrets: { resolve: vi.fn(async () => "x") },
  } as any;
}

async function erasedAt(id: string) {
  const rows = await db.db.query<{ erased_at: string | null }>(
    `SELECT erased_at FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
    [id],
  );
  return rows[0]?.erased_at ?? "gone";
}

describe("retention gate (off by default, per company)", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.reset();
  });

  it("retentionEnabledCompanyIds: only companies with retentionEnabled === true", async () => {
    const on = randomUUID();
    const off = randomUUID();
    const missing = randomUUID();
    await seedRecording({ companyId: on });
    await seedRecording({ companyId: off });
    await seedRecording({ companyId: missing });
    const ctx = ctxWith({ [on]: { retentionEnabled: true }, [off]: { retentionEnabled: "yes" } });
    expect(await retentionEnabledCompanyIds(ctx, NAMESPACE)).toEqual([on]);
  });

  it("no company enabled: nothing is tombstoned, purged by retention or trimmed", async () => {
    const company = randomUUID();
    const failed = await seedRecording({ companyId: company, state: "failed" });
    const retained = await seedRecording({ companyId: company, state: "erased", erasedAt: "2026-10-01T00:00:00Z", lastError: RETENTION_MARKER });

    const result = await runRetention(ctxWith({}), { now: NOW, namespace: NAMESPACE, r2Config, fetch: fakeFetch, companyIds: [] });

    expect(result).toMatchObject({ tombstoned: 0, purged: 0, transcriptsTrimmed: 0 });
    expect(await erasedAt(failed)).toBeNull();
    expect(await erasedAt(retained)).not.toBe("gone");
  });

  it("only enabled companies are touched; erasure requests are purged regardless", async () => {
    const on = randomUUID();
    const off = randomUUID();
    const onRow = await seedRecording({ companyId: on, state: "failed" });
    const offRow = await seedRecording({ companyId: off, state: "failed" });
    const offErasure = await seedRecording({
      companyId: off,
      state: "erased",
      erasedAt: "2026-10-01T00:00:00Z",
      lastError: "erasure",
    });

    const result = await runRetention(ctxWith({}), { now: NOW, namespace: NAMESPACE, r2Config, fetch: fakeFetch, companyIds: [on] });

    expect(result.tombstoned).toBe(1);
    expect(await erasedAt(onRow)).not.toBeNull();
    expect(await erasedAt(offRow)).toBeNull();
    expect(await erasedAt(offErasure)).toBe("gone");
    expect(result.transcriptsTrimmed).toBe(1);
  });
});
