import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimRecordings, releaseLease } from "../src/lease.js";
import { NAMESPACE } from "../src/namespace.js";
import { startHostDb } from "./helpers/host-db.js";

let db: any;
describe("lease management", () => {
  beforeAll(async () => {
    db = await startHostDb();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  it("concurrent claimers get disjoint id sets", async () => {
    for (let r = 0; r < 3; r++) {
      await db.reset();
      for (let i = 0; i < 20; i++)
        await db.db.execute(
          `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
           VALUES ($1::uuid, $2, $3, $4, 'received', now())`,
          [randomUUID(), `call_${i}`, `rec_${i}`, `http://ex.com/${i}`],
        );

      const results = await Promise.all(
        Array.from({ length: 4 }, () => claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 20, leaseSeconds: 300 })),
      );

      const sets = results.map((r) => new Set(r.rows.map((x) => x.id)));
      for (let i = 0; i < sets.length; i++)
        for (let j = i + 1; j < sets.length; j++) expect([...sets[i]].filter((x) => sets[j].has(x))).toHaveLength(0);

      const all = new Set<string>();
      for (const s of sets) for (const id of s) all.add(id);
      expect(all.size).toBe(20);
    }
  });

  it("expired lease reclaimable, unexpired not", async () => {
    const id = randomUUID();
    await db.db.execute(
      `INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, lease_token, lease_until)
       VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid, now() + interval '1 hour')`,
      [id, "call_0", "rec_0", "http://ex.com", randomUUID()],
    );

    expect((await claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 })).rows).toHaveLength(0);

    await db.db.execute(`UPDATE ${NAMESPACE}.tel_recordings SET lease_until = now() - interval '1 second' WHERE id = $1::uuid`, [id]);
    const r = await claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(id);
  });

  it("erased_at and future next_attempt_at skipped", async () => {
    const [erased, future, due] = [randomUUID(), randomUUID(), randomUUID()];
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, erased_at)
     VALUES ($1::uuid, $2, $3, $4, 'received', now())`, [erased, "e", "e", "http://ex.com"]);
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
     VALUES ($1::uuid, $2, $3, $4, 'received', now() + interval '1 hour')`, [future, "f", "f", "http://ex.com"]);
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
     VALUES ($1::uuid, $2, $3, $4, 'received', now())`, [due, "d", "d", "http://ex.com"]);

    const r = await claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 10, leaseSeconds: 300 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(due);
  });

  it("explicit token crash retry", async () => {
    const [id1, id2] = [randomUUID(), randomUUID()];
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
     VALUES ($1::uuid, $2, $3, $4, 'received', now())`, [id1, "c1", "r1", "http://ex.com"]);
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, next_attempt_at)
     VALUES ($1::uuid, $2, $3, $4, 'received', now())`, [id2, "c2", "r2", "http://ex.com"]);

    const first = await claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 1, leaseSeconds: 300 });
    expect(first.rows).toHaveLength(1);

    const second = await claimRecordings(db.db, { namespace: NAMESPACE, states: ["received"], limit: 1, leaseSeconds: 300, token: first.token });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].id).toBe(first.rows[0].id);
  });

  it("releaseLease token validation", async () => {
    const [id, token, wrong] = [randomUUID(), randomUUID(), randomUUID()];
    await db.db.execute(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url, state, lease_token, lease_until)
     VALUES ($1::uuid, $2, $3, $4, 'received', $5::uuid, now() + interval '1 hour')`, [id, "c", "r", "http://ex.com", token]);

    await releaseLease(db.db, { namespace: NAMESPACE, token: wrong, id, patch: { state: "downloaded" } });
    let row = await db.db.query(`SELECT lease_token, state FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [id]);
    expect(row[0].lease_token).toBe(token);

    await releaseLease(db.db, { namespace: NAMESPACE, token, id, patch: { state: "downloaded", attempts: 5, lastError: "e" } });
    row = await db.db.query(`SELECT lease_token, state, attempts, last_error FROM ${NAMESPACE}.tel_recordings WHERE id = $1::uuid`, [id]);
    expect(row[0].lease_token).toBeNull();
    expect(row[0].state).toBe("downloaded");
    expect(row[0].attempts).toBe(5);
  });

  it("regression: Postgres rejects array in ANY, scalar IN works", async () => {
    // Prove ANY($1::text[]) with array param fails, while IN($1,$2) with scalars works
    await expect(db.db.unguardedQuery("SELECT 1 WHERE 'a' = ANY($1::text[])", [["a", "b"]])).rejects.toThrow();
    const result = await db.db.unguardedQuery("SELECT 1 WHERE 'a' IN ($1, $2)", ["a", "b"]);
    expect(result).toHaveLength(1);
  });
});
