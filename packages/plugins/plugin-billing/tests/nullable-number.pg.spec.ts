/**
 * Billing 0.13 (PAR-6991): invoices.number is nullable and the sent-record columns exist, with no behaviour change.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertInvoice, type InvoiceRow } from "../src/db.js";
import { docFileName } from "../src/documents.js";
import { invoiceNumberLabel } from "../src/invoice-number.js";
import { NAMESPACE } from "../src/namespace.js";
import { receivableItem } from "../src/openitems.js";
import { draftsToSend } from "../src/ui/series.js";
import { COMPANY, embeddedAvailable, startHarness, type Harness } from "./helpers/harness.js";
import { validateMigration } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();

const base = (id: string, number: string | null) => ({
  id, company_id: COMPANY, number, status: "draft", currency: "ZAR", customer_kind: "company", customer_ref: "ct-x",
  sender: {}, customer: {}, total_minor: 1000, tax_rate: 15, due_at: null, default_tax_code: null, prices_include_vat: false,
  notes: null, subtotal_minor: 870, vat_minor: 130, send_to: null, recurring_id: null, recurring_key: null,
  subscription_id: null, quote_id: null, deal_id: null,
});

describe("the helper and the null-safe sites", () => {
  it("labels a missing number Draft", () => {
    expect(invoiceNumberLabel(null)).toBe("Draft");
    expect(invoiceNumberLabel("INV-0001")).toBe("INV-0001");
  });
  it("PDF file name, open-item references and the drafts sort do not throw on a null number", () => {
    expect(docFileName({ kind: "invoice", number: null })).toBe("Invoice-Draft.pdf");
    expect(docFileName({ kind: "invoice", number: "INV-0001" })).toBe("Invoice-INV-0001.pdf");
    const item = receivableItem({ invoice: { ...base("i1", null), customer: { name: "Acme" }, created_at: new Date(), updated_at: new Date() } as unknown as InvoiceRow, outstandingMinor: 1000 } as never);
    expect(item.references).toEqual(["Acme"]);
    const inv = (id: string, number: string | null) => ({ id, number, status: "draft", customerRef: "c", totalMinor: 1, currency: "ZAR", createdAt: "2026-11-01T00:00:00Z" });
    const out = draftsToSend({ invoices: [inv("a", null), inv("b", "INV-1"), inv("c", null)], quotes: [] } as never);
    expect(out.map((d) => d.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("the migration", () => {
  it("passes the host's rules and only adds or relaxes", () => {
    const sql = readFileSync(new URL("../migrations/017_billing.sql", import.meta.url), "utf8");
    expect(() => validateMigration(sql, NAMESPACE, [])).not.toThrow();
    expect(sql).not.toMatch(/\b(delete|drop\s+column|drop\s+table)\b/i);
  });
});

describe.skipIf(!available)("insertInvoice on the migrated schema (postgres)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); }, 60_000);
  afterAll(async () => { await h?.stop(); });
  beforeEach(async () => { await h.reset(); });

  it("the exact pre-migration statement still inserts a numbered row", async () => {
    // Verbatim from billing 0.12 db.ts insertInvoice (23 columns): old code must keep working after the migration.
    const r = base("inv-old", "INV-0001");
    const res = await h.client.query(
      `INSERT INTO ${NAMESPACE}.invoices
      (id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer, total_minor, tax_rate, due_at,
       default_tax_code, prices_include_vat, notes, subtotal_minor, vat_minor, send_to, recurring_id, recurring_key, subscription_id, quote_id, deal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23)
     ON CONFLICT DO NOTHING`,
      [r.id, r.company_id, r.number, r.status, r.currency, r.customer_kind, r.customer_ref, "{}", "{}", 1000, 15, null, null, false, null, 870, 130, null, null, null, null, null, null],
    );
    expect(res.rowCount).toBe(1);
    const rows = await h.client.query(`SELECT number, approval_recipients, sent_to, sent_message_id FROM ${NAMESPACE}.invoices WHERE id = 'inv-old'`);
    expect(rows.rows[0]).toEqual({ number: "INV-0001", approval_recipients: null, sent_to: null, sent_message_id: null });
  });

  it("insertInvoice accepts a null number and a number", async () => {
    expect(await insertInvoice(h.ctx, base("inv-null", null) as never)).toBe(1);
    expect(await insertInvoice(h.ctx, base("inv-num", "INV-0002") as never)).toBe(1);
    const rows = await h.client.query(`SELECT id, number FROM ${NAMESPACE}.invoices ORDER BY id`);
    expect(rows.rows).toEqual([{ id: "inv-null", number: null }, { id: "inv-num", number: "INV-0002" }]);
  });
});
