/**
 * PayPal Orders v2 + webhook verify. Off until the owner adds app credentials.
 * CAPTURE orders use `custom_id` = our link id; after CHECKOUT.ORDER.APPROVED we
 * POST `/capture` so settlement does not wait on a second webhook. Webhooks need
 * `verification_status === "SUCCESS"` or we throw so PayPal retries.
 */
import { PaymentProviderError } from "./stripe.js";
import {
  decimalFromMinor,
  minorFromDecimal,
  WebhookRejected,
  type CreatedLink,
  type LinkForVerify,
  type LinkRequest,
  type LocatedLink,
  type PaymentProvider,
  type ProviderEvent,
  type WebhookInput,
} from "./types.js";

export const PAYPAL_LIVE = "https://api-m.paypal.com";
export const PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com";

const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP"]);
const INVOICE_ID_MAX = 127;
const HANDLED = new Set([
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
]);

/** Whether Billing can create a PayPal checkout link in this currency. */
export function paypalSupportsCurrency(currency: string): boolean {
  return SUPPORTED_CURRENCIES.has(currency.toUpperCase());
}

export interface PaypalConfig {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  sandbox?: boolean;
  returnUrl?: string | null;
  cancelUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export interface Readiness {
  ready: boolean;
  blocker: string | null;
  code: "ok" | "off" | "missing" | "host_limit";
}

export function paypalReadiness(
  enabled: boolean | undefined,
  hasClientId: unknown,
  hasClientSecret: unknown,
  hasWebhookId: unknown,
  publicBaseUrl?: string | null,
): Readiness {
  if (enabled !== true) return { ready: false, blocker: "PayPal is switched off in Billing settings.", code: "off" };
  const missing = [
    !hasClientId && "client id",
    !hasClientSecret && "client secret",
    !hasWebhookId && "webhook id",
    !publicBaseUrl && "public address of Paperclip",
  ].filter(Boolean);
  if (missing.length) return { ready: false, blocker: `Missing: ${missing.join(", ")}.`, code: "missing" };
  return { ready: true, blocker: null, code: "ok" };
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function parseEvent(rawBody: string): Obj | null {
  try {
    return obj(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

function customIdFromResource(resource: Obj): string | null {
  const direct = text(resource.custom_id);
  if (direct) return direct;
  for (const unit of Array.isArray(resource.purchase_units) ? resource.purchase_units : []) {
    const id = text(obj(unit).custom_id);
    if (id) return id;
  }
  return null;
}

/** Capture id for a PAYMENT.CAPTURE.REFUNDED resource (resource.id is the refund id only). */
function captureIdFromRefundResource(resource: Obj): string | null {
  const fromRelated = text(obj(obj(resource.supplementary_data).related_ids).capture_id);
  if (fromRelated) return fromRelated;
  for (const entry of Array.isArray(resource.links) ? resource.links : []) {
    const link = obj(entry);
    if (text(link.rel) !== "up") continue;
    const href = text(link.href);
    if (!href) continue;
    const segment = href.replace(/\/+$/, "").split("/").pop();
    if (segment) return segment;
  }
  return null;
}

function providerPaymentIdFromResource(resource: Obj, eventType?: string): string | null {
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") return captureIdFromRefundResource(resource);
  const captureId = text(resource.id);
  if (captureId) return captureId;
  return text(obj(obj(resource.supplementary_data).related_ids).order_id);
}

function amountFromResource(resource: Obj): { amountMinor: number; currency: string | null } {
  const amount = obj(resource.amount);
  return {
    amountMinor: minorFromDecimal(amount.value ?? resource.amount) ?? 0,
    currency: text(amount.currency_code)?.toUpperCase() ?? null,
  };
}

function firstCaptureFromOrder(order: Obj): Obj | null {
  for (const unit of Array.isArray(order.purchase_units) ? order.purchase_units : []) {
    const captures = obj(obj(unit).payments).captures;
    if (!Array.isArray(captures) || captures.length === 0) continue;
    const capture = obj(captures[0]);
    if (text(capture.id)) return capture;
  }
  return null;
}

function paypalIssueCodes(parsed: Obj): string[] {
  const details = Array.isArray(parsed.details) ? parsed.details : [];
  const codes: string[] = [];
  for (const detail of details) {
    const issue = text(obj(detail).issue);
    if (issue) codes.push(issue);
  }
  return codes;
}

function eventFrom(
  kind: ProviderEvent["kind"],
  eventId: string,
  linkId: string,
  resource: Obj,
  paidAt: string,
  fallbackStatus: string,
): ProviderEvent {
  const providerPaymentId = providerPaymentIdFromResource(resource);
  const { amountMinor, currency } = amountFromResource(resource);
  return {
    kind,
    eventId,
    linkId,
    providerPaymentId,
    amountMinor,
    currency,
    feeMinor: null,
    paidAt,
    reference: providerPaymentId,
    status: String(resource.status ?? fallbackStatus),
  };
}

export class PaypalProvider implements PaymentProvider {
  readonly key = "paypal" as const;
  readonly label = "PayPal";
  private readonly doFetch: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: PaypalConfig) {
    this.doFetch = config.fetchImpl ?? fetch;
  }

  private base(): string {
    return this.config.sandbox ? PAYPAL_SANDBOX : PAYPAL_LIVE;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.doFetch(`${this.base()}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = (await response.json().catch(() => ({}))) as Obj;
    const access = text(body.access_token);
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 0;
    if (!response.ok || !access) {
      throw new PaymentProviderError(`PayPal refused the token request: ${text(body.error_description) ?? text(body.error) ?? `HTTP ${response.status}`}`, response.status);
    }
    this.token = { value: access, expiresAt: now + Math.max(0, expiresIn) * 1000 };
    return access;
  }

  private throwPaypalRefusal(parsed: Obj, status: number): never {
    const details = Array.isArray(parsed.details) ? parsed.details : [];
    const detail = details.length ? text(obj(details[0]).description) : null;
    throw new PaymentProviderError(
      `PayPal refused the request: ${detail ?? text(parsed.message) ?? text(parsed.error_description) ?? `HTTP ${status}`}`,
      status,
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: Obj }> {
    const token = await this.accessToken();
    const response = await this.doFetch(`${this.base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await response.json().catch(() => ({}))) as Obj;
    return { ok: response.ok, status: response.status, body: parsed };
  }

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const { ok, status, body: parsed } = await this.request(method, path, body, extraHeaders);
    if (!ok) this.throwPaypalRefusal(parsed, status);
    return parsed as T;
  }

  private async captureOrder(orderId: string): Promise<Obj> {
    const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
    const { ok, status, body: parsed } = await this.request("POST", path, {}, { "PayPal-Request-Id": `capture-${orderId}` });
    if (!ok) {
      if (paypalIssueCodes(parsed).includes("ORDER_ALREADY_CAPTURED")) {
        return this.call<Obj>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      }
      this.throwPaypalRefusal(parsed, status);
    }
    return parsed;
  }

  async createLink(request: LinkRequest): Promise<CreatedLink> {
    const currency = request.currency.toUpperCase();
    if (!paypalSupportsCurrency(currency)) {
      throw new PaymentProviderError(
        currency === "ZAR"
          ? "PayPal links are not offered in ZAR. Ask for PayFast or EFT instead."
          : `PayPal links are offered in USD, EUR or GBP only, and this invoice is in ${currency}. Ask for EFT instead.`,
      );
    }
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new PaymentProviderError("A payment link needs an amount above zero");
    }

    const orderBody: Obj = {
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: request.linkId,
          invoice_id: request.invoiceNumber.slice(0, INVOICE_ID_MAX),
          amount: { currency_code: currency, value: decimalFromMinor(request.amountMinor) },
          description: `Invoice ${request.invoiceNumber}`.slice(0, 127),
        },
      ],
    };

    const returnUrl = text(this.config.returnUrl);
    const cancelUrl = text(this.config.cancelUrl);
    if (returnUrl || cancelUrl) {
      const experience: Obj = {};
      if (returnUrl) experience.return_url = returnUrl;
      if (cancelUrl) experience.cancel_url = cancelUrl;
      orderBody.application_context = experience;
    }

    const order = await this.call<{ id?: string; links?: Array<{ rel?: string; href?: string }> }>("POST", "/v2/checkout/orders", orderBody);
    if (!order.id) throw new PaymentProviderError("PayPal did not return an order id");
    const approve = (order.links ?? []).find((link) => link.rel === "approve" && text(link.href));
    if (!approve?.href) throw new PaymentProviderError("PayPal did not return an approve link");
    return { url: approve.href, providerRef: order.id };
  }

  async deactivateLink(_link: { providerRef: string | null }): Promise<void> {
    // Orders VOID only while CREATED/APPROVED; paid/cancelled invoices refuse the payment anyway.
  }

  locate(input: WebhookInput): LocatedLink | null {
    const event = parseEvent(input.rawBody);
    if (!event) return null;
    const eventType = String(event.event_type ?? "");
    if (eventType && !HANDLED.has(eventType)) return null;
    const resource = obj(event.resource);
    const linkId = customIdFromResource(resource);
    const providerPaymentId = providerPaymentIdFromResource(resource, eventType || undefined);
    return linkId || providerPaymentId ? { linkId, providerPaymentId } : null;
  }

  async verify(input: WebhookInput, link: LinkForVerify, _remoteIp: string | null): Promise<ProviderEvent[]> {
    const event = parseEvent(input.rawBody);
    if (!event || typeof event.id !== "string" || typeof event.event_type !== "string") {
      throw new WebhookRejected("The PayPal event is not readable", "invalid");
    }

    const transmissionId = text(input.headers["paypal-transmission-id"]);
    const transmissionTime = text(input.headers["paypal-transmission-time"]);
    const transmissionSig = text(input.headers["paypal-transmission-sig"]);
    const certUrl = text(input.headers["paypal-cert-url"]);
    const authAlgo = text(input.headers["paypal-auth-algo"]);
    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      throw new WebhookRejected("missing PayPal transmission signature headers", "bad_signature");
    }
    if (!this.config.webhookId) throw new WebhookRejected("The PayPal webhook id is not set", "not_configured");

    let verificationStatus: string | null = null;
    try {
      const verified = await this.call<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: this.config.webhookId,
        webhook_event: event,
      });
      verificationStatus = text(verified.verification_status)?.toUpperCase() ?? null;
    } catch (error) {
      if (error instanceof WebhookRejected) throw error;
      throw new WebhookRejected(
        error instanceof Error ? error.message : "PayPal refused webhook signature verification",
        "bad_signature",
      );
    }
    if (verificationStatus !== "SUCCESS") {
      throw new WebhookRejected(
        verificationStatus ? `PayPal webhook signature verification was ${verificationStatus}` : "PayPal webhook signature verification did not succeed",
        "bad_signature",
      );
    }

    const resource = obj(event.resource);
    const linkId = customIdFromResource(resource) ?? link.id;
    if (linkId !== link.id) throw new WebhookRejected("The notification names another payment", "invalid");
    const createTime = text(resource.create_time) ?? text(event.create_time) ?? input.now.toISOString();

    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        const orderId = text(resource.id);
        if (!orderId) throw new WebhookRejected("The approved order has no id", "invalid");
        const capture = firstCaptureFromOrder(await this.captureOrder(orderId));
        if (!capture) throw new PaymentProviderError("PayPal capture returned no capture id");
        return [eventFrom("payment_confirmed", event.id, linkId, capture, text(capture.create_time) ?? createTime, "COMPLETED")];
      }
      case "PAYMENT.CAPTURE.COMPLETED":
        return [eventFrom("payment_confirmed", event.id, linkId, resource, createTime, event.event_type)];
      case "PAYMENT.CAPTURE.DENIED":
        return [eventFrom("payment_failed", event.id, linkId, resource, createTime, event.event_type)];
      case "PAYMENT.CAPTURE.REFUNDED": {
        const thisRefund = amountFromResource(resource);
        const captureId = captureIdFromRefundResource(resource);
        const refundId = text(resource.id);
        if (!(thisRefund.amountMinor > 0 && captureId)) return [];
        return [
          {
            kind: "refund",
            eventId: event.id,
            linkId,
            providerPaymentId: captureId,
            // Cumulative estimate for logs; apply prefers refundIncrementMinor + a fresh row read.
            amountMinor: link.refundedMinor + thisRefund.amountMinor,
            refundIncrementMinor: thisRefund.amountMinor,
            ...(refundId ? { providerRefundId: refundId } : {}),
            currency: thisRefund.currency,
            feeMinor: null,
            paidAt: createTime,
            reference: captureId,
            status: String(resource.status ?? event.event_type),
          },
        ];
      }
      default:
        return [];
    }
  }
}
