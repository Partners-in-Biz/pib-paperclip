/**
 * End-to-end flows against a real Postgres with the host's SQL rules:
 * numbering, per-line VAT, settle(), POP, bank matches, ledger payloads,
 * Mailbox results, recurring, retainers, time and expenses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isBalanced, type LedgerPostRequested } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { agentContext, COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const MAILBOX_RESULT = "plugin.partnersinbiz.mailbox.mail.send.result";
const MAIL_RECEIVED = "plugin.partnersinbiz.mailbox.mail.received";
const LEDGER_RESULT = "plugin.partnersinbiz.accounting.ledger.post.result";
const BANK_MATCHED = "plugin.partnersinbiz.accounting.bank.matched";

describe.skipIf(!available)("billing flows (postgres)", () => {
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
    h.config.set(COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "ct-lumos", name: "Lumos Labs", email: "pay@lumos.test" });
  });

  async function outbox(event?: string) {
    const rows = (await h.client.query(`SELECT key, event, payload, status FROM ${NAMESPACE}.outbox ORDER BY created_at, key`)).rows as Array<{ key: string; event: string; payload: Record<string, unknown>; status: string }>;
    return event ? rows.filter((r) => r.event === event) : rows;
  }

  async function journals(): Promise<LedgerPostRequested[]> {
    return (await outbox("ledger.post.requested")).map((r) => r.payload as unknown as LedgerPostRequested);
  }

  async function draft(customerRef = "ct-lumen", lines: Array<{ description: string; quantity: number; unitAmountMinor: number; taxCode?: string }> = [{ description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 }]) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    for (const line of lines) await h.call("billing.add-line", { invoiceId: invoice.id, ...line });
    return invoice;
  }

  async function sentInvoice(customerRef = "ct-lumen", lines?: Parameters<typeof draft>[1]) {
    const invoice = await draft(customerRef, lines);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  async function detail(invoiceId: string) {
    return h.call<{ invoice: { status: string; outstandingMinor: number; paidMinor: number; creditedMinor: number; totalMinor: number; vatMinor: number; subtotalMinor: number; deliveryStatus: string | null }; payments: Array<{ amountMinor: number; allocatedMinor: number; creditMinor: number; bankTxId: string | null }>; lines: Array<{ netMinor: number; vatMinor: number; grossMinor: number }>; groups: Array<{ taxCode: string | null; vatMinor: number; netMinor: number }> }>("billing.invoice-detail", { invoiceId });
  }

  describe("numbering", () => {
    it("numbers per client prefix, deduplicates prefixes and keeps kinds apart", async () => {
      const a = await draft("ct-lumen", []);
      const b = await draft("ct-lumen", []);
      const c = await draft("ct-lumos", []);
      expect(a.number).toBe("LUM-001");
      expect(b.number).toBe("LUM-002");
      expect(c.number).toBe("LUO-001");
      const quote = await h.call<{ number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
      expect(quote.number).toBe("Q-LUM-001");
    });

    it("never issues a number twice under concurrent drafting", async () => {
      const numbers = await Promise.all(Array.from({ length: 8 }, () => draft("ct-lumen", []).then((i) => i.number)));
      expect(new Set(numbers).size).toBe(8);
      expect(numbers.sort()).toEqual(["LUM-001", "LUM-002", "LUM-003", "LUM-004", "LUM-005", "LUM-006", "LUM-007", "LUM-008"]);
    });

    it("keeps existing numbers and continues a series", async () => {
      await h.client.query(
        `INSERT INTO ${NAMESPACE}.invoices (id, company_id, number, status, currency, customer_kind, customer_ref) VALUES ('old-1', $1, 'LUM-007', 'paid', 'ZAR', 'contact', 'ct-lumen'), ('old-2', $1, 'INV-0003', 'paid', 'ZAR', 'contact', 'ct-lumen')`,
        [COMPANY],
      );
      expect((await draft("ct-lumen", [])).number).toBe("LUM-008");
      h.config.set(COMPANY, { ...SETTINGS, numbering: { mode: "sequential" } });
      expect((await draft("ct-lumen", [])).number).toBe("INV-0004");
      const old = await h.client.query(`SELECT number FROM ${NAMESPACE}.invoices WHERE id IN ('old-1', 'old-2') ORDER BY id`);
      expect(old.rows.map((r: any) => r.number)).toEqual(["LUM-007", "INV-0003"]);
    });
  });

  describe("per-line VAT", () => {
    it("totals VAT per line and per code, exclusive and inclusive", async () => {
      const invoice = await draft("ct-lumen", [
        { description: "Design", quantity: 2, unitAmountMinor: 10_001 },
        { description: "Export work", quantity: 1, unitAmountMinor: 50_000, taxCode: "za_zero" },
      ]);
      const d = await detail(invoice.id);
      expect(d.lines.map((l) => l.vatMinor)).toEqual([3_000, 0]);
      expect(d.invoice.subtotalMinor).toBe(70_002);
      expect(d.invoice.vatMinor).toBe(3_000);
      expect(d.invoice.totalMinor).toBe(73_002);
      expect(d.groups.map((g) => g.taxCode).sort()).toEqual(["za_std_15", "za_zero"]);

      await h.call("billing.update-invoice", { invoiceId: invoice.id, pricesIncludeVat: true });
      const inclusive = await detail(invoice.id);
      // 20,002 incl. 15% → VAT 2,609; zero-rated 50,000 unchanged.
      expect(inclusive.lines[0]).toMatchObject({ grossMinor: 20_002, vatMinor: 2_609, netMinor: 17_393 });
      expect(inclusive.invoice.totalMinor).toBe(70_002);
    });

    it("keeps the legacy whole-invoice VAT rate for set-invoice-tax", async () => {
      const invoice = await draft("ct-lumen", [{ description: "A", quantity: 1, unitAmountMinor: 1_000_000 }, { description: "B", quantity: 2, unitAmountMinor: 250_050 }]);
      const result = await h.call<{ totalMinor: number }>("billing.set-invoice-tax", { invoiceId: invoice.id, taxRate: 15 });
      expect(result.totalMinor).toBe(1_725_115);
    });
  });

  describe("settle()", () => {
    it("handles partial, top-up, overpayment, idempotency and credit notes", async () => {
      const invoice = await sentInvoice(); // 115,000 incl. VAT
      const part = await h.call<{ invoiceStatus: string; outstandingMinor: number }>("billing.record-payment", { invoiceId: invoice.id, amountMinor: 40_000, paymentKey: "p1" });
      expect(part).toMatchObject({ invoiceStatus: "partially_paid", outstandingMinor: 75_000 });
      const again = await h.call<{ repeat: boolean; outstandingMinor: number }>("billing.record-payment", { invoiceId: invoice.id, amountMinor: 40_000, paymentKey: "p1" });
      expect(again).toMatchObject({ repeat: true, outstandingMinor: 75_000 });
      const top = await h.call<{ invoiceStatus: string; allocatedMinor: number; creditMinor: number }>("billing.record-payment", { invoiceId: invoice.id, amountMinor: 80_000, paymentKey: "p2" });
      expect(top).toMatchObject({ invoiceStatus: "paid", allocatedMinor: 75_000, creditMinor: 5_000 });
      const d = await detail(invoice.id);
      expect(d.payments).toHaveLength(2);
      expect(d.invoice.outstandingMinor).toBe(0);

      // The 5,000 overpayment is customer credit; use it on the next invoice.
      const next = await sentInvoice("ct-lumen", [{ description: "Month 2", quantity: 1, unitAmountMinor: 10_000 }]); // 11,500
      const credit = await h.call<Array<{ sourceKind: string; sourceId: string; availableMinor: number }>>("billing.customer-credit", { client: "contact:ct-lumen" });
      expect(credit).toEqual([expect.objectContaining({ sourceKind: "payment", availableMinor: 5_000 })]);
      const applied = await h.call<{ appliedMinor: number; status: string }>("billing.apply-credit", { invoiceId: next.id, sourceKind: "payment", sourceId: credit[0]!.sourceId });
      expect(applied).toMatchObject({ appliedMinor: 5_000, status: "partially_paid" });

      // A credit note covers the rest; the remainder stays as credit.
      const note = await h.call<{ number: string; appliedMinor: number; creditMinor: number; invoiceStatus: string }>("billing.create-credit-note", { invoiceId: next.id, amountMinor: 10_000, reason: "Goodwill" });
      expect(note).toMatchObject({ number: "CN-LUM-001", appliedMinor: 6_500, creditMinor: 3_500, invoiceStatus: "paid" });
      const left = await h.call<Array<{ sourceKind: string; availableMinor: number }>>("billing.customer-credit", { client: "contact:ct-lumen" });
      expect(left).toEqual([expect.objectContaining({ sourceKind: "credit_note", availableMinor: 3_500 })]);
    });

    it("refuses money on drafts and never lets agents confirm payments", async () => {
      const invoice = await draft();
      await expect(h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 100 })).rejects.toThrow(/Send the invoice/);
      await expect(h.call("billing.confirm-pop", { popId: "x" }, agentContext())).rejects.toThrow(/Agents may not/);
      await expect(h.call("billing.request-send", { invoiceId: invoice.id }, agentContext())).rejects.toThrow(/may not send/);
    });

    it("pays in full when a payment approval issue is done", async () => {
      const invoice = await sentInvoice();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-pay", { invoiceId: invoice.id });
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      const d = await detail(invoice.id);
      expect(d.invoice.status).toBe("paid");
      expect(d.payments).toHaveLength(1);
    });
  });

  describe("sending through the Mailbox", () => {
    it("queues the email after approval, marks sent on the result, posts the journal", async () => {
      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;
      try {
        h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" } });
        const invoice = await draft();
        const { issueId } = await h.call<{ issueId: string; recipients: Array<{ email: string }> }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
        const mails = await outbox("mail.send.requested");
        expect(mails).toHaveLength(1);
        const mail = mails[0]!.payload as any;
        expect(mail.key).toBe(`billing:mail:invoice:${invoice.id}:1`);
        expect(mail.to).toEqual([{ email: "ap@lumen.test", name: "Lumen Digital" }]);
        expect(mail.context).toEqual({ plugin: "partnersinbiz.billing", kind: "invoice", id: invoice.id, clientKind: "contact", clientRef: "ct-lumen" });
        expect(mail.labels).toEqual(["PiB/Invoices"]);
        expect(mail.html).toContain("reply to this email with your proof of payment");
        expect(mail.html).toContain("62000000000");
        expect(mail.attachments[0].url).toContain("private-docs/billing/");
        expect(mail.attachments[0].url).toContain("X-Amz-Expires=604800");
        expect(put).toHaveBeenCalledTimes(1);
        expect((await detail(invoice.id)).invoice).toMatchObject({ status: "draft", deliveryStatus: "queued" });
        await expect(h.call("billing.add-line", { invoiceId: invoice.id, description: "x", quantity: 1, unitAmountMinor: 1 })).rejects.toThrow(/being sent/);

        await h.deliver(MAILBOX_RESULT, COMPANY, { key: mail.key, status: "sent", messageId: "gm-1", threadId: "th-1", sentAt: "2026-09-26T08:00:00.000Z", context: mail.context });
        const d = await detail(invoice.id);
        expect(d.invoice).toMatchObject({ status: "sent", deliveryStatus: "sent" });
        const issue = (await journals()).find((j) => j.key === `billing:invoice:${invoice.id}:issue`)!;
        expect(issue.lines).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "ar", debitMinor: 115_000 }),
          expect.objectContaining({ role: "revenue", creditMinor: 100_000, taxCode: "za_std_15", taxBaseMinor: 100_000 }),
          expect.objectContaining({ role: "vat_output", creditMinor: 15_000, taxCode: "za_std_15", taxBaseMinor: 100_000 }),
        ]));
        expect((await outbox("mail.send.requested"))[0]!.status).toBe("done");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("shows a permanent failure and retries under a new key", async () => {
      const invoice = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      const key = `billing:mail:invoice:${invoice.id}:1`;
      const context = { plugin: "partnersinbiz.billing", kind: "invoice", id: invoice.id };
      await h.deliver(MAILBOX_RESULT, COMPANY, { key, status: "failed", error: "Rate limited", permanent: false, context });
      expect((await detail(invoice.id)).invoice.deliveryStatus).toBe("queued");
      await h.deliver(MAILBOX_RESULT, COMPANY, { key, status: "failed", error: "Mailbox not connected", permanent: true, context });
      expect((await detail(invoice.id)).invoice).toMatchObject({ status: "draft", deliveryStatus: "failed" });
      await h.call("billing.retry-send", { kind: "invoice", id: invoice.id });
      const keys = (await outbox("mail.send.requested")).map((r) => r.key);
      expect(keys).toEqual([key, `billing:mail:invoice:${invoice.id}:2`]);
    });
  });

  describe("proof of payment", () => {
    it("matches an emailed POP by invoice number, waits for a person, then settles", async () => {
      const invoice = await sentInvoice();
      const mail = {
        key: "mbx:1",
        accountAddress: "peet@pib.test",
        messageId: "gm-pop-1",
        threadId: "th-9",
        from: { email: "ap@lumen.test", name: "Lumen AP" },
        to: [{ email: "peet@pib.test" }],
        subject: `Payment for ${invoice.number}`,
        snippet: "Please find attached our proof of payment",
        receivedAt: "2026-09-26T09:00:00.000Z",
        attachments: [{ attachmentId: "a1", filename: "pop.pdf", mime: "application/pdf", bytes: 1000 }],
        triage: { category: "proof_of_payment", urgency: 0.2, needsReply: 0.1, phishing: 0, confidence: 0.9 },
      };
      await h.deliver(MAIL_RECEIVED, COMPANY, mail);
      await h.deliver(MAIL_RECEIVED, COMPANY, mail);
      const pops = await h.call<Array<{ id: string; invoiceId: string; matchBasis: string; issueId: string }>>("billing.pops", {});
      expect(pops).toHaveLength(1);
      expect(pops[0]).toMatchObject({ invoiceId: invoice.id, matchBasis: "number" });
      expect((await detail(invoice.id)).invoice.status).toBe("payment_pending_verification");
      expect((await detail(invoice.id)).payments).toHaveLength(0);
      const issue = h.issues.get(pops[0]!.issueId)!;
      expect(issue.title).toBe(`Check proof of payment for ${invoice.number}`);
      issue.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issue.id });
      const d = await detail(invoice.id);
      expect(d.invoice.status).toBe("paid");
      expect(d.payments).toHaveLength(1);
    });

    it("rejects a POP when its issue is cancelled", async () => {
      const invoice = await sentInvoice();
      await h.deliver(MAIL_RECEIVED, COMPANY, {
        key: "mbx:2", accountAddress: "peet@pib.test", messageId: "gm-pop-2", threadId: "t", from: { email: "someone@else.test" }, to: [],
        subject: `Paid ${invoice.number.replace("-", " ")}`, snippet: "", receivedAt: new Date().toISOString(), attachments: [], triage: { category: null, urgency: null, needsReply: null, phishing: null, confidence: null },
      });
      const [pop] = await h.call<Array<{ id: string; issueId: string }>>("billing.pops", {});
      h.issues.get(pop!.issueId)!.status = "cancelled";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: pop!.issueId });
      expect((await h.call<Array<{ status: string }>>("billing.pops", {}))[0]!.status).toBe("rejected");
      expect((await detail(invoice.id)).invoice.status).toBe("sent");
    });

    it("ignores newsletters and drafts a bill from a known supplier's invoice", async () => {
      await seedClient(h, { id: "co-aws", name: "Amazon Web Services", kind: "company" });
      await h.client.query(`UPDATE ${NAMESPACE}.crm_companies SET domain = 'aws.test' WHERE id = 'co-aws'`);
      const base = { accountAddress: "peet@pib.test", threadId: "t", to: [], snippet: "", receivedAt: "2026-09-20T10:00:00.000Z", attachments: [] };
      await h.deliver(MAIL_RECEIVED, COMPANY, { ...base, key: "n1", messageId: "m1", from: { email: "news@x.test" }, subject: "Weekly news", triage: { category: "newsletter", urgency: 0, needsReply: 0, phishing: 0, confidence: 0.9 } });
      await h.deliver(MAIL_RECEIVED, COMPANY, { ...base, key: "b1", messageId: "m2", from: { email: "billing@aws.test" }, subject: "Invoice No. 12345 for September", triage: { category: "invoice_or_bill", urgency: 0, needsReply: 0, phishing: 0, confidence: 0.9 } });
      expect(await h.call<unknown[]>("billing.pops", {})).toHaveLength(0);
      const bills = await h.call<Array<{ supplierName: string; supplierReference: string; status: string; source: string }>>("billing.list-bills", {});
      expect(bills).toEqual([expect.objectContaining({ supplierName: "Amazon Web Services", supplierReference: "12345", status: "draft", source: "email" })]);
    });
  });

  describe("bank matches from Accounting", () => {
    const match = (over: Record<string, unknown>) => ({
      key: "bank:tx-1:invoice", bankTxId: "tx-1", bankAccountRole: "bank", bankAccountCode: "1000", kind: "receivable",
      currency: "ZAR", date: "2026-09-26", reference: "LUM-001", basis: "exact", matchedBy: {}, ...over,
    });

    it("settles an exact match once and answers every delivery", async () => {
      const invoice = await sentInvoice();
      const event = match({ key: `bank:tx-1:invoice:${invoice.id}`, openItemKey: `invoice:${invoice.id}`, amountMinor: 115_000 });
      await h.deliver(BANK_MATCHED, COMPANY, event);
      await h.deliver(BANK_MATCHED, COMPANY, event);
      const results = h.emitted.filter((e) => e.name === "bank.match.result").map((e) => e.payload as { status: string; paymentId: string });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]!.status).toBe("settled");
      const d = await detail(invoice.id);
      expect(d.invoice.status).toBe("paid");
      expect(d.payments).toEqual([expect.objectContaining({ amountMinor: 115_000, bankTxId: "tx-1" })]);
      const payment = (await journals()).find((j) => j.source.kind === "payment")!;
      expect(payment.lines[0]).toMatchObject({ role: "bank", accountCode: "1000", dimensions: expect.objectContaining({ bankTxId: "tx-1" }) });
    });

    it("asks a person for amount-only matches and overpayments", async () => {
      const invoice = await sentInvoice();
      await h.deliver(BANK_MATCHED, COMPANY, match({ key: "k-amount", openItemKey: `invoice:${invoice.id}`, amountMinor: 115_000, basis: "amount" }));
      await h.deliver(BANK_MATCHED, COMPANY, match({ key: "k-over", bankTxId: "tx-2", openItemKey: `invoice:${invoice.id}`, amountMinor: 200_000 }));
      const results = h.emitted.filter((e) => e.name === "bank.match.result").map((e) => e.payload as { key: string; status: string });
      expect(results.map((r) => r.status)).toEqual(["needs_review", "needs_review"]);
      expect((await detail(invoice.id)).payments).toHaveLength(0);
      const review = [...h.issues.values()].find((i) => i.description?.includes("bank line tx-1 "))!;
      review.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: review.id });
      expect((await detail(invoice.id)).invoice.status).toBe("paid");
      expect(h.emitted.filter((e) => e.name === "bank.match.result").at(-1)!.payload).toMatchObject({ key: "k-amount", status: "settled" });
    });

    it("reconciles a POP payment instead of counting the money twice", async () => {
      const invoice = await sentInvoice();
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "manual-1" });
      await h.deliver(BANK_MATCHED, COMPANY, match({ key: "k-rec", openItemKey: `invoice:${invoice.id}`, amountMinor: 115_000 }));
      const d = await detail(invoice.id);
      expect(d.payments).toHaveLength(1);
      expect(d.payments[0]!.bankTxId).toBe("tx-1");
      expect(h.emitted.filter((e) => e.name === "bank.match.result").at(-1)!.payload).toMatchObject({ status: "settled" });
      // The earlier journal is reversed and posted again on the matched bank account.
      const keys = (await journals()).filter((j) => j.source.kind === "payment").map((j) => j.key.replace(/[0-9a-f-]{36}/, "<id>"));
      expect(keys).toEqual(["billing:payment:<id>", "billing:payment:<id>:reverse", "billing:payment:<id>:bank:tx-1"]);
      const repost = (await journals()).find((j) => j.key.endsWith(":bank:tx-1"))!;
      expect(repost.lines[0]).toMatchObject({ accountCode: "1000", dimensions: expect.objectContaining({ bankTxId: "tx-1" }) });
      expect(isBalanced(repost.lines)).toBe(true);
    });
  });

  describe("ledger", () => {
    it("posts balanced journals for every financial event and stores journal numbers", async () => {
      const invoice = await sentInvoice("ct-lumen", [{ description: "Build", quantity: 1, unitAmountMinor: 100_000 }, { description: "Export", quantity: 1, unitAmountMinor: 20_000, taxCode: "za_zero" }]);
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 50_000, paymentKey: "x1" });
      await h.call("billing.create-credit-note", { invoiceId: invoice.id, amountMinor: 11_500, reason: "Discount" });
      await h.call("billing.write-off", { invoiceId: invoice.id, reason: "Client closed" });
      const bill = await h.call<{ id: string }>("billing.create-bill", { supplierName: "Hosting Co", category: "hosting", supplierReference: "H-1" });
      await h.call("billing.add-bill-line", { billId: bill.id, description: "Server", unitAmountMinor: 11_500 });
      await h.call("billing.approve-bill", { billId: bill.id });
      await h.call("billing.pay-bill", { billId: bill.id });
      await h.call("billing.create-expense", { description: "Figma", amountMinor: 23_000, vatMinor: 3_000, category: "software", vatClaimable: true, paidFrom: "card" });
      const other = await sentInvoice("ct-lumos");
      await h.call("billing.cancel-invoice", { invoiceId: other.id, reason: "Wrong client" });

      const all = await journals();
      const kinds = all.map((j) => j.key.replace(/:[0-9a-f-]{36}/g, ":<id>"));
      expect(kinds).toEqual(expect.arrayContaining([
        "billing:invoice:<id>:issue",
        "billing:payment:<id>",
        "billing:credit_note:<id>:issue",
        "billing:invoice:<id>:write_off",
        "billing:bill:<id>:approve",
        "billing:bill_payment:<id>",
        "billing:expense:<id>:v1",
        "billing:invoice:<id>:void",
      ]));
      for (const journal of all) expect(isBalanced(journal.lines), journal.key).toBe(true);
      const voided = all.find((j) => j.key.endsWith(":void"))!;
      expect(voided.reverseKey).toBe(`billing:invoice:${other.id}:issue`);
      const note = all.find((j) => j.source.kind === "credit_note")!;
      // 11,500 against an invoice of 115,000 (std) + 20,000 (zero): VAT reverses at the charged rate.
      expect(note.lines.find((l) => l.role === "vat_output")!.debitMinor).toBe(1_278);
      const expense = all.find((j) => j.source.kind === "expense")!;
      expect(expense.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "expense:software", debitMinor: 20_000 }),
        expect.objectContaining({ role: "vat_input", debitMinor: 3_000, taxBaseMinor: 20_000 }),
        expect.objectContaining({ role: "bank", creditMinor: 23_000 }),
      ]));

      const issueKey = `billing:invoice:${invoice.id}:issue`;
      await h.deliver(LEDGER_RESULT, COMPANY, { key: issueKey, status: "posted", journalId: "j1", journalNumber: "JNL-0001", source: { plugin: "partnersinbiz.billing", kind: "invoice", id: invoice.id } });
      const row = (await h.client.query(`SELECT issue_journal, ledger_status FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as any;
      expect(row).toEqual({ issue_journal: "JNL-0001", ledger_status: "posted" });
      expect((await outbox()).find((r) => r.key === issueKey)!.status).toBe("done");

      // A rejection, then a posting after a retry: the posting wins; a late rejection never overwrites it.
      const billKey = `billing:bill:${bill.id}:approve`;
      const source = { plugin: "partnersinbiz.billing", kind: "bill", id: bill.id };
      await h.deliver(LEDGER_RESULT, COMPANY, { key: billKey, status: "rejected", error: "No expense:hosting account", source });
      let billRow = (await h.client.query(`SELECT ledger_status, ledger_error, journal_number FROM ${NAMESPACE}.bills WHERE id = $1`, [bill.id])).rows[0] as any;
      expect(billRow).toMatchObject({ ledger_status: "rejected", ledger_error: "No expense:hosting account" });
      await h.call("billing.retry-ledger", { key: billKey });
      await h.deliver(LEDGER_RESULT, COMPANY, { key: billKey, status: "posted", journalNumber: "JNL-0009", source });
      await h.deliver(LEDGER_RESULT, COMPANY, { key: billKey, status: "rejected", error: "late", source });
      billRow = (await h.client.query(`SELECT ledger_status, ledger_error, journal_number FROM ${NAMESPACE}.bills WHERE id = $1`, [bill.id])).rows[0] as any;
      expect(billRow).toEqual({ ledger_status: "posted", ledger_error: null, journal_number: "JNL-0009" });
      const writeOff = all.find((j) => j.key.endsWith(":write_off"))!;
      expect(writeOff.lines.map((l) => l.role)).toEqual(expect.arrayContaining(["bad_debts", "vat_output", "ar"]));
    });

    it("books realised FX on a foreign-currency receipt", async () => {
      await h.client.query(`INSERT INTO ${NAMESPACE}.fx_rates (day, base, rates, source) VALUES ('2026-09-01', 'ZAR', '{"ZAR":1,"USD":0.0555555556}', 'test'), ('2026-09-20', 'ZAR', '{"ZAR":1,"USD":0.05}', 'test')`);
      const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "USD", customerKind: "contact", customerRef: "ct-lumen", taxCode: "za_export_zero" });
      await h.call("billing.add-line", { invoiceId: invoice.id, description: "Export consulting", quantity: 1, unitAmountMinor: 100_000 });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'sent', sent_at = '2026-09-01T10:00:00Z', fx_rate = 18 WHERE id = $1`, [invoice.id]);
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 100_000, paidAt: "2026-09-20T10:00:00Z", paymentKey: "usd" });
      const fx = (await journals()).find((j) => j.key.endsWith(":fx"))!;
      expect(fx.currency).toBe("ZAR");
      expect(fx.lines).toEqual([expect.objectContaining({ role: "ar", debitMinor: 200_000 }), expect.objectContaining({ role: "fx_gain", creditMinor: 200_000 })]);
    });
  });

  describe("open items", () => {
    it("shares receivables with Accounting after each change", async () => {
      const invoice = await sentInvoice();
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 15_000, paymentKey: "o1" });
      const items = h.emitted.filter((e) => e.name === "open-item.upserted").map((e) => e.payload as { key: string; outstandingMinor: number; status: string; references: string[] });
      expect(items.at(-1)).toMatchObject({ key: `invoice:${invoice.id}`, outstandingMinor: 100_000, status: "partially_paid" });
      expect(items.at(-1)!.references).toContain(invoice.number);
      h.emitted.length = 0;
      await h.runJob("emit-open-items-all");
      expect(h.emitted.filter((e) => e.name === "open-item.upserted")).toHaveLength(1);
    });
  });

  describe("recurring, retainers and time", () => {
    it("copies every field onto the recurring invoice", async () => {
      const template = await draft("ct-lumen", [{ description: "Retainer — SEO", quantity: 1, unitAmountMinor: 500_000 }, { description: "Hosting", quantity: 1, unitAmountMinor: 20_000, taxCode: "za_zero" }]);
      await h.call("billing.update-invoice", { invoiceId: template.id, notes: "Thanks!", sendTo: "ap@lumen.test, cfo@lumen.test", pricesIncludeVat: true });
      await h.call("billing.create-recurring", { templateInvoiceId: template.id, frequency: "monthly", nextRunAt: "2026-08-01T00:00:00Z" });
      await h.runJob("run-recurring");
      await h.runJob("run-recurring");
      const rows = (await h.client.query(`SELECT id, number, notes, send_to, prices_include_vat, total_minor, recurring_key FROM ${NAMESPACE}.invoices WHERE recurring_id IS NOT NULL ORDER BY created_at`)).rows as any[];
      expect(rows).toHaveLength(2); // Aug and Sep (one period per run, catching up); Oct is not due yet
      expect(rows[0]).toMatchObject({ number: "LUM-002", notes: "Thanks!", prices_include_vat: true, recurring_key: expect.stringMatching(/2026-08-01$/) });
      expect(rows[1].recurring_key).toMatch(/2026-09-01$/);
      expect(rows[0].send_to).toEqual([{ email: "ap@lumen.test", name: null }, { email: "cfo@lumen.test", name: null }]);
      const lines = (await h.client.query(`SELECT description, tax_code FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1 ORDER BY created_at`, [rows[0].id])).rows;
      expect(lines).toEqual([{ description: "Retainer — SEO", tax_code: "za_std_15" }, { description: "Hosting", tax_code: "za_zero" }]);
      const tmpl = (await h.client.query(`SELECT total_minor FROM ${NAMESPACE}.invoices WHERE id = $1`, [template.id])).rows[0] as any;
      expect(Number(rows[0].total_minor)).toBe(Number(tmpl.total_minor));
    });

    it("drafts one retainer invoice per period", async () => {
      const plan = await h.call<{ id: string }>("billing.create-plan", { name: "Growth retainer", priceMinor: 1_500_000, period: "monthly" });
      await h.call("billing.create-subscription", { client: "contact:ct-lumen", planId: plan.id, startAt: "2026-09-01T00:00:00Z" });
      await h.runJob("run-recurring");
      const invoices = (await h.client.query(`SELECT status, subscription_id, total_minor FROM ${NAMESPACE}.invoices WHERE subscription_id IS NOT NULL`)).rows as any[];
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ status: "draft" });
      expect(Number(invoices[0].total_minor)).toBe(1_725_000);
      const reports = await h.call<{ mrr: { mrrMinor: number; arrMinor: number; active: number } }>("billing.reports", {});
      expect(reports.mrr).toMatchObject({ mrrMinor: 1_500_000, arrMinor: 18_000_000, active: 1 });
    });

    it("bills time entries once", async () => {
      const entry = await h.call<{ id: string; amountMinor: number }>("billing.log-time", { description: "Strategy call", minutes: 90, rateMinor: 85_000, client: "contact:ct-lumen" });
      expect(entry.amountMinor).toBe(127_500);
      await expect(h.call("billing.start-timer", { description: "a" })).resolves.toBeTruthy();
      await expect(h.call("billing.start-timer", { description: "b" })).rejects.toThrow(/already running/);
      const invoice = await draft("ct-lumen", []);
      const billed = await h.call<{ billed: number }>("billing.bill-time", { invoiceId: invoice.id, entryIds: [entry.id] });
      expect(billed.billed).toBe(1);
      const other = await draft("ct-lumen", []);
      expect((await h.call<{ billed: number }>("billing.bill-time", { invoiceId: other.id, entryIds: [entry.id] })).billed).toBe(0);
      const d = await detail(invoice.id);
      expect(d.invoice.subtotalMinor).toBe(127_500);
    });
  });

  describe("reports", () => {
    it("ages what is still owed, including partly paid invoices", async () => {
      const a = await sentInvoice();
      const b = await sentInvoice();
      await h.call("billing.record-payment", { invoiceId: b.id, amountMinor: 15_000, paymentKey: "r1" });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '45 days' WHERE id = $1`, [a.id]);
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '100 days' WHERE id = $1`, [b.id]);
      const reports = await h.call<any>("billing.reports", {});
      expect(reports.agedDebtors.buckets["31-60"]).toEqual({ count: 1, amountMinor: 115_000 });
      expect(reports.agedDebtors.buckets["90+"]).toEqual({ count: 1, amountMinor: 100_000 });
      expect(reports.clients.clients[0]).toMatchObject({ clientKey: "contact:ct-lumen", outstandingMinor: 215_000, lifetimePaidMinor: 15_000 });
    });
  });

  describe("dunning", () => {
    it("sends one reminder per stage and skips opted-out clients", async () => {
      h.config.set(COMPANY, { ...SETTINGS, dunning: { enabled: true } });
      const a = await sentInvoice("ct-lumen");
      const b = await sentInvoice("ct-lumos");
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '8 days' WHERE id IN ($1, $2)`, [a.id, b.id]);
      await h.call("billing.set-dunning-optout", { client: "contact:ct-lumos", optOut: true });
      await h.runJob("dunning");
      await h.runJob("dunning");
      const reminders = (await outbox("mail.send.requested")).map((r) => r.payload as any);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].key).toBe(`billing:mail:reminder:${a.id}:2`);
      expect(reminders[0].subject).toContain("8 days overdue");
    });
  });

  describe("expenses and receipts", () => {
    it("reads a receipt with Claude and lets Jev pick the category", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url).includes("r2.cloudflarestorage.com")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
        if (String(url).includes("api.anthropic.com")) {
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("claude-haiku-4-5-20251001");
          expect(body.output_config.format.type).toBe("json_schema");
          expect(body.messages[0].content[0].type).toBe("image");
          return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ vendor: "Takealot", date: "2026-09-10", totalMinor: 115_000, vatMinor: 15_000, currency: "ZAR" }) }] });
        }
        if (String(url).includes("typesafe.ai")) {
          const body = JSON.parse(String(init?.body));
          expect(JSON.stringify(body.state)).not.toContain("115000");
          return Response.json({ model: "jev-1.13.0", answers: { category: { type: "choice", choice: "equipment", probabilities: { equipment: 0.93 }, confidence: 0.93 }, vat_claimable: { type: "noul", noul: 0.97 } } });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch;
      try {
        h.config.set(COMPANY, {
          ...SETTINGS,
          r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk", prefix: "billing" },
          anthropic: { apiKey: "sk-ant" },
          jev: { apiKey: "jev-key" },
        });
        const upload = await h.call<{ key: string; uploadUrl: string }>("billing.upload-url", { purpose: "receipt", fileName: "till.png", mime: "image/png", bytes: 3 });
        expect(upload.key).toMatch(new RegExp(`^billing/${COMPANY}/receipt/`));
        const expense = await h.call<{ id: string; status: string; category: string; vatClaimable: boolean; amountMinor: number; vendor: string }>("billing.receipt-to-expense", { key: upload.key, mime: "image/png", fileName: "till.png" });
        expect(expense).toMatchObject({ status: "draft", category: "equipment", vatClaimable: true, amountMinor: 115_000, vendor: "Takealot" });
        expect(await journals()).toHaveLength(0);
        await h.call("billing.update-expense", { expenseId: expense.id, record: true, category: "software" });
        const corrected = (await h.client.query(`SELECT question_key, value_text, corrected_to FROM ${NAMESPACE}.decisions WHERE question_key = 'category'`)).rows;
        expect(corrected).toEqual([{ question_key: "category", value_text: "equipment", corrected_to: "software" }]);
        await h.call("billing.update-expense", { expenseId: expense.id, amountMinor: 120_000 });
        const keys = (await journals()).map((j) => j.key.replace(expense.id, "<id>"));
        expect(keys).toEqual(["billing:expense:<id>:v1", "billing:expense:<id>:v1:reverse", "billing:expense:<id>:v2"]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe("PDF", () => {
    it("renders invoice, credit note and statement PDFs", async () => {
      const invoice = await sentInvoice();
      const pdf = await h.call<{ base64: string; filename: string }>("billing.document-pdf", { kind: "invoice", id: invoice.id });
      expect(Buffer.from(pdf.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.filename).toBe(`Invoice-${invoice.number}.pdf`);
      const note = await h.call<{ id: string }>("billing.create-credit-note", { invoiceId: invoice.id, amountMinor: 1_000 });
      const cn = await h.call<{ base64: string }>("billing.credit-note-pdf", { creditNoteId: note.id });
      expect(Buffer.from(cn.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      const statement = await h.call<{ base64: string; entries: number }>("billing.statement-pdf", { client: "contact:ct-lumen" });
      expect(statement.entries).toBe(2);
      expect(Buffer.from(statement.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    });
  });

  it("runs every other action within the host SQL rules", async () => {
    const run = async (key: string, params: Record<string, unknown> = {}) => h.call<any>(key, params);
    // Quotes end to end.
    const quote = await run("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", validUntil: "2026-10-31" });
    const withLine = await run("billing.add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 20_000 });
    await run("billing.update-quote-line", { quoteId: quote.id, lineId: withLine.lineId, quantity: 2 });
    await run("billing.update-quote", { quoteId: quote.id, notes: "Valid 30 days" });
    const detailQ = await run("billing.quote-detail", { quoteId: quote.id });
    expect(detailQ.quote.totalMinor).toBe(46_000);
    const { issueId } = await run("billing.request-quote-send", { quoteId: quote.id });
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
    const qKey = `billing:mail:quote:${quote.id}:1`;
    await h.deliver(MAILBOX_RESULT, COMPANY, { key: qKey, status: "sent", sentAt: "2026-09-26T10:00:00Z", context: { plugin: "partnersinbiz.billing", kind: "quote", id: quote.id } });
    expect((await run("billing.quote-detail", { quoteId: quote.id })).quote).toMatchObject({ status: "sent", deliveryStatus: "sent" });
    await run("billing.set-quote-status", { quoteId: quote.id, status: "accepted" });
    const converted = await run("billing.convert-quote", { quoteId: quote.id });
    const convertedLines = await run("billing.invoice-detail", { invoiceId: converted.invoice.id });
    expect(convertedLines.lines.map((l: any) => l.description)).toEqual(["Audit"]);
    expect((await run("billing.quote-html", { quoteId: quote.id })).html).toContain("Quote Q-LUM-001");
    const extra = await run("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    const extraLine = await run("billing.add-quote-line", { quoteId: extra.id, description: "x", quantity: 1, unitAmountMinor: 1 });
    await run("billing.remove-quote-line", { quoteId: extra.id, lineId: extraLine.lineId });

    // Invoice lines, html, payments list, credit, statements.
    const inv = await draft("ct-lumen", [{ description: "A", quantity: 1, unitAmountMinor: 10_000 }]);
    const added = await run("billing.add-line", { invoiceId: inv.id, description: "B", quantity: 1, unitAmountMinor: 5_000 });
    await run("billing.update-line", { invoiceId: inv.id, lineId: added.lineId, taxCode: "za_exempt" });
    await run("billing.remove-line", { invoiceId: inv.id, lineId: added.lineId });
    expect((await run("billing.invoice-html", { invoiceId: inv.id })).html).toContain("15");
    await run("billing.mark-sent", { invoiceId: inv.id });
    await run("billing.record-payment", { invoiceId: inv.id, amountMinor: 20_000, paymentKey: "sweep" });
    expect(await run("billing.invoice-payments", { invoiceId: inv.id })).toHaveLength(1);
    expect((await run("billing.customer-credit", { client: "contact:ct-lumen" }))[0].availableMinor).toBe(8_500);
    const note = await run("billing.create-credit-note", { invoiceId: inv.id, amountMinor: 500 });
    await run("billing.send-credit-note", { creditNoteId: note.id });
    expect(await run("billing.list-credit-notes")).toHaveLength(1);
    await run("billing.send-statement", { client: "contact:ct-lumen", from: "2026-01-01", to: "2026-12-31" });
    expect((await outbox("mail.send.requested")).map((r) => r.key.split(":")[2])).toEqual(expect.arrayContaining(["quote", "credit_note", "statement"]));

    // Reminders, retainers, recurring, time, bills, expenses, decisions.
    expect((await run("billing.dunning")).enabled).toBe(false);
    await run("billing.set-dunning-optout", { client: "contact:ct-lumen", optOut: true });
    await run("billing.set-dunning-optout", { client: "contact:ct-lumen", optOut: false });
    expect(await run("billing.run-dunning")).toMatchObject({ sent: 0 });
    const plan = await run("billing.create-plan", { name: "P", priceMinor: 100, period: "quarterly" });
    await run("billing.update-plan", { planId: plan.id, active: false });
    const sub = await run("billing.create-subscription", { client: "contact:ct-lumen", priceMinor: 100, description: "Care", startAt: "2027-01-01" });
    await run("billing.set-subscription-status", { subscriptionId: sub.id, status: "paused" });
    expect((await run("billing.retainers", { client: "contact:ct-lumen" })).subscriptions[0].status).toBe("paused");
    const recurring = await run("billing.create-recurring", { templateInvoiceId: inv.id, frequency: "quarterly", nextRunAt: "2027-01-01T00:00:00Z" });
    await run("billing.update-recurring", { recurringId: recurring.id, autoSend: true, endsAt: "2027-12-31" });
    await run("billing.pause-recurring", { recurringId: recurring.id });
    await run("billing.resume-recurring", { recurringId: recurring.id });
    expect(await run("billing.list-recurring")).toHaveLength(1);
    const timer = await run("billing.start-timer", { description: "Now" });
    await run("billing.stop-timer", { entryId: timer.id });
    await run("billing.delete-time-entry", { entryId: timer.id });
    expect(await run("billing.list-time", { unbilled: true })).toHaveLength(0);
    const bill = await run("billing.create-bill", { supplierKind: "contact", supplierRef: "ct-lumos", supplierName: "Lumos", category: "contractors" });
    const bl = await run("billing.add-bill-line", { billId: bill.id, description: "Dev", unitAmountMinor: 1_000 });
    await run("billing.remove-bill-line", { billId: bill.id, lineId: bl.lines[0].id });
    await run("billing.update-bill", { billId: bill.id, notes: "n", dueDate: "2026-11-01" });
    await run("billing.add-bill-line", { billId: bill.id, description: "Dev", unitAmountMinor: 1_000 });
    await run("billing.request-bill-approval", { billId: bill.id });
    const issue = [...h.issues.values()].find((i) => i.title.startsWith("Approve bill"))!;
    issue.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issue.id });
    expect((await run("billing.bill-detail", { billId: bill.id })).status).toBe("approved");
    const other = await run("billing.create-bill", { supplierName: "Temp" });
    await run("billing.cancel-bill", { billId: other.id });
    const expense = await run("billing.create-expense", { description: "Taxi", amountMinor: 5_000, category: "travel", vatClaimable: false });
    await run("billing.void-expense", { expenseId: expense.id });
    await expect(run("billing.receipt-file", { expenseId: expense.id })).rejects.toThrow(/No file/);
    await expect(run("billing.upload-url", { purpose: "receipt", mime: "image/png", bytes: 10 })).rejects.toThrow(/private R2/);
    await expect(run("billing.correct-decision", { decisionId: "none", correctedTo: "travel" })).resolves.toEqual({ ok: false });
    const reports = await run("billing.reports", { from: "2026-01-01", to: "2026-12-31" });
    expect(reports.agedCreditors.totalMinor).toBe(1_000); // bill amounts include VAT by default
    for (const journal of await journals()) expect(isBalanced(journal.lines), journal.key).toBe(true);
    expect(h.statements.length).toBeGreaterThan(100);
  });

  it("loads the page in own and client workspace mode", async () => {
    await sentInvoice();
    const own = await h.call<any>("billing.load", {});
    expect(own.invoices).toHaveLength(1);
    expect(own.features).toMatchObject({ email: true, ledger: true, dunning: false });
    const ws = await h.call<any>("billing.load", { client: "contact:ct-lumen" });
    expect(ws.client).toMatchObject({ kind: "contact", id: "ct-lumen", name: "Lumen Digital", found: true });
    expect(ws.bills).toEqual([]);
    expect(ws.expenses).toEqual([]);
  });

  it("runs tools as an agent with the 0.2 names", async () => {
    const run = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "p" };
    const failed = (await h.tools.get("record-payment")!({ invoiceId: "nope", amountMinor: 1 }, run)) as { data: unknown; error: string };
    expect(failed.data).toEqual({ ok: false, error: "Invoice was not found" });
    const listed = (await h.tools.get("list-open-invoices")!({}, run)) as { data: { items: unknown[]; count: number } };
    expect(listed.data).toEqual({ items: [], count: 0 });
    const created = (await h.tools.get("create-invoice")!({ currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", customerName: "Lumen Digital" }, run)) as { data: { id: string; number: string } };
    expect(created.data.number).toBe("LUM-001");
    const line = (await h.tools.get("add-line")!({ invoiceId: created.data.id, description: "Work", quantity: 1, unitAmountMinor: 1_000 }, run)) as { data: { totalMinor: number } };
    expect(line.data.totalMinor).toBe(1_150);
    const html = (await h.tools.get("invoice-html")!({ invoiceId: created.data.id }, run)) as { data: { html: string } };
    expect(html.data.html).toContain("Invoice LUM-001");
    const report = (await h.tools.get("billing-report")!({}, run)) as { data: { agedDebtors: unknown } };
    expect(report.data.agedDebtors).toBeTruthy();
    void userContext;
  });
});
