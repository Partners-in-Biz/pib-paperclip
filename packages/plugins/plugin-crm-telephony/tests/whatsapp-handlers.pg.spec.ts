import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTwilioSignature, buildPublicWebhookUrl, parseFormParams } from "../src/twilio-signature.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import type { PluginContext, PluginDatabaseClient, PluginWebhookInput } from "@paperclipai/plugin-sdk";
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

describe("WhatsApp webhook handlers", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_messages CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_audit CASCADE`);
  });

  describe("wa-inbound handler", () => {
    it("accepts first message on empty table when company token verifies", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");

      // Set up mock context with two companies
      const authToken1 = "wrong-token-123";
      const authToken2 = "test-auth-token";
      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;

      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello";
      const params = parseFormParams(formBody);
      const correctSignature = computeTwilioSignature(authToken2, webhookUrl, params);

      const mockCtx: Partial<PluginContext> = {
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
        companies: {
          list: vi.fn(async () => [
            { id: "company-1", name: "Company 1" } as any,
            { id: "company-2", name: "Company 2" } as any,
          ]),
          get: vi.fn(),
        },
        secrets: {
          resolve: vi.fn(async (secretName: string, opts: any) => {
            if (opts.companyId === "company-1") {
              return authToken1;
            }
            if (opts.companyId === "company-2") {
              return authToken2;
            }
            throw new Error("Company not found");
          }),
        },
      } as any;

      const input: PluginWebhookInput = {
        requestId: "test-request-1",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": correctSignature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Verify message was inserted
      const rows = await pgDb.client.query(
        `SELECT * FROM ${NAMESPACE}.tel_messages WHERE provider_msg_id = 'SM123'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as any).company_id).toBe("company-2");
    });

    it("rejects bad signature without writing to database", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");

      const authToken = "test-auth-token";
      const proto = "https";
      const host = "example.com";

      const formBody = "MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello";
      const badSignature = "bad-signature-value";

      const mockCtx: Partial<PluginContext> = {
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
        companies: {
          list: vi.fn(async () => [
            { id: "company-1", name: "Company 1" } as any,
          ]),
          get: vi.fn(),
        },
        secrets: {
          resolve: vi.fn(async () => authToken),
        },
      } as any;

      const input: PluginWebhookInput = {
        requestId: "test-request-2",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": badSignature,
        },
        rawBody: formBody,
        parsedBody: {},
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("bad_signature");

      // Verify nothing was written
      const rows = await pgDb.client.query(
        `SELECT * FROM ${NAMESPACE}.tel_messages WHERE provider_msg_id = 'SM123'`,
      );
      expect(rows.rows).toHaveLength(0);
    });

    it("uses header-derived URL for signature verification", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");

      const authToken = "test-auth-token";
      const proto = "https";
      const host = "derived-host.example.com"; // Different from hardcoded
      const baseUrl = `${proto}://${host}`;

      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM456&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hi";
      const params = parseFormParams(formBody);
      const correctSignature = computeTwilioSignature(authToken, webhookUrl, params);

      const mockCtx: Partial<PluginContext> = {
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
        companies: {
          list: vi.fn(async () => [
            { id: "company-1", name: "Company 1" } as any,
          ]),
          get: vi.fn(),
        },
        secrets: {
          resolve: vi.fn(async () => authToken),
        },
      } as any;

      const input: PluginWebhookInput = {
        requestId: "test-request-3",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": correctSignature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Verify message was inserted with the correct company
      const rows = await pgDb.client.query(
        `SELECT * FROM ${NAMESPACE}.tel_messages WHERE provider_msg_id = 'SM456'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as any).company_id).toBe("company-1");
    });
  });

  describe("wa-status handler", () => {
    it("updates message status with verified company", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound, handleWaStatus } = await import("../src/whatsapp.js");
      const { insertOnce } = await import("../src/idempotency.js");

      // First, insert a message
      await insertOnce(dbClient, NAMESPACE, "message", {
        company_id: "company-1",
        channel: "whatsapp",
        direction: "outbound",
        provider_msg_id: "SM789",
        contact_id: null,
        from_e164: "+27821234568",
        to_e164: "+27821234567",
        body: "Test message",
        status: "queued",
        received_at: null,
      });

      const authToken = "test-auth-token";
      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;

      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-status",
      });

      const formBody = "MessageSid=SM789&MessageStatus=delivered";
      const params = parseFormParams(formBody);
      const correctSignature = computeTwilioSignature(authToken, webhookUrl, params);

      const mockCtx: Partial<PluginContext> = {
        logger: {
          warn: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
        },
        companies: {
          list: vi.fn(async () => [
            { id: "company-1", name: "Company 1" } as any,
          ]),
          get: vi.fn(),
        },
        secrets: {
          resolve: vi.fn(async () => authToken),
        },
      } as any;

      const input: PluginWebhookInput = {
        requestId: "test-request-4",
        endpointKey: "wa-status",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": correctSignature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Verify status was updated
      const rows = await pgDb.client.query(
        `SELECT status FROM ${NAMESPACE}.tel_messages WHERE provider_msg_id = 'SM789'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as any).status).toBe("delivered");
    });
  });
});
