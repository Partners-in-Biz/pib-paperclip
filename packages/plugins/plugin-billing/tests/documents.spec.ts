import { describe, expect, it } from "vitest";
import { copyInvoiceFields } from "../src/invoices.js";
import { docTitle, documentPdfSpec, renderDocument, statementPdfSpec, statementRows, type DocView } from "../src/documents.js";
import { invoiceEmail, isEmail, mailKey, parseAddresses, parseMailKey, reminderEmail, renderTemplate } from "../src/mail.js";
import { ageBucket, ageing, converterFor, expenseSummary, mrrMetrics, revenueByClient, revenueByMonth } from "../src/reports.js";
import { extractReceipt, expenseQuestions, expenseState, normaliseReceipt, ruleVatClaimable } from "../src/receipts.js";
import { computeDocument } from "../src/money.js";
import { renderDocumentPdf } from "@partnersinbiz/pib-plugin-kit";
import type { InvoiceRow } from "../src/db.js";

const totals = computeDocument([{ quantity: 2, unitAmountMinor: 50_000, taxCode: "za_std_15" }, { quantity: 1, unitAmountMinor: 10_000, taxCode: "za_zero" }], {});
const view: DocView = {
  kind: "invoice",
  number: "LUM-001",
  status: "sent",
  currency: "ZAR",
  issuedAt: "2026-09-26T10:00:00Z",
  dueAt: "2026-10-10T00:00:00Z",
  sender: { name: "Partners in Biz", vatNumber: "4123456789", address: "1 Main Rd\nBallito" },
  customer: { name: "Lumen Digital", email: "ap@lumen.test" },
  lines: totals.lines.map((l, i) => ({ description: i === 0 ? "SEO sprint — month 1" : "Export report", quantity: i === 0 ? 2 : 1, unitAmountMinor: i === 0 ? 50_000 : 10_000, ...l })),
  groups: totals.groups,
  subtotalMinor: totals.subtotalMinor,
  vatMinor: totals.vatMinor,
  totalMinor: totals.totalMinor,
  pricesIncludeVat: false,
  legacy: false,
  paidMinor: 20_000,
  creditedMinor: 0,
  outstandingMinor: totals.totalMinor - 20_000,
  payment: { bankName: "FNB", accountNumber: "62000000000", branchCode: "250655" },
  notes: "Thank you",
};

describe("PDF documents", () => {
  it("builds a tax invoice with VAT per code, balance due and EFT reference", () => {
    const spec = documentPdfSpec(view);
    expect(spec.title).toBe("Tax invoice");
    expect(spec.number).toBe("LUM-001");
    expect(spec.details).toContainEqual(["Reference", "LUM-001"]);
    expect(spec.totals!.map((t) => t.label)).toEqual(["Subtotal (excl. VAT)", "VAT 15%", "Zero-rated", "Total", "Paid", "Balance due"]);
    expect(spec.totals!.find((t) => t.label === "Balance due")!.value).toBe("R 1,050.00");
    expect(spec.sections!.map((s) => s.heading)).toEqual(["Payment details (EFT)", "Proof of payment", "Notes"]);
    expect(spec.sections![0]!.lines).toContain("Reference: LUM-001");
    expect(spec.stamp).toBeNull();
    expect(docTitle({ kind: "invoice", sender: {} })).toBe("Invoice");
    expect(docTitle({ kind: "credit_note", sender: { vatNumber: "1" } })).toBe("Tax credit note");
    expect(documentPdfSpec({ ...view, status: "paid" }).stamp).toBe("Paid");
  });

  it("renders invoice and statement PDFs", async () => {
    const bytes = await renderDocument(view);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const statement = {
      currency: "ZAR",
      from: "2026-07-01",
      to: "2026-09-30",
      sender: { name: "PiB" },
      customer: { name: "Lumen" },
      openingMinor: 10_000,
      entries: [
        { date: "2026-08-02", kind: "payment" as const, reference: "LUM-001", description: "Payment", debitMinor: 0, creditMinor: 10_000 },
        { date: "2026-08-01", kind: "invoice" as const, reference: "LUM-002", description: "Invoice", debitMinor: 115_000, creditMinor: 0 },
      ],
      ageing: { current: 115_000, d30: 0, d60: 0, d90: 0, d90plus: 0 },
    };
    expect(statementRows(statement).map((r) => r.balanceMinor)).toEqual([125_000, 115_000]);
    const pdf = await renderDocumentPdf(statementPdfSpec(statement));
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(statementPdfSpec(statement).totals!.at(-1)).toEqual({ label: "Amount due", value: "R 1,150.00", bold: true });
  });
});

describe("emails", () => {
  it("writes the invoice email with EFT details and a POP request", () => {
    const email = invoiceEmail(view, { hasAttachment: true });
    expect(email.subject).toBe("Invoice LUM-001 from Partners in Biz");
    expect(email.text).toContain("Please find invoice LUM-001 for R 1,050.00, due on 2026-10-10. The PDF is attached.");
    expect(email.text).toContain("reply to this email with your proof of payment");
    expect(email.html).toContain("62000000000");
    expect(email.html).toContain("Hi Lumen,");
    const bare = invoiceEmail({ ...view, customer: { name: "<b>X</b>" } }, { hasAttachment: false });
    expect(bare.html).not.toContain("<b>X</b>");
    expect(bare.text).toContain("SEO sprint — month 1");
  });

  it("parses keys, addresses and templates", () => {
    expect(mailKey("invoice", "abc", 2)).toBe("billing:mail:invoice:abc:2");
    expect(parseMailKey("billing:mail:reminder:abc:3")).toEqual({ kind: "reminder", id: "abc", n: 3 });
    expect(parseMailKey("other")).toBeNull();
    expect(parseAddresses("ap@x.com, Jo Soap <JO@Y.com>; bad, ap@x.com")).toEqual([{ email: "ap@x.com", name: null }, { email: "jo@y.com", name: "Jo Soap" }]);
    expect(isEmail("a@b.co")).toBe(true);
    expect(renderTemplate("Invoice {{invoiceNumber}} for {{ amount }} {{unknown}}", { invoiceNumber: "LUM-1", amount: "R 5" })).toBe("Invoice LUM-1 for R 5 {{unknown}}");
    const reminder = reminderEmail({ subject: "Reminder {{invoiceNumber}}", body: "Hi {{clientName}},\n\nPlease pay." }, { invoiceNumber: "LUM-1", clientName: "Lumen" }, { bankName: "FNB" }, "LUM-1");
    expect(reminder.subject).toBe("Reminder LUM-1");
    expect(reminder.html).toContain("Reference");
  });
});

describe("recurring copies", () => {
  it("keeps every field of the template", () => {
    const template = {
      id: "t", company_id: "w", number: "LUM-001", status: "paid", currency: "USD", customer_kind: "company", customer_ref: "co", sender: { name: "PiB" }, customer: { name: "Lumen", email: "a@b.c" },
      sender_snapshot: { frozen: true }, customer_snapshot: { frozen: true }, total_minor: 115_000, tax_rate: 15, due_at: "2026-09-15T00:00:00Z", approval_issue_id: "x", pending_action: "pay",
      sent_at: "2026-09-01T00:00:00Z", default_tax_code: "za_std_15", prices_include_vat: true, notes: "Terms", subtotal_minor: 100_000, vat_minor: 15_000, send_to: [{ email: "ap@b.c" }],
    } as unknown as InvoiceRow;
    const copy = copyInvoiceFields(template, { id: "n", number: "LUM-002" }, new Date("2026-10-01T00:00:00Z"));
    expect(copy).toMatchObject({
      id: "n", number: "LUM-002", status: "draft", currency: "USD", customer_kind: "company", customer_ref: "co", sender: { name: "PiB" }, customer: { name: "Lumen", email: "a@b.c" },
      sender_snapshot: null, customer_snapshot: null, total_minor: 115_000, tax_rate: 15, approval_issue_id: null, pending_action: null, sent_at: null,
      default_tax_code: "za_std_15", prices_include_vat: true, notes: "Terms", subtotal_minor: 100_000, vat_minor: 15_000, send_to: [{ email: "ap@b.c" }],
    });
    expect(copy.due_at).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("reports", () => {
  const convert = converterFor("ZAR", { USD: 18 });
  const now = new Date("2026-09-26T00:00:00Z");

  it("ages outstanding amounts into 0-30 / 31-60 / 61-90 / 90+", () => {
    expect([ageBucket(-5), ageBucket(30), ageBucket(31), ageBucket(61), ageBucket(91)]).toEqual(["0-30", "0-30", "31-60", "61-90", "90+"]);
    const report = ageing(
      [
        { id: "a", number: "A", party: "Lumen", partyKey: "c:1", currency: "ZAR", outstandingMinor: 10_000, dueAt: "2026-09-30T00:00:00Z" },
        { id: "b", number: "B", party: "Lumen", partyKey: "c:1", currency: "ZAR", outstandingMinor: 5_000, dueAt: "2026-08-10T00:00:00Z" },
        { id: "c", number: "C", party: "Acme", partyKey: "c:2", currency: "USD", outstandingMinor: 1_000, dueAt: "2026-05-01T00:00:00Z" },
        { id: "d", number: "D", party: "Acme", partyKey: "c:2", currency: "EUR", outstandingMinor: 1_000, dueAt: null },
        { id: "e", number: "E", party: "Paid", partyKey: "c:3", currency: "ZAR", outstandingMinor: 0, dueAt: "2026-01-01T00:00:00Z" },
      ],
      now,
      "ZAR",
      convert,
    );
    expect(report.buckets).toEqual({ "0-30": { count: 1, amountMinor: 10_000 }, "31-60": { count: 1, amountMinor: 5_000 }, "61-90": { count: 0, amountMinor: 0 }, "90+": { count: 1, amountMinor: 18_000 } });
    expect(report.unconverted).toBe(1);
    expect(report.parties[0]).toMatchObject({ party: "Acme", totalMinor: 18_000 });
  });

  it("reports revenue invoiced and collected by month, per client, expenses and MRR", () => {
    const invoices = [
      { id: "1", status: "paid", currency: "ZAR", sentAt: "2026-08-05T00:00:00Z", subtotalMinor: 100_000, vatMinor: 15_000, totalMinor: 115_000, clientKey: "c:1", clientName: "Lumen" },
      { id: "2", status: "draft", currency: "ZAR", sentAt: null, subtotalMinor: 50_000, vatMinor: 0, totalMinor: 50_000, clientKey: "c:1", clientName: "Lumen" },
      { id: "3", status: "sent", currency: "USD", sentAt: "2026-09-01T00:00:00Z", subtotalMinor: 1_000, vatMinor: 0, totalMinor: 1_000, fxRate: 17.5, clientKey: "c:2", clientName: "Acme" },
    ];
    const payments = [{ invoiceId: "1", currency: "ZAR", paidAt: "2026-09-02T00:00:00Z", allocatedMinor: 115_000, clientKey: "c:1", clientName: "Lumen" }];
    const revenue = revenueByMonth({ invoices, payments, from: "2026-08-01", to: "2026-09-30", book: "ZAR", convert });
    expect(revenue.months).toEqual([
      { month: "2026-08", invoicedMinor: 100_000, vatMinor: 15_000, collectedMinor: 0, invoices: 1 },
      { month: "2026-09", invoicedMinor: 17_500, vatMinor: 0, collectedMinor: 115_000, invoices: 1 },
    ]);
    const clients = revenueByClient({
      invoices: invoices.map((i) => ({ ...i, outstandingMinor: i.status === "sent" ? 1_000 : 0 })),
      payments,
      from: "2026-08-01",
      to: "2026-09-30",
      book: "ZAR",
      convert,
    });
    expect(clients.clients[0]).toMatchObject({ clientKey: "c:1", lifetimePaidMinor: 115_000, invoices: 1, lastPaidAt: "2026-09-02T00:00:00Z" });
    expect(clients.clients[1]).toMatchObject({ clientKey: "c:2", outstandingMinor: 17_500 });
    const expenses = expenseSummary({
      items: [
        { category: "software", currency: "ZAR", amountMinor: 11_500, vatMinor: 1_500, vatClaimable: true, date: "2026-09-01", source: "expense" },
        { category: "software", currency: "ZAR", amountMinor: 5_000, vatMinor: 0, vatClaimable: false, date: "2026-09-03", source: "bill" },
        { category: "travel", currency: "ZAR", amountMinor: 9_999, vatMinor: 0, vatClaimable: false, date: "2025-01-01", source: "expense" },
      ],
      from: "2026-08-01",
      to: "2026-09-30",
      book: "ZAR",
      convert,
    });
    expect(expenses.categories).toEqual([{ category: "software", totalMinor: 16_500, vatClaimableMinor: 1_500, count: 2, bills: 1 }]);
    const mrr = mrrMetrics({
      items: [
        { status: "active", priceMinor: 300_000, currency: "ZAR", period: "monthly", startedAt: "2026-01-01T00:00:00Z", cancelledAt: null },
        { status: "active", priceMinor: 1_200_000, currency: "ZAR", period: "yearly", startedAt: "2026-09-10T00:00:00Z", cancelledAt: null },
        { status: "cancelled", priceMinor: 90_000, currency: "ZAR", period: "quarterly", startedAt: "2026-02-01T00:00:00Z", cancelledAt: "2026-09-20T00:00:00Z" },
      ],
      now,
      book: "ZAR",
      convert,
    });
    expect(mrr).toMatchObject({ mrrMinor: 400_000, arrMinor: 4_800_000, active: 2, newMrrMinor: 100_000, churnedMrrMinor: 30_000, churned: 1, churnRate: 0.5 });
  });
});

describe("receipts", () => {
  it("normalises what Claude returns", () => {
    expect(normaliseReceipt({ vendor: " Takealot ", date: "2026-09-10", totalMinor: 115_000, vatMinor: 999_999, currency: "zar" })).toEqual({ vendor: "Takealot", date: "2026-09-10", totalMinor: 115_000, vatMinor: null, currency: "ZAR" });
    expect(normaliseReceipt({ date: "10 Sept", totalMinor: 12.5 })).toEqual({ vendor: null, date: null, totalMinor: null, vatMinor: null, currency: null });
  });

  it("sends PDFs as document blocks with a JSON schema and reads the answer", async () => {
    let sent: any = null;
    const fields = await extractReceipt(
      { apiKey: "k", model: "claude-haiku-4-5-20251001" },
      { bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" },
      (async (_url: string, init: RequestInit) => {
        sent = { headers: init.headers, body: JSON.parse(String(init.body)) };
        return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: '{"vendor":"Vodacom","date":"2026-09-01","totalMinor":49900,"vatMinor":6509,"currency":"ZAR"}' }] });
      }) as unknown as typeof fetch,
    );
    expect(fields).toEqual({ vendor: "Vodacom", date: "2026-09-01", totalMinor: 49_900, vatMinor: 6_509, currency: "ZAR" });
    expect(sent.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(sent.body.messages[0].content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(sent.body.output_config.format.schema.required).toEqual(["vendor", "date", "totalMinor", "vatMinor", "currency"]);
    await expect(extractReceipt({ apiKey: "k", model: "m" }, { bytes: new Uint8Array(), mime: "text/plain" })).rejects.toThrow(/PDF or an image/);
  });

  it("asks Jev only named fields and falls back to rules", () => {
    const state = expenseState({ vendor: "Uber", description: "Airport", amountMinor: 45_000, currency: "ZAR", vatMinor: 5_870, senderVatRegistered: true });
    expect(state).toEqual({ vendor: "Uber", description: "Airport", amount: "R100–R1k", currency: "ZAR", vat_shown_on_receipt: true, we_are_vat_registered: true });
    const questions = expenseQuestions(["software", "travel", "other"]);
    expect(questions.category).toMatchObject({ type: "choice", criteria: { software: null, travel: null, other: null } });
    expect(questions.vat_claimable!.type).toBe("noul");
    expect(ruleVatClaimable({ vatMinor: 100, senderVatRegistered: true, category: "software" })).toBe(true);
    expect(ruleVatClaimable({ vatMinor: 100, senderVatRegistered: true, category: "meals" })).toBe(false);
    expect(ruleVatClaimable({ vatMinor: 100, senderVatRegistered: false, category: "software" })).toBe(false);
  });
});
