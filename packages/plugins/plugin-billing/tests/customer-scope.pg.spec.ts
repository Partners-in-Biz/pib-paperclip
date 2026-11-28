/**
 * Access stage B-4 (plan B-D6, PAR-15206): under `enforce` a limited person with an own-companies grant sees and
 * changes Billing records of his companies' customers only. His companies come from the CRM copy (`managers`, sent
 * with company.upserted). A guessed id, another company's invoice, quote, PDF, statement, payment link or client
 * summary is refused; lists hold his only; creating for another company, or for a typed name with no CRM record, is
 * refused. With the switch off (and in `report`) everything is as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { customerRefusal, OUTSIDE_SCOPE, SCOPE_UNVERIFIED } from "../src/customer-scope.js";
import { COMPANY, embeddedAvailable, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const OWNER = "b4000000-0000-4000-8000-0000000000a1";
const LIMITED = "b4000000-0000-4000-8000-0000000000a2";
const OTHER_MANAGER = "b4000000-0000-4000-8000-0000000000a3";
const MINE = "crm-co-mine";
const OTHER = "crm-co-other";
const GUESSED = "b4000000-0000-4000-8000-00000000dead";
const GRANT = [
  "billing.invoices:view", "billing.invoices:create", "billing.invoices:edit", "billing.invoices:approve",
  "billing.quotes:view", "billing.quotes:create", "billing.quotes:edit", "billing.time:view", "billing.time:create",
  "billing.time:edit", "billing.time:delete", "billing.plans:view", "billing.plans:create", "billing.plans:edit",
];

const as = (userId: string) => ({ companyId: COMPANY, actor: { type: "user" as const, userId, agentId: null, runId: null, companyId: COMPANY } });
const refused = (answer: unknown) => isRefusal(answer) && (answer as { message: string }).message;

describe.skipIf(!available)("Billing records scoped to a limited person's own companies (postgres)", () => {
  let h: Harness;
  let tick = 0;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  async function company(id: string, name: string, managers: { ownerUserId: string | null; managerUserIds: string[] }) {
    tick += 1;
    await h.deliver("plugin.partnersinbiz.crm.company.upserted", COMPANY, { id, name, domain: null, lifecycle: null, updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, tick)).toISOString(), managers });
  }
  async function contact(id: string, name: string, accountIds: string[]) {
    tick += 1;
    await h.deliver("plugin.partnersinbiz.crm.contact.upserted", COMPANY, { id, name, emails: [`${id}@example.test`], phones: [], tags: [], accountIds, updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, tick)).toISOString() });
  }
  const mode = (m: "off" | "report" | "enforce") => h.ctx.state.set(accessCompanyScope(COMPANY), { mode: m, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  const invoice = async (kind: "company" | "contact", ref: string) =>
    ((await h.call("billing.create-invoice", { currency: "ZAR", customerKind: kind, customerRef: ref }, as(OWNER))) as { id: string }).id;
  const quote = async (ref: string) => ((await h.call("billing.create-quote", { currency: "ZAR", customerKind: "company", customerRef: ref }, as(OWNER))) as { id: string }).id;

  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, SETTINGS);
    h.members.length = 0;
    h.members.push(
      { companyId: COMPANY, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: COMPANY, principalType: "user", principalId: LIMITED, status: "active", membershipRole: "member" },
    );
    // No scope override: every scopable Billing area is limited to his own companies.
    await h.ctx.state.set(accessGrantScope(COMPANY, LIMITED), { allow: GRANT, deny: [], scopeOverrides: {} });
    await company(MINE, "Mine Ltd", { ownerUserId: LIMITED, managerUserIds: [] });
    await company(OTHER, "Other Ltd", { ownerUserId: OTHER_MANAGER, managerUserIds: [] });
    await contact("ct-mine", "Mia Mine", [MINE]);
    await contact("ct-other", "Otto Other", [OTHER]);
    await mode("off");
    ids.mine = await invoice("company", MINE);
    ids.contact = await invoice("contact", "ct-mine");
    ids.other = await invoice("company", OTHER);
    ids.otherContact = await invoice("contact", "ct-other");
    ids.quoteMine = await quote(MINE);
    ids.quoteOther = await quote(OTHER);
  });

  it("the CRM copy keeps who manages a company", async () => {
    const rows = await h.client.query(`SELECT id, managers FROM plugin_billing_287195dc99.crm_companies ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: MINE, managers: { ownerUserId: LIMITED, managerUserIds: [] } },
      { id: OTHER, managers: { ownerUserId: OTHER_MANAGER, managerUserIds: [] } },
    ]);
  });

  it("lists hold his companies' customers only (a contact of his company counts); costs and standing issues are left out", async () => {
    await mode("enforce");
    const page = (await h.call("billing.load", {}, as(LIMITED))) as { invoices: Array<{ id: string }>; quotes: Array<{ id: string }>; clients: Array<{ id: string }>; bills: unknown[]; expenses: unknown[]; workIssues: unknown[] };
    expect(page.invoices.map((i) => i.id).sort()).toEqual([ids.mine, ids.contact].sort());
    expect(page.quotes.map((q) => q.id)).toEqual([ids.quoteMine]);
    expect(page.clients.map((c) => c.id).sort()).toEqual(["ct-mine", MINE].sort());
    expect([page.bills, page.expenses, page.workIssues]).toEqual([[], [], []]);
    expect(((await h.call("billing.list-quotes", {}, as(LIMITED))) as Array<{ id: string }>).map((q) => q.id)).toEqual([ids.quoteMine]);
    // The owner still sees the whole book under enforce.
    expect(((await h.call("billing.load", {}, as(OWNER))) as { invoices: unknown[] }).invoices).toHaveLength(4);
  });

  /**
   * One row of each listed kind for his company and for the other company, plus PiB's own costs and standing work.
   * Each list must hold his row and leave out the other company's (review on PAR-15206: every filter needs a failing test).
   */
  async function seedEveryList() {
    const sql = (text: string, values: unknown[]) => h.client.query(text.replaceAll("NS.", "plugin_billing_287195dc99."), values);
    await sql(`UPDATE NS.invoices SET status = 'sent', number = 'INV-' || left(id, 6) WHERE id = ANY($1)`, [[ids.mine, ids.other]]);
    const rows: Record<string, { mine: string; other: string }> = {};
    const both = async (name: string, insert: (id: string, invoiceId: string, kind: string, ref: string) => Promise<unknown>) => {
      rows[name] = { mine: `${name}-mine`, other: `${name}-other` };
      await insert(rows[name].mine, ids.mine, "company", MINE);
      await insert(rows[name].other, ids.other, "company", OTHER);
    };
    await both("cn", (id, invoiceId, kind, ref) =>
      sql(`INSERT INTO NS.credit_notes (id, company_id, invoice_id, amount_minor, currency, customer_kind, customer_ref) VALUES ($1, $2, $3, 100, 'ZAR', $4, $5)`, [id, COMPANY, invoiceId, kind, ref]));
    await both("pop", (id, invoiceId) => sql(`INSERT INTO NS.pops (id, company_id, source, invoice_id) VALUES ($1, $2, 'upload', $3)`, [id, COMPANY, invoiceId]));
    await both("sub", (id, _invoiceId, kind, ref) =>
      sql(`INSERT INTO NS.subscriptions (id, company_id, customer_kind, customer_ref, customer_name, description, price_minor, currency, next_invoice_at) VALUES ($1, $2, $3, $4, $1, 'retainer', 1000, 'ZAR', now() + interval '30 days')`, [id, COMPANY, kind, ref]));
    await both("dec", (id, invoiceId) => {
      // An open host issue, or the stale-approval sweep in load closes the decision.
      h.issues.set(id, { id, companyId: COMPANY, title: "Record payment", status: "todo" });
      return sql(`INSERT INTO NS.decision_issues (issue_id, company_id, kind, subject_kind, subject_id, payload) VALUES ($1, $2, 'payment', 'invoice', $3, $4)`, [id, COMPANY, invoiceId, JSON.stringify({ invoiceId, amountMinor: 100, currency: "ZAR", number: "INV" })]);
    });
    await sql(`INSERT INTO NS.expenses (id, company_id, description, amount_minor) VALUES ('exp-1', $1, 'PiB rent', 5000)`, [COMPANY]);
    await sql(`INSERT INTO NS.bills (id, company_id, supplier_name) VALUES ('bill-1', $1, 'PiB supplier')`, [COMPANY]);
    await sql(`INSERT INTO NS.work_issues (key, company_id, kind, issue_id) VALUES ('wi-1', $1, 'deal_won', 'issue-wi-1')`, [COMPANY]);
    const time = async (client: string) => ((await h.call("billing.log-time", { client, description: "work", minutes: 30 }, as(OWNER))) as { id: string }).id;
    rows.time = { mine: await time(`company:${MINE}`), other: await time(`contact:ct-other`) };
    const recurring = async (templateInvoiceId: string) =>
      ((await h.call("billing.create-recurring", { templateInvoiceId, frequency: "monthly", nextRunAt: "2027-01-01T00:00:00Z" }, as(OWNER))) as { id: string }).id;
    rows.rec = { mine: await recurring(ids.mine), other: await recurring(ids.other) };
    rows.inv = { mine: ids.mine, other: ids.other };
    return rows;
  }
  const idsOf = (list: unknown) => (list as Array<{ id?: string; issueId?: string; invoiceId?: string }>).map((row) => row.id ?? row.issueId ?? row.invoiceId);

  it("every list holds his row and not the other company's; PiB's own costs and standing work are empty for him", async () => {
    const rows = await seedEveryList();
    const only = (list: unknown, kind: string, what: string) => {
      const got = idsOf(list);
      expect(got, `${what}: his row`).toContain(rows[kind]!.mine);
      expect(got, `${what}: other company's row`).not.toContain(rows[kind]!.other);
    };
    await mode("enforce");
    const page = (await h.call("billing.load", {}, as(LIMITED))) as Record<string, unknown> & { retainers: { subscriptions: unknown } };
    only(page.invoices, "inv", "load invoices");
    only(page.creditNotes, "cn", "load creditNotes");
    only(page.pops, "pop", "load pops");
    only(page.time, "time", "load time");
    only(page.recurring, "rec", "load recurring");
    only(page.retainers.subscriptions, "sub", "load retainers.subscriptions");
    only(page.decisions, "dec", "load decisions");
    expect({ expenses: page.expenses, bills: page.bills, workIssues: page.workIssues }).toEqual({ expenses: [], bills: [], workIssues: [] });
    only(await h.call("billing.open-invoices", {}, as(LIMITED)), "inv", "open-invoices");
    only(await h.call("billing.list-credit-notes", {}, as(LIMITED)), "cn", "list-credit-notes");
    only(await h.call("billing.pops", {}, as(LIMITED)), "pop", "pops");
    only(((await h.call("billing.retainers", {}, as(LIMITED))) as { subscriptions: unknown }).subscriptions, "sub", "retainers");
    only(await h.call("billing.list-time", {}, as(LIMITED)), "time", "list-time");
    only(await h.call("billing.list-recurring", {}, as(LIMITED)), "rec", "list-recurring");
    // The same data for the owner: every row, and the costs and standing work are there (so the empties above mean something).
    const all = (await h.call("billing.load", {}, as(OWNER))) as Record<string, unknown[]> & { retainers: { subscriptions: unknown[] } };
    for (const [key, kind] of [["creditNotes", "cn"], ["pops", "pop"], ["time", "time"], ["recurring", "rec"], ["decisions", "dec"]] as const) {
      expect(idsOf(all[key]), key).toEqual(expect.arrayContaining([rows[kind]!.mine, rows[kind]!.other]));
    }
    expect(idsOf(all.retainers.subscriptions)).toEqual(expect.arrayContaining([rows.sub!.mine, rows.sub!.other]));
    expect([all.expenses.length, all.bills.length, all.workIssues.length]).toEqual([1, 1, 1]);
    expect(idsOf(await h.call("billing.open-invoices", {}, as(OWNER)))).toEqual(expect.arrayContaining([ids.mine, ids.other]));
  });

  it("each record kind resolves to its customer: credit note, POP, payment link, subscription, running timer, quote follow-up, upload purpose", async () => {
    const rows = await seedEveryList();
    const sql = (text: string, values: unknown[]) => h.client.query(text.replaceAll("NS.", "plugin_billing_287195dc99."), values);
    for (const [id, invoiceId] of [["link-mine", ids.mine], ["link-other", ids.other]] as const) {
      await sql(`INSERT INTO NS.payment_links (id, company_id, invoice_id, provider, amount_minor, currency, status) VALUES ($1, $2, $3, 'mock', 100, 'ZAR', 'cancelled')`, [id, COMPANY, invoiceId]);
    }
    // A running timer of the other company's client, started by him (the owner logs it in his name).
    await sql(`INSERT INTO NS.time_entries (id, company_id, owner, description, customer_kind, customer_ref, customer_name, started_at, currency) VALUES ('timer-other', $1, $2, 'call', 'company', $3, 'Other Ltd', now(), 'ZAR')`, [COMPANY, `user:${LIMITED}`, OTHER]);
    await mode("enforce");
    const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["billing.credit-note-pdf", { creditNoteId: rows.cn!.other }, { creditNoteId: rows.cn!.mine }],
      ["billing.pop-file", { popId: rows.pop!.other }, { popId: rows.pop!.mine }],
      ["billing.cancel-payment-link", { linkId: "link-other" }, { linkId: "link-mine" }],
      ["billing.set-subscription-status", { subscriptionId: rows.sub!.other, status: "paused" }, { subscriptionId: rows.sub!.mine, status: "paused" }],
      ["billing.log-follow-up", { quoteId: ids.quoteOther, note: "called" }, { quoteId: ids.quoteMine, note: "called" }],
    ];
    for (const [key, theirs, his] of pairs) {
      expect(refused(await h.call(key, theirs, as(LIMITED))), `${key} other`).toBe(OUTSIDE_SCOPE);
      // His own record passes the scope check (the handler may still refuse for its own reasons, never with the scope answer).
      expect(refused(await h.call(key, his, as(LIMITED)).catch((error: Error) => error.message)), `${key} his`).not.toBe(OUTSIDE_SCOPE);
    }
    expect(refused(await h.call("billing.stop-timer", {}, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.stop-timer", { entryId: "timer-other" }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.upload-url", { purpose: "receipt", mime: "application/pdf", bytes: 10 }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.upload-url", { purpose: "pop", mime: "application/pdf", bytes: 10 }, as(LIMITED)).catch((error: Error) => error.message))).not.toBe(OUTSIDE_SCOPE);
  });

  it("time entries and recurring schedules: his lists, his records only", async () => {
    const time = async (client: string) => ((await h.call("billing.log-time", { client, description: "work", minutes: 30 }, as(OWNER))) as { id: string }).id;
    const recurring = async (templateInvoiceId: string) =>
      ((await h.call("billing.create-recurring", { templateInvoiceId, frequency: "monthly", nextRunAt: "2027-01-01T00:00:00Z" }, as(OWNER))) as { id: string }).id;
    const t = { mine: await time(`company:${MINE}`), other: await time(`contact:ct-other`) };
    const r = { mine: await recurring(ids.mine), other: await recurring(ids.other) };
    await mode("enforce");
    expect(((await h.call("billing.list-time", {}, as(LIMITED))) as Array<{ id: string }>).map((e) => e.id)).toEqual([t.mine]);
    expect(((await h.call("billing.list-recurring", {}, as(LIMITED))) as Array<{ id: string }>).map((e) => e.id)).toEqual([r.mine]);
    expect(refused(await h.call("billing.delete-time-entry", { entryId: t.other }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.pause-recurring", { recurringId: r.other }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.bill-time", { invoiceId: ids.mine, entryIds: [t.mine, t.other] }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(isRefusal(await h.call("billing.pause-recurring", { recurringId: r.mine }, as(LIMITED)))).toBe(false);
  });

  it("a guessed id and another company's invoice, quote, PDF, statement and payment links are refused with one answer", async () => {
    await mode("enforce");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["billing.invoice-detail", { invoiceId: ids.other }],
      ["billing.invoice-detail", { invoiceId: ids.otherContact }],
      ["billing.invoice-detail", { invoiceId: GUESSED }],
      ["billing.invoice-pdf", { invoiceId: ids.other }],
      ["billing.invoice-html", { invoiceId: ids.other }],
      ["billing.document-pdf", { kind: "invoice", id: ids.other }],
      ["billing.document-pdf", { kind: "quote", id: ids.quoteOther }],
      ["billing.quote-detail", { quoteId: ids.quoteOther }],
      ["billing.quote-detail", { quoteId: GUESSED }],
      ["billing.statement-pdf", { client: `company:${OTHER}` }],
      ["billing.statement-pdf", {}],
      ["billing.customer-credit", { client: `contact:ct-other` }],
      ["billing.payment-links", { invoiceId: ids.other }],
      ["billing.payment-links", {}],
      ["billing.add-line", { invoiceId: ids.other, description: "x", quantity: 1, unitAmountMinor: 100 }],
      ["billing.record-payment", { invoiceId: ids.other, amountMinor: 100 }],
      ["billing.load", { client: `company:${OTHER}` }],
      ["billing.log-follow-up", { invoiceId: ids.other, note: "called" }],
    ];
    for (const [key, params] of calls) expect(refused(await h.call(key, params, as(LIMITED))), `${key} ${JSON.stringify(params)}`).toBe(OUTSIDE_SCOPE);
    // His own open as before.
    for (const invoiceId of [ids.mine, ids.contact]) {
      const detail = (await h.call("billing.invoice-detail", { invoiceId }, as(LIMITED))) as { invoice: { id: string } };
      expect(detail.invoice.id).toBe(invoiceId);
    }
    expect(isRefusal(await h.call("billing.quote-detail", { quoteId: ids.quoteMine }, as(LIMITED)))).toBe(false);
  });

  it("creating an invoice or quote for another company, or for a typed name with no CRM record, is refused; his own company works", async () => {
    await mode("enforce");
    const create = (key: string, params: Record<string, unknown>) => h.call(key, { currency: "ZAR", ...params }, as(LIMITED));
    expect(refused(await create("billing.create-invoice", { customerKind: "company", customerRef: OTHER }))).toBe(OUTSIDE_SCOPE);
    expect(refused(await create("billing.create-invoice", { customerKind: "contact", customerRef: "ct-other" }))).toBe(OUTSIDE_SCOPE);
    expect(refused(await create("billing.create-invoice", { customerKind: "company", customerRef: "crm-not-there", customerName: "Typed Name" }))).toBe(OUTSIDE_SCOPE);
    expect(refused(await create("billing.create-quote", { customerKind: "company", customerRef: OTHER }))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.convert-quote", { quoteId: ids.quoteOther }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.log-time", { client: `company:${OTHER}`, description: "x", minutes: 30 }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    expect(refused(await h.call("billing.log-time", { description: "no client", minutes: 30 }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    const made = (await create("billing.create-invoice", { customerKind: "company", customerRef: MINE })) as { id: string };
    expect(isRefusal(made)).toBe(false);
    expect(typeof made.id).toBe("string");
  });

  it("an agent tool for him is refused the same way (tool result, not data)", async () => {
    await mode("enforce");
    const tool = h.tools.get("create-invoice")!;
    const run = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "p", onBehalfOfUserId: LIMITED, onBehalfOfRestricted: true };
    const answer = (await tool({ currency: "ZAR", customerKind: "company", customerRef: OTHER }, run)) as { error?: string };
    expect(answer.error).toContain(OUTSIDE_SCOPE);
    const detail = (await h.tools.get("invoice-detail")!({ invoiceId: ids.mine }, run)) as { error?: string };
    expect(detail.error).toBeUndefined();
  });

  it("client-summary refuses a client that is not his (403, the refusal form) and answers for his", async () => {
    await mode("enforce");
    const route = (kind: string, id: string) =>
      plugin.definition.onApiRequest!({ routeKey: "client-summary", method: "GET", path: "/client-summary", params: {}, query: { kind, id }, body: null, actor: { actorType: "user", actorId: LIMITED, userId: LIMITED }, companyId: COMPANY, headers: {} } as never);
    const other = await route("company", OTHER);
    expect(other.status).toBe(403);
    expect(refused(other.body)).toBe(OUTSIDE_SCOPE);
    expect((await route("contact", "ct-other")).status).toBe(403);
    expect((await route("company", MINE)).status).toBe(200);
    expect((await route("contact", "ct-mine")).status).toBe(200);
  });

  it("fails closed: a failed read of his contacts refuses the action, the tool and client-summary; a malformed client or a key without a rule is refused", async () => {
    await mode("enforce");
    const query = h.ctx.db.query.bind(h.ctx.db);
    Object.assign(h.ctx.db, { query: async (sql: string, params?: unknown[]) => (sql.includes("account_ids &&") ? Promise.reject(new Error("db down")) : query(sql, params)) });
    try {
      expect(refused(await h.call("billing.invoice-detail", { invoiceId: ids.mine }, as(LIMITED)))).toBe(SCOPE_UNVERIFIED);
      const run = { agentId: "agent-1", runId: "run-1", companyId: COMPANY, projectId: "p", onBehalfOfUserId: LIMITED, onBehalfOfRestricted: true };
      expect(((await h.tools.get("invoice-detail")!({ invoiceId: ids.mine }, run)) as { error?: string }).error).toContain(SCOPE_UNVERIFIED);
      const summary = await plugin.definition.onApiRequest!({ routeKey: "client-summary", method: "GET", path: "/client-summary", params: {}, query: { kind: "company", id: MINE }, body: null, actor: { actorType: "user", actorId: LIMITED, userId: LIMITED }, companyId: COMPANY, headers: {} } as never);
      expect([summary.status, refused(summary.body)]).toEqual([403, SCOPE_UNVERIFIED]);
      // The owner is not limited, so nothing is read for him.
      expect(isRefusal(await h.call("billing.invoice-detail", { invoiceId: ids.mine }, as(OWNER)))).toBe(false);
    } finally {
      Object.assign(h.ctx.db, { query });
    }
    expect(refused(await h.call("billing.statement-pdf", { client: "junk" }, as(LIMITED)))).toBe(OUTSIDE_SCOPE);
    const scope = { companyIds: new Set([MINE]), contactIds: new Set<string>() };
    expect(await customerRefusal(h.ctx, COMPANY, "billing.no-rule", {}, as(LIMITED) as never, scope)).toBe(OUTSIDE_SCOPE);
    expect(await customerRefusal(h.ctx, COMPANY, "billing.invoice-detail", { invoiceId: ids.mine }, as(LIMITED) as never, scope)).toBeNull();
  });

  it("company-wide invoice areas stay closed to him although he may view invoices (dunning, Planning Canvas cards, all payment links)", async () => {
    await mode("enforce");
    for (const key of ["billing.dunning", "billing.run-dunning", "billing.set-dunning-optout", "canvas.cards.search"]) {
      expect(refused(await h.call(key, {}, as(LIMITED))), key).toMatch(/limited to your own companies/);
    }
    expect(refused(await h.call("billing.payment-links", {}, as(LIMITED)))).toBe(OUTSIDE_SCOPE); // the whole company's links
  });

  it("a company the CRM adds him to opens on the next call", async () => {
    await mode("enforce");
    expect(isRefusal(await h.call("billing.invoice-detail", { invoiceId: ids.other }, as(LIMITED)))).toBe(true);
    await company(OTHER, "Other Ltd", { ownerUserId: OTHER_MANAGER, managerUserIds: [LIMITED] });
    expect(isRefusal(await h.call("billing.invoice-detail", { invoiceId: ids.other }, as(LIMITED)))).toBe(false);
  });

  it("switch off and report: the same person gets today's answers (parity)", async () => {
    for (const [i, m] of (["off", "report"] as const).entries()) {
      await mode(m);
      const page = (await h.call("billing.load", {}, as(LIMITED))) as { invoices: unknown[]; quotes: unknown[] };
      expect([m, page.invoices.length, page.quotes.length]).toEqual([m, 4 + i, 2]);
      expect(isRefusal(await h.call("billing.invoice-detail", { invoiceId: ids.other }, as(LIMITED)))).toBe(false);
      const made = await h.call("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: OTHER }, as(LIMITED));
      expect(isRefusal(made)).toBe(false);
    }
  });
});
