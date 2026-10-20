/**
 * End-to-end flow tests: invoice/quote send saves PDF to Drive in 03 Deliverables folder.
 * Drive failures are fire-and-forget: the send succeeds even if Drive save fails.
 * The driveSave call is mocked to verify the exact bytes and parameters are passed to the kit.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

// Hoisted before module imports
const { fakeDriveSave } = vi.hoisted(() => ({
  fakeDriveSave: vi.fn(),
}));

vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => {
  const original = await orig<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return {
    ...original,
    driveSave: fakeDriveSave,
  };
});

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
    vi.clearAllMocks();
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" } });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "ct-lumos", name: "Lumos Labs", email: "pay@lumos.test" });
    fakeDriveSave.mockResolvedValue({
      status: "saved",
      requestId: "r",
      driveFileId: "f",
      url: "https://drive.example/f",
    });
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

  async function detail(invoiceId: string) {
    return h.call<{ invoice: { status: string; deliveryStatus: string } }>("billing.invoice-detail", { invoiceId });
  }

  describe("send flow without errors", () => {
    it("invoice: send completes and queues the mail (with saveSentCopy in the flow)", async () => {
      let r2PutBody: Uint8Array | undefined;
      const put = vi.fn(async (_url: string, init: { body: Uint8Array }) => {
        r2PutBody = init.body;
        return new Response("", { status: 200 });
      });
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen", [{ description: "SEO work", quantity: 1, unitAmountMinor: 100_000 }]);
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        // Verify R2 was called (PDF rendered and stored)
        expect(put).toHaveBeenCalledTimes(1);

        // Verify driveSave was called with the same PDF bytes
        await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalledTimes(1));
        const driveCall = fakeDriveSave.mock.calls[0]!;
        const driveOpts = driveCall[1];
        expect(driveOpts.subfolder).toBe("03 Deliverables");
        expect(driveOpts.kind).toBe("client");
        expect(driveOpts.mimeType).toBe("application/pdf");
        expect(driveOpts.name).toMatch(/^\d{4}-\d{2}-\d{2} Invoice .+ v01\.pdf$/);
        expect(driveOpts.client).toEqual({ kind: "contact", ref: "ct-lumen" });
        expect(driveOpts.companyId).toBe(COMPANY);

        // KEY ASSERTION: saved bytes equal uploaded bytes
        const r2Sha256 = createHash("sha256").update(r2PutBody!).digest("hex");
        const driveSha256 = createHash("sha256").update(driveOpts.bytes).digest("hex");
        expect(driveSha256).toBe(r2Sha256);

        // Verify PDF sanity
        expect(driveOpts.bytes[0]).toBe(0x25); // "%"
        expect(driveOpts.bytes[1]).toBe(0x50); // "P"
        expect(driveOpts.bytes[2]).toBe(0x44); // "D"
        expect(driveOpts.bytes[3]).toBe(0x46); // "F"

        // Verify the invoice is queued for send
        const d = await detail(invoice.id);
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("quote: send completes and queues the mail (with saveSentCopy in the flow)", async () => {
      let r2PutBody: Uint8Array | undefined;
      const put = vi.fn(async (_url: string, init: { body: Uint8Array }) => {
        r2PutBody = init.body;
        return new Response("", { status: 200 });
      });
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const quote = await draftQuote("ct-lumos", [{ description: "Strategy", quantity: 1, unitAmountMinor: 50_000 }]);
        const { issueId } = await h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: quote.id }, userContext());
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        expect(put).toHaveBeenCalledTimes(1);

        // Verify driveSave was called with the same PDF bytes
        await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalledTimes(1));
        const driveCall = fakeDriveSave.mock.calls[0]!;
        const driveOpts = driveCall[1];
        expect(driveOpts.subfolder).toBe("03 Deliverables");
        expect(driveOpts.kind).toBe("client");
        expect(driveOpts.mimeType).toBe("application/pdf");
        expect(driveOpts.name).toMatch(/^\d{4}-\d{2}-\d{2} Quote Q-\S+ v01\.pdf$/);
        expect(driveOpts.client).toEqual({ kind: "contact", ref: "ct-lumos" });

        // KEY ASSERTION: saved bytes equal uploaded bytes
        const r2Sha256 = createHash("sha256").update(r2PutBody!).digest("hex");
        const driveSha256 = createHash("sha256").update(driveOpts.bytes).digest("hex");
        expect(driveSha256).toBe(r2Sha256);

        const d = await h.call<{ quote: { status: string; deliveryStatus: string } }>("billing.quote-detail", { quoteId: quote.id });
        expect(d.quote.deliveryStatus).toBe("queued");
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

      expect(fakeDriveSave).not.toHaveBeenCalled();

      const d = await detail(invoice.id);
      expect(d.invoice.deliveryStatus).toBe("queued");
    });

    it("invoice: when email is off (manual mode), send marks sent without queueing", async () => {
      h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" }, email: { off: true } });

      const invoice = await draft("ct-lumen");
      await h.call("billing.mark-sent", { invoiceId: invoice.id });

      expect(fakeDriveSave).not.toHaveBeenCalled();

      const d = await detail(invoice.id);
      expect(d.invoice.status).toBe("sent");
      expect(d.invoice.deliveryStatus).toBe("manual");
    });
  });

  describe("driveSave failure scenarios (fire-and-forget)", () => {
    it("invoice send continues when driveSave returns failed status", async () => {
      fakeDriveSave.mockResolvedValue({
        status: "failed",
        requestId: "r",
        reason: "drive_not_bound",
      });

      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen");
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        // Send completes even though driveSave failed
        const d = await detail(invoice.id);
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("invoice send continues when driveSave returns no_ack", async () => {
      fakeDriveSave.mockResolvedValue({
        status: "no_ack",
        requestId: "r",
      });

      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen");
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        const d = await detail(invoice.id);
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("invoice send continues when driveSave rejects", async () => {
      fakeDriveSave.mockRejectedValue(new Error("Network error"));

      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen");
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        const d = await detail(invoice.id);
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("invoice send continues when driveSave never settles (timeout)", async () => {
      fakeDriveSave.mockImplementation(() => new Promise(() => {})); // Never settles

      const put = vi.fn(async () => new Response("", { status: 200 }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = put as unknown as typeof fetch;

      try {
        const invoice = await draft("ct-lumen");
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });

        // Should complete immediately without waiting for driveSave
        const d = await detail(invoice.id);
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});
