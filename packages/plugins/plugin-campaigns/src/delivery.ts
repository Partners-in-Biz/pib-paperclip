/**
 * What the email provider says happened to a campaign email (0.7.0): `mail.delivery`, announced by the Mailbox, kit type `MailDelivery`.
 *
 * The Mailbox's `mail.send.result` is the one answer a send settles on (Campaigns records `sent` from it). A delivery report comes
 * later and says what became of the message: delivered, bounced, marked as spam, opened, clicked. It is announced only for mail the
 * email provider took (a Gmail send has no such report), so with the provider off this module never runs and Campaigns works as before.
 *
 * What each type does here (a step event per send and kind, once; a repeat changes nothing):
 *
 * | type | step event | more |
 * |---|---|---|
 * | delivered | `delivered` | |
 * | opened, clicked | `open`, `click` | the first per send (a mail client may preload a pixel, a person may click twice); they exist only when tracking is switched on for the domain at the provider |
 * | bounced (hard) | `bounce` (kind `hard`) | the address goes on the do-not-email list for EVERY sender (a hard bounce is about the address), reason `bounce`, and its running campaigns stop |
 * | suppressed | `bounce` (kind `suppressed`) | the provider refused an address on its own list: the same as a hard bounce |
 * | complained | `complaint` | the address goes on THIS client's marketing list (the sender's), reason `complaint`, and that sender's campaigns stop for it |
 * | soft_bounced | `soft_bounce` | nothing is suppressed: the address may work next time (the Mailbox backs it off itself) |
 * | failed | `failed` | the provider could not send it |
 * | delayed | none | a delay is not an outcome |
 *
 * Idempotency, the same discipline as `mail.send.result` and `mail.received`: the event is handled once per its `key` (kit `receiveOnce`, which
 * keeps the answer in the `inbox` table), a step event is written once per `source_key` (`delivery:<kind>:<send key>`, so the same fact under
 * another delivery id changes nothing), and the do-not-email row is written once per address and sender (`addSuppression`, `ON CONFLICT DO
 * NOTHING`), so a redelivered event, or the Mailbox's own `contact.suppressed` for the same bounce arriving first, adds nothing twice.
 * Only a campaign's own sends are read: the event's context must be `campaign_step` of this plugin and its key `campaigns:step:<enrollment>:<n>`.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { getCrmContact, MAIL_DELIVERY_TYPES, MAIL_EVENTS, PIB_PLUGINS, receiveOnce, suppressionEmail, type MailDelivery, type MailDeliveryType } from "@partnersinbiz/pib-plugin-kit";
import { enrollmentById, getCampaign, insertStepEventOnce, sentEventByKey, type StepEventType } from "./db.js";
import { campaignAddress, campaignSenderKey } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { suppressAddress } from "./suppress.js";

/** The step event a delivery type becomes; `null` is a type that is not an outcome. */
const EVENT_OF: Record<MailDeliveryType, StepEventType | null> = {
  delivered: "delivered",
  delayed: null,
  bounced: "bounce",
  soft_bounced: "soft_bounce",
  complained: "complaint",
  failed: "failed",
  suppressed: "bounce",
  opened: "open",
  clicked: "click",
};

const SEND_KEY = /^campaigns:step:(.+):(\d+)$/;
const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A `mail.delivery` payload of one of this plugin's campaign sends, or null for anything else (another plugin's mail, a malformed event). */
export function asCampaignDelivery(payload: unknown): MailDelivery | null {
  const body = record(payload);
  const context = record(body.context);
  if (typeof body.key !== "string" || !body.key || body.key.length > 400) return null;
  if (!(MAIL_DELIVERY_TYPES as readonly string[]).includes(String(body.type))) return null;
  if (typeof body.sendKey !== "string" || !SEND_KEY.test(body.sendKey)) return null;
  if (context.plugin !== PLUGIN_ID || context.kind !== "campaign_step") return null;
  const recipient = typeof body.recipient === "string" ? suppressionEmail(body.recipient) : "";
  const bounce = record(body.bounce);
  return {
    key: body.key,
    type: body.type as MailDeliveryType,
    provider: typeof body.provider === "string" ? body.provider : "",
    sendKey: body.sendKey,
    ...(EMAIL.test(recipient) ? { recipient } : {}),
    at: typeof body.at === "string" && Number.isFinite(Date.parse(body.at)) ? body.at : new Date().toISOString(),
    context: { plugin: PLUGIN_ID, kind: "campaign_step", id: typeof context.id === "string" ? context.id : "", clientKind: context.clientKind === "contact" ? "contact" : context.clientKind === "company" ? "company" : null, clientRef: typeof context.clientRef === "string" ? context.clientRef : null },
    ...(bounce.kind === "hard" || bounce.kind === "soft" ? { bounce: { kind: bounce.kind, subType: typeof bounce.subType === "string" ? bounce.subType : null } } : {}),
  };
}

export interface DeliveryOutcome extends Record<string, unknown> {
  matched: boolean;
  campaignId?: string;
  enrollmentId?: string;
  /** The step event kind this delivery is, or null for a type that is not an outcome. */
  event?: StepEventType | null;
  /** True when this delivery added the step event (false: it was already there). */
  recorded?: boolean;
  /** True when this delivery added the address to the do-not-email list (false: it was already on it, or nothing is suppressed). */
  suppressed?: boolean;
}

/** `mail.delivery` event handler: handled once per delivery key, and never throws (a failure is logged; the Mailbox's own suppression event still reaches us). */
export async function onMailDelivery(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const delivery = asCampaignDelivery(event.payload);
  if (!delivery || !event.companyId) return;
  const companyId = event.companyId;
  try {
    await receiveOnce(ctx, companyId, MAIL_EVENTS.delivery, delivery.key, () => handleDelivery(ctx, companyId, delivery));
  } catch (error) {
    ctx.logger.error("Campaign delivery report failed", { key: delivery.key, error: message(error) });
  }
}

export async function handleDelivery(ctx: PluginContext, companyId: string, delivery: MailDelivery): Promise<DeliveryOutcome> {
  const match = SEND_KEY.exec(delivery.sendKey ?? "");
  const kind = EVENT_OF[delivery.type];
  if (!match || !delivery.sendKey) return { matched: false };
  const enrollmentId = match[1]!;
  const stepPosition = Number(match[2]);
  // The event's own context must agree with the key it carries.
  if (delivery.context?.id && delivery.context.id !== enrollmentId) return { matched: false };
  const enrollment = await enrollmentById(ctx, enrollmentId);
  if (!enrollment || enrollment.companyId !== companyId) return { matched: false };
  const campaign = await getCampaign(ctx, enrollment.campaignId);
  if (!campaign || campaign.companyId !== companyId) return { matched: false };
  const out: DeliveryOutcome = { matched: true, campaignId: campaign.id, enrollmentId: enrollment.id, event: kind, recorded: false, suppressed: false };
  if (!kind) return out;

  // The step event, once per send and kind. A bounce keeps whether it was hard (or the provider's own refusal) in its meta.
  out.recorded = await insertStepEventOnce(ctx, {
    companyId,
    campaignId: campaign.id,
    enrollmentId: enrollment.id,
    stepPosition,
    eventType: kind,
    variant: enrollment.variant,
    sourceKey: `delivery:${kind}:${delivery.sendKey}`,
    meta: { sendKey: delivery.sendKey, deliveryKey: delivery.key, type: delivery.type, provider: delivery.provider || null, at: delivery.at, ...(delivery.recipient ? { to: delivery.recipient } : {}), ...(delivery.bounce ? { bounceKind: delivery.bounce.kind, bounceSubType: delivery.bounce.subType } : {}) },
  });

  // A hard bounce or a complaint stops the address, once. The address is the send's own (the single recipient the event names, else what the
  // send went to); an event whose recipient is not who we emailed changes the report and nothing else.
  const suppressing = delivery.type === "bounced" || delivery.type === "suppressed" || delivery.type === "complained";
  if (!suppressing) return out;
  if (delivery.type === "bounced" && delivery.bounce?.kind === "soft") return out;
  const sent = await sentEventByKey(ctx, companyId, delivery.sendKey);
  const sentTo = typeof sent?.meta.to === "string" && sent.meta.to ? suppressionEmail(sent.meta.to) : null;
  const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId).catch(() => null);
  const expected = sentTo ?? (campaignAddress(contact?.emails) ? suppressionEmail(campaignAddress(contact?.emails)!) : null);
  const address = delivery.recipient ?? expected;
  if (!address) return out;
  if (expected && address !== expected) {
    ctx.logger.info("A delivery report names an address the campaign did not email; the address is not suppressed", { key: delivery.key });
    return out;
  }
  const complaint = delivery.type === "complained";
  const result = await suppressAddress(ctx, {
    companyId,
    email: address,
    reason: complaint ? "complaint" : "bounce",
    // A complaint is this client's: their marketing list only. A hard bounce is about the address: every sender's.
    scope: complaint ? "marketing" : "all",
    senderKey: complaint ? campaignSenderKey(campaign) : "",
    source: PIB_PLUGINS.mailbox,
    contactId: enrollment.contactId,
    campaignId: campaign.id,
  });
  out.suppressed = result.created;
  return out;
}
