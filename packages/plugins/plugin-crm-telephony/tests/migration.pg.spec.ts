import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { startPg, type PgDb } from "./helpers/pg.js";

describe("CRM Telephony migrations", () => {
  let db: PgDb;

  beforeAll(async () => {
    db = await startPg();
  });

  afterAll(async () => {
    await db.stop();
  });

  it("creates all 7 tel_* tables", async () => {
    const res = await db.client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1", [NAMESPACE]);
    const tableNames = (res.rows as unknown[])
      .map((r: unknown) => (r as { tablename: string }).tablename)
      .sort();
    expect(tableNames).toEqual(["tel_audit", "tel_calls", "tel_contact_prefs", "tel_messages", "tel_recordings", "tel_templates", "tel_transcripts"]);
  });

  it("has no FOREIGN KEY constraints", async () => {
    const res = await db.client.query(
      "SELECT COUNT(*) as count FROM pg_constraint WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) AND contype = 'f'",
      [NAMESPACE],
    );
    const count = ((res.rows as unknown[])[0] as { count: string }).count;
    expect(Number(count)).toBe(0);
  });

  it("tel_recordings has lease_token and next_attempt_at columns", async () => {
    const res = await db.client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tel_recordings' AND column_name IN ('lease_token', 'next_attempt_at') ORDER BY column_name",
      [NAMESPACE],
    );
    const cols = (res.rows as unknown[]).map((r: unknown) => (r as { column_name: string }).column_name);
    expect(cols).toEqual(["lease_token", "next_attempt_at"]);
  });

  it("duplicate recording_sid violates unique constraint", async () => {
    const id1 = "00000000-0000-0000-0000-000000000001";
    const id2 = "00000000-0000-0000-0000-000000000002";
    await db.client.query(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url) VALUES ($1, 'cs1', 'rs1', 'http://test')`, [id1]);
    await expect(
      db.client.query(`INSERT INTO ${NAMESPACE}.tel_recordings (id, call_sid, recording_sid, twilio_url) VALUES ($1, 'cs2', 'rs1', 'http://test')`, [id2]),
    ).rejects.toThrow();
  });

  it("tel_recordings has company_id and dead_issue_id columns", async () => {
    const res = await db.client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tel_recordings' AND column_name IN ('company_id', 'dead_issue_id') ORDER BY column_name",
      [NAMESPACE],
    );
    const cols = (res.rows as unknown[]).map((r: unknown) => (r as { column_name: string }).column_name);
    expect(cols).toEqual(["company_id", "dead_issue_id"]);
  });
});
