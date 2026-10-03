/** The actions and tools behind online payments: make a link, list links, withdraw one, record a refund, rehearse a payment. */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isCanaryCustomer } from "../canary.js";
import { loadBilling } from "../config.js";
import { BillingError, isOpenStatus } from "../domain.js";
import { requireOwnInvoice } from "../invoices.js";
import { actorLabel, optionalInteger, optionalString, requiredCompany, requiredString, requirePerson } from "../util.js";
import { applyProviderEvent } from "./confirm.js";
import { recordRefund } from "./confirm.js";
import { ensurePaymentLinks, retireLink } from "./links.js";
import { mockEvent } from "./mock.js";
import { enabledProviderKeys, paymentSettings, providerStates, webhookUrl } from "./settings.js";
import { getLink, linksForCompany, linksForInvoice, recentEvents, refundsForInvoice, type LinkStatus, type PaymentLinkRow } from "./store.js";
import { PROVIDER_LABELS, REAL_PROVIDERS, type ProviderKey } from "./types.js";

const LINK_STATUSES: LinkStatus[] = ["active", "paid", "cancelled", "needs_attention", "failed"];

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function publicLink(row: PaymentLinkRow) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    provider: row.provider,
    label: PROVIDER_LABELS[row.provider] ?? row.provider,
    status: row.status,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    // The address is shown only while it can be paid.
    url: row.status === "active" ? row.url : null,
    paidAt: iso(row.paid_at),
    feeMinor: row.fee_minor == null ? null : Number(row.fee_minor),
    refundedMinor: Number(row.refunded_minor ?? 0),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
  };
}

function providerParam(params: Record<string, unknown>): ProviderKey | null {
  const value = optionalString(params, "provider");
  if (!value) return null;
  if (!(REAL_PROVIDERS as string[]).includes(value)) throw new BillingError("provider is stripe or payfast");
  return value as ProviderKey;
}

export async function createPaymentLinkAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "draft") throw new BillingError(`Invoice ${invoice.number} is still a draft. Its payment link is made when it is sent, for what it owes then.`);
  if (!isOpenStatus(invoice.status)) throw new BillingError(`Invoice ${invoice.number} is ${invoice.status.replace(/_/g, " ")}, so there is nothing to pay online.`);
  const { settings } = await loadBilling(ctx, companyId);
  const on = enabledProviderKeys(settings);
  if (on.length === 0) {
    const reasons = providerStates(settings).filter((s) => s.key !== "mock").map((s) => `${s.label}: ${s.blocker ?? "off"}`);
    throw new BillingError(`No online payment provider is switched on, so the way to pay is EFT. (${reasons.join(" ")})`);
  }
  const canary = isCanaryCustomer(invoice);
  if (canary && !on.includes("mock")) throw new BillingError("This invoice is for the canary (test) client, which only ever gets the test provider's link, and the test provider is off.");
  const only = providerParam(params);
  const providers = only ? on.filter((key) => key === only) : on;
  if (providers.length === 0) throw new BillingError(`${PROVIDER_LABELS[only!]} is not switched on for this company.`);
  const result = await ensurePaymentLinks(ctx, invoice, settings, { createdBy: actorLabel(context), providers });
  if (result.links.length === 0) throw new BillingError(`No payment link could be made: ${result.problems.join("; ") || "the invoice owes nothing"}.`);
  // A test link on a real customer's invoice (made by hand to rehearse the books) is not shown on its emails or PDF.
  const testOnly = !canary && result.links.some((link) => link.provider === "mock");
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    links: result.links.map((link) => ({ id: link.id, provider: link.provider, label: link.label, url: link.url, amountMinor: link.amountMinor })),
    problems: result.problems,
    next: `Invoice and reminder emails already carry these links${testOnly ? " (a test link is never shown to a real customer)" : ""}. Nothing was sent. The invoice becomes paid only when the provider confirms the payment.`,
  };
}

export async function paymentLinksAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoiceId = optionalString(params, "invoiceId");
  const status = optionalString(params, "status");
  if (status && !(LINK_STATUSES as string[]).includes(status)) throw new BillingError(`status is one of ${LINK_STATUSES.join(", ")}`);
  if (invoiceId) {
    const invoice = await requireOwnInvoice(ctx, companyId, invoiceId);
    return (await linksForInvoice(ctx, invoice.id, status ? [status as LinkStatus] : undefined)).map(publicLink);
  }
  return (await linksForCompany(ctx, companyId, status ? [status as LinkStatus] : ["active", "needs_attention", "failed"], 500)).map(publicLink);
}

export async function cancelPaymentLinkAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "withdrawing a payment link");
  const companyId = requiredCompany(context);
  const link = await getLink(ctx, requiredString(params, "linkId"));
  if (!link || link.company_id !== companyId) throw new BillingError("Payment link was not found");
  if (link.status !== "active") throw new BillingError(`This link is ${link.status.replace(/_/g, " ")}, so there is nothing to withdraw.`);
  await retireLink(ctx, link, (await loadBilling(ctx, companyId)).settings);
  return publicLink((await getLink(ctx, link.id))!);
}

/** A person records money paid back to the customer through a provider (Stripe's own refunds arrive by webhook). */
export async function recordRefundAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const recordedBy = requirePerson(context, "recording a refund");
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const amount = optionalInteger(params, "amountMinor");
  if (!amount || amount <= 0) throw new BillingError("amountMinor is the refund in cents");
  const only = providerParam(params);
  const paid = (await linksForInvoice(ctx, invoice.id, ["paid"])).filter((link) => !only || link.provider === only);
  const link = paid[0];
  if (!link) throw new BillingError(`No online payment was taken for ${invoice.number}, so there is nothing to refund through a provider. A refund of an EFT payment is money you pay out of the bank: record it in Accounting.`);
  const refundable = Number(link.amount_minor) - Number(link.refunded_minor);
  if (amount > refundable) throw new BillingError(`Only ${refundable / 100} of the ${Number(link.amount_minor) / 100} paid through ${PROVIDER_LABELS[link.provider]} can still be refunded.`);
  const { settings } = await loadBilling(ctx, companyId);
  const reference = optionalString(params, "reference");
  const outcome = await recordRefund(ctx, {
    invoice,
    link,
    provider: link.provider,
    amountMinor: amount,
    source: "person",
    sourceKey: `person:${link.id}:${reference ?? randomUUID()}`,
    reason: optionalString(params, "reason") ?? null,
    at: new Date().toISOString(),
    recordedBy: recordedBy ? `user:${recordedBy}` : null,
  }, settings);
  return { invoiceId: invoice.id, number: invoice.number, refundId: outcome.refundId, recorded: outcome.recorded, invoiceStatus: outcome.invoiceStatus, outstandingMinor: outcome.outstandingMinor };
}

/**
 * Rehearsal: a person "pays" or "refunds" a link of the test provider, through exactly the path a real
 * confirmed payment takes (matching, the journal, the refund). Only the test provider, only when it is on.
 */
export async function simulatePaymentAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "rehearsing a payment");
  const companyId = requiredCompany(context);
  const { settings } = await loadBilling(ctx, companyId);
  if (paymentSettings(settings).mock?.enabled !== true) throw new BillingError("The test provider is off. It is for the canary journey: switch it on in Billing settings under Card and online payments.");
  const link = await getLink(ctx, requiredString(params, "linkId"));
  if (!link || link.company_id !== companyId || link.provider !== "mock") throw new BillingError("That is not a test payment link");
  const kind = optionalString(params, "kind") === "refund" ? "refund" : "payment_confirmed";
  const amount = kind === "refund" ? optionalInteger(params, "amountMinor") ?? Number(link.amount_minor) : Number(link.amount_minor);
  const event = mockEvent({ kind, linkId: link.id, amountMinor: amount, currency: link.currency, paymentId: `mock_pay_${link.id.slice(0, 8)}`, feeMinor: kind === "payment_confirmed" ? optionalInteger(params, "feeMinor") ?? null : null, seq: kind === "refund" ? amount : 1 });
  return applyProviderEvent(ctx, link, event, settings);
}

/** What the Billing page and Setup need to say about online payments. */
export async function paymentsStatusAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const { settings } = await loadBilling(ctx, companyId);
  const [attention, events] = await Promise.all([linksForCompany(ctx, companyId, ["needs_attention", "failed"], 20), recentEvents(ctx, companyId, 10)]);
  return {
    providers: providerStates(settings).map((state) => ({ ...state, webhookUrl: state.key === "stripe" || state.key === "payfast" ? webhookUrl(settings, state.key) : null })),
    attention: attention.map(publicLink),
    events: events.map((e) => ({ key: e.key, provider: e.provider, kind: e.kind, result: e.result, detail: e.detail, at: iso(e.received_at) })),
  };
}

export { refundsForInvoice };
