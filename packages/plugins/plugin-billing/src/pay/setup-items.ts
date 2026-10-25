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

async function confirmed(ctx: PluginContext, companyId: string, provider: string): Promise<number> {
  const rows = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(ctx, "payment_events")} WHERE company_id = $1 AND provider = $2 AND kind = 'payment_confirmed' AND result = 'applied'`, [companyId, provider]);
  return Number(rows[0]?.n ?? 0);
}

export async function paymentSetupItems(ctx: PluginContext, companyId: string, settings: BillingSettings, settingsHref: string): Promise<SetupItem[]> {
  const items: SetupItem[] = [];
  const clearing = clearingAccountCode(settings);

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
      detail: "Needs your decision before it can be used. Built and tested, but it cannot be switched on yet. PayFast tells us a payment arrived by sending a web form, and the Paperclip server version in use accepts only JSON on plugin webhook addresses, so the notification would arrive empty and no payment could be confirmed. Decide one of: (1) approve a small change to the Paperclip server so plugin webhooks accept form posts (the same kind of change already made for chat webhooks), (2) use PayPal or another provider whose notifications are JSON, or (3) leave EFT only.",
      href: "https://www.payfast.co.za/registration",
      hrefLabel: "PayFast registration",
      steps: payfastSteps,
      agentNext: "After the server change, PayFast is switched on in settings and works like PayPal: a pay-online link on invoices and reminders, a payment recorded when PayFast's notification passes four checks (signature, source address, our merchant and a confirmation request back to PayFast).",
    });
  } else if (payfast.enabled) {
    const n = await confirmed(ctx, companyId, "payfast");
    items.push({ key: "pay_payfast", title: "Payments through PayFast", required: false, status: "done", detail: n > 0 ? `${n} payment${n === 1 ? "" : "s"} confirmed by PayFast so far.` : "On. No payment has been confirmed yet: pay a test invoice in the sandbox.", href: settingsHref, hrefLabel: "Open settings" });
  } else {
    items.push({ key: "pay_payfast", title: "Payments through PayFast", required: false, status: payfast.switchedOn ? "missing" : "optional", detail: payfast.switchedOn ? `PayFast is switched on but ${payfast.blocker?.toLowerCase() ?? "not complete"}` : "Optional. Lets South African customers pay from a link in the email (ZAR only). Off until you do the steps below.", href: "https://www.payfast.co.za/registration", hrefLabel: "PayFast registration", steps: payfastSteps });
  }

  const paypal = providerState(settings, "paypal");
  const paypalHook = webhookUrl(settings, "paypal");
  const paypalSteps = [
    "Open the PayPal Developer Dashboard (https://developer.paypal.com/dashboard/) and create (or open) the app for the business. Start in Sandbox.",
    "Copy the Client ID and Client Secret from the app credentials.",
    `In the app, add a webhook with the address ${paypalHook ?? "(save the public address of Paperclip in Billing settings first: it builds this address)"} and subscribe to PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED and PAYMENT.CAPTURE.REFUNDED. Copy the webhook id.`,
    "In Billing settings → Card and online payments → PayPal: paste the client id, client secret and webhook id as secrets, tick the sandbox box while testing, set the public address of Paperclip, switch PayPal on and Save.",
    `Check account ${clearing} exists in Accounting; PayPal payouts are categorised to it.`,
    "Pay a test invoice in the sandbox. When it shows as paid here, switch the sandbox off and use the live app credentials. PayPal does not take ZAR — use PayFast for rand invoices.",
  ];
  if (paypal.enabled) {
    const n = await confirmed(ctx, companyId, "paypal");
    items.push({
      key: "pay_paypal",
      title: "Payments through PayPal",
      required: false,
      status: "done",
      detail: n > 0 ? `${n} payment${n === 1 ? "" : "s"} confirmed by PayPal so far.` : "On. No payment has been confirmed yet: pay a test invoice in the sandbox.",
      href: settingsHref,
      hrefLabel: "Open settings",
      agentNext: `Sent invoices and reminders carry a pay-online link for non-ZAR currencies PayPal takes. A payment is recorded only when PayPal's signed notification arrives: the invoice is paid, the books get the journal (clearing account ${clearing}) and the CRM is told. Refunds in PayPal are recorded too.`,
    });
  } else {
    items.push({
      key: "pay_paypal",
      title: "Payments through PayPal",
      required: false,
      status: paypal.switchedOn ? "missing" : "optional",
      detail: paypal.switchedOn ? `PayPal is switched on but ${paypal.blocker?.toLowerCase() ?? "not complete"}` : "Optional. Lets customers pay an invoice online (USD, EUR, GBP; not ZAR). EFT stays the default and keeps working. Off until you do the steps below.",
      href: "https://developer.paypal.com/dashboard/",
      hrefLabel: "Open PayPal Developer Dashboard",
      steps: paypalSteps,
      agentNext: "Once on, every sent invoice and reminder gets a pay-online link (when the currency is one PayPal takes) and a confirmed payment is matched to its invoice and posted to the books by itself.",
    });
  }

  return items;
}
