/**
 * The company graph for Billing: live numbers for its lead-to-cash stages
 * (the same definitions as its KPIs), the done checks on every kind of work
 * it hands to agents (reopen, pass, finished another way), stable
 * `billing:<kind>:<id>` origin ids, and the `log-follow-up` tool.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { DONE_CHECK_MAX_REOPENS, flowStagesFor, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { draftBillFromEmail } from "../src/costs.js";
import { listedOverdue, MISSING_LINES } from "../src/donechecks.js";
import { shortDayText } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { INVOICE_DRAFT_SKILL } from "../src/skills.js";
import { BILLING_TOOLS } from "../src/tools.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";
import { validateMigration } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const MAIL_RECEIVED = "plugin.partnersinbiz.mailbox.mail.received";
const DEAL_WON = "plugin.partnersinbiz.crm.deal.won";
const AGENT = { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" };

describe("agent surface", () => {
  it("log-follow-up takes one subject and a note, every parameter described", () => {
    const tool = BILLING_TOOLS.find((t) => t.name === "log-follow-up")!;
    const schema = tool.parametersSchema as { required: string[]; properties: Record<string, { description?: string }> };
    expect(schema.required).toEqual(["note"]);
    expect(Object.keys(schema.properties)).toEqual(["invoiceId", "quoteId", "billId", "dealId", "note", "mailDraftId"]);
    for (const prop of Object.values(schema.properties)) expect(prop.description).toBeTruthy();
  });

  it("the skill says closes are checked and how to finish another way", () => {
    expect(INVOICE_DRAFT_SKILL).toContain("When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.");
    expect(INVOICE_DRAFT_SKILL).toContain("`log-follow-up`");
    expect(INVOICE_DRAFT_SKILL).toContain("leave the issue blocked");
  });

  it("the 011 migration passes the host guard, never deletes and has no quotes in comments", () => {
    const sql = readFileSync(new URL("../migrations/011_billing.sql", import.meta.url), "utf8");
    expect(() => validateMigration(sql, NAMESPACE, ["issues"])).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
  });

  it("reads the invoices an overdue issue listed from its fingerprint", () => {
    expect([...listedOverdue("2026-09-28:inv-a:0,inv-b:2")!]).toEqual(["inv-a", "inv-b"]);
    expect(listedOverdue("inv-a,inv-b")).toBeNull();
    expect(listedOverdue(null)).toBeNull();
  });
});

describe.skipIf(!available)("billing graph (postgres)", () => {
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
    for (const key of [...h.state.keys()]) if (/:pib-(setup|cockpit|cockpit-jobs|done-checks):/.test(key)) h.state.delete(key);
    h.wakeups.length = 0;
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
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

  const tool = <T = Record<string, unknown>>(name: string, params: Record<string, unknown>) =>
    h.tools.get(name)!(params, AGENT).then((r) => {
      const result = r as { data?: T; error?: string; ok?: boolean };
      if (result.error) throw new Error(result.error);
      return result.data as T;
    });
  const age = async (tableName: "invoices" | "quotes", id: string, hours: number) =>
    h.client.query(`UPDATE ${NAMESPACE}.${tableName} SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(hours)]);
  const workIssue = async (key: string) => (await h.client.query(`SELECT issue_id, status, fingerprint, opened_at, detail FROM ${NAMESPACE}.work_issues WHERE key = $1`, [key])).rows[0] as { issue_id: string; status: string; fingerprint: string; opened_at: unknown; detail: Record<string, unknown> | null } | undefined;
  const commentsOn = (issueId: string) => h.comments.filter((c) => c.issueId === issueId).map((c) => c.body);

  /** An agent (or a person) marks the issue done; the host then sends issue.updated. */
  async function closes(issueId: string, actorType: "agent" | "user" = "agent") {
    h.issues.get(issueId)!.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, entityType: "issue", actorType, actorId: actorType === "agent" ? "agent-am" : "user-1" });
    return h.issues.get(issueId)!;
  }

  async function draft(customerRef = "ct-lumen", unitAmountMinor = 100_000, currency = "ZAR") {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency, customerKind: customerRef.startsWith("co-") ? "company" : "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Work", quantity: 1, unitAmountMinor });
    return invoice;
  }

  async function overdue(days: number, customerRef = "ct-lumen") {
    const invoice = await draft(customerRef);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - ($2 || ' days')::interval WHERE id = $1`, [invoice.id, String(days)]);
    return invoice;
  }

  async function quote(dealId = "deal-1") {
    const q = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", dealId });
    await h.call("billing.add-quote-line", { quoteId: q.id, description: "Audit", quantity: 1, unitAmountMinor: 50_000 });
    return q;
  }

  // ── Stages ──────────────────────────────────────────────────────────────

  describe("lead-to-cash stages", () => {
    const route = async (): Promise<CockpitSnapshot> => {
      const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId: COMPANY, headers: {} } as PluginApiRequestInput);
      expect(res.status).toBe(200);
      return res.body as CockpitSnapshot;
    };
    const stage = (s: CockpitSnapshot, key: string) => s.flows!.find((f) => f.stage === key)!;

    it("reports every Billing stage, zero when there is nothing", async () => {
      const s = await route();
      expect(s.flows!.map((f) => f.stage)).toEqual(flowStagesFor("partnersinbiz.billing").map((f) => f.key));
      for (const report of s.flows!) expect(report).toMatchObject({ count: 0, stuck: 0, amountMinor: 0, currency: "ZAR" });
    });

    it("counts each stage with the KPI definitions: drafts, approvals, quotes with the customer and money owed as at today", async () => {
      // Drafts: one invoice over a day old, one fresh; one quote over a day old.
      const staleInvoice = await draft("ct-lumen", 100_000); // R 1,150.00 with VAT
      await age("invoices", staleInvoice.id, 50);
      await draft("ct-lumen", 20_000); // R 230.00, fresh
      const staleQuote = await quote("deal-7");
      await age("quotes", staleQuote.id, 30);
      // Approvals: an invoice and a quote waiting for a person.
      const asked = await draft("ct-lumen", 40_000);
      await h.call("billing.request-send", { invoiceId: asked.id });
      const askedQuote = await quote("deal-8");
      await h.call("billing.request-quote-send", { quoteId: askedQuote.id });
      // With the customer: one unanswered for 20 days (stuck), one answered, one recent, one expired (not open).
      const silent = await quote("deal-2");
      const answered = await quote("deal-3");
      const recent = await quote("deal-4");
      const expired = await quote("deal-5");
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() - interval '20 days' WHERE id IN ($1, $2)`, [silent.id, answered.id]);
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() - interval '2 days' WHERE id = $1`, [recent.id]);
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() - interval '30 days', valid_until = now() - interval '1 day' WHERE id = $1`, [expired.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, {
        key: "mbx:a", messageId: "gm-a", accountAddress: "peet@pib.test", threadId: "th", from: { email: "ap@lumen.test", name: "Thandi" }, to: [], subject: "Re: quote",
        snippet: "Can we talk?", receivedAt: new Date().toISOString(), attachments: [], triage: { category: "reply", urgency: 0, needsReply: 1, phishing: 0, confidence: 0.9 },
        replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: answered.id },
      });
      // Owed: one overdue for 12 days (R 1,150.00), one not due yet (R 575.00).
      await overdue(12);
      const notDue = await draft("ct-lumen", 50_000);
      await h.call("billing.mark-sent", { invoiceId: notDue.id });

      const s = await route();
      expect(stage(s, "invoice.draft")).toEqual({ stage: "invoice.draft", count: 2, stuck: 1, stuckReason: "1 over a day old", amountMinor: 138_000, currency: "ZAR", oldestDays: 2 });
      expect(stage(s, "quote.draft")).toEqual({ stage: "quote.draft", count: 1, stuck: 1, stuckReason: "1 over a day old", amountMinor: 57_500, currency: "ZAR", oldestDays: 1 });
      expect(stage(s, "invoice.approval")).toMatchObject({ count: 1, stuck: 0, amountMinor: 46_000 });
      expect(stage(s, "quote.approval")).toMatchObject({ count: 1, stuck: 0, amountMinor: 57_500 });
      expect(stage(s, "quote.sent")).toMatchObject({ count: 3, stuck: 1, stuckReason: "1 with no answer after 14 days", oldestDays: 20, amountMinor: 172_500 });
      const asAt = `as at ${shortDayText(new Date().toISOString().slice(0, 10))}`;
      expect(stage(s, "invoice.open")).toMatchObject({ count: 2, stuck: 1, amountMinor: 172_500, currency: "ZAR", oldestDays: 12, stuckReason: `1 overdue (R 1,150.00), ${asAt}` });

      // One definition per number: the stages add up to the KPIs.
      const kpi = (key: string) => s.kpis.find((k) => k.key === key)!;
      expect(stage(s, "invoice.draft").count + stage(s, "quote.draft").count).toBe(kpi("drafts").raw);
      expect(kpi("drafts").hint).toBe("2 invoices and 1 quote, 2 over a day old");
      expect(stage(s, "invoice.open").amountMinor).toBe(kpi("outstanding").raw);
      expect(kpi("overdue").raw).toBe(115_000);
      // Open quotes (drafts and sent, still valid) are the quotes to send, to approve and with the customer.
      expect(stage(s, "quote.draft").count + stage(s, "quote.approval").count + stage(s, "quote.sent").count).toBe(kpi("open_quotes").raw);
    });

    it("leaves the money out when a stage mixes currencies, and counts a payment dated after today as not paid yet", async () => {
      await draft("ct-lumen", 10_000, "ZAR");
      await draft("ct-lumen", 10_000, "USD");
      const paidLater = await overdue(3);
      await h.client.query(
        `INSERT INTO ${NAMESPACE}.payments (id, company_id, invoice_id, amount_minor, allocated_minor, paid_at, method, source, source_key, currency) VALUES ('pay-future', $1, $2, 115000, 115000, now() + interval '3 days', 'eft', 'manual', 'manual:future', 'ZAR')`,
        [COMPANY, paidLater.id],
      );
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'paid' WHERE id = $1`, [paidLater.id]);
      const s = await route();
      expect(stage(s, "invoice.draft")).toMatchObject({ count: 2, amountMinor: null, currency: null });
      // Stored as paid by a payment dated in 3 days: still owed and overdue as at today.
      expect(stage(s, "invoice.open")).toMatchObject({ count: 1, stuck: 1, amountMinor: 115_000 });
    });
  });

  // ── Done checks ─────────────────────────────────────────────────────────

  describe("Drafts to send", () => {
    async function openDrafts() {
      const stale = await draft();
      await age("invoices", stale.id, 30);
      await h.runJob("drafts-to-send");
      const row = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!;
      return { stale, issueId: row.issue_id };
    }

    it("reopens an early close with each draft still waiting, and wakes the agent", async () => {
      const { stale, issueId } = await openDrafts();
      expect(h.issues.get(issueId)!.originId).toBe(`billing:drafts-to-send:${COMPANY}`);
      h.wakeups.length = 0;
      const issue = await closes(issueId);
      expect(issue.status).toBe("todo");
      const comment = commentsOn(issueId).at(-1)!;
      expect(comment).toContain("**Not done yet** (Drafts to send)");
      expect(comment).toContain(`- Invoice draft for Lumen Digital (R 1,150.00, invoiceId \`${stale.id}\`) has no send request yet.`);
      expect(h.wakeups).toEqual([issueId]);
    });

    it("passes once every draft has a send request", async () => {
      const { stale, issueId } = await openDrafts();
      await tool("request-invoice-send", { invoiceId: stale.id });
      expect((await closes(issueId)).status).toBe("done");
      expect(commentsOn(issueId).join("\n")).not.toContain("Not done yet");
    });

    it("passes when the draft was cancelled instead", async () => {
      const { stale, issueId } = await openDrafts();
      await h.call("billing.cancel-invoice", { invoiceId: stale.id, reason: "Duplicate" });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("an accepted quote converted without asking to send its invoice is still missing (a company that only quoted)", async () => {
      const q = await quote();
      await h.call("billing.set-quote-status", { quoteId: q.id, status: "accepted" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET accepted_at = now() - interval '2 days' WHERE id = $1`, [q.id]);
      await h.runJob("drafts-to-send");
      const issueId = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!.issue_id;
      expect(await closes(issueId)).toMatchObject({ status: "todo" });
      expect(commentsOn(issueId).at(-1)).toContain(`Quote ${q.number} for Lumen Digital (R 575.00) was accepted but is not invoiced yet: \`convert-quote\``);
      const { invoice } = await tool<{ invoice: { id: string } }>("convert-quote", { quoteId: q.id });
      expect(await closes(issueId)).toMatchObject({ status: "todo" });
      expect(commentsOn(issueId).at(-1)).toContain(`Invoice drafted from quote ${q.number} for Lumen Digital (R 575.00, invoiceId \`${invoice.id}\`) has no send request yet.`);
      await tool("request-invoice-send", { invoiceId: invoice.id });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("never checks a person's close", async () => {
      const { issueId } = await openDrafts();
      expect((await closes(issueId, "user")).status).toBe("done");
      expect(commentsOn(issueId).join("\n")).not.toContain("Not done yet");
    });

    it("hands the issue to the Operator after the last early close", async () => {
      const { issueId } = await openDrafts();
      for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) expect((await closes(issueId)).status).toBe("todo");
      const issue = await closes(issueId);
      expect(issue).toMatchObject({ status: "todo", assigneeAgentId: "agent-op" });
      expect(commentsOn(issueId).at(-1)).toContain("**Still not done** (Drafts to send)");
    });

    it("keeps the reopen comment short when many drafts wait", async () => {
      for (let i = 0; i < MISSING_LINES + 3; i += 1) await age("invoices", (await draft("ct-lumen", 1_000 + i)).id, 30);
      await h.runJob("drafts-to-send");
      const issueId = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!.issue_id;
      await closes(issueId);
      const bullets = commentsOn(issueId).at(-1)!.split("\n").filter((line) => line.startsWith("- "));
      expect(bullets).toHaveLength(MISSING_LINES);
      expect(bullets.at(-1)).toBe("- …and 4 more like these (see the list in the issue).");
    });
  });

  describe("Overdue invoices", () => {
    async function openOverdue(days = 8) {
      const invoice = await overdue(days);
      await h.runJob("overdue-invoices");
      const row = (await workIssue(`billing:overdue-invoices:${COMPANY}`))!;
      expect(h.issues.get(row.issue_id)!.originId).toBe(`billing:overdue-invoices:${COMPANY}`);
      return { invoice, issueId: row.issue_id };
    }

    it("reopens when a listed invoice due a reminder has no step yet", async () => {
      const { invoice, issueId } = await openOverdue();
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain(`- ${invoice.number} for Lumen Digital (R 1,150.00, 8 days overdue) has no reminder request, payment check or note yet: \`request-reminder-send\` (invoiceId \`${invoice.id}\`).`);
    });

    it("passes with a reminder request", async () => {
      const { invoice, issueId } = await openOverdue();
      await tool("request-reminder-send", { invoiceId: invoice.id });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("passes with a payment check, a follow-up note, or the invoice paid", async () => {
      const a = await overdue(8);
      const b = await overdue(9, "co-acme");
      const c = await overdue(10);
      await h.runJob("overdue-invoices");
      const issueId = (await workIssue(`billing:overdue-invoices:${COMPANY}`))!.issue_id;
      await tool("request-payment-check", { invoiceId: a.id, note: "WhatsApp: paid on Friday" });
      await tool("log-follow-up", { invoiceId: b.id, note: "Owner agreed a payment plan: R 500 a month from October." });
      expect((await closes(issueId)).status).toBe("todo");
      const comment = commentsOn(issueId).at(-1)!;
      expect(comment).toContain(c.number);
      expect(comment).not.toContain(a.number);
      expect(comment).not.toContain(b.number);
      await h.call("billing.record-payment", { invoiceId: c.id, amountMinor: 115_000, paymentKey: "pc" });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("asks nothing for an invoice whose next reminder is not due yet, nor for one not listed", async () => {
      const invoice = await overdue(3);
      // Reminder 1 went out before the issue opened; reminder 2 is due at 7 days.
      await h.client.query(`INSERT INTO ${NAMESPACE}.reminders (id, company_id, invoice_id, stage, days_overdue, status, created_at) VALUES ('r1', $1, $2, 0, 1, 'sent', now() - interval '2 days')`, [COMPANY, invoice.id]);
      await h.runJob("overdue-invoices");
      const issueId = (await workIssue(`billing:overdue-invoices:${COMPANY}`))!.issue_id;
      expect(h.issues.get(issueId)!.description).toContain("Reminder 2 is due in 4 days");
      await overdue(20, "co-acme"); // overdue after the list was made
      expect((await closes(issueId)).status).toBe("done");
    });

    it("an invoice over 60 days needs the owner: a note settles it", async () => {
      const { invoice, issueId } = await openOverdue(70);
      await h.client.query(`INSERT INTO ${NAMESPACE}.reminders (id, company_id, invoice_id, stage, days_overdue, status, created_at) VALUES ('r3', $1, $2, 2, 14, 'sent', now() - interval '50 days')`, [COMPANY, invoice.id]);
      await h.runJob("overdue-invoices");
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain("ask the owner (`partnersinbiz.cockpit:ask-owner`), then `log-follow-up`");
      await tool("log-follow-up", { invoiceId: invoice.id, note: "Owner will call them on Monday." });
      expect((await closes(issueId)).status).toBe("done");
    });
  });

  describe("Quote reply", () => {
    async function openReply() {
      const q = await quote();
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [q.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, {
        key: "mbx:r1", messageId: "gm-r1", accountAddress: "peet@pib.test", threadId: "th-r", from: { email: "ap@lumen.test", name: "Thandi" }, to: [], subject: "Re: Quote",
        snippet: "Can you add hosting?", receivedAt: new Date().toISOString(), attachments: [], triage: { category: "reply", urgency: 0, needsReply: 1, phishing: 0, confidence: 0.9 },
        replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: q.id },
      });
      const row = (await workIssue(`billing:quote-reply:${q.id}`))!;
      expect(row.detail).toMatchObject({ quoteStatus: "sent", messageId: "gm-r1" });
      expect(h.issues.get(row.issue_id)!.originId).toBe(`billing:quote-reply:${q.id}`);
      return { q, issueId: row.issue_id };
    }

    it("reopens while the quote is unanswered", async () => {
      const { q, issueId } = await openReply();
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain(`- Quote ${q.number} for Lumen Digital is still sent: record their answer with \`set-quote-status\`, or draft the reply in the Mailbox and log it with \`log-follow-up\` (quoteId \`${q.id}\`, mailDraftId).`);
    });

    it("passes once the quote's status changed", async () => {
      const { q, issueId } = await openReply();
      await tool("set-quote-status", { quoteId: q.id, status: "declined" });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("passes when the drafted answer is logged, or a new quote for the deal is drafted", async () => {
      const first = await openReply();
      await tool("log-follow-up", { quoteId: first.q.id, note: "Drafted an answer: hosting is R 300 a month extra.", mailDraftId: "draft-9" });
      expect((await closes(first.issueId)).status).toBe("done");
      const detail = await tool<{ followUps: Array<{ note: string; mailDraftId: string | null; by: string | null }> }>("quote-detail", { quoteId: first.q.id });
      expect(detail.followUps[0]).toMatchObject({ mailDraftId: "draft-9", by: "agent:agent-am" });

      await h.reset();
      await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
      h.config.set(COMPANY, { ...SETTINGS });
      const second = await openReply();
      await quote("deal-1");
      expect((await closes(second.issueId)).status).toBe("done");
    });
  });

  describe("Deal won", () => {
    const won = (over: Record<string, unknown> = {}) => ({
      key: "crm:deal:deal-9:won", dealId: "deal-9", title: "Website rebuild", valueMinor: 2_500_000, currency: "ZAR",
      clientKind: "company", clientRef: "co-acme", clientName: "Acme Holdings", contactEmail: null, firstWin: false, wonAt: new Date().toISOString(), ...over,
    });
    async function openDeal(over: Record<string, unknown> = {}) {
      await h.deliver(DEAL_WON, COMPANY, won(over));
      const dealId = String(over.dealId ?? "deal-9");
      const row = (await workIssue(`billing:deal-won:${dealId}`))!;
      return { issueId: row.issue_id, row };
    }

    it("keeps the client and reopens while nothing is drafted", async () => {
      const { issueId, row } = await openDeal();
      expect(row.detail).toMatchObject({ clientKind: "company", clientRef: "co-acme", title: "Website rebuild" });
      // A draft for another client does not count.
      await draft("ct-lumen");
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain('- Nothing is drafted for deal "Website rebuild" (`company:co-acme`) since this issue opened: no quote, invoice or retainer (pass dealId `deal-9`).');
    });

    it("passes with a quote for the deal", async () => {
      const { issueId } = await openDeal();
      await tool("create-quote", { currency: "ZAR", customerKind: "company", customerRef: "co-acme", dealId: "deal-9" });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("passes with a retainer or an invoice for the client, or a note on the deal", async () => {
      const a = await openDeal();
      await tool("create-subscription", { client: "company:co-acme", priceMinor: 500_000, period: "monthly" });
      expect((await closes(a.issueId)).status).toBe("done");

      const b = await openDeal({ key: "crm:deal:deal-10:won", dealId: "deal-10", clientRef: "ct-lumen", clientKind: "contact", clientName: "Lumen Digital" });
      await draft("ct-lumen");
      expect((await closes(b.issueId)).status).toBe("done");

      const c = await openDeal({ key: "crm:deal:deal-11:won", dealId: "deal-11", clientRef: "co-nobody" });
      await expect(tool("log-follow-up", { dealId: "deal-404", note: "x" })).rejects.toThrow(/knows no deal deal-404/);
      await tool("log-follow-up", { dealId: "deal-11", note: "Owner: this was a free pilot, no invoice." });
      expect((await closes(c.issueId)).status).toBe("done");
    });

    it("an invoice already drafted for the deal counts once it is asked to send", async () => {
      const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: "co-acme", dealId: "deal-12" });
      await h.call("billing.add-line", { invoiceId: invoice.id, description: "Build", quantity: 1, unitAmountMinor: 100_000 });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET created_at = now() - interval '1 hour' WHERE id = $1`, [invoice.id]);
      const { issueId } = await openDeal({ key: "crm:deal:deal-12:won", dealId: "deal-12" });
      expect(h.issues.get(issueId)!.title).toContain("send invoice");
      expect((await closes(issueId)).status).toBe("todo");
      await tool("request-invoice-send", { invoiceId: invoice.id });
      expect((await closes(issueId)).status).toBe("done");
    });
  });

  describe("Complete the bill", () => {
    async function openBill() {
      const bill = await draftBillFromEmail(h.ctx, COMPANY, {
        supplier: { kind: "company", ref: "co-acme", name: "Acme Holdings" }, fromEmail: "billing@acme.test", subject: "Invoice 881",
        messageId: "gm-b1", threadId: "th-b1", receivedAt: new Date().toISOString(), reference: "881",
      }, { ...SETTINGS } as never);
      const issue = [...h.issues.values()].find((i) => i.originId === `billing:bill-from-email:${bill.billId}`)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-am" });
      return { billId: bill.billId, issueId: issue.id };
    }

    it("reopens until the bill has lines and an approval request", async () => {
      const { billId, issueId } = await openBill();
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain(`The bill from Acme Holdings (billId \`${billId}\`) has no lines yet`);
      await tool("add-bill-line", { billId, description: "Hosting", unitAmountMinor: 11_500 });
      expect((await closes(issueId)).status).toBe("todo");
      expect(commentsOn(issueId).at(-1)).toContain("has its lines but no approval request: `request-bill-approval`");
      await tool("request-bill-approval", { billId });
      expect((await closes(issueId)).status).toBe("done");
    });

    it("passes when it is not a bill (a note) or a person cancelled it", async () => {
      const a = await openBill();
      await tool("log-follow-up", { billId: a.billId, note: "Not a bill: it is their statement." });
      expect((await closes(a.issueId)).status).toBe("done");
      await h.reset();
      h.config.set(COMPANY, { ...SETTINGS });
      const b = await openBill();
      await h.call("billing.cancel-bill", { billId: b.billId });
      expect((await closes(b.issueId)).status).toBe("done");
    });
  });

  describe("person-only decisions", () => {
    it("are never done-checked: an agent's close of a send approval goes back to a person", async () => {
      const invoice = await draft();
      const { issueId } = await tool<{ issueId: string }>("request-invoice-send", { invoiceId: invoice.id });
      expect(h.issues.get(issueId)!.originId).toBe(`billing:invoice-send:${invoice.id}`);
      const issue = await closes(issueId);
      expect(issue).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-9" });
      expect(commentsOn(issueId).join("\n")).not.toContain("Not done yet");
    });
  });

  // ── Origins ─────────────────────────────────────────────────────────────

  describe("origin ids", () => {
    it("every issue Billing opens names the module and the kind of work", async () => {
      const sent = await overdue(10);
      await tool("request-reminder-send", { invoiceId: sent.id });
      await tool("record-payment", { invoiceId: sent.id, amountMinor: 10_000 });
      await tool("create-credit-note", { invoiceId: sent.id, amountMinor: 1_000, reason: "Discount" });
      await tool("request-payment-check", { invoiceId: sent.id, note: "Said they paid" });
      const q = await quote();
      await tool("request-quote-send", { quoteId: q.id });
      const bill = await h.call<{ id: string }>("billing.create-bill", { supplierName: "Hosting Co" });
      await h.call("billing.add-bill-line", { billId: bill.id, description: "Server", unitAmountMinor: 1_000 });
      await tool("request-bill-approval", { billId: bill.id });
      const origins = [...h.issues.values()].map((i) => i.originId ?? "");
      for (const prefix of ["billing:reminder:", "billing:record-payment:", "billing:credit-note:", "billing:payment-check:", "billing:quote-send:", "billing:bill-approval:"]) {
        expect(origins.some((o) => o.startsWith(prefix)), prefix).toBe(true);
      }
      expect(origins.every((o) => o.startsWith("billing:"))).toBe(true);
    });

    it("gives standing issues opened before 0.5 their new origin id, and the migration moves their keys", async () => {
      const stale = await draft();
      await age("invoices", stale.id, 30);
      await h.runJob("drafts-to-send");
      const key = `billing:drafts-to-send:${COMPANY}`;
      const row = (await workIssue(key))!;
      h.issues.get(row.issue_id)!.originId = `digest:drafts:${COMPANY}`;
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)!.originId).toBe(key);

      // A deal-won issue nothing refreshes: the daily job fixes its origin too.
      await h.client.query(`INSERT INTO ${NAMESPACE}.work_issues (key, company_id, kind, subject_id, issue_id, status) VALUES ('billing:deal-won:d-old', $1, 'deal_won', 'd-old', $2, 'open')`, [COMPANY, "issue-legacy"]);
      h.issues.set("issue-legacy", { id: "issue-legacy", companyId: COMPANY, title: "Deal won: old", status: "todo", originId: "deal-won:d-old" });
      await h.runJob("drafts-to-send");
      expect(h.issues.get("issue-legacy")!.originId).toBe("billing:deal-won:d-old");

      // The 0.5 migration renames stored keys.
      for (const [legacy, kind, subject] of [[`digest:drafts:co-x`, "drafts", null], [`digest:overdue:co-x`, "overdue", null], ["quote-reply:q-x", "quote_reply", "q-x"], ["deal-won:d-x", "deal_won", "d-x"]] as const) {
        await h.client.query(`INSERT INTO ${NAMESPACE}.work_issues (key, company_id, kind, subject_id, issue_id, status) VALUES ($1, 'co-x', $2, $3, 'i', 'open')`, [legacy, kind, subject]);
      }
      const sql = readFileSync(new URL("../migrations/011_billing.sql", import.meta.url), "utf8");
      for (const statement of sql.split(";").map((part) => part.replace(/^\s*--.*$/gm, "").trim()).filter((part) => part.startsWith("UPDATE"))) await h.client.query(statement);
      const keys = ((await h.client.query(`SELECT key FROM ${NAMESPACE}.work_issues WHERE company_id = 'co-x' ORDER BY key`)).rows as Array<{ key: string }>).map((r) => r.key);
      expect(keys).toEqual(["billing:deal-won:d-x", "billing:drafts-to-send:co-x", "billing:overdue-invoices:co-x", "billing:quote-reply:q-x"]);
    });
  });

  describe("log-follow-up", () => {
    it("needs exactly one subject of this company and shows on the invoice", async () => {
      const sent = await overdue(5);
      await expect(tool("log-follow-up", { note: "x" })).rejects.toThrow(/exactly one of invoiceId, quoteId, billId or dealId/);
      await expect(tool("log-follow-up", { invoiceId: sent.id, quoteId: "q", note: "x" })).rejects.toThrow(/exactly one/);
      await expect(tool("log-follow-up", { invoiceId: "nope", note: "x" })).rejects.toThrow(/not found/);
      const result = await h.tools.get("log-follow-up")!({ invoiceId: sent.id, note: "Promised to pay on the 30th.", mailDraftId: "d-1" }, AGENT) as { content: string; data: { logged: boolean; subject: string } };
      expect(result.content).toBe(`Follow-up logged on invoice ${sent.number}`);
      expect(result.data).toMatchObject({ logged: true, subject: `invoice:${sent.id}` });
      const detail = await h.call<{ followUps: Array<{ note: string; mailDraftId: string }> }>("billing.invoice-detail", { invoiceId: sent.id }, userContext());
      expect(detail.followUps).toEqual([expect.objectContaining({ note: "Promised to pay on the 30th.", mailDraftId: "d-1" })]);
    });
  });
});
