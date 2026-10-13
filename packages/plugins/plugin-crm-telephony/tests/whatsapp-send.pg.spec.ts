import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import { randomUUID } from "node:crypto";

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

describe("sendWhatsapp", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_messages CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_audit CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_contact_prefs CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_templates CASCADE`);
  });

  it("blocks when whatsapp is disabled", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);
    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: false,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("disabled");
    }

    // Verify audit was written
    const auditRows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_audit WHERE action = 'wa.send.blocked'`
    );
    expect(auditRows.rows).toHaveLength(1);
    const auditDetail = (auditRows.rows[0] as any).detail as Record<string, any>;
    expect(auditDetail.reason).toBe("disabled");
  });

  it("blocks when phone number is invalid", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);
    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "invalid-number",
        kind: "service",
        body: "Test",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("bad_number");
    }

    // No message should be created
    const messages = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_messages`
    );
    expect(messages.rows).toHaveLength(0);
  });

  it("blocks when contact is opted out", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);

    // Insert opt-out preference
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, wa_opt_out_at)
       VALUES ($1, $2, now())`,
      ["company-1", "contact-1"]
    );

    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("opted_out");
    }
  });

  it("blocks when daily cap is reached", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);

    // Use a time clearly within the SAST day (UTC+2)
    const now = new Date("2024-10-13T10:00:00Z"); // 12:00 SAST

    // Insert cap rows to reach the limit (cap is 200 by default)
    for (let i = 0; i < 200; i++) {
      await pgDb.client.query(
        `INSERT INTO ${NAMESPACE}.tel_messages
           (id, company_id, channel, direction, provider_msg_id, contact_id, from_e164, to_e164,
            status, kind, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(),
          "company-1",
          "whatsapp",
          "outbound",
          `sm${i}`,
          null,
          "+27821234567",
          "+27821234568",
          "failed",
          "service",
          now.toISOString(),
        ]
      );
    }

    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("cap_reached");
    }
  });

  it("allows freeform message when window is open", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = {
      sendMessage: vi.fn(async () => ({
        ok: true,
        value: { sid: "SM123456", status: "sent" },
      })),
    };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test response",
      }
    );

    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.providerMsgId).toBe("SM123456");
    }

    // Verify message was created and updated with real SID
    const messages = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_messages WHERE company_id = 'company-1' AND direction = 'outbound'`
    );
    expect(messages.rows).toHaveLength(1);
    const msg = messages.rows[0] as any;
    expect(msg.provider_msg_id).toBe("SM123456");
    expect(msg.status).toBe("sent");
    expect(msg.body).toBe("Test response");
  });

  it("blocks when window is closed and no template provided", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("window_closed_template_required");
    }
  });

  it("blocks when window is closed and template is not approved", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");
    const templateId = randomUUID();

    // Insert unapproved template
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_templates
         (id, company_id, channel, name, language, approved)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [templateId, "company-1", "whatsapp", "Test Template", "en", false]
    );

    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        templateId: templateId,
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("template_not_approved");
    }
  });

  it("sends with approved template and content variables", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");
    const templateId = randomUUID();

    // Insert approved template with content SID
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_templates
         (id, company_id, channel, name, language, twilio_content_sid, approved)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [templateId, "company-1", "whatsapp", "Test Template", "en", "HXXXXXXXXXXXXXXXXXXXX", true]
    );

    const mockClient = {
      sendMessage: vi.fn(async (input: any) => {
        // Verify content variables are passed
        expect(input.contentVariables).toEqual({ name: "John", item: "Widget" });
        return {
          ok: true,
          value: { sid: "SM-template-1", status: "sent" },
        };
      }),
    };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        templateId: templateId,
        variables: { name: "John", item: "Widget" },
      }
    );

    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.providerMsgId).toBe("SM-template-1");
    }

    // Verify message was stored without body (template mode)
    const messages = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_messages WHERE company_id = 'company-1' AND direction = 'outbound'`
    );
    expect(messages.rows).toHaveLength(1);
    const msg = messages.rows[0] as any;
    expect(msg.body).toBeNull();
    expect(msg.template_id).toBe(templateId);
  });

  it("marks message as failed on send failure", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = {
      sendMessage: vi.fn(async () => ({
        ok: false,
        failure: {
          kind: "rate_limited",
          status: 429,
          code: null,
          error: "Rate limited",
        },
      })),
    };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test response",
      }
    );

    expect(result.sent).toBe(false);

    // Verify message was marked as failed
    const messages = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_messages WHERE company_id = 'company-1' AND direction = 'outbound'`
    );
    expect(messages.rows).toHaveLength(1);
    const msg = messages.rows[0] as any;
    expect(msg.status).toBe("failed");

    // Verify audit was written
    const audits = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_audit WHERE action = 'wa.send.failed'`
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("handles timeout without retrying and audits as unknown", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = {
      sendMessage: vi.fn(async () => ({
        ok: false,
        failure: {
          kind: "timeout",
          status: null,
          code: null,
          error: "Request timeout",
        },
      })),
    };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "Test response",
      }
    );

    expect(result.sent).toBe(false);

    // Verify client was called exactly once (no retry)
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);

    // Verify audit was written as unknown
    const audits = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_audit WHERE action = 'wa.send.unknown'`
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("never includes body text or variables in audit detail", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = {
      sendMessage: vi.fn(async () => ({
        ok: true,
        value: { sid: "SM123456", status: "sent" },
      })),
    };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "This is sensitive information",
      }
    );

    expect(result.sent).toBe(true);

    // Verify audit never contains body text
    const audits = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_audit WHERE company_id = 'company-1'`
    );
    expect(audits.rows).toHaveLength(1);

    const auditJson = JSON.stringify((audits.rows[0] as any).detail);
    expect(auditJson).not.toContain("This is sensitive information");
    expect(auditJson).not.toContain("+27821234568"); // toE164 should not be in detail
  });

  it("rejects empty body in window-open mode", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = { sendMessage: vi.fn() };

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: "",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("bad_body");
    }
  });

  it("rejects body longer than 1600 characters in window-open mode", async () => {
    const { sendWhatsapp } = await import("../src/whatsapp-send.js");
    const { insertOnce } = await import("../src/idempotency.js");

    const dbClient = createMockDbClient(pgDb);
    const now = new Date("2024-10-13T10:00:00Z");

    // Insert inbound message to open window
    await insertOnce(dbClient, NAMESPACE, "message", {
      company_id: "company-1",
      channel: "whatsapp",
      direction: "inbound",
      provider_msg_id: "SM-inbound-1",
      contact_id: null,
      from_e164: "+27821234568",
      to_e164: "+27821234567",
      body: "Hello from customer",
      status: "received",
      received_at: now,
    });

    const mockClient = { sendMessage: vi.fn() };
    const longBody = "x".repeat(1601);

    const result = await sendWhatsapp(
      {
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        settings: {
          whatsappEnabled: true,
          smsEnabled: true,
          maxWhatsappPerDay: 200,
          recordingEnabled: false,
          maxCallsPerDay: 50,
          maxSmsPerDay: 200,
          recordingRetentionDays: 30,
          allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
          callerIds: [],
          usSmsCampaignStatus: "none",
          usMessagingServiceSid: null,
          smsHolidays: [],
        },
        fromWhatsapp: "+27821234567",
        now: () => now,
      },
      {
        companyId: "company-1",
        userId: "user-1",
        contactId: "contact-1",
        toE164: "+27821234568",
        kind: "service",
        body: longBody,
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("bad_body");
    }
  });
});
