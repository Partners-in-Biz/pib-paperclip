import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import { createMockDbClient, readOptOutRows, readPrefRows } from "./helpers/test-utils.js";

let pgDb: PgDb;

describe("WhatsApp opt-out", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_number_optouts CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_contact_prefs CASCADE`);
  });

  describe("applyWaOptOut", () => {
    const stopKeywords = [
      { body: "STOP", label: "STOP" },
      { body: "stop ", label: "stop with space" },
      { body: "Hou Op", label: "Hou Op (case-insensitive)" },
      { body: "HOUOP", label: "HOUOP (no space)" },
    ];

    const nonStopKeywords = [
      { body: "stopping", label: "stopping" },
      { body: "please stop", label: "please stop" },
      { body: "Hi, how are you?", label: "normal text" },
    ];

    it.each(stopKeywords)("opts out on '$label'", async ({ body }) => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const result = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: [],
        providerMsgId: "msg-1",
        body,
      });

      expect(result.optedOut).toBe(true);
      const rows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(rows).toHaveLength(1);
    });

    it.each(nonStopKeywords)("does not opt out on '$label'", async ({ body }) => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const result = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: [],
        providerMsgId: "msg-1",
        body,
      });

      expect(result.optedOut).toBe(false);
      const rows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(rows).toHaveLength(0);
    });

    it("creates number-only row when no candidates", async () => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const result = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: [],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      expect(result.optedOut).toBe(true);
      expect(result.numberOptOutCreated).toBe(true);
      const rows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(rows).toHaveLength(1);
    });

    it("opts out number and both contacts when ambiguous", async () => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const result = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1", "contact-2"],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      expect(result.optedOut).toBe(true);
      expect(result.numberOptOutCreated).toBe(true);
      const optRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(optRows).toHaveLength(1);
      const prefRows = await readPrefRows(pgDb, "company-1");
      expect(prefRows).toHaveLength(2);
    });

    it("is idempotent: re-running keeps earliest timestamp and sets numberOptOutCreated=false", async () => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const r1 = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1"],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      expect(r1.numberOptOutCreated).toBe(true);

      const firstRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      const firstTime = firstRows[0].opt_out_at;

      await new Promise((r) => setTimeout(r, 10));

      const r2 = await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1"],
        providerMsgId: "msg-2",
        body: "STOP",
      });

      expect(r2.numberOptOutCreated).toBe(false);
      const secondRows = await readOptOutRows(pgDb, "company-1", "+27821234567");
      expect(secondRows[0].opt_out_at).toEqual(firstTime);
    });

    it("does not touch erased_at on conflict", async () => {
      const { applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const erasedDate = new Date("2026-01-01");
      await pgDb.client.query(
        `INSERT INTO ${NAMESPACE}.tel_contact_prefs (company_id, contact_id, erased_at, updated_at)
         VALUES ($1, $2, $3, $4)`,
        ["company-1", "contact-1", erasedDate, new Date("2026-01-01")],
      );

      await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1"],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      const prefs = await readPrefRows(pgDb, "company-1", "contact-1");
      expect(prefs[0].erased_at).toEqual(erasedDate);
    });
  });

  describe("isWaOptedOut", () => {
    it("returns true when number is opted out", async () => {
      const { isWaOptedOut, applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: [],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      const result = await isWaOptedOut(dbClient, NAMESPACE, "company-1", "+27821234567", null);
      expect(result).toBe(true);
    });

    it("returns true when specific contact is opted out", async () => {
      const { isWaOptedOut, applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1"],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      const result = await isWaOptedOut(dbClient, NAMESPACE, "company-1", "+27821234567", "contact-1");
      expect(result).toBe(true);
    });

    it("returns false when not opted out", async () => {
      const { isWaOptedOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      const result = await isWaOptedOut(dbClient, NAMESPACE, "company-1", "+27821234567", "contact-1");
      expect(result).toBe(false);
    });

    it("returns false for different company", async () => {
      const { isWaOptedOut, applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: [],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      const result = await isWaOptedOut(dbClient, NAMESPACE, "company-2", "+27821234567", null);
      expect(result).toBe(false);
    });

    it("returns true for number level when ambiguous", async () => {
      const { isWaOptedOut, applyWaOptOut } = await import("../src/optout.js");
      const dbClient = createMockDbClient(pgDb);

      await applyWaOptOut(dbClient, NAMESPACE, {
        companyId: "company-1",
        e164: "+27821234567",
        candidateIds: ["contact-1", "contact-2"],
        providerMsgId: "msg-1",
        body: "STOP",
      });

      const result = await isWaOptedOut(dbClient, NAMESPACE, "company-1", "+27821234567", null);
      expect(result).toBe(true);
    });
  });
});
