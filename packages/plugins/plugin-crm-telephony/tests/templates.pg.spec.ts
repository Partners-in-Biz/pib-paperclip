import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { startPg, type PgDb } from "./helpers/pg.js";
import { syncTemplates, listPickerTemplates, type TwilioClient } from "../src/templates.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

let db: PgDb;

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

function createMockClient(
  templates: Array<{ sid: string; friendlyName: string; language: string; bodyPreview: string }> = [],
  approvals: Record<string, string> = {},
): Pick<TwilioClient, "listContentTemplates" | "getApprovalStatus"> {
  return {
    listContentTemplates: async () => ({ ok: true, value: templates }),
    getApprovalStatus: async (sid: string) => ({ ok: true, value: (approvals[sid] || "pending") as any }),
  };
}

describe("Template sync and picker", () => {
  beforeAll(async () => {
    db = await startPg();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_templates CASCADE`);
    await db.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_audit CASCADE`);
  });

  describe("syncTemplates", () => {
    it("upserts by company+content sid (insert then update)", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";
      const agentId = "a1";

      // First sync: insert
      const mockClient1 = createMockClient(
        [{ sid: "sid1", friendlyName: "Greeting", language: "en", bodyPreview: "Hello" }],
        { sid1: "approved" },
      );
      const r1 = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient1 as any,
        companyId,
        agentId,
      });
      expect(r1.created).toBe(1);
      expect(r1.updated).toBe(0);

      // Second sync: same template, updated name -> should update, not insert
      const mockClient2 = createMockClient(
        [{ sid: "sid1", friendlyName: "Greeting Updated", language: "en", bodyPreview: "Hello" }],
        { sid1: "approved" },
      );
      const r2 = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient2 as any,
        companyId,
        agentId,
      });
      expect(r2.created).toBe(0);
      expect(r2.updated).toBe(1); // name changed -> updated
      expect(r2.unchanged).toBe(0);

      const rows = await db.client.query(`SELECT COUNT(*) as cnt FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`, [companyId]);
      expect(((rows as any).rows[0] as any).cnt).toBe("1"); // no duplicates
    });

    it("skips unsupported languages only af/en", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";
      const mockClient = createMockClient(
        [
          { sid: "sid1", friendlyName: "EN", language: "en", bodyPreview: "Hi" },
          { sid: "sid2", friendlyName: "DE", language: "de", bodyPreview: "Hallo" },
          { sid: "sid3", friendlyName: "AF", language: "af", bodyPreview: "Hallo" },
        ],
        { sid1: "approved", sid2: "approved", sid3: "approved" },
      );

      const r = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId: "a1",
      });
      expect(r.created).toBe(2);
      expect(r.skipped).toBe(1);
    });

    it("maps approval status and un-approves vanished rows", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";

      // Seed old template
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, twilio_content_sid, approved)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [companyId, "whatsapp", "Old", "en", "sid-old", true],
      );

      // Sync new template only
      const mockClient = createMockClient(
        [{ sid: "sid-new", friendlyName: "New", language: "en", bodyPreview: "Hi" }],
        { "sid-new": "approved" },
      );
      const r = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId: "a1",
      });
      expect(r.created).toBe(1);
      expect(r.updated).toBe(1); // un-approval

      const rows = await db.client.query(
        `SELECT twilio_content_sid, approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1 ORDER BY created_at`,
        [companyId],
      );
      expect(((rows as any).rows[0] as any).approved).toBe(false); // old un-approved
      expect(((rows as any).rows[1] as any).approved).toBe(true); // new approved
    });

    it("preserves other companies when syncing", async () => {
      const dbClient = createMockDbClient(db);
      const c1 = "c1";
      const c2 = "c2";

      // Seed both companies with same sid
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, twilio_content_sid, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [c1, "whatsapp", "T1", "en", "sid1", true, c2, "whatsapp", "T2", "en", "sid1", true],
      );

      // Sync c1 with empty list
      const mockClient = createMockClient([], {});
      await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId: c1,
        agentId: "a1",
      });

      // c1's template un-approved, c2's unchanged
      const c1Row = await db.client.query(`SELECT approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`, [c1]);
      expect(((c1Row as any).rows[0] as any).approved).toBe(false);
      const c2Row = await db.client.query(`SELECT approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`, [c2]);
      expect(((c2Row as any).rows[0] as any).approved).toBe(true);
    });

    it("writes audit row with action and detail", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";
      const agentId = "a1";
      const mockClient = createMockClient(
        [{ sid: "sid1", friendlyName: "T", language: "en", bodyPreview: "Hi" }],
        { sid1: "approved" },
      );

      await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      const audit = await db.client.query(`SELECT action, detail FROM ${NAMESPACE}.tel_audit WHERE company_id = $1`, [companyId]);
      expect((audit as any).rows).toHaveLength(1);
      expect(((audit as any).rows[0] as any).action).toBe("template.sync");
      const detail = ((audit as any).rows[0] as any).detail;
      expect(detail.created).toBe(1);
      expect(detail.approved).toBe(1);
    });
  });

  describe("listPickerTemplates", () => {
    it("lists only approved templates for company", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";

      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [companyId, "whatsapp", "Approved", "en", "Hello", true, companyId, "whatsapp", "Pending", "en", "Hi", false],
      );

      const templates = await listPickerTemplates(dbClient, NAMESPACE, companyId);
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe("Approved");
    });

    it("filters by language when specified", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "c1";

      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [companyId, "whatsapp", "EN", "en", "Hello", true, companyId, "whatsapp", "AF", "af", "Hallo", true],
      );

      const en = await listPickerTemplates(dbClient, NAMESPACE, companyId, { language: "en" });
      expect(en).toHaveLength(1);
      expect(en[0].name).toBe("EN");

      const af = await listPickerTemplates(dbClient, NAMESPACE, companyId, { language: "af" });
      expect(af).toHaveLength(1);
      expect(af[0].name).toBe("AF");
    });
  });
});
