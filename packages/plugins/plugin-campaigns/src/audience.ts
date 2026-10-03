/**
 * Who a launch enrolls, and who can actually be reached on each channel.
 *
 * - Email is opt-out: everyone in the audience except addresses on the sender's
 *   do-not-email list. A contact with no address stays in (they get the usual
 *   step issue), as before.
 * - SMS and WhatsApp are opt-in: a contact is enrolled in a campaign whose first
 *   step is a text only when they have a mobile number, an opt-in on record for
 *   this sender and channel, and are not on the sender's do-not-contact list. A
 *   later step on another channel is skipped for a contact it cannot reach.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { agentRecordedConsents, audienceContacts, blockedAddresses, consentedAddresses, crmContactsByIds, suppressedEmails, type AudienceContact } from "./db.js";
import { campaignPhone, isMessagingChannel, type Channel, type MessagingChannel } from "./channels.js";
import { campaignAddress, campaignSenderKey, stepChannel, type CampaignDraft, type CampaignStepDraft } from "./domain.js";

/** The channel of the first step (lowest position, version A). */
export function firstChannel(steps: CampaignStepDraft[]): Channel {
  const first = [...steps].filter((step) => step.variant !== "b").sort((a, b) => a.position - b.position)[0];
  return first ? stepChannel(first) : "email";
}

export function channelsUsed(steps: CampaignStepDraft[]): Channel[] {
  return [...new Set(steps.map((step) => stepChannel(step)))];
}

export interface AudienceReach {
  /** Contacts with an email address that is not on the sender's list. */
  email: number;
  /** Contacts with a mobile number, an opt-in for this sender and no block, per text channel. */
  sms: number;
  whatsapp: number;
}

export interface LaunchAudience {
  /** Everyone who matches the audience now. */
  contacts: AudienceContact[];
  /** Who a launch enrolls. */
  eligible: AudienceContact[];
  /** Left out because they opted out (or, for a text, are blocked). */
  suppressedCount: number;
  /** Left out of a text campaign: no mobile number, or no opt-in on record. */
  notReachable: number;
  reach: AudienceReach;
  /**
   * Of the contacts counted in `reach`, how many have their opt-in recorded by an agent
   * (`record-channel-consent`) instead of coming from a form, an import or the person. The
   * approver sees it: an agent's typed evidence is the weakest proof of consent.
   */
  agentRecorded: Record<MessagingChannel, number>;
}

export async function launchAudience(
  ctx: PluginContext,
  companyId: string,
  campaign: CampaignDraft,
  steps: CampaignStepDraft[],
  contactIds: string[] = [],
  defaultCountry = "+27",
): Promise<LaunchAudience> {
  const contacts: AudienceContact[] = contactIds.length > 0 ? await crmContactsByIds(ctx, companyId, contactIds) : await audienceContacts(ctx, companyId, campaign);
  const senderKey = campaignSenderKey(campaign);
  const suppressed = await suppressedEmails(ctx, companyId, contacts.map((contact) => campaignAddress(contact.emails) ?? "").filter(Boolean), senderKey);
  const phones = new Map<string, string>();
  for (const contact of contacts) {
    const phone = campaignPhone(contact.phones, defaultCountry);
    if (phone) phones.set(contact.id, phone);
  }
  const reach: AudienceReach = { email: contacts.filter((contact) => { const a = campaignAddress(contact.emails); return Boolean(a) && !suppressed.has(a!); }).length, sms: 0, whatsapp: 0 };
  const textOk: Record<MessagingChannel, Set<string>> = { sms: new Set(), whatsapp: new Set() };
  const agentRecorded: Record<MessagingChannel, number> = { sms: 0, whatsapp: 0 };
  for (const channel of channelsUsed(steps)) {
    if (!isMessagingChannel(channel)) continue;
    const numbers = [...phones.values()];
    const blocked = await blockedAddresses(ctx, companyId, channel, numbers, senderKey);
    const consented = await consentedAddresses(ctx, companyId, channel, numbers, senderKey);
    for (const contact of contacts) {
      const phone = phones.get(contact.id);
      if (phone && !blocked.has(phone) && consented.has(phone)) textOk[channel].add(contact.id);
    }
    reach[channel] = textOk[channel].size;
    agentRecorded[channel] = await agentRecordedConsents(ctx, companyId, channel, contacts.filter((contact) => textOk[channel].has(contact.id)).map((contact) => phones.get(contact.id)!), senderKey);
  }
  const first = firstChannel(steps);
  let eligible: AudienceContact[];
  let suppressedCount: number;
  let notReachable = 0;
  if (isMessagingChannel(first)) {
    eligible = contacts.filter((contact) => textOk[first].has(contact.id));
    const blocked = await blockedAddresses(ctx, companyId, first, [...phones.values()], senderKey);
    suppressedCount = contacts.filter((contact) => { const phone = phones.get(contact.id); return Boolean(phone) && blocked.has(phone!); }).length;
    notReachable = contacts.length - eligible.length - suppressedCount;
  } else {
    eligible = contacts.filter((contact) => {
      const address = campaignAddress(contact.emails);
      return !address || !suppressed.has(address);
    });
    suppressedCount = contacts.length - eligible.length;
  }
  return { contacts, eligible, suppressedCount, notReachable, reach, agentRecorded };
}
