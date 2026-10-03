/**
 * A messaging provider for tests: nothing leaves the process. It records what
 * would have been sent, answers from a script (so a test can make the provider
 * refuse, time out or block a number) and serves replies and delivery statuses a
 * test puts in.
 */
import type { InboundMessage, MessageStatus, MessagingProvider, OutboundMessage, SendOutcome } from "../../src/messaging.js";

export class MockProvider implements MessagingProvider {
  readonly id = "mock";
  sent: OutboundMessage[] = [];
  /** Outcomes used one per send, in order; after they run out every send succeeds. */
  script: SendOutcome[] = [];
  inboundQueue: InboundMessage[] = [];
  statusMap = new Map<string, MessageStatus>();
  inboundCalls: Array<{ since: Date; numbers: Array<{ channel: string; address: string }> }> = [];
  private counter = 0;

  async send(message: OutboundMessage): Promise<SendOutcome> {
    this.sent.push(message);
    const next = this.script.shift();
    if (next) return next;
    this.counter += 1;
    return { ok: true, providerId: `SM${String(this.counter).padStart(32, "0")}`, status: "queued", segments: 1 };
  }

  async inbound(input: { since: Date; numbers: Array<{ channel: "sms" | "whatsapp"; address: string }> }): Promise<InboundMessage[]> {
    this.inboundCalls.push(input);
    return this.inboundQueue.filter((m) => Date.parse(m.receivedAt) >= input.since.getTime() && input.numbers.some((n) => n.address === m.to && n.channel === m.channel));
  }

  async statuses(providerIds: string[]): Promise<MessageStatus[]> {
    return providerIds.map((id) => this.statusMap.get(id)).filter((s): s is MessageStatus => Boolean(s));
  }
}

export function reply(from: string, to: string, body: string, id: string, receivedAt = new Date().toISOString(), channel: "sms" | "whatsapp" = "sms"): InboundMessage {
  return { providerId: id, channel, from, to, body, receivedAt };
}
