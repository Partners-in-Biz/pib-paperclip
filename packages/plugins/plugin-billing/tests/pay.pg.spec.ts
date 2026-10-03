/**
 * Money in (audit Q10-6) end to end on a real Postgres with the host's SQL rules: a payment link, the signed
 * webhook, matching the payment to its invoice, the journals (clearing account, fee, refund), refunds, and
 * every way a delivery can be wrong. Stripe is exercised with real signatures and a fake Stripe API; PayFast's
 * protocol is in pay-providers.spec.ts. Nothing here talks to a real provider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isBalanced, type LedgerPostRequested } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { billingSettings } from "../src/config.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import { documentPdfSpec } from "../src/documents.js";
import { getInvoice } from "../src/db.js";
import { invoiceEmail } from "../src/mail.js";
import { invoiceView, startInvoiceSend } from "../src/invoices.js";
import { setupStatus } from "../src/setup.js";
import { signStripeBody } from "../src/pay/stripe.js";
import { ensurePaymentLinks, housekeepPaymentLinks } from "../src/pay/links.js";
import { forgetWebhookSecrets, WEBHOOK_SECRET_TTL_MS } from "../src/pay/settings.js";
import { handleBillingWebhook } from "../src/pay/webhook.js";
import { ONLINE_PAYMENTS_REFERENCE } from "../src/skills.js";
import { applyProviderEvent } from "../src/pay/confirm.js";
import { getLink } from "../src/pay/store.js";
import { agentContext, COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const WEBHOOK_SECRET = "secret-wh"; // the harness resolves a secret ref to `secret-<id>`

const STRIPE_SETTINGS = {
  ...SETTINGS,
  payments: {
    publicBaseUrl: "https://paperclip.test",
    stripe: { enabled: true, secretKey: { type: "secret_ref", secretId: "sk" }, webhookSecret: { type: "secret_ref", secretId: "wh" } },
  },
};

describe.skipIf(!available)("online payments (postgres)", () => {
  let h: Harness;
  let stripeCalls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }>;
  let planted = 0;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    forgetWebhookSecrets();
    h.config.set(COMPANY, { ...STRIPE_SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    stripeCalls = [];
    planted = 0;
    // A fake Stripe: every POST is recorded and answered with the objects Stripe would return.
    vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string; headers: Record<string, string> }) => {
      stripeCalls.push({ url, method: init.method, body: init.body, headers: init.headers });
      planted += 1;
      const body = url.endsWith("/v1/prices") ? { id: `price_${planted}` } : url.endsWith("/v1/payment_links") ? { id: `plink_${planted}`, url: `https://buy.stripe.com/test_${planted}` } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function outbox(event?: string) {
    const rows = (await h.client.query(`SELECT key, event, payload, status FROM ${NAMESPACE}.outbox ORDER BY created_at, key`)).rows as Array<{ key: string; event: string; payload: Record<string, unknown>; status: string }>;
    return event ? rows.filter((r) => r.event === event) : rows;
  }
  const journals = async () => (await outbox("ledger.post.requested")).map((r) => r.payload as unknown as LedgerPostRequested);

  async function sentInvoice(customerRef = "ct-lumen", unitAmountMinor = 100_000) {
    const invoice = await h.call<{ id: string; number: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor });
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  async function makeLink(invoiceId: string) {
    const result = (await h.tools.get("create-payment-link")!({ invoiceId }, { agentId: "agent-1", runId: "r1", companyId: COMPANY, projectId: "p" })) as { data: { links: Array<{ id: string; url: string; provider: string }>; error?: string } };
    return result.data;
  }

  const row = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as Array<Record<string, any>>;
  const invoiceRow = async (id: string) => (await h.call<{ invoice: { status: string; outstandingMinor: number; paidMinor: number } }>("billing.invoice-detail", { invoiceId: id })).invoice;

  /** Deliver a Stripe event the way the host does: raw body, headers, parsed body. */
  async function deliver(event: Record<string, unknown>, options: { secret?: string; timestamp?: number; signature?: string | null } = {}) {
    const rawBody = JSON.stringify(event);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = options.signature === undefined ? signStripeBody(options.secret ?? WEBHOOK_SECRET, rawBody, timestamp) : options.signature;
    return plugin.definition.onWebhook!({ endpointKey: "stripe", headers: signature ? { "stripe-signature": signature } : {}, rawBody, parsedBody: event, requestId: `req-${Math.random()}` });
  }
  const paidSession = (linkId: string, over: Record<string, unknown> = {}, eventId = "evt_paid_1") => ({
    id: eventId, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_1", client_reference_id: linkId, payment_intent: "pi_1", payment_status: "paid", amount_total: 115_000, currency: "zar", ...over } },
  });

  it("is off by default: no link, no provider call, the invoice email is EFT only", async () => {
    h.config.set(COMPANY, { ...SETTINGS });
    const invoice = await sentInvoice();
    const result = (await h.tools.get("create-payment-link")!({ invoiceId: invoice.id }, { agentId: "a", runId: "r", companyId: COMPANY, projectId: "p" })) as { data: { ok: boolean; error: string } };
    expect(result.data.error).toMatch(/No online payment provider is switched on, so the way to pay is EFT/);
    expect(stripeCalls).toEqual([]);
    const row0 = (await getInvoice(h.ctx, invoice.id))!;
    const view = await invoiceView(h.ctx, row0, await billingSettings(h.ctx, COMPANY));
    expect(view.paymentLinks).toEqual([]);
    const email = invoiceEmail(view, { hasAttachment: false });
    expect(email.text).not.toMatch(/online/i);
    expect(email.text).toContain("EFT payment details");
    expect(documentPdfSpec(view).sections!.map((s) => s.heading)).not.toContain("Pay online");
  });

  it("switched on with a secret missing is still off", async () => {
    h.config.set(COMPANY, { ...STRIPE_SETTINGS, payments: { stripe: { enabled: true, secretKey: { type: "secret_ref", secretId: "sk" } } } });
    const invoice = await sentInvoice();
    const result = (await h.tools.get("create-payment-link")!({ invoiceId: invoice.id }, { agentId: "a", runId: "r", companyId: COMPANY, projectId: "p" })) as { data: { error: string } };
    expect(result.data.error).toMatch(/Card \(Stripe\): Missing: webhook signing secret/);
  });

  it("makes one link for what the invoice owes and shows it on the email and the PDF beside the EFT details", async () => {
    const invoice = await sentInvoice();
    const made = await makeLink(invoice.id);
    expect(made.links).toHaveLength(1);
    expect(made.links[0]).toMatchObject({ provider: "stripe", url: expect.stringMatching(/^https:\/\/buy\.stripe\.com\/test_\d+\?client_reference_id=/) });
    const stored = (await row(`SELECT * FROM ${NAMESPACE}.payment_links`))[0]!;
    expect(stored).toMatchObject({ invoice_id: invoice.id, provider: "stripe", status: "active", amount_minor: "115000", currency: "ZAR", provider_ref: expect.stringMatching(/^plink_/) });
    expect(made.links[0]!.url).toContain(stored.id);
    // A second ask returns the same link and calls Stripe no more.
    const calls = stripeCalls.length;
    expect((await makeLink(invoice.id)).links[0]!.id).toBe(stored.id);
    expect(stripeCalls).toHaveLength(calls);
    expect(stripeCalls.map((c) => c.headers["idempotency-key"])).toEqual([`${stored.id}:price`, `${stored.id}:link`]);

    const view = await invoiceView(h.ctx, (await getInvoice(h.ctx, invoice.id))!, await billingSettings(h.ctx, COMPANY));
    const email = invoiceEmail(view, { hasAttachment: true });
    expect(email.text).toContain(`Pay R 1,150.00 online (Card (Stripe)): ${made.links[0]!.url}`);
    expect(email.html).toContain(`href="${made.links[0]!.url.replace(/&/g, "&amp;")}"`);
    expect(email.text).toContain("EFT payment details");
    expect(email.text).toMatch(/pay online with the link below, or by EFT/);
    const sections = documentPdfSpec(view).sections!;
    expect(sections.map((s) => s.heading)).toEqual(["Pay online", "Payment details (EFT)", "Proof of payment"]);
    expect(sections[0]!.lines[0]).toContain("Card (Stripe): https://buy.stripe.com/");
  });

  it("making the link is part of sending: the email that goes out carries it", async () => {
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    const outcome = await startInvoiceSend(h.ctx, invoice.id, "user:u1");
    expect(outcome.mode).toBe("queued");
    const mail = (await outbox("mail.send.requested"))[0]!.payload as { html: string; text: string };
    expect(mail.text).toMatch(/Pay R 1,150\.00 online \(Card \(Stripe\)\): https:\/\/buy\.stripe\.com\/test_\d+/);
    expect(mail.html).toContain("buy.stripe.com");
    const links = await row(`SELECT amount_minor, status FROM ${NAMESPACE}.payment_links WHERE invoice_id = $1`, [invoice.id]);
    expect(links).toEqual([{ amount_minor: "115000", status: "active" }]);
  });

  it("the first send says what the invoice owes, never R 0.00 (the email and the PDF are made while the row is still a draft)", async () => {
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    const draft = (await getInvoice(h.ctx, invoice.id))!;
    expect(draft.status).toBe("draft");
    // The send freezes the row as "sent" in memory before the database says so.
    const view = await invoiceView(h.ctx, { ...draft, status: "sent" }, await billingSettings(h.ctx, COMPANY));
    expect(view.outstandingMinor).toBe(115_000);
    expect(invoiceEmail(view, { hasAttachment: true }).text).toContain(`invoice ${draft.number} for R 1,150.00`);
    expect(documentPdfSpec(view).totals!.find((t) => t.label === "Balance due")).toMatchObject({ value: "R 1,150.00" });
    // and the mail that really goes out says the same
    await startInvoiceSend(h.ctx, invoice.id, "user:u1");
    const mail = (await outbox("mail.send.requested"))[0]!.payload as { text: string };
    expect(mail.text).toContain(`invoice ${draft.number} for R 1,150.00`);
    expect(mail.text).not.toContain("R 0.00");
  });

  it("a link Stripe refuses never blocks the invoice: it goes out with EFT only and the failure is shown", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid API Key provided: sk_****" } }) }) as Response);
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    expect((await startInvoiceSend(h.ctx, invoice.id, "user:u1")).mode).toBe("queued");
    const mail = (await outbox("mail.send.requested"))[0]!.payload as { text: string };
    expect(mail.text).not.toMatch(/online/);
    expect(mail.text).toContain("EFT payment details");
    expect(await row(`SELECT status, last_error FROM ${NAMESPACE}.payment_links`)).toEqual([{ status: "failed", last_error: expect.stringContaining("Invalid API Key provided: sk_****") }]);
    h.config.set(COMPANY, { ...STRIPE_SETTINGS });
    const snap = await cockpitSnapshot(h.ctx, COMPANY);
    expect(snap.health.find((c) => c.key === "payments:links")).toMatchObject({ status: "warn" });
  });

  it("a confirmed Stripe payment pays the invoice once, posts to the clearing account and tells the CRM", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await deliver(paidSession(link.id));

    const inv = await invoiceRow(invoice.id);
    expect(inv).toMatchObject({ status: "paid", outstandingMinor: 0, paidMinor: 115_000 });
    const payment = (await row(`SELECT * FROM ${NAMESPACE}.payments WHERE invoice_id = $1`, [invoice.id]))[0]!;
    expect(payment).toMatchObject({ source: "gateway", method: "card", amount_minor: "115000", allocated_minor: "115000", source_key: "gateway:stripe:pi_1", created_by: "provider:stripe" });
    expect((await row(`SELECT status, payment_id, provider_payment_id FROM ${NAMESPACE}.payment_links`))[0]).toMatchObject({ status: "paid", payment_id: payment.id, provider_payment_id: "pi_1" });
    expect((await row(`SELECT result FROM ${NAMESPACE}.payment_events`))).toEqual([{ result: "applied" }]);

    // Money held at the provider: Dr 1020 (clearing) / Cr receivables, for the whole amount.
    const posted = (await journals()).find((j) => j.key === `billing:payment:${payment.id}`)!;
    expect(isBalanced(posted.lines)).toBe(true);
    expect(posted.lines.map((l) => [l.role, l.accountCode ?? null, l.debitMinor, l.creditMinor])).toEqual([["bank", "1020", 115_000, 0], ["ar", null, 0, 115_000]]);
    expect(h.emitted.some((e) => e.name === "invoice.paid" && (e.payload as { invoiceId: string }).invoiceId === invoice.id)).toBe(true);
    // The link stops showing on the paid invoice.
    expect((await getInvoice(h.ctx, invoice.id))!.status).toBe("paid");
    expect((await makeLink(invoice.id)).error).toMatch(/nothing to pay online|is paid/);
  });

  it("answers a repeated delivery with nothing new (one payment, one journal, one event row)", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    const event = paidSession(link.id);
    await deliver(event);
    await deliver(event);
    // The same payment announced again under another event id (Stripe sends two events for async methods).
    await deliver({ ...paidSession(link.id, {}, "evt_paid_2"), type: "checkout.session.async_payment_succeeded" });
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments WHERE invoice_id = $1`, [invoice.id])).toHaveLength(1);
    expect((await journals()).filter((j) => j.key.startsWith("billing:payment:"))).toHaveLength(1);
    expect(await row(`SELECT result FROM ${NAMESPACE}.payment_events ORDER BY key`)).toEqual([{ result: "applied" }, { result: "applied" }]);
  });

  it("the event ledger answers a repeated event as already handled, and tries a failed one again", async () => {
    const invoice = await sentInvoice();
    const made = (await makeLink(invoice.id)).links[0]!;
    const link = (await getLink(h.ctx, made.id))!;
    const settings = await billingSettings(h.ctx, COMPANY);
    const event = { kind: "payment_confirmed" as const, eventId: "evt_ledger", linkId: link.id, providerPaymentId: "pi_ledger", amountMinor: 115_000, currency: "ZAR", feeMinor: null, paidAt: new Date().toISOString(), reference: null, status: "paid" };
    expect(await applyProviderEvent(h.ctx, link, event, settings)).toMatchObject({ result: "applied" });
    expect(await applyProviderEvent(h.ctx, link, event, settings)).toMatchObject({ result: "duplicate", detail: "Already handled (applied)" });
    // an event recorded as failed (the worker died half way) is applied by the retry the provider makes
    await h.client.query(`INSERT INTO ${NAMESPACE}.payment_events (key, company_id, provider, kind, link_id, result, detail) VALUES ('stripe:evt_retry', $1, 'stripe', 'payment_confirmed', $2, 'failed', 'boom')`, [COMPANY, link.id]);
    expect(await applyProviderEvent(h.ctx, link, { ...event, eventId: "evt_retry" }, settings)).toMatchObject({ result: "applied" });
    expect(await row(`SELECT result FROM ${NAMESPACE}.payment_events WHERE key = 'stripe:evt_retry'`)).toEqual([{ result: "applied" }]);
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments WHERE invoice_id = $1`, [invoice.id])).toHaveLength(1);
  });

  it("believes nothing before the signature checks out: a forged delivery records no payment, no event, no issue", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await expect(deliver(paidSession(link.id), { secret: "whsec_attacker" })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(deliver(paidSession(link.id), { signature: null })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(deliver(paidSession(link.id), { timestamp: Math.floor(Date.now() / 1000) - 3_600 })).rejects.toMatchObject({ code: "stale" });
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments`)).toHaveLength(0);
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_events`)).toHaveLength(0);
    expect((await invoiceRow(invoice.id)).status).toBe("sent");
    expect([...h.issues.values()].filter((i) => /online payment/.test(i.title))).toEqual([]);
  });

  it("ignores a delivery that names no link of ours, and cannot be steered to another company's invoice", async () => {
    await expect(deliver(paidSession("not-our-link"))).resolves.toBeUndefined();
    await expect(deliver({ id: "evt_x", type: "customer.created", created: 1, data: { object: {} } })).resolves.toBeUndefined();
    // A payment intent we never saw: nothing to match.
    await expect(deliver({ id: "evt_y", type: "charge.refunded", created: 1, data: { object: { id: "ch", payment_intent: "pi_unknown", amount_refunded: 100 } } })).resolves.toBeUndefined();
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_events`)).toHaveLength(0);
    // A link of another provider is not this provider's.
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await h.client.query(`UPDATE ${NAMESPACE}.payment_links SET provider = 'mock' WHERE id = $1`, [link.id]);
    await expect(deliver(paidSession(link.id))).resolves.toBeUndefined();
    expect((await invoiceRow(invoice.id)).status).toBe("sent");
  });

  it("will not settle a payment of another amount: a person is asked, the money is not lost track of", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await deliver(paidSession(link.id, { amount_total: 100_000 }));
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments`)).toHaveLength(0);
    expect((await invoiceRow(invoice.id)).status).toBe("sent");
    expect((await row(`SELECT status, last_error FROM ${NAMESPACE}.payment_links`))[0]).toMatchObject({ status: "needs_attention", last_error: expect.stringContaining("the link was for R 1,150.00 and R 1,000.00 was paid") });
    expect((await row(`SELECT result FROM ${NAMESPACE}.payment_events`))).toEqual([{ result: "needs_attention" }]);
    const issue = [...h.issues.values()].find((i) => /Check an online payment of R 1,000.00/.test(i.title))!;
    expect(issue).toBeTruthy();
    expect(issue.description).toContain("The money is real");
    expect(await row(`SELECT kind, status FROM ${NAMESPACE}.decision_issues WHERE issue_id = $1`, [issue.id])).toEqual([{ kind: "gateway", status: "open" }]);
    // The Cockpit says so too.
    const snap = await cockpitSnapshot(h.ctx, COMPANY);
    expect(snap.health.find((c) => c.key === "payments:attention")).toMatchObject({ status: "warn" });
  });

  it("asks a person when the invoice was cancelled meanwhile, and when another currency was paid", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'cancelled' WHERE id = $1`, [invoice.id]);
    await deliver(paidSession(link.id));
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments`)).toHaveLength(0);
    expect([...h.issues.values()].find((i) => /Check an online payment/.test(i.title))!.description).toContain("This invoice is cancelled");

    const second = await sentInvoice();
    const link2 = (await makeLink(second.id)).links[0]!;
    await deliver(paidSession(link2.id, { currency: "usd", payment_intent: "pi_2" }, "evt_usd"));
    expect((await row(`SELECT result FROM ${NAMESPACE}.payment_events WHERE key = 'stripe:evt_usd'`))[0]).toEqual({ result: "needs_attention" });
  });

  it("an invoice paid by EFT first: the card payment is recorded as customer credit and a person decides what to do with it", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 115_000, reference: "EFT" }, userContext());
    expect((await invoiceRow(invoice.id)).status).toBe("paid");
    await deliver(paidSession(link.id));
    const payments = await row(`SELECT source, amount_minor, allocated_minor FROM ${NAMESPACE}.payments ORDER BY created_at`);
    expect(payments).toEqual([{ source: "manual", amount_minor: "115000", allocated_minor: "115000" }, { source: "gateway", amount_minor: "115000", allocated_minor: "0" }]);
    expect([...h.issues.values()].find((i) => /Check an online payment/.test(i.title))!.description).toMatch(/R 1,150\.00 is now credit on the customer's account/);
  });

  it("a partial EFT payment withdraws the link for the old amount, and the next send makes one for what is left", async () => {
    const invoice = await sentInvoice();
    const first = (await makeLink(invoice.id)).links[0]!;
    await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 15_000, reference: "part" }, userContext());
    expect((await row(`SELECT status FROM ${NAMESPACE}.payment_links WHERE id = $1`, [first.id]))[0]).toEqual({ status: "cancelled" });
    const second = (await makeLink(invoice.id)).links[0]!;
    expect(second.id).not.toBe(first.id);
    expect((await row(`SELECT amount_minor FROM ${NAMESPACE}.payment_links WHERE id = $1`, [second.id]))[0]).toEqual({ amount_minor: "100000" });
    // The customer pays the old, withdrawn link anyway: the money is recorded, only what is owed is allocated, and a person is told about the extra.
    await deliver(paidSession(first.id, {}, "evt_old"));
    expect(await row(`SELECT amount_minor, allocated_minor FROM ${NAMESPACE}.payments WHERE source = 'gateway'`)).toEqual([{ amount_minor: "115000", allocated_minor: "100000" }]);
    expect((await invoiceRow(invoice.id)).status).toBe("paid");
    expect([...h.issues.values()].find((i) => /Check an online payment/.test(i.title))!.description).toMatch(/R 150\.00 is now credit/);
  });

  it("switches a withdrawn link off at the provider once, from the hourly housekeeping", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await h.call("billing.cancel-invoice", { invoiceId: invoice.id }, userContext());
    expect((await row(`SELECT status FROM ${NAMESPACE}.payment_links WHERE id = $1`, [link.id]))[0]).toEqual({ status: "cancelled" });
    const before = stripeCalls.length;
    expect(await housekeepPaymentLinks(h.ctx, COMPANY, await billingSettings(h.ctx, COMPANY))).toEqual({ switchedOff: 1 });
    const off = stripeCalls.slice(before);
    expect(off).toHaveLength(1);
    expect(off[0]!.url).toMatch(/\/v1\/payment_links\/plink_\d+$/);
    expect(new URLSearchParams(off[0]!.body).get("active")).toBe("false");
    expect((await row(`SELECT remote_off_at FROM ${NAMESPACE}.payment_links WHERE id = $1`, [link.id]))[0]!.remote_off_at).toBeTruthy();
    expect(await housekeepPaymentLinks(h.ctx, COMPANY, await billingSettings(h.ctx, COMPANY))).toEqual({ switchedOff: 0 });
    expect(stripeCalls).toHaveLength(before + 1);
  });

  it("records a refund Stripe reports: a negative payment, the invoice owing again, the journal and an issue", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await deliver(paidSession(link.id));
    const refund = (total: number, id: string) => ({ id, type: "charge.refunded", created: Math.floor(Date.now() / 1000), data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: total, currency: "zar" } } });
    await deliver(refund(5_000, "evt_r1"));
    const inv = await invoiceRow(invoice.id);
    expect(inv).toMatchObject({ status: "partially_paid", outstandingMinor: 5_000, paidMinor: 110_000 });
    const negative = (await row(`SELECT amount_minor, allocated_minor, source, method FROM ${NAMESPACE}.payments WHERE source = 'gateway_refund'`));
    expect(negative).toEqual([{ amount_minor: "-5000", allocated_minor: "-5000", source: "gateway_refund", method: "card" }]);
    const rf = (await row(`SELECT id, amount_minor, source, provider FROM ${NAMESPACE}.payment_refunds`))[0]!;
    expect(rf).toMatchObject({ amount_minor: "5000", source: "webhook", provider: "stripe" });
    const refundJournal = (await journals()).find((j) => j.key === `billing:refund:${rf.id}`)!;
    expect(refundJournal.lines.map((l) => [l.role, l.accountCode ?? null, l.debitMinor, l.creditMinor])).toEqual([["ar", null, 5_000, 0], ["bank", "1020", 0, 5_000]]);
    expect(isBalanced(refundJournal.lines)).toBe(true);
    expect((await row(`SELECT refunded_minor FROM ${NAMESPACE}.payment_links`))[0]).toEqual({ refunded_minor: "5000" });
    expect([...h.issues.values()].find((i) => /^Refund recorded: R 50\.00 on/.test(i.title))!.description).toContain("owes R 50.00 again");

    // The same total again changes nothing; a bigger total records only the difference.
    await deliver(refund(5_000, "evt_r1b"));
    await deliver(refund(115_000, "evt_r2"));
    expect((await row(`SELECT amount_minor FROM ${NAMESPACE}.payment_refunds ORDER BY created_at`)).map((r) => r.amount_minor)).toEqual(["5000", "110000"]);
    expect(await invoiceRow(invoice.id)).toMatchObject({ outstandingMinor: 115_000, paidMinor: 0 });
    expect((await getInvoice(h.ctx, invoice.id))!.status).not.toBe("paid");
  });

  it("a person records a refund of an online payment, once, within what was paid", async () => {
    h.config.set(COMPANY, { ...STRIPE_SETTINGS, payments: { ...STRIPE_SETTINGS.payments, mock: { enabled: true } } });
    const invoice = await sentInvoice();
    const link = (await row(`SELECT id FROM ${NAMESPACE}.payment_links`)).length ? null : null;
    void link;
    const made = (await h.call<{ links: Array<{ id: string; provider: string }> }>("billing.create-payment-link", { invoiceId: invoice.id }, userContext())).links;
    const mock = made.find((l) => l.provider === "mock")!;
    await h.call("billing.simulate-payment", { linkId: mock.id }, userContext());
    expect((await invoiceRow(invoice.id)).status).toBe("paid");
    await expect(h.call("billing.record-refund", { invoiceId: invoice.id, amountMinor: 10_000 }, agentContext())).rejects.toThrow(/Agents may not do recording a refund/);
    await expect(h.call("billing.record-refund", { invoiceId: invoice.id, amountMinor: 999_999 }, userContext())).rejects.toThrow(/can still be refunded/);
    const done = await h.call<{ recorded: boolean; invoiceStatus: string; outstandingMinor: number }>("billing.record-refund", { invoiceId: invoice.id, amountMinor: 10_000, reason: "Customer returned the service", reference: "ref-1" }, userContext());
    expect(done).toMatchObject({ recorded: true, invoiceStatus: "partially_paid", outstandingMinor: 10_000 });
    expect((await h.call<{ recorded: boolean }>("billing.record-refund", { invoiceId: invoice.id, amountMinor: 10_000, reference: "ref-1" }, userContext())).recorded).toBe(false);
    expect(await invoiceRow(invoice.id)).toMatchObject({ outstandingMinor: 10_000 });
    // An invoice nobody paid online has nothing to refund through a provider.
    const eft = await sentInvoice();
    await expect(h.call("billing.record-refund", { invoiceId: eft.id, amountMinor: 100 }, userContext())).rejects.toThrow(/No online payment was taken/);
  });

  it("the test provider rehearses the whole path, including the provider's fee in the books", async () => {
    h.config.set(COMPANY, { ...SETTINGS, payments: { mock: { enabled: true } } });
    const invoice = await sentInvoice();
    const link = (await h.call<{ links: Array<{ id: string; url: string }> }>("billing.create-payment-link", { invoiceId: invoice.id }, userContext())).links[0]!;
    expect(link.url).toMatch(/^https:\/\/pay\.invalid\/mock\//);
    await h.call("billing.simulate-payment", { linkId: link.id, feeMinor: 3_000 }, userContext());
    const payment = (await row(`SELECT id FROM ${NAMESPACE}.payments WHERE source = 'gateway'`))[0]!;
    const fee = (await journals()).find((j) => j.key === `billing:payment:${payment.id}:fee`)!;
    expect(fee.lines.map((l) => [l.role, l.accountCode ?? null, l.debitMinor, l.creditMinor])).toEqual([["expense:bank_charges", null, 3_000, 0], ["bank", "1020", 0, 3_000]]);
    expect((await row(`SELECT fee_minor FROM ${NAMESPACE}.payment_links`))[0]).toEqual({ fee_minor: "3000" });
    // A real person is needed to rehearse: an agent cannot "pay".
    await expect(h.call("billing.simulate-payment", { linkId: link.id }, agentContext())).rejects.toThrow(/Agents may not/);
  });

  it("rehearses only with the test provider switched on, and only on its own links", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await expect(h.call("billing.simulate-payment", { linkId: link.id }, userContext())).rejects.toThrow(/test provider is off/);
    h.config.set(COMPANY, { ...STRIPE_SETTINGS, payments: { ...STRIPE_SETTINGS.payments, mock: { enabled: true } } });
    await expect(h.call("billing.simulate-payment", { linkId: link.id }, userContext())).rejects.toThrow(/not a test payment link/);
  });

  it("the canary client never gets a real link, a real email or a ledger entry", async () => {
    await seedClient(h, { id: "canary-ab12cd34", name: "PiB Canary Co", kind: "company" });
    await h.client.query(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('canary-contact-ab12cd34', $1, 'Canary Contact', ARRAY['canary@canary.invalid'], now())`, [COMPANY]);
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "canary-contact-ab12cd34" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Test", quantity: 1, unitAmountMinor: 100_000 });
    const outcome = await startInvoiceSend(h.ctx, invoice.id, "user:u1");
    // No address a real person can have: marked sent without email, no real provider link, no journal.
    expect(outcome.mode).toBe("manual");
    expect(await outbox("mail.send.requested")).toHaveLength(0);
    expect(stripeCalls).toEqual([]);
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_links`)).toHaveLength(0);
    expect((await getInvoice(h.ctx, invoice.id))!.status).toBe("sent");
    expect(await journals()).toEqual([]);
    // A test payment is recorded and the CRM is told, but nothing reaches the books.
    await h.call("billing.record-payment", { invoiceId: invoice.id, amountMinor: 115_000, reference: "test" }, userContext());
    expect((await invoiceRow(invoice.id)).status).toBe("paid");
    expect(await journals()).toEqual([]);
    expect(h.emitted.some((e) => e.name === "invoice.paid")).toBe(true);
  });

  it("PayFast deliveries arrive empty on this host: ignored without a trace, never believed", async () => {
    await expect(plugin.definition.onWebhook!({ endpointKey: "payfast", headers: {}, rawBody: "", parsedBody: {}, requestId: "r" })).resolves.toBeUndefined();
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_events`)).toHaveLength(0);
    await expect(plugin.definition.onWebhook!({ endpointKey: "nope", headers: {}, rawBody: "{}", parsedBody: {}, requestId: "r" })).rejects.toThrow(/Unknown webhook endpoint/);
  });

  it("says in Setup what the owner does for each provider, and that PayFast waits on a host decision", async () => {
    h.config.set(COMPANY, { ...SETTINGS, payments: { publicBaseUrl: "https://paperclip.test" } });
    const off = await setupStatus(h.ctx, COMPANY);
    const stripe = off.items.find((i) => i.key === "pay_stripe")!;
    expect(stripe).toMatchObject({ required: false, status: "optional", href: "https://dashboard.stripe.com/apikeys" });
    expect(stripe.steps!.join("\n")).toContain("https://paperclip.test/api/plugins/partnersinbiz.billing/webhooks/stripe");
    expect(stripe.steps!.join("\n")).toContain("checkout.session.completed, checkout.session.async_payment_succeeded");
    expect(stripe.agentNext).toMatch(/pay-online link/);
    const payfast = off.items.find((i) => i.key === "pay_payfast")!;
    // Not "waiting on another step": it waits on the owner's decision, and the item says so.
    expect(payfast).toMatchObject({ required: false, status: "optional", detail: expect.stringMatching(/^Needs your decision/) });
    expect(payfast.detail).toMatch(/accepts only JSON on plugin webhook addresses/);
    expect(payfast.detail).toMatch(/Yoco and Paystack/);
    // Once on, the item is done and counts confirmed payments.
    h.config.set(COMPANY, { ...STRIPE_SETTINGS });
    expect((await setupStatus(h.ctx, COMPANY)).items.find((i) => i.key === "pay_stripe")).toMatchObject({ status: "done", detail: expect.stringMatching(/No payment has been confirmed yet/) });
    const invoice = await sentInvoice();
    await deliver(paidSession((await makeLink(invoice.id)).links[0]!.id));
    expect((await setupStatus(h.ctx, COMPANY)).items.find((i) => i.key === "pay_stripe")!.detail).toBe("1 payment confirmed by Stripe so far.");
  });

  // ── Stripe's fee ───────────────────────────────────────────────────────────

  it("Stripe's fee is not in its notification, so Billing posts none and nothing it tells the owner or an agent claims otherwise", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await deliver(paidSession(link.id));
    // Gross to the clearing account, and no fee journal: the payout will arrive net of the fee and leave it on 1020.
    const payment = (await row(`SELECT id FROM ${NAMESPACE}.payments WHERE source = 'gateway'`))[0]!;
    expect((await journals()).map((j) => j.key)).toEqual([expect.stringMatching(/^billing:invoice:/), `billing:payment:${payment.id}`]);
    expect((await row(`SELECT fee_minor FROM ${NAMESPACE}.payment_links`))[0]).toEqual({ fee_minor: null });
    expect((await h.call<Array<{ feeMinor: number | null; status: string }>>("billing.payment-links", { invoiceId: invoice.id }))[0]).toMatchObject({ status: "paid", feeMinor: null });

    // What agents read says so (Billing's reference), and what the owner reads in Setup, before and after Stripe is on.
    expect(ONLINE_PAYMENTS_REFERENCE).toContain("**Stripe's does not**");
    expect(ONLINE_PAYMENTS_REFERENCE).toMatch(/for Stripe Billing posts no fee/);
    expect(ONLINE_PAYMENTS_REFERENCE).toMatch(/Never tell the owner a Stripe fee is already in the books/);
    expect(ONLINE_PAYMENTS_REFERENCE).not.toMatch(/fee is posted as bank charges/i);
    const on = (await setupStatus(h.ctx, COMPANY)).items.find((i) => i.key === "pay_stripe")!;
    expect(on.agentNext).toMatch(/Stripe's fee is not in its notification, so Billing does not post it/);
    h.config.set(COMPANY, { ...SETTINGS, payments: { publicBaseUrl: "https://paperclip.test" } });
    const off = (await setupStatus(h.ctx, COMPANY)).items.find((i) => i.key === "pay_stripe")!;
    expect(off.steps!.join("\n")).toMatch(/Billing posts no Stripe fee/);
    expect(off.agentNext).toMatch(/Stripe's fee is booked from each payout by the Bookkeeper/);
  });

  // ── The test provider stays away from real customers ───────────────────────

  it("the test provider's link is never made on a real customer's send, and never shown on its email or PDF even when made by hand", async () => {
    h.config.set(COMPANY, { ...SETTINGS, payments: { mock: { enabled: true } } });
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    expect((await startInvoiceSend(h.ctx, invoice.id, "user:u1")).mode).toBe("queued");
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_links`)).toHaveLength(0);
    const mail = (await outbox("mail.send.requested"))[0]!.payload as { text: string; html: string };
    expect(mail.text + mail.html).not.toContain("pay.invalid");

    // Someone rehearses the books by hand on this real invoice (once the mail has gone and it counts as sent): the link exists, and the customer still never sees it.
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'sent' WHERE id = $1`, [invoice.id]);
    const made = await h.call<{ links: Array<{ provider: string; url: string }>; next: string }>("billing.create-payment-link", { invoiceId: invoice.id }, userContext());
    expect(made.links).toEqual([expect.objectContaining({ provider: "mock", url: expect.stringContaining("pay.invalid") })]);
    expect(made.next).toMatch(/a test link is never shown to a real customer/);
    const settings = await billingSettings(h.ctx, COMPANY);
    const view = await invoiceView(h.ctx, (await getInvoice(h.ctx, invoice.id))!, settings);
    expect(view.paymentLinks).toEqual([]);
    expect(invoiceEmail(view, { hasAttachment: false }).text).not.toContain("pay.invalid");
    expect(documentPdfSpec(view).sections!.map((x) => x.heading)).not.toContain("Pay online");
    // A reminder or a re-send makes and shows nothing from the test provider either.
    expect((await ensurePaymentLinks(h.ctx, (await getInvoice(h.ctx, invoice.id))!, settings)).links).toEqual([]);

    // The canary client is the one that gets it, and only when the test provider is on.
    await seedClient(h, { id: "canary-ab12cd34", name: "PiB Canary Co", kind: "company" });
    const canary = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: "canary-ab12cd34", customerName: "PiB Canary Co" });
    await h.call("billing.add-line", { invoiceId: canary.id, description: "Test", quantity: 1, unitAmountMinor: 100_000 });
    await h.call("billing.mark-sent", { invoiceId: canary.id });
    const canaryLink = await h.call<{ links: Array<{ provider: string }> }>("billing.create-payment-link", { invoiceId: canary.id }, userContext());
    expect(canaryLink.links.map((l) => l.provider)).toEqual(["mock"]);
    expect((await invoiceView(h.ctx, (await getInvoice(h.ctx, canary.id))!, settings)).paymentLinks).toEqual([expect.objectContaining({ provider: "mock" })]);
    h.config.set(COMPANY, { ...STRIPE_SETTINGS });
    const other = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "company", customerRef: "canary-ab12cd34", customerName: "PiB Canary Co" });
    await h.call("billing.add-line", { invoiceId: other.id, description: "Test 2", quantity: 1, unitAmountMinor: 100_000 });
    await h.call("billing.mark-sent", { invoiceId: other.id });
    await expect(h.call("billing.create-payment-link", { invoiceId: other.id }, userContext())).rejects.toThrow(/canary \(test\) client.*test provider is off/);
    expect(stripeCalls).toEqual([]);
  });

  // ── Refunds out of order ───────────────────────────────────────────────────

  const refundEvent = (id: string, linkId: string, total = 5_000) => ({ id, type: "charge.refunded", created: Math.floor(Date.now() / 1000), data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: total, currency: "zar", metadata: { pib_link: linkId } } } });

  it("a refund that arrives before its payment fails the delivery so Stripe sends it again, and is applied once the payment is recorded", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await expect(deliver(refundEvent("evt_early", link.id))).rejects.toThrow(/before the payment it refunds was recorded/);
    // Nothing was booked against money that never arrived.
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_refunds`)).toHaveLength(0);
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payments`)).toHaveLength(0);
    expect((await journals()).filter((j) => j.key.startsWith("billing:refund:"))).toEqual([]);
    expect(await row(`SELECT result FROM ${NAMESPACE}.payment_events WHERE key = 'stripe:evt_early'`)).toEqual([{ result: "failed" }]);
    // The payment arrives; Stripe sends the same refund event again, and now it counts.
    await deliver(paidSession(link.id));
    await deliver(refundEvent("evt_early", link.id));
    expect(await row(`SELECT amount_minor FROM ${NAMESPACE}.payment_refunds`)).toEqual([{ amount_minor: "5000" }]);
    expect(await invoiceRow(invoice.id)).toMatchObject({ status: "partially_paid", outstandingMinor: 5_000 });
    expect(await row(`SELECT result FROM ${NAMESPACE}.payment_events WHERE key = 'stripe:evt_early'`)).toEqual([{ result: "applied" }]);
  });

  it("a refund of money Billing never recorded (a payment a person was asked about) is ignored, and the issue says so", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    await deliver(paidSession(link.id, { amount_total: 100_000 }));
    expect((await row(`SELECT status FROM ${NAMESPACE}.payment_links`))[0]).toEqual({ status: "needs_attention" });
    await deliver(refundEvent("evt_nothing", link.id));
    expect(await row(`SELECT result, detail FROM ${NAMESPACE}.payment_events WHERE key = 'stripe:evt_nothing'`)).toEqual([{ result: "ignored", detail: expect.stringMatching(/did not record.*needs attention.*nothing to reverse/) }]);
    expect(await row(`SELECT 1 FROM ${NAMESPACE}.payment_refunds`)).toHaveLength(0);
    expect((await journals()).filter((j) => j.key.startsWith("billing:refund:"))).toEqual([]);
    expect([...h.issues.values()].find((i) => /Check an online payment/.test(i.title))!.description).toMatch(/Billing did not record this payment, so it records nothing for the refund either/);
    // The issue for money that WAS recorded (an invoice paid by EFT first) keeps the other wording.
    const second = await sentInvoice();
    const link2 = (await makeLink(second.id)).links[0]!;
    await h.call("billing.record-payment", { invoiceId: second.id, amountMinor: 115_000, reference: "EFT" }, userContext());
    await deliver(paidSession(link2.id, { payment_intent: "pi_2" }, "evt_second"));
    const credit = [...h.issues.values()].filter((i) => /Check an online payment/.test(i.title)).pop()!;
    expect(credit.description).toMatch(/Billing records the refund when Stripe tells it/);
  });

  // ── The public webhook address ─────────────────────────────────────────────

  it("a flood of unsigned deliveries naming a real link cannot use up the secret budget, and a genuine delivery still gets through", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    const resolved: string[] = [];
    const secrets = (h.ctx as unknown as { secrets: { resolve: (ref: { secretId: string }, options: unknown) => Promise<string> } }).secrets;
    const real = secrets.resolve;
    secrets.resolve = async (ref, options) => {
      resolved.push(ref.secretId);
      return real(ref, options);
    };
    try {
      const now = Math.floor(Date.now() / 1000);
      // Missing, malformed and stale headers are refused before any secret is asked for.
      for (const signature of [null, "garbage", "t=abc,v1=zz", `t=${now},v1=${"a".repeat(10)}`, signStripeBody("whsec_x", "{}", now - 3_600)]) {
        await expect(deliver(paidSession(link.id), { signature })).rejects.toMatchObject({ code: expect.stringMatching(/^(bad_signature|stale)$/) });
      }
      expect(resolved).toEqual([]);
      // Well-formed but wrongly signed: the first resolves the signing secret, the other thirty-nine use the remembered one.
      for (let i = 0; i < 40; i += 1) await expect(deliver(paidSession(link.id), { secret: "whsec_attacker" })).rejects.toMatchObject({ code: "bad_signature" });
      expect(resolved).toEqual(["wh"]);
      // A genuine delivery after the flood is believed and applied, with no further read of the secret.
      await deliver(paidSession(link.id));
      expect(resolved).toEqual(["wh"]);
      expect((await invoiceRow(invoice.id)).status).toBe("paid");

      // The remembered secret expires after a minute: the next delivery reads it again.
      const second = await sentInvoice();
      const link2 = (await makeLink(second.id)).links[0]!;
      const signingReads = () => resolved.filter((id) => id.startsWith("wh"));
      expect(signingReads()).toEqual(["wh"]);
      const event = paidSession(link2.id, { payment_intent: "pi_2" }, "evt_later");
      const raw = JSON.stringify(event);
      const later = new Date(Date.now() + WEBHOOK_SECRET_TTL_MS + 1_000);
      const stamp = Math.floor(later.getTime() / 1000);
      await handleBillingWebhook(h.ctx, { endpointKey: "stripe", rawBody: raw, headers: { "stripe-signature": signStripeBody(WEBHOOK_SECRET, raw, stamp) } }, { now: later });
      expect(signingReads()).toEqual(["wh", "wh"]);
      expect((await invoiceRow(second.id)).status).toBe("paid");

      // A rotated secret is a new reference: read at once, and the old signing secret no longer verifies.
      h.config.set(COMPANY, { ...STRIPE_SETTINGS, payments: { ...STRIPE_SETTINGS.payments, stripe: { ...STRIPE_SETTINGS.payments.stripe, webhookSecret: { type: "secret_ref", secretId: "wh2" } } } });
      const third = await sentInvoice();
      const link3 = (await makeLink(third.id)).links[0]!;
      await expect(deliver(paidSession(link3.id, { payment_intent: "pi_3" }, "evt_old_secret"))).rejects.toMatchObject({ code: "bad_signature" });
      await deliver(paidSession(link3.id, { payment_intent: "pi_3" }, "evt_new_secret"), { secret: "secret-wh2" });
      expect(signingReads()).toEqual(["wh", "wh", "wh2"]);
      expect((await invoiceRow(third.id)).status).toBe("paid");
    } finally {
      secrets.resolve = real;
    }
  });

  it("a reminder run makes its payment links with one read of the Stripe key, not one per invoice", async () => {
    h.config.set(COMPANY, { ...STRIPE_SETTINGS, dunning: { enabled: true } });
    await seedClient(h, { id: "ct-lumos", name: "Lumos Ltd", email: "ap@lumos.test" });
    const a = await sentInvoice("ct-lumen");
    const b = await sentInvoice("ct-lumos");
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '8 days' WHERE id IN ($1, $2)`, [a.id, b.id]);
    const resolved: string[] = [];
    const secrets = (h.ctx as unknown as { secrets: { resolve: (ref: { secretId: string }, options: unknown) => Promise<string> } }).secrets;
    const real = secrets.resolve;
    secrets.resolve = async (ref, options) => {
      resolved.push(ref.secretId);
      return real(ref, options);
    };
    try {
      await h.runJob("dunning");
    } finally {
      secrets.resolve = real;
    }
    const reminders = (await outbox("mail.send.requested")).map((r) => r.payload as { text: string });
    expect(reminders).toHaveLength(2);
    for (const reminder of reminders) expect(reminder.text).toMatch(/buy\.stripe\.com/);
    expect(resolved.filter((id) => id === "sk")).toEqual(["sk"]);
  });

  it("the Cockpit turns red when a notification could not be applied", async () => {
    const invoice = await sentInvoice();
    const link = (await makeLink(invoice.id)).links[0]!;
    // The ledger is not the problem here; make settling fail by dropping the invoice row's status to something settle refuses.
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET status = 'draft' WHERE id = $1`, [invoice.id]);
    await h.client.query(`INSERT INTO ${NAMESPACE}.payment_events (key, company_id, provider, kind, link_id, result, detail) VALUES ('stripe:evt_broken', $1, 'stripe', 'payment_confirmed', $2, 'failed', 'boom')`, [COMPANY, link.id]);
    const snap = await cockpitSnapshot(h.ctx, COMPANY);
    expect(snap.health.find((c) => c.key === "payments:notifications")).toMatchObject({ status: "bad", detail: expect.stringMatching(/1 payment notification from a provider could not be applied/) });
  });
});
