/**
 * Signed documents become draft invoices: the pure parts. What a hand-off from the CRM may say and how it is read, every way the
 * signed document can disagree with the quote it names, the words of the two issues, and the migration and skill text that go with it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRM_DEAL_ACCEPTED_EVENT, CRM_QUOTE_ACCEPTED_EVENT, parseAcceptance, quoteDifferences, signedInvoiceIssue, signedMismatchIssue, type Acceptance, type QuoteFacts } from "../src/accepted.js";
import { WORK_ORIGINS } from "../src/origins.js";
import { INVOICE_DRAFT_SKILL, SKILLS } from "../src/skills.js";
import { NAMESPACE } from "../src/namespace.js";
import type { InvoiceRow, QuoteRow } from "../src/db.js";
import { validateMigration } from "./helpers/sql-guard.js";

const DOC = "7a1c0e2e-5b1d-4c53-9e55-0a6f2f0b9c11";

const dealPayload = (over: Record<string, unknown> = {}) => ({
  key: `crm:esign:${DOC}:accepted`, documentId: DOC, kind: "quote", title: "Quote Q-ACM-001", dealId: "deal-1", quoteId: "q-1", quoteNumber: "Q-ACM-001",
  clientKind: "company", clientRef: "co-acme", clientName: "Acme Holdings", valueMinor: 115_000, currency: "ZAR", signerName: "Ada Lovelace",
  signedAt: "2026-10-04T08:15:00.000Z", contentSha256: "a".repeat(64), auditHead: "b".repeat(64), ...over,
});
const quotePayload = (over: Record<string, unknown> = {}) => ({
  key: `crm:esign:${DOC}:quote-accepted`, quoteId: "q-1", number: "Q-ACM-001", dealId: "deal-1", clientKind: "company", clientRef: "co-acme", totalMinor: 115_000, currency: "ZAR",
  acceptedAt: "2026-10-04T08:15:00.000Z", documentId: DOC, contentSha256: "a".repeat(64), auditHead: "b".repeat(64), signerName: "Ada Lovelace", ...over,
});

const quote = (over: Partial<QuoteFacts> = {}): QuoteFacts => ({ number: "Q-ACM-001", customer_kind: "company", customer_ref: "co-acme", total_minor: 115_000, subtotal_minor: 100_000, currency: "ZAR", deal_id: "deal-1", ...over });
const acc = (over: Partial<Acceptance> = {}): Acceptance => ({ ...parseAcceptance("quote", quotePayload())!, ...over });

describe("the two events", () => {
  it("are the CRM's e-sign hand-offs, under the CRM's key (the kit has no names for them yet)", () => {
    expect(CRM_DEAL_ACCEPTED_EVENT).toBe("plugin.partnersinbiz.crm.deal.accepted");
    expect(CRM_QUOTE_ACCEPTED_EVENT).toBe("plugin.partnersinbiz.crm.quote.accepted");
  });

  it("never the event Billing sends the CRM itself", () => {
    expect(CRM_QUOTE_ACCEPTED_EVENT).not.toBe("plugin.partnersinbiz.billing.quote.accepted");
  });
});

describe("reading a hand-off", () => {
  it("reads deal.accepted: the value is the amount, the quote is optional", () => {
    expect(parseAcceptance("deal", dealPayload())).toMatchObject({
      source: "deal", documentId: DOC, title: "Quote Q-ACM-001", dealId: "deal-1", quoteId: "q-1", quoteNumber: "Q-ACM-001", clientKind: "company", clientRef: "co-acme",
      clientName: "Acme Holdings", amountMinor: 115_000, currency: "ZAR", signerName: "Ada Lovelace", signedAt: "2026-10-04T08:15:00.000Z",
    });
    expect(parseAcceptance("deal", dealPayload({ quoteId: null, quoteNumber: null, valueMinor: null }))).toMatchObject({ quoteId: null, quoteNumber: null, amountMinor: null });
  });

  it("reads quote.accepted: the total is the amount, and the CRM's placeholder number 'quote' means no number", () => {
    expect(parseAcceptance("quote", quotePayload())).toMatchObject({ source: "quote", quoteId: "q-1", quoteNumber: "Q-ACM-001", amountMinor: 115_000, signedAt: "2026-10-04T08:15:00.000Z", title: null });
    expect(parseAcceptance("quote", quotePayload({ number: "quote" }))!.quoteNumber).toBeNull();
  });

  it("refuses a hand-off that names no signed document: nothing could be made once without it", () => {
    for (const bad of [{}, null, "x", 5, { ...quotePayload(), documentId: "" }, { ...quotePayload(), documentId: 12 }, { ...quotePayload(), documentId: "has space" }, { ...quotePayload(), documentId: "x".repeat(90) }]) {
      expect(parseAcceptance("quote", bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull();
    }
  });

  it("does not believe odd types: an amount must be a whole number of cents, a currency three capitals, a client kind company or contact", () => {
    const odd = parseAcceptance("deal", dealPayload({ valueMinor: "115000", currency: "zar", clientKind: "vendor", signedAt: "yesterday", dealId: 7 }))!;
    expect(odd).toMatchObject({ amountMinor: null, currency: null, clientKind: null, clientRef: null, signedAt: null, dealId: null });
    expect(parseAcceptance("deal", dealPayload({ valueMinor: 1.5 }))!.amountMinor).toBeNull();
    expect(parseAcceptance("deal", dealPayload({ valueMinor: -5 }))!.amountMinor).toBeNull();
  });
});

describe("what differs between the signed document and the quote", () => {
  it("nothing when the client, the amount, the currency and the deal all agree", () => {
    expect(quoteDifferences(acc(), quote())).toEqual([]);
    // No deal on either side is no difference.
    expect(quoteDifferences(acc({ dealId: null }), quote({ deal_id: null }))).toEqual([]);
    // A deal on one side only is fine: the invoice takes it.
    expect(quoteDifferences(acc(), quote({ deal_id: null }))).toEqual([]);
  });

  it("says the amounts exactly when they differ", () => {
    expect(quoteDifferences(acc({ amountMinor: 100_000 }), quote({ subtotal_minor: 90_000 }))).toEqual(["The client signed R 1,000.00, but quote Q-ACM-001 totals R 1,150.00."]);
  });

  it("recognises the quote's total without VAT, which is the usual way an agent gets it wrong", () => {
    const [line] = quoteDifferences(acc({ amountMinor: 100_000 }), quote());
    expect(line).toContain("The client signed R 1,000.00, but quote Q-ACM-001 totals R 1,150.00");
    expect(line).toContain("the quote's total without VAT");
    expect(line).toContain("the total with VAT");
  });

  it("a different currency is a difference even when the number matches", () => {
    const lines = quoteDifferences(acc({ currency: "USD" }), quote());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("The client signed");
    expect(lines[0]).toContain("but quote Q-ACM-001 totals R 1,150.00");
    expect(lines[0]).not.toContain("signed R 1,150.00");
  });

  it("a different client, in either kind", () => {
    expect(quoteDifferences(acc({ clientRef: "co-other" }), quote())).toEqual(["The document was signed for company:co-other, but quote Q-ACM-001 is for company:co-acme."]);
    expect(quoteDifferences(acc({ clientKind: "contact", clientRef: "co-acme" }), quote())).toEqual(["The document was signed for contact:co-acme, but quote Q-ACM-001 is for company:co-acme."]);
  });

  it("a document that names no client cannot be checked, so it does not pass", () => {
    const [line] = quoteDifferences(acc({ clientKind: null, clientRef: null }), quote());
    expect(line).toContain("names no client");
    expect(line).toContain("company:co-acme");
  });

  it("a document that states no amount cannot be checked either", () => {
    expect(quoteDifferences(acc({ amountMinor: null }), quote())[0]).toContain("states no amount");
  });

  it("a different deal, and a different quote number for the same id", () => {
    expect(quoteDifferences(acc({ dealId: "deal-2" }), quote())).toEqual(["The document belongs to deal deal-2, but quote Q-ACM-001 belongs to deal deal-1."]);
    expect(quoteDifferences(acc({ quoteNumber: "Q-ACM-009" }), quote())).toEqual(["The document names quote Q-ACM-009, but that quote id is quote Q-ACM-001."]);
  });

  it("a quote with no amount has nothing to invoice, whatever was signed", () => {
    expect(quoteDifferences(acc({ amountMinor: 115_000 }), quote({ total_minor: 0, subtotal_minor: 0 })).join(" ")).toContain("has no amount yet");
  });

  it("lists every difference, not only the first", () => {
    const lines = quoteDifferences(acc({ clientRef: "co-other", amountMinor: 1, dealId: "deal-2" }), quote());
    expect(lines).toHaveLength(3);
  });
});

describe("the two issues", () => {
  const invoice = { id: "inv-1", number: "ACM-001", currency: "ZAR", total_minor: 115_000, customer_kind: "company", customer_ref: "co-acme" } as unknown as InvoiceRow;
  const q = { id: "q-1", number: "Q-ACM-001" } as unknown as QuoteRow;

  it("the success issue says it is a draft, names the invoice and the document, and tells the agent to ask for the send, never to send", () => {
    const { title, description } = signedInvoiceIssue({ acc: acc({ title: "Quote Q-ACM-001" }), client: "Acme Holdings", clientRef: "company:co-acme", invoice, quote: q, prefix: "PIB" });
    expect(title).toBe('Signed: "Quote Q-ACM-001" for Acme Holdings: check invoice ACM-001 and ask for approval to send');
    expect(description).toContain("Ada Lovelace signed");
    expect(description).toContain("Billing drafted invoice ACM-001 (R 1,150.00) automatically. **It is a draft: nothing was sent.**");
    expect(description).toContain("invoiceId `inv-1`");
    expect(description).toContain(`Document \`${DOC}\``);
    expect(description).toContain("SHA-256 starting aaaaaaaaaaaaaaaa");
    expect(description).toContain("`request-invoice-send`");
    expect(description).toContain("Never email it yourself, and never draft a second invoice for this document.");
    expect(description).toContain("/PIB/billing?client=company:co-acme");
    expect(description).not.toMatch(/pibt_|signing link/i);
  });

  it("without a quote it says the invoice is one line and includes VAT", () => {
    const { description } = signedInvoiceIssue({ acc: acc({ source: "deal", quoteId: null, quoteNumber: null, dealId: "deal-7", title: "Proposal: Website" }), client: "Acme Holdings", clientRef: "company:co-acme", invoice, quote: null, prefix: "PIB" });
    expect(description).toContain("The document named no Billing quote, so the invoice has one line for the signed amount and is linked to deal `deal-7`.");
    expect(description).toContain("prices include VAT");
  });

  it("the mismatch issue lists every difference and says nothing was drafted and why", () => {
    const { title, description } = signedMismatchIssue({ acc: acc(), client: "Acme Holdings", clientRef: "company:co-acme", differences: ["The client signed R 1,000.00, but quote Q-ACM-001 totals R 1,150.00.", "The document belongs to deal deal-2, but quote Q-ACM-001 belongs to deal deal-1."], quote: q, prefix: "PIB" });
    expect(title).toBe("Signed: quote Q-ACM-001 for Acme Holdings: no invoice drafted, it does not match Billing");
    expect(description).toContain("Billing did **not** draft an invoice");
    expect(description).toContain("- The client signed R 1,000.00, but quote Q-ACM-001 totals R 1,150.00.");
    expect(description).toContain("- The document belongs to deal deal-2, but quote Q-ACM-001 belongs to deal deal-1.");
    expect(description).toContain("`quote-detail`, quoteId `q-1`");
    expect(description).toContain("never edit it");
    expect(description).toContain("`partnersinbiz.cockpit:ask-owner`");
  });

  it("titles stay inside the host's limit", () => {
    const long = "x".repeat(400);
    expect(signedInvoiceIssue({ acc: acc({ title: long }), client: "Acme", clientRef: "company:co-acme", invoice, quote: null, prefix: null }).title.length).toBeLessThanOrEqual(240);
    expect(signedMismatchIssue({ acc: acc({ title: long }), client: "Acme", clientRef: null, differences: ["x"], quote: null, prefix: null }).title.length).toBeLessThanOrEqual(240);
  });
});

describe("the migration and the skill", () => {
  it("013 passes the host's rules, deletes nothing, keeps no quotes in comments and stores no name", () => {
    const sql = readFileSync(new URL("../migrations/013_billing.sql", import.meta.url), "utf8");
    expect(() => validateMigration(sql, NAMESPACE, ["issues"])).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/\b(signer|client_name|name)\b\s+text/i);
  });

  it("the work Billing hands out for a signature has its own origin id, and the skill explains the issue and its done check", () => {
    expect(WORK_ORIGINS.signed).toBe("billing:signed:");
    expect(INVOICE_DRAFT_SKILL).toContain("| Signed: …");
    expect(INVOICE_DRAFT_SKILL).toContain("signed");
    expect(SKILLS[0]!.markdown!.length).toBeLessThanOrEqual(18_000);
  });
});
