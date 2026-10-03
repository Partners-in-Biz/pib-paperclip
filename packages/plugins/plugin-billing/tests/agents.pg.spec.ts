/**
 * What agents may do in Billing, against a real Postgres: ask for sends
 * (invoice, quote, reminder), ask a person for money (payment, credit note,
 * payment check), and the hand-offs a sale produces (quote.accepted with the
 * deal, invoice.paid). A person's "done" applies each; an agent's is undone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { agentContext, COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const RUN = { agentId: "agent-am", runId: "run-1", companyId: COMPANY, projectId: "p" };

type ToolResult = { content: string; data: Record<string, any>; error?: string };

describe.skipIf(!available)("billing agent requests (postgres)", () => {
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
    for (const key of [...h.state.keys()]) if (/:pib-(setup|cockpit|cockpit-jobs):/.test(key)) h.state.delete(key);
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
  });

  const tool = async (name: string, params: Record<string, unknown>) => (await h.tools.get(name)!(params, RUN)) as ToolResult;
  const mails = async () => (await h.client.query(`SELECT key, payload FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested' ORDER BY created_at`)).rows as Array<{ key: string; payload: any }>;
  const handoffs = (name: string) => h.emitted.filter((e) => e.name === name).map((e) => e.payload as Record<string, any>);
  const done = async (issueId: string, actorType: "user" | "agent" = "user") => {
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, actorType, actorId: actorType === "user" ? "user-9" : "agent-rev" });
  };
  const cancel = async (issueId: string) => {
    h.issues.get(issueId)!.status = "cancelled";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, actorType: "user", actorId: "user-9" });
  };
  const commentsOn = (issueId: string) => h.comments.filter((c) => c.issueId === issueId).map((c) => c.body);

  async function draft(unitAmountMinor = 100_000, extra: Record<string, unknown> = {}) {
    const invoice = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", ...extra })).data as { id: string; number: string };
    await tool("add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor });
    return invoice;
  }

  async function sent(unitAmountMinor = 100_000) {
    const invoice = await draft(unitAmountMinor);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  async function setRoles(input: { reviewerAgentId?: string | null; reviewOutward?: boolean; accountManager?: string | null; ownerUserId?: string | null }) {
    await h.deliver(ROLES, COMPANY, {
      companyId: COMPANY,
      operatorAgentId: null,
      reviewerAgentId: input.reviewerAgentId ?? null,
      reviewOutward: input.reviewOutward ?? false,
      ownerUserId: input.ownerUserId === undefined ? "owner-1" : input.ownerUserId,
      team: input.accountManager ? { "account-manager": { agentId: input.accountManager, status: "idle" } } : {},
      updatedAt: new Date().toISOString(),
    });
  }

  describe("send requests", () => {
    it("lets an agent ask for an invoice send once; a person's done emails it", async () => {
      const invoice = await draft();
      const asked = await tool("request-invoice-send", { invoiceId: invoice.id });
      expect(asked.error).toBeUndefined();
      expect(asked.content).toBe("Send approval issue opened for a person");
      expect(asked.data).toMatchObject({ invoiceId: invoice.id, number: "LUM-001", pendingAction: "send", already: false, recipients: [{ email: "ap@lumen.test", name: "Lumen Digital" }] });
      expect(asked.data.issue).toMatch(/^\/PIB\/issues\/PIB-\d+$/);
      const issue = h.issues.get(asked.data.issueId)!;
      // A draft's number means nothing to the person yet: the title names the client and the amount.
      expect(issue).toMatchObject({ assigneeUserId: "user-9", title: "Approve sending invoice to Lumen Digital (R 1,150.00)" });
      expect(issue.description).toContain("An agent (agent:agent-am) asks to send the draft invoice for R 1,150.00 to Lumen Digital");
      expect(issue.description).toContain("/PIB/billing?tab=invoices&client=contact:ct-lumen");

      const again = await tool("request-invoice-send", { invoiceId: invoice.id });
      expect(again.data).toMatchObject({ issueId: asked.data.issueId, already: true });
      expect(again.content).toBe("A send approval is already open for this invoice");
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Approve sending invoice"))).toHaveLength(1);

      expect(await mails()).toHaveLength(0);
      await done(asked.data.issueId);
      expect((await mails()).map((m) => m.key)).toEqual([`billing:mail:invoice:${invoice.id}:1`]);
    });

    it("renames an open send approval from the old draft-number title, never one a person changed", async () => {
      const invoice = await draft();
      const asked = await tool("request-invoice-send", { invoiceId: invoice.id });
      const issue = h.issues.get(asked.data.issueId)!;
      issue.title = `Approve sending invoice ${invoice.number} (Lumen Digital)`; // as 0.4 titled it
      await h.runJob("mark-overdue");
      expect(h.issues.get(asked.data.issueId)!.title).toBe("Approve sending invoice to Lumen Digital (R 1,150.00)");
      issue.title = `Approve sending invoice ${invoice.number}`; // as earlier versions titled it
      await h.runJob("mark-overdue");
      expect(h.issues.get(asked.data.issueId)!.title).toBe("Approve sending invoice to Lumen Digital (R 1,150.00)");
      issue.title = "Approve this one on Friday";
      await h.runJob("mark-overdue");
      expect(h.issues.get(asked.data.issueId)!.title).toBe("Approve this one on Friday");
    });

    it("routes to the Reviewer first; an agent's done is undone with a comment, only a person's counts", async () => {
      await setRoles({ reviewerAgentId: "agent-rev", reviewOutward: true });
      const quote = (await tool("create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", dealId: "deal-7" })).data as { id: string; number: string };
      await tool("add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 20_000 });
      const asked = await tool("request-quote-send", { quoteId: quote.id });
      const issue = h.issues.get(asked.data.issueId)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-rev", title: "Approve sending quote to Lumen Digital (R 230.00)" });
      expect(issue.description).toContain("for CRM deal deal-7");
      expect(issue.description).toContain("## Reviewer: check before the person approves");
      expect(issue.description).toContain("user user-9");

      await done(asked.data.issueId, "agent");
      expect(await mails()).toHaveLength(0);
      expect(h.issues.get(asked.data.issueId)).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-9" });
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("An agent closed this approval (sending quote Q-LUM-001)");

      await done(asked.data.issueId);
      expect((await mails()).map((m) => m.key)).toEqual([`billing:mail:quote:${quote.id}:1`]);
    });

    it("opens a new approval when the old one was closed without Billing hearing of it", async () => {
      const invoice = await draft();
      const first = await tool("request-invoice-send", { invoiceId: invoice.id });
      h.issues.get(first.data.issueId)!.status = "cancelled"; // no issue.updated reached Billing
      const second = await tool("request-invoice-send", { invoiceId: invoice.id });
      expect(second.data).toMatchObject({ already: false });
      expect(second.data.issueId).not.toBe(first.data.issueId);
    });

    it("sends approvals to the owner when no Billing approver is set", async () => {
      h.config.set(COMPANY, { ...SETTINGS });
      await setRoles({ ownerUserId: "owner-1" });
      const invoice = await draft();
      const asked = await tool("request-invoice-send", { invoiceId: invoice.id });
      expect(h.issues.get(asked.data.issueId)).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
    });

    it("refuses sends that cannot happen, with the reason", async () => {
      const empty = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" })).data as { id: string };
      expect((await tool("request-invoice-send", { invoiceId: empty.id })).data).toEqual({ ok: false, error: "Add a line before sending the invoice" });
      const out = await sent();
      expect((await tool("request-invoice-send", { invoiceId: out.id })).error).toContain("already sent");
    });
  });

  describe("money guards", () => {
    it("turns an agent's record-payment into a person's decision, applied once on done", async () => {
      const invoice = await sent(); // R 1,150.00
      const asked = await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000, reference: "LUM-001", paymentKey: "bank-42", paidAt: "2026-09-20" });
      expect(asked.content).toBe("Asked a person to record the payment (decision issue)");
      expect(asked.data).toMatchObject({ requested: true, already: false, number: "LUM-001", amountMinor: 115_000 });
      const issue = h.issues.get(asked.data.issueId)!;
      expect(issue).toMatchObject({ title: "Record payment of R 1,150.00 on LUM-001 (Lumen Digital)?", assigneeUserId: "user-9", assigneeAgentId: null });
      const invoiceRow = async () => (await h.client.query(`SELECT status FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as { status: string };
      expect((await invoiceRow()).status).toBe("sent");
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.payments`)).rows[0]).toEqual({ n: 0 });
      expect((await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "bank-42" })).data).toMatchObject({ already: true, issueId: asked.data.issueId });

      await done(asked.data.issueId);
      await done(asked.data.issueId);
      expect((await invoiceRow()).status).toBe("paid");
      const payments = (await h.client.query(`SELECT source, source_key, reference FROM ${NAMESPACE}.payments`)).rows;
      expect(payments).toEqual([{ source: "approval", source_key: "manual:bank-42", reference: "LUM-001" }]);
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("Recorded R 1,150.00 on LUM-001: the invoice is now paid");
      const paid = handoffs("invoice.paid");
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({ key: `billing:invoice:${invoice.id}:paid`, invoiceId: invoice.id, number: "LUM-001", clientKind: "contact", clientRef: "ct-lumen", totalMinor: 115_000, currency: "ZAR" });
      expect((await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "bank-42" })).data).toMatchObject({ recorded: true });
      expect((await tool("record-payment", { invoiceId: invoice.id, amountMinor: 5_000 })).error).toContain("is already paid, so this money would only become customer credit");
    });

    it("records nothing when the person cancels, and people on the page still record directly", async () => {
      const invoice = await sent();
      const asked = await tool("record-payment", { invoiceId: invoice.id, amountMinor: 50_000 });
      await cancel(asked.data.issueId);
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.payments`)).rows[0]).toEqual({ n: 0 });
      const direct = await h.call<{ invoiceStatus: string }>("billing.record-payment", { invoiceId: invoice.id, amountMinor: 50_000, paymentKey: "p1" }, userContext());
      expect(direct.invoiceStatus).toBe("partially_paid");
    });

    it("turns an agent's credit note into a decision; an agent closing it is undone; a failure reopens it", async () => {
      const invoice = await sent();
      const asked = await tool("create-credit-note", { invoiceId: invoice.id, amountMinor: 11_500, reason: "Late delivery discount" });
      expect(asked.data).toMatchObject({ requested: true, amountMinor: 11_500 });
      expect(h.issues.get(asked.data.issueId)!.title).toBe("Issue credit note of R 115.00 on LUM-001 (Lumen Digital)?");
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.credit_notes`)).rows[0]).toEqual({ n: 0 });
      await expect(tool("create-credit-note", { invoiceId: invoice.id, amountMinor: 999_999_999 })).resolves.toMatchObject({ data: { ok: false, error: "Credit notes on LUM-001 would exceed its total" } });

      await done(asked.data.issueId, "agent");
      expect(h.issues.get(asked.data.issueId)).toMatchObject({ status: "todo", assigneeUserId: "user-9" });
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("a credit note on LUM-001");

      await done(asked.data.issueId);
      const notes = (await h.client.query(`SELECT number, amount_minor, reason FROM ${NAMESPACE}.credit_notes`)).rows as any[];
      expect(notes).toEqual([{ number: "CN-LUM-001", amount_minor: "11500", reason: "Late delivery discount" }]);
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("Issued credit note CN-LUM-001");

      // The invoice is cancelled before a second request is approved: the person is told why and it stays open.
      const other = await sent(10_000);
      const second = await tool("create-credit-note", { invoiceId: other.id, amountMinor: 1_000 });
      await h.call("billing.cancel-invoice", { invoiceId: other.id, reason: "Wrong client" });
      await done(second.data.issueId);
      expect(h.issues.get(second.data.issueId)!.status).toBe("todo");
      expect(commentsOn(second.data.issueId).join("\n")).toContain("This could not be applied: This invoice is cancelled");
      expect((await h.client.query(`SELECT status FROM ${NAMESPACE}.decision_issues WHERE issue_id = $1`, [second.data.issueId])).rows[0]).toEqual({ status: "open" });
    });
  });

  describe("money is never counted twice", () => {
    const BANK = "plugin.partnersinbiz.accounting.bank.matched";
    const payments = async () => (await h.client.query(`SELECT amount_minor, source, source_key, bank_tx_id, created_by FROM ${NAMESPACE}.payments ORDER BY created_at`)).rows as any[];
    const decisionStatus = async (issueId: string) => ((await h.client.query(`SELECT status FROM ${NAMESPACE}.decision_issues WHERE issue_id = $1`, [issueId])).rows[0] as { status: string }).status;

    it("withdraws an open payment decision when the invoice is paid another way", async () => {
      const invoice = await sent();
      const asked = await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "tx-1" });
      await h.deliver(BANK, COMPANY, { key: "bank:tx-1", bankTxId: "tx-1", bankAccountRole: "bank", bankAccountCode: "1000", kind: "receivable", currency: "ZAR", date: "2026-09-26", reference: "LUM-001", basis: "exact", matchedBy: {}, openItemKey: `invoice:${invoice.id}`, amountMinor: 115_000 });
      expect(await decisionStatus(asked.data.issueId)).toBe("dismissed");
      expect(h.issues.get(asked.data.issueId)!.status).toBe("cancelled");
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("Not needed any more: invoice LUM-001 is paid");
      await done(asked.data.issueId);
      expect(await payments()).toHaveLength(1);
    });

    it("does not record a decision when money arrived since the request, or its bank line is recorded", async () => {
      const invoice = await sent();
      const asked = await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000 });
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 50_000, paymentKey: "page" }, userContext());
      await done(asked.data.issueId);
      expect((await payments()).map((p) => p.source_key)).toEqual(["manual:page"]);
      expect(await decisionStatus(asked.data.issueId)).toBe("dismissed");
      expect(commentsOn(asked.data.issueId).at(-1)).toContain("Not recorded: since this was asked, R 500.00 was recorded or credited on LUM-001");

      // The bank line was already matched before the agent asked about it.
      const other = await sent();
      await h.deliver(BANK, COMPANY, { key: "bank:tx-2", bankTxId: "tx-2", bankAccountRole: "bank", kind: "receivable", currency: "ZAR", date: "2026-09-26", reference: "LUM-002", basis: "exact", matchedBy: {}, openItemKey: `invoice:${other.id}`, amountMinor: 50_000 });
      const again = await tool("record-payment", { invoiceId: other.id, amountMinor: 50_000, paymentKey: "tx-2" });
      await done(again.data.issueId);
      expect((await payments()).filter((p) => p.bank_tx_id === "tx-2" || p.source_key === "manual:tx-2")).toHaveLength(1);
      expect(commentsOn(again.data.issueId).at(-1)).toContain("Not recorded: bank line tx-2 is already recorded");
    });

    it("records the person who approved, not only the assignee", async () => {
      const invoice = await sent();
      const asked = await tool("record-payment", { invoiceId: invoice.id, amountMinor: 115_000 });
      h.issues.get(asked.data.issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: asked.data.issueId, actorType: "user", actorId: "user-77" });
      expect((await payments())[0]).toMatchObject({ created_by: "user:user-77" });
    });

    it("issues a decision's credit note once, even when it is approved again", async () => {
      const invoice = await sent();
      const asked = await tool("create-credit-note", { invoiceId: invoice.id, amountMinor: 11_500, reason: "Discount" });
      await done(asked.data.issueId);
      await h.client.query(`UPDATE ${NAMESPACE}.decision_issues SET status = 'open', resolved_at = NULL WHERE issue_id = $1`, [asked.data.issueId]);
      await done(asked.data.issueId);
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.credit_notes`)).rows[0]).toEqual({ n: 1 });

      const second = await tool("create-credit-note", { invoiceId: invoice.id, amountMinor: 5_000, reason: "More" });
      await h.call("billing.create-credit-note", { invoiceId: invoice.id, amountMinor: 5_000, reason: "Done on the page" }, userContext());
      await done(second.data.issueId);
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.credit_notes`)).rows[0]).toEqual({ n: 2 });
      expect(commentsOn(second.data.issueId).at(-1)).toContain("Not issued: a credit note was issued on LUM-001 since this was asked");
    });

    it("keeps a send request and the right totals when an agent edits and asks in parallel", async () => {
      const invoice = await draft();
      const [, asked] = await Promise.all([
        tool("add-line", { invoiceId: invoice.id, description: "Extra", quantity: 1, unitAmountMinor: 10_000 }),
        tool("request-invoice-send", { invoiceId: invoice.id }),
      ]);
      const row = (await h.client.query(`SELECT pending_action, approval_issue_id, total_minor FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as any;
      expect(row).toMatchObject({ pending_action: "send", approval_issue_id: asked.data.issueId });
      const lines = (await h.client.query(`SELECT sum(gross_minor)::text AS total FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [invoice.id])).rows[0] as any;
      expect(String(row.total_minor)).toBe(lines.total);

      const other = await draft();
      const both = await Promise.all([tool("request-invoice-send", { invoiceId: other.id }), tool("request-invoice-send", { invoiceId: other.id })]);
      const open = [...h.issues.values()].filter((i) => i.originId === `billing:invoice-send:${other.id}` && i.title.startsWith("Approve sending invoice") && i.status !== "cancelled");
      expect(open).toHaveLength(1);
      expect(both.every((r) => r.data.issueId === open[0]!.id)).toBe(true);
      await expect(h.call("billing.request-pay", { invoiceId: (await sent()).id }, userContext()).then(async (r: any) => r)).resolves.toMatchObject({ pendingAction: "pay" });
    });
  });

  describe("payment checks", () => {
    it("opens the proof-of-payment check for a person; done records the money on the day the customer paid", async () => {
      const invoice = await sent();
      const asked = await tool("request-payment-check", { invoiceId: invoice.id, note: "WhatsApp from Sipho: paid on Friday", amountMinor: 115_000, paidOn: "2026-09-25", reference: "LUM-001" });
      expect(asked.content).toBe("Payment check opened for a person");
      expect(asked.data).toMatchObject({ already: false, status: "payment_pending_verification", number: "LUM-001" });
      const issue = h.issues.get(asked.data.issueId)!;
      expect(issue).toMatchObject({ title: "Check proof of payment for LUM-001 (Lumen Digital)", assigneeUserId: "user-9" });
      expect(issue.description).toContain('What the customer said or sent: "WhatsApp from Sipho: paid on Friday"');
      expect(issue.description).toContain("The customer says they paid R 1,150.00 on 2026-09-25.");
      const pops = await h.call<Array<{ source: string; matchBasis: string; status: string }>>("billing.pops", {});
      expect(pops).toEqual([expect.objectContaining({ source: "agent", matchBasis: "agent", status: "pending" })]);

      const again = await tool("request-payment-check", { invoiceId: invoice.id, note: "Also sent a screenshot by email" });
      expect(again.data).toMatchObject({ already: true, issueId: asked.data.issueId });
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("Also sent a screenshot by email");

      await done(asked.data.issueId);
      const payment = (await h.client.query(`SELECT amount_minor, source, paid_at FROM ${NAMESPACE}.payments`)).rows[0] as any;
      expect(payment).toMatchObject({ amount_minor: "115000", source: "pop" });
      expect(new Date(payment.paid_at).toISOString().slice(0, 10)).toBe("2026-09-25");
      expect(((await h.client.query(`SELECT status FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as any).status).toBe("paid");
    });

    it("refuses checks on drafts and paid invoices", async () => {
      const d = await draft();
      expect((await tool("request-payment-check", { invoiceId: d.id, note: "x" })).error).toContain("still a draft");
      const s = await sent();
      await h.call("billing.record-payment", { invoiceId: s.id, amountMinor: 115_000, paymentKey: "full" });
      expect((await tool("request-payment-check", { invoiceId: s.id, note: "x" })).error).toContain("already paid");
    });
  });

  describe("payment reminders", () => {
    async function overdue(days: number) {
      const invoice = await sent();
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - ($2 || ' days')::interval WHERE id = $1`, [invoice.id, String(days)]);
      return invoice;
    }

    it("asks a person to approve the next due stage, then sends it once", async () => {
      const invoice = await overdue(8);
      const asked = await tool("request-reminder-send", { invoiceId: invoice.id });
      expect(asked.content).toBe("Reminder approval issue opened for a person");
      expect(asked.data).toMatchObject({ stage: 2, already: false });
      const issue = h.issues.get(asked.data.issueId)!;
      expect(issue.title).toBe("Approve payment reminder 2 for LUM-001 (Lumen Digital, R 1,150.00)");
      expect(issue.description).toContain("To: ap@lumen.test");
      expect(issue.description).toContain("Subject: Second reminder: invoice LUM-001 is 8 days overdue");
      expect(issue.description).toContain("> Hi Lumen Digital,");
      expect((await tool("request-reminder-send", { invoiceId: invoice.id })).data).toMatchObject({ already: true, issueId: asked.data.issueId });
      expect(await mails()).toHaveLength(0);

      await done(asked.data.issueId);
      expect((await mails()).map((m) => m.key)).toEqual([`billing:mail:reminder:${invoice.id}:2`]);
      expect(commentsOn(asked.data.issueId).join("\n")).toContain("Reminder 2 for LUM-001 is queued in the Mailbox.");
      // The same stage is never asked for (or sent) again; the last stage is due at 14 days.
      expect((await tool("request-reminder-send", { invoiceId: invoice.id })).error).toMatch(/Reminder 3 for LUM-001 is due on \d{4}-\d{2}-\d{2} \(in 6 day\(s\)\)/);
    });

    it("says what to do instead when a reminder is not the next step", async () => {
      const early = await sent();
      expect((await tool("request-reminder-send", { invoiceId: early.id })).error).toContain("is not overdue yet");
      const late = await overdue(20);
      await h.client.query(`INSERT INTO ${NAMESPACE}.reminders (id, company_id, invoice_id, stage, days_overdue, status) VALUES ('r1', $1, $2, 2, 14, 'sent')`, [COMPANY, late.id]);
      expect((await tool("request-reminder-send", { invoiceId: late.id })).error).toContain("All 3 reminders for LUM-002 were sent. Next: ask the owner (ask-owner)");
      const other = await overdue(3);
      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", dunning: { enabled: true } });
      expect((await tool("request-reminder-send", { invoiceId: other.id })).error).toContain("Automatic reminders are on");
      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
      await h.call("billing.set-dunning-optout", { client: "contact:ct-lumen", optOut: true });
      expect((await tool("request-reminder-send", { invoiceId: other.id })).error).toContain("opted out");
    });
  });

  describe("deals and hand-offs", () => {
    it("links quotes to deals and announces acceptance by any path, with the deal", async () => {
      const quote = (await tool("create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", dealId: "deal-42" })).data as { id: string; dealId: string };
      expect(quote.dealId).toBe("deal-42");
      await tool("add-quote-line", { quoteId: quote.id, description: "Website", quantity: 1, unitAmountMinor: 2_000_000 });
      expect((await tool("set-quote-status", { quoteId: quote.id, status: "sent" })).error).toContain("Agents may not do marking a quote sent");

      const accepted = await tool("set-quote-status", { quoteId: quote.id, status: "accepted" });
      expect(accepted.content).toBe("Quote accepted (the CRM is told). Next: convert-quote.");
      await h.call("billing.set-quote-status", { quoteId: quote.id, status: "declined" }, userContext());
      await h.call("billing.set-quote-status", { quoteId: quote.id, status: "accepted" }, userContext());
      const events = handoffs("quote.accepted");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ key: `billing:quote:${quote.id}:accepted`, quoteId: quote.id, number: "Q-LUM-001", dealId: "deal-42", clientKind: "contact", clientRef: "ct-lumen", totalMinor: 2_300_000, currency: "ZAR" });

      const converted = (await tool("convert-quote", { quoteId: quote.id })).data as { invoice: { id: string; dealId: string } };
      expect(converted.invoice.dealId).toBe("deal-42");
      await h.call("billing.mark-sent", { invoiceId: converted.invoice.id });
      await h.call("billing.record-payment", { invoiceId: converted.invoice.id, amountMinor: 1_000_000, paymentKey: "part" });
      expect(handoffs("invoice.paid")).toHaveLength(0);
      await h.call("billing.record-payment", { invoiceId: converted.invoice.id, amountMinor: 1_300_000, paymentKey: "rest" });
      const paid = handoffs("invoice.paid");
      expect(paid).toEqual([expect.objectContaining({ invoiceId: converted.invoice.id, dealId: "deal-42", totalMinor: 2_300_000 })]);
      expect((await tool("list-quotes", { dealId: "deal-42" })).data.items).toEqual([expect.objectContaining({ id: quote.id, status: "converted" })]);
    });

    it("sends each hand-off again hourly for a few hours with the same key", async () => {
      const invoice = await sent();
      await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: "all" });
      expect(handoffs("invoice.paid")).toHaveLength(1);
      await h.runJob("mark-overdue");
      expect(handoffs("invoice.paid")).toHaveLength(1); // too soon
      for (let i = 0; i < 8; i += 1) {
        await h.client.query(`UPDATE ${NAMESPACE}.handoffs SET last_emitted_at = now() - interval '2 hours'`);
        await h.runJob("mark-overdue");
      }
      const sentKeys = handoffs("invoice.paid").map((p) => p.key);
      expect(sentKeys).toHaveLength(6);
      expect(new Set(sentKeys)).toEqual(new Set([`billing:invoice:${invoice.id}:paid`]));
    });
  });

  it("wires every declared tool to a handler", async () => {
    const { BILLING_TOOLS } = await import("../src/tools.js");
    expect([...h.tools.keys()].sort()).toEqual(BILLING_TOOLS.map((t) => t.name).sort());
    for (const declared of BILLING_TOOLS) {
      const result = await tool(declared.name, {});
      expect(result.content, declared.name).not.toBe("Unknown billing tool");
      expect(typeof result.data, declared.name).toBe("object");
    }
  });

  it("keeps agent tool results compact and actionable", async () => {
    const invoice = await draft();
    const detail = (await tool("invoice-detail", { invoiceId: invoice.id })).data;
    expect(detail).toMatchObject({ mode: "compact", invoice: { id: invoice.id, number: "LUM-001", status: "draft" } });
    // Everything stays reachable by id: the full detail is one parameter away.
    const full = (await tool("invoice-detail", { invoiceId: invoice.id, compact: false })).data;
    expect(full.invoice).toMatchObject({ id: invoice.id, number: "LUM-001", status: "draft", createdAt: expect.any(String) });
    const created = await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-unknown" });
    expect(created.data.error).toBe("customerName is required (the customer is not in the CRM client list yet)");
    const named = await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-unknown", customerName: "New Client" });
    expect(named.data.number).toMatch(/^NEW-001$/);
    void agentContext;
  });
});
