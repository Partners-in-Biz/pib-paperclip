/**
 * The test provider. It makes links that cannot be paid for real (`pay.invalid` never resolves) and
 * produces the events a real provider would, so the whole money-in path (link, confirmed payment,
 * matching, journals, refund) is tested and rehearsed on the canary client without a charge.
 * It is switched on by `payments.mock.enabled` and has no webhook address of its own: a person
 * "pays" a mock link from the Billing page (`billing.simulate-payment`).
 */
import type { CreatedLink, LinkForVerify, LinkRequest, LocatedLink, PaymentProvider, ProviderEvent, WebhookInput } from "./types.js";
import { WebhookRejected } from "./types.js";

export class MockProvider implements PaymentProvider {
  readonly key = "mock" as const;
  readonly label = "Test provider";

  async createLink(request: LinkRequest): Promise<CreatedLink> {
    return { url: `https://pay.invalid/mock/${request.linkId}`, providerRef: `mock_${request.linkId}` };
  }

  async deactivateLink(): Promise<void> {}

  locate(): LocatedLink | null {
    return null;
  }

  async verify(_input: WebhookInput, _link: LinkForVerify): Promise<ProviderEvent[]> {
    throw new WebhookRejected("The test provider has no webhook", "invalid");
  }
}

/** The event a mock "payment" or "refund" produces. */
export function mockEvent(input: { kind: "payment_confirmed" | "refund"; linkId: string; amountMinor: number; currency: string; paymentId: string; feeMinor?: number | null; at?: Date; seq?: number }): ProviderEvent {
  return {
    kind: input.kind,
    eventId: `mock:${input.kind}:${input.linkId}:${input.seq ?? 1}`,
    linkId: input.linkId,
    providerPaymentId: input.paymentId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    feeMinor: input.feeMinor ?? null,
    paidAt: (input.at ?? new Date()).toISOString(),
    reference: input.paymentId,
    status: input.kind === "refund" ? "refunded" : "paid",
  };
}
