/**
 * Billing removes all canary invoices and quotes when the CRM emits company.deleted
 * for a canary company (PAR-4450).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const COMPANY_DELETED_EVENT = "plugin.partnersinbiz.crm.company.deleted";

describe.skipIf(!available)("canary cleanup (postgres)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
    // registerCanaryCleanup is already registered in plugin.definition.setup()
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, SETTINGS);
    await seedClient(h, { id: "canary-ab12cd34", name: "PiB Canary Co", kind: "company" });
    await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
  });

  const q = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Record<string, unknown>[];
  const AGENT = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "p" };

  const tool = async (name: string, params: Record<string, unknown>) =>
    (await h.tools.get(name)!(params, AGENT)) as { data?: Record<string, unknown>; error?: string };

  it("removes canary invoices, quotes and their related records when company.deleted is emitted", async () => {
    // Create canary invoices and quotes with lines
    const canaryInv1 = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "canary-ab12cd34",
      customerName: "PiB Canary Co",
    });
    const canaryInvId = (canaryInv1.data as any).id;
    await tool("add-line", { invoiceId: canaryInvId, description: "Work", quantity: 1, unitAmountMinor: 100_000 });
    await tool("add-line", { invoiceId: canaryInvId, description: "More", quantity: 2, unitAmountMinor: 50_000 });

    const canaryQuote1 = await tool("create-quote", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "canary-ab12cd34",
      customerName: "PiB Canary Co",
    });
    const canaryQuoteId = (canaryQuote1.data as any).id;
    await tool("add-quote-line", { quoteId: canaryQuoteId, description: "Service", quantity: 1, unitAmountMinor: 200_000 });

    // Create non-canary documents (control)
    const realInv = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "co-acme",
      customerName: "Acme Holdings",
    });
    const realInvId = (realInv.data as any).id;
    await tool("add-line", { invoiceId: realInvId, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

    const realQuote = await tool("create-quote", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "co-acme",
      customerName: "Acme Holdings",
    });
    const realQuoteId = (realQuote.data as any).id;
    await tool("add-quote-line", { quoteId: realQuoteId, description: "Service", quantity: 1, unitAmountMinor: 200_000 });

    // Verify setup
    let canaryInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'canary-ab12cd34'`);
    let canaryQuotes = await q(`SELECT id FROM ${NAMESPACE}.quotes WHERE customer_ref = 'canary-ab12cd34'`);
    let canaryInvoiceLines = await q(`SELECT id FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [canaryInvId]);
    let canaryQuoteLines = await q(`SELECT id FROM ${NAMESPACE}.quote_lines WHERE quote_id = $1`, [canaryQuoteId]);
    expect(canaryInvoices).toHaveLength(1);
    expect(canaryQuotes).toHaveLength(1);
    expect(canaryInvoiceLines).toHaveLength(2);
    expect(canaryQuoteLines).toHaveLength(1);

    // Emit company.deleted for canary
    await h.deliver(COMPANY_DELETED_EVENT, COMPANY, {
      key: "company:canary-ab12cd34:deleted",
      id: "canary-ab12cd34",
      name: "PiB Canary Co",
      deletedAt: new Date().toISOString(),
    });

    // Verify canary documents are deleted
    canaryInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'canary-ab12cd34'`);
    canaryQuotes = await q(`SELECT id FROM ${NAMESPACE}.quotes WHERE customer_ref = 'canary-ab12cd34'`);
    canaryInvoiceLines = await q(`SELECT id FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [canaryInvId]);
    canaryQuoteLines = await q(`SELECT id FROM ${NAMESPACE}.quote_lines WHERE quote_id = $1`, [canaryQuoteId]);
    expect(canaryInvoices).toHaveLength(0);
    expect(canaryQuotes).toHaveLength(0);
    expect(canaryInvoiceLines).toHaveLength(0);
    expect(canaryQuoteLines).toHaveLength(0);

    // Verify non-canary documents remain
    const realInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'co-acme'`);
    const realQuotes = await q(`SELECT id FROM ${NAMESPACE}.quotes WHERE customer_ref = 'co-acme'`);
    const realInvoiceLines = await q(`SELECT id FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [realInvId]);
    const realQuoteLines = await q(`SELECT id FROM ${NAMESPACE}.quote_lines WHERE quote_id = $1`, [realQuoteId]);
    expect(realInvoices).toHaveLength(1);
    expect(realQuotes).toHaveLength(1);
    expect(realInvoiceLines).toHaveLength(1);
    expect(realQuoteLines).toHaveLength(1);
  });

  it("removes work_issues created for canary invoices when company.deleted is emitted", async () => {
    // Create canary invoice
    const canaryInv = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "canary-ab12cd34",
      customerName: "PiB Canary Co",
    });
    const canaryInvId = (canaryInv.data as any).id;
    await tool("add-line", { invoiceId: canaryInvId, description: "Work", quantity: 1, unitAmountMinor: 100_000 });

    // Manually create a work_issue for the canary invoice (simulating what might be created during processing)
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.work_issues (id, company_id, kind, subject_id, title, actor_id, actor_kind, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
      ["wi-canary-1", COMPANY, "invoice", canaryInvId, "Test Work Issue", "actor-1", "agent"],
    );

    // Verify work_issue exists
    let workIssues = await q(`SELECT id FROM ${NAMESPACE}.work_issues WHERE kind = 'invoice' AND subject_id = $1`, [canaryInvId]);
    expect(workIssues).toHaveLength(1);

    // Emit company.deleted for canary
    await h.deliver(COMPANY_DELETED_EVENT, COMPANY, {
      key: "company:canary-ab12cd34:deleted",
      id: "canary-ab12cd34",
      name: "PiB Canary Co",
      deletedAt: new Date().toISOString(),
    });

    // Verify work_issue is deleted
    workIssues = await q(`SELECT id FROM ${NAMESPACE}.work_issues WHERE kind = 'invoice' AND subject_id = $1`, [canaryInvId]);
    expect(workIssues).toHaveLength(0);
  });

  it("does not delete non-canary documents when company.deleted is emitted for a non-canary id", async () => {
    // Create a canary and a real document
    const canaryInv = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "canary-ab12cd34",
      customerName: "PiB Canary Co",
    });
    const canaryInvId = (canaryInv.data as any).id;

    const realInv = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "co-acme",
      customerName: "Acme Holdings",
    });
    const realInvId = (realInv.data as any).id;

    // Emit company.deleted for a non-canary id
    await h.deliver(COMPANY_DELETED_EVENT, COMPANY, {
      key: "company:co-acme:deleted",
      id: "co-acme",
      name: "Acme Holdings",
      deletedAt: new Date().toISOString(),
    });

    // Verify both invoices remain - billing cleanup only handles canary companies
    const canaryInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'canary-ab12cd34'`);
    const realInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'co-acme'`);
    expect(canaryInvoices).toHaveLength(1);
    expect(realInvoices).toHaveLength(1); // not deleted, canary cleanup only handles canary companies
  });

  it("ignores empty or missing payload", async () => {
    const canaryInv = await tool("create-invoice", {
      currency: "ZAR",
      customerKind: "company",
      customerRef: "canary-ab12cd34",
      customerName: "PiB Canary Co",
    });
    const canaryInvId = (canaryInv.data as any).id;

    // Emit with empty payload
    await h.deliver(COMPANY_DELETED_EVENT, COMPANY, {});

    // Verify nothing deleted
    const canaryInvoices = await q(`SELECT id FROM ${NAMESPACE}.invoices WHERE customer_ref = 'canary-ab12cd34'`);
    expect(canaryInvoices).toHaveLength(1);
  });
});
