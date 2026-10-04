/**
 * A rehearsal on the canary client is harmless (0.7.1, audit Q1b-2 / Q5-1), on a real Postgres under the host's SQL rules.
 *
 * The Acceptance agent's quote-to-invoice journey accepts a canary quote, converts it itself and asks for the send approval. Live, the
 * CRM marked the canary deal won on the acceptance, Billing opened "Deal won: … convert quote" and woke a real agent, which converted the
 * quote first, so the journey's own `convert-quote` was refused ("Only an accepted quote can be converted") and the journey failed.
 *
 * So: nothing a canary client does opens an issue or wakes anyone from an event or a daily job (a won deal, a reply to its quote, the
 * drafts and overdue digests, reminders, the Cockpit's "stuck" figures), and every one of those still works for a real client (each test
 * has its control). The journey's own explicit tool calls, such as its send request, stay exactly as they were.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { CANARY_SKIPPED } from "../src/followups.js";
import { NAMESPACE } from "../src/namespace.js";
import { APPROVAL_ORIGINS, WORK_ORIGINS } from "../src/origins.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const DEAL_WON = "plugin.partnersinbiz.crm.deal.won";
const MAIL_RECEIVED = "plugin.partnersinbiz.mailbox.mail.received";
const AGENT = { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" };
/** The canary company's CRM record id (`canary-` and eight hex characters), as the CRM makes it. */
const CANARY = "canary-ab12cd34";
const CANARY_CONTACT = "canary-contact-ab12cd34";

type ToolResult = { content: string; data: Record<string, any>; error?: string };
type Row = Record<string, unknown>;

describe.skipIf(!available)("a rehearsal on the canary client is harmless (postgres)", () => {
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

  // ── helpers ──────────────────────────────────────────────────────────────

  const q = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Row[];
  const tool = async (name: string, params: Record<string, unknown>) => (await h.tools.get(name)!(params, AGENT)) as ToolResult;
  const workIssue = async (key: string) => (await q(`SELECT issue_id, status, fingerprint FROM ${NAMESPACE}.work_issues WHERE key = $1`, [key]))[0] as { issue_id: string; status: string; fingerprint: string } | undefined;
  const allWorkIssues = () => q(`SELECT key, kind FROM ${NAMESPACE}.work_issues`);
  const inbox = async (key: string) => (await q(`SELECT result FROM ${NAMESPACE}.inbox WHERE key = $1`, [key]))[0] as { result: Record<string, unknown> } | undefined;
  const reminderRows = (invoiceId: string) => q(`SELECT stage, status FROM ${NAMESPACE}.reminders WHERE invoice_id = $1`, [invoiceId]);
  const handoffs = (name: string) => h.emitted.filter((e) => e.name === name).map((e) => e.payload as Record<string, any>);
  const age = (table: "invoices" | "quotes", id: string, hours: number) =>
    h.client.query(`UPDATE ${NAMESPACE}.${table} SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(hours)]);

  const won = (over: Record<string, unknown> = {}) => ({
    key: "crm:deal:deal-9:won",
    dealId: "deal-9",
    title: "Website rebuild",
    valueMinor: 100_000,
    currency: "ZAR",
    clientKind: "company",
    clientRef: "co-acme",
    clientName: "Acme Holdings",
    contactEmail: null,
    firstWin: true,
    wonAt: "2026-10-04T08:00:00.000Z",
    ...over,
  });

  /** A draft invoice with one line for a client; `kind` is the CRM record type of `ref`. */
  async function draft(ref: string, kind: "company" | "contact" = "company") {
    const made = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: kind, customerRef: ref, ...(ref.startsWith("canary-") ? { customerName: "PiB Canary Co" } : {}) });
    await h.call("billing.add-line", { invoiceId: made.id, description: "Work", quantity: 1, unitAmountMinor: 100_000 });
    return made;
  }

  /** A sent invoice that fell due `daysAgo` days ago. */
  async function overdue(ref: string, daysAgo: number, kind: "company" | "contact" = "company") {
    const invoice = await draft(ref, kind);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - ($2 || ' days')::interval WHERE id = $1`, [invoice.id, String(daysAgo)]);
    return invoice;
  }

  async function quote(ref: string, over: { dealId?: string; kind?: "company" | "contact" } = {}) {
    const made = await h.call<{ id: string; number: string }>("billing.create-quote", {
      currency: "ZAR",
      customerKind: over.kind ?? "company",
      customerRef: ref,
      ...(ref.startsWith("canary-") ? { customerName: "PiB Canary Co" } : {}),
      ...(over.dealId ? { dealId: over.dealId } : {}),
    });
    await h.call("billing.add-quote-line", { quoteId: made.id, description: "Audit", quantity: 1, unitAmountMinor: 100_000 });
    return made;
  }

  // ── a canary deal won ────────────────────────────────────────────────────

  describe("a won deal", () => {
    it("on the canary opens no issue and wakes nobody, and says why; the same event for a real client still opens its issue and wakes the Account Manager", async () => {
      // Control: a real client's won deal is the work it always was.
      await h.deliver(DEAL_WON, COMPANY, won());
      const real = (await workIssue("billing:deal-won:deal-9"))!;
      expect(h.issues.get(real.issue_id)).toMatchObject({ assigneeAgentId: "agent-am", title: expect.stringContaining("Deal won: Website rebuild for Acme Holdings") });
      expect(h.wakeups).toEqual([real.issue_id]);

      // The canary: the identical event.
      h.wakeups.length = 0;
      h.issues.clear();
      const event = won({ key: "crm:deal:deal-c:won", dealId: "deal-c", title: "Canary rehearsal", clientRef: CANARY, clientName: "PiB Canary Co" });
      await h.deliver(DEAL_WON, COMPANY, event);
      expect(await workIssue("billing:deal-won:deal-c")).toBeUndefined();
      expect([...h.issues.values()]).toEqual([]);
      expect(h.wakeups).toEqual([]);
      // The skip is the stored result of the hand-off, with its reason, and a re-send (the CRM sends each hand-off again hourly for a day) changes nothing.
      expect((await inbox("deal-won:crm:deal:deal-c:won"))!.result).toEqual({ dealId: "deal-c", skipped: CANARY_SKIPPED });
      await h.deliver(DEAL_WON, COMPANY, event);
      expect(await workIssue("billing:deal-won:deal-c")).toBeUndefined();
      expect(h.wakeups).toEqual([]);
    });

    it("on the canary's own contact is left alone too, even when a quote and an accepted quote for the deal exist", async () => {
      const made = await quote(CANARY_CONTACT, { dealId: "deal-cc", kind: "contact" });
      await h.call("billing.set-quote-status", { quoteId: made.id, status: "accepted" });
      h.wakeups.length = 0;
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-cc:won", dealId: "deal-cc", clientKind: "contact", clientRef: CANARY_CONTACT, clientName: "Canary Contact" }));
      expect(await allWorkIssues()).toEqual([]);
      expect([...h.issues.values()]).toEqual([]);
      expect(h.wakeups).toEqual([]);
    });

    it("is decided by the client's id only: a real client whose id merely contains the word canary still gets its issue", async () => {
      await seedClient(h, { id: "acme-canary-1", name: "Canary Holdings", kind: "company" });
      await seedClient(h, { id: "canary", name: "Canary (no dash)", kind: "company" });
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-l1:won", dealId: "deal-l1", clientRef: "acme-canary-1", clientName: "Canary Holdings" }));
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-l2:won", dealId: "deal-l2", clientRef: "canary", clientName: "Canary (no dash)" }));
      expect(await workIssue("billing:deal-won:deal-l1")).toBeDefined();
      expect(await workIssue("billing:deal-won:deal-l2")).toBeDefined();
      expect(h.wakeups).toHaveLength(2);
    });
  });

  // ── the journey itself ───────────────────────────────────────────────────

  describe("the quote-to-invoice journey", () => {
    /**
     * What the woken Account Manager did live with the "Deal won: … convert quote" issue: it converted the accepted quote at once. If a
     * rehearsal woke it, this is what ran before the journey's own `convert-quote` step.
     */
    async function wokenAccountManager(): Promise<void> {
      for (const id of [...h.wakeups]) {
        const issue = h.issues.get(id);
        if (!issue?.originId?.startsWith(WORK_ORIGINS.dealWon)) continue;
        const quoteId = /\(`([^`]+)`\) for this deal is accepted: `convert-quote`/.exec(issue.description ?? "")?.[1];
        if (quoteId) await tool("convert-quote", { quoteId });
      }
    }

    it("accepts, converts and asks for the send approval with no competing issue, and nobody is woken", async () => {
      // The journey's steps, in its order (journeys/quote-to-invoice.json): a quote with a line for the canary, on a deal.
      const made = (await tool("create-quote", { currency: "ZAR", customerKind: "company", customerRef: CANARY, customerName: "PiB Canary Co", customerEmail: "canary@canary.invalid", dealId: "deal-j", notes: "Acceptance canary: never send." })).data as { id: string };
      await tool("add-quote-line", { quoteId: made.id, description: "Canary service", quantity: 1, unitAmountMinor: 100_000 });
      const accepted = await tool("set-quote-status", { quoteId: made.id, status: "accepted" });
      expect(accepted.error).toBeUndefined();
      expect(accepted.data).toMatchObject({ status: "accepted" });
      // Billing tells the CRM (a hand-off, not an issue) ...
      expect(handoffs("quote.accepted")).toHaveLength(1);
      // ... the CRM marks the deal won and sends deal.won back, which is what opened the competing issue live.
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-j:won", dealId: "deal-j", title: "Canary rehearsal", clientRef: CANARY, clientName: "PiB Canary Co" }));
      await wokenAccountManager();

      const converted = await tool("convert-quote", { quoteId: made.id });
      expect(converted.error).toBeUndefined();
      expect(converted.data).toMatchObject({ quote: { status: "converted" }, invoice: { status: "draft" } });
      const invoiceId = String(converted.data.invoice.id);

      const ask = await tool("request-invoice-send", { invoiceId, sendTo: "canary@canary.invalid" });
      expect(ask.error).toBeUndefined();
      expect(ask.data).toMatchObject({ pendingAction: "send" });

      // The only issue is the journey's own send approval (the Cockpit cancels it at the end); nothing else was opened, and nobody woke.
      expect([...h.issues.values()].map((issue) => issue.originId)).toEqual([`${APPROVAL_ORIGINS.invoiceSend}${invoiceId}`]);
      expect(await allWorkIssues()).toEqual([]);
      expect(h.wakeups).toEqual([]);
      // And, as before, it is a draft with a send approval open: nothing was emailed or posted.
      expect((await q(`SELECT status, pending_action, deal_id FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoiceId]))[0]).toMatchObject({ status: "draft", pending_action: "send", deal_id: "deal-j" });
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event IN ('mail.send.requested', 'ledger.post.requested')`)).toEqual([]);
    });

    it("the same journey on a real client does wake the Account Manager (the control: a woken agent that converts first is what broke the journey)", async () => {
      const made = await quote("co-acme", { dealId: "deal-r" });
      await tool("set-quote-status", { quoteId: made.id, status: "accepted" });
      await h.deliver(DEAL_WON, COMPANY, won({ key: "crm:deal:deal-r:won", dealId: "deal-r", clientRef: "co-acme" }));
      expect(h.wakeups).toHaveLength(1);
      await wokenAccountManager();
      const second = await tool("convert-quote", { quoteId: made.id });
      expect(second.error).toContain("Only an accepted quote can be converted");
    });
  });

  // ── the daily digests ────────────────────────────────────────────────────

  describe("Drafts to send", () => {
    it("never lists the canary's old drafts and accepted quote, and never wakes anyone for them; a real draft still does", async () => {
      const canaryInvoice = await draft(CANARY);
      await age("invoices", canaryInvoice.id, 30);
      const canaryContactInvoice = await draft(CANARY_CONTACT, "contact");
      await age("invoices", canaryContactInvoice.id, 30);
      const canaryQuote = await quote(CANARY);
      await age("quotes", canaryQuote.id, 30);
      const canaryAccepted = await quote(CANARY, { dealId: "deal-ca" });
      await h.call("billing.set-quote-status", { quoteId: canaryAccepted.id, status: "accepted" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET accepted_at = now() - interval '2 days' WHERE id = $1`, [canaryAccepted.id]);

      await h.runJob("drafts-to-send");
      expect(await workIssue(`billing:drafts-to-send:${COMPANY}`)).toBeUndefined();
      expect([...h.issues.values()]).toEqual([]);
      expect(h.wakeups).toEqual([]);

      // Control: one real draft among them opens the issue, and it lists the real one only.
      const real = await draft("ct-lumen", "contact");
      await age("invoices", real.id, 30);
      await h.runJob("drafts-to-send");
      const row = (await workIssue(`billing:drafts-to-send:${COMPANY}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue.title).toBe("Drafts to send: 1 invoice waiting");
      expect(issue.description).toContain(`Invoice ${real.number}`);
      for (const number of [canaryInvoice.number, canaryContactInvoice.number, canaryQuote.number, canaryAccepted.number]) expect(issue.description).not.toContain(number);
      expect(h.wakeups).toEqual([row.issue_id]);
    });
  });

  describe("Overdue invoices", () => {
    it("never lists a canary invoice, however overdue, and never wakes anyone for it; a real overdue invoice still does", async () => {
      const canary = await overdue(CANARY, 70);
      const canaryContact = await overdue(CANARY_CONTACT, 8, "contact");
      await h.runJob("overdue-invoices");
      await h.runJob("drafts-to-send"); // also keeps the overdue issue current
      expect(await workIssue(`billing:overdue-invoices:${COMPANY}`)).toBeUndefined();
      expect([...h.issues.values()]).toEqual([]);
      expect(h.wakeups).toEqual([]);

      const real = await overdue("ct-lumen", 8, "contact");
      await h.runJob("overdue-invoices");
      const row = (await workIssue(`billing:overdue-invoices:${COMPANY}`))!;
      const issue = h.issues.get(row.issue_id)!;
      expect(issue.title).toMatch(/^Overdue invoices: 1 /);
      expect(issue.description).toContain(real.number);
      expect(issue.description).not.toContain(canary.number);
      expect(issue.description).not.toContain(canaryContact.number);
      expect(h.wakeups).toEqual([row.issue_id]);
    });
  });

  describe("Reminders", () => {
    it("are never planned, queued or recorded for a canary invoice, by the job or by Send now; a real overdue invoice still gets its reminder", async () => {
      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", dunning: { enabled: true } });
      const canary = await overdue(CANARY, 20);
      const canaryContact = await overdue(CANARY_CONTACT, 20, "contact");
      await h.runJob("dunning");
      expect(await h.call("billing.run-dunning", {})).toMatchObject({ sent: 0, skipped: 0 });
      expect(await reminderRows(canary.id)).toEqual([]);
      expect(await reminderRows(canaryContact.id)).toEqual([]);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`)).toEqual([]);
      const status = await h.call<{ next: Array<{ invoiceId: string }> }>("billing.dunning", {});
      expect(status.next).toEqual([]);

      // Control.
      const real = await overdue("ct-lumen", 20, "contact");
      await h.runJob("dunning");
      expect((await reminderRows(real.id)).length).toBe(1);
      expect(await q(`SELECT 1 FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`)).toHaveLength(1);
      expect(await reminderRows(canary.id)).toEqual([]);
    });
  });

  // ── a reply to a quote ───────────────────────────────────────────────────

  describe("a reply to a quote", () => {
    const reply = (key: string, quoteId: string, number: string) => ({
      key,
      messageId: `gm-${key}`,
      accountAddress: "peet@pib.test",
      threadId: `th-${key}`,
      from: { email: "ap@lumen.test", name: "Thandi" },
      to: [{ email: "peet@pib.test" }],
      subject: `Re: Quote ${number} from Partners in Biz`,
      snippet: "Looks good, we accept.",
      receivedAt: new Date().toISOString(),
      attachments: [],
      replyTo: { plugin: "partnersinbiz.billing", kind: "quote", id: quoteId },
      triage: { category: "reply", urgency: 0.5, needsReply: 0.9, phishing: 0, confidence: 0.8 },
    });

    it("to a canary quote opens no issue and wakes nobody; to a real quote it opens its issue", async () => {
      const canary = await quote(CANARY, { dealId: "deal-c" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [canary.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, reply("mbx:c1", canary.id, canary.number));
      expect(await workIssue(`billing:quote-reply:${canary.id}`)).toBeUndefined();
      expect([...h.issues.values()]).toEqual([]);
      expect(h.wakeups).toEqual([]);

      const real = await quote("co-acme", { dealId: "deal-1" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() WHERE id = $1`, [real.id]);
      await h.deliver(MAIL_RECEIVED, COMPANY, reply("mbx:r1", real.id, real.number));
      const row = (await workIssue(`billing:quote-reply:${real.id}`))!;
      expect(h.issues.get(row.issue_id)).toMatchObject({ assigneeAgentId: "agent-am" });
      expect(h.wakeups).toEqual([row.issue_id]);
    });
  });

  // ── Accounting's bank matching ───────────────────────────────────────────

  describe("open items for Accounting", () => {
    const items = () => h.emitted.filter((e) => e.name === "open-item.upserted").map((e) => e.payload as { key: string; clientRef: string });

    it("never include a canary invoice, so no real bank line can be matched to it; a real sent invoice is still sent", async () => {
      const canary = await draft(CANARY);
      await h.call("billing.mark-sent", { invoiceId: canary.id });
      const canaryContact = await draft(CANARY_CONTACT, "contact");
      await h.call("billing.mark-sent", { invoiceId: canaryContact.id });
      await h.runJob("emit-open-items");
      await h.runJob("emit-open-items-all");
      expect(items()).toEqual([]);

      const real = await draft("ct-lumen", "contact");
      await h.call("billing.mark-sent", { invoiceId: real.id });
      await h.runJob("emit-open-items-all");
      expect(items().map((item) => item.key)).toContain(`invoice:${real.id}`);
      expect(items().map((item) => item.key)).not.toContain(`invoice:${canary.id}`);
      expect(items().map((item) => item.key)).not.toContain(`invoice:${canaryContact.id}`);
    });
  });

  // ── what the Operator reads ──────────────────────────────────────────────

  describe("the Cockpit's stuck figures", () => {
    const snapshot = async (): Promise<CockpitSnapshot> => {
      const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId: COMPANY, headers: {} } as PluginApiRequestInput);
      return res.body as CockpitSnapshot;
    };
    const stage = async (key: string) => (await snapshot()).flows?.find((flow) => flow.stage === key);

    it("count the canary's old drafts, overdue invoices and unanswered quotes as work in hand but never as stuck; a real one is stuck", async () => {
      const canaryDraft = await draft(CANARY);
      await age("invoices", canaryDraft.id, 30);
      const canaryQuote = await quote(CANARY);
      await age("quotes", canaryQuote.id, 30);
      await overdue(CANARY, 10);
      const sentQuote = await quote(CANARY, { dealId: "deal-s" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() - interval '20 days' WHERE id = $1`, [sentQuote.id]);

      expect(await stage("invoice.draft")).toMatchObject({ count: 1, stuck: 0 });
      expect(await stage("quote.draft")).toMatchObject({ count: 1, stuck: 0 });
      expect(await stage("invoice.open")).toMatchObject({ count: 1, stuck: 0 });
      expect(await stage("quote.sent")).toMatchObject({ count: 1, stuck: 0 });
      const kpis = (await snapshot()).kpis;
      expect(kpis.find((k) => k.key === "overdue")).toMatchObject({ value: "None", tone: "ok" });

      // Control: the same things for a real client are stuck.
      const realDraft = await draft("ct-lumen", "contact");
      await age("invoices", realDraft.id, 30);
      const realQuote = await quote("co-acme");
      await age("quotes", realQuote.id, 30);
      await overdue("ct-lumen", 10, "contact");
      const realSent = await quote("co-acme", { dealId: "deal-t" });
      await h.client.query(`UPDATE ${NAMESPACE}.quotes SET status = 'sent', sent_at = now() - interval '20 days' WHERE id = $1`, [realSent.id]);
      expect(await stage("invoice.draft")).toMatchObject({ count: 2, stuck: 1 });
      expect(await stage("quote.draft")).toMatchObject({ count: 2, stuck: 1 });
      expect(await stage("invoice.open")).toMatchObject({ count: 2, stuck: 1 });
      expect(await stage("quote.sent")).toMatchObject({ count: 2, stuck: 1 });
      expect((await snapshot()).kpis.find((k) => k.key === "overdue")?.tone).toBe("bad");
    });
  });
});
