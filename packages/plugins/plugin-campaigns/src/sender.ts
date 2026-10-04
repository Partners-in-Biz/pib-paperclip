/**
 * Who a campaign's messages go out as (Q1a-3).
 *
 * Before 0.6 a campaign saved its sender name and reply-to, showed them to the
 * approver, and the mail then went out from the Mailbox's default account (PiB's
 * own Gmail) with no Reply-To. Now:
 *
 * - Each sender (`own`, `company:<id>`, `contact:<id>`: the kit `senderKeyOf`) can
 *   have an identity: a Mailbox account address to send from (a connected Gmail
 *   mailbox, or since 0.7.0 a send-only address on a verified sending domain of the
 *   email provider), a display name, a reply-to, and the SMS and WhatsApp numbers.
 *   `set-sender-identity` writes it. A send-only address has no inbox, so its
 *   replies go to the reply-to and are matched to the step by that mailbox.
 * - Own marketing may use the Mailbox default account when no identity is set. A
 *   CLIENT's marketing needs that client's identity: with none the send is refused
 *   (kit `resolveSender`) rather than going out as PiB, and so is approval and
 *   launch. Nobody can send as an address the Mailbox does not hold: it only sends
 *   from an account the company connected or a provider domain it registered, and
 *   refuses any other `from`.
 * - A campaign's own `fromName` and `replyTo` win over the identity's.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, resolveSender, senderKeyOf, type SenderIdentity } from "@partnersinbiz/pib-plugin-kit";
import type { MessagingChannel } from "./channels.js";
import { listSenderIdentityRows, type SenderIdentityRow } from "./db.js";
import { campaignSenderKey, type CampaignDraft } from "./domain.js";
import { defaultSender, type MessagingSetup } from "./messaging.js";

export type EmailSender =
  | { ok: true; senderKey: string; identity: SenderIdentity | null; fromName: string; replyTo: string | null }
  | { ok: false; senderKey: string; error: string };

export type MessageSender = { ok: true; senderKey: string; from: string; name: string } | { ok: false; senderKey: string; error: string };

function emailIdentities(rows: SenderIdentityRow[]): SenderIdentity[] {
  return rows
    .filter((row) => row.from_address)
    .map((row) => ({ senderKey: row.sender_key, fromAddress: row.from_address!, fromName: row.from_name, replyTo: row.reply_to }));
}

function clientLabel(campaign: Pick<CampaignDraft, "clientName" | "clientRef">): string {
  return campaign.clientName ?? campaign.clientRef ?? "the client";
}

/** The display name a campaign's messages carry. */
async function senderName(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "fromName" | "clientRef" | "clientName"> | null, row: SenderIdentityRow | undefined): Promise<string> {
  if (campaign?.fromName) return campaign.fromName;
  if (row?.from_name) return row.from_name;
  if (campaign?.clientRef) return campaign.clientName ?? "";
  try {
    const config = await readConfig(ctx, companyId);
    if (typeof config.defaultFromName === "string" && config.defaultFromName.trim()) return config.defaultFromName.trim();
  } catch {
    // no settings yet
  }
  return "Partners in Biz";
}

/**
 * Who a campaign's messages say they are from, for the footer of an email an agent sends
 * by hand (issue delivery, or after a failed send). It does not need the sender to be
 * connected: the words "who we are" are the same either way.
 */
export async function senderDisplayName(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "fromName" | "clientRef" | "clientName" | "clientKind"> | null): Promise<string> {
  try {
    const key = senderKeyOf(campaign);
    const row = (await listSenderIdentityRows(ctx, companyId)).find((entry) => entry.sender_key === key);
    return await senderName(ctx, companyId, campaign, row);
  } catch {
    return campaign?.fromName || campaign?.clientName || "Partners in Biz";
  }
}

/** The mailbox a campaign's email goes out from, its display name and reply-to; or why it may not go out. */
export async function resolveEmailSender(ctx: PluginContext, companyId: string, campaign: CampaignDraft, rows?: SenderIdentityRow[]): Promise<EmailSender> {
  const all = rows ?? (await listSenderIdentityRows(ctx, companyId));
  const senderKey = campaignSenderKey(campaign);
  const resolved = resolveSender(emailIdentities(all), campaign);
  if (!resolved.ok) {
    return {
      ok: false,
      senderKey,
      error: `No sender is set up for ${senderKey} (${clientLabel(campaign)}), so this campaign's email would go out from PiB's own Gmail. Add one with set-sender-identity (fromAddress is a Gmail mailbox connected in the Mailbox or a send-only address on the client's sending domain; add fromName and replyTo). Email for a client is never sent from the default account.`,
    };
  }
  const row = all.find((entry) => entry.sender_key === senderKey);
  return {
    ok: true,
    senderKey,
    identity: resolved.identity,
    fromName: await senderName(ctx, companyId, campaign, row),
    replyTo: campaign.replyTo ?? resolved.identity?.replyTo ?? null,
  };
}

/** The number an SMS or WhatsApp message goes out from. A client's campaign never uses PiB's own number. */
export async function resolveMessageSender(
  ctx: PluginContext,
  companyId: string,
  campaign: CampaignDraft,
  channel: MessagingChannel,
  setup: MessagingSetup,
  rows?: SenderIdentityRow[],
): Promise<MessageSender> {
  const all = rows ?? (await listSenderIdentityRows(ctx, companyId));
  const senderKey = senderKeyOf(campaign);
  const row = all.find((entry) => entry.sender_key === senderKey);
  const own = channel === "sms" ? row?.sms_from : row?.whatsapp_from;
  const name = await senderName(ctx, companyId, campaign, row);
  if (own) return { ok: true, senderKey, from: own, name };
  if (campaign.clientRef) {
    return {
      ok: false,
      senderKey,
      error: `No ${channel === "sms" ? "SMS" : "WhatsApp"} number is set up for ${senderKey} (${clientLabel(campaign)}), so this campaign's messages would go out from PiB's own number. Add one with set-sender-identity (${channel === "sms" ? "smsFrom" : "whatsappFrom"}). A client's messages are never sent from PiB's number.`,
    };
  }
  const shared = defaultSender(setup, channel);
  if (!shared) return { ok: false, senderKey, error: `No ${channel === "sms" ? "SMS" : "WhatsApp"} number is set in the Campaigns settings.` };
  return { ok: true, senderKey, from: shared, name };
}
