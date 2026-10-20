import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

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

describe.skipIf(!available)("sent-copy flows (postgres)", () => {
  let h: Harness;
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

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
    fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });
  });

  async function draft(customerRef = "ct-lumen", lines = [{ description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 }]) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    for (const line of lines) await h.call("billing.add-line", { invoiceId: invoice.id, ...line });
    return invoice;
  }

  async function draftQuote(customerRef = "ct-lumen", lines = [{ description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 }]) {
    const quote = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef });
    for (const line of lines) await h.call("billing.add-quote-line", { quoteId: quote.id, ...line });
    return quote;
  }

  async function mockR2Put() {
    let body: Uint8Array | undefined;
    const put = vi.fn(async (_url: string, init: { body: Uint8Array }) => {
      body = init.body;
      return new Response("", { status: 200 });
    });
    const real = globalThis.fetch;
    globalThis.fetch = put as unknown as typeof fetch;
    return { put, body: () => body, restore: () => { globalThis.fetch = real; } };
  }

  describe("send flow without errors", () => {
    it.each([
      ["invoice", "ct-lumen", () => draft("ct-lumen", [{ description: "SEO work", quantity: 1, unitAmountMinor: 100_000 }]), (doc: any) => h.call<{ issueId: string }>("billing.request-send", { invoiceId: doc.id }), (name: string) => name.includes("Invoice")],
      ["quote", "ct-lumos", () => draftQuote("ct-lumos", [{ description: "Strategy", quantity: 1, unitAmountMinor: 50_000 }]), (doc: any) => h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: doc.id }, userContext()), (name: string) => name.includes("Quote")],
    ])("%s: send completes and queues", async (_, customerRef, createDoc, requestSend, nameCheck) => {
      const r2 = await mockR2Put();
      try {
        const doc = await createDoc();
        const { issueId } = await requestSend(doc);
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
        expect(r2.put).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalledTimes(1));
        const opts = fakeDriveSave.mock.calls[0]![1];
        expect(opts.subfolder).toBe("03 Deliverables");
        expect(opts.kind).toBe("client");
        expect(opts.mimeType).toBe("application/pdf");
        expect(nameCheck(opts.name)).toBe(true);
        expect(opts.client.kind).toBe("contact");
        expect(opts.client.ref).toBe(customerRef);
        expect(opts.companyId).toBe(COMPANY);
        expect(sha256(opts.bytes)).toBe(sha256(r2.body()!));
        expect(opts.bytes.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      } finally {
        r2.restore();
      }
    });

    it("no R2: send completes without driveSave", async () => {
      h.config.set(COMPANY, { ...SETTINGS });
      const invoice = await draft("ct-lumen");
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      expect(fakeDriveSave).not.toHaveBeenCalled();
    });

    it("email off: marks sent without queueing", async () => {
      h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" }, email: { off: true } });
      const invoice = await draft("ct-lumen");
      await h.call("billing.mark-sent", { invoiceId: invoice.id });
      expect(fakeDriveSave).not.toHaveBeenCalled();
      const d = await h.call<{ invoice: any }>("billing.invoice-detail", { invoiceId: invoice.id });
      expect(d.invoice.status).toBe("sent");
      expect(d.invoice.deliveryStatus).toBe("manual");
    });
  });

  describe("driveSave failure scenarios (fire-and-forget)", () => {
    it.each([
      ["failed status", () => fakeDriveSave.mockResolvedValue({ status: "failed" as const, requestId: "r", reason: "drive_not_bound" })],
      ["no_ack", () => fakeDriveSave.mockResolvedValue({ status: "no_ack" as const, requestId: "r" })],
      ["rejects", () => fakeDriveSave.mockRejectedValue(new Error("Network error"))],
      ["never settles", () => fakeDriveSave.mockImplementation(() => new Promise(() => {}))],
    ])("invoice send continues when %s", async (_, setup) => {
      setup();
      const r2 = await mockR2Put();
      try {
        const invoice = await draft("ct-lumen");
        const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
        h.issues.get(issueId)!.status = "done";
        await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
        const d = await h.call<{ invoice: any }>("billing.invoice-detail", { invoiceId: invoice.id });
        expect(d.invoice.deliveryStatus).toBe("queued");
      } finally {
        r2.restore();
      }
    });
  });
});
