import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { insertOnce, type SqlExecutor } from "../src/idempotency.js";
import { startPg, type PgDb } from "./helpers/pg.js";

describe("insertOnce with Postgres", () => {
  let db: PgDb;
  let executor: SqlExecutor;

  beforeAll(async () => {
    db = await startPg();
    executor = {
      async execute(sql, params) {
        const result = await db.client.query(sql, params);
        return { rowCount: result.rowCount ?? 0 };
      },
    };
  });

  afterAll(async () => {
    if (db) await db.stop();
  });

  it("returns true for first call_sid, false for duplicate", async () => {
    const result1 = await insertOnce(executor, NAMESPACE, "call", {
      id: "00000000-0000-0000-0000-000000000001",
      call_sid: "call_001",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      user_id: "user1",
      company_id: "comp1",
      direction: "inbound",
    });
    expect(result1).toBe(true);

    const result2 = await insertOnce(executor, NAMESPACE, "call", {
      id: "00000000-0000-0000-0000-000000000002",
      call_sid: "call_001",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      user_id: "user2",
      company_id: "comp2",
      direction: "outbound",
    });
    expect(result2).toBe(false);
  });

  it("returns true for first recording_sid, false for duplicate", async () => {
    const result1 = await insertOnce(executor, NAMESPACE, "recording", {
      id: "00000000-0000-0000-0000-000000000011",
      call_sid: "call_rec1",
      recording_sid: "rec_001",
      twilio_url: "https://example.com/rec1",
    });
    expect(result1).toBe(true);

    const result2 = await insertOnce(executor, NAMESPACE, "recording", {
      id: "00000000-0000-0000-0000-000000000012",
      call_sid: "call_rec2",
      recording_sid: "rec_001",
      twilio_url: "https://example.com/rec2",
    });
    expect(result2).toBe(false);
  });

  it("returns true for first provider_msg_id, false for duplicate", async () => {
    const result1 = await insertOnce(executor, NAMESPACE, "message", {
      id: "00000000-0000-0000-0000-000000000021",
      provider_msg_id: "msg_001",
      company_id: "comp1",
      channel: "sms",
      direction: "inbound",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
    });
    expect(result1).toBe(true);

    const result2 = await insertOnce(executor, NAMESPACE, "message", {
      id: "00000000-0000-0000-0000-000000000022",
      provider_msg_id: "msg_001",
      company_id: "comp2",
      channel: "whatsapp",
      direction: "outbound",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
    });
    expect(result2).toBe(false);
  });

  it("supports different SIDs in same table", async () => {
    const r1 = await insertOnce(executor, NAMESPACE, "call", {
      id: "00000000-0000-0000-0000-000000000031",
      call_sid: "call_unique_1",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      user_id: "user1",
      company_id: "comp1",
      direction: "inbound",
    });
    expect(r1).toBe(true);

    const r2 = await insertOnce(executor, NAMESPACE, "call", {
      id: "00000000-0000-0000-0000-000000000032",
      call_sid: "call_unique_2",
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      user_id: "user2",
      company_id: "comp2",
      direction: "outbound",
    });
    expect(r2).toBe(true);
  });
});
