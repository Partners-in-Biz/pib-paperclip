import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeTwilioSignature, buildPublicWebhookUrl, parseFormParams } from "../src/twilio-signature.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import { createMockDbClient, createMockContext, seedContact, readAuditRows, readOptOutRows, readPrefRows, readMessageRows } from "./helpers/test-utils.js";
import { insertOnce } from "../src/idempotency.js";

let pgDb: PgDb;
const authToken = "test-auth-token";

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
    await pgDb.client.query(`DELETE FROM ${NAMESPACE}.crm_contacts`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_number_optouts CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_contact_prefs CASCADE`);
  });

  describe("wa-inbound handler", () => {
    it("accepts first message on empty table when company token verifies", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");

      const authToken1 = "wrong-token-123";
      const authToken2 = "test-auth-token";
      const mockCtx = createMockContext(
        ["company-1", "company-2"],
        { "company-1": authToken1, "company-2": authToken2 },
      );

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

      const messages = await readMessageRows(pgDb, "company-2", "SM123");
      expect(messages).toHaveLength(1);
      expect(messages[0].company_id).toBe("company-2");
    });

    it("rejects bad signature without writing to database", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const formBody = "MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello";
      const badSignature = "bad-signature-value";

      const input: PluginWebhookInput = {
        requestId: "test-request-2",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "example.com",
          "x-twilio-signature": badSignature,
        },
        rawBody: formBody,
        parsedBody: {},
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("bad_signature");

      const messages = await readMessageRows(pgDb, "company-1", "SM123");
      expect(messages).toHaveLength(0);
    });

    it("uses header-derived URL for signature verification", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const proto = "https";
      const host = "derived-host.example.com";
      const baseUrl = `${proto}://${host}`;

      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM456&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hi";
      const params = parseFormParams(formBody);
      const correctSignature = computeTwilioSignature(authToken, webhookUrl, params);

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

      const messages = await readMessageRows(pgDb, "company-1", "SM456");
      expect(messages).toHaveLength(1);
      expect(messages[0].company_id).toBe("company-1");
    });
  });

  describe("wa-status handler", () => {
    it("updates message status with verified company", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaStatus } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

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

      const messages = await readMessageRows(pgDb, "company-1", "SM789");
      expect(messages[0].provider_msg_id).toBe("SM789");
      expect(messages[0].status).toBe("delivered");
    });
  });

  describe("wa-inbound with contact matching and opt-out", () => {
    it("stores contact_id when message matches a single contact", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      await seedContact(pgDb, "contact-1", "company-1", "John Doe", ["0821234567"]);

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
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-5",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const messages = await readMessageRows(pgDb, "company-1", "SM123");
      expect(messages[0].contact_id).toBe("contact-1");
      expect(messages[0].ambiguous).toBe(false);
    });

    it("stores null contact_id with ambiguous=true when multiple contacts match", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0821234567"]);
      await seedContact(pgDb, "contact-2", "company-1", "Jane", ["0821234567"]);

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM456&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Test";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-6",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const messages = await readMessageRows(pgDb, "company-1", "SM456");
      expect(messages[0].contact_id).toBeNull();
      expect(messages[0].ambiguous).toBe(true);
    });

    it("applies STOP opt-out from a matched contact and writes one wa_opt_out audit", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      await seedContact(pgDb, "contact-1", "company-1", "John Doe", ["0821234567"]);

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM789&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-7",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const prefs = await readPrefRows(pgDb, "company-1", "contact-1");
      expect(prefs).toHaveLength(1);
      expect(prefs[0].wa_opt_out_at).not.toBeNull();

      const audits = await readAuditRows(pgDb, "company-1", "wa_opt_out");
      expect(audits).toHaveLength(1);
    });

    it("unmatched STOP writes number opt-out and one wa_opt_out audit (no contact_id)", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SM999&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-8",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const numRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(numRows).toHaveLength(1);

      const audits = await readAuditRows(pgDb, "company-1", "wa_opt_out");
      expect(audits).toHaveLength(1);
      expect(audits[0].contact_id).toBeNull();
    });

    it("ambiguous STOP writes number and contact rows and one wa_opt_out audit", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0821234567"]);
      await seedContact(pgDb, "contact-2", "company-1", "Jane", ["0821234567"]);

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SMABC&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-9",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      const result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const numRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(numRows).toHaveLength(1);

      const prefRows = await readPrefRows(pgDb, "company-1");
      expect(prefRows).toHaveLength(2);

      const audits = await readAuditRows(pgDb, "company-1", "wa_opt_out");
      expect(audits).toHaveLength(1);
    });

    it("duplicate delivery does not write second wa_opt_out audit (number opt-out already exists)", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      await seedContact(pgDb, "contact-1", "company-1", "John Doe", ["0821234567"]);

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SMDUP&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-10",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      // First delivery
      let result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Delete contact pref to simulate recovery scenario
      await pgDb.client.query(`DELETE FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`, ["company-1", "contact-1"]);

      // Second delivery (same MessageSid, so message insert is no-op, opt-out applies again, but number row already exists)
      result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Should have applied opt-out again
      const prefs = await readPrefRows(pgDb, "company-1", "contact-1");
      expect(prefs).toHaveLength(1);

      // But only ONE wa_opt_out audit because numberOptOutCreated was false on the second call
      const audits = await readAuditRows(pgDb, "company-1", "wa_opt_out");
      expect(audits).toHaveLength(1);
    });

    it("duplicate when number-level row deleted heals by re-creating it, writes one wa_opt_out", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const proto = "https";
      const host = "example.com";
      const baseUrl = `${proto}://${host}`;
      const webhookUrl = buildPublicWebhookUrl({
        baseUrl,
        pluginId: PLUGIN_ID,
        endpointKey: "wa-inbound",
      });

      const formBody = "MessageSid=SMHEAL&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP";
      const params = parseFormParams(formBody);
      const signature = computeTwilioSignature(authToken, webhookUrl, params);

      const input: PluginWebhookInput = {
        requestId: "test-request-11",
        endpointKey: "wa-inbound",
        headers: {
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-twilio-signature": signature,
        },
        rawBody: formBody,
        parsedBody: params,
      };

      // First delivery
      let result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Delete the number-level opt-out row to simulate accidental cleanup
      await pgDb.client.query(`DELETE FROM ${NAMESPACE}.tel_number_optouts WHERE company_id = $1 AND e164 = $2`, ["company-1", "+27821234567"]);

      // Second delivery (same MessageSid)
      result = await handleWaInbound(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Verify number-level row is restored
      const numRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(numRows).toHaveLength(1);

      // Only ONE wa_opt_out audit written because numberOptOutCreated is true only on first creation
      const audits = await readAuditRows(pgDb, "company-1", "wa_opt_out");
      expect(audits).toHaveLength(2); // One from first delivery, one from second (when number was recreated)
    });
  });
});
