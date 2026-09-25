import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertAgentMaySend, assertFrequency, assertQuoteStatus, assertTaxRate, buildInvoiceHtml, canSeeInvoice, createCreditNote, createExpense, createPayment, lineTotal, markPaid, markSent, nextNumber, nextRunDate, totalWithTax, type InvoiceState } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

const draft: InvoiceState = {
  status: "draft",
  sender: { name: "Northwind" },
  customer: { name: "Ada", refKind: "contact", refId: "contact-1" },
  senderSnapshot: null,
  customerSnapshot: null,
  sentAt: null,
};

describe("billing", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_billing_287195dc99");
    const sql = readFileSync(new URL("../migrations/001_billing.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.invoices`);
    expect(sql).toContain("total_minor");
    expect(sql).toContain("sender_snapshot");
  });

  it("lets an agent draft and refuses a send", () => {
    expect(lineTotal([{ quantity: 2, unitAmountMinor: 1500 }])).toBe(3000);
    expect(() => assertAgentMaySend()).toThrow(/may not send/);
  });

  it("freezes sender and customer snapshots when a draft is sent", () => {
    const sent = markSent(draft, "2026-09-25T12:00:00Z");
    expect(sent.status).toBe("sent");
    expect(sent.senderSnapshot).toEqual(draft.sender);
    expect(sent.customerSnapshot).toEqual(draft.customer);
    expect(markPaid(sent).status).toBe("paid");
  });

  it("shows a named invoice to the partner company that holds the grant", () => {
    expect(canSeeInvoice("workspace-b", "workspace-a", [])).toBe(false);
    expect(canSeeInvoice("workspace-b", "workspace-a", [{ granteeCompanyId: "workspace-b" }])).toBe(true);
  });
});

describe("billing numbering", () => {
  it("produces the next sequential number", () => {
    expect(nextNumber("INV", [])).toBe("INV-0001");
    expect(nextNumber("INV", ["INV-0001", "INV-0003"])).toBe("INV-0004");
    expect(nextNumber("QTE", ["QTE-0007"])).toBe("QTE-0008");
  });

  it("ignores numbers from other prefixes", () => {
    expect(nextNumber("INV", ["QTE-0001", "INV-0002"])).toBe("INV-0003");
  });
});

describe("billing expenses", () => {
  it("creates an expense with defaults", () => {
    const expense = createExpense({ companyId: "workspace-a", description: "Hosting", amountMinor: 50000 });
    expect(expense.currency).toBe("ZAR");
    expect(expense.category).toBe("other");
    expect(expense.amountMinor).toBe(50000);
  });

  it("rejects a blank description and a negative amount", () => {
    expect(() => createExpense({ companyId: "workspace-a", description: "  ", amountMinor: 1 })).toThrow(/description is required/);
    expect(() => createExpense({ companyId: "workspace-a", description: "X", amountMinor: -1 })).toThrow(/non-negative/);
  });
});

describe("billing quote status", () => {
  it("accepts only the known quote statuses", () => {
    expect(assertQuoteStatus("accepted")).toBe("accepted");
    expect(() => assertQuoteStatus("paid")).toThrow(/draft, sent, accepted/);
  });
});

describe("billing invoice html", () => {
  it("builds a printable invoice with the total", () => {
    const html = buildInvoiceHtml({
      number: "INV-0001",
      status: "draft",
      currency: "ZAR",
      sender: { name: "Northwind" },
      customer: { name: "Ada" },
      lines: [{ description: "Website", quantity: 2, unitAmountMinor: 150000 }],
      dueAt: null,
    });
    expect(html).toContain("Invoice INV-0001");
    expect(html).toContain("Northwind");
    expect(html).toContain("Ada");
    expect(html).toContain("3,000");
  });

  it("escapes HTML in names", () => {
    const html = buildInvoiceHtml({
      number: "INV-1",
      status: "draft",
      currency: "ZAR",
      sender: { name: "<b>Northwind</b>" },
      customer: { name: "Ada" },
      lines: [],
      dueAt: null,
    });
    expect(html).not.toContain("<b>Northwind</b>");
    expect(html).toContain("&lt;b&gt;Northwind&lt;/b&gt;");
  });
});

describe("billing recurring", () => {
  it("validates the frequency", () => {
    expect(assertFrequency("monthly")).toBe("monthly");
    expect(() => assertFrequency("weekly")).toThrow(/monthly, quarterly, or yearly/);
  });

  it("advances the run date by the period", () => {
    const base = new Date("2026-01-15T00:00:00Z");
    expect(nextRunDate(base, "monthly").toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(nextRunDate(base, "quarterly").toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(nextRunDate(base, "yearly").toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
});

describe("billing payments", () => {
  it("creates a payment with defaults", () => {
    const payment = createPayment({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: 50000 });
    expect(payment.method).toBe("bank");
    expect(payment.amountMinor).toBe(50000);
  });

  it("rejects a zero or negative amount", () => {
    expect(() => createPayment({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: 0 })).toThrow(/positive integer/);
    expect(() => createPayment({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: -5 })).toThrow(/positive integer/);
  });
});

describe("billing tax", () => {
  it("validates the tax rate", () => {
    expect(assertTaxRate(15)).toBe(15);
    expect(() => assertTaxRate(-1)).toThrow(/between 0 and 100/);
    expect(() => assertTaxRate(101)).toThrow(/between 0 and 100/);
  });

  it("computes tax and total", () => {
    const result = totalWithTax(100000, 15);
    expect(result.taxMinor).toBe(15000);
    expect(result.totalMinor).toBe(115000);
  });
});

describe("billing credit notes", () => {
  it("creates an issued credit note", () => {
    const note = createCreditNote({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: 50000, reason: "Refund" });
    expect(note.status).toBe("issued");
    expect(note.amountMinor).toBe(50000);
    expect(note.reason).toBe("Refund");
  });

  it("rejects a zero or negative amount", () => {
    expect(() => createCreditNote({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: 0 })).toThrow(/positive integer/);
    expect(() => createCreditNote({ companyId: "workspace-a", invoiceId: "inv-1", amountMinor: -5 })).toThrow(/positive integer/);
  });
});
