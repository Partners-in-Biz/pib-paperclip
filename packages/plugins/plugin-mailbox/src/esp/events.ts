/**
 * What a provider webhook event changes, once it has been verified (`webhook.ts`).
 *
 * | Event | What the Mailbox does |
 * |---|---|
 * | delivered | counts it, forgets earlier soft bounces of the address, marks the send delivered |
 * | delivery_delayed | marks the send delayed (a delay is not a bounce: nothing is suppressed) |
 * | bounced, Permanent (a hard bounce) | the address goes on the do-not-email list for ALL mail (`bounced`, per address, every sender), announced as `contact.suppressed`; counted toward the domain's bounce rate |
 * | bounced, Transient or Undetermined (a soft bounce) | marketing to the address waits 6, then 24, then 72 hours; the third in 14 days puts it on the marketing list too |
 * | complained | the address goes on the do-not-email list for marketing, on THE SENDER'S list (the client's, or the company's own), announced as `contact.suppressed` and as a withdrawn consent; counted toward the complaint rate |
 * | suppressed | the provider refused to send to an address on its own list: treated as a hard bounce |
 * | failed | marks the send failed (the reason is kept; a quota reason is put on the provider's state) |
 * | opened, clicked | counted and noted on the send (opens are unreliable: mail clients preload them) |
 * | domain.* | the provider's status of the domain is read again |
 *
 * Rules that hold for every event:
 * - It is applied once: the delivery id (`svix-id`) and the message, kind and recipient are both recorded, so a replay and a
 *   second copy under another delivery id change nothing.
 * - It is about a domain the company registered AND about a message this Mailbox sent. An event about any other domain (the
 *   same provider account may serve other apps) is acknowledged and ignored. So is an event about a message the Mailbox did not
 *   send: a webhook is team-wide, so when the PiB web app or another app shares the provider team and the same domain, its bounces
 *   and complaints arrive here too, and counting them would inflate the domain's rates (and could hold the client's marketing)
 *   and fill the do-not-email list with addresses that are none of this company's. "A message the Mailbox sent" is a send
 *   it recorded (found by the provider's message id) or, for an event that beats the database write by a few milliseconds, the
 *   `pib_company` tag the Mailbox puts on every message it hands over. Nothing else is applied, and nothing is recorded.
 * - A message with several recipients does not say which of them an event is about, so it suppresses nobody (it is still
 *   counted). Marketing is one recipient per message.
 * - The day counters move last, after everything that can fail, so an event that fails halfway and is delivered again does not count twice
 *   (the suppression and the notes on the send are the same when repeated; a counter is not).
 * - A bounce or complaint re-judges the domain's last 7 days at once (`applyReputation`): the domain that has just crossed
 *   2% hard bounces or 0.1% complaints is held back for marketing now, not at tomorrow's check.
 * - The result is announced as `mail.delivery` (kit `MAIL_EVENTS.delivery`, `plugin.partnersinbiz.mailbox.mail.delivery`, kit type
 *   `MailDelivery`) for any plugin that wants to record it: `{ key, type, provider, sendKey, recipient?, at, context, clientKind,
 *   clientRef, bounce? }`. The client is the send's own scope, else the sending domain's client. An open or a click is announced too (0.6.1;
 *   they exist only when somebody switched tracking on for the domain, and each may repeat: a consumer counts the first per send). The
 *   result of the SEND stays the single `mail.send.result` the sender settles on; a later bounce is never sent as a second result
 *   for the same key, because the senders settle on the first one.
 */
import { MAIL_EVENTS, senderKeyOf, suppressionScope, type MailDelivery, type MailDeliveryType, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import type { LoadedConfig } from "../config.js";
import { sendingDomain } from "../dns.js";
import { applyReputation, defaultResolver, type DomainRunEnv } from "../domain-health.js";
import { announceOptOut } from "../erasure.js";
import { errorMessage, type Env } from "../gmail/env.js";
import { isValidEmail } from "../gmail/headers.js";
import { PLUGIN_ID } from "../namespace.js";
import { accountSenderKey } from "../sender.js";
import { announce, suppressionPayload } from "../suppression.js";
import { refreshSendingDomain } from "./domains.js";
import { addressOf, tagValue, type ResendEvent } from "./resend.js";
import { noteEspState } from "./runtime.js";
import type { EspDayField, EspDomainRow } from "./types.js";
import { SOFT_BOUNCE_LIMIT, SOFT_BOUNCE_WINDOW_DAYS, softBounceBackoffUntil, utcDay } from "./warmup.js";

export const ESP_DELIVERY_EVENT = MAIL_EVENTS.delivery;

export type EspEventOutcome = "applied" | "duplicate" | "ignored";

/** The strongest thing that happened to a message wins: a bounce is never overwritten by a late "delivered". */
const RANK: Record<string, number> = { sent: 1, delayed: 2, delivered: 3, soft_bounced: 4, suppressed: 5, failed: 6, bounced: 7, complained: 8 };

export function mergedDeliveryStatus(current: string | null | undefined, incoming: string): string {
  return (RANK[incoming] ?? 0) >= (RANK[current ?? ""] ?? 0) ? incoming : (current as string);
}

const TYPE_OF: Record<string, MailDeliveryType | "sent"> = {
  delivered: "delivered",
  delayed: "delayed",
  bounced_hard: "bounced",
  bounced_soft: "soft_bounced",
  complained: "complained",
  failed: "failed",
  suppressed: "suppressed",
  opened: "opened",
  clicked: "clicked",
  sent: "sent",
};

function domainEnv(env: Env): DomainRunEnv {
  return { ctx: env.ctx, store: env.store, dns: env.dns ?? defaultResolver(env.ctx), now: env.now };
}

/** Whose do-not-email list the event is about: the account that sent the message, else the client the domain belongs to, else the company's own. */
async function senderKeyFor(env: Env, companyId: string, accountId: string | null, domain: EspDomainRow): Promise<string> {
  if (accountId) {
    const account = await env.store.getAccount(companyId, accountId);
    if (account) return accountSenderKey(account);
  }
  return senderKeyOf({ clientKind: domain.client_kind, clientRef: domain.client_ref });
}

export async function applyEspEvent(env: Env, loaded: LoadedConfig, event: ResendEvent, delivery: { id: string }): Promise<EspEventOutcome> {
  const companyId = loaded.companyId;
  const s = env.store;
  const now = env.now();

  if (event.kind === "domain") {
    const rows = await s.listEspDomains(companyId);
    const row = rows.find((entry) => entry.provider_domain_id === event.domainId);
    if (!row) return "ignored";
    if (!(await s.recordEspEvent({ companyId, eventId: delivery.id, dedupeKey: `${delivery.id}`, provider: "resend", type: event.type, emailId: null, recipient: "", domain: row.domain, sendKey: null, detail: {} }))) return "duplicate";
    try {
      await refreshSendingDomain(env, loaded, companyId, row.domain, { verify: false });
    } catch (error) {
      await s.forgetEspEvent(companyId, delivery.id);
      throw error;
    }
    return "applied";
  }
  if (event.kind === "other" || !event.emailId) return "ignored";

  // Only about a domain the company registered: another app's mail through the same provider account is none of the Mailbox's business.
  const domainName = sendingDomain(addressOf(event.from));
  const domain = domainName ? await s.getEspDomain(companyId, domainName) : null;
  if (!domain) return "ignored";

  const send = await s.sendByProviderMessage(companyId, "resend", event.emailId);
  // Only about a message this Mailbox sent: one it recorded, or one that carries the tag it puts on everything it sends. The webhook is
  // team-wide, so another app's mail through the same provider team and domain must not count here.
  if (!send && event.tags.pib_company !== tagValue(companyId)) return "ignored";

  const recipient = event.to.length === 1 && isValidEmail(event.to[0]) ? event.to[0]!.toLowerCase() : "";
  const type = TYPE_OF[event.kind] ?? event.type;
  const once = !(event.kind === "opened" || event.kind === "clicked");
  const detail: Record<string, unknown> = {};
  if (event.bounce) Object.assign(detail, { bounceType: event.bounce.type, bounceSubType: event.bounce.subType });
  if (event.failedReason) detail.reason = event.failedReason.slice(0, 120);
  if (event.to.length > 1) detail.recipients = event.to.length;
  const created = await s.recordEspEvent({
    companyId,
    eventId: delivery.id,
    dedupeKey: once ? `${event.emailId}:${event.type}:${recipient || "many"}` : delivery.id,
    provider: "resend",
    type: event.type,
    emailId: event.emailId,
    recipient,
    domain: domain.domain,
    sendKey: send?.key ?? null,
    detail,
  });
  if (!created) return "duplicate";

  try {
    const at = Date.parse(event.createdAt ?? "");
    const eventTime = Number.isFinite(at) ? at : now;
    const day = utcDay(eventTime);
    const atIso = new Date(eventTime).toISOString();
    const senderKey = await senderKeyFor(env, companyId, send?.account_id ?? null, domain);
    let reputationChanged = false;
    // The counter this event moves, applied after everything else (see the header).
    let counter: EspDayField | null = null;

    switch (event.kind) {
      case "delivered": {
        if (recipient) await s.clearRecipientHealth(companyId, recipient);
        counter = "delivered";
        break;
      }
      case "bounced_hard":
      case "suppressed": {
        if (recipient) {
          // A hard bounce is per address: it stops every send from every sender.
          const stored = await s.upsertSuppression({ companyId, email: recipient, scope: "all", reason: "bounced", source: PLUGIN_ID, detail: `Hard bounce (${event.kind === "suppressed" ? "on the provider's own list" : event.bounce?.subType ?? "Permanent"})`, senderKey: "" });
          await s.clearRecipientHealth(companyId, recipient);
          if (stored.created || stored.widened) await announce(env, companyId, suppressionPayload({ email: recipient, reason: "bounced", scope: suppressionScope("bounced"), at: atIso }));
        }
        // The provider's own refusal is not the domain's bounce: only a real hard bounce counts toward its rate.
        if (event.kind === "bounced_hard") {
          counter = "hard_bounces";
          reputationChanged = true;
        } else {
          counter = "failed";
        }
        break;
      }
      case "bounced_soft": {
        if (recipient) {
          const row = await s.recordSoftBounce(companyId, recipient, atIso, SOFT_BOUNCE_WINDOW_DAYS);
          await s.setBackoff(companyId, recipient, softBounceBackoffUntil(row.soft_bounces, eventTime));
          if (row.soft_bounces >= SOFT_BOUNCE_LIMIT) {
            // It keeps not arriving: stop the marketing, keep the invoices.
            const stored = await s.upsertSuppression({ companyId, email: recipient, scope: "marketing", reason: "bounced", source: PLUGIN_ID, detail: `${row.soft_bounces} soft bounces in ${SOFT_BOUNCE_WINDOW_DAYS} days`, senderKey });
            if (stored.created) await announce(env, companyId, suppressionPayload({ email: recipient, reason: "bounced", scope: "marketing", senderKey, at: atIso }));
          }
        }
        counter = "soft_bounces";
        break;
      }
      case "complained": {
        if (recipient) {
          // An unsubscribe and a complaint are per sender: a client's recipient complaining does not silence the company's own marketing.
          const stored = await s.upsertSuppression({ companyId, email: recipient, scope: "marketing", reason: "complained", source: PLUGIN_ID, detail: "Marked the mail as spam (provider feedback loop)", senderKey });
          if (stored.created) {
            await announce(env, companyId, suppressionPayload({ email: recipient, reason: "complained", scope: "marketing", senderKey, at: atIso }));
            await announceOptOut(env, companyId, { email: recipient, senderKey, source: "api", wording: "marked the mail as spam", at: atIso });
          }
        }
        counter = "complaints";
        reputationChanged = true;
        break;
      }
      case "failed": {
        counter = "failed";
        if (/quota/i.test(event.failedReason ?? "")) await noteEspState(env.ctx, companyId, { code: "quota", detail: event.failedReason }, now);
        break;
      }
      case "opened":
        counter = "opened";
        break;
      case "clicked":
        counter = "clicked";
        break;
      default:
        break;
    }

    // What happened to the message, kept on its send so mail-status shows it.
    if (send) {
      const status = mergedDeliveryStatus(send.delivery_status, type);
      const note: Record<string, unknown> = { [`${type}_at`]: atIso, ...detail };
      await s.setSendDelivery(companyId, send.key, event.kind === "opened" || event.kind === "clicked" ? send.delivery_status ?? "sent" : status, note);
    }

    // Nothing below can throw (the re-judging and the announcement catch their own errors), so the event is either not counted and taken back
    // out for the provider's retry, or counted and complete.
    if (counter) await s.bumpEspDay(companyId, domain.domain, day, counter, 1);

    if (reputationChanged) {
      try {
        await applyReputation(domainEnv(env), companyId, domain.domain);
      } catch (error) {
        env.ctx.logger.info("Domain reputation not re-judged", { domain: domain.domain, error: errorMessage(error) });
      }
    }

    // Everything the consumers can use is announced; the provider's own "sent" only says it took the message, which `mail.send.result` already did.
    if (type !== "sent") {
      await announceDelivery(env, companyId, { id: delivery.id, type: type as MailDeliveryType, sendKey: send?.key ?? null, recipient, at: atIso, context: send?.context ?? null, client: deliveryClient(send?.context ?? null, domain), bounce: event.bounce });
    }
    return "applied";
  } catch (error) {
    // Not applied: the provider's retry must be able to apply it.
    await s.forgetEspEvent(companyId, delivery.id).catch(() => undefined);
    throw error;
  }
}

const clientKindOf = (value: unknown): "company" | "contact" => (value === "contact" ? "contact" : "company");

/** The client a delivery is for: the send's own scope, else the client the sending domain belongs to, else nobody (the company's own mail). */
function deliveryClient(context: MailSendRequested["context"] | null, domain: Pick<EspDomainRow, "client_kind" | "client_ref">): { kind: "company" | "contact" | null; ref: string | null } {
  if (context?.clientRef) return { kind: clientKindOf(context.clientKind), ref: context.clientRef };
  if (domain.client_ref) return { kind: clientKindOf(domain.client_kind), ref: domain.client_ref };
  return { kind: null, ref: null };
}

/** `mail.delivery`: what happened to a message after the provider took it. No message content, no link, no address unless it is the single recipient. Never throws. */
async function announceDelivery(env: Pick<Env, "ctx">, companyId: string, input: { id: string; type: MailDeliveryType; sendKey: string | null; recipient: string; at: string; context: MailSendRequested["context"] | null; client: { kind: "company" | "contact" | null; ref: string | null }; bounce: ResendEvent["bounce"] }): Promise<void> {
  const payload: MailDelivery = {
    key: `esp:${input.id}`,
    type: input.type,
    provider: "resend",
    sendKey: input.sendKey,
    ...(input.recipient ? { recipient: input.recipient } : {}),
    at: input.at,
    context: input.context,
    clientKind: input.client.ref ? input.client.kind : null,
    clientRef: input.client.ref,
    ...(input.bounce ? { bounce: { kind: (input.bounce.type ?? "").toLowerCase() === "permanent" ? ("hard" as const) : ("soft" as const), subType: input.bounce.subType } } : {}),
  };
  try {
    await env.ctx.events.emit(ESP_DELIVERY_EVENT, companyId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    env.ctx.logger.info("mail.delivery emit failed", { type: input.type, error: errorMessage(error) });
  }
}

