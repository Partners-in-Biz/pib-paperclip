/**
 * A paid invoice is filed to Drive through a filing issue for the Account Manager (PAR-4111): one issue per
 * invoice, the printable invoice as the `invoice` document, nothing for drafts, unpaid or canary clients.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { getInvoice } from "../src/db.js";
import { openInvoiceFilingIssue } from "../src/filing.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

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
    expect(body).toContain("`Clients/<Company> (<Contact>)/Contracts & Quotes/`");
    expect(body).toMatch(new RegExp(`\\d{4}-\\d{2}-\\d{2} Lumen Digital invoice ${invoice.number} SEO sprint v01\\.html`));
    expect(body).toContain("pib-drive-saving");
    expect(body).toContain("Drive file name in your closing comment");
    expect(body).not.toMatch(/https?:\/\//);
    const doc = h.documents.get(`${issue!.id}:invoice`)!;
    expect(doc.format).toBe("markdown");
    expect(doc.body).toContain(invoice.number);
    expect(doc.body).toContain("1,150.00");
    expect(doc.body).toContain("<html");
  });

  it("does not open a second issue when the paid hand-off is replayed", async () => {
    const invoice = await sent();
    await pay(invoice.id);
    const row = (await getInvoice(h.ctx, invoice.id))!;
    await openInvoiceFilingIssue(h.ctx, row, new Date());
    await h.runJob("mark-overdue");
    await h.client.query(`UPDATE ${NAMESPACE}.handoffs SET last_emitted_at = now() - interval '2 hours'`);
    await h.runJob("mark-overdue");
    expect(filingIssues()).toHaveLength(1);
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
