/**
 * A paid invoice is filed to Drive through a filing issue for the Account Manager (PAR-4111): one issue per
 * invoice, the printable invoice as the `invoice` document, nothing for drafts, unpaid or canary clients.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { getInvoice } from "../src/db.js";
import { openInvoiceFilingIssue } from "../src/filing.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, invoiceNumber, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ORIGIN = "billing:drive-file:invoice:";

describe.skipIf(!available)("paid invoice filing issue (postgres)", () => {
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
    await seedClient(h, { id: "canary-ct", name: "Canary Client", email: "x@canary.invalid" });
  });

  const filingIssues = () => [...h.issues.values()].filter((issue) => issue.originId?.startsWith(ORIGIN));

  async function draft(customerRef = "ct-lumen") {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 });
    return invoice;
  }
  async function sent(customerRef = "ct-lumen") {
    const invoice = await draft(customerRef);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    invoice.number = (await invoiceNumber(h, invoice.id))!;
    return invoice;
  }
  const pay = (invoiceId: string, key = "all") => h.call("billing.record-payment", { invoiceId, amountMinor: 115_000, paymentKey: key });

  it("opens one filing issue when an invoice is paid, with the invoice as a document and no link", async () => {
    const invoice = await sent();
    await pay(invoice.id);
    const [issue] = filingIssues();
    expect(filingIssues()).toHaveLength(1);
    expect(issue!.originId).toBe(`${ORIGIN}${invoice.id}`);
    expect(issue!.title).toBe(`File paid invoice ${invoice.number} (Lumen Digital)`);
    const body = issue!.description!;
    expect(body).toContain("Lumen Digital");
    expect(body).toContain("`02 Partners in Biz/Clients/<Company> (<Contact>)/Contracts & Quotes/`");
    expect(body).toContain("0ADMOMlq1HzGgUk9PVA");
    expect(body).toContain("1FDrIxsipXHGSOCJzRls0kXAQqeCPFtnU");
    expect(body).toMatch(new RegExp(`\\d{4}-\\d{2}-\\d{2} Lumen Digital invoice ${invoice.number} SEO sprint \\(paid\\) v01\\.pdf`));
    expect(body).toContain("pib-drive-saving");
    expect(body).toContain("Google Drive (filing)");
    expect(body).toContain(`drive-file.sh invoice-pdf ${invoice.id} <outFile>`);
    expect(body).toContain("agent_authorization_required");
    expect(body).toContain("Never create a client folder, never file under another name.");
    expect(body).not.toMatch(/https?:\/\//);
    const doc = h.documents.get(`${issue!.id}:invoice`)!;
    expect(doc.format).toBe("markdown");
    expect(doc.body).toContain(invoice.number);
    expect(doc.body).toContain("1,150.00");
    expect(doc.body).toContain("<html");
  });

  it("does not open a second issue when the paid hand-off is replayed, and re-upserts the document once", async () => {
    const invoice = await sent();
    await pay(invoice.id);
    const row = (await getInvoice(h.ctx, invoice.id))!;
    const real = h.ctx.issues.documents.upsert;
    let upserts = 0;
    h.ctx.issues.documents.upsert = (async (input: Parameters<typeof real>[0]) => { upserts++; return real(input); }) as typeof real;
    try {
      await openInvoiceFilingIssue(h.ctx, row, new Date());
    } finally {
      h.ctx.issues.documents.upsert = real;
    }
    expect(upserts).toBe(1);
    await h.runJob("mark-overdue");
    await h.client.query(`UPDATE ${NAMESPACE}.handoffs SET last_emitted_at = now() - interval '2 hours'`);
    await h.runJob("mark-overdue");
    expect(filingIssues()).toHaveLength(1);
  });

  it("attaches the invoice on a replay when the first document write failed", async () => {
    const invoice = await sent();
    const real = h.ctx.issues.documents.upsert;
    let calls = 0;
    h.ctx.issues.documents.upsert = (async (input: Parameters<typeof real>[0]) => {
      if (calls++ === 0) throw new Error("document write failed");
      return real(input);
    }) as typeof real;
    try {
      await pay(invoice.id);
      expect(filingIssues()).toHaveLength(1);
      expect(h.documents.size).toBe(0);
      await openInvoiceFilingIssue(h.ctx, (await getInvoice(h.ctx, invoice.id))!, new Date());
    } finally {
      h.ctx.issues.documents.upsert = real;
    }
    expect(filingIssues()).toHaveLength(1);
    expect(h.documents.get(`${filingIssues()[0]!.id}:invoice`)!.body).toContain(invoice.number);
  });

  it("invoice-pdf returns the same sha256 twice for a paid invoice and rejects a draft", async () => {
    const invoice = await sent();
    await pay(invoice.id);
    type Pdf = { filename: string; mime: string; base64: string; sha256: string; bytes: number };
    const a = await h.call<Pdf>("billing.invoice-pdf", { invoiceId: invoice.id });
    const b = await h.call<Pdf>("billing.invoice-pdf", { invoiceId: invoice.id });
    expect(a.mime).toBe("application/pdf");
    expect(a.filename).toMatch(/\.pdf$/);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(a.bytes).toBe(Buffer.from(a.base64, "base64").length);
    expect(Buffer.from(a.base64, "base64").subarray(0, 4).toString()).toBe("%PDF");
    const d = await draft();
    await expect(h.call("billing.invoice-pdf", { invoiceId: d.id })).rejects.toThrow(/draft/i);
  });

  it("opens nothing for a draft, a sent invoice or a part payment", async () => {
    const draftInvoice = await draft();
    const sentInvoice = await sent();
    await h.call("billing.record-payment", { invoiceId: sentInvoice.id, amountMinor: 50_000, paymentKey: "part" });
    for (const id of [draftInvoice.id, sentInvoice.id]) {
      expect(await openInvoiceFilingIssue(h.ctx, (await getInvoice(h.ctx, id))!, new Date())).toBeNull();
    }
    expect(filingIssues()).toHaveLength(0);
  });

  it("files nothing for a canary client", async () => {
    const invoice = await sent("canary-ct");
    await pay(invoice.id);
    expect((await getInvoice(h.ctx, invoice.id))!.status).toBe("paid");
    expect(filingIssues()).toHaveLength(0);
    expect(h.documents.size).toBe(0);
  });
});
