/**
 * The provider webhook endpoints (`POST /api/plugins/partnersinbiz.billing/webhooks/<stripe|payfast>`).
 *
 * The host route is public and passes the plugin the raw body, the headers and nothing else: no
 * company, no caller. So a delivery is handled in this order, and nothing is believed before step 3:
 *
 * 1. Read the delivery without trusting it, only to learn which of OUR payment links it names (our
 *    link id comes back as the reference on Stripe and as `m_payment_id` on PayFast).
 * 2. The link row, in our own database, says which company it belongs to. A delivery naming no link of
 *    ours is answered with success and ignored (a Stripe account can have other products).
 * 3. That company's saved secrets verify the delivery (signature, and for PayFast the source address and
 *    the server confirmation). A Stripe delivery whose signature header is missing, malformed or stale is refused
 *    before any secret is resolved, and the signing secret is remembered for a minute (`webhookSecretFor`), so a
 *    flood cannot use up the host's 30 secret resolves a minute for the company. A delivery that fails is rejected with an error: it records nothing, and the
 *    provider retries or alerts.
 * 4. Only then is it applied, once (`confirm.ts`).
 *
 * Nothing in a delivery can pick the company or the invoice: only the link we made can.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { billingSettings } from "../config.js";
import { applyProviderEvent, type ApplyOutcome } from "./confirm.js";
import { remoteIpFrom } from "./crypto.js";
import { PayFastProvider } from "./payfast.js";
import { buildVerifier } from "./settings.js";
import { getLink, linkByProviderPayment } from "./store.js";
import { StripeProvider, checkStripeSignatureShape } from "./stripe.js";
import { WebhookRejected, type LocatedLink, type WebhookInput } from "./types.js";

export const WEBHOOK_KEYS = ["stripe", "payfast"] as const;
export type WebhookKey = (typeof WEBHOOK_KEYS)[number];

export function isWebhookKey(value: string): value is WebhookKey {
  return (WEBHOOK_KEYS as readonly string[]).includes(value);
}

/** The headers with lower-cased names and one string each. */
export function normaliseHeaders(headers: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const text = Array.isArray(value) ? value.join(", ") : value;
    if (typeof text === "string") out[name.toLowerCase()] = text;
  }
  return out;
}

/** Which of our links a delivery names, read without any secret (a hint only: nothing is believed until it verifies). */
export function locateLink(key: WebhookKey, input: WebhookInput): LocatedLink | null {
  const reader = key === "stripe" ? new StripeProvider({ secretKey: "", webhookSecret: "" }) : new PayFastProvider({ merchantId: "", merchantKey: "", notifyUrl: "" });
  return reader.locate(input);
}

export interface WebhookOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  resolveAddresses?: (host: string) => Promise<string[]>;
}

export interface WebhookResult {
  handled: boolean;
  outcomes: ApplyOutcome[];
  reason?: string;
}

export async function handleBillingWebhook(ctx: PluginContext, input: Pick<PluginWebhookInput, "endpointKey" | "headers" | "rawBody">, options: WebhookOptions = {}): Promise<WebhookResult> {
  if (!isWebhookKey(input.endpointKey)) throw new Error(`Unknown webhook endpoint ${input.endpointKey}`);
  const key = input.endpointKey;
  const delivery: WebhookInput = { rawBody: input.rawBody ?? "", headers: normaliseHeaders(input.headers), now: options.now ?? new Date() };
  const located = locateLink(key, delivery);
  if (!located) return { handled: false, outcomes: [], reason: "not about a payment link" };
  let link = located.linkId ? await getLink(ctx, located.linkId) : null;
  if (!link && located.providerPaymentId) link = await linkByProviderPayment(ctx, key, located.providerPaymentId);
  if (!link || link.provider !== key) {
    ctx.logger.info("Payment webhook for a link Billing does not know", { provider: key });
    return { handled: false, outcomes: [], reason: "unknown link" };
  }
  // Refuse what is plainly not a signed delivery before any secret is asked for (the address is public; see `webhookSecretFor`).
  if (key === "stripe") {
    try {
      checkStripeSignatureShape(delivery);
    } catch (error) {
      if (error instanceof WebhookRejected) ctx.logger.warn("Payment webhook refused", { provider: key, code: error.code });
      throw error;
    }
  }
  const settings = await billingSettings(ctx, link.company_id);
  const verifier = await buildVerifier(ctx, link.company_id, settings, key, { fetchImpl: options.fetchImpl, resolveAddresses: options.resolveAddresses, nowMs: delivery.now.getTime() });
  if (!verifier) throw new WebhookRejected(`${key} is not set up for this company (secrets missing)`, "not_configured");
  let events;
  try {
    events = await verifier.verify(delivery, { id: link.id, amountMinor: Number(link.amount_minor), currency: link.currency }, remoteIpFrom(delivery.headers));
  } catch (error) {
    if (error instanceof WebhookRejected) ctx.logger.warn("Payment webhook refused", { provider: key, code: error.code });
    throw error;
  }
  const outcomes: ApplyOutcome[] = [];
  for (const event of events) {
    // Each event sees the link as the one before left it (a refund after a payment).
    const fresh = (await getLink(ctx, link.id)) ?? link;
    outcomes.push(await applyProviderEvent(ctx, fresh, event, settings));
  }
  return { handled: true, outcomes };
}
