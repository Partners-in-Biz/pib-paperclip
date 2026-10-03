/**
 * The payment provider boundary (audit Q10-6, money in).
 *
 * Billing never talks to a card network. A provider turns an invoice into a hosted
 * checkout link, and later says, through a signed webhook, that the money arrived.
 * Everything provider specific lives behind `PaymentProvider`; everything else
 * (matching the payment to its invoice, the journal, refunds, the emails) is the
 * same for every provider and is tested with the `mock` one.
 *
 * Rules every adapter keeps:
 * - A provider is off until its secrets exist and the owner switched it on
 *   (`providerReadiness`). EFT stays the default way to pay.
 * - A webhook is believed only after its signature (and, for PayFast, its source
 *   address and a server-side confirmation) checks out. A delivery that fails a
 *   check records nothing.
 * - Amounts are integer minor units. A payment whose amount or currency differs
 *   from the link it paid is never settled by itself: a person decides.
 */

export type ProviderKey = "stripe" | "payfast" | "mock";

/** Providers a real customer can pay through. `mock` is for tests and the canary journey only. */
export const REAL_PROVIDERS: ProviderKey[] = ["stripe", "payfast"];

export const PROVIDER_LABELS: Record<ProviderKey, string> = { stripe: "Card (Stripe)", payfast: "PayFast", mock: "Test provider" };

export interface LinkRequest {
  /** Our payment link id (a UUID). It travels to the provider as the reference the payment comes back with. */
  linkId: string;
  /** The invoice number and the amount are all a provider is told: no customer name, email or phone (data minimisation, POPIA). */
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  description: string;
}

export interface CreatedLink {
  url: string;
  /** The provider's id for the link (Stripe `plink_...`), when it has one. */
  providerRef: string | null;
}

/** What a webhook delivery looks like to an adapter (the host's `onWebhook` input plus what verification needs). */
export interface WebhookInput {
  /** The exact body bytes as text: signatures are computed over them. */
  rawBody: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  now: Date;
}

/** The link a delivery is about, as far as an unauthenticated reading of it can tell. */
export interface LocatedLink {
  linkId: string | null;
  providerPaymentId: string | null;
}

export type ProviderEventKind = "payment_confirmed" | "payment_failed" | "refund";

export interface ProviderEvent {
  kind: ProviderEventKind;
  /** Unique per provider event; with the provider it is the dedupe key. */
  eventId: string;
  linkId: string | null;
  providerPaymentId: string | null;
  /** Payment: the amount paid. Refund: the total refunded so far on that payment (the provider reports it cumulatively). */
  amountMinor: number;
  currency: string | null;
  /** The provider's fee, when the delivery carries it. */
  feeMinor: number | null;
  paidAt: string;
  reference: string | null;
  /** Provider status text, for the log line. */
  status: string;
}

export type RejectionCode = "bad_signature" | "bad_source" | "stale" | "invalid" | "not_confirmed" | "not_configured";

/** A delivery that failed a check. The host answers the provider with an error, which makes it retry or alert. */
export class WebhookRejected extends Error {
  constructor(message: string, readonly code: RejectionCode) {
    super(message);
    this.name = "WebhookRejected";
  }
}

export interface LinkForVerify {
  id: string;
  amountMinor: number;
  currency: string;
}

export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly label: string;
  createLink(request: LinkRequest): Promise<CreatedLink>;
  /** Stop a link from taking payments (the invoice was paid or cancelled). Best effort. */
  deactivateLink(link: { providerRef: string | null }): Promise<void>;
  /** Which of our links a delivery names, without trusting it. Null when it is not about a link. */
  locate(input: WebhookInput): LocatedLink | null;
  /** Authenticate the delivery and say what happened. Throws `WebhookRejected`. */
  verify(input: WebhookInput, link: LinkForVerify, remoteIp: string | null): Promise<ProviderEvent[]>;
}

/** Minor-unit amount from a decimal string such as `1234.56`, or null when it is not a plain amount. */
export function minorFromDecimal(value: unknown): number | null {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** `1234.56` for 123456. */
export function decimalFromMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
