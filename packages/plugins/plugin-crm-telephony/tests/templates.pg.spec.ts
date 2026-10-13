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

function createMockClient(templates: Array<{ sid: string; friendlyName: string; language: string; bodyPreview: string }> = [], approvals: Record<string, string> = {}): Pick<TwilioClient, "listContentTemplates" | "getApprovalStatus"> {
  return {
    listContentTemplates: async () => ({
      ok: true,
      value: templates,
    }),
    getApprovalStatus: async (sid: string) => ({
      ok: true,
      value: (approvals[sid] || "pending") as any,
    }),
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
    it("creates new templates with approved flag", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      const mockClient = createMockClient(
        [
          { sid: "sid1", friendlyName: "Greeting", language: "en", bodyPreview: "Hello" },
        ],
        { sid1: "approved" },
      );

      const result = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.approved).toBe(1);
      expect(result.error).toBeUndefined();

      const rows = await db.client.query(
        `SELECT name, language, approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`,
        [companyId],
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as any).approved).toBe(true);
    });

    it("skips unsupported languages", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      const mockClient = createMockClient(
        [
          { sid: "sid1", friendlyName: "English", language: "en", bodyPreview: "Hello" },
          { sid: "sid2", friendlyName: "German", language: "de", bodyPreview: "Hallo" },
          { sid: "sid3", friendlyName: "Afrikaans", language: "af", bodyPreview: "Hallo" },
        ],
        { sid1: "approved", sid2: "approved", sid3: "approved" },
      );

      const result = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);

      const rows = await db.client.query(`SELECT language FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`, [companyId]);
      expect(rows.rows).toHaveLength(2);
      const langs = (rows.rows as any[]).map((r) => r.language).sort();
      expect(langs).toEqual(["af", "en"]);
    });

    it("un-approves vanished templates", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      // Seed an existing approved template
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, twilio_content_sid, approved)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [companyId, "whatsapp", "Old Template", "en", "sid-old", true],
      );

      // Sync with new template only
      const mockClient = createMockClient(
        [{ sid: "sid-new", friendlyName: "New Template", language: "en", bodyPreview: "New" }],
        { "sid-new": "approved" },
      );

      const result = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1); // Un-approval counts as update

      const rows = await db.client.query(
        `SELECT twilio_content_sid, approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1 ORDER BY created_at`,
        [companyId],
      );
      expect(rows.rows).toHaveLength(2);
      const [oldRow, newRow] = rows.rows as any[];
      expect(oldRow.twilio_content_sid).toBe("sid-old");
      expect(oldRow.approved).toBe(false);
      expect(newRow.twilio_content_sid).toBe("sid-new");
      expect(newRow.approved).toBe(true);
    });

    it("preserves other companies when un-approving", async () => {
      const dbClient = createMockDbClient(db);
      const company1 = "company-1";
      const company2 = "company-2";
      const agentId = "agent-1";

      // Seed templates for both companies
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, twilio_content_sid, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [company1, "whatsapp", "Template 1", "en", "sid1", true, company2, "whatsapp", "Template 2", "en", "sid1", true],
      );

      // Sync company1 with empty list
      const mockClient = createMockClient([], {});

      await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId: company1,
        agentId,
      });

      // Check company1's template is un-approved
      const company1Rows = await db.client.query(
        `SELECT approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`,
        [company1],
      );
      expect((company1Rows.rows[0] as any).approved).toBe(false);

      // Check company2's template is still approved
      const company2Rows = await db.client.query(
        `SELECT approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`,
        [company2],
      );
      expect((company2Rows.rows[0] as any).approved).toBe(true);
    });

    it("returns error on list failure without touching DB", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      // Seed a template before the sync
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, approved)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, "whatsapp", "Existing", "en", true],
      );

      // Mock client that fails on list
      const mockClient = {
        listContentTemplates: async () => ({
          ok: false,
          failure: { kind: "auth_error", status: 401 },
        }),
        getApprovalStatus: async () => ({
          ok: true,
          value: "approved" as const,
        }),
      };

      const result = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      expect(result.error).toBeDefined();
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);

      // Verify the existing template is unchanged
      const rows = await db.client.query(
        `SELECT approved FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`,
        [companyId],
      );
      expect((rows.rows[0] as any).approved).toBe(true);
    });

    it("returns error on approval status failure without touching DB", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      // Seed a template before the sync
      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, approved)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, "whatsapp", "Existing", "en", true],
      );

      // Mock client that fails on approval check
      const mockClient = {
        listContentTemplates: async () => ({
          ok: true,
          value: [{ sid: "sid1", friendlyName: "New", language: "en", bodyPreview: "Hi" }],
        }),
        getApprovalStatus: async () => ({
          ok: false,
          failure: { kind: "rate_limited", status: 429 },
        }),
      };

      const result = await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      expect(result.error).toBeDefined();
      expect(result.created).toBe(0);

      // Verify the existing template is unchanged
      const rows = await db.client.query(
        `SELECT name FROM ${NAMESPACE}.tel_templates WHERE company_id = $1`,
        [companyId],
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as any).name).toBe("Existing");
    });

    it("writes audit row on successful sync", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";
      const agentId = "agent-1";

      const mockClient = createMockClient(
        [{ sid: "sid1", friendlyName: "Template", language: "en", bodyPreview: "Hi" }],
        { sid1: "approved" },
      );

      await syncTemplates({
        db: dbClient,
        namespace: NAMESPACE,
        client: mockClient as any,
        companyId,
        agentId,
      });

      const audit = await db.client.query(`SELECT action, detail FROM ${NAMESPACE}.tel_audit WHERE company_id = $1`, [
        companyId,
      ]);
      expect(audit.rows).toHaveLength(1);
      expect((audit.rows[0] as any).action).toBe("template.sync");
      const detail = (audit.rows[0] as any).detail;
      expect(detail.created).toBe(1);
      expect(detail.approved).toBe(1);
    });
  });

  describe("listPickerTemplates", () => {
    it("returns only approved templates", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";

      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [
          companyId,
          "whatsapp",
          "Approved",
          "en",
          "Hello",
          true,
          companyId,
          "whatsapp",
          "Pending",
          "en",
          "Hi",
          false,
        ],
      );

      const templates = await listPickerTemplates(dbClient, NAMESPACE, companyId);
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe("Approved");
    });

    it("filters by language when specified", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";

      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, name, language, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [
          companyId,
          "whatsapp",
          "English",
          "en",
          "Hello",
          true,
          companyId,
          "whatsapp",
          "Afrikaans",
          "af",
          "Hallo",
          true,
        ],
      );

      const enTemplates = await listPickerTemplates(dbClient, NAMESPACE, companyId, { language: "en" });
      expect(enTemplates).toHaveLength(1);
      expect(enTemplates[0].name).toBe("English");

      const afTemplates = await listPickerTemplates(dbClient, NAMESPACE, companyId, { language: "af" });
      expect(afTemplates).toHaveLength(1);
      expect(afTemplates[0].name).toBe("Afrikaans");
    });

    it("returns empty list for company with no approved templates", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "empty-company";

      const templates = await listPickerTemplates(dbClient, NAMESPACE, companyId);
      expect(templates).toHaveLength(0);
    });

    it("returns formatted output with bodyPreview", async () => {
      const dbClient = createMockDbClient(db);
      const companyId = "company-1";

      await db.client.query(
        `INSERT INTO ${NAMESPACE}.tel_templates (company_id, channel, id, name, language, body_preview, approved)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, "whatsapp", "00000000-0000-0000-0000-000000000001", "Greeting", "en", "Hello {{name}}", true],
      );

      const templates = await listPickerTemplates(dbClient, NAMESPACE, companyId);
      expect(templates).toHaveLength(1);
      expect(templates[0]).toEqual({
        id: "00000000-0000-0000-0000-000000000001",
        name: "Greeting",
        language: "en",
        bodyPreview: "Hello {{name}}",
      });
    });
  });
});
