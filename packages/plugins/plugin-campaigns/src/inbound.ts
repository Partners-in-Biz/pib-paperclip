/**
 * What comes back from SMS and WhatsApp: replies, STOP words, delivery results.
 *
 * - `poll-messaging` (a job) reads the replies the provider holds for the
 *   company's numbers since the last run and hands each to `handleInboundMessage`
 *   once (kit `receiveOnce`, keyed by the provider's message id). It then asks the
 *   provider for the delivery status of messages sent in the last three days.
 * - The `messaging-inbound` webhook takes the same message as JSON for setups that
 *   can forward it (Twilio Studio, a Function). It needs the company's shared
 *   secret in the `x-pib-webhook-secret` header: without one anybody could post
 *   "STOP" for any number.
 * - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT and a few sentences that plainly
 *   ask to stop put the number on the sender's do-not-contact list, stop that
 *   sender's running campaigns for the contact and cancel their open step issues.
 *   START and UNSTOP lift the person's own opt-out and record a fresh opt-in. HELP is
 *   answered by the provider. Anything else is a reply a person reads; the plugin
 *   cannot answer a text, so the issue says to reach the person another way.
 */
import { timingSafeEqual } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, decide, getCrmContact, isModuleEnabled, OWN_SENDER, receiveOnce, shouldAct } from "@partnersinbiz/pib-plugin-kit";
import {
  addChannelSuppression,
  crmContactsByPhone,
  enrollmentById,
  getCampaign,
  insertStepEventOnce,
  latestMessageFor,
  listSenderIdentityRows,
  markDecisionActed,
  messagesAwaitingStatus,
  pushEnrollmentDue,
  stopEnrollment,
  updateMessage,
} from "./db.js";
import { classifyKeyword, normalizePhone, type InboundIntent, type MessagingChannel } from "./channels.js";
import { campaignReplyPlan, clientPrefix, isReplyKind, pushDate, REPLY_KIND_LABELS } from "./domain.js";
import { jevConfigFor, REPLY_QUESTIONS, replyState } from "./jev.js";
import { campaignAssignee, openIssueOnce } from "./mail.js";
import { INBOUND_READ_CAP, inboundWebhookSecret, messagingSetup, type InboundMessage, type MessagingSetup } from "./messaging.js";
import { PLUGIN_ID } from "./namespace.js";
import { replyOrigin } from "./origins.js";
import { projectForCampaign } from "./projects.js";
import { knownCompanies } from "./setup-status.js";
import { optInChannel, optOutChannel } from "./sms.js";

export interface InboundOutcome extends Record<string, unknown> {
  intent: InboundIntent;
  matched: boolean;
  enrollmentId?: string;
  issueId?: string | null;
  optedOut?: boolean;
  optedIn?: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whose list a message to one of our numbers is on. A number we do not know stops everything (the safe side). */
async function senderKeyForNumber(ctx: PluginContext, companyId: string, channel: MessagingChannel, to: string, setup: MessagingSetup): Promise<string> {
  const rows = await listSenderIdentityRows(ctx, companyId);
  const hit = rows.find((row) => (channel === "sms" ? row.sms_from : row.whatsapp_from) === to);
  if (hit) return hit.sender_key;
  const own = channel === "sms" ? setup.config.smsFrom : setup.config.whatsappFrom;
  return own && own === to ? OWN_SENDER : "";
}

/** The projected contacts that have this number (any way it was written). */
async function contactsForPhone(ctx: PluginContext, companyId: string, phone: string, country: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await crmContactsByPhone(ctx, companyId, phone.replace(/\D/g, "").slice(-9));
  return rows.filter((row) => (row.phones ?? []).some((raw) => normalizePhone(raw, country) === phone)).map((row) => ({ id: row.id, name: row.name }));
}

function pct(value: number | null): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

async function processInbound(ctx: PluginContext, companyId: string, msg: InboundMessage, setup: MessagingSetup): Promise<InboundOutcome> {
  const intent = classifyKeyword(msg.body);
  const senderKey = await senderKeyForNumber(ctx, companyId, msg.channel, msg.to, setup);
  const contacts = await contactsForPhone(ctx, companyId, msg.from, setup.config.defaultCountry);
  const contactIds = contacts.map((contact) => contact.id);
  if (intent === "stop") {
    await optOutChannel(ctx, { companyId, channel: msg.channel, address: msg.from, senderKey, reason: "stop_keyword", source: PLUGIN_ID, contactIds, wording: "texted a stop word" });
    return { intent, matched: contactIds.length > 0, optedOut: true };
  }
  if (intent === "start") {
    await optInChannel(ctx, { companyId, channel: msg.channel, address: msg.from, senderKey, contactId: contactIds[0] ?? null, recordedAt: msg.receivedAt, evidence: "Replied START to our message" });
    return { intent, matched: contactIds.length > 0, optedIn: true };
  }
  if (intent === "help") return { intent, matched: false };

  // The reply belongs to the sender whose number was texted. A number the plugin does not know (senderKey "") matches any.
  const last = await latestMessageFor(ctx, companyId, msg.from, msg.channel, senderKey || null);
  const enrollment = last ? await enrollmentById(ctx, last.enrollment_id) : null;
  const campaign = enrollment ? await getCampaign(ctx, enrollment.campaignId) : null;
  if (!last || !enrollment || !campaign || campaign.companyId !== companyId) return { intent, matched: false };

  const config = await jevConfigFor(ctx, companyId);
  const decision = config
    ? await decide(ctx, companyId, { config, purpose: "campaigns.reply", subject: { kind: "sms", id: msg.providerId }, state: replyState({ subject: "Reply to a text message", snippet: msg.body }), questions: REPLY_QUESTIONS })
    : null;
  const answer = decision?.answers.reply_kind;
  const kind = answer && answer.type === "choice" && isReplyKind(answer.choice) ? answer.choice : null;
  const confidence = answer && answer.type === "choice" ? answer.confidence : null;
  const confident = Boolean(kind && shouldAct(answer, "update"));
  const plan = campaignReplyPlan(kind, confident);
  if (confident && decision?.ids.reply_kind) await markDecisionActed(ctx, decision.ids.reply_kind).catch(() => undefined);

  const stepPosition = last.step_position;
  if (plan.event) {
    await insertStepEventOnce(ctx, { companyId, campaignId: campaign.id, enrollmentId: enrollment.id, stepPosition, eventType: plan.event, variant: enrollment.variant, sourceKey: `${plan.event}:${msg.providerId}`, meta: { channel: msg.channel, providerId: msg.providerId, kind, confidence } });
  }
  if (plan.suppress === "unsubscribe") {
    await optOutChannel(ctx, { companyId, channel: msg.channel, address: msg.from, senderKey: last.sender_key, reason: "stop_keyword", source: PLUGIN_ID, contactIds: [...new Set([enrollment.contactId, ...contactIds])], campaignId: campaign.id, wording: "asked to stop in their own words" });
  }
  if (plan.stop === "this" && enrollment.status === "running") await stopEnrollment(ctx, enrollment.id);
  if (plan.pushDays && enrollment.status === "running") await pushEnrollmentDue(ctx, enrollment.id, pushDate(enrollment.nextDueAt, new Date(), plan.pushDays));

  let issueId: string | null = null;
  if (plan.issue) {
    const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId).catch(() => null);
    const name = contact?.name ?? "A contact";
    const followUp = plan.issue === "follow-up";
    const channelName = msg.channel === "sms" ? "SMS" : "WhatsApp";
    const reason = !config ? "Smart sorting is not set up, so the reply was not read." : !decision ? "Smart sorting could not be reached, so the reply was not read." : kind && !confident ? `Smart sorting thinks it is ${REPLY_KIND_LABELS[kind]} but is only ${pct(confidence)} sure.` : kind ? `Smart sorting read it as ${REPLY_KIND_LABELS[kind]}.` : "Smart sorting could not tell what kind of reply it is.";
    const lines = [
      `${name} (\`contact:${enrollment.contactId}\`) replied by ${channelName} to campaign "${campaign.name}" (step ${stepPosition}). ${followUp ? `Smart sorting read it as **${REPLY_KIND_LABELS[kind!]}** (${pct(confidence)} sure), so the campaign is stopped for this contact.` : reason}`,
      "",
      `The plugin cannot answer a text. Reach them another way (call, or email through \`partnersinbiz.mailbox:create-draft\`), log what you did with \`partnersinbiz.campaigns:log-reply\` (messageId \`${msg.providerId}\`, outcome \`answered\` or \`no-reply-needed\`), then mark this issue done.`,
      followUp ? "Log the next step on the contact in the CRM too." : `If they asked to stop in their own words, record it: \`partnersinbiz.campaigns:suppress-phone\` (phone, channel \`${msg.channel}\`${campaign.clientRef ? `, client \`${campaign.clientKind ?? "company"}:${campaign.clientRef}\`` : ""}).`,
      "",
      `> ${msg.body.replace(/\s+/g, " ").slice(0, 500)}`,
    ];
    issueId = await openIssueOnce(ctx, {
      companyId,
      originId: replyOrigin(enrollment.id, msg.providerId),
      title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}${followUp ? "Reply from" : "Check reply from"} ${name} (${channelName})`,
      description: lines.join("\n"),
      assignee: await campaignAssignee(ctx, companyId, campaign),
      wakeReason: "A campaign contact replied",
      projectId: await projectForCampaign(ctx, companyId, campaign),
    });
  }
  return { intent, matched: true, enrollmentId: enrollment.id, issueId };
}

/** One inbound message, handled once however often the provider or the poll hands it over. */
export async function handleInboundMessage(ctx: PluginContext, companyId: string, msg: InboundMessage, setup?: MessagingSetup): Promise<{ result: InboundOutcome; repeat: boolean }> {
  const resolved = setup ?? (await messagingSetup(ctx, companyId));
  return receiveOnce<InboundOutcome>(ctx, companyId, "messaging.inbound", `msg:${msg.channel}:${msg.providerId}`, () => processInbound(ctx, companyId, msg, resolved));
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const cursorState = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "campaigns-messaging", stateKey: "inbound-cursor" });
/** First poll for a company: look back this far, so a STOP sent before the channel was switched on is still honoured. */
const FIRST_LOOKBACK_MS = 3 * 86_400_000;
const STATUS_LOOKBACK_MS = 3 * 86_400_000;

/** The provider's codes that mean the number cannot be reached at all: it is not tried again. */
const UNREACHABLE = new Set(["30005", "30006", "21211", "21614"]);

export interface PollOutcome {
  companyId: string;
  inbound: number;
  stops: number;
  statuses: number;
  error?: string;
}

/** Reads replies and delivery results for one company. Throws nothing: the error comes back in the outcome. */
export async function pollCompany(ctx: PluginContext, companyId: string, now = new Date()): Promise<PollOutcome> {
  const out: PollOutcome = { companyId, inbound: 0, stops: 0, statuses: 0 };
  const setup = await messagingSetup(ctx, companyId);
  const provider = setup.provider;
  if (!provider) return out;
  try {
    const numbers: Array<{ channel: MessagingChannel; address: string }> = [];
    const add = (channel: MessagingChannel, address: string | null | undefined) => {
      if (address && !numbers.some((n) => n.channel === channel && n.address === address)) numbers.push({ channel, address });
    };
    add("sms", setup.config.smsFrom);
    add("whatsapp", setup.config.whatsappFrom);
    for (const row of await listSenderIdentityRows(ctx, companyId)) {
      add("sms", row.sms_from);
      add("whatsapp", row.whatsapp_from);
    }
    const stored = (await ctx.state.get(cursorState(companyId)).catch(() => null)) as { at?: string } | null;
    const since = stored?.at && Number.isFinite(Date.parse(stored.at)) ? new Date(stored.at) : new Date(now.getTime() - FIRST_LOOKBACK_MS);
    if (numbers.length > 0) {
      const messages = await provider.inbound({ since, numbers });
      let latest = since.getTime();
      for (const msg of messages) {
        const { result, repeat } = await handleInboundMessage(ctx, companyId, msg, setup);
        if (!repeat) {
          out.inbound += 1;
          if (result.optedOut) out.stops += 1;
        }
        latest = Math.max(latest, Date.parse(msg.receivedAt));
      }
      // The cursor only moves forward, with five minutes of overlap so a message that reached the provider
      // late is still read (repeats are skipped). A read that came back short of the provider's cap saw everything
      // up to now, so an idle number does not widen the read window on every poll; a full read may have left
      // messages unread, so it stays at the newest one it handled.
      const capped = messages.length >= INBOUND_READ_CAP;
      if (capped) ctx.logger.warn("Messaging poll read as many replies as it can in one go; some may be unread (the provider still blocks anyone who replied STOP)", { companyId, read: messages.length });
      const reached = capped ? Math.min(now.getTime(), latest) : now.getTime();
      await ctx.state.set(cursorState(companyId), { at: new Date(Math.max(since.getTime(), reached - 5 * 60_000)).toISOString() }).catch(() => undefined);
    }
    out.statuses = await reconcileStatuses(ctx, companyId, setup, now);
  } catch (error) {
    out.error = message(error);
    ctx.logger.warn("Messaging poll failed", { companyId, error: out.error });
  }
  return out;
}

/** Brings the delivery status of recent messages up to date. A number that cannot be reached is not messaged again. */
export async function reconcileStatuses(ctx: PluginContext, companyId: string, setup: MessagingSetup, now = new Date()): Promise<number> {
  const provider = setup.provider;
  if (!provider) return 0;
  const rows = await messagesAwaitingStatus(ctx, companyId, new Date(now.getTime() - STATUS_LOOKBACK_MS).toISOString());
  const byProvider = new Map(rows.filter((row) => row.provider_id).map((row) => [row.provider_id!, row]));
  if (byProvider.size === 0) return 0;
  let changed = 0;
  for (const status of await provider.statuses([...byProvider.keys()])) {
    const row = byProvider.get(status.providerId);
    if (!row) continue;
    const word = status.status.toLowerCase();
    if (word === "delivered" || word === "read") {
      await updateMessage(ctx, row.key, { status: "delivered", provider_status: word });
      await insertStepEventOnce(ctx, { companyId, campaignId: row.campaign_id, enrollmentId: row.enrollment_id, stepPosition: row.step_position, eventType: "delivered", variant: "a", sourceKey: `delivered:${row.key}`, meta: { channel: row.channel, providerId: status.providerId } });
      changed += 1;
    } else if (word === "undelivered" || word === "failed") {
      await updateMessage(ctx, row.key, { status: "failed", provider_status: word, error_code: status.errorCode, error: `The provider could not deliver it${status.errorCode ? ` (code ${status.errorCode})` : ""}.` });
      await insertStepEventOnce(ctx, { companyId, campaignId: row.campaign_id, enrollmentId: row.enrollment_id, stepPosition: row.step_position, eventType: "failed", variant: "a", sourceKey: `failed:${row.key}`, meta: { channel: row.channel, providerId: status.providerId, code: status.errorCode } });
      if (status.errorCode === "21610") {
        await optOutChannel(ctx, { companyId, channel: row.channel, address: row.to_address, senderKey: row.sender_key, reason: "provider_opt_out", source: PLUGIN_ID, contactIds: row.contact_id ? [row.contact_id] : [], campaignId: row.campaign_id, wording: "blocked at the provider after STOP" });
      } else if (status.errorCode && UNREACHABLE.has(status.errorCode)) {
        await addChannelSuppression(ctx, { companyId, channel: row.channel, address: row.to_address, senderKey: row.sender_key, reason: "invalid_number", scope: "all", source: PLUGIN_ID, contactId: row.contact_id, campaignId: row.campaign_id });
      }
      changed += 1;
    } else if (word !== row.provider_status) {
      await updateMessage(ctx, row.key, { provider_status: word });
    }
  }
  return changed;
}

/** Job: poll every company that has Campaigns settings saved, the module on and a provider ready. */
export async function pollMessaging(ctx: PluginContext): Promise<PollOutcome[]> {
  const out: PollOutcome[] = [];
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await configSaved(ctx, companyId)) || !(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      const result = await pollCompany(ctx, companyId);
      out.push(result);
    } catch (error) {
      ctx.logger.warn("Messaging poll skipped", { companyId, error: message(error) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The inbound webhook
// ---------------------------------------------------------------------------

function field(body: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A reply forwarded as JSON: `{ companyId, MessageSid, From, To, Body }` (Twilio's
 * own field names, or camelCase), with the company's shared secret in the
 * `x-pib-webhook-secret` header. Throws with a plain message when it is refused.
 */
export async function handleInboundWebhook(ctx: PluginContext, input: { headers: Record<string, string | string[] | undefined>; parsedBody?: unknown }): Promise<void> {
  const body = (input.parsedBody && typeof input.parsedBody === "object" ? input.parsedBody : {}) as Record<string, unknown>;
  const companyId = field(body, "companyId");
  if (!companyId) throw new Error("companyId is required.");
  if (!(await configSaved(ctx, companyId))) throw new Error("Not accepted.");
  const secret = await inboundWebhookSecret(ctx, companyId);
  const header = input.headers["x-pib-webhook-secret"];
  const given = Array.isArray(header) ? header[0] : header;
  // The same refusal whether the secret is unset or wrong: nothing to learn from the answer.
  if (!secret || secret.length < 16 || !given || !sameSecret(given, secret)) throw new Error("Not accepted.");
  const providerId = field(body, "MessageSid", "SmsSid", "messageSid", "providerId");
  const toRaw = field(body, "To", "to");
  const fromRaw = field(body, "From", "from");
  const channel: MessagingChannel = /^whatsapp:/i.test(toRaw) || body.channel === "whatsapp" ? "whatsapp" : "sms";
  const to = normalizePhone(toRaw, "+");
  const from = normalizePhone(fromRaw, "+");
  if (!providerId || !to || !from) throw new Error("MessageSid, From and To are required.");
  await handleInboundMessage(ctx, companyId, { providerId, channel, from, to, body: field(body, "Body", "body"), receivedAt: new Date().toISOString() });
}
