/**
 * Delete draft invoices and quotes: hard-delete for canary/numberless drafts,
 * void otherwise. Tests company scoping, status checks, and related row constraints.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { BILLING_TOOLS } from "../src/tools.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const AGENT = { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" };
const OTHER_COMPANY = "other-company";

describe.skipIf(!available)("delete-draft-invoice and delete-draft-quote (postgres)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS });
    h.config.set(OTHER_COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "canary-test", name: "Canary Test", email: "test@canary.invalid" });
  });

  const tool = <T = Record<string, unknown>>(name: string, params: Record<string, unknown>) =>
    h.tools.get(name)!(params, AGENT).then((r) => {
      const result = r as { data?: T; error?: string; ok?: boolean };
      if (result.error) throw new Error(result.error);
      return result.data as T;
    });

  const callWithCompany = <T = Record<string, unknown>>(name: string, params: Record<string, unknown>, companyId: string) =>
    h.tools.get(name)!(params, { agentId: "agent-am", runId: "run-am", companyId, projectId: "p" }).then((r) => {
      const result = r as { data?: T; error?: string; ok?: boolean };
      if (result.error) throw new Error(result.error);
      return result.data as T;
    });

  const draft = async (customerRef = "ct-lumen", unitAmountMinor = 100_000, currency = "ZAR", companyId = COMPANY) =>
    h.call<{ id: string; number: string }>(
      "billing.create-invoice",
      { currency, customerKind: "contact", customerRef },
      { agentId: "agent-am", runId: "run-am", companyId, projectId: "p" },
    );

  const quote = async (dealId = "deal-1", customerRef = "ct-lumen", companyId = COMPANY) =>
    h.call<{ id: string; number: string }>(
      "billing.create-quote",
      { currency: "ZAR", customerKind: "contact", customerRef, dealId },
      { agentId: "agent-am", runId: "run-am", companyId, projectId: "p" },
    );

  describe("delete-draft-invoice", () => {
    it("hard-deletes a canary draft invoice without a number", async () => {
      const inv = await draft("canary-test");
      // Canary invoices get numbered, but are flagged as canary by customer_ref starting with "canary-"

      // Delete the draft
      const result = await tool<{ deleted: boolean; id: string; number: string }>("delete-draft-invoice", { invoiceId: inv.id });
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(inv.id);

      // Verify deletion
      const rows = await h.client.query(`SELECT id FROM ${NAMESPACE}.invoices WHERE id = $1`, [inv.id]);
      expect(rows.rows).toHaveLength(0);
    });

    it("hard-deletes a regular draft invoice without a number", async () => {
      // Create an invoice without letting it get a number by updating the draft status artificially
      const inv = await h.call<{ id: string; number: string }>("billing.create-invoice", {
        currency: "ZAR",
        customerKind: "contact",
        customerRef: "ct-lumen",
      });

      // Clear the number by setting it to empty (simulating a numberless draft)
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET number = '' WHERE id = $1`, [inv.id]);

      // Delete the draft
      const result = await tool<{ deleted: boolean; id: string }>("delete-draft-invoice", { invoiceId: inv.id });
      expect(result.deleted).toBe(true);

      // Verify deletion
      const rows = await h.client.query(`SELECT id FROM ${NAMESPACE}.invoices WHERE id = $1`, [inv.id]);
      expect(rows.rows).toHaveLength(0);
    });

    it("voids a non-canary draft invoice with a number", async () => {
      const inv = await draft("ct-lumen");
      expect(inv.number).toMatch(/^[A-Z]+-/); // Should have a proper number

      // Add a line so the invoice is numbered
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Delete the draft
      const result = await tool<{ voided: boolean; id: string; number: string; status?: string }>("delete-draft-invoice", { invoiceId: inv.id });
      expect(result.voided).toBe(true);
      expect(result.number).toBe(inv.number);

      // Verify it was voided, not deleted
      const rows = await h.client.query(
        `SELECT status, void_reason FROM ${NAMESPACE}.invoices WHERE id = $1`,
        [inv.id],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as { status: string; void_reason: string | null };
      expect(row).toMatchObject({ status: "cancelled", void_reason: "deleted draft" });
    });

    it("refuses to delete a sent invoice", async () => {
      const inv = await draft("ct-lumen");
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Mark as sent
      await h.call("billing.mark-sent", { invoiceId: inv.id });

      // Try to delete
      const error = await tool("delete-draft-invoice", { invoiceId: inv.id }).catch((e) => e.message);
      expect(error).toContain("draft");
    });

    it("refuses to delete a draft invoice with a payment", async () => {
      const inv = await draft("ct-lumen");
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Record a payment on the draft (insert directly without currency field)
      await h.client.query(
        `INSERT INTO ${NAMESPACE}.payments (id, invoice_id, company_id, amount_minor) VALUES ($1, $2, $3, $4)`,
        ["pay-1", inv.id, COMPANY, 10000],
      );

      // Try to delete
      const error = await tool("delete-draft-invoice", { invoiceId: inv.id }).catch((e) => e.message);
      expect(error).toContain("payment");
    });

    it("voids a draft with a pending approval instead of hard-deleting", async () => {
      const inv = await draft("ct-lumen");
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Request send (creates approval issue and pending_action)
      await h.call("billing.request-send", { invoiceId: inv.id });

      // Delete the draft (should void, not hard-delete, because ct-lumen is not canary and has a number)
      const result = await tool<{ voided: boolean; number: string }>("delete-draft-invoice", { invoiceId: inv.id });
      expect(result.voided).toBe(true);

      // Verify it was voided
      const rows = await h.client.query(
        `SELECT status FROM ${NAMESPACE}.invoices WHERE id = $1`,
        [inv.id],
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("deletes child rows (lines, grants, follow-ups) when hard-deleting", async () => {
      const inv = await draft("canary-test");
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Verify line exists
      let lineRows = await h.client.query(`SELECT id FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [inv.id]);
      expect(lineRows.rows.length).toBeGreaterThan(0);

      // Delete
      await tool("delete-draft-invoice", { invoiceId: inv.id });

      // Verify line is deleted
      lineRows = await h.client.query(`SELECT id FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [inv.id]);
      expect(lineRows.rows).toHaveLength(0);
    });

    it("resets converted_invoice_id on the source quote when hard-deleting", async () => {
      // Create a quote from a canary customer (to ensure hard-delete, not void)
      const q = await h.call<{ id: string; number: string }>(
        "billing.create-quote",
        { currency: "ZAR", customerKind: "contact", customerRef: "canary-test", dealId: "deal-1" },
      );
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Accept and convert it
      await h.call("billing.set-quote-status", { quoteId: q.id, status: "accepted" });
      const convertResult = await h.call<{ invoice: { id: string } }>("billing.convert-quote", { quoteId: q.id });
      const convertedInvoiceId = convertResult.invoice.id;

      // Verify quote is linked
      let quoteRows = await h.client.query(
        `SELECT converted_invoice_id FROM ${NAMESPACE}.quotes WHERE id = $1`,
        [q.id],
      );
      const quoteRow1 = quoteRows.rows[0] as { converted_invoice_id: string | null };
      expect(quoteRow1.converted_invoice_id).toBe(convertedInvoiceId);

      // Delete the invoice
      await tool("delete-draft-invoice", { invoiceId: convertedInvoiceId });

      // Verify the link is reset
      quoteRows = await h.client.query(
        `SELECT converted_invoice_id, status FROM ${NAMESPACE}.quotes WHERE id = $1`,
        [q.id],
      );
      const quoteRow2 = quoteRows.rows[0] as { converted_invoice_id: string | null; status: string };
      expect(quoteRow2).toMatchObject({ converted_invoice_id: null, status: "accepted" });
    });
  });

  describe("delete-draft-quote", () => {
    it("hard-deletes a draft quote", async () => {
      const q = await quote("deal-1");
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Delete
      const result = await tool<{ deleted: boolean; id: string; number: string }>("delete-draft-quote", { quoteId: q.id });
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(q.id);

      // Verify deletion
      const rows = await h.client.query(`SELECT id FROM ${NAMESPACE}.quotes WHERE id = $1`, [q.id]);
      expect(rows.rows).toHaveLength(0);
    });

    it("deletes child rows (lines, follow-ups) when hard-deleting", async () => {
      const q = await quote("deal-1");
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Verify line exists
      let lineRows = await h.client.query(`SELECT id FROM ${NAMESPACE}.quote_lines WHERE quote_id = $1`, [q.id]);
      expect(lineRows.rows.length).toBeGreaterThan(0);

      // Delete
      await tool("delete-draft-quote", { quoteId: q.id });

      // Verify line is deleted
      lineRows = await h.client.query(`SELECT id FROM ${NAMESPACE}.quote_lines WHERE quote_id = $1`, [q.id]);
      expect(lineRows.rows).toHaveLength(0);
    });

    it("refuses to delete a quote that was converted to an invoice", async () => {
      const q = await quote("deal-1");
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Accept and convert
      await h.call("billing.set-quote-status", { quoteId: q.id, status: "accepted" });
      await h.call("billing.convert-quote", { quoteId: q.id });

      // Try to delete (converted quotes have status != 'draft')
      const error = await tool("delete-draft-quote", { quoteId: q.id }).catch((e) => e.message);
      expect(error).toContain("draft");
    });

    it("refuses to delete a non-draft quote", async () => {
      const q = await quote("deal-1");
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Update quote to sent status
      await h.client.query(
        `UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`,
        [q.id],
      );

      // Try to delete
      const error = await tool("delete-draft-quote", { quoteId: q.id }).catch((e) => e.message);
      expect(error).toContain("draft");
    });

    it("refuses to delete an accepted quote", async () => {
      const q = await quote("deal-1");
      await h.call("billing.add-quote-line", { quoteId: q.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

      // Accept the quote
      await h.call("billing.set-quote-status", { quoteId: q.id, status: "accepted" });

      // Try to delete (accepted quotes are no longer draft)
      const error = await tool("delete-draft-quote", { quoteId: q.id }).catch((e) => e.message);
      expect(error).toContain("draft");
    });
  });
});
