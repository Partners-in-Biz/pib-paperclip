/**
 * POPIA erasure for Billing (audit Q10-13): what is dropped now, what the law makes it keep (as a minimal record
 * with the reason and the day the period ends), idempotence, and the receiver the CRM's approved request reaches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ContactEraseRequested } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { eraseFromBilling, finishErasureHolds, retentionYears } from "../src/privacy.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const EMAIL = "jane@example.com";

const request = (over: Partial<ContactEraseRequested> = {}): ContactEraseRequested => ({
  key: "erase:r1", requestId: "r1", subject: { email: EMAIL, clientKind: "contact", clientRef: "ct-jane" }, scope: "all", reason: "data_subject_request", approvedByUserId: "user-1", requestedAt: "2026-10-03T00:00:00Z", source: "partnersinbiz.crm", ...over,
});

describe("retention period", () => {
  it("is seven years unless settings say otherwise, never outside 5 to 15", () => {
    expect(retentionYears({})).toBe(7);
    expect(retentionYears({ privacy: { retentionYears: 5 } })).toBe(5);
    expect(retentionYears({ privacy: { retentionYears: 1 } })).toBe(5);
    expect(retentionYears({ privacy: { retentionYears: 40 } })).toBe(15);
    expect(retentionYears({ privacy: { retentionYears: Number.NaN } })).toBe(7);
  });
});

describe.skipIf(!available)("billing erasure (postgres)", () => {
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
    for (const key of [...h.state.keys()]) if (key.includes("pib-privacy")) h.state.delete(key);
    h.config.set(COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-jane", name: "Jane Doe", email: EMAIL });
    await seedClient(h, { id: "co-acme", name: "Acme", kind: "company" });
  });

  const q = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Array<Record<string, any>>;

  /** Jane's records: a draft, an issued and paid invoice with a credit note, a sent quote, proofs, notes, time and a subscription. */
  async function seedJane() {
    const draft = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-jane" });
    await h.call("billing.add-line", { invoiceId: draft.id, description: "Draft work", quantity: 1, unitAmountMinor: 1_000 });
    await q(`INSERT INTO ${NAMESPACE}.payment_links (id, company_id, invoice_id, provider, amount_minor, currency, url) VALUES ('lnk-draft', $1, $2, 'stripe', 1150, 'ZAR', 'https://buy.stripe.com/x')`, [COMPANY, draft.id]);

    const issued = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-jane" });
    await h.call("billing.add-line", { invoiceId: issued.id, description: "SEO for Jane", quantity: 1, unitAmountMinor: 100_000 });
    await h.call("billing.mark-sent", { invoiceId: issued.id });
    await h.call("billing.record-payment", { invoiceId: issued.id, amountMinor: 115_000, reference: "Jane D EFT" }, userContext());
    await h.call("billing.create-credit-note", { invoiceId: issued.id, amountMinor: 1_000, reason: "Goodwill" }, userContext());
    await q(`UPDATE ${NAMESPACE}.invoices SET customer = customer || '{"email":"jane@example.com","contactName":"Jane D","phone":"0821234567","address":"1 Main Road, Durban","vatNumber":"4123456789"}'::jsonb,
                                              customer_snapshot = COALESCE(customer_snapshot, customer) || '{"email":"jane@example.com","contactName":"Jane D","phone":"0821234567","address":"1 Main Road, Durban","vatNumber":"4123456789"}'::jsonb,
                                              send_to = '[{"email":"jane@example.com","name":"Jane"}]'::jsonb, sent_at = '2026-03-15T10:00:00Z', notes = 'Questions? jane@example.com' WHERE id = $1`, [issued.id]);
    await q(`INSERT INTO ${NAMESPACE}.payment_links (id, company_id, invoice_id, provider, amount_minor, currency, url, status) VALUES ('lnk-issued', $1, $2, 'stripe', 115000, 'ZAR', 'https://buy.stripe.com/y', 'paid')`, [COMPANY, issued.id]);

    const quote = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-jane" });
    await h.call("billing.add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 5_000 });
    await q(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', customer = customer || '{"email":"jane@example.com"}'::jsonb, send_to = '[{"email":"jane@example.com"}]'::jsonb WHERE id = $1`, [quote.id]);

    await q(`INSERT INTO ${NAMESPACE}.deliveries (key, company_id, doc_kind, doc_id, recipients, subject, status) VALUES ('d1', $1, 'invoice', $2, '[{"email":"jane@example.com","name":"Jane"}]'::jsonb, 'Invoice for Jane Doe', 'sent')`, [COMPANY, issued.id]);
    await q(`INSERT INTO ${NAMESPACE}.pops (id, company_id, invoice_id, source, status, from_email, from_name, subject, snippet, attachments, file_key) VALUES ('pop1', $1, $2, 'email', 'confirmed', 'jane@example.com', 'Jane Doe', 'Proof for INV', 'Paid from my FNB account', '[{"filename":"proof.pdf"}]'::jsonb, 'billing/pop1.pdf')`, [COMPANY, issued.id]);
    await q(`INSERT INTO ${NAMESPACE}.follow_ups (id, company_id, subject_kind, subject_id, note) VALUES ('f1', $1, 'invoice', $2, 'Jane promised to pay Friday, call 0821234567')`, [COMPANY, issued.id]);
    await q(`INSERT INTO ${NAMESPACE}.time_entries (id, company_id, owner, description, customer_kind, customer_ref, ended_at, minutes) VALUES ('t1', $1, 'agent:a', 'Unbilled call with Jane', 'contact', 'ct-jane', now(), 30), ('t2', $1, 'agent:b', 'Billed work', 'contact', 'ct-jane', now(), 60)`, [COMPANY]);
    await q(`UPDATE ${NAMESPACE}.time_entries SET invoice_id = $1 WHERE id = 't2'`, [issued.id]);
    await q(`INSERT INTO ${NAMESPACE}.subscriptions (id, company_id, customer_kind, customer_ref, customer_name, description, price_minor, currency, period, next_invoice_at) VALUES ('sub1', $1, 'contact', 'ct-jane', 'Jane Doe', 'Monthly retainer for Jane', 50000, 'ZAR', 'monthly', now() + interval '10 days')`, [COMPANY]);
    await q(`INSERT INTO ${NAMESPACE}.dunning_optouts (company_id, customer_kind, customer_ref, reason) VALUES ($1, 'contact', 'ct-jane', 'Jane asked us to stop, sick relative')`, [COMPANY]);

    // Jane's address on a company's invoice (she was the billing contact) and on its delivery.
    const acme = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: "co-acme", customerName: "Acme" });
    await h.call("billing.add-line", { invoiceId: acme.id, description: "Acme work", quantity: 1, unitAmountMinor: 10_000 });
    await h.call("billing.mark-sent", { invoiceId: acme.id });
    await q(`UPDATE ${NAMESPACE}.invoices SET send_to = '[{"email":"jane@example.com","name":"Jane"},{"email":"ap@acme.test","name":"AP"}]'::jsonb, customer = customer || '{"email":"jane@example.com","contactName":"Jane"}'::jsonb WHERE id = $1`, [acme.id]);
    await q(`INSERT INTO ${NAMESPACE}.deliveries (key, company_id, doc_kind, doc_id, recipients, subject, status) VALUES ('d2', $1, 'invoice', $2, '[{"email":"jane@example.com"},{"email":"ap@acme.test"}]'::jsonb, 'Invoice for Acme', 'sent')`, [COMPANY, acme.id]);
    return { draft: draft.id, issued: issued.id, quote: quote.id, acme: acme.id };
  }

  it("drops what the law does not make it keep and cuts the rest to a minimal record", async () => {
    const ids = await seedJane();
    const outcome = await eraseFromBilling(h.ctx, request(), COMPANY);

    // Never-issued drafts are not records: gone with their lines and link.
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.invoices WHERE id = $1`, [ids.draft])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [ids.draft])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.payment_links WHERE id = 'lnk-draft'`)).toHaveLength(0);

    // The issued invoice stays as a tax record: name, address and VAT number; no email, phone or contact name.
    const issued = (await q(`SELECT customer, customer_snapshot, send_to, notes, status FROM ${NAMESPACE}.invoices WHERE id = $1`, [ids.issued]))[0]!;
    expect(issued.status).toBe("paid");
    expect(issued.customer).toMatchObject({ name: "Jane Doe", address: "1 Main Road, Durban", vatNumber: "4123456789" });
    expect(issued.customer).not.toHaveProperty("email");
    expect(issued.customer).not.toHaveProperty("phone");
    expect(issued.customer).not.toHaveProperty("contactName");
    expect(Object.keys(issued.customer_snapshot).sort()).toEqual(["address", "name", "refId", "refKind", "vatNumber"].filter((k) => k in issued.customer_snapshot).sort());
    expect(issued.customer_snapshot).not.toHaveProperty("email");
    expect(issued.send_to).toEqual([]);
    expect((await q(`SELECT amount_minor FROM ${NAMESPACE}.payments WHERE invoice_id = $1`, [ids.issued])).map((p) => p.amount_minor)).toEqual(["115000"]);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.credit_notes WHERE invoice_id = $1`, [ids.issued])).toHaveLength(1);
    expect((await q(`SELECT url FROM ${NAMESPACE}.payment_links WHERE id = 'lnk-issued'`))[0]).toEqual({ url: null });

    // Quotes lose the customer details, emails and delivery records lose recipients and subject, proofs lose their text.
    expect((await q(`SELECT customer, send_to FROM ${NAMESPACE}.quotes WHERE id = $1`, [ids.quote]))[0]).toEqual({ customer: { name: "[erased]" }, send_to: [] });
    expect((await q(`SELECT recipients, subject FROM ${NAMESPACE}.deliveries WHERE key = 'd1'`))[0]).toEqual({ recipients: [], subject: "[erased]" });
    expect((await q(`SELECT from_email, from_name, subject, snippet, attachments, file_key FROM ${NAMESPACE}.pops WHERE id = 'pop1'`))[0]).toEqual({ from_email: null, from_name: null, subject: null, snippet: null, attachments: [], file_key: "billing/pop1.pdf" });
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.follow_ups WHERE id = 'f1'`)).toHaveLength(0);
    expect((await q(`SELECT id FROM ${NAMESPACE}.time_entries ORDER BY id`)).map((r) => r.id)).toEqual(["t2"]);
    expect((await q(`SELECT customer_name, description, status FROM ${NAMESPACE}.subscriptions`))[0]).toEqual({ customer_name: "[erased]", description: "[erased]", status: "cancelled" });
    expect((await q(`SELECT reason FROM ${NAMESPACE}.dunning_optouts`))[0]).toEqual({ reason: null });
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.crm_contacts WHERE id = 'ct-jane'`)).toHaveLength(0);

    // Her address on a company's invoice and its delivery record goes; the company's own recipient stays.
    const acme = (await q(`SELECT send_to, customer FROM ${NAMESPACE}.invoices WHERE id = $1`, [ids.acme]))[0]!;
    expect(acme.send_to).toEqual([{ email: "ap@acme.test", name: "AP" }]);
    expect(acme.customer).not.toHaveProperty("email");
    expect(acme.customer).not.toHaveProperty("contactName");
    expect(acme.customer.name).toBe("Acme");
    expect((await q(`SELECT recipients FROM ${NAMESPACE}.deliveries WHERE key = 'd2'`))[0]!.recipients).toEqual([{ email: "ap@acme.test" }]);

    expect(outcome.counts).toMatchObject({ draft_invoices: 1, invoice_contact_details: 1, quotes: 1, email_records: expect.any(Number), follow_up_notes: 1, proof_of_payment_text: expect.any(Number), unbilled_time: 1, subscriptions: 1, crm_contacts: 1, other_documents: expect.any(Number) });
    // What it keeps, with the law and the day the period ends (seven years from the invoice).
    expect(outcome.retained!.map((r) => r.what)).toEqual([
      "1 issued invoice, 1 credit note and 1 payment (name and address only; email, phone and contact name removed)",
      "1 proof-of-payment file and the invoice PDFs in private storage",
      "1 online payment notification in the Paperclip host's webhook delivery log (the payer's name, email and billing address as the provider sent them)",
    ]);
    // The gap Billing cannot close is said plainly, with who can close it.
    expect(outcome.retained![2]!.why).toMatch(/host stores every webhook delivery.*neither read nor delete.*host operator/);
    expect(outcome.retained![0]!.why).toContain("Tax Administration Act s29");
    expect(outcome.retained![0]!.why).toContain("Name and address are removed on 2033-03-15.");
    expect((await q(`SELECT retain_until::text AS d, released_at FROM ${NAMESPACE}.privacy_holds`))[0]).toEqual({ d: "2033-03-15", released_at: null });

    // Proof it happened, without the person: a hash, never the address.
    const proof = (await q(`SELECT subject_hash, status, approved_by, counts, retained FROM ${NAMESPACE}.erasures WHERE request_id = 'r1'`))[0]!;
    expect(proof.subject_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(proof)).not.toContain("jane@example.com");
    expect(proof).toMatchObject({ status: "erased", approved_by: "user-1" });
  });

  it("names the host's webhook log only for a person who paid online (an EFT customer has no payload there)", async () => {
    await seedClient(h, { id: "ct-eft", name: "Eft Person", email: "eft@example.com" });
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-eft" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Work", quantity: 1, unitAmountMinor: 10_000 });
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    // A test-provider link is not a real payment notification either.
    await q(`INSERT INTO ${NAMESPACE}.payment_links (id, company_id, invoice_id, provider, amount_minor, currency, url, status) VALUES ('lnk-mock', $1, $2, 'mock', 11500, 'ZAR', 'https://pay.invalid/mock/x', 'paid')`, [COMPANY, invoice.id]);
    const outcome = await eraseFromBilling(h.ctx, request({ requestId: "r-eft", subject: { email: "eft@example.com", clientKind: "contact", clientRef: "ct-eft" } }), COMPANY);
    expect(outcome.retained!.map((r) => r.what).filter((what) => /webhook delivery log/.test(what))).toEqual([]);
    expect(outcome.retained!.some((r) => /issued invoice/.test(r.what))).toBe(true);
  });

  it("is idempotent: a second run drops nothing more and answers the same retained list", async () => {
    await seedJane();
    const first = await eraseFromBilling(h.ctx, request(), COMPANY);
    const second = await eraseFromBilling(h.ctx, request(), COMPANY);
    expect(Object.values(second.counts).reduce((a, b) => a + b, 0)).toBe(0);
    expect(second.retained).toEqual(first.retained);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.erasures`)).toHaveLength(1);
    expect((await q(`SELECT status FROM ${NAMESPACE}.erasures`))[0]).toEqual({ status: "retained" });
  });

  it("when the retention period ends, the name and address go too and the hold is released", async () => {
    const ids = await seedJane();
    await eraseFromBilling(h.ctx, request(), COMPANY);
    expect(await finishErasureHolds(h.ctx, COMPANY, "2033-03-14")).toBe(0);
    expect((await q(`SELECT customer FROM ${NAMESPACE}.invoices WHERE id = $1`, [ids.issued]))[0]!.customer.name).toBe("Jane Doe");
    expect(await finishErasureHolds(h.ctx, COMPANY, "2033-03-15")).toBe(1);
    const row = (await q(`SELECT customer, customer_snapshot FROM ${NAMESPACE}.invoices WHERE id = $1`, [ids.issued]))[0]!;
    expect(row.customer).toEqual({ name: "[erased]" });
    expect(row.customer_snapshot).toEqual({ name: "[erased]" });
    expect((await q(`SELECT released_at FROM ${NAMESPACE}.privacy_holds`))[0]!.released_at).toBeTruthy();
    expect(await finishErasureHolds(h.ctx, COMPANY, "2040-01-01")).toBe(0);
    await h.runJob("privacy-retention");
  });

  it("finds the person by email when the request names no contact id, and leaves strangers alone", async () => {
    await seedJane();
    await seedClient(h, { id: "ct-other", name: "Other Person", email: "other@example.com" });
    const outcome = await eraseFromBilling(h.ctx, request({ subject: { email: EMAIL } }), COMPANY);
    expect(outcome.counts.draft_invoices).toBe(1);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.crm_contacts WHERE id = 'ct-other'`)).toHaveLength(1);
    const nothing = await eraseFromBilling(h.ctx, request({ requestId: "r2", subject: { email: "nobody@example.com" } }), COMPANY);
    expect(nothing).toEqual({ counts: {}, retained: [] });
    expect((await q(`SELECT status FROM ${NAMESPACE}.erasures WHERE request_id = 'r2'`))[0]).toEqual({ status: "nothing_found" });
  });

  it("holds no marketing data, so a marketing-only request touches nothing", async () => {
    await seedJane();
    expect(await eraseFromBilling(h.ctx, request({ scope: "marketing_only" }), COMPANY)).toEqual({ counts: {}, retained: [] });
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.crm_contacts WHERE id = 'ct-jane'`)).toHaveLength(1);
  });

  it("answers the CRM's request once approved, and refuses one a person did not approve", async () => {
    await seedJane();
    h.emitted.length = 0;
    await h.deliver("plugin.partnersinbiz.crm.contact.erase.requested", COMPANY, { ...request(), approvedByUserId: "" });
    const refused = h.emitted.find((e) => e.name === "contact.erase.completed")!.payload as { status: string; error: string; plugin: string };
    expect(refused).toMatchObject({ plugin: "partnersinbiz.billing", status: "failed" });
    expect(refused.error).toMatch(/Not approved by a person/);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.crm_contacts WHERE id = 'ct-jane'`)).toHaveLength(1);

    h.emitted.length = 0;
    await h.deliver("plugin.partnersinbiz.crm.contact.erase.requested", COMPANY, request());
    const answer = h.emitted.find((e) => e.name === "contact.erase.completed")!.payload as { status: string; counts: Record<string, number>; retained: Array<{ what: string }> };
    expect(answer.status).toBe("erased");
    expect(answer.retained.length).toBeGreaterThan(0);
    expect(await q(`SELECT 1 FROM ${NAMESPACE}.crm_contacts WHERE id = 'ct-jane'`)).toHaveLength(0);
    // A re-announcement is answered from memory, not run again.
    h.emitted.length = 0;
    await h.deliver("plugin.partnersinbiz.crm.contact.erase.requested", COMPANY, request());
    expect((h.emitted.find((e) => e.name === "contact.erase.completed")!.payload as { status: string }).status).toBe("erased");
  });
});
