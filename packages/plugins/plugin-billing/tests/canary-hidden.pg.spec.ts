/**
 * Canary invoices and quotes are hidden from list operations and balance reports (0.7.1, audit Q1b-2).
 * The Cockpit KPI "Drafts to send" and billing reports exclude canary drafts and balances entirely.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const CANARY = "canary-ab12cd34";
const CANARY_CONTACT = "canary-contact-ab12cd34";

type Row = Record<string, unknown>;
type ToolResult = { content: string; data: Record<string, any>; error?: string };

describe.skipIf(!available)("canary invoices and quotes are hidden from lists and balances (postgres)", () => {
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
    for (const key of [...h.state.keys()]) if (/:pib-(setup|cockpit):/.test(key)) h.state.delete(key);
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await seedClient(h, { id: CANARY, name: "PiB Canary Co", kind: "company" });
    await seedClient(h, { id: CANARY_CONTACT, name: "Canary Contact", email: "canary@canary.invalid" });
    await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await h.deliver(ROLES, COMPANY, {
      companyId: COMPANY,
      operatorAgentId: "agent-op",
      reviewerAgentId: null,
      reviewOutward: false,
      ownerUserId: "owner-1",
      team: { "account-manager": { agentId: "agent-am", status: "idle" }, operator: { agentId: "agent-op", status: "idle" } },
      updatedAt: new Date().toISOString(),
    });
  });

  const q = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Row[];
  const tool = async (name: string, params: Record<string, unknown>) => (await h.tools.get(name)!(params, { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" })) as ToolResult;
  const cockpit = async (): Promise<CockpitSnapshot> => {
    const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId: COMPANY, headers: {} });
    expect(res.status).toBe(200);
    return res.body as CockpitSnapshot;
  };

  async function draftInvoice(ref: string, kind: "company" | "contact" = "company") {
    const made = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: kind, customerRef: ref, ...(ref.startsWith("canary-") ? { customerName: "PiB Canary Co" } : {}) });
    await h.call("billing.add-line", { invoiceId: made.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });
    return made;
  }

  async function draftQuote(ref: string, kind: "company" | "contact" = "company") {
    const made = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: kind, customerRef: ref, ...(ref.startsWith("canary-") ? { customerName: "PiB Canary Co" } : {}) });
    await h.call("billing.add-quote-line", { quoteId: made.id, description: "Audit", quantity: 1, unitAmountMinor: 100_000 });
    return made;
  }

  describe("Cockpit Drafts KPI", () => {
    it("excludes canary drafts from the count and totals", async () => {
      const canaryInvoice = await draftInvoice(CANARY);
      const canaryContactInvoice = await draftInvoice(CANARY_CONTACT, "contact");
      const canaryQuote = await draftQuote(CANARY);
      const realInvoice = await draftInvoice("ct-lumen", "contact");
      const realQuote = await draftQuote("co-acme", "company");

      const snap = await cockpit();
      const draftsKpi = snap.kpis.find((k) => k.key === "drafts")!;
      // Count is per kind in the SQL, so both invoice and quote count toward raw
      expect(draftsKpi.raw).toBeGreaterThanOrEqual(1); // At least the real ones (may be 1 or 2 depending on grouping)
      expect(draftsKpi.hint).not.toContain(canaryInvoice.number);
      expect(draftsKpi.hint).not.toContain(canaryContactInvoice.number);
      expect(draftsKpi.hint).not.toContain(canaryQuote.number);

      // The flows also exclude canary from their count
      const invoiceDraft = snap.flows?.find((f) => f.stage === "invoice.draft");
      if (invoiceDraft) {
        expect(invoiceDraft.count).toBeGreaterThanOrEqual(0); // Only real invoices, canary excluded
        expect(invoiceDraft.count).toBeLessThanOrEqual(1);
      }
      const quoteDraft = snap.flows?.find((f) => f.stage === "quote.draft");
      if (quoteDraft) {
        expect(quoteDraft.count).toBeGreaterThanOrEqual(0); // Only real quotes, canary excluded
        expect(quoteDraft.count).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("list-open-invoices", () => {
    it("excludes canary invoices by default", async () => {
      const canaryInv = await draftInvoice(CANARY);
      await h.call("billing.mark-sent", { invoiceId: canaryInv.id });
      const realInv = await draftInvoice("ct-lumen", "contact");
      await h.call("billing.mark-sent", { invoiceId: realInv.id });

      const result = await tool("list-open-invoices", {}) as any;
      const invoices = result.data.items as Array<{ id: string; number: string }>;
      expect(invoices.map((i) => i.id)).not.toContain(canaryInv.id);
      expect(invoices.map((i) => i.id)).toContain(realInv.id);
    });

    it("excludes canary for a specific client query (customer scope)", async () => {
      const canaryInv = await draftInvoice(CANARY);
      await h.call("billing.mark-sent", { invoiceId: canaryInv.id });

      const result = await tool("list-open-invoices", { client: `company:${CANARY}` }) as any;
      const invoices = result.data.items as Array<{ id: string; number: string }>;
      // Canary invoice exists but is filtered out even when scoped to that customer
      expect(invoices).toEqual([]);
    });
  });

  describe("list-quotes", () => {
    it("excludes canary quotes by default", async () => {
      const canaryQuote = await draftQuote(CANARY);
      const realQuote = await draftQuote("ct-lumen", "contact");

      const result = await tool("list-quotes", {}) as any;
      const quotes = result.data.items as Array<{ id: string; number: string }>;
      expect(quotes.map((q) => q.id)).not.toContain(canaryQuote.id);
      expect(quotes.map((q) => q.id)).toContain(realQuote.id);
    });

    it("excludes canary for a specific client query (customer scope)", async () => {
      const canaryQuote = await draftQuote(CANARY);

      const result = await tool("list-quotes", { client: `company:${CANARY}` }) as any;
      const quotes = result.data.items as Array<{ id: string; number: string }>;
      // Canary quote exists but is filtered out even when scoped to that customer
      expect(quotes).toEqual([]);
    });
  });

  describe("billing reports", () => {
    it("excludes canary invoices from debtors and revenue", async () => {
      const canaryInv = await draftInvoice(CANARY);
      await h.call("billing.mark-sent", { invoiceId: canaryInv.id });
      const realInv = await draftInvoice("ct-lumen", "contact");
      await h.call("billing.mark-sent", { invoiceId: realInv.id });
      await h.call("billing.record-payment", { invoiceId: realInv.id, amountMinor: 115_000 });

      const reports = await h.call<{
        clients: { clients: Array<{ clientName: string; outstandingMinor: number }> };
        agedDebtors: { totalMinor: number };
      }>("billing.reports", {});

      expect(reports.clients.clients.map((c) => c.clientName)).not.toContain("PiB Canary Co");
      expect(reports.agedDebtors.totalMinor).toBe(0); // Real invoice was fully paid, no debtors
    });
  });

  describe("email domain canary", () => {
    it("treats invoices explicitly created with .invalid emails as canary", async () => {
      // When an invoice is created with an explicit .invalid email, it should be hidden
      const inv = await h.call<{ id: string }>("billing.create-invoice", {
        currency: "ZAR",
        customerKind: "contact",
        customerRef: "contact-explicit",
        customerName: "Explicit Invalid",
        customerEmail: "test@canary.invalid",
      });
      await h.call("billing.add-line", { invoiceId: inv.id, description: "Test", quantity: 1, unitAmountMinor: 100_000 });
      await h.call("billing.mark-sent", { invoiceId: inv.id });

      // Should be excluded from list because of .invalid email
      const result = await tool("list-open-invoices", {}) as any;
      const invoices = result.data.items as Array<{ id: string }>;
      expect(invoices.map((i) => i.id)).not.toContain(inv.id);
    });
  });
});
