/**
 * Signed documents become draft invoices, on a real Postgres under the host's SQL rules (audit Q1b-2, Q1b-11).
 *
 * The CRM tells Billing a client signed (`deal.accepted`, and `quote.accepted` when the document names a Billing quote). Billing
 * checks what the CRM cannot (the quote exists, is the same client's and equals the signed amount), then drafts the invoice once:
 * the two events, a repeat delivery and a retry after a crash must never make two. A difference means no invoice and an issue that
 * says exactly what differs. Nothing is ever sent, and the canary client gets its draft without anyone being woken.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { CLAIM_LEASE_MINUTES } from "../src/accepted-store.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const MODULES = "plugin.partnersinbiz.setup.modules.updated";
const CRM_DEAL = "plugin.partnersinbiz.crm.deal.accepted";
const CRM_QUOTE = "plugin.partnersinbiz.crm.quote.accepted";
const DEAL_WON = "plugin.partnersinbiz.crm.deal.won";
const SIGNED_AT = "2026-10-04T08:15:00.000Z";
const AGENT = { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" };

type Row = Record<string, unknown>;
interface Quote {
  id: string;
  number: string;
  totalMinor: number;
}

describe.skipIf(!available)("signed documents become draft invoices (postgres)", () => {
  let h: Harness;
  let docSeq = 0;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    for (const key of [...h.state.keys()]) if (/:pib-(setup|cockpit|cockpit-jobs|done-checks):/.test(key)) h.state.delete(key);
    h.wakeups.length = 0;
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
    await seedClient(h, { id: "co-other", name: "Other Ltd", kind: "company" });
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

  // ── helpers ──────────────────────────────────────────────────────────────

  const newDoc = () => `doc-${++docSeq}-${randomUUID().slice(0, 8)}`;
  const q = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Row[];
  const tool = <T = Record<string, unknown>>(name: string, params: Record<string, unknown>) =>
    h.tools.get(name)!(params, AGENT).then((r) => {
      const result = r as { data?: T; error?: string };
      if (result.error) throw new Error(result.error);
      return result.data as T;
    });
  const workIssue = async (key: string) => (await q(`SELECT issue_id, status, fingerprint FROM ${NAMESPACE}.work_issues WHERE key = $1`, [key]))[0] as { issue_id: string; status: string; fingerprint: string } | undefined;
  const commentsOn = (issueId: string) => h.comments.filter((c) => c.issueId === issueId).map((c) => c.body);
  const invoicesFor = (column: "quote_id" | "deal_id", id: string) =>
    q(`SELECT id, number, status, total_minor, subtotal_minor, vat_minor, deal_id, quote_id, pending_action, prices_include_vat, customer_kind, customer_ref, currency FROM ${NAMESPACE}.invoices WHERE ${column} = $1 ORDER BY created_at, id`, [id]);
  const allInvoices = () => q(`SELECT id FROM ${NAMESPACE}.invoices`);
  const acceptance = async (doc: string) => (await q(`SELECT * FROM ${NAMESPACE}.signed_acceptances WHERE document_id = $1`, [doc]))[0];
  const quoteRow = async (id: string) => (await q(`SELECT status, accepted_at, converted_invoice_id, deal_id FROM ${NAMESPACE}.quotes WHERE id = $1`, [id]))[0]!;
  const lineCount = async (invoiceId: string) => Number((await q(`SELECT count(*)::int AS n FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [invoiceId]))[0]!.n);

  /** A Billing quote for a client with one line of R 1,000.00 excl. VAT: it totals R 1,150.00. */
  async function makeQuote(over: { ref?: string; kind?: "company" | "contact"; dealId?: string | null; unit?: number; status?: "sent" | "declined" | "expired" | "accepted" } = {}): Promise<Quote> {
    const made = await h.call<{ id: string; number: string }>("billing.create-quote", {
      currency: "ZAR",
      customerKind: over.kind ?? "company",
      customerRef: over.ref ?? "co-acme",
      ...(over.dealId === null ? {} : { dealId: over.dealId ?? "deal-1" }),
    });
    const line = await h.call<{ totalMinor: number }>("billing.add-quote-line", { quoteId: made.id, description: "Audit", quantity: 1, unitAmountMinor: over.unit ?? 100_000 });
    if (over.status === "expired") {
      await h.call("billing.set-quote-status", { quoteId: made.id, status: "sent" });
      await h.call("billing.set-quote-status", { quoteId: made.id, status: "expired" });
    } else if (over.status) await h.call("billing.set-quote-status", { quoteId: made.id, status: over.status });
    return { id: made.id, number: made.number, totalMinor: line.totalMinor };
  }

  const dealEvent = (doc: string, quote: Quote | null, over: Record<string, unknown> = {}) => ({
    key: `crm:esign:${doc}:accepted`, documentId: doc, kind: quote ? "quote" : "proposal", title: quote ? `Quote ${quote.number}` : "Proposal: Website rebuild",
    dealId: "deal-1", quoteId: quote?.id ?? null, quoteNumber: quote?.number ?? null, clientKind: "company", clientRef: "co-acme", clientName: "Acme Holdings",
    valueMinor: quote?.totalMinor ?? 115_000, currency: "ZAR", signerName: "Ada Lovelace", signedAt: SIGNED_AT, contentSha256: "a".repeat(64), auditHead: "b".repeat(64), ...over,
  });
  const quoteEvent = (doc: string, quote: Quote, over: Record<string, unknown> = {}) => ({
    key: `crm:esign:${doc}:quote-accepted`, quoteId: quote.id, number: quote.number, dealId: "deal-1", clientKind: "company", clientRef: "co-acme", totalMinor: quote.totalMinor, currency: "ZAR",
    acceptedAt: SIGNED_AT, documentId: doc, contentSha256: "a".repeat(64), auditHead: "b".repeat(64), signerName: "Ada Lovelace", ...over,
  });

  async function closes(issueId: string, actorType: "agent" | "user" = "agent") {
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, entityType: "issue", actorType, actorId: actorType === "agent" ? "agent-am" : "user-1" });
    return h.issues.get(issueId)!;
  }

  // ── a signed quote ───────────────────────────────────────────────────────

  describe("a signed quote", () => {
    it("is accepted and converted into one draft invoice that is never sent, and the CRM is not told again", async () => {
      const quote = await makeQuote({ status: "sent" });
      const doc = newDoc();
      h.emitted.length = 0;
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));

      const invoices = await invoicesFor("quote_id", quote.id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ status: "draft", deal_id: "deal-1", pending_action: null, customer_kind: "company", customer_ref: "co-acme", currency: "ZAR" });
      expect(Number(invoices[0]!.total_minor)).toBe(quote.totalMinor);
      expect(await lineCount(String(invoices[0]!.id))).toBe(1);

      const row = await quoteRow(quote.id);
      expect(row).toMatchObject({ status: "converted", converted_invoice_id: invoices[0]!.id });
      expect(new Date(String(row.accepted_at)).toISOString()).toBe(SIGNED_AT);

      // Nothing went out: no email, no send approval, and the CRM was not told what it told Billing.
      expect(h.emitted.map((e) => e.name)).not.toContain("quote.accepted");
      expect(h.emitted.filter((e) => e.name.startsWith("mail."))).toEqual([]);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event LIKE 'mail.%'`)).toEqual([]);
      expect(await q(`SELECT approval_issue_id FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoices[0]!.id])).toEqual([{ approval_issue_id: null }]);

      expect(await acceptance(doc)).toMatchObject({ status: "drafted", invoice_id: invoices[0]!.id, first_event: "quote.accepted", quote_id: quote.id, canary: false });
    });

    it("a quote never sent from Billing, a sent one, an expired one and one a person already marked accepted are all invoiced", async () => {
      for (const status of [undefined, "sent", "expired", "accepted"] as const) {
        await h.reset();
        h.config.set(COMPANY, { ...SETTINGS });
        await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
        const quote = await makeQuote({ status });
        await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote));
        expect(await invoicesFor("quote_id", quote.id), String(status)).toHaveLength(1);
        expect((await quoteRow(quote.id)).status, String(status)).toBe("converted");
      }
    });

    it("gives the Account Manager one issue with the invoice and the signed document, and nobody is asked to send yet", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      const [invoice] = await invoicesFor("quote_id", quote.id);
      const row = (await workIssue(`billing:signed:${doc}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-am", status: "todo", originId: `billing:signed:${doc}` });
      expect(issue.title).toBe(`Signed: quote ${quote.number} for Acme Holdings: check invoice ${invoice!.number} and ask for approval to send`);
      expect(issue.description).toContain(`invoiceId \`${invoice!.id}\``);
      expect(issue.description).toContain(`Document \`${doc}\``);
      expect(issue.description).toContain("**It is a draft: nothing was sent.**");
      expect(h.wakeups).toContain(row.issue_id);
    });

    it("one signature, one invoice: the two events, a repeat and both at once draft exactly once", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await Promise.all([h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote)), h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote))]);
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote));
      expect(await invoicesFor("quote_id", quote.id)).toHaveLength(1);
      expect(await allInvoices()).toHaveLength(1);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.work_issues WHERE key = $1`, [`billing:signed:${doc}`])).toHaveLength(1);
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Signed:"))).toHaveLength(1);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.signed_acceptances WHERE document_id = $1`, [doc])).toHaveLength(1);
    });

    it("the hourly re-send of a hand-off changes nothing, even after the invoice went out", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      const [invoice] = await invoicesFor("quote_id", quote.id);
      await h.call("billing.mark-sent", { invoiceId: invoice!.id });
      for (let i = 0; i < 3; i += 1) {
        await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
        await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote));
      }
      expect(await allInvoices()).toHaveLength(1);
      expect((await invoicesFor("quote_id", quote.id))[0]).toMatchObject({ status: "sent" });
    });

    it("a quote an agent already converted by hand is not invoiced a second time", async () => {
      const quote = await makeQuote({ status: "accepted" });
      await h.call("billing.convert-quote", { quoteId: quote.id });
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await allInvoices()).toHaveLength(1);
      expect(await acceptance(doc)).toMatchObject({ status: "already_invoiced" });
      expect(String((await acceptance(doc))!.reason)).toContain(`Quote ${quote.number} already has invoice`);
      expect(await workIssue(`billing:signed:${doc}`)).toBeUndefined();
    });

    it("a second signed document for the same quote is not invoiced again", async () => {
      const quote = await makeQuote();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote));
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote));
      expect(await allInvoices()).toHaveLength(1);
    });

    it("adopts the deal the document names when the quote had none, so the money can be traced to the deal", async () => {
      const quote = await makeQuote({ dealId: null });
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote, { dealId: "deal-5" }));
      expect(await invoicesFor("deal_id", "deal-5")).toHaveLength(1);
      expect((await quoteRow(quote.id)).deal_id).toBe("deal-5");
    });

    it("does nothing with Billing switched off, and does it once Billing is on again", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { billing: false }, updatedAt: new Date().toISOString() });
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await allInvoices()).toHaveLength(0);
      expect(await acceptance(doc)).toBeUndefined();
      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { billing: true }, updatedAt: new Date(Date.now() + 1000).toISOString() });
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await allInvoices()).toHaveLength(1);
    });

    it("ignores a hand-off that names no document, and one for another company's quote", async () => {
      const quote = await makeQuote();
      await h.deliver(CRM_QUOTE, COMPANY, { ...quoteEvent(newDoc(), quote), documentId: "" });
      expect(await allInvoices()).toHaveLength(0);
      // The same quote id arriving under another company is not this company's quote: it cannot be found there.
      const other = "22222222-2222-2222-2222-222222222222";
      h.config.set(other, { ...SETTINGS });
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, other, quoteEvent(doc, quote));
      expect(await allInvoices()).toHaveLength(0);
      expect(await acceptance(doc)).toMatchObject({ status: "needs_attention", company_id: other });
      expect(String((await acceptance(doc))!.reason)).toContain("has no quote with id");
    });
  });

  // ── when the signed document and Billing disagree ────────────────────────

  describe("when the signed document and Billing disagree", () => {
    const cases: Array<{ name: string; quote: () => Promise<Quote>; event: (doc: string, quote: Quote) => Record<string, unknown>; says: string[]; unchanged: string }> = [
      { name: "the amount", quote: () => makeQuote(), event: (doc, quote) => quoteEvent(doc, quote, { totalMinor: 100_000 }), says: ["The client signed R 1,000.00, but quote", "totals R 1,150.00", "the quote's total without VAT"], unchanged: "draft" },
      { name: "the currency", quote: () => makeQuote(), event: (doc, quote) => quoteEvent(doc, quote, { currency: "USD" }), says: ["The client signed", "totals R 1,150.00"], unchanged: "draft" },
      { name: "the client", quote: () => makeQuote({ ref: "co-other" }), event: (doc, quote) => quoteEvent(doc, quote), says: ["The document was signed for company:co-acme, but quote", "is for company:co-other"], unchanged: "draft" },
      { name: "the client's kind", quote: () => makeQuote({ kind: "contact", ref: "ct-lumen" }), event: (doc, quote) => quoteEvent(doc, quote, { clientRef: "ct-lumen" }), says: ["signed for company:ct-lumen", "is for contact:ct-lumen"], unchanged: "draft" },
      { name: "the deal", quote: () => makeQuote({ dealId: "deal-9" }), event: (doc, quote) => quoteEvent(doc, quote), says: ["The document belongs to deal deal-1, but quote", "belongs to deal deal-9"], unchanged: "draft" },
      { name: "the quote number", quote: () => makeQuote(), event: (doc, quote) => quoteEvent(doc, quote, { number: "Q-ZZZ-009" }), says: ["The document names quote Q-ZZZ-009, but that quote id is quote"], unchanged: "draft" },
      { name: "a quote that is not there", quote: async () => ({ id: "no-such-quote", number: "Q-ZZZ-001", totalMinor: 115_000 }), event: (doc, quote) => quoteEvent(doc, quote), says: ["Billing has no quote with id no-such-quote", "Check the quote id typed into the document"], unchanged: "" },
      { name: "a quote with no lines", quote: async () => { const made = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "co-acme", dealId: "deal-1" }); return { id: made.id, number: made.number, totalMinor: 0 }; }, event: (doc, quote) => quoteEvent(doc, quote, { totalMinor: 115_000 }), says: ["has no amount yet", "The client signed R 1,150.00, but quote"], unchanged: "draft" },
      { name: "a quote someone marked declined", quote: () => makeQuote({ status: "declined" }), event: (doc, quote) => quoteEvent(doc, quote), says: ["is marked declined in Billing, but the client signed it"], unchanged: "declined" },
    ];

    for (const c of cases) {
      it(`${c.name}: no invoice, the quote is left alone, and the Account Manager is told exactly what differs`, async () => {
        const quote = await c.quote();
        const doc = newDoc();
        h.emitted.length = 0;
        await h.deliver(CRM_QUOTE, COMPANY, c.event(doc, quote));
        expect(await allInvoices()).toEqual([]);
        if (c.unchanged) expect((await quoteRow(quote.id)).status).toBe(c.unchanged);
        const row = await acceptance(doc);
        expect(row).toMatchObject({ status: "needs_attention", invoice_id: null });
        const issue = h.issues.get((await workIssue(`billing:signed:${doc}`))!.issue_id)!;
        expect(issue).toMatchObject({ assigneeAgentId: "agent-am" });
        expect(issue.title).toContain("no invoice drafted");
        for (const text of c.says) expect(issue.description, text).toContain(text);
        expect(String(row!.reason)).toContain(c.says[0]!);
        expect(h.emitted.filter((e) => e.name === "quote.accepted")).toEqual([]);
        expect(h.wakeups).toContain(issue.id);
      });
    }

    it("lists every difference at once", async () => {
      const quote = await makeQuote({ ref: "co-other", dealId: "deal-9" });
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote, { totalMinor: 1 }));
      const issue = h.issues.get((await workIssue(`billing:signed:${doc}`))!.issue_id)!;
      expect(issue.description!.match(/^- The /gm)).toHaveLength(3);
    });

    it("is final: a repeat opens no second issue, and a quote fixed afterwards is not invoiced behind the Account Manager's back", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote, { totalMinor: 100_000 }));
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote, { valueMinor: 100_000 }));
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Signed:"))).toHaveLength(1);
      // The next hourly re-send arrives with the amount now equal to the quote's total: still nothing.
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await allInvoices()).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "needs_attention" });
    });

    it("a signed document with an amount and neither a deal nor a quote cannot be matched to anything", async () => {
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null, { dealId: null }));
      expect(await allInvoices()).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "needs_attention" });
      const issue = h.issues.get((await workIssue(`billing:signed:${doc}`))!.issue_id)!;
      expect(issue.description).toContain("linked to neither a deal nor a Billing quote");
    });
  });

  // ── a deal with no Billing quote ─────────────────────────────────────────

  describe("a signed deal with no Billing quote", () => {
    it("drafts one line for exactly the signed amount, VAT included, linked to the deal, and never sends it", async () => {
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null, { valueMinor: 115_000 }));
      const [invoice] = await invoicesFor("deal_id", "deal-1");
      expect(invoice).toMatchObject({ status: "draft", quote_id: null, prices_include_vat: true, customer_kind: "company", customer_ref: "co-acme", pending_action: null });
      expect(Number(invoice!.total_minor)).toBe(115_000);
      expect(Number(invoice!.subtotal_minor)).toBe(100_000);
      expect(Number(invoice!.vat_minor)).toBe(15_000);
      const lines = await q(`SELECT description, quantity, unit_amount_minor FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [invoice!.id]);
      expect(lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit: Number(l.unit_amount_minor) }))).toEqual([{ description: "Proposal: Website rebuild", quantity: 1, unit: 115_000 }]);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event LIKE 'mail.%'`)).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "drafted", invoice_id: invoice!.id, first_event: "deal.accepted" });
      const issue = h.issues.get((await workIssue(`billing:signed:${doc}`))!.issue_id)!;
      expect(issue.description).toContain("The document named no Billing quote, so the invoice has one line");
    });

    it("a business that charges no VAT is invoiced the same amount", async () => {
      h.config.set(COMPANY, { ...SETTINGS, vatRegistered: false });
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null, { valueMinor: 80_000 }));
      const [invoice] = await invoicesFor("deal_id", "deal-1");
      expect(Number(invoice!.total_minor)).toBe(80_000);
      expect(Number(invoice!.vat_minor)).toBe(0);
    });

    it("the same signature twice, or both events, make one invoice", async () => {
      const doc = newDoc();
      await Promise.all([h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null)), h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null))]);
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null));
      expect(await allInvoices()).toHaveLength(1);
    });

    it("a deal Billing already invoiced is not invoiced again", async () => {
      const made = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: "co-acme", dealId: "deal-1" });
      await h.call("billing.add-line", { invoiceId: made.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null));
      expect(await allInvoices()).toHaveLength(1);
      expect(await acceptance(doc)).toMatchObject({ status: "already_invoiced", invoice_id: made.id });
      expect(await workIssue(`billing:signed:${doc}`)).toBeUndefined();
    });

    it("a deal that has a quote the document does not name is not guessed at", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null, { valueMinor: 115_000 }));
      expect(await allInvoices()).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "needs_attention" });
      const issue = h.issues.get((await workIssue(`billing:signed:${doc}`))!.issue_id)!;
      expect(issue.description).toContain(`${quote.number}, draft, R 1,150.00`);
      expect(issue.description).toContain("will not guess which one the client agreed to");
    });

    it("a document with no amount has nothing to invoice and opens no issue", async () => {
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null, { valueMinor: null }));
      expect(await allInvoices()).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "skipped" });
      expect(await workIssue(`billing:signed:${doc}`)).toBeUndefined();
    });

    it("a document with the deal's quote named is the quote path, whichever event comes first", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote));
      expect(await invoicesFor("quote_id", quote.id)).toHaveLength(1);
      expect(await acceptance(doc)).toMatchObject({ status: "drafted", first_event: "deal.accepted" });
    });
  });

  // ── the won-deal issue ───────────────────────────────────────────────────

  describe("the won-deal issue", () => {
    const won = { key: "crm:deal:deal-1:won", dealId: "deal-1", title: "Website rebuild", valueMinor: 115_000, currency: "ZAR", clientKind: "company", clientRef: "co-acme", clientName: "Acme Holdings", contactEmail: null, firstWin: false, wonAt: SIGNED_AT };

    it("is closed when Billing drafted the invoice itself, so nobody drafts a second one", async () => {
      await h.deliver(DEAL_WON, COMPANY, won);
      const dealIssue = (await workIssue("billing:deal-won:deal-1"))!;
      expect(h.issues.get(dealIssue.issue_id)!.status).toBe("todo");
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(h.issues.get(dealIssue.issue_id)!.status).toBe("done");
      const [invoice] = await invoicesFor("quote_id", quote.id);
      expect(commentsOn(dealIssue.issue_id).join("\n")).toContain(`Billing drafted invoice ${invoice!.number} from the document the client signed`);
      expect(commentsOn(dealIssue.issue_id).join("\n")).toContain("Do not draft another invoice");
    });

    it("is not opened at all when the signature came first", async () => {
      const quote = await makeQuote();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote));
      await h.deliver(DEAL_WON, COMPANY, won);
      expect(await workIssue("billing:deal-won:deal-1")).toBeUndefined();
    });

    it("stays open when nothing was drafted, because a difference stopped it", async () => {
      await h.deliver(DEAL_WON, COMPANY, won);
      const quote = await makeQuote();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote, { totalMinor: 1 }));
      expect(h.issues.get((await workIssue("billing:deal-won:deal-1"))!.issue_id)!.status).toBe("todo");
    });
  });

  // ── the canary ───────────────────────────────────────────────────────────

  describe("the canary client", () => {
    beforeEach(async () => {
      await seedClient(h, { id: "canary-ab12cd34", name: "PiB Canary Co", kind: "company" });
    });

    it("gets its draft invoice, but no issue is opened, nobody is woken and nothing is posted or sent", async () => {
      const made = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "canary-ab12cd34", customerName: "PiB Canary Co", dealId: "deal-c" });
      const line = await h.call<{ totalMinor: number }>("billing.add-quote-line", { quoteId: made.id, description: "Canary service", quantity: 1, unitAmountMinor: 100_000 });
      const quote = { id: made.id, number: made.number, totalMinor: line.totalMinor };
      const doc = newDoc();
      h.wakeups.length = 0;
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote, { clientRef: "canary-ab12cd34", dealId: "deal-c" }));
      const invoices = await invoicesFor("quote_id", quote.id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ status: "draft", pending_action: null });
      expect(await acceptance(doc)).toMatchObject({ status: "drafted", canary: true });
      expect(await workIssue(`billing:signed:${doc}`)).toBeUndefined();
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Signed:"))).toEqual([]);
      expect(h.wakeups).toEqual([]);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event IN ('mail.send.requested', 'ledger.post.requested')`)).toEqual([]);
    });

    it("a mismatch for the canary is recorded but opens no issue either", async () => {
      const made = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: "canary-ab12cd34", customerName: "PiB Canary Co" });
      await h.call("billing.add-quote-line", { quoteId: made.id, description: "Canary service", quantity: 1, unitAmountMinor: 100_000 });
      const doc = newDoc();
      h.wakeups.length = 0;
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, { id: made.id, number: made.number, totalMinor: 5 }, { clientRef: "canary-ab12cd34", dealId: null }));
      expect(await allInvoices()).toEqual([]);
      expect(await acceptance(doc)).toMatchObject({ status: "needs_attention", canary: true });
      expect(await workIssue(`billing:signed:${doc}`)).toBeUndefined();
      expect(h.wakeups).toEqual([]);
    });
  });

  // ── a crash half way ─────────────────────────────────────────────────────

  describe("when the worker stops half way", () => {
    it("a retry finishes the half-made draft: the same invoice, its lines once, the quote converted, and no second invoice", async () => {
      const quote = await makeQuote({ status: "sent" });
      const doc = newDoc();
      const real = h.ctx.db.execute;
      let failed = false;
      (h.ctx.db as { execute: typeof real }).execute = async (sql: string, params?: unknown[]) => {
        if (!failed && /INSERT INTO .*invoice_lines/.test(sql)) {
          failed = true;
          throw new Error("worker stopped");
        }
        return real(sql, params);
      };
      try {
        await expect(h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote))).rejects.toThrow("worker stopped");
      } finally {
        (h.ctx.db as { execute: typeof real }).execute = real;
      }
      // The invoice row exists with no lines, the quote is accepted but not converted, and the claim says why it is waiting.
      const half = await acceptance(doc);
      expect(half).toMatchObject({ status: "processing", last_error: "worker stopped" });
      const [stopped] = await invoicesFor("quote_id", quote.id);
      expect(stopped!.id).toBe(half!.invoice_id);
      expect(await lineCount(String(stopped!.id))).toBe(0);
      expect((await quoteRow(quote.id)).status).toBe("accepted");

      // The next delivery inside the lease leaves it alone (another run may still be working on it)...
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await lineCount(String(stopped!.id))).toBe(0);
      // ...and once the lease is over it finishes the same invoice.
      await h.client.query(`UPDATE ${NAMESPACE}.signed_acceptances SET claimed_at = now() - interval '${CLAIM_LEASE_MINUTES + 5} minutes' WHERE document_id = $1`, [doc]);
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, quote));
      const invoices = await invoicesFor("quote_id", quote.id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]!.id).toBe(stopped!.id);
      expect(await lineCount(String(stopped!.id))).toBe(1);
      expect(Number(invoices[0]!.total_minor)).toBe(quote.totalMinor);
      expect(await quoteRow(quote.id)).toMatchObject({ status: "converted", converted_invoice_id: stopped!.id });
      expect(await acceptance(doc)).toMatchObject({ status: "drafted", last_error: null });
      expect(await allInvoices()).toHaveLength(1);
    });

    it("a stopped deal-only draft is finished the same way", async () => {
      const doc = newDoc();
      const real = h.ctx.db.execute;
      let failed = false;
      (h.ctx.db as { execute: typeof real }).execute = async (sql: string, params?: unknown[]) => {
        if (!failed && /INSERT INTO .*invoice_lines/.test(sql)) {
          failed = true;
          throw new Error("worker stopped");
        }
        return real(sql, params);
      };
      try {
        await expect(h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null))).rejects.toThrow("worker stopped");
      } finally {
        (h.ctx.db as { execute: typeof real }).execute = real;
      }
      await h.client.query(`UPDATE ${NAMESPACE}.signed_acceptances SET claimed_at = now() - interval '${CLAIM_LEASE_MINUTES + 5} minutes' WHERE document_id = $1`, [doc]);
      await h.deliver(CRM_DEAL, COMPANY, dealEvent(doc, null));
      const invoices = await invoicesFor("deal_id", "deal-1");
      expect(invoices).toHaveLength(1);
      expect(await lineCount(String(invoices[0]!.id))).toBe(1);
      expect(Number(invoices[0]!.total_minor)).toBe(115_000);
      expect(await acceptance(doc)).toMatchObject({ status: "drafted" });
    });

    it("a stale claim that never started is taken over and keeps the invoice id it chose", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      const planned = randomUUID();
      await h.client.query(
        `INSERT INTO ${NAMESPACE}.signed_acceptances (company_id, document_id, status, first_event, quote_id, invoice_id, claimed_at) VALUES ($1, $2, 'processing', 'quote.accepted', $3, $4, now() - interval '1 hour')`,
        [COMPANY, doc, quote.id, planned],
      );
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect((await invoicesFor("quote_id", quote.id)).map((i) => i.id)).toEqual([planned]);
    });

    it("a live claim is respected: a delivery while another run holds it makes nothing", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.client.query(`INSERT INTO ${NAMESPACE}.signed_acceptances (company_id, document_id, status, first_event, quote_id, invoice_id) VALUES ($1, $2, 'processing', 'deal.accepted', $3, $4)`, [COMPANY, doc, quote.id, randomUUID()]);
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      expect(await allInvoices()).toEqual([]);
    });
  });

  // ── the done check ───────────────────────────────────────────────────────

  describe("closing the issue", () => {
    async function drafted() {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote));
      const [invoice] = await invoicesFor("quote_id", quote.id);
      return { quote, doc, invoice: invoice!, issueId: (await workIssue(`billing:signed:${doc}`))!.issue_id };
    }

    it("is reopened by the check while the invoice has no send request, and passes once it is asked to send", async () => {
      const { invoice, issueId } = await drafted();
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain(`Invoice ${invoice.number} (R 1,150.00, invoiceId \`${invoice.id}\`), drafted from the document the client signed, has no send request yet`);
      await tool("request-invoice-send", { invoiceId: invoice.id });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("passes when an invoice that must not go out is explained with a note, or was cancelled", async () => {
      const a = await drafted();
      await tool("log-follow-up", { invoiceId: a.invoice.id, note: "Owner: the client wants it split in two; I will draft both." });
      expect((await closes(a.issueId)).status).toBe("done");
      const b = await drafted();
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'cancelled' WHERE id = $1`, [b.invoice.id]);
      expect((await closes(b.issueId)).status).toBe("done");
    });

    it("a person's close is never checked", async () => {
      const { issueId } = await drafted();
      expect((await closes(issueId, "user")).status).toBe("done");
    });

    it("after a difference it is reopened until an invoice exists for the quote, or a note says why none will", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote, { totalMinor: 100_000 }));
      const issueId = (await workIssue(`billing:signed:${doc}`))!.issue_id;
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain(`No invoice was drafted for the signed document \`${doc}\` and none exists yet for quoteId \`${quote.id}\``);
      // Fixed the way the issue says: accepted and converted by hand.
      await h.call("billing.set-quote-status", { quoteId: quote.id, status: "accepted" });
      await h.call("billing.convert-quote", { quoteId: quote.id });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("after a difference a note on the quote or the deal also passes", async () => {
      const quote = await makeQuote();
      const doc = newDoc();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(doc, quote, { totalMinor: 100_000 }));
      const issueId = (await workIssue(`billing:signed:${doc}`))!.issue_id;
      await tool("log-follow-up", { quoteId: quote.id, note: "Owner: the client will sign again with the right amount." });
      expect((await closes(issueId)).status).toBe("done");
    });
  });

  // ── the Cockpit ──────────────────────────────────────────────────────────

  describe("Cockpit health", () => {
    const route = async (): Promise<CockpitSnapshot> => {
      const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId: COMPANY, headers: {} } as PluginApiRequestInput);
      return res.body as CockpitSnapshot;
    };

    it("says nothing is wrong while every signature has been handled", async () => {
      const quote = await makeQuote();
      await h.deliver(CRM_QUOTE, COMPANY, quoteEvent(newDoc(), quote));
      expect((await route()).health.find((x) => x.key === "signed:stuck")).toMatchObject({ status: "ok" });
    });

    it("warns about a signature whose invoice could not be drafted for hours, with the reason and what to do", async () => {
      const doc = newDoc();
      await h.client.query(`INSERT INTO ${NAMESPACE}.signed_acceptances (company_id, document_id, status, first_event, last_error, created_at, claimed_at) VALUES ($1, $2, 'processing', 'quote.accepted', 'Billing does not know the client yet', now() - interval '5 hours', now() - interval '5 hours')`, [COMPANY, doc]);
      const item = (await route()).health.find((x) => x.key === "signed:stuck")!;
      expect(item).toMatchObject({ status: "warn", title: "A signed document has no invoice draft" });
      expect(item.detail).toContain(doc);
      expect(item.detail).toContain("Billing does not know the client yet");
      expect(item.fix).toBeTruthy();
    });

    it("does not warn about one that is only a few minutes old", async () => {
      await h.client.query(`INSERT INTO ${NAMESPACE}.signed_acceptances (company_id, document_id, status, first_event) VALUES ($1, $2, 'processing', 'quote.accepted')`, [COMPANY, newDoc()]);
      expect((await route()).health.find((x) => x.key === "signed:stuck")).toMatchObject({ status: "ok" });
    });
  });
});
