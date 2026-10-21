import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn() }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...await orig(), driveSave: fakeDriveSave }));

const available = await embeddedAvailable();
describe.skipIf(!available)("sent-copy flows (postgres)", () => {
  let h: Harness;
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  beforeAll(async () => { h = await startHarness(); await plugin.definition.setup(h.ctx); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  beforeEach(async () => {
    vi.clearAllMocks();
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" } });
    await Promise.all([seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" }), seedClient(h, { id: "ct-lumos", name: "Lumos Labs", email: "pay@lumos.test" })]);
    fakeDriveSave.mockResolvedValue({ status: "saved", requestId: "r", driveFileId: "f", url: "https://drive.example/f" });
  });

  async function createDoc(kind: "invoice" | "quote", customerRef: string) {
    const isInvoice = kind === "invoice";
    const doc = await h.call<{ id: string }>(isInvoice ? "billing.create-invoice" : "billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef });
    const addFn = isInvoice ? "billing.add-line" : "billing.add-quote-line";
    const idKey = isInvoice ? "invoiceId" : "quoteId";
    await h.call(addFn, { [idKey]: doc.id, description: "work", quantity: 1, unitAmountMinor: 100_000 });
    return doc;
  }

  async function mockR2Put() {
    let body: Uint8Array | undefined;
    const put = vi.fn(async (_: string, init: { body: Uint8Array }) => { body = init.body; return new Response(); });
    const real = globalThis.fetch;
    globalThis.fetch = put as any;
    return { put, body: () => body, restore: () => { globalThis.fetch = real; } };
  }

  it.each([["invoice", "ct-lumen"], ["quote", "ct-lumos"]] as const)("send %s: pdf to drive with correct bytes", async (kind, customerRef) => {
    const r2 = await mockR2Put();
    try {
      const doc = await createDoc(kind, customerRef);
      const reqFn = kind === "invoice" ? "billing.request-send" : "billing.request-quote-send";
      const idKey = kind === "invoice" ? "invoiceId" : "quoteId";
      const { issueId } = await h.call<{ issueId: string }>(reqFn, { [idKey]: doc.id }, kind === "quote" ? userContext() : undefined);
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      expect(r2.put).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(fakeDriveSave).toHaveBeenCalledTimes(1));
      const opts = fakeDriveSave.mock.calls[0]![1];
      expect(opts.subfolder).toBe("03 Deliverables");
      expect(opts.kind).toBe("client");
      expect(opts.mimeType).toBe("application/pdf");
      expect(opts.client.kind).toBe("contact");
      expect(opts.client.ref).toBe(customerRef);
      expect(opts.companyId).toBe(COMPANY);
      expect(sha256(opts.bytes)).toBe(sha256(r2.body()!));
      expect(opts.bytes.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    } finally {
      r2.restore();
    }
  });

  it("no R2: no driveSave call", async () => {
    h.config.set(COMPANY, { ...SETTINGS });
    const doc = await createDoc("invoice", "ct-lumen");
    const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: doc.id });
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
    expect(fakeDriveSave).not.toHaveBeenCalled();
  });

  it("email off: no driveSave, delivery manual", async () => {
    h.config.set(COMPANY, { ...SETTINGS, r2: { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" }, email: { off: true } });
    const doc = await createDoc("invoice", "ct-lumen");
    await h.call("billing.mark-sent", { invoiceId: doc.id });
    expect(fakeDriveSave).not.toHaveBeenCalled();
    const d = await h.call<{ invoice: any }>("billing.invoice-detail", { invoiceId: doc.id });
    expect(d.invoice.deliveryStatus).toBe("manual");
  });

  it.each([["failed", () => fakeDriveSave.mockResolvedValue({ status: "failed", requestId: "r", reason: "x" })], ["rejects", () => fakeDriveSave.mockRejectedValue(new Error())], ["timeout", () => fakeDriveSave.mockImplementation(() => new Promise(() => {}))]] as const)("send continues when driveSave %s", async (_, setup) => {
    setup();
    const r2 = await mockR2Put();
    try {
      const doc = await createDoc("invoice", "ct-lumen");
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: doc.id });
      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId });
      const d = await h.call<{ invoice: any }>("billing.invoice-detail", { invoiceId: doc.id });
      expect(d.invoice.deliveryStatus).toBe("queued");
    } finally {
      r2.restore();
    }
  });
});
