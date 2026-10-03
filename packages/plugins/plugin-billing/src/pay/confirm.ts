/**
 * What a verified provider event does (Q10-6): match the confirmed payment to its invoice, record it
 * through the one `settle()` every payment uses, post it to the books, and record refunds.
 *
 * The books. A card or online payment is not in the bank when the provider confirms it: the provider
 * pays it out later, as one lump net of fees. So the journal is Dr the clearing account (money held at
 * the provider, account 1020 from Accounting 0.4) / Cr receivables for the whole amount, the provider's
 * fee goes Dr bank charges / Cr clearing when the delivery carries it (PayFast's does; Stripe's
 * `checkout.session.completed` carries no fee and the restricted key cannot read balance transactions, so for
 * Stripe the fee is NOT posted here: the net payout leaves it on the clearing account and the Bookkeeper
 * books it from the payout), and the payout bank line is
 * categorised to the clearing account in Accounting. A refund is Dr receivables / Cr clearing.
 * Each journal has a stable key, so a repeated delivery posts nothing twice.
 *
 * What is never settled by itself: a payment whose amount or currency is not the link's, one for an
 * invoice that is cancelled or still a draft, or one the invoice cannot take. Real money has arrived in
 * those cases, so a person is asked on an issue (kind `gateway`) with what to do; the event is recorded
 * as needing attention and is not retried.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor } from "@partnersinbiz/pib-plugin-kit";
import { openBillingApproval } from "../approvals.js";
import { refreshInvoiceStatus } from "../balances.js";
import type { BillingSettings } from "../config.js";
import { getInvoice, table, type InvoiceRow } from "../db.js";
import { BillingError } from "../domain.js";
import { emitInvoiceItem } from "../openitems.js";
import { APPROVAL_ORIGINS } from "../origins.js";
import { postGatewayFee, postRefund } from "../posting.js";
import { closePopIssues, recordDecisionIssue } from "../pop.js";
import { billingPath, companyPrefix } from "../routing.js";
import { paymentById, settle } from "../settle.js";
import { clearingAccountCode } from "./settings.js";
import { eventResult, finishEvent, insertRefund, markLinkPaid, recordEvent, setLinkRefunded, setLinkStatus, type PaymentLinkRow } from "./store.js";
import { PROVIDER_LABELS, type ProviderEvent } from "./types.js";

export interface ApplyOutcome {
  result: "applied" | "ignored" | "needs_attention" | "duplicate";
  detail: string;
  invoiceId?: string;
  paymentId?: string;
}

/** A stable UUID-shaped id from a key, so one provider event makes one refund however often it arrives. */
function stableUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function customerNameOf(invoice: InvoiceRow): string {
  const customer = (invoice.customer_snapshot ?? invoice.customer) as { name?: unknown } | null;
  return typeof customer?.name === "string" && customer.name ? customer.name : invoice.customer_ref;
}

/** An issue for a person about money that arrived and that Billing will not settle by itself. */
async function askPerson(ctx: PluginContext, settings: BillingSettings, link: PaymentLinkRow, invoice: InvoiceRow | null, event: ProviderEvent, why: string): Promise<string> {
  const label = PROVIDER_LABELS[link.provider];
  const currency = event.currency ?? link.currency;
  const money = formatMoneyMinor(event.amountMinor, currency);
  const prefix = await companyPrefix(ctx, link.company_id);
  const number = invoice?.number ?? "an invoice that is gone";
  const issue = await openBillingApproval(ctx, settings, {
    companyId: link.company_id,
    title: `Check an online payment of ${money} for ${number}`,
    description: [
      `${label} confirmed a payment of ${money} (provider reference ${event.providerPaymentId ?? event.eventId}) for the payment link of invoice ${number}.`,
      "",
      `Billing did not record it by itself: ${why}`,
      "",
      "The money is real. Open the payment in the provider's dashboard, then either:",
      "- record it on the Billing page (Money is in) against the right invoice and amount, or",
      link.status === "paid"
        ? "- refund it from the provider's dashboard (Billing records the refund when Stripe tells it; for PayFast use Record refund on the invoice)."
        : "- refund it from the provider's dashboard. Billing did not record this payment, so it records nothing for the refund either: there is nothing in the books to reverse.",
      "Mark this issue done when it is handled.",
      "",
      `Invoices: ${billingPath(prefix, { tab: "invoices" })}`,
    ].join("\n"),
    originId: `${APPROVAL_ORIGINS.gatewayPayment}${link.provider}:${event.eventId}`,
    outward: false,
    priority: "high",
  });
  await recordDecisionIssue(ctx, { issueId: issue.id, companyId: link.company_id, kind: "gateway", subjectKind: "payment_link", subjectId: link.id, payload: { linkId: link.id, invoiceId: invoice?.id ?? link.invoice_id, number, amountMinor: event.amountMinor, currency, provider: link.provider, why } });
  await setLinkStatus(ctx, link.id, ["active"], "needs_attention", why);
  return issue.id;
}

async function confirmPayment(ctx: PluginContext, link: PaymentLinkRow, event: ProviderEvent, settings: BillingSettings): Promise<ApplyOutcome> {
  const invoice = await getInvoice(ctx, link.invoice_id);
  if (!invoice || invoice.company_id !== link.company_id) {
    await askPerson(ctx, settings, link, null, event, "the invoice is not in Billing any more.");
    return { result: "needs_attention", detail: "Invoice not found; a person was asked" };
  }
  const currency = (event.currency ?? link.currency).toUpperCase();
  if (event.amountMinor !== Number(link.amount_minor) || currency !== link.currency) {
    const why = `the link was for ${formatMoneyMinor(Number(link.amount_minor), link.currency)} and ${formatMoneyMinor(event.amountMinor, currency)} was paid.`;
    await askPerson(ctx, settings, link, invoice, event, why);
    return { result: "needs_attention", detail: why, invoiceId: invoice.id };
  }
  let settled: Awaited<ReturnType<typeof settle>>;
  try {
    settled = await settle(ctx, {
      companyId: link.company_id,
      invoiceId: invoice.id,
      amountMinor: event.amountMinor,
      sourceKey: `gateway:${link.provider}:${event.providerPaymentId ?? event.eventId}`,
      source: "gateway",
      paidAt: event.paidAt,
      method: link.provider === "stripe" ? "card" : link.provider,
      reference: `${PROVIDER_LABELS[link.provider]} ${event.providerPaymentId ?? ""}`.trim(),
      // Money held at the provider until it pays out: the clearing account, not the bank.
      bankAccountRole: "bank",
      bankAccountCode: clearingAccountCode(settings),
      createdBy: `provider:${link.provider}`,
    }, settings);
  } catch (error) {
    if (!(error instanceof BillingError)) throw error;
    const why = `${error.message}.`.replace(/\.\.$/, ".");
    await askPerson(ctx, settings, link, invoice, event, why);
    return { result: "needs_attention", detail: why, invoiceId: invoice.id };
  }
  await markLinkPaid(ctx, link.id, { providerPaymentId: event.providerPaymentId, paymentId: settled.paymentId, feeMinor: event.feeMinor, paidAt: event.paidAt });
  const payment = await paymentById(ctx, settled.paymentId);
  if (payment && event.feeMinor && event.feeMinor > 0) await postGatewayFee(ctx, invoice, payment, event.feeMinor, PROVIDER_LABELS[link.provider], clearingAccountCode(settings), settings);
  await closePopIssues(ctx, link.company_id, settled.confirmedPopIds);
  if (!settled.repeat && settled.creditMinor > 0) {
    // The invoice was paid another way first (or by a second link): the extra stays with the customer as credit and a person decides what to do with it.
    await askPerson(ctx, settings, { ...link, status: "paid" }, invoice, event, `the invoice no longer owed all of it, so ${formatMoneyMinor(settled.creditMinor, link.currency)} is now credit on the customer's account (refund it or apply it to another invoice).`);
  }
  return { result: "applied", detail: `Recorded ${formatMoneyMinor(settled.amountMinor, link.currency)} on ${settled.invoiceNumber}; the invoice is ${settled.status.replace(/_/g, " ")}`, invoiceId: invoice.id, paymentId: settled.paymentId };
}

export interface RefundInput {
  invoice: InvoiceRow;
  link: PaymentLinkRow | null;
  provider: PaymentLinkRow["provider"];
  amountMinor: number;
  source: "webhook" | "person";
  /** Unique per refund: the provider event, or a key the page makes. */
  sourceKey: string;
  reason: string | null;
  at: string;
  recordedBy: string | null;
}

export interface RefundOutcome {
  recorded: boolean;
  refundId: string;
  invoiceStatus: string;
  outstandingMinor: number;
}

/** Records money paid back to the customer: a negative payment, a refund row, the invoice owing again, the journal, and an issue for a person. */
export async function recordRefund(ctx: PluginContext, input: RefundInput, settings: BillingSettings): Promise<RefundOutcome> {
  const refundId = stableUuid(`refund:${input.provider}:${input.sourceKey}`);
  const invoice = input.invoice;
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new BillingError("A refund is a positive amount in cents");
  const inserted = await insertRefund(ctx, { id: refundId, companyId: invoice.company_id, invoiceId: invoice.id, linkId: input.link?.id ?? null, paymentId: null, provider: input.provider, sourceKey: input.sourceKey, amountMinor: input.amountMinor, reason: input.reason, source: input.source, recordedBy: input.recordedBy });
  if (!inserted) return { recorded: false, refundId, invoiceStatus: invoice.status, outstandingMinor: 0 };
  const paymentId = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payments")}
      (id, company_id, invoice_id, amount_minor, allocated_minor, method, reference, paid_at, source, source_key, currency, customer_kind, customer_ref, created_by)
     SELECT $1::text, i.company_id, i.id, $3::bigint, $3::bigint, $4::text, $5::text, $6::timestamptz, 'gateway_refund', $7::text, i.currency, i.customer_kind, i.customer_ref, $8::text
       FROM ${table(ctx, "invoices")} i WHERE i.id = $2::text
     ON CONFLICT (company_id, source_key) DO NOTHING`,
    [paymentId, invoice.id, -input.amountMinor, input.provider === "stripe" ? "card" : input.provider, `Refund${input.reason ? `: ${input.reason}` : ""}`.slice(0, 200), input.at, `refund:${refundId}`, input.recordedBy],
  );
  await ctx.db.execute(`UPDATE ${table(ctx, "payment_refunds")} SET payment_id = $2 WHERE id = $1`, [refundId, paymentId]);
  const refreshed = await refreshInvoiceStatus(ctx, invoice.id);
  await emitInvoiceItem(ctx, invoice.id);
  await postRefund(ctx, invoice, { id: refundId, amountMinor: input.amountMinor, date: input.at, reason: input.reason, provider: PROVIDER_LABELS[input.provider] }, clearingAccountCode(settings), settings);
  if (input.link) await setLinkRefunded(ctx, input.link.id, Number(input.link.refunded_minor) + input.amountMinor);
  const money = formatMoneyMinor(input.amountMinor, invoice.currency);
  const prefix = await companyPrefix(ctx, invoice.company_id);
  const issue = await openBillingApproval(ctx, settings, {
    companyId: invoice.company_id,
    title: `Refund recorded: ${money} on ${invoice.number} (${customerNameOf(invoice)})`,
    description: [
      `${money} was refunded to the customer through ${PROVIDER_LABELS[input.provider]}${input.reason ? ` (${input.reason})` : ""}. Billing recorded it: the payment is reversed, the books are updated and invoice ${invoice.number} is now ${(refreshed?.status ?? invoice.status).replace(/_/g, " ")} (it owes ${formatMoneyMinor(refreshed?.balance.outstandingMinor ?? 0, invoice.currency)} again).`,
      "",
      "Decide what the invoice should do now, then mark this issue done:",
      "- the sale is cancelled or the customer is credited: issue a credit note on the Billing page;",
      "- the customer will pay again: leave it (reminders resume if they are on);",
      "- you do not want reminders for it: write it off or opt the client out.",
      "",
      `Invoice: ${billingPath(prefix, { tab: "invoices" })}`,
    ].join("\n"),
    originId: `${APPROVAL_ORIGINS.refund}${refundId}`,
    outward: false,
  });
  await recordDecisionIssue(ctx, { issueId: issue.id, companyId: invoice.company_id, kind: "refund", subjectKind: "invoice", subjectId: invoice.id, payload: { invoiceId: invoice.id, number: invoice.number, amountMinor: input.amountMinor, currency: invoice.currency, refundId } });
  return { recorded: true, refundId, invoiceStatus: refreshed?.status ?? invoice.status, outstandingMinor: refreshed?.balance.outstandingMinor ?? 0 };
}

async function applyRefundEvent(ctx: PluginContext, link: PaymentLinkRow, event: ProviderEvent, settings: BillingSettings): Promise<ApplyOutcome> {
  const invoice = await getInvoice(ctx, link.invoice_id);
  if (!invoice || invoice.company_id !== link.company_id) return { result: "ignored", detail: "Refund for an invoice that is not in Billing" };
  // A refund reverses a payment Billing recorded. Providers do not promise to deliver events in order, so a refund can arrive first:
  // an active link has not taken the money yet (as far as Billing knows), so fail the delivery and the provider sends it again later.
  // Any other link without a recorded payment (a payment a person was asked about, a failed or withdrawn link) has nothing to reverse.
  if (!link.payment_id) {
    if (link.status === "active") throw new Error("A refund arrived before the payment it refunds was recorded. It will be applied when the provider sends it again.");
    return { result: "ignored", detail: `Refund for a payment Billing did not record (the link is ${link.status.replace(/_/g, " ")}), so there is nothing to reverse`, invoiceId: invoice.id };
  }
  // The provider reports the total refunded so far; only the part not recorded yet is new.
  const delta = event.amountMinor - Number(link.refunded_minor);
  if (delta <= 0) return { result: "ignored", detail: "That refund is already recorded", invoiceId: invoice.id };
  const outcome = await recordRefund(ctx, { invoice, link, provider: link.provider, amountMinor: delta, source: "webhook", sourceKey: `${event.providerPaymentId ?? link.id}:${event.amountMinor}`, reason: null, at: event.paidAt, recordedBy: `provider:${link.provider}` }, settings);
  return { result: "applied", detail: `Recorded a refund of ${formatMoneyMinor(delta, invoice.currency)}; the invoice is ${outcome.invoiceStatus.replace(/_/g, " ")}`, invoiceId: invoice.id };
}

/**
 * Applies one verified event at most once. A repeat of an event that finished is answered "duplicate";
 * one that failed halfway is run again (every step is idempotent), and its failure is thrown so the host
 * answers the provider with an error and it retries.
 */
export async function applyProviderEvent(ctx: PluginContext, link: PaymentLinkRow, event: ProviderEvent, settings: BillingSettings): Promise<ApplyOutcome> {
  const key = `${link.provider}:${event.eventId}`;
  const fresh = await recordEvent(ctx, { key, companyId: link.company_id, provider: link.provider, kind: event.kind, linkId: link.id });
  if (!fresh) {
    const prior = await eventResult(ctx, key);
    if (prior && prior !== "failed") return { result: "duplicate", detail: `Already handled (${prior})` };
  }
  try {
    let outcome: ApplyOutcome;
    if (event.kind === "payment_confirmed") outcome = await confirmPayment(ctx, link, event, settings);
    else if (event.kind === "refund") outcome = await applyRefundEvent(ctx, link, event, settings);
    else {
      await ctx.db.execute(`UPDATE ${table(ctx, "payment_links")} SET last_error = $2, updated_at = now() WHERE id = $1 AND status = 'active'`, [link.id, "The payment failed at the provider (the customer can try again on the same link)"]);
      outcome = { result: "ignored", detail: "The payment failed at the provider" };
    }
    await finishEvent(ctx, key, outcome.result === "duplicate" ? "ignored" : outcome.result, outcome.detail);
    return outcome;
  } catch (error) {
    await finishEvent(ctx, key, "failed", error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
}
