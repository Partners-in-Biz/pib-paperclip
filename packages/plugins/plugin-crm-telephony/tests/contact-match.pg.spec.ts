import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import { createMockDbClient, seedContact } from "./helpers/test-utils.js";

let pgDb: PgDb;

describe("Contact matching by phone", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`DELETE FROM ${NAMESPACE}.crm_contacts`);
  });

  describe("matchContactsByPhone", () => {
    const rawFormats = [
      { phone: "082 123 4567", label: "raw '082 123 4567'" },
      { phone: "+27 82 123 4567", label: "international '+27 82 123 4567'" },
    ];

    it.each(rawFormats)("matches single contact with $label", async ({ phone }) => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John Doe", [phone]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBe("contact-1");
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual(["contact-1"]);
    });

    it("returns ambiguous (null contactId) when two contacts share the same number", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0821234567"]);
      await seedContact(pgDb, "contact-2", "company-1", "Jane", ["0821234567"]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBeNull();
      expect(result.ambiguous).toBe(true);
      expect(result.candidateIds).toEqual(["contact-1", "contact-2"]);
    });

    it("ignores deleted contacts", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0821234567"], true);
      await seedContact(pgDb, "contact-2", "company-1", "Jane", ["0821234567"], false);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBe("contact-2");
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual(["contact-2"]);
    });

    it("scopes by company_id", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0821234567"]);
      await seedContact(pgDb, "contact-2", "company-2", "Jane", ["0821234567"]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBe("contact-1");
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual(["contact-1"]);
    });

    it("rejects number with different country prefix", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["+12815234567"]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBeNull();
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual([]);
    });

    it("returns empty result (null contactId, ambiguous false) when no match", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0829999999"]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBeNull();
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual([]);
    });

    it("matches when contact has multiple phones and one matches", async () => {
      const { matchContactsByPhone } = await import("../src/contact-match.js");
      const dbClient = createMockDbClient(pgDb);

      await seedContact(pgDb, "contact-1", "company-1", "John", ["0819876543", "0821234567", "0837654321"]);

      const result = await matchContactsByPhone(dbClient, NAMESPACE, "company-1", "+27821234567");

      expect(result.contactId).toBe("contact-1");
      expect(result.ambiguous).toBe(false);
      expect(result.candidateIds).toEqual(["contact-1"]);
    });
  });
});
