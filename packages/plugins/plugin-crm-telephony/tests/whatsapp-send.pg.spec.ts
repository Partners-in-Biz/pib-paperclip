import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import type { TelephonySettings } from "../src/settings.js";
import type { TwilioClient } from "../src/twilio-client.js";

let pgDb: PgDb;

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

function makeSettings(overrides?: Partial<TelephonySettings>): TelephonySettings {
  return {
    recordingEnabled: false,
    whatsappFrom: null,
    whatsappEnabled: true,
    smsEnabled: false,
    maxCallsPerDay: 50,
    maxSmsPerDay: 200,
    maxWhatsappPerDay: 200,
    recordingRetentionDays: 30,
    allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
    callerIds: [],
    voiceAllowedUserIds: [],
    usSmsCampaignStatus: "none",
    usMessagingServiceSid: null,
    smsHolidays: [],
    ...overrides,
  };
}

function makeFakeClient() {
  return {
    getContentTemplates: vi.fn(),
    sendMessage: vi.fn(async () => ({ ok: true, value: { sid: "SM123456789", status: "accepted" } })),
    updateMessageStatus: vi.fn(),
  } as any as TwilioClient;
}

describe("sendWhatsapp", () => {
  beforeAll(async () => { pgDb = await startPg(); }, 180_000);
  afterAll(async () => { await pgDb?.stop(); });
  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_messages CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_contact_prefs CASCADE`);
  });

  it("blocks opt-out", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, wa_opt_out_at) VALUES ($1, $2, $3)`,
      ["c1", "contact-1", new Date().toISOString()]
    );
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567",
    }, {
      companyId: "c1", userId: "u1", contactId: "contact-1", toE164: "+27829876543",
      kind: "service", body: "Hello",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("opted_out");
  });

  it("requires template outside window", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567",
    }, {
      companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543",
      kind: "marketing", body: "No template",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("window_closed_template_required");
  });

  it("allows freeform in 24h window", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const msgId = "550e8400-e29b-41d4-a716-446655440002";
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages
       (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msgId, "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received",
       oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567", now: () => now,
    }, {
      companyId: "c1", userId: "u1", contactId: "contact-1", toE164: "+27829876543",
      kind: "marketing", body: "Free-form",
    });
    expect(result.sent).toBe(true);
    if (result.sent) expect(result.messageId).toBeDefined();
  });

  it("inserts pending, updates with SID on success", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const msgId = "550e8400-e29b-41d4-a716-446655440003";
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages
       (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msgId, "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received",
       oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567", now: () => now,
    }, {
      companyId: "c1", userId: "u1", contactId: "contact-1", toE164: "+27829876543",
      kind: "marketing", body: "Test",
    });
    expect(result.sent).toBe(true);
    if (result.sent) {
      const rows = await pgDb.client.query(
        `SELECT provider_msg_id, status FROM ${NAMESPACE}.tel_messages WHERE id = $1`,
        [result.messageId]
      );
      expect((rows.rows as any)[0].provider_msg_id).toBe("SM123456789");
      expect((rows.rows as any)[0].status).toBe("queued");
    }
  });

  it("returns unknown_outcome on timeout, keeps pending", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const msgId = "550e8400-e29b-41d4-a716-446655440004";
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages
       (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msgId, "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received",
       oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const fakeClient = {
      getContentTemplates: vi.fn(),
      sendMessage: vi.fn(async () => { throw new Error("timeout"); }),
      updateMessageStatus: vi.fn(),
    } as any as TwilioClient;
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: fakeClient, settings: makeSettings(),
      fromWhatsapp: "+27821234567", now: () => now,
    }, {
      companyId: "c1", userId: "u1", contactId: "contact-1", toE164: "+27829876543",
      kind: "marketing", body: "Test",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("unknown_outcome");
    expect((fakeClient as any).sendMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks when whatsapp disabled", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(),
      settings: makeSettings({ whatsappEnabled: false }),
      fromWhatsapp: "+27821234567",
    }, {
      companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543",
      kind: "marketing", body: "Test",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("disabled");
  });

  it("rejects invalid E.164", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567",
    }, {
      companyId: "c1", userId: "u1", contactId: null, toE164: "invalid",
      kind: "marketing", body: "Test",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("bad_number");
  });

  it("isolates companies; different company inbound doesn't open window", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const msgId = "550e8400-e29b-41d4-a716-446655440005";
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages
       (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msgId, "c2", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM999", "received",
       oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const result = await sendWhatsapp({
      db: dbClient, namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(),
      fromWhatsapp: "+27821234567", now: () => now,
    }, {
      companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543",
      kind: "marketing", body: "Blocked",
    });
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("window_closed_template_required");
  });

  it("daily cap: send refused, client not called", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const dbClient = createMockDbClient(pgDb);
    const now = new Date();
    const fakeClient = makeFakeClient();
    for (let i = 0; i < 200; i++) {
      const uuid = `550e8400-e29b-41d4-a716-${(4466 + i).toString().padStart(12, "0")}`;
      await pgDb.client.query(
        `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, provider_msg_id, from_e164, to_e164, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuid, "c1", "whatsapp", "outbound", `S${i}`, "+27821234567", "+27829876543", "sent", now.toISOString()]
      );
    }
    const result = await sendWhatsapp(
      { db: dbClient, namespace: NAMESPACE, client: fakeClient, settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543", kind: "marketing", body: "T" }
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("cap_reached");
    expect(fakeClient.sendMessage).not.toHaveBeenCalled();
  });

  it("4xx with code 21211: returns bad_number, message marked failed", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["550e8400-e29b-41d4-a716-446655440006", "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received", oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const fakeClient = { sendMessage: vi.fn(async () => ({ ok: false, failure: { kind: "rejected", status: 400, code: 21211, error: "Bad" } })), getContentTemplates: vi.fn(), updateMessageStatus: vi.fn() } as any as TwilioClient;
    const result = await sendWhatsapp(
      { db: createMockDbClient(pgDb), namespace: NAMESPACE, client: fakeClient, settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543", kind: "marketing", body: "T" }
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("bad_number");
    expect(fakeClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("4xx with code 21614: returns bad_number", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["550e8400-e29b-41d4-a716-446655440008", "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received", oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const fakeClient = { sendMessage: vi.fn(async () => ({ ok: false, failure: { kind: "rejected", status: 400, code: 21614, error: "Bad" } })), getContentTemplates: vi.fn(), updateMessageStatus: vi.fn() } as any as TwilioClient;
    const result = await sendWhatsapp(
      { db: createMockDbClient(pgDb), namespace: NAMESPACE, client: fakeClient, settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543", kind: "marketing", body: "T" }
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe("bad_number");
  });

  it("auth failure: returns send_failed with failureKind", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["550e8400-e29b-41d4-a716-446655440009", "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received", oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const fakeClient = { sendMessage: vi.fn(async () => ({ ok: false, failure: { kind: "auth", status: 401, code: null, error: "Auth failed" } })), getContentTemplates: vi.fn(), updateMessageStatus: vi.fn() } as any as TwilioClient;
    const result = await sendWhatsapp(
      { db: createMockDbClient(pgDb), namespace: NAMESPACE, client: fakeClient, settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543", kind: "marketing", body: "T" }
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("send_failed");
      expect(result.failureKind).toBe("auth");
    }
  });

  it("rate_limited: returns send_failed with failureKind", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["550e8400-e29b-41d4-a716-446655440010", "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received", oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    const fakeClient = { sendMessage: vi.fn(async () => ({ ok: false, failure: { kind: "rate_limited", status: 429, code: null, error: "Rate limited" } })), getContentTemplates: vi.fn(), updateMessageStatus: vi.fn() } as any as TwilioClient;
    const result = await sendWhatsapp(
      { db: createMockDbClient(pgDb), namespace: NAMESPACE, client: fakeClient, settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: null, toE164: "+27829876543", kind: "marketing", body: "T" }
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("send_failed");
      expect(result.failureKind).toBe("rate_limited");
    }
  });

  it("audit hides PII", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_messages (id, company_id, channel, direction, to_e164, from_e164, provider_msg_id, status, received_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["550e8400-e29b-41d4-a716-446655440007", "c1", "whatsapp", "inbound", "+27821234567", "+27829876543", "SM000", "received", oneHourAgo.toISOString(), oneHourAgo.toISOString()]
    );
    await sendWhatsapp(
      { db: createMockDbClient(pgDb), namespace: NAMESPACE, client: makeFakeClient(), settings: makeSettings(), fromWhatsapp: "+27821234567", now: () => now },
      { companyId: "c1", userId: "u1", contactId: "c1", toE164: "+27829876543", kind: "marketing", body: "SecretMsg" }
    );
    const rows = await pgDb.client.query(`SELECT detail FROM ${NAMESPACE}.tel_audit WHERE action = 'wa.send' AND company_id = $1`, ["c1"]);
    const detail = JSON.stringify((rows.rows as any)[0]?.detail || {});
    expect(detail).not.toContain("SecretMsg");
    expect(detail).not.toContain("+27829876543");
  });
});
