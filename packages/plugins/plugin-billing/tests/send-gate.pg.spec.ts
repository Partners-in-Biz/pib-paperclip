/**
 * Billing send gate (PAR-6993): only a person's "done" sends an invoice; a failure before the mail is queued reopens the ticket
 * and leaves the invoice unsent with its number; no email goes out without the PDF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const RESULT = "plugin.partnersinbiz.mailbox.mail.send.result";
const R2 = { accountId: "acc", bucket: "private-docs", accessKeyId: "AK", secretAccessKey: "sk-raw", prefix: "billing" };

describe.skipIf(!available)("invoice send gate (postgres)", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  beforeAll(async () => { h = await startHarness(); await plugin.definition.setup(h.ctx); }, 60_000);
  afterAll(async () => { globalThis.fetch = realFetch; await h?.stop(); });
  beforeEach(async () => {
    globalThis.fetch = realFetch;
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", r2: R2 });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
  });

  const okR2 = () => { globalThis.fetch = vi.fn(async () => new Response()) as any; };
  const badR2 = () => { globalThis.fetch = vi.fn(async () => { throw new Error("r2 down"); }) as any; };
  const row = async (id: string) => (await h.client.query(`SELECT * FROM ${NAMESPACE}.invoices WHERE id = $1`, [id])).rows[0] as any;
  const count = async (sql: string) => Number(((await h.client.query(sql)).rows[0] as any).n);
  const mails = () => count(`SELECT count(*) AS n FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`);
  const deliveries = () => count(`SELECT count(*) AS n FROM ${NAMESPACE}.deliveries`);
  async function request() {
    const inv = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: inv.id, description: "work", quantity: 1, unitAmountMinor: 100_000 });
    const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: inv.id });
    return { id: inv.id, issueId };
  }
  async function close(issueId: string, actorType?: string) {
    const issue = h.issues.get(issueId)!;
    issue.status = "done";
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, entityType: "issue", ...(actorType ? { actorType: actorType as any } : {}), actorId: "x" });
  }
  const reopens = (issueId: string) => h.comments.filter((c) => c.issueId === issueId).length;

  it.each(["agent", "system", "plugin", undefined])("a %s closing the approval reopens it and sends nothing", async (actor) => {
    okR2();
    const { id, issueId } = await request();
    const before = reopens(issueId);
    await close(issueId, actor);
    expect(h.issues.get(issueId)!.status).toBe("todo");
    expect(reopens(issueId)).toBe(before + 1);
    expect((await row(id)).status).toBe("draft");
    expect((await row(id)).number).toBeNull();
    expect(await mails()).toBe(0);
  });

  it("the reopen's own plugin event (status todo) does nothing", async () => {
    const { issueId } = await request();
    const update = vi.spyOn(h.ctx.issues, "update");
    await h.deliver("issue.updated", COMPANY, {}, { entityId: issueId, entityType: "issue", actorType: "plugin", actorId: "p" });
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("a person's done sends once", async () => {
    okR2();
    const { id, issueId } = await request();
    await close(issueId, "user");
    expect((await row(id)).delivery_status).toBe("queued");
    expect(await mails()).toBe(1);
  });

  it("PDF storage failing reopens the ticket, keeps the number, sends nothing; the next done sends it", async () => {
    badR2();
    const { id, issueId } = await request();
    await close(issueId, "user");
    const failed = await row(id);
    expect(failed).toMatchObject({ status: "draft", pending_action: "send", delivery_status: "failed", mail_seq: 0 });
    expect(failed.delivery_error).toContain("PDF not rendered or stored");
    expect(failed.number).toBeTruthy();
    expect(await deliveries()).toBe(0);
    expect(await mails()).toBe(0);
    expect(h.issues.get(issueId)!.status).toBe("todo");
    expect(h.comments.filter((c) => c.issueId === issueId && c.body.includes("PDF not rendered"))).toHaveLength(1);
    okR2();
    await close(issueId, "user");
    const after = await row(id);
    expect(after.number).toBe(failed.number);
    expect(after.delivery_status).toBe("queued");
    expect(await mails()).toBe(1);
  });

  it("no R2 with email on fails instead of sending without the PDF", async () => {
    const { r2: _r2, ...noR2 } = SETTINGS;
    h.config.set(COMPANY, { ...noR2, reviewerUserId: "user-9" });
    const { id, issueId } = await request();
    await close(issueId, "user");
    expect(await row(id)).toMatchObject({ status: "draft", pending_action: "send", delivery_status: "failed" });
    expect(await mails()).toBe(0);
    expect(h.issues.get(issueId)!.status).toBe("todo");
  });

  it("a failure after the mail was queued keeps the delivery, does not reopen, and still records the queue", async () => {
    okR2();
    const { id, issueId } = await request();
    const real = h.ctx.db.execute;
    let failedOnce = false;
    (h.ctx.db as any).execute = async (sql: string, params?: unknown[]) => {
      if (!failedOnce && /SET delivery_key = \$2, delivery_status = 'queued'/.test(sql)) { failedOnce = true; throw new Error("db blip"); }
      return real(sql, params);
    };
    try { await close(issueId, "user"); } finally { (h.ctx.db as any).execute = real; }
    expect(failedOnce).toBe(true);
    const r = await row(id);
    expect(r.delivery_status).toBe("queued");
    expect(r.pending_action).toBeNull();
    expect(await deliveries()).toBe(1);
    expect(await mails()).toBe(1);
    expect(h.issues.get(issueId)!.status).toBe("done");
    await h.deliver(RESULT, COMPANY, { key: r.delivery_key, status: "sent", sentAt: new Date().toISOString(), context: { plugin: "partnersinbiz.billing" } });
    expect((await row(id)).status).toBe("sent");
  });

  it("a permanent mail failure reopens the ticket once, a repeat is a no-op, and the next done mints a new key", async () => {
    okR2();
    const { id, issueId } = await request();
    await close(issueId, "user");
    const first = await row(id);
    const result = { key: first.delivery_key, status: "failed", permanent: true, error: "mailbox full", context: { plugin: "partnersinbiz.billing" } };
    await h.deliver(RESULT, COMPANY, result);
    const failed = await row(id);
    expect(failed).toMatchObject({ pending_action: "send", delivery_status: "failed", delivery_error: "mailbox full", status: "draft" });
    expect(h.issues.get(issueId)!.status).toBe("todo");
    const comments = reopens(issueId);
    await h.deliver(RESULT, COMPANY, result);
    expect(reopens(issueId)).toBe(comments);
    await close(issueId, "user");
    const again = await row(id);
    expect(again.mail_seq).toBe(2);
    expect(again.delivery_key).not.toBe(first.delivery_key);
  });

  it("email off: done marks it sent without email and reopens nothing", async () => {
    okR2();
    h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", email: { enabled: false } });
    const { id, issueId } = await request();
    await close(issueId, "user");
    expect((await row(id)).status).toBe("sent");
    expect(h.issues.get(issueId)!.status).toBe("done");
    expect(await mails()).toBe(0);
  });

  describe("frozen recipients (PAR-6994)", () => {
    const make = async (customerRef = "ct-lumen") => {
      const inv = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
      await h.call("billing.add-line", { invoiceId: inv.id, description: "work", quantity: 1, unitAmountMinor: 100_000 });
      return inv.id;
    };
    const issueCount = () => h.issues.size;

    it("email on and no address: error, no ticket", async () => {
      await seedClient(h, { id: "ct-none", name: "No Mail" });
      const id = await make("ct-none");
      const before = issueCount();
      await expect(h.call("billing.request-send", { invoiceId: id })).rejects.toThrow(/no email address/);
      expect(issueCount()).toBe(before);
      expect((await row(id)).approval_issue_id).toBeNull();
    });

    it("email off: manual ticket, approval_recipients null", async () => {
      h.config.set(COMPANY, { ...SETTINGS, reviewerUserId: "user-9", email: { enabled: false } });
      await seedClient(h, { id: "ct-off", name: "Off" });
      const id = await make("ct-off");
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      expect(issueId).toBeTruthy();
      expect((await row(id)).approval_recipients).toBeNull();
    });

    it("stores recipients, lists them, and a later CRM change does not move the mail", async () => {
      okR2();
      const id = await make();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      expect((await row(id)).approval_recipients).toEqual([{ email: "ap@lumen.test", name: "Lumen Digital" }]);
      expect(String(h.issues.get(issueId)!.description)).toContain("ap@lumen.test");
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET send_to = '[{"email":"new@lumen.test"}]'::jsonb WHERE id = $1`, [id]);
      await close(issueId, "user");
      const out = (await h.client.query(`SELECT recipients FROM ${NAMESPACE}.deliveries`)).rows.at(-1) as any;
      expect(out.recipients.map((r: any) => r.email)).toEqual(["ap@lumen.test"]);
    });

    it("null approval_recipients falls back to the current address", async () => {
      okR2();
      const id = await make();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET approval_recipients = NULL WHERE id = $1`, [id]);
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET send_to = '[{"email":"new@lumen.test"}]'::jsonb WHERE id = $1`, [id]);
      await close(issueId, "user");
      const out = (await h.client.query(`SELECT recipients FROM ${NAMESPACE}.deliveries`)).rows.at(-1) as any;
      expect(out.recipients.map((r: any) => r.email)).toEqual(["new@lumen.test"]);
    });

    it("a sent result records sent_to and message id and comments once, even delivered twice", async () => {
      okR2();
      const id = await make();
      const { issueId } = await h.call<{ issueId: string }>("billing.request-send", { invoiceId: id });
      await close(issueId, "user");
      const key = (await row(id)).delivery_key;
      const result = { key, status: "sent", messageId: "msg-123", sentAt: "2026-11-04T10:00:00.000Z", context: { plugin: "partnersinbiz.billing" } };
      const before = reopens(issueId);
      await h.deliver(RESULT, COMPANY, result);
      await h.deliver(RESULT, COMPANY, result);
      const sent = await row(id);
      expect(sent.sent_message_id).toBe("msg-123");
      expect(sent.sent_to.map((r: any) => r.email)).toEqual(["ap@lumen.test"]);
      expect(reopens(issueId)).toBe(before + 1);
      const body = h.comments.filter((c) => c.issueId === issueId).at(-1)!.body ?? (h.comments.at(-1) as any).text;
      expect(String(body)).toContain("msg-123");
    });
  });
});
