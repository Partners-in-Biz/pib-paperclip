import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimRecordings, releaseLease, type LeaseDb } from "../src/lease.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("lease management on real Postgres", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.reset();
  });

  it("migration applies all 7 tables with correct schema", async () => {
    // Check that all tables exist and have no FOREIGN KEY constraints
    const tables = (await pg.client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = '${NAMESPACE}' ORDER BY tablename`,
    )).rows as Array<{ tablename: string }>;

    expect(tables.map((t) => t.tablename).sort()).toEqual([
      "tel_audit",
      "tel_calls",
      "tel_contact_prefs",
      "tel_messages",
      "tel_recordings",
      "tel_templates",
      "tel_transcripts",
    ]);

    // Verify tel_recordings has lease columns
    const cols = (await pg.client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = '${NAMESPACE}' AND table_name = 'tel_recordings' ORDER BY column_name`,
    )).rows as Array<{ column_name: string }>;
    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain("lease_token");
    expect(colNames).toContain("next_attempt_at");

    // Verify no FOREIGN KEY constraints exist
    const constraints = (await pg.client.query(
      `SELECT constraint_type FROM information_schema.table_constraints WHERE table_schema = '${NAMESPACE}' AND constraint_type = 'FOREIGN KEY'`,
    )).rows as Array<{ constraint_type: string }>;
    expect(constraints).toHaveLength(0);
  });

  it("claimRecordings locks and claims non-erased rows in correct states", async () => {
    // Seed 5 'received' rows
    const rowIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      await pg.client.query(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state)
        VALUES ($1, $2, $3, $4, 'received')`, [id, `call_${i}`, `rec_${i}`, `http://example.com/${i}`]);
      rowIds.push(id);
    }

    // Claim 3 rows
    const result = await claimRecordings(pg.db, {
      namespace: NAMESPACE,
      states: ["received"],
      limit: 3,
      leaseSeconds: 300,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.token).toBeDefined();
    expect(result.rows.every((r) => r.state === "received")).toBe(true);

    // Verify claimed rows have the lease token in DB
    const leased = (await pg.client.query(
      `SELECT id, lease_token FROM ${NAMESPACE}.tel_recordings WHERE lease_token = $1`,
      [result.token],
    )).rows as Array<{ id: string; lease_token: string }>;
    expect(leased).toHaveLength(3);
    expect(leased.every((r) => r.lease_token === result.token)).toBe(true);
  });

  it("double-claim race: concurrent claimers with different tokens get disjoint sets", async () => {
    // 10 rounds of concurrency test
    for (let round = 0; round < 10; round++) {
      await pg.reset();

      // Seed 20 'received' rows due now
      for (let i = 0; i < 20; i++) {
        await pg.client.query(
          `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
          VALUES ($1, $2, $3, $4, 'received', now())`,
          [randomUUID(), `call_${i}`, `rec_${i}`, `http://example.com/${i}`],
        );
      }

      // Run 4 concurrent claimers with limit 20 and distinct tokens
      const claimers = Array.from({ length: 4 }, async () =>
        claimRecordings(pg.db, {
          namespace: NAMESPACE,
          states: ["received"],
          limit: 20,
          leaseSeconds: 300,
        }),
      );

      const results = await Promise.all(claimers);

      // Check that claimed id sets are pairwise disjoint
      const claimedIdSets = results.map((r) => new Set(r.rows.map((row) => row.id)));
      for (let i = 0; i < claimedIdSets.length; i++) {
        for (let j = i + 1; j < claimedIdSets.length; j++) {
          const intersection = [...claimedIdSets[i]].filter((id) => claimedIdSets[j].has(id));
          expect(intersection).toHaveLength(0);
        }
      }

      // Check that union equals the seed set
      const allClaimedIds = new Set<string>();
      for (const set of claimedIdSets) {
        for (const id of set) allClaimedIds.add(id);
      }
      expect(allClaimedIds.size).toBe(20);

      // Check each row has exactly one lease_token in DB
      const dbRows = (await pg.client.query(
        `SELECT id, lease_token FROM ${NAMESPACE}.tel_recordings WHERE lease_token IS NOT NULL`,
      )).rows as Array<{ id: string; lease_token: string }>;
      expect(dbRows.length).toBe(20);
      const tokenMap = new Map<string, string[]>();
      for (const row of dbRows) {
        if (!tokenMap.has(row.lease_token)) tokenMap.set(row.lease_token, []);
        tokenMap.get(row.lease_token)!.push(row.id);
      }
      for (const [, ids] of tokenMap) {
        for (const id of ids) {
          expect(dbRows.filter((r) => r.id === id)).toHaveLength(1);
        }
      }
    }
  });

  it("single-row double-claim: exactly one claimer gets the row", async () => {
    const id = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'received', now())`,
      [id, "call_0", "rec_0", "http://example.com"],
    );

    // Race two claimers on the same row
    const claims = await Promise.all([
      claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 1, leaseSeconds: 300 }),
      claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 1, leaseSeconds: 300 }),
    ]);

    const claimed = claims.filter((c) => c.rows.length > 0);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].rows[0].id).toBe(id);
  });

  it("rows with future next_attempt_at are not claimed", async () => {
    const futureId = randomUUID();
    const dueId = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'received', now() + interval '1 hour')`,
      [futureId, "call_future", "rec_future", "http://example.com"],
    );
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'received', now())`,
      [dueId, "call_due", "rec_due", "http://example.com"],
    );

    const result = await claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(dueId);
  });

  it("rows with erased_at set are not claimed", async () => {
    const erasedId = randomUUID();
    const aliveId = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, erased_at)
      VALUES ($1, $2, $3, $4, 'received', now())`,
      [erasedId, "call_erased", "rec_erased", "http://example.com"],
    );
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state)
      VALUES ($1, $2, $3, $4, 'received')`,
      [aliveId, "call_alive", "rec_alive", "http://example.com"],
    );

    const result = await claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(aliveId);
  });

  it("rows with unexpired lease are not reclaimable; expired lease IS reclaimable", async () => {
    const id = randomUUID();
    const token1 = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, lease_token, lease_until)
      VALUES ($1, $2, $3, $4, 'received', $5, now() + interval '1 hour')`,
      [id, "call_0", "rec_0", "http://example.com", token1],
    );

    // Try to claim with different token; should fail (row is locked under another token)
    const result1 = await claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(result1.rows).toHaveLength(0);

    // Expire the lease
    await pg.client.query(
      `UPDATE ${NAMESPACE}.tel_recordings SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

    // Now it should be claimable
    const result2 = await claimRecordings(pg.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(result2.rows).toHaveLength(1);
    expect(result2.rows[0].id).toBe(id);
  });

  it("re-querying with same token returns already-leased rows (crash retry)", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'received', now())`,
      [id1, "call_1", "rec_1", "http://example.com"],
    );
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
      VALUES ($1, $2, $3, $4, 'received', now())`,
      [id2, "call_2", "rec_2", "http://example.com"],
    );

    // First claim without explicit token (generates random token)
    const firstClaim = await claimRecordings(pg.db, {
      namespace: NAMESPACE,
      states: ["received"],
      limit: 1,
      leaseSeconds: 300,
    });
    expect(firstClaim.rows).toHaveLength(1);
    const claimedId = firstClaim.rows[0].id;
    const token = firstClaim.token;

    // Re-claim with same token (simulating crash retry)
    // Should NOT claim new rows, just return the already-leased ones
    const secondClaim = await claimRecordings(pg.db, {
      namespace: NAMESPACE,
      states: ["received"],
      limit: 1,
      leaseSeconds: 300,
      token,
    });

    // Should return the same row, not claim the second unclaimed row
    expect(secondClaim.rows).toHaveLength(1);
    expect(secondClaim.rows[0].id).toBe(claimedId);
  });

  it("releaseLease clears lease and applies patch only when token matches", async () => {
    const id = randomUUID();
    const token = randomUUID();
    const wrongToken = randomUUID();
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, lease_token, lease_until)
      VALUES ($1, $2, $3, $4, 'received', $5, now() + interval '1 hour')`,
      [id, "call_0", "rec_0", "http://example.com", token],
    );

    // Release with wrong token; should do nothing
    await releaseLease(pg.db, {
      namespace: NAMESPACE,
      token: wrongToken,
      id,
      patch: { state: "downloaded" },
    });

    let row = (await pg.client.query(`SELECT lease_token, state FROM ${NAMESPACE}.tel_recordings WHERE id = $1`, [id])).rows as Array<{
      lease_token: string;
      state: string;
    }>;
    expect(row[0].lease_token).toBe(token);
    expect(row[0].state).toBe("received");

    // Release with correct token and patch
    await releaseLease(pg.db, {
      namespace: NAMESPACE,
      token,
      id,
      patch: { state: "downloaded", attempts: 5, lastError: "test error" },
    });

    const releasedRow = (await pg.client.query(
      `SELECT lease_token, state, attempts, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1`,
      [id],
    )).rows as Array<{ lease_token: string | null; state: string; attempts: number; last_error: string }>;
    expect(releasedRow[0].lease_token).toBeNull();
    expect(releasedRow[0].state).toBe("downloaded");
    expect(releasedRow[0].attempts).toBe(5);
    expect(releasedRow[0].last_error).toBe("test error");
  });
});
