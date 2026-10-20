/**
 * End-to-end flow tests: invoice/quote send saves PDF to Drive in 03 Deliverables folder.
 * Drive failures are fire-and-forget: the send succeeds even if Drive save fails.
 * Note: Testing the actual driveSave call flow requires the full CRM integration, which is
 * handled by the kit's registerDriveReplies. These tests verify the send flow completes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const MAILBOX_RESULT = "plugin.partnersinbiz.mailbox.mail.send.result";

describe.skipIf(!available)("sent-copy flows (postgres)", () => {
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
    h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" } });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "ct-lumos", name: "Lumos Labs", email: "pay@lumos.test" });
  });

  async function draft(customerRef = "ct-lumen", lines: Array<{ description: string; quantity: number; unitAmountMinor: number; taxCode?: string }> = [{ description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 }]) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    for (const line of lines) await h.call("billing.add-line", { invoiceId: invoice.id, ...line });
    return invoice;
  }

  async function draftQuote(customerRef = "ct-lumen", lines: Array<{ description: string; quantity: number; unitAmountMinor: number; taxCode?: string }> = [{ description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 }]) {
    const quote = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef });
    for (const line of lines) await h.call("billing.add-quote-line", { quoteId: quote.id, ...line });
    return quote;
  }

  describe("send flow without errors", () => {
    it("invoice: send completes and queues the mail (with saveSentCopy in the flow)", async () => {
      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen", [{ description: "SEO work", quantity: 1, unitAmountMinor: 100_000 }]);
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        // Verify R2 was called (PDF rendered and stored)
        expect(put).toHaveBeenCalledTimes(1);

        // Verify the invoice is queued for send
        const detail = await h.call<{ invoice: { status: string; deliveryStatus: string } }>("billing.invoice-detail", { invoiceId: invoice.id });
        expect(detail.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("quote: send completes and queues the mail (with saveSentCopy in the flow)", async () => {
      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const quote = await draftQuote("ct-lumos", [{ description: "Strategy", quantity: 1, unitAmountMinor: 50_000 }]);
        const { issueId } = await h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: quote.id }, userContext());
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        expect(put).toHaveBeenCalledTimes(1);

        const detail = await h.call<{ quote: { status: string; deliveryStatus: string } }>("billing.quote-detail", { quoteId: quote.id });
        expect(detail.quote.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("invoice: when R2 is not configured, send completes without PDF", async () => {
      h.config.set(COMPANY, { ...SETTINGS }); // No R2

      const invoice = await draft("ct-lumen");
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

      const detail = await h.call<{ invoice: { status: string; deliveryStatus: string } }>("billing.invoice-detail", { invoiceId: invoice.id });
      expect(detail.invoice.deliveryStatus).toBe("queued");
    });

    it("invoice: when email is off (manual mode), send marks sent without queueing", async () => {
      h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" }, email: { off: true } });

      const invoice = await draft("ct-lumen");
      await h.call("billing.mark-sent", { invoiceId: invoice.id });

      const detail = await h.call<{ invoice: { status: string; deliveryStatus: string } }>("billing.invoice-detail", { invoiceId: invoice.id });
      expect(detail.invoice.status).toBe("sent");
      expect(detail.invoice.deliveryStatus).toBe("manual");
    });

  });
});
