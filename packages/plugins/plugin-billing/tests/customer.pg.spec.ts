/**
 * The Bill to block: the CRM company's billing details reach drafts, quote conversions and recurring copies,
 * are frozen into customer_snapshot at the send boundary, and never change a document that was sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { getInvoice } from "../src/db.js";
import { invoiceView, markInvoiceSent } from "../src/invoices.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const COMPANY_UPSERTED = "plugin.partnersinbiz.crm.company.upserted";

const DETAILS = {
  email: "accounts@acme.test",
  phone: "+27 21 555 0100",
  address: "1 Long Street\nCape Town\n8001",
  vatNumber: "4123456789",
  registrationNumber: "2019/123456/07",
};

describe.skipIf(!available)("billing customer details (postgres)", () => {
  let h: Harness;
  let tick = 0;

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
  });

  /** A company.upserted event as the CRM sends it, through the registered handler. */
  async function upsert(id: string, billing: Record<string, unknown> | null | undefined, name = "Acme Ltd") {
    tick += 1;
    const payload: Record<string, unknown> = { id, name, domain: null, lifecycle: null, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, tick)).toISOString() };
    if (billing !== undefined) payload.billing = billing;
    await h.deliver(COMPANY_UPSERTED, COMPANY, payload);
  }

  async function row(id: string) {
    return (await h.client.query(`SELECT status, customer, customer_snapshot, send_to FROM ${NAMESPACE}.invoices WHERE id = $1`, [id])).rows[0] as { status: string; customer: any; customer_snapshot: any; send_to: unknown };
  }

  async function view(id: string) {
    return invoiceView(h.ctx, (await getInvoice(h.ctx, id))!, SETTINGS as never);
  }

  async function draft(ref: string, kind: "company" | "contact" = "company", extra: Record<string, unknown> = {}) {
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: kind, customerRef: ref, ...extra });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 });
    return invoice;
  }

  async function outbox(event: string) {
    return (await h.client.query(`SELECT key, payload FROM ${NAMESPACE}.outbox WHERE event = $1 ORDER BY created_at, key`, [event])).rows as Array<{ key: string; payload: any }>;
  }

  describe("projection", () => {
    it("stores billing from company.upserted and clears it when a later event has none", async () => {
      await upsert("co-acme", DETAILS);
      let stored = (await h.client.query(`SELECT billing FROM ${NAMESPACE}.crm_companies WHERE id = 'co-acme'`)).rows[0] as any;
      expect(stored.billing).toEqual(DETAILS);
      await upsert("co-acme", undefined);
      stored = (await h.client.query(`SELECT billing FROM ${NAMESPACE}.crm_companies WHERE id = 'co-acme'`)).rows[0] as any;
      expect(stored.billing).toBeNull();
    });
  });

  describe("new documents", () => {
    it("prints all five fields in Bill to on a new invoice and quote", async () => {
      await upsert("co-acme", DETAILS);
      const invoice = await draft("co-acme");
      expect((await row(invoice.id)).customer).toMatchObject({ name: "Acme Ltd", ...DETAILS });
      const v = await view(invoice.id);
      expect(v.customer).toMatchObject({ name: "Acme Ltd", ...DETAILS });
      const html = await h.call<{ html: string }>("billing.invoice-html", { invoiceId: invoice.id });
      for (const text of ["accounts@acme.test", "+27 21 555 0100", "1 Long Street", "VAT no. 4123456789", "Reg. no. 2019/123456/07"]) expect(JSON.stringify(html)).toContain(text);

      const quote = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "co-acme" });
      const q = (await h.client.query(`SELECT customer FROM ${NAMESPACE}.quotes WHERE id = $1`, [quote.id])).rows[0] as any;
      expect(q.customer).toMatchObject({ name: "Acme Ltd", ...DETAILS });
    });

    it("leaves contact clients as they were (name and first email only)", async () => {
      await seedClient(h, { id: "ct-jo", name: "Jo Bloggs", email: "jo@bloggs.test" });
      const invoice = await draft("ct-jo", "contact");
      expect((await row(invoice.id)).customer).toEqual({ refKind: "contact", refId: "ct-jo", name: "Jo Bloggs", email: "jo@bloggs.test" });
      expect((await view(invoice.id)).customer).toEqual({ refKind: "contact", refId: "ct-jo", name: "Jo Bloggs", email: "jo@bloggs.test" });
    });

    it("keeps customerName and customerEmail overrides over the CRM", async () => {
      await upsert("co-acme", DETAILS);
      const invoice = await draft("co-acme", "company", { customerName: "Acme Trading", customerEmail: "peter@acme.test" });
      const customer = (await row(invoice.id)).customer;
      expect(customer).toMatchObject({ name: "Acme Trading", email: "peter@acme.test", phone: DETAILS.phone, vatNumber: DETAILS.vatNumber });
      expect(customer.emailFromCrm).toBeUndefined();
      await upsert("co-acme", { ...DETAILS, email: "other@acme.test", phone: "000" });
      const v = (await view(invoice.id)).customer;
      expect(v).toMatchObject({ name: "Acme Trading", email: "peter@acme.test", phone: "000" });
    });
  });

  describe("drafts", () => {
    it("shows details set after the draft was made, and a changed billing email follows the CRM", async () => {
      await upsert("co-acme", null);
      const invoice = await draft("co-acme");
      expect((await view(invoice.id)).customer.vatNumber).toBeUndefined();
      await upsert("co-acme", DETAILS);
      expect((await view(invoice.id)).customer).toMatchObject(DETAILS);
      await upsert("co-acme", { ...DETAILS, email: "new@acme.test" });
      expect((await view(invoice.id)).customer.email).toBe("new@acme.test");
    });

    it("freezes the merged block when the send starts, and the sent invoice is never touched again", async () => {
      await upsert("co-acme", null);
      const invoice = await draft("co-acme");
      await upsert("co-acme", DETAILS);
      await h.call("billing.retry-send", { kind: "invoice", id: invoice.id });
      const sent = await row(invoice.id);
      expect(sent.customer_snapshot).toMatchObject({ name: "Acme Ltd", ...DETAILS });
      const mails = await outbox("mail.send.requested");
      expect(mails).toHaveLength(1);
      expect(mails[0]!.payload.to).toEqual([{ email: "accounts@acme.test", name: "Acme Ltd" }]);
      await h.deliver("plugin.partnersinbiz.mailbox.mail.send.result", COMPANY, { key: mails[0]!.key, status: "sent", sentAt: "2026-10-02T08:00:00.000Z", context: mails[0]!.payload.context });
      expect((await row(invoice.id)).status).toBe("sent");

      await upsert("co-acme", { ...DETAILS, address: "9 Short Road", vatNumber: "9999999999", email: "else@acme.test" });
      expect((await row(invoice.id)).customer_snapshot).toEqual(sent.customer_snapshot);
      expect((await view(invoice.id)).customer).toEqual(sent.customer_snapshot);
      await h.call("billing.retry-send", { kind: "invoice", id: invoice.id });
      const again = await outbox("mail.send.requested");
      expect(again).toHaveLength(2);
      expect(again[1]!.payload.to).toEqual([{ email: "accounts@acme.test", name: "Acme Ltd" }]);
      expect((await row(invoice.id)).customer_snapshot).toEqual(sent.customer_snapshot);
    });

    it("freezes the merged block when a person marks the invoice sent", async () => {
      await upsert("co-acme", null);
      const invoice = await draft("co-acme");
      await upsert("co-acme", DETAILS);
      await h.call("billing.mark-sent", { invoiceId: invoice.id });
      expect((await row(invoice.id)).customer_snapshot).toMatchObject({ name: "Acme Ltd", ...DETAILS });
    });

    it("never writes an un-merged first snapshot when the mail result is the first to mark it sent", async () => {
      await upsert("co-acme", null);
      const invoice = await draft("co-acme");
      await upsert("co-acme", DETAILS);
      await markInvoiceSent(h.ctx, invoice.id, null, "sent", SETTINGS as never);
      expect((await row(invoice.id)).customer_snapshot).toMatchObject(DETAILS);
    });

    it("an explicit send_to still wins, on send and on re-send", async () => {
      await upsert("co-acme", DETAILS);
      const invoice = await draft("co-acme");
      await h.call("billing.update-invoice", { invoiceId: invoice.id, sendTo: "ap@acme.test" });
      await h.call("billing.retry-send", { kind: "invoice", id: invoice.id });
      const mails = await outbox("mail.send.requested");
      expect(mails[0]!.payload.to).toEqual([{ email: "ap@acme.test", name: null }]);
      expect((await row(invoice.id)).send_to).toEqual([{ email: "ap@acme.test", name: null }]);
      expect((await row(invoice.id)).customer_snapshot.email).toBe("accounts@acme.test");
      await h.deliver("plugin.partnersinbiz.mailbox.mail.send.result", COMPANY, { key: mails[0]!.key, status: "sent", sentAt: "2026-10-02T08:00:00.000Z", context: mails[0]!.payload.context });
      await h.call("billing.retry-send", { kind: "invoice", id: invoice.id });
      expect((await outbox("mail.send.requested"))[1]!.payload.to).toEqual([{ email: "ap@acme.test", name: null }]);
    });

    it("sends a quote with the details it was drafted without", async () => {
      await upsert("co-acme", null);
      const quote = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "co-acme" });
      await h.call("billing.add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 50_000 });
      await upsert("co-acme", DETAILS);
      await h.call("billing.retry-send", { kind: "quote", id: quote.id });
      const stored = (await h.client.query(`SELECT customer FROM ${NAMESPACE}.quotes WHERE id = $1`, [quote.id])).rows[0] as any;
      expect(stored.customer).toMatchObject(DETAILS);
      expect((await outbox("mail.send.requested"))[0]!.payload.to).toEqual([{ email: "accounts@acme.test", name: "Acme Ltd" }]);
    });
  });

  describe("copies", () => {
    it("convert-quote of a quote made before the details were set carries them", async () => {
      await upsert("co-acme", null);
      const quote = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "co-acme" });
      await h.call("billing.add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 50_000 });
      await upsert("co-acme", DETAILS);
      await h.call("billing.set-quote-status", { quoteId: quote.id, status: "accepted" });
      const converted = await h.call<{ invoice: { id: string } }>("billing.convert-quote", { quoteId: quote.id });
      expect((await row(converted.invoice.id)).customer).toMatchObject({ name: "Acme Ltd", ...DETAILS });
    });

    it("a recurring copy of a template sent before the details changed carries the current ones", async () => {
      await upsert("co-acme", DETAILS);
      const template = await draft("co-acme");
      await h.call("billing.mark-sent", { invoiceId: template.id });
      await upsert("co-acme", { ...DETAILS, address: "9 Short Road", email: "else@acme.test", phone: null });
      await h.call("billing.create-recurring", { templateInvoiceId: template.id, frequency: "monthly", nextRunAt: "2026-10-01T00:00:00Z" });
      await h.runJob("run-recurring");
      const copy = (await h.client.query(`SELECT customer, customer_snapshot FROM ${NAMESPACE}.invoices WHERE recurring_id IS NOT NULL`)).rows[0] as any;
      expect(copy.customer_snapshot).toBeNull();
      expect(copy.customer).toMatchObject({ address: "9 Short Road", email: "else@acme.test", vatNumber: DETAILS.vatNumber });
      expect(copy.customer.phone).toBeUndefined();
    });
  });
});
