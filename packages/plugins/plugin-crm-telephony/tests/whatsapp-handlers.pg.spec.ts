import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import {
  createMockDbClient,
  createMockContext,
  buildSignedWebhookInput,
  seedContact,
  readAuditRows,
  readOptOutRows,
  readPrefRows,
  readMessageRows,
} from "./helpers/test-utils.js";
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
      const mockCtx = createMockContext(["company-1", "company-2"], { "company-1": "wrong", "company-2": authToken });

      const { input } = buildSignedWebhookInput("MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      const messages = await readMessageRows(pgDb, "company-2", "SM123");
      expect(messages).toHaveLength(1);
      expect(messages[0].company_id).toBe("company-2");
    });

    it("rejects bad signature without writing to database", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const { input } = buildSignedWebhookInput("MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello", authToken, "wa-inbound");
      input.headers["x-twilio-signature"] = "bad-signature";

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("bad_signature");

      const messages = await readMessageRows(pgDb, "company-1", "SM123");
      expect(messages).toHaveLength(0);
    });

    it("uses header-derived URL for signature verification", async () => {
      const dbClient = createMockDbClient(pgDb);
      const { handleWaInbound } = await import("../src/whatsapp.js");
      const mockCtx = createMockContext(["company-1"], { "company-1": authToken });

      const { input } = buildSignedWebhookInput("MessageSid=SM456&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hi", authToken, "wa-inbound", "https", "custom-host.com");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SM789&MessageStatus=delivered", authToken, "wa-status");

      const result = await handleWaStatus(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SM123&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Hello", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SM456&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=Test", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SM789&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SM999&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SMABC&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP", authToken, "wa-inbound");

      const result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SMDUP&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP", authToken, "wa-inbound");

      // First delivery
      let result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Delete contact pref to simulate recovery scenario
      await pgDb.client.query(`DELETE FROM ${NAMESPACE}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`, ["company-1", "contact-1"]);

      // Second delivery (same MessageSid, so message insert is no-op, opt-out applies again, but number row already exists)
      result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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

      const { input } = buildSignedWebhookInput("MessageSid=SMHEAL&From=whatsapp:+27821234567&To=whatsapp:+27821234568&Body=STOP", authToken, "wa-inbound");

      // First delivery
      let result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
      expect(result).toBe("ok");

      // Delete the number-level opt-out row to simulate accidental cleanup
      await pgDb.client.query(`DELETE FROM ${NAMESPACE}.tel_number_optouts WHERE company_id = $1 AND e164 = $2`, ["company-1", "+27821234567"]);

      // Second delivery (same MessageSid)
      result = await handleWaInbound(mockCtx as any, dbClient, NAMESPACE, input, PLUGIN_ID);
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
