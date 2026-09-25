import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertAgentMaySend, assertQuoteStatus, canSeeInvoice, createExpense, lineTotal, markPaid, markSent, nextNumber, type InvoiceState } from "../src/domain.js";
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
