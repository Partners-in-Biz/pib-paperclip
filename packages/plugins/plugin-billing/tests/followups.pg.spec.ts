/**
 * Nothing sits silently: the standing issues Billing keeps for the Account
 * Manager (drafts to send, overdue invoices, quote replies, won deals), the
 * journals it back-posts once Accounting is on, and what the Cockpit shows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const MODULES = "plugin.partnersinbiz.setup.modules.updated";
const MAIL_RECEIVED = "plugin.partnersinbiz.mailbox.mail.received";
const DEAL_WON = "plugin.partnersinbiz.crm.deal.won";

describe.skipIf(!available)("billing follow-ups (postgres)", () => {
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
    await seedClient(h, { id: "co-acme", name: "Acme Holdings", kind: "company" });
    await h.deliver(ROLES, COMPANY, {
      companyId: COMPANY,
      operatorAgentId: "agent-op",
      reviewerAgentId: null,
      reviewOutward: false,
      ownerUserId: "owner-1",
      team: { "account-manager": { agentId: "agent-am", status: "idle" } },
      updatedAt: new Date().toISOString(),
    });
  });

  const workIssue = async (key: string) => (await h.client.query(`SELECT issue_id, status, fingerprint FROM ${NAMESPACE}.work_issues WHERE key = $1`, [key])).rows[0] as { issue_id: string; status: string; fingerprint: string } | undefined;
  const commentsOn = (issueId: string) => h.comments.filter((c) => c.issueId === issueId).map((c) => c.body);
  const age = async (tableName: "invoices" | "quotes", id: string, hours: number) =>
    h.client.query(`UPDATE ${NAMESPACE}.${tableName} SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(hours)]);

  async function draft(customerRef = "ct-lumen", unitAmountMinor = 100_000) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Work", quantity: 1, unitAmountMinor });
    return invoice;
  }

  async function quote(status?: "accepted") {
    const q = await h.call<{ id: string; number: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", dealId: "deal-1" });
    await h.call("billing.add-quote-line", { quoteId: q.id, description: "Audit", quantity: 1, unitAmountMinor: 50_000 });
    if (status) await h.call("billing.set-quote-status", { quoteId: q.id, status });
    return q;
  }

  describe("Drafts to send", () => {
    it("keeps one issue for the Account Manager: listed, updated, closed when empty, reopened when drafts return", async () => {
      const stale = await draft();
      await age("invoices", stale.id, 30);
      const fresh = await draft(); // under a day old: not listed yet
      const asked = await draft();
      await age("invoices", asked.id, 30);
      await h.call("billing.request-send", { invoiceId: asked.id });
      const template = await draft();
      await age("invoices", template.id, 30);
      await h.call("billing.create-recurring", { templateInvoiceId: template.id, frequency: "monthly", nextRunAt: "2027-01-01T00:00:00Z" });
      const plan = await h.call<{ id: string }>("billing.create-plan", { name: "Care", priceMinor: 300_000, period: "monthly" });
      await h.call("billing.create-subscription", { client: "contact:ct-lumen", planId: plan.id, startAt: "2026-09-01T00:00:00Z" });
      await h.runJob("run-recurring");
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET created_at = now() - interval '2 days' WHERE subscription_id IS NOT NULL`);
      const q = await quote();
      await age("quotes", q.id, 30);
      const acceptedQuote = await quote("accepted");
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET accepted_at = now() - interval '2 days' WHERE id = $1`, [acceptedQuote.id]);

      await h.runJob("drafts-to-send");
      const row = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-am", title: "Drafts to send: 2 invoices and 2 quotes waiting" });
      expect(issue.description).toContain(`Invoice ${stale.number}`);
      expect(issue.description).toContain("retainer");
      expect(issue.description).toContain(`Quote ${q.number}`);
      expect(issue.description).toContain("accepted: `convert-quote`, then `request-invoice-send`");
      expect(issue.description).not.toContain(`Invoice ${fresh.number} (`);
      expect(issue.description).not.toContain(`Invoice ${asked.number} (`);
      expect(issue.description).not.toContain(`Invoice ${template.number} (`);
      expect(issue.description).toContain("/PIB/billing?tab=invoices");
      expect(h.wakeups).toContain(row.issue_id);

      // Same list: the same issue, no duplicate, no new wake-up.
      const wakes = h.wakeups.length;
      await h.runJob("drafts-to-send");
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Drafts to send"))).toHaveLength(1);
      expect(h.wakeups.length).toBe(wakes);

      // A new stale draft: the issue is updated, the agent woken and told what is new.
      await age("invoices", fresh.id, 30);
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)!.title).toBe("Drafts to send: 3 invoices and 2 quotes waiting");
      expect(commentsOn(row.issue_id).join("\n")).toContain(`New drafts waiting: ${fresh.number}`);
      expect(h.wakeups.length).toBe(wakes + 1);

      // Everything handled: closed with a note.
      for (const id of [stale.id, fresh.id]) await h.call("billing.request-send", { invoiceId: id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET pending_action = 'send' WHERE subscription_id IS NOT NULL`);
      await h.call("billing.request-quote-send", { quoteId: q.id });
      await h.call("billing.convert-quote", { quoteId: acceptedQuote.id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET pending_action = 'send' WHERE quote_id = $1`, [acceptedQuote.id]);
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)!.status).toBe("done");
      expect((await workIssue(`billing:drafts-to-send:${COMPANY}`))!.status).toBe("closed");
      expect(commentsOn(row.issue_id).at(-1)).toContain("Nothing is waiting");

      // New drafts later: the same issue opens again.
      const later = await draft();
      await age("invoices", later.id, 30);
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)).toMatchObject({ status: "todo", title: "Drafts to send: 1 invoice waiting" });
      expect((await workIssue(`billing:drafts-to-send:${COMPANY}`))).toMatchObject({ issue_id: row.issue_id, status: "open" });
    });

    it("never unassigns a person's pick when nobody is available", async () => {
      await h.deliver(ROLES, COMPANY, { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, reviewOutward: false, ownerUserId: null, team: {}, updatedAt: new Date(Date.now() + 1000).toISOString() });
      const stale = await draft();
      await age("invoices", stale.id, 30);
      await h.runJob("drafts-to-send");
      const row = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!;
      expect(h.issues.get(row.issue_id)).toMatchObject({ assigneeAgentId: null, assigneeUserId: null });
      h.issues.get(row.issue_id)!.assigneeUserId = "user-5";
      const more = await draft();
      await age("invoices", more.id, 30);
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)).toMatchObject({ assigneeUserId: "user-5", title: "Drafts to send: 2 invoices waiting" });
    });

    it("goes to the Operator, then the owner, when no Account Manager is running", async () => {
      await h.deliver(ROLES, COMPANY, { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, reviewOutward: false, ownerUserId: "owner-1", team: { "account-manager": { agentId: "agent-am", status: "paused" } }, updatedAt: new Date(Date.now() + 1000).toISOString() });
      const stale = await draft();
      await age("invoices", stale.id, 30);
      await h.runJob("drafts-to-send");
      const row = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!;
      expect(h.issues.get(row.issue_id)).toMatchObject({ assigneeAgentId: null, assigneeUserId: "owner-1" });
      const page = await h.call<{ team: { accountManager: boolean; via: string; setupHref: string } }>("billing.load", {});
      expect(page.team).toEqual({ accountManager: false, via: "owner", setupHref: "/setup?section=team#team-account-manager" });
    });
  });

  describe("Overdue invoices", () => {
    async function overdue(days: number, customerRef = "ct-lumen") {
      const invoice = await draft(customerRef);
      await h.call("billing.mark-sent", { invoiceId: invoice.id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - ($2 || ' days')::interval WHERE id = $1`, [invoice.id, String(days)]);
      return invoice;
    }

    it("lists each overdue invoice with its next step weekly, keeps it current daily and closes it when paid", async () => {
      const a = await overdue(8);
      const b = await overdue(70);
      await h.client.query(`INSERT INTO ${NAMESPACE}.reminders (id, company_id, invoice_id, stage, days_overdue, status) VALUES ('r-b', $1, $2, 2, 14, 'sent')`, [COMPANY, b.id]);
      await h.runJob("overdue-invoices");
      const row = (await workIssue(`billing:overdue-invoices:${COMPANY}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-am", title: "Overdue invoices: 2 (R 2,300.00)" });
      expect(issue.description).toContain("`request-reminder-send` (reminder 2 is due)");
      expect(issue.description).toContain("All reminders sent: ask the owner (call, payment plan or write-off); over 60 days: ask the owner");
      expect(issue.description).toContain("request-payment-check");
      expect(commentsOn(row.issue_id)).toEqual([]);

      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", dunning: { enabled: true } });
      await h.runJob("overdue-invoices");
      expect(h.issues.get(row.issue_id)!.description).toContain("Reminder 2 goes out automatically");
      expect(commentsOn(row.issue_id).join("\n")).toContain("This week: 2 overdue invoices");

      // Closed by the agent: the daily run does not reopen it, the weekly run does.
      h.issues.get(row.issue_id)!.status = "done";
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)!.status).toBe("done");
      await h.runJob("overdue-invoices");
      expect(h.issues.get(row.issue_id)!.status).toBe("todo");

      for (const [invoice, key] of [[a, "pa"], [b, "pb"]] as const) await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 115_000, paymentKey: key });
      await h.runJob("drafts-to-send");
      expect(h.issues.get(row.issue_id)!.status).toBe("done");
      expect(commentsOn(row.issue_id).at(-1)).toBe("Nothing is overdue any more.");
    });
  });

  describe("quote replies", () => {
    const reply = (over: Record<string, unknown>) => ({
      accountAddress: "peet@pib.test",
      threadId: "th-q",
      from: { email: "ap@lumen.test", name: "Thandi" },
      to: [{ email: "peet@pib.test" }],
      subject: "Re: Quote Q-LUM-001 from Partners in Biz",
      snippet: "Looks good, we accept. When can you start?",
      receivedAt: new Date().toISOString(),
      attachments: [],
      triage: { category: "reply", urgency: 0.5, needsReply: 0.9, phishing: 0, confidence: 0.8 },
      ...over,
    });

    it("goes to the Deal Desk when there is one", async () => {
      await h.deliver(ROLES, COMPANY, {
        companyId: COMPANY, operatorAgentId: "agent-op", reviewerAgentId: null, reviewOutward: false, ownerUserId: "owner-1",
        team: { "account-manager": { agentId: "agent-am", status: "idle" }, "deal-desk": { agentId: "agent-dd", status: "idle" } },
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      });
      const q = await quote();
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [q.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, reply({ key: "mbx:dd1", messageId: "gm-dd1", replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: q.id } }));
      const row = (await workIssue(`billing:quote-reply:${q.id}`))!;
      expect(h.issues.get(row.issue_id)).toMatchObject({ assigneeAgentId: "agent-dd" });
    });

    it("opens one issue per quote for the Account Manager, with the reply and the next steps", async () => {
      const q = await quote();
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [q.id]);
      const first = reply({ key: "mbx:q1", messageId: "gm-q1", replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: q.id } });
      await h.deliver(MAIL_RECEIVED, COMPANY, first);
      await h.deliver(MAIL_RECEIVED, COMPANY, first);
      const row = (await workIssue(`billing:quote-reply:${q.id}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue).toMatchObject({ title: "Quote reply: Q-LUM-001 (Lumen Digital)", assigneeAgentId: "agent-am" });
      expect(issue.description).toContain("> Looks good, we accept. When can you start?");
      expect(issue.description).toContain(`\`partnersinbiz.billing:set-quote-status\` (quoteId \`${q.id}\`, status \`accepted\`), then \`convert-quote\``);
      expect(issue.description).toContain("replyToMessageId `gm-q1`");
      expect(issue.description).toContain("CRM deal `deal-1`");
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Quote reply"))).toHaveLength(1);

      // A second reply without the Mailbox's reply context, matched by the quote number: same issue, a comment.
      await h.deliver(MAIL_RECEIVED, COMPANY, reply({ key: "mbx:q2", messageId: "gm-q2", snippet: "Please add hosting too" }));
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Quote reply"))).toHaveLength(1);
      expect(commentsOn(row.issue_id).join("\n")).toContain('New reply from Thandi <ap@lumen.test>: "Please add hosting too"');
      expect(h.issues.get(row.issue_id)!.description).toContain("replyToMessageId `gm-q2`");
      expect(await h.call<unknown[]>("billing.pops", {})).toHaveLength(0);
    });

    it("leaves proofs of payment, spam and bounces to their own paths", async () => {
      const q = await quote();
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [q.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, reply({ key: "mbx:s", messageId: "gm-s", replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: q.id }, triage: { category: "spam", urgency: 0, needsReply: 0, phishing: 0.9, confidence: 0.9 } }));
      await h.deliver(MAIL_RECEIVED, COMPANY, reply({ key: "mbx:b", messageId: "gm-b", subject: "Undeliverable: Quote Q-LUM-001", replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: q.id }, bounce: { recipients: ["ap@lumen.test"], rfcIds: [] }, triage: { category: "notification", urgency: 0, needsReply: 0, phishing: 0, confidence: 0.9 } }));
      expect(await workIssue(`billing:quote-reply:${q.id}`)).toBeUndefined();
    });
  });

  describe("deal won", () => {
    const won = (over: Record<string, unknown> = {}) => ({
      key: "crm:deal:deal-9:won",
      dealId: "deal-9",
      title: "Website rebuild",
      valueMinor: 2_500_000,
      currency: "ZAR",
      clientKind: "company",
      clientRef: "co-acme",
      clientName: "Acme Holdings",
      contactEmail: "cfo@acme.test",
      firstWin: true,
      wonAt: "2026-09-27T10:00:00.000Z",
      ...over,
    });

    it("opens one drafting issue per won deal for the Account Manager, with links", async () => {
      await h.deliver(DEAL_WON, COMPANY, won());
      await h.deliver(DEAL_WON, COMPANY, won());
      const row = (await workIssue("billing:deal-won:deal-9"))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue).toMatchObject({ title: "Deal won: Website rebuild for Acme Holdings, R 25,000.00: draft the quote, invoice or retainer", assigneeAgentId: "agent-am" });
      expect(issue.description).toContain("dealId `deal-9`");
      expect(issue.description).toContain("/PIB/billing?client=company:co-acme");
      expect(issue.description).toContain("/PIB/billing?tab=quotes&client=company:co-acme");
      expect(issue.description).toContain("/PIB/crm?tab=deals");
      expect(issue.description).toContain("first win");
      expect([...h.issues.values()].filter((i) => i.title.startsWith("Deal won"))).toHaveLength(1);
    });

    it("points at the accepted quote, skips deals already invoiced, and does nothing with Billing off", async () => {
      const q = await quote("accepted");
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-1:won", dealId: "deal-1", clientKind: "contact", clientRef: "ct-lumen", clientName: "Lumen Digital" }));
      const tailored = h.issues.get((await workIssue("billing:deal-won:deal-1"))!.issue_id)!;
      expect(tailored.description).toContain(`Quote ${q.number} (\`${q.id}\`) for this deal is accepted: \`convert-quote\` it`);
      expect(tailored.description).not.toContain("Draft what was sold");
      expect(tailored.title).toBe(`Deal won: Website rebuild for Lumen Digital, R 25,000.00: convert quote ${q.number} and send the invoice`);

      const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", dealId: "deal-2" });
      await h.call("billing.add-line", { invoiceId: invoice.id, description: "x", quantity: 1, unitAmountMinor: 100 });
      await h.call("billing.mark-sent", { invoiceId: invoice.id });
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-2:won", dealId: "deal-2" }));
      expect(await workIssue("billing:deal-won:deal-2")).toBeUndefined();

      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { billing: false }, updatedAt: new Date().toISOString() });
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-3:won", dealId: "deal-3" }));
      expect(await workIssue("billing:deal-won:deal-3")).toBeUndefined();
    });
  });

  describe("journals missed while Accounting was off", () => {
    const journalKeys = async () => ((await h.client.query(`SELECT key FROM ${NAMESPACE}.outbox WHERE event = 'ledger.post.requested' ORDER BY key`)).rows as Array<{ key: string }>).map((r) => r.key.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"));

    it("posts every missed journal once when Accounting is switched on, and from the nightly job", async () => {
      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { accounting: false }, updatedAt: new Date().toISOString() });
      const a = await draft();
      await h.call("billing.mark-sent", { invoiceId: a.id });
      await h.call("billing.record-payment", { invoiceId: a.id, amountMinor: 50_000, paymentKey: "k1" });
      await h.call("billing.create-credit-note", { invoiceId: a.id, amountMinor: 5_000, reason: "Discount" });
      await h.call("billing.write-off", { invoiceId: a.id, reason: "Closed" });
      const bill = await h.call<{ id: string }>("billing.create-bill", { supplierName: "Hosting Co", category: "hosting" });
      await h.call("billing.add-bill-line", { billId: bill.id, description: "Server", unitAmountMinor: 11_500 });
      await h.call("billing.approve-bill", { billId: bill.id });
      await h.call("billing.pay-bill", { billId: bill.id });
      await h.call("billing.create-expense", { description: "Figma", amountMinor: 23_000, vatMinor: 3_000, category: "software", vatClaimable: true });
      const voided = await draft();
      await h.call("billing.mark-sent", { invoiceId: voided.id });
      await h.call("billing.cancel-invoice", { invoiceId: voided.id, reason: "Wrong" });
      expect(await journalKeys()).toEqual([]);

      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { accounting: true }, updatedAt: new Date(Date.now() + 1000).toISOString() });
      const keys = await journalKeys();
      expect(keys).toEqual([
        "billing:bill:<id>:approve",
        "billing:bill_payment:<id>",
        "billing:credit_note:<id>:issue",
        "billing:expense:<id>:v1",
        "billing:invoice:<id>:issue",
        "billing:invoice:<id>:write_off",
        "billing:payment:<id>",
      ]);
      await h.deliver(MODULES, COMPANY, { companyId: COMPANY, modules: { accounting: true }, updatedAt: new Date(Date.now() + 2000).toISOString() });
      await h.runJob("post-missing-journals");
      expect(await journalKeys()).toEqual(keys);
      const invoiceLedger = (await h.client.query(`SELECT ledger_status FROM ${NAMESPACE}.invoices WHERE id = $1`, [a.id])).rows[0] as { ledger_status: string };
      expect(invoiceLedger.ledger_status).toBe("pending");
    });

    it("posts what was skipped while posting was off in the settings, from the nightly job", async () => {
      h.config.set(COMPANY, { ...SETTINGS, ledger: { enabled: false } });
      const a = await draft();
      await h.call("billing.mark-sent", { invoiceId: a.id });
      await h.runJob("post-missing-journals");
      expect(await journalKeys()).toEqual([]);
      h.config.set(COMPANY, { ...SETTINGS, ledger: { enabled: true } });
      await h.runJob("post-missing-journals");
      expect(await journalKeys()).toEqual(["billing:invoice:<id>:issue"]);
    });
  });

  describe("Cockpit", () => {
    const route = async (): Promise<CockpitSnapshot> => {
      const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId: COMPANY, headers: {} } as PluginApiRequestInput);
      return res.body as CockpitSnapshot;
    };

    it("shows drafts to send and every decision waiting on a person", async () => {
      const stale = await draft();
      await age("invoices", stale.id, 30);
      await draft();
      const sent = await draft();
      await h.call("billing.mark-sent", { invoiceId: sent.id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '10 days' WHERE id = $1`, [sent.id]);
      const agent = { agentId: "agent-am", runId: "r", companyId: COMPANY, projectId: "p" };
      await h.tools.get("record-payment")!({ invoiceId: sent.id, amountMinor: 10_000 }, agent);
      await h.tools.get("create-credit-note")!({ invoiceId: sent.id, amountMinor: 1_000 }, agent);
      await h.tools.get("request-reminder-send")!({ invoiceId: sent.id }, agent);
      const s = await route();
      expect(s.kpis.find((k) => k.key === "drafts")).toMatchObject({ raw: 2, tone: "warn", group: "pipeline", value: "R 2,300.00", hint: "2 invoices, 1 over a day old" });
      expect(s.waiting.map((w) => w.title)).toEqual(expect.arrayContaining([
        `Record payment of R 100.00 on ${sent.number}?`,
        `Issue credit note of R 10.00 on ${sent.number}?`,
        `Approve payment reminder 2 for ${sent.number}`,
      ]));
      expect(s.health.map((c) => c.key)).toEqual(expect.arrayContaining(["job:drafts-to-send", "job:overdue-invoices", "job:post-missing-journals"]));

      const page = await h.call<{ decisions: Array<{ kind: string; title: string }> }>("billing.load", {});
      expect(page.decisions.map((d) => d.kind).sort()).toEqual(["credit_note", "payment", "reminder"]);
      const other = await h.call<{ decisions: unknown[] }>("billing.load", { client: "company:co-acme" }, userContext());
      expect(other.decisions).toEqual([]);
    });
  });
});
