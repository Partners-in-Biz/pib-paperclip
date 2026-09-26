import { describe, expect, it } from "vitest";
import { isBalanced } from "@partnersinbiz/pib-plugin-kit";
import {
  billJournal,
  billPaymentJournal,
  creditNoteJournal,
  expenseJournal,
  invoiceIssueJournal,
  invoiceVoidJournal,
  parseLedgerKey,
  paymentJournal,
  realisedFxJournal,
  reverseJournal,
  writeOffJournal,
} from "../src/ledger.js";
import { computeDocument, splitByGroups } from "../src/money.js";

const totals = computeDocument(
  [
    { quantity: 1, unitAmountMinor: 100_000, taxCode: "za_std_15" },
    { quantity: 1, unitAmountMinor: 20_000, taxCode: "za_zero" },
  ],
  {},
);

const issue = invoiceIssueJournal({
  id: "inv-1",
  number: "LUM-001",
  date: "2026-09-26T10:00:00Z",
  currency: "ZAR",
  customerKind: "contact",
  customerRef: "ct-1",
  customerName: "Lumen",
  totalMinor: totals.totalMinor,
  groups: totals.groups,
});

describe("ledger payloads", () => {
  it("issues an invoice: AR / revenue per VAT code / output VAT with tax base", () => {
    expect(issue.key).toBe("billing:invoice:inv-1:issue");
    expect(issue.source).toEqual({ plugin: "partnersinbiz.billing", kind: "invoice", id: "inv-1" });
    expect(issue.date).toBe("2026-09-26");
    expect(isBalanced(issue.lines)).toBe(true);
    expect(issue.lines).toEqual([
      expect.objectContaining({ role: "ar", debitMinor: 135_000, creditMinor: 0, clientKind: "contact", clientRef: "ct-1" }),
      expect.objectContaining({ role: "revenue", creditMinor: 100_000, taxCode: "za_std_15", taxBaseMinor: 100_000 }),
      expect.objectContaining({ role: "vat_output", creditMinor: 15_000, taxCode: "za_std_15", taxBaseMinor: 100_000 }),
      expect.objectContaining({ role: "revenue", creditMinor: 20_000, taxCode: "za_zero", taxBaseMinor: 20_000 }),
    ]);
  });

  it("voids by reversing the issue journal", () => {
    const v = invoiceVoidJournal(issue, { id: "inv-1", number: "LUM-001", date: "2026-09-27" });
    expect(v.reverseKey).toBe(issue.key);
    expect(isBalanced(v.lines)).toBe(true);
    expect(v.lines[0]).toMatchObject({ role: "ar", creditMinor: 135_000, debitMinor: 0 });
  });

  it("records a payment on the matched bank account with the bank line in memo and dimensions", () => {
    const p = paymentJournal({ id: "pay-1", invoiceNumber: "LUM-001", date: "2026-09-28", currency: "ZAR", amountMinor: 50_000, customerKind: "contact", customerRef: "ct-1", bankTxId: "tx-9", bankAccountCode: "1010", method: "eft", reference: "LUM-001" });
    expect(isBalanced(p.lines)).toBe(true);
    expect(p.lines[0]).toMatchObject({ role: "bank", accountCode: "1010", debitMinor: 50_000, dimensions: { bankTxId: "tx-9", invoice: "LUM-001", method: "eft" } });
    expect(p.memo).toContain("bank tx tx-9");
    const manual = paymentJournal({ id: "pay-2", invoiceNumber: "LUM-001", date: "2026-09-28", currency: "ZAR", amountMinor: 1, customerKind: "contact", customerRef: "ct-1", method: "eft" });
    expect(manual.lines[0]!.accountCode).toBeUndefined();
    expect(paymentJournal({ id: "pay-3", invoiceNumber: "X", date: "2026-09-28", currency: "ZAR", amountMinor: 1, customerKind: "contact", customerRef: "c", method: "eft", keySuffix: "bank:tx-1" }).key).toBe("billing:payment:pay-3:bank:tx-1");
  });

  it("writes off with the VAT share on output VAT (VAT201 bad-debt adjustment)", () => {
    const w = writeOffJournal({ invoiceId: "inv-1", invoiceNumber: "LUM-001", date: "2026-12-01", currency: "ZAR", amountMinor: 13_500, customerKind: "contact", customerRef: "ct-1", split: splitByGroups(13_500, totals.groups) });
    expect(isBalanced(w.lines)).toBe(true);
    expect(w.lines).toEqual([
      expect.objectContaining({ role: "bad_debts", debitMinor: 12_000 }),
      expect.objectContaining({ role: "vat_output", debitMinor: 1_500, taxCode: "za_std_15", taxBaseMinor: 10_000 }),
      expect.objectContaining({ role: "ar", creditMinor: 13_500 }),
    ]);
  });

  it("reverses revenue and VAT proportionally on a credit note", () => {
    const cn = creditNoteJournal({ id: "cn-1", number: "CN-LUM-001", invoiceNumber: "LUM-001", date: "2026-09-29", currency: "ZAR", amountMinor: 13_500, customerKind: "contact", customerRef: "ct-1", split: splitByGroups(13_500, totals.groups) });
    expect(isBalanced(cn.lines)).toBe(true);
    const vat = cn.lines.find((l) => l.role === "vat_output")!;
    expect(vat.debitMinor).toBe(1_500);
    expect(cn.lines.find((l) => l.role === "ar")!.creditMinor).toBe(13_500);
  });

  it("books bills, bill payments, expenses, write-offs and realised FX in balance", () => {
    const bill = billJournal({ id: "b-1", supplierName: "Hosting Co", date: "2026-09-01", currency: "ZAR", totalMinor: 23_000, lines: [{ category: "hosting", taxCode: "za_std_15", netMinor: 10_000, vatMinor: 1_500 }, { category: "software", taxCode: "za_std_15", netMinor: 10_000, vatMinor: 1_500 }] });
    expect(bill.lines).toEqual([
      expect.objectContaining({ role: "expense:hosting", debitMinor: 10_000 }),
      expect.objectContaining({ role: "expense:software", debitMinor: 10_000 }),
      expect.objectContaining({ role: "vat_input", debitMinor: 3_000, taxCode: "za_std_15", taxBaseMinor: 20_000 }),
      expect.objectContaining({ role: "ap", creditMinor: 23_000 }),
    ]);
    const payments = [
      billPaymentJournal({ id: "bp-1", supplierName: "Hosting Co", date: "2026-09-10", currency: "ZAR", amountMinor: 23_000, bankTxId: "tx-2" }),
      expenseJournal({ id: "e-1", version: 1, description: "Lunch", date: "2026-09-02", currency: "ZAR", amountMinor: 11_500, vatMinor: 1_500, vatClaimable: false, category: "meals", paidFrom: "cash" }),
      expenseJournal({ id: "e-2", version: 2, description: "Laptop", date: "2026-09-02", currency: "ZAR", amountMinor: 1_150_000, vatMinor: 150_000, vatClaimable: true, category: "equipment", paidFrom: "owner" }),
      writeOffJournal({ invoiceId: "inv-1", invoiceNumber: "LUM-001", date: "2026-12-01", currency: "ZAR", amountMinor: 7_000, customerKind: "contact", customerRef: "ct-1" }),
    ];
    for (const journal of [bill, ...payments]) expect(isBalanced(journal.lines), journal.key).toBe(true);
    expect(payments[1]!.lines).toEqual([expect.objectContaining({ role: "expense:meals", debitMinor: 11_500 }), expect.objectContaining({ role: "cash", creditMinor: 11_500 })]);
    expect(payments[2]!.lines.map((l) => l.role)).toEqual(["expense:equipment", "vat_input", "owner_equity"]);
    expect(payments[3]!.lines.map((l) => l.role)).toEqual(["bad_debts", "ar"]);

    const gain = realisedFxJournal({ paymentId: "p", invoiceNumber: "X-1", date: "2026-09-20", bookCurrency: "ZAR", allocatedMinor: 10_000, issueRate: 18, paymentRate: 18.5, customerKind: "company", customerRef: "c" })!;
    expect(gain.lines).toEqual([expect.objectContaining({ role: "ar", debitMinor: 5_000 }), expect.objectContaining({ role: "fx_gain", creditMinor: 5_000 })]);
    const loss = realisedFxJournal({ paymentId: "p", invoiceNumber: "X-1", date: "2026-09-20", bookCurrency: "ZAR", allocatedMinor: 10_000, issueRate: 18.5, paymentRate: 18, customerKind: "company", customerRef: "c" })!;
    expect(loss.lines.map((l) => l.role)).toEqual(["fx_loss", "ar"]);
    expect(realisedFxJournal({ paymentId: "p", invoiceNumber: "X", date: "2026-09-20", bookCurrency: "ZAR", allocatedMinor: 10_000, issueRate: 18, paymentRate: 18, customerKind: "company", customerRef: "c" })).toBeNull();

    const reversed = reverseJournal(payments[2]!, "2026-09-03");
    expect(reversed.key).toBe("billing:expense:e-2:v2:reverse");
    expect(reversed.reverseKey).toBe("billing:expense:e-2:v2");
    expect(isBalanced(reversed.lines)).toBe(true);
  });

  it("refuses to build an unbalanced journal", () => {
    expect(() => writeOffJournal({ invoiceId: "i", invoiceNumber: "X", date: "2026-01-01", currency: "ZAR", amountMinor: 0, customerKind: "contact", customerRef: "c" })).toThrow(/does not balance/);
  });

  it("parses its own keys", () => {
    expect(parseLedgerKey("billing:invoice:abc:issue")).toEqual({ kind: "invoice", id: "abc", event: "issue" });
    expect(parseLedgerKey("billing:payment:abc")).toEqual({ kind: "payment", id: "abc", event: null });
    expect(parseLedgerKey("billing:expense:abc:v2:reverse")).toEqual({ kind: "expense", id: "abc", event: "v2:reverse" });
    expect(parseLedgerKey("payroll:run:1")).toBeNull();
  });
});
