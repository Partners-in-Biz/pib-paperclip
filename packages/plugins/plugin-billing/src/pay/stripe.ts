/**
 * Stripe: hosted checkout and webhook signatures (Q10-6), written against Stripe's published API
 * (Prices, Payment Links, the `Stripe-Signature` header). Off until the owner adds the keys.
 *
 * Why a Payment Link and not a bare Checkout Session. A Checkout Session expires within 24 hours,
 * and an invoice email is read days later. A Payment Link is a permanent hosted checkout page and
 * every payment on it produces the same `checkout.session.completed` event, so the webhook side is
 * the one Stripe documents for Checkout. The link is created with the invoice's own price (one
 * Price, then one Payment Link, each with an idempotency key so a retry never makes a second one),
 * takes one completed payment (`restrictions.completed_sessions.limit`) and carries our link id as
 * `client_reference_id` and metadata, which is how a payment finds its invoice.
 *
 * Webhook. The signature header holds a timestamp and one or more `v1` signatures: the HMAC-SHA256
 * of `<t>.<raw body>` keyed with the endpoint's signing secret. Only `v1` is believed, the timestamp
 * must be within five minutes (replay), and comparison is constant time. Events we act on:
 * `checkout.session.completed` (when `payment_status` is `paid`), `checkout.session.async_payment_succeeded`,
 * `checkout.session.async_payment_failed` and `charge.refunded` (refunds are reported as the total
 * refunded so far, so a repeat or an out-of-order delivery cannot count one twice).
 */
import { hmacHex, safeEqual } from "./crypto.js";
import { WebhookRejected, type CreatedLink, type LinkForVerify, type LinkRequest, type LocatedLink, type PaymentProvider, type ProviderEvent, type WebhookInput } from "./types.js";

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_TOLERANCE_SECONDS = 300;

/** Currencies Stripe counts in whole units: Billing keeps minor units with two decimals, so these are not offered. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export class PaymentProviderError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
}

/** Flatten nested params to Stripe's `a[b][0][c]=value` form encoding. */
export function stripeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return pairs.join("&");
}

/** Parse `t=...,v1=...,v1=...` (other schemes are ignored: a downgrade to v0 must not pass). */
export function parseStripeSignature(header: string | undefined): { timestamp: number | null; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of (header ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]+$/i.test(value)) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

/**
 * What can be told about a delivery's signature without the secret: the header is there, carries a timestamp and a
 * `v1` signature of the right shape, and is fresh. The webhook address is public and the host lets a plugin resolve 30
 * secrets a minute per company, so what is plainly not a signed Stripe delivery is refused before any secret is asked for.
 * Passing this proves nothing: `verifyStripeSignature` still has to match the HMAC.
 */
export function checkStripeSignatureShape(input: WebhookInput, toleranceSeconds = STRIPE_TOLERANCE_SECONDS): void {
  const { timestamp, signatures } = parseStripeSignature(input.headers["stripe-signature"]);
  if (timestamp == null || !signatures.some((signature) => /^[0-9a-f]{64}$/.test(signature))) throw new WebhookRejected("No usable Stripe-Signature header", "bad_signature");
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > toleranceSeconds) throw new WebhookRejected("The Stripe signature is too old or too far in the future", "stale");
}

/** Throws `WebhookRejected` unless the delivery was signed with `secret` within the tolerance. */
export function verifyStripeSignature(input: WebhookInput, secret: string, toleranceSeconds = STRIPE_TOLERANCE_SECONDS): void {
  if (!secret) throw new WebhookRejected("The Stripe signing secret is not set", "not_configured");
  const { timestamp, signatures } = parseStripeSignature(input.headers["stripe-signature"]);
  if (timestamp == null || signatures.length === 0) throw new WebhookRejected("No usable Stripe-Signature header", "bad_signature");
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > toleranceSeconds) throw new WebhookRejected("The Stripe signature is too old or too far in the future", "stale");
  const expected = hmacHex(secret, `${timestamp}.${input.rawBody}`);
  if (!signatures.some((signature) => safeEqual(signature, expected))) throw new WebhookRejected("The Stripe signature does not match", "bad_signature");
}

/** Build the header Stripe would send (for tests and the mock journey). */
export function signStripeBody(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

function parseEvent(rawBody: string): Obj | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Obj) : null;
  } catch {
    return null;
  }
}

const HANDLED = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "charge.refunded"]);

export class StripeProvider implements PaymentProvider {
  readonly key = "stripe" as const;
  readonly label = "Card (Stripe)";
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: StripeConfig) {
    this.doFetch = config.fetchImpl ?? fetch;
  }

  private async call<T>(path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    const response = await this.doFetch(`${STRIPE_API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      body: stripeForm(params),
    });
    const body = (await response.json().catch(() => ({}))) as Obj;
    if (!response.ok) throw new PaymentProviderError(`Stripe refused the request: ${text(obj(body.error).message) ?? `HTTP ${response.status}`}`, response.status);
    return body as T;
  }

  async createLink(request: LinkRequest): Promise<CreatedLink> {
    const currency = request.currency.toUpperCase();
    if (ZERO_DECIMAL.has(currency)) throw new PaymentProviderError(`Stripe links are not offered in ${currency} (it has no cents). Ask for EFT instead.`);
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) throw new PaymentProviderError("A payment link needs an amount above zero");
    const price = await this.call<{ id?: string }>("/v1/prices", { currency: currency.toLowerCase(), unit_amount: request.amountMinor, product_data: { name: `Invoice ${request.invoiceNumber}` } }, `${request.linkId}:price`);
    if (!price.id) throw new PaymentProviderError("Stripe did not return a price");
    const link = await this.call<{ id?: string; url?: string }>(
      "/v1/payment_links",
      {
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { pib_link: request.linkId, invoice: request.invoiceNumber },
        payment_intent_data: { metadata: { pib_link: request.linkId, invoice: request.invoiceNumber }, description: request.description.slice(0, 200) },
        restrictions: { completed_sessions: { limit: 1 } },
        after_completion: { type: "hosted_confirmation", hosted_confirmation: { custom_message: `Thank you. Invoice ${request.invoiceNumber} is paid.` } },
        inactive_message: `Invoice ${request.invoiceNumber} was already paid or is no longer open. Reply to the email we sent you if you need help.`,
      },
      `${request.linkId}:link`,
    );
    if (!link.id || !link.url) throw new PaymentProviderError("Stripe did not return a payment link");
    const url = new URL(link.url);
    url.searchParams.set("client_reference_id", request.linkId);
    return { url: url.toString(), providerRef: link.id };
  }

  async deactivateLink(link: { providerRef: string | null }): Promise<void> {
    if (!link.providerRef) return;
    await this.call(`/v1/payment_links/${encodeURIComponent(link.providerRef)}`, { active: false }, `deactivate:${link.providerRef}`);
  }

  locate(input: WebhookInput): LocatedLink | null {
    const event = parseEvent(input.rawBody);
    if (!event || !HANDLED.has(String(event.type))) return null;
    const data = obj(obj(event.data).object);
    const linkId = text(data.client_reference_id) ?? text(obj(data.metadata).pib_link);
    const providerPaymentId = text(data.payment_intent);
    return linkId || providerPaymentId ? { linkId, providerPaymentId } : null;
  }

  async verify(input: WebhookInput, link: LinkForVerify): Promise<ProviderEvent[]> {
    verifyStripeSignature(input, this.config.webhookSecret);
    const event = parseEvent(input.rawBody);
    if (!event || typeof event.id !== "string" || typeof event.type !== "string") throw new WebhookRejected("The Stripe event is not readable", "invalid");
    const data = obj(obj(event.data).object);
    const at = typeof event.created === "number" ? new Date(event.created * 1000).toISOString() : input.now.toISOString();
    const paymentIntent = text(data.payment_intent);
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        // A completed session can still be awaiting a slower method (a bank transfer): only `paid` is money.
        if (data.payment_status !== "paid") return [];
        const amount = whole(data.amount_total);
        if (amount == null) throw new WebhookRejected("The Stripe session has no amount", "invalid");
        return [{ kind: "payment_confirmed", eventId: event.id, linkId: link.id, providerPaymentId: paymentIntent ?? text(data.id), amountMinor: amount, currency: text(data.currency)?.toUpperCase() ?? null, feeMinor: null, paidAt: at, reference: text(data.id), status: String(data.payment_status) }];
      }
      case "checkout.session.async_payment_failed":
        return [{ kind: "payment_failed", eventId: event.id, linkId: link.id, providerPaymentId: paymentIntent, amountMinor: whole(data.amount_total) ?? 0, currency: text(data.currency)?.toUpperCase() ?? null, feeMinor: null, paidAt: at, reference: text(data.id), status: "async_payment_failed" }];
      case "charge.refunded": {
        const refunded = whole(data.amount_refunded);
        if (refunded == null || refunded <= 0 || !paymentIntent) return [];
        return [{ kind: "refund", eventId: event.id, linkId: link.id, providerPaymentId: paymentIntent, amountMinor: refunded, currency: text(data.currency)?.toUpperCase() ?? null, feeMinor: null, paidAt: at, reference: text(data.id), status: "refunded" }];
      }
      default:
        return [];
    }
  }
}
