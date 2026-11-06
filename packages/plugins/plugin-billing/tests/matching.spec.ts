import { describe, expect, it } from "vitest";
import { decideBankMatch, parseOpenItemKey } from "../src/bank.js";
import { choosePopInvoice, findReferences, looksLikePop, matchByNumber, referenceKey, threadInvoiceId } from "../src/pop.js";
import { namesOnlyInvoice, popSearchText } from "../src/pop-references.js";
import { planReminders, stageToSend } from "../src/dunning.js";
import { DEFAULT_DUNNING_STAGES } from "../src/config.js";
import type { InvoiceBalance } from "../src/balances.js";

const open = [
  { id: "i1", number: "LUM-001", customerKind: "contact", customerRef: "ct-lumen" },
  { id: "i2", number: "LUM-002", customerKind: "contact", customerRef: "ct-lumen" },
  { id: "i3", number: "INV-0007", customerKind: "company", customerRef: "co-acme" },
];
const triage = (category: string | null) => ({ category: category as never, urgency: null, needsReply: null, phishing: null, confidence: null });

describe("proof of payment matching", () => {
  it("normalises invoice references", () => {
    expect(referenceKey("LUM-001")).toBe("LUM-1");
    expect(referenceKey("lum 1")).toBe("LUM-1");
    expect(referenceKey("INV-0007")).toBe("INV-7");
    expect(findReferences("Paid lum001 and INV 0007 today")).toEqual(["LUM-1", "INV-7"]);
    expect(findReferences("Re: Q-LUM-001 and CN-LUM-002")).toEqual([]);
    expect(findReferences("R 1500 paid")).toEqual([]);
  });

  it("matches the invoice number, the thread, or the sender's only open invoice", () => {
    expect(matchByNumber("POP for LUM-002", open).map((i) => i.id)).toEqual(["i2"]);
    expect(choosePopInvoice({ text: "POP LUM-002 and LUM-001", open })).toEqual({ invoiceId: "i1", basis: "number", others: ["i2"] });
    expect(choosePopInvoice({ threadInvoiceId: "i2", text: "see attached", open })).toEqual({ invoiceId: "i2", basis: "thread", others: [] });
    expect(choosePopInvoice({ text: "paid", open, senderClients: [{ kind: "company", ref: "co-acme" }] })).toEqual({ invoiceId: "i3", basis: "sender", others: [] });
    expect(choosePopInvoice({ text: "paid", open, senderClients: [{ kind: "contact", ref: "ct-lumen" }] })).toEqual({ invoiceId: null, basis: "none", others: [] });
  });

  it("treats POP-category mail and mail quoting an open invoice as POP, not newsletters or bills", () => {
    const mail = (category: string | null, subject: string) => ({ triage: triage(category), subject, snippet: "", attachments: [], replyTo: null });
    expect(looksLikePop(mail("proof_of_payment", "Payment"), open)).toBe(true);
    expect(looksLikePop(mail(null, "Paid LUM-001"), open)).toBe(true);
    expect(looksLikePop(mail("newsletter", "LUM-001 news"), open)).toBe(false);
    expect(looksLikePop(mail("invoice_or_bill", "Invoice LUM-001"), open)).toBe(false);
    expect(looksLikePop(mail(null, "Hello"), open)).toBe(false);
    expect(threadInvoiceId({ replyTo: { plugin: "partnersinbiz.billing", kind: "invoice", id: "i1" } })).toBe("i1");
    expect(threadInvoiceId({ replyTo: { plugin: "partnersinbiz.crm", kind: "invoice", id: "i1" } })).toBeNull();
  });
});

describe("bank match decisions", () => {
  const item = { outstandingMinor: 115_000, currency: "ZAR", open: true };
  it("settles only exact matches up to what is owed", () => {
    expect(decideBankMatch({ basis: "exact", amountMinor: 115_000, currency: "ZAR" }, item).action).toBe("settle");
    expect(decideBankMatch({ basis: "exact", amountMinor: 50_000, currency: "ZAR" }, item).action).toBe("settle");
    expect(decideBankMatch({ basis: "exact", amountMinor: 115_001, currency: "ZAR" }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "amount", amountMinor: 115_000, currency: "ZAR" }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "manual", amountMinor: 115_000, currency: "ZAR" }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "manual", amountMinor: 115_000, currency: "ZAR", matchedBy: { userId: "u1" } }, item).action).toBe("settle");
    expect(decideBankMatch({ basis: "amount", amountMinor: 115_000, currency: "ZAR", matchedBy: { agentId: "a1" } }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "manual", amountMinor: 115_001, currency: "ZAR", matchedBy: { userId: "u1" } }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "exact", amountMinor: 115_000, currency: "USD" }, item).action).toBe("review");
    expect(decideBankMatch({ basis: "exact", amountMinor: 115_000, currency: "ZAR" }, { ...item, open: false }).action).toBe("review");
    expect(decideBankMatch({ basis: "exact", amountMinor: 0, currency: "ZAR" }, item).action).toBe("reject");
  });

  it("reconciles a payment already recorded by a person", () => {
    expect(decideBankMatch({ basis: "amount", amountMinor: 115_000, currency: "ZAR" }, { ...item, open: false, recordedPaymentMatches: true }).action).toBe("settle");
    expect(parseOpenItemKey("invoice:abc")).toEqual({ kind: "invoice", id: "abc" });
    expect(parseOpenItemKey("bill:x")).toEqual({ kind: "bill", id: "x" });
    expect(parseOpenItemKey("other:x")).toBeNull();
  });
});

describe("dunning schedule", () => {
  it("sends the latest due stage once, never an earlier one late", () => {
    const stages = DEFAULT_DUNNING_STAGES;
    expect(stageToSend(stages, 0, [])).toBeNull();
    expect(stageToSend(stages, 1, [])).toBe(0);
    expect(stageToSend(stages, 6, [0])).toBeNull();
    expect(stageToSend(stages, 7, [0])).toBe(1);
    expect(stageToSend(stages, 20, [])).toBe(2);
    expect(stageToSend(stages, 20, [2])).toBeNull();
  });

  it("plans reminders for overdue, unpaid, opted-in invoices only", () => {
    const now = new Date("2026-09-26T08:00:00Z");
    const balance = (id: string, status: string, dueDaysAgo: number, outstanding: number, customerRef = "c1"): InvoiceBalance => ({
      invoice: { id, status, customer_kind: "company", customer_ref: customerRef, due_at: new Date(now.getTime() - dueDaysAgo * 86_400_000).toISOString() } as never,
      state: {} as never,
      outstandingMinor: outstanding,
      futurePaidMinor: 0,
      futurePayments: 0,
      nextFuturePaidAt: null,
    });
    const plans = planReminders({
      balances: [
        balance("a", "overdue", 8, 100),
        balance("b", "partially_paid", 15, 50),
        balance("c", "payment_pending_verification", 30, 100),
        balance("d", "overdue", 30, 100, "opted"),
        balance("e", "sent", -3, 100),
        balance("f", "overdue", 2, 100),
      ],
      stages: DEFAULT_DUNNING_STAGES,
      sentByInvoice: new Map([["f", [0]]]),
      optedOut: new Set(["company:opted"]),
      now,
    });
    expect(plans).toEqual([
      { invoiceId: "a", stage: 1, daysOverdue: 8 },
      { invoiceId: "b", stage: 2, daysOverdue: 15 },
    ]);
  });
});

describe("a proof naming one invoice", () => {
  it("is only true when this invoice is the only number named", () => {
    const kumari = "Morning Stean Attached is the PoP for INV ELE-006. Regards Kumari From: Stean van Wyk <stean@partnersinbiz.online> Sent: Monday, 02 November 2026 13:54 To: Kumari Pillay";
    expect(namesOnlyInvoice(kumari, "ELE-006")).toBe(true);
    expect(namesOnlyInvoice(kumari, "ELE-005")).toBe(false);
    expect(namesOnlyInvoice("PoP for ELE-006 and ELE-007", "ELE-006")).toBe(false);
    expect(namesOnlyInvoice("No number here", "ELE-006")).toBe(false);
    expect(namesOnlyInvoice("PoP for 2026-001", "2026-001")).toBe(false);
  });

  it("reads the subject, snippet and file names of a stored proof", () => {
    const text = popSearchText({ subject: "Paid", snippet: null, file_name: "pop.pdf", attachments: [{ filename: "ELE-006.pdf" }, null] });
    expect(namesOnlyInvoice(text, "ELE-006")).toBe(true);
    expect(popSearchText({ attachments: "not a list" })).not.toContain("not a list");
  });
});
