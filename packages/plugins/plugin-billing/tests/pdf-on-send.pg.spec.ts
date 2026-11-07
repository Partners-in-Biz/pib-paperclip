/**
 * PAR-8201: every path that marks a document sent stores its PDF first (pdf_key is the record of what the client got),
 * and refuses when the PDF cannot be stored. Paths: manual mark-sent, send with email off / no address, re-send, quote send.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { startInvoiceSend } from "../src/invoices.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const R2 = { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" };

describe.skipIf(!available)("PDF stored on every send path (postgres)", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  beforeAll(async () => { h = await startHarness(); await plugin.definition.setup(h.ctx); }, 60_000);
  afterAll(async () => { globalThis.fetch = realFetch; await h?.stop(); });
  beforeEach(async () => {
    globalThis.fetch = realFetch;
    await h.reset();
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "ct-quiet", name: "Quiet Co" });
  });

  const { r2: _r2, ...noR2 } = SETTINGS;
  const settings = (extra: Record<string, unknown> = {}, r2 = true) => h.config.set(COMPANY, { ...noR2, reviewerUserId: "user-9", ...(r2 ? { r2: R2 } : {}), ...extra });
  const okR2 = () => { globalThis.fetch = vi.fn(async () => new Response()) as any; };
  const badR2 = () => { globalThis.fetch = vi.fn(async () => { throw new Error("r2 down"); }) as any; };
  const invoice = async (id: string) => (await h.client.query(`SELECT * FROM ${NAMESPACE}.invoices WHERE id = $1`, [id])).rows[0] as any;
  const quote = async (id: string) => (await h.client.query(`SELECT * FROM ${NAMESPACE}.quotes WHERE id = $1`, [id])).rows[0] as any;
  const mails = async () => (await h.client.query(`SELECT payload::text AS payload FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`)).rows as Array<{ payload: string }>;
  async function draft(customerRef = "ct-lumen") {
    const inv = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: inv.id, description: "work", quantity: 1, unitAmountMinor: 100_000 });
    return inv.id;
  }
  async function draftQuote(customerRef = "ct-lumen") {
    const q = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-quote-line", { quoteId: q.id, description: "audit", quantity: 1, unitAmountMinor: 20_000 });
    return q.id;
  }
  async function approve(issueId: string) {
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, entityType: "issue", actorType: "user", actorId: "user-9" });
  }

  describe("manual mark-sent", () => {
    it("stores the PDF, then marks sent", async () => {
      settings(); okR2();
      const id = await draft();
      await h.call("billing.mark-sent", { invoiceId: id });
      const row = await invoice(id);
      expect(row).toMatchObject({ status: "sent", delivery_status: "manual" });
      expect(row.pdf_key).toMatch(/\.pdf$/);
      expect(row.pdf_at).toBeTruthy();
    });

    it.each([["no R2", false], ["R2 failing", true]] as const)("refuses with %s and leaves the draft (number kept)", async (_label, r2) => {
      settings({}, r2); badR2();
      const id = await draft();
      await expect(h.call("billing.mark-sent", { invoiceId: id })).rejects.toThrow(/PDF not rendered or stored/);
      const row = await invoice(id);
      expect(row).toMatchObject({ status: "draft", sent_at: null, pdf_key: null });
      expect(row.number).toBeTruthy();
    });
  });

  describe("approved send without email", () => {
    it("email off: stores the PDF and marks sent, no mail", async () => {
      settings({ email: { enabled: false } }); okR2();
      const id = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      await approve(issueId);
      const row = await invoice(id);
      expect(row).toMatchObject({ status: "sent", delivery_status: "manual" });
      expect(row.pdf_key).toMatch(/\.pdf$/);
      expect(await mails()).toHaveLength(0);
    });

    it("email off without R2: stays a draft and the approval reopens", async () => {
      settings({ email: { enabled: false } }, false);
      const id = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      await approve(issueId);
      const row = await invoice(id);
      expect(row).toMatchObject({ status: "draft", sent_at: null, pdf_key: null, pending_action: "send", delivery_status: "failed" });
      expect(row.delivery_error).toContain("PDF not rendered or stored");
      expect(h.issues.get(issueId)!.status).toBe("todo");
    });

    // Recurring and subscription auto-send call startInvoiceSend directly; a client with no address gets no email.
    it("auto-send to a client with no address: stores the PDF and marks sent; without R2 it refuses", async () => {
      settings(); okR2();
      const id = await draft("ct-quiet");
      await startInvoiceSend(h.ctx, id, "recurring schedule");
      const row = await invoice(id);
      expect(row).toMatchObject({ status: "sent", delivery_status: "manual" });
      expect(row.pdf_key).toMatch(/\.pdf$/);
      expect(await mails()).toHaveLength(0);

      settings({}, false);
      const other = await draft("ct-quiet");
      await expect(startInvoiceSend(h.ctx, other, "subscription")).rejects.toThrow(/PDF not rendered or stored/);
      expect(await invoice(other)).toMatchObject({ status: "draft", sent_at: null, pdf_key: null });
    });
  });

  describe("re-send of a sent invoice", () => {
    it("emails with the PDF attached and refreshes pdf_key", async () => {
      settings(); okR2();
      const id = await draft();
      await h.call("billing.mark-sent", { invoiceId: id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET pdf_key = NULL WHERE id = $1`, [id]);
      const out = await h.call<{ attached: boolean }>("billing.retry-send", { kind: "invoice", id });
      expect(out.attached).toBe(true);
      expect((await invoice(id)).pdf_key).toMatch(/\.pdf$/);
      const sent = await mails();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toContain("application/pdf");
    });

    it("refuses to email without the PDF", async () => {
      settings(); okR2();
      const id = await draft();
      await h.call("billing.mark-sent", { invoiceId: id });
      const before = await invoice(id);
      settings({}, false);
      await expect(h.call("billing.retry-send", { kind: "invoice", id })).rejects.toThrow(/PDF not rendered or stored/);
      expect(await mails()).toHaveLength(0);
      expect(await invoice(id)).toMatchObject({ mail_seq: before.mail_seq, delivery_key: before.delivery_key });
    });
  });

  describe("quote send", () => {
    it("emails with the PDF attached and stores pdf_key", async () => {
      settings(); okR2();
      const id = await draftQuote();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: id });
      await approve(issueId);
      const row = await quote(id);
      expect(row.pdf_key).toMatch(/\.pdf$/);
      expect(row.delivery_status).toBe("queued");
      const sent = await mails();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toContain("application/pdf");
    });

    it("sends no email without the PDF", async () => {
      settings({}, false);
      const id = await draftQuote();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: id });
      await approve(issueId).catch(() => undefined);
      expect(await mails()).toHaveLength(0);
      const row = await quote(id);
      expect(row.pdf_key).toBeNull();
      expect(row.delivery_status).not.toBe("queued");
      expect(row.sent_at).toBeNull();
    });

    it("email off: stores the PDF before marking sent; without R2 it refuses", async () => {
      settings({ email: { enabled: false } }); okR2();
      const id = await draftQuote();
      await h.call("billing.retry-send", { kind: "quote", id });
      const row = await quote(id);
      expect(row).toMatchObject({ status: "sent" });
      expect(row.pdf_key).toMatch(/\.pdf$/);

      settings({ email: { enabled: false } }, false);
      const other = await draftQuote();
      await expect(h.call("billing.retry-send", { kind: "quote", id: other })).rejects.toThrow(/PDF not rendered or stored/);
      expect(await quote(other)).toMatchObject({ status: "draft", sent_at: null, pdf_key: null });
    });
  });
});
