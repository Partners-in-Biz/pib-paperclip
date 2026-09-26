/**
 * Company Cockpit: the snapshot route (unconfigured and configured), health
 * states, waiting items, the hourly push, and Reviewer routing for sending
 * invoices and quotes (only a person's completion counts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const ROLES = "plugin.partnersinbiz.cockpit.roles.updated";
const MODULES_UPDATED = "plugin.partnersinbiz.setup.modules.updated";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("manifest", () => {
  it("declares the cockpit route", () => {
    expect(manifest.apiRoutes).toContainEqual(COCKPIT_ROUTE);
    expect(manifest.version).toBe("0.3.2");
  });
});

describe.skipIf(!available)("billing cockpit (postgres)", () => {
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
  });

  const route = async (companyId = COMPANY): Promise<CockpitSnapshot> => {
    const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId, headers: {} } as PluginApiRequestInput);
    expect(res.status).toBe(200);
    return res.body as CockpitSnapshot;
  };
  const kpi = (s: CockpitSnapshot, key: string) => s.kpis.find((k) => k.key === key)!;
  const health = (s: CockpitSnapshot, key: string) => s.health.find((c) => c.key === key)!;

  async function draft(customerRef = "ct-lumen", unitAmountMinor = 100_000) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor });
    return invoice;
  }

  async function sent(customerRef = "ct-lumen", unitAmountMinor = 100_000) {
    const invoice = await draft(customerRef, unitAmountMinor);
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  async function setRoles(input: { reviewerAgentId: string | null; reviewOutward: boolean }) {
    await h.deliver(ROLES, COMPANY, { companyId: COMPANY, operatorAgentId: null, ownerUserId: "user-1", updatedAt: new Date().toISOString(), ...input });
  }

  it("works before settings are saved: a settings warning, zero money, jobs not run yet", async () => {
    const s = await route();
    expect(s).toMatchObject({ plugin: "partnersinbiz.billing", title: "Billing" });
    expect(health(s, "settings")).toMatchObject({ status: "warn", href: "/setup" });
    expect(kpi(s, "outstanding")).toMatchObject({ value: "R 0.00", raw: 0, group: "money" });
    expect(kpi(s, "overdue")).toMatchObject({ value: "None", tone: "ok" });
    expect(health(s, "job:mark-overdue")).toMatchObject({ status: "ok", detail: "Has not run yet." });
    expect(health(s, "outbox").status).toBe("ok");
    expect(s.waiting).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.health.find((c) => c.key === "snapshot")).toBeUndefined();
  });

  it("shows the money, waiting approvals, activity and problems for a configured company", async () => {
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });

    const late = await sent("ct-lumen", 100_000); // R 1,150.00 with VAT
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '5 days' WHERE id = $1`, [late.id]);
    const paid = await sent("ct-lumen", 20_000); // R 230.00
    await h.call("billing.record-payment", { invoiceId: paid.id, amountMinor: 23_000 });
    const waitingSend = await draft("ct-lumen", 50_000);
    const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: waitingSend.id });
    await h.call("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.bills (id, company_id, supplier_name, status, currency, total_minor, due_date) VALUES ('bill-1', $1, 'AWS', 'approved', 'ZAR', 30000, current_date + 3)`,
      [COMPANY],
    );
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.pops (id, company_id, invoice_id, source, status, received_at) VALUES ('pop-old', $1, $2, 'upload', 'pending', now() - interval '4 days')`,
      [COMPANY, late.id],
    );
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.decision_issues (issue_id, company_id, kind, subject_kind, subject_id) VALUES ('issue-pop', $1, 'pop', 'pop', 'pop-old')`,
      [COMPANY],
    );
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.deliveries (key, company_id, doc_kind, doc_id, subject, status) VALUES ('d1', $1, 'invoice', $2, 'Invoice', 'failed')`,
      [COMPANY, late.id],
    );
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET ledger_status = 'rejected' WHERE id = $1`, [late.id]);

    const s = await route();
    expect(s.health.find((c) => c.key === "settings")).toBeUndefined();
    expect(kpi(s, "outstanding")).toMatchObject({ value: "R 1,150.00", raw: 115_000 });
    expect(kpi(s, "overdue")).toMatchObject({ value: "1 · R 1,150.00", raw: 115_000, tone: "bad" });
    expect(kpi(s, "received_month")).toMatchObject({ value: "R 230.00", raw: 23_000 });
    expect(kpi(s, "open_quotes")).toMatchObject({ raw: 1 });
    expect(kpi(s, "bills_due")).toMatchObject({ value: "1 · R 300.00", tone: "warn" });
    expect(kpi(s, "mrr")).toMatchObject({ raw: 0 });

    expect(health(s, "pops")).toMatchObject({ status: "warn" });
    expect(health(s, "sends")).toMatchObject({ status: "warn" });
    expect(health(s, "ledger")).toMatchObject({ status: "bad" });

    expect(s.waiting).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `approval:${issueId}`, issueId, kind: "review", href: `/issues/${issueId}`, title: `Approve sending invoice ${waitingSend.number}` }),
      expect.objectContaining({ key: "pop:issue-pop", issueId: "issue-pop", kind: "money" }),
    ]));
    expect(s.activity.length).toBeGreaterThanOrEqual(3);
    expect(s.activity.map((a) => a.text)).toEqual(expect.arrayContaining([
      `Sent invoice ${late.number} to Lumen Digital (R 1,150.00)`,
      `Received R 230.00 for invoice ${paid.number} from Lumen Digital`,
    ]));
    expect(s.quality.map((q) => q.key)).toEqual(["approvals_rejected", "decisions_corrected"]);
  });

  it("keeps the rest of the snapshot when one query fails", async () => {
    h.config.set(COMPANY, { ...SETTINGS });
    const real = h.ctx.db.query;
    (h.ctx.db as { query: typeof real }).query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("recurring_invoices")) throw new Error("boom");
      return real(sql, params);
    }) as typeof real;
    try {
      const s = await route();
      expect(s.kpis.find((k) => k.key === "mrr")).toBeUndefined();
      expect(kpi(s, "outstanding")).toBeDefined();
      expect(health(s, "snapshot")).toMatchObject({ status: "warn" });
      expect(health(s, "snapshot").detail).toContain("boom");
    } finally {
      (h.ctx.db as { query: typeof real }).query = real;
    }
  });

  it("records job runs and reports failing jobs", async () => {
    h.config.set(COMPANY, { ...SETTINGS });
    await h.runJob("mark-overdue");
    const rec = h.state.get("instance::pib-cockpit-jobs:job:mark-overdue") as { lastOkAt: string | null };
    expect(rec.lastOkAt).toBeTruthy();
    h.state.set("instance::pib-cockpit-jobs:job:dunning", { lastStartedAt: null, lastOkAt: null, lastErrorAt: new Date().toISOString(), lastError: "Mailbox down", consecutiveFailures: 3 });
    const s = await route();
    expect(health(s, "job:mark-overdue").status).toBe("ok");
    expect(health(s, "job:dunning")).toMatchObject({ status: "bad", detail: "Last error: Mailbox down" });
  });

  it("pushes the snapshot hourly only for companies with Billing on and settings saved", async () => {
    h.config.set(COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    // A second company the plugin knows but whose settings were never saved.
    await h.client.query(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, updated_at) VALUES ('ct-x', $1, 'X', now())`, [OTHER]);
    await h.runJob("mark-overdue");
    const pushed = h.emitted.filter((e) => e.name === "cockpit.snapshot");
    expect(pushed.map((e) => e.companyId)).toEqual([COMPANY]);
    expect(pushed[0]!.payload).toMatchObject({ plugin: "partnersinbiz.billing" });

    h.emitted.length = 0;
    await h.deliver(MODULES_UPDATED, COMPANY, { companyId: COMPANY, modules: { billing: false }, updatedAt: new Date().toISOString() });
    await h.runJob("mark-overdue");
    expect(h.emitted.filter((e) => e.name === "cockpit.snapshot")).toEqual([]);
  });

  describe("Reviewer routing", () => {
    beforeEach(async () => {
      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9" });
      await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    });

    it("sends invoice and quote send approvals to the person when there is no Reviewer", async () => {
      const invoice = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      const issue = h.issues.get(issueId)!;
      expect(issue).toMatchObject({ assigneeUserId: "user-9", assigneeAgentId: null });
      expect(issue.description).not.toContain("Reviewer");
    });

    it("assigns send approvals to the Reviewer with checks, but payment approvals to the person", async () => {
      await setRoles({ reviewerAgentId: "agent-rev", reviewOutward: true });
      const invoice = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      const issue = h.issues.get(issueId)!;
      expect(issue).toMatchObject({ assigneeAgentId: "agent-rev", assigneeUserId: null });
      expect(issue.description).toContain("## Reviewer: check before the person approves");
      for (const word of ["VAT", "Due date", "Bank details", "PDF attached", "Email wording", "Recipients"]) expect(issue.description).toContain(word);
      expect(issue.description).toContain("user user-9");

      const quote = await h.call<{ id: string }>("billing.create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
      await h.call("billing.add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 10_000 });
      const q = await h.call<{ issueId: string }>("billing.request-quote-send", { quoteId: quote.id });
      expect(h.issues.get(q.issueId)).toMatchObject({ assigneeAgentId: "agent-rev" });

      const other = await sent();
      const pay = await h.call<{ issueId: string }>("billing.request-pay", { invoiceId: other.id });
      expect(h.issues.get(pay.issueId)).toMatchObject({ assigneeUserId: "user-9", assigneeAgentId: null });
    });

    it("ignores the Reviewer when outward review is off", async () => {
      await setRoles({ reviewerAgentId: "agent-rev", reviewOutward: false });
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: (await draft()).id });
      expect(h.issues.get(issueId)).toMatchObject({ assigneeUserId: "user-9", assigneeAgentId: null });
    });

    it("only counts the approval when a person completes it", async () => {
      await setRoles({ reviewerAgentId: "agent-rev", reviewOutward: true });
      const invoice = await draft();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: invoice.id });
      const mails = async () => (await h.client.query(`SELECT key FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`)).rows;

      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, actorType: "agent", actorId: "agent-rev" });
      expect(await mails()).toHaveLength(0);
      expect(h.issues.get(issueId)).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-9" });

      h.issues.get(issueId)!.status = "done";
      await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, actorType: "user", actorId: "user-9" });
      expect(await mails()).toHaveLength(1);
    });
  });
});
