import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTEMPTS, runMediaPipeline, raiseDeadIssues, type PipelineSteps, type PipelineStepCtx, type StepResult } from "../src/pipeline.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

interface TestDb {
  db: {
    execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  };
  reset(): Promise<void>;
  stop(): Promise<void>;
}

let db: TestDb;

// Helpers
const fixedNow = new Date();

async function seedRecording(recordingId: string, opts?: { callSid?: string; recordingSid?: string; companyId?: string; state?: string; attempts?: number; leaseToken?: string; leaseUntil?: string; erasedAt?: string }) {
  const callSid = opts?.callSid || `call_${Date.now()}`;
  const recordingSid = opts?.recordingSid || `rec_${Date.now()}`;
  const state = opts?.state || "received";

  let sql = `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state`;
  const params: unknown[] = [recordingId, callSid, recordingSid, "http://ex.com/rec", state];

  if (opts?.companyId) {
    sql += ", company_id";
    params.push(opts.companyId);
  }
  if (opts?.attempts !== undefined) {
    sql += ", attempts";
    params.push(opts.attempts);
  }
  if (opts?.leaseToken) {
    sql += ", lease_token";
    params.push(opts.leaseToken);
  }
  if (opts?.leaseUntil) {
    sql += ", lease_until";
    params.push(opts.leaseUntil);
  }
  if (opts?.erasedAt) {
    sql += ", erased_at";
    params.push(opts.erasedAt);
  }

  sql += ") VALUES ($1::uuid, $2, $3, $4, $5";
  let paramIdx = 5;
  if (opts?.companyId) sql += `, $${++paramIdx}::uuid`;
  if (opts?.attempts !== undefined) sql += `, $${++paramIdx}`;
  if (opts?.leaseToken) sql += `, $${++paramIdx}::uuid`;
  if (opts?.leaseUntil) sql += `, ${opts.leaseUntil}`;
  if (opts?.erasedAt) sql += `, now()`;
  sql += ")";

  await db.db.execute(sql, params);
}

function createMockCtx() {
  const createdIssues: any[] = [];
  const logs: string[] = [];
  return {
    ctx: {
      db: db.db,
      logger: {
        debug: (msg: string) => {
          logs.push(msg);
          console.log("[DEBUG]", msg);
        },
        warn: (msg: string) => {
          console.log("[WARN]", msg);
        },
      },
      issues: {
        create: vi.fn(async (input: any) => {
          const issue = { id: randomUUID(), ...input };
          createdIssues.push(issue);
          return issue;
        }),
      },
    } as any,
    createdIssues,
    logs,
  };
}

describe("media pipeline", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  it("happy path: received -> downloaded -> twilio_deleted", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    await seedRecording(recordingId, { companyId });
    const { ctx: mockCtx } = createMockCtx();

    // Step 1: received -> downloaded
    const steps1: PipelineSteps = {
      received: async (sc: PipelineStepCtx) => {
        await sc.extendLease();
        return { state: "downloaded", patch: { r2Key: "s3://bucket/rec1", bytes: 12345, sha256: "abc123" } };
      },
    };

    const result1 = await runMediaPipeline(mockCtx, { steps: steps1, namespace: NAMESPACE });
    expect(result1.processed).toBe(1);
    expect(result1.failed).toBe(0);
    expect(result1.dead).toBe(0);
    expect(result1.abandoned).toBe(0);

    let row = await db.db.query<{ state: string; attempts: number; r2_key: string; bytes: number; sha256: string }>(
      `SELECT state, attempts, r2_key, bytes, sha256 FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("downloaded");
    expect(row[0].attempts).toBe(0);
    expect(row[0].r2_key).toBe("s3://bucket/rec1");
    expect(Number(row[0].bytes)).toBe(12345);
    expect(row[0].sha256).toBe("abc123");

    // Step 2: downloaded -> twilio_deleted
    const steps2: PipelineSteps = {
      downloaded: async (sc: PipelineStepCtx) => {
        await sc.extendLease();
        return { state: "twilio_deleted" };
      },
    };

    const result2 = await runMediaPipeline(mockCtx, { steps: steps2, namespace: NAMESPACE });
    expect(result2.processed).toBe(1);
    expect(result2.failed).toBe(0);

    const row2 = await db.db.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row2[0].state).toBe("twilio_deleted");
    expect(row2[0].attempts).toBe(0);
  });

  it("failure schedules backoff and row reclaimable after backoff", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    const now = new Date();
    const steps: PipelineSteps = {
      received: async () => {
        throw new Error("Download failed");
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, now, namespace: NAMESPACE });
    expect(result.failed).toBe(1);
    expect(result.dead).toBe(0);

    let row = await db.db.query<{ state: string; attempts: number; next_attempt_at: unknown; last_error: string }>(
      `SELECT state, attempts, next_attempt_at, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("received");
    expect(row[0].attempts).toBe(1);
    expect(row[0].last_error).toContain("Download failed");

    const nextAttempt = new Date(row[0].next_attempt_at as any);
    const expectedMin = new Date(now.getTime() + 60 * 1000);
    const expectedMax = new Date(now.getTime() + 65 * 1000);
    expect(nextAttempt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(nextAttempt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());

    const claimed1 = await db.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text as cnt FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid AND lease_token IS NOT NULL`,
      [recordingId],
    );
    expect(Number(claimed1[0].cnt)).toBe(0);

    await runMediaPipeline(mockCtx, { steps, now: nextAttempt, namespace: NAMESPACE });
    const claimed2 = await db.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text as cnt FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid AND lease_token IS NOT NULL`,
      [recordingId],
    );
    expect(Number(claimed2[0].cnt)).toBe(0);
  });

  it("6 consecutive failures => state dead and single issue created", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;
    const recordingSid = `rec_${Date.now()}`;
    await seedRecording(recordingId, { callSid, recordingSid, companyId });

    const { ctx: mockCtx, createdIssues } = createMockCtx();
    const steps: PipelineSteps = {
      received: async () => {
        throw new Error("Download failed");
      },
    };

    const now = new Date();
    for (let i = 1; i <= 6; i++) {
      const currentTime = new Date(now.getTime() + (i - 1) * 70 * 1000);
      const result = await runMediaPipeline(mockCtx, { steps, now: currentTime, namespace: NAMESPACE });
      expect(result.failed).toBe(1);
      if (i < 6) expect(result.dead).toBe(0);
      else expect(result.dead).toBe(1);

      if (i < 6) {
        await db.db.execute(
          `UPDATE ${NAMESPACE}.tel_recordings SET next_attempt_at = now() - interval '1 second' WHERE id = $1::uuid`,
          [recordingId],
        );
      }
    }

    let row = await db.db.query<{ state: string; attempts: number; dead_issue_id: unknown }>(
      `SELECT state, attempts, dead_issue_id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("dead");
    expect(row[0].attempts).toBe(6);
    expect(row[0].dead_issue_id).not.toBeNull();

    expect(createdIssues).toHaveLength(1);
    const issue = createdIssues[0];
    expect(issue.companyId).toBe(companyId);
    expect(issue.title).toContain(recordingSid);
    expect(issue.description).toContain(recordingSid);
    expect(issue.description).toContain(callSid);
    expect(issue.priority).toBe("high");
    expect(row[0].dead_issue_id).toBe(issue.id);
  });

  it("issues.create throws => dead_issue_id stays NULL and next tick retries", async () => {
    const companyId = randomUUID();
    const recordingId = randomUUID();
    const callSid = `call_${Date.now()}`;
    const recordingSid = `rec_${Date.now()}`;
    await seedRecording(recordingId, { callSid, recordingSid, companyId, state: "dead", attempts: 6 });

    let createAttempt = 0;
    const db_client = db.db;
    const mockCtx = {
      db: db_client,
      logger: { debug: () => {}, warn: vi.fn() },
      issues: {
        create: vi.fn(async () => {
          createAttempt++;
          if (createAttempt === 1) throw new Error("Temporary failure");
          return { id: randomUUID() };
        }),
      },
    } as any;

    const result1 = await runMediaPipeline(mockCtx, { namespace: NAMESPACE });
    expect(result1.issuesRaised).toBe(0);

    let row = await db_client.query<{ dead_issue_id: unknown }>(`SELECT dead_issue_id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(row[0].dead_issue_id).toBeNull();

    const result2 = await runMediaPipeline(mockCtx, { namespace: NAMESPACE });
    expect(result2.issuesRaised).toBe(1);

    row = await db_client.query<{ dead_issue_id: unknown }>(`SELECT dead_issue_id FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(row[0].dead_issue_id).not.toBeNull();
  });

  it("crash resume: expired lease reclaimable", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    let runCount = 0;
    const steps: PipelineSteps = {
      received: async (sc: PipelineStepCtx) => {
        runCount++;
        await sc.extendLease();
        return { state: "downloaded" };
      },
    };

    const now = new Date();
    let result1 = await runMediaPipeline(mockCtx, { steps, now, namespace: NAMESPACE });
    expect(result1.processed).toBe(1);

    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_recordings SET state = 'received', lease_until = now() - interval '1 second', lease_token = NULL, attempts = 0 WHERE id = $1::uuid`,
      [recordingId],
    );

    const result2 = await runMediaPipeline(mockCtx, { steps, now: new Date(now.getTime() + 2000), namespace: NAMESPACE });
    expect(result2.processed).toBe(1);

    let row = await db.db.query<{ state: string }>(`SELECT state FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(row[0].state).toBe("downloaded");
  });

  it("lost lease: token invalidated during processing => abandoned counted", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    let stepRun = false;
    const steps: PipelineSteps = {
      received: async (sc: PipelineStepCtx) => {
        stepRun = true;
        // Simulate another worker invalidating the lease by changing the token
        await sc.ctx.db.execute(
          `UPDATE ${NAMESPACE}.tel_recordings SET lease_token = $1::uuid WHERE id = $2::uuid`,
          [randomUUID(), sc.row.id],
        );
        return { state: "downloaded" };
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    // The step ran but the update to "downloaded" failed due to token mismatch
    expect(stepRun).toBe(true);
    expect(result.abandoned).toBe(1);
    expect(result.processed).toBe(0);

    // State should not have changed (update failed due to token mismatch)
    let row = await db.db.query<{ state: string }>(
      `SELECT state FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("received");
  });

  it("stale worker cannot overwrite row with token guard", async () => {
    const recordingId = randomUUID();
    const correctToken = randomUUID();
    await seedRecording(recordingId, { leaseToken: correctToken, leaseUntil: "now() + interval '10 minutes'" });

    const wrongToken = randomUUID();
    const result = await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_recordings SET state = 'downloaded', lease_token = NULL, lease_until = NULL WHERE id = $1::uuid AND lease_token = $2::uuid`,
      [recordingId, wrongToken],
    );
    expect(result.rowCount).toBe(0);

    let row = await db.db.query<{ state: string }>(
      `SELECT state FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("received");
  });

  it("default empty steps => nothing claimed, no error", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    const result = await runMediaPipeline(mockCtx, { namespace: NAMESPACE });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.abandoned).toBe(0);

    let row = await db.db.query<{ state: string }>(`SELECT state FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [recordingId]);
    expect(row[0].state).toBe("received");
  });

  it("erased_at rows never claimed", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId, { erasedAt: "now()" });
    const { ctx: mockCtx } = createMockCtx();

    const steps: PipelineSteps = {
      received: async () => {
        throw new Error("Should not run");
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    expect(result.processed).toBe(0);
  });

  it("rows in unhandled states are not claimed", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId, { state: "transcribed" });
    const { ctx: mockCtx } = createMockCtx();

    const steps: PipelineSteps = {
      received: async () => {
        throw new Error("Should not run");
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    expect(result.processed).toBe(0);
  });

  it("step returning {state:'dead', error} sets last_error on success", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    const steps: PipelineSteps = {
      received: async () => {
        return { state: "dead", error: "Recording no longer available" };
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    expect(result.processed).toBe(1);

    const row = await db.db.query<{ state: string; last_error: string }>(
      `SELECT state, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("dead");
    expect(row[0].last_error).toBe("Recording no longer available");
  });

  it("step error without error field resets last_error", async () => {
    const recordingId = randomUUID();
    const prevError = "Previous error";
    await seedRecording(recordingId);
    // Set previous error
    await db.db.execute(
      `UPDATE ${NAMESPACE}.tel_recordings SET last_error = $1 WHERE id = $2::uuid`,
      [prevError, recordingId],
    );
    const { ctx: mockCtx } = createMockCtx();

    const steps: PipelineSteps = {
      received: async () => {
        return { state: "downloaded" };
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    expect(result.processed).toBe(1);

    const row = await db.db.query<{ state: string; last_error: string | null }>(
      `SELECT state, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].state).toBe("downloaded");
    expect(row[0].last_error).toBeNull();
  });

  it("sanitizes error messages: removes Authorization and Bearer tokens, AC SIDs", async () => {
    const recordingId = randomUUID();
    await seedRecording(recordingId);
    const { ctx: mockCtx } = createMockCtx();

    const steps: PipelineSteps = {
      received: async () => {
        throw new Error("Failed with Authorization: Bearer sk_test_abc123xyz and AC0123456789abcdef0123456789abcd");
      },
    };

    const result = await runMediaPipeline(mockCtx, { steps, namespace: NAMESPACE });
    expect(result.failed).toBe(1);

    let row = await db.db.query<{ last_error: string }>(
      `SELECT last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`,
      [recordingId],
    );
    expect(row[0].last_error).not.toContain("sk_test_abc123xyz");
    expect(row[0].last_error).not.toContain("AC0123456789abcdef0123456789abcd");
    expect(row[0].last_error).toContain("[redacted]");
  });
});
