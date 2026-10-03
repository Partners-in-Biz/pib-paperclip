/**
 * PayFast (South Africa): hosted checkout and ITN verification (Q10-6), written against PayFast's
 * documented custom integration. Off until the owner adds the merchant details.
 *
 * Checkout. The customer opens `https://www.payfast.co.za/eng/process?...` with the payment fields and
 * a signature: the fields that have a value, in PayFast's documented order, as `name=urlencode(value)`
 * joined by `&`, with `passphrase=...` last when the merchant account has one, then MD5 (lower case
 * hex). Our link id is `m_payment_id`. PayFast shows the payment page and, when it is paid, posts an
 * ITN (Instant Transaction Notification) to `notify_url`.
 *
 * ITN. The four checks PayFast documents, all of which must pass before money is believed:
 *  1. the signature: MD5 of every posted field except `signature`, in the order received, urlencoded,
 *     with the passphrase appended when there is one;
 *  2. the source: the request comes from one of PayFast's own addresses (www, w1w, w2w and sandbox
 *     hostnames, resolved here), read from the reverse proxy's X-Forwarded-For;
 *  3. the data: our merchant id, and the amount against the link (compared by the caller, which never
 *     settles a different amount by itself: it asks a person);
 *  4. a server-side confirmation: the same fields posted to `/eng/query/validate`, which answers VALID.
 *
 * HOST LIMIT (checked 2026-10-03 in server/src/app.ts and the live runtime). PayFast posts the ITN as
 * `application/x-www-form-urlencoded`. The host's plugin webhook route sits behind `express.json()`
 * only, so a form post arrives at the plugin with an EMPTY body and nothing to verify. Until the host
 * accepts form bodies for plugin webhooks (a small host change, which needs the owner's approval under
 * rule 7) PayFast cannot confirm a payment, so it is never offered: `payfastReadiness` says why, and
 * the Setup checklist item says what the owner decides. Flip `ITN_VIA_HOST` when that lands.
 */
import { lookup } from "node:dns/promises";
import { md5Hex, phpUrlencode, safeEqual } from "./crypto.js";
import { PaymentProviderError } from "./stripe.js";
import { decimalFromMinor, minorFromDecimal, WebhookRejected, type CreatedLink, type LinkForVerify, type LinkRequest, type LocatedLink, type PaymentProvider, type ProviderEvent, type WebhookInput } from "./types.js";

/** True once the host passes form-encoded plugin webhook bodies through. See the module header. */
export const ITN_VIA_HOST = false;

export const PAYFAST_HOSTS = ["www.payfast.co.za", "sandbox.payfast.co.za", "w1w.payfast.co.za", "w2w.payfast.co.za"];
export const PAYFAST_LIVE = "https://www.payfast.co.za";
export const PAYFAST_SANDBOX = "https://sandbox.payfast.co.za";

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase?: string | null;
  sandbox?: boolean;
  /** Where PayFast posts the ITN: `<public address>/api/plugins/partnersinbiz.billing/webhooks/payfast`. */
  notifyUrl: string;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  fetchImpl?: typeof fetch;
  /** Resolves a hostname to its addresses (tests inject a fixed answer). */
  resolveAddresses?: (host: string) => Promise<string[]>;
}

/** The documented order of the checkout fields. A value that is empty is left out of the string. */
const FIELD_ORDER = ["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "name_first", "name_last", "email_address", "cell_number", "m_payment_id", "amount", "item_name", "item_description"] as const;

/** `name=urlencode(value)&...` over the non-empty values in order, then the passphrase, then MD5. */
export function payfastCheckoutSignature(fields: Record<string, string>, passphrase?: string | null): string {
  const parts = FIELD_ORDER.filter((name) => (fields[name] ?? "") !== "").map((name) => `${name}=${phpUrlencode(fields[name]!)}`);
  if (passphrase) parts.push(`passphrase=${phpUrlencode(passphrase)}`);
  return md5Hex(parts.join("&"));
}

/** The posted fields in the order they arrived. */
export function parseForm(rawBody: string): Array<[string, string]> {
  if (!rawBody.trim()) return [];
  return [...new URLSearchParams(rawBody.trim()).entries()];
}

/** The string PayFast signs and the server confirmation posts: every field but the signature, in order, urlencoded. */
export function itnParamString(entries: Array<[string, string]>): string {
  return entries.filter(([key]) => key !== "signature").map(([key, value]) => `${key}=${phpUrlencode(value)}`).join("&");
}

export function itnSignature(entries: Array<[string, string]>, passphrase?: string | null): string {
  const base = itnParamString(entries);
  return md5Hex(passphrase ? `${base}&passphrase=${phpUrlencode(passphrase)}` : base);
}

/** Build a signed ITN body (for tests): the fields in order plus their signature. */
export function signItn(fields: Array<[string, string]>, passphrase?: string | null): string {
  const signature = itnSignature(fields, passphrase);
  return `${itnParamString(fields)}&signature=${signature}`;
}

export interface Readiness {
  ready: boolean;
  /** Why it is not ready, in words an owner can act on. */
  blocker: string | null;
  code: "ok" | "off" | "missing" | "host_limit";
}

/** Whether PayFast links may be offered: switched on, complete, and the host can deliver its notifications. */
export function payfastReadiness(settings: { enabled?: boolean; merchantId?: unknown; merchantKey?: unknown; hasPassphrase?: boolean }, publicBaseUrl: string | null, hostPassesForms: boolean = ITN_VIA_HOST): Readiness {
  if (settings.enabled !== true) return { ready: false, blocker: "PayFast is switched off in Billing settings.", code: "off" };
  const missing = [!settings.merchantId && "merchant ID", !settings.merchantKey && "merchant key", !publicBaseUrl && "public address of Paperclip"].filter(Boolean);
  if (missing.length) return { ready: false, blocker: `Missing: ${missing.join(", ")}.`, code: "missing" };
  if (!hostPassesForms) return { ready: false, blocker: "This Paperclip version cannot receive PayFast notifications (PayFast sends them as web forms and the plugin webhook route reads only JSON), so a payment could not be confirmed.", code: "host_limit" };
  return { ready: true, blocker: null, code: "ok" };
}

export class PayFastProvider implements PaymentProvider {
  readonly key = "payfast" as const;
  readonly label = "PayFast";
  private readonly doFetch: typeof fetch;
  private addresses: { at: number; set: Set<string> } | null = null;

  constructor(private readonly config: PayFastConfig) {
    this.doFetch = config.fetchImpl ?? fetch;
  }

  private base(): string {
    return this.config.sandbox ? PAYFAST_SANDBOX : PAYFAST_LIVE;
  }

  async createLink(request: LinkRequest): Promise<CreatedLink> {
    if (request.currency.toUpperCase() !== "ZAR") throw new PaymentProviderError(`PayFast takes rand only, and this invoice is in ${request.currency.toUpperCase()}. Ask for EFT instead.`);
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) throw new PaymentProviderError("A payment link needs an amount above zero");
    // Only the invoice number and the amount go to PayFast and into the address: no customer name or email (the buyer types them on PayFast's page).
    const fields: Record<string, string> = {
      merchant_id: this.config.merchantId,
      merchant_key: this.config.merchantKey,
      return_url: this.config.returnUrl ?? "",
      cancel_url: this.config.cancelUrl ?? "",
      notify_url: this.config.notifyUrl,
      m_payment_id: request.linkId,
      amount: decimalFromMinor(request.amountMinor),
      item_name: `Invoice ${request.invoiceNumber}`.slice(0, 100),
      item_description: request.description.slice(0, 255),
    };
    const signature = payfastCheckoutSignature(fields, this.config.passphrase);
    const query = FIELD_ORDER.filter((field) => (fields[field] ?? "") !== "").map((field) => `${field}=${phpUrlencode(fields[field]!)}`).join("&");
    return { url: `${this.base()}/eng/process?${query}&signature=${signature}`, providerRef: null };
  }

  async deactivateLink(): Promise<void> {
    // A PayFast link is only a signed address: there is nothing to switch off. A paid or cancelled invoice refuses the payment when it arrives.
  }

  locate(input: WebhookInput): LocatedLink | null {
    const data = Object.fromEntries(parseForm(input.rawBody));
    const linkId = typeof data.m_payment_id === "string" && data.m_payment_id ? data.m_payment_id : null;
    const providerPaymentId = typeof data.pf_payment_id === "string" && data.pf_payment_id ? data.pf_payment_id : null;
    return linkId ? { linkId, providerPaymentId } : null;
  }

  /** PayFast's own addresses, resolved from its hostnames (cached ten minutes). */
  private async validAddresses(now: number): Promise<Set<string>> {
    if (this.addresses && now - this.addresses.at < 600_000) return this.addresses.set;
    const resolve = this.config.resolveAddresses ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
    const set = new Set<string>();
    for (const host of PAYFAST_HOSTS) {
      try {
        for (const address of await resolve(host)) set.add(address);
      } catch {
        // one hostname failing to resolve leaves the others
      }
    }
    this.addresses = { at: now, set };
    return set;
  }

  async verify(input: WebhookInput, link: LinkForVerify, remoteIp: string | null): Promise<ProviderEvent[]> {
    const entries = parseForm(input.rawBody);
    if (entries.length === 0) throw new WebhookRejected("The notification has no body: the host did not pass the form fields on", "invalid");
    const data = Object.fromEntries(entries);
    // 1. signature
    const given = String(data.signature ?? "").toLowerCase();
    if (!given || !safeEqual(given, itnSignature(entries, this.config.passphrase))) throw new WebhookRejected("The PayFast signature does not match", "bad_signature");
    // 2. source
    const addresses = await this.validAddresses(input.now.getTime());
    if (!remoteIp || !addresses.has(remoteIp)) throw new WebhookRejected("The notification did not come from a PayFast address", "bad_source");
    // 3. data: ours, and (by the caller) the amount
    if (String(data.merchant_id ?? "") !== this.config.merchantId) throw new WebhookRejected("The notification is for another merchant", "invalid");
    if (String(data.m_payment_id ?? "") !== link.id) throw new WebhookRejected("The notification names another payment", "invalid");
    // 4. PayFast confirms it sent exactly this
    const response = await this.doFetch(`${this.base()}/eng/query/validate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: itnParamString(entries) });
    const answer = (await response.text().catch(() => "")).trim();
    if (!response.ok || answer !== "VALID") throw new WebhookRejected(`PayFast did not confirm the notification (${answer.slice(0, 40) || `HTTP ${response.status}`})`, "not_confirmed");

    const status = String(data.payment_status ?? "").toUpperCase();
    const pfId = String(data.pf_payment_id ?? "");
    const gross = minorFromDecimal(data.amount_gross) ?? 0;
    const fee = minorFromDecimal(String(data.amount_fee ?? "").replace(/^-/, ""));
    const base = { eventId: `${pfId}:${status}`, linkId: link.id, providerPaymentId: pfId || null, amountMinor: gross, currency: "ZAR", feeMinor: fee, paidAt: input.now.toISOString(), reference: pfId || null, status };
    if (status === "COMPLETE") return [{ kind: "payment_confirmed", ...base }];
    if (status === "FAILED" || status === "CANCELLED") return [{ kind: "payment_failed", ...base }];
    return [];
  }
}
