/**
 * Tools for who a campaign sends as, who agreed to be texted, and the checks
 * before approval: `set-sender-identity`, `remove-sender-identity`,
 * `list-sender-identities`, `record-channel-consent`, `suppress-phone` and
 * `preflight-campaign`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientScopeFromInput, formatClientParam, getCrmContact, resolveCrmClient, senderKeyOf, suppressionEmail, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { campaignPhone, normalizePhone, maskPhone, isMobile, type MessagingChannel } from "./channels.js";
import { crmContactsByPhone, deleteSenderIdentity, getCampaign, listSenderIdentityRows, listSteps, upsertConsent, upsertSenderIdentity, type SenderIdentityRow } from "./db.js";
import { CampaignError } from "./domain.js";
import { messagingSetup } from "./messaging.js";
import { PLUGIN_ID } from "./namespace.js";
import { optOutChannel } from "./sms.js";
import { optionalString, requiredString, stringList } from "./params.js";
import { gatherPreflight } from "./preflight.js";

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/** The sender named by `client`: own work when it is omitted, `own` or empty. */
function senderScope(params: Record<string, unknown>): ClientScope {
  const scope = clientScopeFromInput(params);
  if (scope !== undefined) return scope;
  if ("client" in params || "clientRef" in params) throw new CampaignError("client must be company:<crm company id>, contact:<crm contact id> or own.");
  return null;
}

async function requireClientExists(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<string> {
  if (!scope) return "own";
  const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope);
  if (!client) throw new CampaignError(`CRM ${scope.kind} ${scope.id} was not found. Run the CRM "resync" action if it was just created.`);
  return formatClientParam(scope);
}

/** `""` and null clear a field; a missing key keeps it. */
function change(params: Record<string, unknown>, key: string): { set: boolean; value: string | null } {
  if (!(key in params)) return { set: false, value: null };
  const raw = params[key];
  if (raw == null || raw === "") return { set: true, value: null };
  if (typeof raw !== "string") throw new CampaignError(`${key} must be a string`);
  return { set: true, value: raw.trim() };
}

function publicIdentity(row: SenderIdentityRow) {
  return { sender: row.sender_key, fromAddress: row.from_address, fromName: row.from_name, replyTo: row.reply_to, smsFrom: row.sms_from, whatsappFrom: row.whatsapp_from };
}

/** True when an identity differs in anything a recipient or a send would notice. */
export function identityChanged(before: SenderIdentityRow | undefined, after: SenderIdentityRow): boolean {
  const keys = ["from_address", "from_name", "reply_to", "sms_from", "whatsapp_from"] as const;
  return keys.some((key) => (before?.[key] ?? null) !== (after[key] ?? null));
}

/**
 * `beforeSave` runs with the identity as it was and as it will be, so the caller
 * can refuse a change that must not happen (the worker refuses one under a running
 * campaign: the approver saw the old sender, and a new one would go out unapproved).
 */
export async function setSenderIdentity(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  actor: string | null,
  beforeSave?: (before: SenderIdentityRow | undefined, after: SenderIdentityRow) => Promise<void>,
): Promise<Record<string, unknown>> {
  const scope = senderScope(params);
  await requireClientExists(ctx, companyId, scope);
  const senderKey = senderKeyOf(scope ? { clientKind: scope.kind, clientRef: scope.id } : null);
  const existing = (await listSenderIdentityRows(ctx, companyId)).find((row) => row.sender_key === senderKey);
  const next: SenderIdentityRow = existing ? { ...existing } : { company_id: companyId, sender_key: senderKey, from_address: null, from_name: null, reply_to: null, sms_from: null, whatsapp_from: null };
  const setup = await messagingSetup(ctx, companyId);

  const from = change(params, "fromAddress");
  if (from.set) {
    if (from.value && !EMAIL.test(from.value)) throw new CampaignError("fromAddress must be an email address: a mailbox connected in the Mailbox.");
    next.from_address = from.value ? suppressionEmail(from.value) : null;
  }
  const name = change(params, "fromName");
  if (name.set) next.from_name = name.value ? name.value.slice(0, 120) : null;
  const reply = change(params, "replyTo");
  if (reply.set) {
    if (reply.value && !EMAIL.test(reply.value)) throw new CampaignError("replyTo must be an email address.");
    next.reply_to = reply.value ? suppressionEmail(reply.value) : null;
  }
  for (const [key, column] of [["smsFrom", "sms_from"], ["whatsappFrom", "whatsapp_from"]] as const) {
    const field = change(params, key);
    if (!field.set) continue;
    if (!field.value) {
      next[column] = null;
      continue;
    }
    // A Twilio Messaging Service SID is allowed for SMS; everything else must be a real number.
    const phone = /^MG[0-9a-zA-Z]{20,}$/.test(field.value) && key === "smsFrom" ? field.value : normalizePhone(field.value, setup.config.defaultCountry);
    if (!phone || (!phone.startsWith("MG") && !isMobile(phone))) throw new CampaignError(`${key} must be a phone number such as +27821234567${key === "smsFrom" ? " or a Messaging Service SID (MG...)" : ""}.`);
    next[column] = phone;
  }
  if (!next.from_address && !next.sms_from && !next.whatsapp_from && !next.from_name && !next.reply_to) throw new CampaignError("Nothing to save: give at least one of fromAddress, fromName, replyTo, smsFrom, whatsappFrom.");
  next.updated_by = actor;
  await beforeSave?.(existing, next);
  await upsertSenderIdentity(ctx, next);
  return { saved: true, ...publicIdentity(next), next: next.from_address ? "Email goes out from that mailbox, which must be connected in the Mailbox (it refuses any other). A campaign draft that was waiting for approval needs a new request." : "Done." };
}

export async function removeSenderIdentity(ctx: PluginContext, companyId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope = senderScope(params);
  const senderKey = senderKeyOf(scope ? { clientKind: scope.kind, clientRef: scope.id } : null);
  return { sender: senderKey, removed: await deleteSenderIdentity(ctx, companyId, senderKey) };
}

export async function listSenderIdentities(ctx: PluginContext, companyId: string): Promise<Record<string, unknown>> {
  return { identities: (await listSenderIdentityRows(ctx, companyId)).map(publicIdentity) };
}

const CONSENT_SOURCES = ["form", "import", "manual", "reply", "api"] as const;
const MAX_PEOPLE = 200;

/**
 * An agent records that people agreed (or no longer agree) to SMS or WhatsApp from
 * a sender. The approver sees how many opt-ins a campaign relies on; this is where
 * they come from, so the evidence is required and kept with the record.
 */
export async function recordChannelConsent(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: string | null): Promise<Record<string, unknown>> {
  const channel = requiredString(params, "channel");
  if (channel !== "sms" && channel !== "whatsapp") throw new CampaignError("channel must be sms or whatsapp");
  const basis = optionalString(params, "basis") ?? "consent";
  if (basis !== "consent" && basis !== "contract") throw new CampaignError("basis must be consent or contract");
  if (basis === "contract" && channel === "whatsapp") throw new CampaignError("WhatsApp needs the person's own opt-in (basis consent): an existing customer relationship is not enough.");
  const source = optionalString(params, "source") ?? "manual";
  if (!(CONSENT_SOURCES as readonly string[]).includes(source)) throw new CampaignError(`source must be one of ${CONSENT_SOURCES.join(", ")}`);
  const evidence = requiredString(params, "evidence");
  if (evidence.length < 12) throw new CampaignError("evidence must say what the person agreed to, where and when (at least a short sentence).");
  const granted = params.granted !== false;
  const scope = senderScope(params);
  await requireClientExists(ctx, companyId, scope);
  const senderKey = senderKeyOf(scope ? { clientKind: scope.kind, clientRef: scope.id } : null);
  const contactIds = stringList(params, "contactIds");
  const phones = stringList(params, "phones");
  if (contactIds.length === 0 && phones.length === 0) throw new CampaignError("Give contactIds (CRM contacts, whose mobile number is used) or phones.");
  if (contactIds.length + phones.length > MAX_PEOPLE) throw new CampaignError(`At most ${MAX_PEOPLE} people per call.`);
  const setup = await messagingSetup(ctx, companyId);
  const targets: Array<{ address: string; contactId: string | null }> = [];
  const skipped: string[] = [];
  for (const id of contactIds) {
    const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, id).catch(() => null);
    const phone = contact ? campaignPhone(contact.phones, setup.config.defaultCountry) : null;
    if (phone) targets.push({ address: phone, contactId: id });
    else skipped.push(`${id}: ${contact ? "no mobile number" : "not found in the CRM"}`);
  }
  for (const raw of phones) {
    const phone = normalizePhone(raw, setup.config.defaultCountry);
    if (phone && isMobile(phone)) targets.push({ address: phone, contactId: null });
    else skipped.push(`${maskPhone(raw.replace(/\D/g, "").padStart(7, "0"))}: not a mobile number`);
  }
  const recordedAt = new Date().toISOString();
  let recorded = 0;
  for (const target of targets) {
    if (granted) {
      if (await upsertConsent(ctx, { companyId, channel, address: target.address, senderKey, granted: true, basis, source, evidence, contactId: target.contactId, recordedAt, recordedBy: actor })) recorded += 1;
    } else {
      await upsertConsent(ctx, { companyId, channel, address: target.address, senderKey, granted: false, basis, source, evidence, contactId: target.contactId, recordedAt, recordedBy: actor });
      await optOutChannel(ctx, { companyId, channel, address: target.address, senderKey, reason: "manual", source: PLUGIN_ID, contactIds: target.contactId ? [target.contactId] : [], wording: "opt-out recorded by a person or agent" });
      recorded += 1;
    }
  }
  return { channel, sender: senderKey, granted, recorded, skipped, next: granted ? "These people can now be enrolled in a campaign for this sender that uses this channel." : "They are on the do-not-contact list and their running campaigns for this sender stopped." };
}

/** An agent records that someone asked not to be texted or messaged on WhatsApp. */
export async function suppressPhone(ctx: PluginContext, companyId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const phoneRaw = requiredString(params, "phone");
  const setup = await messagingSetup(ctx, companyId);
  const phone = normalizePhone(phoneRaw, setup.config.defaultCountry);
  if (!phone) throw new CampaignError("phone must be a phone number such as +27821234567");
  const which = optionalString(params, "channel") ?? "both";
  if (which !== "sms" && which !== "whatsapp" && which !== "both") throw new CampaignError("channel must be sms, whatsapp or both");
  const scopeGiven = "client" in params || "clientRef" in params;
  const scope = scopeGiven ? senderScope(params) : undefined;
  // Without `client` the opt-out is for every sender (the safe side); `own` or a client limits it to that sender.
  const senderKey = scope === undefined ? "" : senderKeyOf(scope ? { clientKind: scope.kind, clientRef: scope.id } : null);
  const channels: MessagingChannel[] = which === "both" ? ["sms", "whatsapp"] : [which];
  const contactIds = (await crmContactsByPhone(ctx, companyId, phone.replace(/\D/g, "").slice(-9))).filter((row) => (row.phones ?? []).some((raw) => normalizePhone(raw, setup.config.defaultCountry) === phone)).map((row) => row.id);
  let stopped = 0;
  for (const channel of channels) {
    const outcome = await optOutChannel(ctx, { companyId, channel, address: phone, senderKey, reason: "manual", source: PLUGIN_ID, contactIds, wording: "opted out, recorded by an agent" });
    stopped += outcome.stopped;
  }
  return { phone: maskPhone(phone), channels, sender: senderKey || "every sender", stoppedEnrollments: stopped };
}

/** The checks an approval request runs, on demand, so an agent can fix problems first. */
export async function preflightCampaign(ctx: PluginContext, companyId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const campaign = await getCampaign(ctx, requiredString(params, "campaignId"));
  if (!campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign was not found");
  const steps = await listSteps(ctx, campaign.id);
  const result = await gatherPreflight(ctx, companyId, campaign, steps, { network: params.links !== false });
  return { campaignId: campaign.id, ok: result.ok, errors: result.errors, warnings: result.warnings, sentAs: result.sentAs, channels: result.channels };
}
