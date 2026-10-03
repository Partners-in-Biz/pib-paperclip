/**
 * The Setup checklist items for online payments (provider boundary rule): one per provider, optional, each with
 * the exact steps and deep links the owner needs, and what the agent does once it is done. Nothing here creates an
 * account or enters a credential: those are the owner's one-time steps.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SetupItem } from "@partnersinbiz/pib-plugin-kit";
import type { BillingSettings } from "../config.js";
import { table } from "../db.js";
import { ITN_VIA_HOST } from "./payfast.js";
import { clearingAccountCode, providerState, webhookUrl } from "./settings.js";

const STRIPE_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "charge.refunded"];

async function confirmed(ctx: PluginContext, companyId: string, provider: string): Promise<number> {
  const rows = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(ctx, "payment_events")} WHERE company_id = $1 AND provider = $2 AND kind = 'payment_confirmed' AND result = 'applied'`, [companyId, provider]);
  return Number(rows[0]?.n ?? 0);
}

export async function paymentSetupItems(ctx: PluginContext, companyId: string, settings: BillingSettings, settingsHref: string): Promise<SetupItem[]> {
  const items: SetupItem[] = [];
  const clearing = clearingAccountCode(settings);

  const stripe = providerState(settings, "stripe");
  const stripeHook = webhookUrl(settings, "stripe");
  const stripeSteps = [
    "Open Stripe (https://dashboard.stripe.com/register) and create the account for the business, or sign in. Stripe must be available for your country: its dashboard says so while you register.",
    "Use test mode first. In Developers → API keys (https://dashboard.stripe.com/apikeys) create a **restricted key** that can only write Products, Prices and Payment Links (nothing else), and copy it.",
    `In Developers → Webhooks (https://dashboard.stripe.com/webhooks) add an endpoint with the address ${stripeHook ?? "(save the public address of Paperclip in Billing settings first: it builds this address)"} and these events: ${STRIPE_EVENTS.join(", ")}. Copy its signing secret (starts whsec_).`,
    "In Billing settings → Card and online payments: set the public address of Paperclip, paste the key and the signing secret as secrets, switch on **Accept card payments through Stripe**, and Save.",
    `In Accounting, check account ${clearing} (Payment provider clearing) exists: Accounting 0.4 adds it. Each Stripe payout bank line is categorised to it. Stripe's notification carries no fee and this key cannot read it, so Billing posts no Stripe fee: the payout arrives net of it and the Bookkeeper books the fee to bank charges from each payout.`,
    "Make a test payment with a Stripe test card on a test invoice. When it shows as paid here, repeat the keys and webhook in live mode.",
  ];
  if (stripe.enabled) {
    const n = await confirmed(ctx, companyId, "stripe");
    items.push({
      key: "pay_stripe",
      title: "Card payments (Stripe)",
      required: false,
      status: "done",
      detail: n > 0 ? `${n} payment${n === 1 ? "" : "s"} confirmed by Stripe so far.` : "On. No payment has been confirmed yet: make a test payment to prove the webhook works.",
      href: settingsHref,
      hrefLabel: "Open settings",
      agentNext: `Sent invoices and reminders carry a pay-online link. A payment is recorded only when Stripe's signed notification arrives: the invoice is paid, the books get the journal (clearing account ${clearing}) and the CRM is told. Refunds in Stripe are recorded too. Stripe's fee is not in its notification, so Billing does not post it: the Bookkeeper books it from each payout.`,
    });
  } else {
    items.push({
      key: "pay_stripe",
      title: "Card payments (Stripe)",
      required: false,
      status: stripe.switchedOn ? "missing" : "optional",
      detail: stripe.switchedOn ? `Stripe is switched on but ${stripe.blocker?.toLowerCase() ?? "not complete"}` : "Optional. Lets customers pay an invoice by card from a link in the email. EFT stays the default and keeps working. Off until you do the steps below.",
      href: "https://dashboard.stripe.com/apikeys",
      hrefLabel: "Open Stripe API keys",
      steps: stripeSteps,
      agentNext: "Once on, every sent invoice and reminder gets a pay-online link and a confirmed payment is matched to its invoice and posted to the books by itself (Stripe's fee is booked from each payout by the Bookkeeper).",
    });
  }

  const payfast = providerState(settings, "payfast");
  const payfastSteps = [
    "Open PayFast (https://www.payfast.co.za/registration) and register the business, or sign in. Start in the sandbox (https://sandbox.payfast.co.za).",
    "In PayFast: Settings → Integration. Note the Merchant ID and Merchant Key and set a passphrase.",
    "In Billing settings → Card and online payments → PayFast: enter the Merchant ID, paste the Merchant Key and the passphrase as secrets, tick the sandbox box while testing, set the public address of Paperclip, switch PayFast on and Save.",
    `PayFast posts its notification to ${webhookUrl(settings, "payfast") ?? "(the public address of Paperclip first)"}: nothing to enter in PayFast, the address travels with each payment.`,
    `Check account ${clearing} exists in Accounting; PayFast payouts are categorised to it.`,
    "Pay a test invoice in the sandbox. When it shows as paid here, switch the sandbox off and use the live merchant details.",
  ];
  // The host cannot deliver PayFast notifications whatever the owner switches on, so the decision is shown even while PayFast is off.
  if (!ITN_VIA_HOST) {
    items.push({
      key: "pay_payfast",
      title: "Payments through PayFast",
      required: false,
      status: "optional",
      detail: "Needs your decision before it can be used. Built and tested, but it cannot be switched on yet. PayFast tells us a payment arrived by sending a web form, and the Paperclip server version in use accepts only JSON on plugin webhook addresses, so the notification would arrive empty and no payment could be confirmed. Decide one of: (1) approve a small change to the Paperclip server so plugin webhooks accept form posts (the same kind of change already made for chat webhooks), (2) use Stripe or another provider whose notifications are JSON (Yoco and Paystack both have South African merchants and JSON notifications), or (3) leave EFT only.",
      href: "https://www.payfast.co.za/registration",
      hrefLabel: "PayFast registration",
      steps: payfastSteps,
      agentNext: "After the server change, PayFast is switched on in settings and works like Stripe: a pay-online link on invoices and reminders, a payment recorded when PayFast's notification passes four checks (signature, source address, our merchant and a confirmation request back to PayFast).",
    });
  } else if (payfast.enabled) {
    const n = await confirmed(ctx, companyId, "payfast");
    items.push({ key: "pay_payfast", title: "Payments through PayFast", required: false, status: "done", detail: n > 0 ? `${n} payment${n === 1 ? "" : "s"} confirmed by PayFast so far.` : "On. No payment has been confirmed yet: pay a test invoice in the sandbox.", href: settingsHref, hrefLabel: "Open settings" });
  } else {
    items.push({ key: "pay_payfast", title: "Payments through PayFast", required: false, status: payfast.switchedOn ? "missing" : "optional", detail: payfast.switchedOn ? `PayFast is switched on but ${payfast.blocker?.toLowerCase() ?? "not complete"}` : "Optional. Lets South African customers pay from a link in the email. Off until you do the steps below.", href: "https://www.payfast.co.za/registration", hrefLabel: "PayFast registration", steps: payfastSteps });
  }
  return items;
}
