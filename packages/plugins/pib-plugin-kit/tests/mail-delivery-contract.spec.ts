import { describe, expect, it } from "vitest";
import { DEAL_ACCEPTED_FIELDS, HANDOFF_EVENTS, MAIL_DELIVERY_TYPES, MAIL_EVENTS, PIB_PLUGINS, pluginEvent, type DealAccepted, type MailDelivery, type MailSendResult } from "../src/index.js";

describe("mail.delivery (Mailbox -> everyone)", () => {
  it("is announced under the name the Mailbox emits and the plugins listen to", () => {
    expect(MAIL_EVENTS.delivery).toBe("mail.delivery");
    expect(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.delivery)).toBe("plugin.partnersinbiz.mailbox.mail.delivery");
    // The three mail events stay distinct: a send's answer is not a delivery report.
    expect(new Set(Object.values(MAIL_EVENTS)).size).toBe(Object.keys(MAIL_EVENTS).length);
  });

  it("names every type the Mailbox can announce, including opened and clicked", () => {
    expect([...MAIL_DELIVERY_TYPES].sort()).toEqual(["bounced", "clicked", "complained", "delayed", "delivered", "failed", "opened", "soft_bounced", "suppressed"].sort());
  });

  it("carries the send's key, the client scope, the provider and the time", () => {
    const delivery: MailDelivery = {
      key: "esp:msg_1",
      type: "bounced",
      provider: "resend",
      sendKey: "campaigns:step:e1:1",
      recipient: "ada@acme.test",
      at: "2026-10-04T08:00:00.000Z",
      context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "e1", clientKind: "company", clientRef: "acme" },
      clientKind: "company",
      clientRef: "acme",
      bounce: { kind: "hard", subType: "General" },
    };
    expect(delivery.type).toBe("bounced");
    expect(delivery.context?.clientRef).toBe(delivery.clientRef);
    // A send the Mailbox cannot find: no key, no context, still a valid report.
    const unknown: MailDelivery = { key: "esp:msg_2", type: "delivered", provider: "resend", sendKey: null, at: "2026-10-04T08:00:00.000Z", context: null };
    expect(unknown.sendKey).toBeNull();
  });

  it("lets a send result say which provider took it, and leaves it off for Gmail", () => {
    const viaProvider: MailSendResult = { key: "k", status: "sent", messageId: "resend:abc", provider: "resend", context: { plugin: "p", kind: "k", id: "1" } };
    const viaGmail: MailSendResult = { key: "k2", status: "sent", messageId: "gmail-1", context: { plugin: "p", kind: "k", id: "1" } };
    expect(viaProvider.provider).toBe("resend");
    expect(viaGmail.provider).toBeUndefined();
  });
});

describe("deal.accepted (CRM -> Billing)", () => {
  it("is a hand-off event under the CRM's name", () => {
    expect(HANDOFF_EVENTS.dealAccepted).toBe("deal.accepted");
    expect(pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.dealAccepted)).toBe("plugin.partnersinbiz.crm.deal.accepted");
    // It is not the deal-won event and not the quote one.
    expect(HANDOFF_EVENTS.dealAccepted).not.toBe(HANDOFF_EVENTS.dealWon);
    expect(HANDOFF_EVENTS.dealAccepted).not.toBe(HANDOFF_EVENTS.quoteAccepted);
  });

  it("has the fields the CRM documents, in its order", () => {
    expect(DEAL_ACCEPTED_FIELDS).toEqual(["key", "documentId", "kind", "title", "dealId", "quoteId", "quoteNumber", "clientKind", "clientRef", "clientName", "valueMinor", "currency", "signerName", "signedAt", "contentSha256", "auditHead"]);
    const sample: DealAccepted = {
      key: "crm:esign:doc1:accepted",
      documentId: "doc1",
      kind: "quote",
      title: "Quote Q-0001",
      dealId: "deal1",
      quoteId: "q1",
      quoteNumber: "Q-0001",
      clientKind: "company",
      clientRef: "acme",
      clientName: "Acme Plumbing",
      valueMinor: 150_000,
      currency: "ZAR",
      signerName: "Ada Lovelace",
      signedAt: "2026-10-04T08:00:00.000Z",
      contentSha256: "a".repeat(64),
      auditHead: "b".repeat(64),
    };
    expect(Object.keys(sample).sort()).toEqual([...DEAL_ACCEPTED_FIELDS].sort());
  });
});
