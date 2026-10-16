import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";

let pgDb: PgDb;

// Mock PluginDatabaseClient wrapping the test database
function createMockDbClient(pgDb: PgDb): PluginDatabaseClient {
  return {
    namespace: NAMESPACE,
    query: async (sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return (result.rows || []) as any[];
    },
    execute: async (sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return { rowCount: result.rowCount || 0 };
    },
  };
}

describe("24h communication window", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_messages CASCADE`);
  });

  it("recognizes message within 24h window", async () => {
    const dbClient = createMockDbClient(pgDb);
    const { insertOnce } = await import("../src/idempotency.js");
    const { isWindowOpen } = await import("../src/wa-window.js");

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Insert message 1 hour ago
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM123",
      contact_id: null,
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      body: "Hello",
      status: "received",
      received_at: oneHourAgo,
    });

    const isOpen = await isWindowOpen(dbClient, NAMESPACE, "company-1", "+27821234567", now);
    expect(isOpen).toBe(true);
  });

  it("excludes message outside 24h window", async () => {
    const dbClient = createMockDbClient(pgDb);
    const { insertOnce } = await import("../src/idempotency.js");
    const { isWindowOpen } = await import("../src/wa-window.js");

    const now = new Date();
    const oneDayOneHourAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);

    // Insert message 25 hours ago
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM456",
      contact_id: null,
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      body: "Old message",
      status: "received",
      received_at: oneDayOneHourAgo,
    });

    const isOpen = await isWindowOpen(dbClient, NAMESPACE, "company-1", "+27821234567", now);
    expect(isOpen).toBe(false);
  });

  it("returns true at 23h59m and false at 24h01m", async () => {
    const dbClient = createMockDbClient(pgDb);
    const { insertOnce } = await import("../src/idempotency.js");
    const { isWindowOpen } = await import("../src/wa-window.js");

    const messageTime = new Date("2024-01-01T12:00:00Z");

    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM789",
      contact_id: null,
      from_e164: "+27821234567",
      to_e164: "+27821234568",
      body: "Test",
      status: "received",
      received_at: messageTime,
    });

    // Check at 23h59m (just before 24h)
    const at23h59m = new Date("2024-01-02T11:59:59Z");
    const isOpenAt23h59m = await isWindowOpen(dbClient, NAMESPACE, "company-1", "+27821234567", at23h59m);
    expect(isOpenAt23h59m).toBe(true);

    // Check at 24h01m (just after 24h)
    const at24h01m = new Date("2024-01-02T12:01:00Z");
    const isOpenAt24h01m = await isWindowOpen(dbClient, NAMESPACE, "company-1", "+27821234567", at24h01m);
    expect(isOpenAt24h01m).toBe(false);
  });

  it("writes audit entry with detail", async () => {
    const dbClient = createMockDbClient(pgDb);
    const { writeAudit } = await import("../src/audit.js");

    await writeAudit(dbClient, NAMESPACE, {
      companyId: "company-1",
      userId: "system",
      action: "wa.inbound",
      contactId: null,
      detail: {
        sid: "SM123",
        from: "+27821234567",
        to: "+27821234568",
        numMedia: 0,
      },
    });

    const queryResult = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_audit WHERE action = 'wa.inbound'`,
    );
    const rows = queryResult.rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe("company-1");
    expect(rows[0].user_id).toBe("system");
    expect(rows[0].detail.sid).toBe("SM123");
  });
});
