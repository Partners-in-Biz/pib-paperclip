/**
 * Sending an SMS or WhatsApp campaign step, and the opt-out and opt-in records
 * that go with it.
 *
 * A step goes out only when all of these hold, checked in this order:
 * 1. the channel is ready (provider account, secret and a sender number) and the
 *    sender resolves: a client's message never goes out from PiB's own number;
 * 2. the contact has a mobile number (a landline is never texted);
 * 3. the number is not on the sender's do-not-contact list (STOP, a provider
 *    block, a number that cannot be reached);
 * 4. the number has a granted opt-in on file for this sender and channel (SMS and
 *    WhatsApp marketing is opt-in; email is opt-out). Without one the step is
 *    skipped, not sent;
 * 5. it is inside the send window (default Mon-Fri 08:00-20:00, Sat 09:00-13:00,
 *    never Sunday); outside it the step waits for the window to open.
 * The text always says how to opt out ("Reply STOP to opt out." is added when the
 * step does not say it). The row in `channel_messages` is written BEFORE the
 * provider is called, so a crash can never send a step twice.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { consentKey, getCrmContact, HANDOFF_EVENTS, type ConsentRecorded } from "@partnersinbiz/pib-plugin-kit";
import {
  addChannelSuppression,
  blockedAddresses,
  claimMessage,
  consentedAddresses,
  getMessage,
  insertStepEventOnce,
  liftChannelSuppression,
  pushEnrollmentDue,
  saveEnrollment,
  stopEnrollmentsForSender,
  updateMessage,
  upsertConsent,
  type ChannelMessageRow,
  type ChannelSuppressionReason,
} from "./db.js";
import {
  campaignPhone,
  isInSendWindow,
  maskPhone,
  nextSendWindow,
  smsLength,
  SMS_MAX_CHARS,
  WHATSAPP_SESSION_MAX,
  WHATSAPP_TEMPLATE_MAX,
  withOptOutLine,
  type MessagingChannel,
} from "./channels.js";
import {
  advanceEnrollment,
  campaignMessageKey,
  personalize,
  stepChannel,
  type CampaignDraft,
  type CampaignStepDraft,
  type EnrollmentDraft,
} from "./domain.js";
import { failStep, personalVars } from "./mail.js";
import { firstHeldLog, messagingSetup, providerPaused, readinessOf, recordProviderResult, type MessagingSetup, type OutboundMessage, type SendOutcome } from "./messaging.js";
import { PLUGIN_ID } from "./namespace.js";
import { resolveMessageSender } from "./sender.js";
import { cancelStepIssue } from "./suppress.js";

export type MessagingStepResult = "sent" | "stopped" | "issue" | "deferred" | "held" | "skipped";

/** A retryable answer (429, 503) is tried this many times, ten minutes apart, before a person is asked. */
export const MESSAGE_MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 10;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Opt-out and opt-in
// ---------------------------------------------------------------------------

/** The client a sender key stands for, or none for PiB's own list and for "every sender". */
export function clientOfSender(senderKey: string): { clientKind: "company" | "contact"; clientRef: string } | null {
  const match = /^(company|contact):(.+)$/.exec(senderKey);
  return match ? { clientKind: match[1] as "company" | "contact", clientRef: match[2]! } : null;
}

/**
 * Tells the CRM about an opt-out or opt-in. The subject names the client the number was
 * texted for (from the sender key), so a client's STOP reaches the CRM as that client's
 * withdrawn consent and never as PiB's own.
 */
async function announceConsent(ctx: PluginContext, companyId: string, input: { phone: string; contactId?: string | null; granted: boolean; wording: string; recordedAt: string; senderKey: string }): Promise<void> {
  const client = clientOfSender(input.senderKey);
  const subject = { phone: input.phone, contactId: input.contactId ?? null, clientKind: client?.clientKind ?? null, clientRef: client?.clientRef ?? null };
  const key = consentKey(subject, "marketing_sms", input.recordedAt);
  if (!key) return;
  const payload: ConsentRecorded = { key, subject, purpose: "marketing_sms", basis: "consent", granted: input.granted, source: "reply", evidence: { wording: input.wording }, recordedAt: input.recordedAt, recordedBy: PLUGIN_ID };
  try {
    await ctx.events.emit(HANDOFF_EVENTS.consentRecorded, companyId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("consent.recorded emit failed", { error: message(error) });
  }
}

/**
 * Someone opted out of SMS or WhatsApp from a sender (they texted STOP, the
 * provider blocked them, or a person said so). The number goes on that sender's
 * list, the sender's running campaigns stop for every contact that has the number,
 * and their open step issues are cancelled. SMS opt-outs are announced as a
 * withdrawn consent so the CRM can keep the record.
 */
export async function optOutChannel(
  ctx: PluginContext,
  input: { companyId: string; channel: MessagingChannel; address: string; senderKey: string; reason: ChannelSuppressionReason; source: string; contactIds: string[]; campaignId?: string | null; announce?: boolean; wording?: string },
): Promise<{ created: boolean; stopped: number; cancelledIssues: number }> {
  const created = await addChannelSuppression(ctx, {
    companyId: input.companyId,
    channel: input.channel,
    address: input.address,
    senderKey: input.senderKey,
    reason: input.reason,
    scope: input.reason === "invalid_number" ? "all" : "marketing",
    source: input.source,
    contactId: input.contactIds[0] ?? null,
    campaignId: input.campaignId ?? null,
  });
  let stopped = 0;
  let cancelledIssues = 0;
  for (const contactId of new Set(input.contactIds)) {
    for (const row of await stopEnrollmentsForSender(ctx, input.companyId, contactId, input.reason === "invalid_number" ? "" : input.senderKey)) {
      stopped += 1;
      if (row.open_issue_id && (await cancelStepIssue(ctx, input.companyId, row.open_issue_id, maskPhone(input.address), "stopped"))) cancelledIssues += 1;
    }
  }
  if (input.channel === "sms" && input.announce !== false && input.reason !== "invalid_number") {
    await announceConsent(ctx, input.companyId, { phone: input.address, contactId: input.contactIds[0] ?? null, granted: false, wording: input.wording ?? "opted out", recordedAt: new Date().toISOString(), senderKey: input.senderKey });
  }
  return { created, stopped, cancelledIssues };
}

/** START or UNSTOP: lifts the person's own opt-out and records a fresh opt-in. A number a person blocked by hand stays blocked. */
export async function optInChannel(
  ctx: PluginContext,
  input: { companyId: string; channel: MessagingChannel; address: string; senderKey: string; contactId?: string | null; recordedAt?: string; evidence: string },
): Promise<{ lifted: number }> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const lifted = await liftChannelSuppression(ctx, input.companyId, input.channel, input.address, input.senderKey);
  await upsertConsent(ctx, { companyId: input.companyId, channel: input.channel, address: input.address, senderKey: input.senderKey, granted: true, basis: "consent", source: "reply", evidence: input.evidence, contactId: input.contactId ?? null, recordedAt, recordedBy: PLUGIN_ID });
  if (input.channel === "sms") await announceConsent(ctx, input.companyId, { phone: input.address, contactId: input.contactId ?? null, granted: true, wording: "opted in again", recordedAt, senderKey: input.senderKey });
  return { lifted };
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

/** The step is not for this contact (no number, no opt-in): it is recorded as skipped and they move on. */
async function skipStep(ctx: PluginContext, input: { enrollment: EnrollmentDraft; steps: CampaignStepDraft[]; step: CampaignStepDraft }, why: string): Promise<"skipped"> {
  const { enrollment, step } = input;
  await insertStepEventOnce(ctx, {
    companyId: enrollment.companyId,
    campaignId: enrollment.campaignId,
    enrollmentId: enrollment.id,
    stepPosition: step.position,
    eventType: "skipped",
    variant: step.variant,
    sourceKey: `skipped:${campaignMessageKey(enrollment.id, step.position)}`,
    meta: { channel: stepChannel(step), why },
  });
  await saveEnrollment(ctx, advanceEnrollment({ ...enrollment, sendingKey: null }, input.steps, new Date()));
  return "skipped";
}

async function stopEnrollmentHere(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<"stopped"> {
  await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null, sendingKey: null });
  return "stopped";
}

/** The text a recipient gets, and the template variables for a WhatsApp first message. */
export function composeMessage(step: CampaignStepDraft, vars: Parameters<typeof personalize>[1]): { text: string; template: OutboundMessage["template"] } {
  const text = personalize(step.body, vars);
  if (stepChannel(step) === "whatsapp" && step.templateRef) {
    const values: Record<string, string> = {};
    (step.templateVars ?? []).forEach((token, index) => {
      values[String(index + 1)] = personalize(token, vars);
    });
    return { text, template: { ref: step.templateRef, vars: values } };
  }
  return { text: withOptOutLine(text), template: null };
}

/** What is wrong with a composed message's length, or null. */
export function messageLengthProblem(channel: MessagingChannel, text: string, template: boolean): string | null {
  if (channel === "sms") return text.length > SMS_MAX_CHARS ? `The SMS is ${text.length} characters; the provider refuses more than ${SMS_MAX_CHARS}.` : null;
  const max = template ? WHATSAPP_TEMPLATE_MAX : WHATSAPP_SESSION_MAX;
  return text.length > max ? `The WhatsApp message is ${text.length} characters; the limit is ${max}.` : null;
}

export interface MessagingStepInput {
  campaign: CampaignDraft;
  enrollment: EnrollmentDraft;
  step: CampaignStepDraft;
  steps: CampaignStepDraft[];
  setup?: MessagingSetup;
  now?: Date;
}

/**
 * Sends one due SMS or WhatsApp step. Returns what happened to the enrollment:
 * `sent` (moved on), `stopped` (opted out), `skipped` (not for this contact, moved
 * on), `deferred` (waiting for the send window or a retry), `held` (the channel or
 * sender is not set up: nothing is sent and the Cockpit says so) or `issue` (a
 * person was handed the step).
 */
export async function sendMessagingStep(ctx: PluginContext, input: MessagingStepInput): Promise<MessagingStepResult> {
  const { campaign, enrollment, step, steps } = input;
  const channel = stepChannel(step);
  if (channel === "email") throw new Error("sendMessagingStep is for SMS and WhatsApp steps");
  const companyId = enrollment.companyId;
  const now = input.now ?? new Date();
  const setup = input.setup ?? (await messagingSetup(ctx, companyId));
  const readiness = readinessOf(setup, channel);
  if (!readiness.ready || !setup.provider) {
    if (firstHeldLog(`${campaign.id}:${channel}:not-ready`)) ctx.logger.warn("Campaign message held: channel not ready", { campaignId: campaign.id, channel, reason: readiness.reason });
    return "held";
  }
  const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId);
  const phone = campaignPhone(contact?.phones, setup.config.defaultCountry);
  if (!contact || !phone) return skipStep(ctx, { enrollment, steps, step }, "no mobile number on the contact");
  const sender = await resolveMessageSender(ctx, companyId, campaign, channel, setup);
  if (!sender.ok) {
    if (firstHeldLog(`${campaign.id}:${channel}:no-number`)) ctx.logger.warn("Campaign message held: no sender number", { campaignId: campaign.id, channel, senderKey: sender.senderKey });
    return "held";
  }
  const senderKey = sender.senderKey;
  if ((await blockedAddresses(ctx, companyId, channel, [phone], senderKey)).has(phone)) return stopEnrollmentHere(ctx, enrollment);
  if (!(await consentedAddresses(ctx, companyId, channel, [phone], senderKey)).has(phone)) return skipStep(ctx, { enrollment, steps, step }, "no opt-in on record for this sender");

  if (!isInSendWindow(now, setup.config.timezone, setup.config.windows)) {
    const open = nextSendWindow(now, setup.config.timezone, setup.config.windows);
    if (!open) {
      if (firstHeldLog(`${campaign.id}:${channel}:no-window`)) ctx.logger.warn("Campaign message held: the send windows never open", { campaignId: campaign.id });
      return "held";
    }
    await pushEnrollmentDue(ctx, enrollment.id, open.toISOString());
    return "deferred";
  }

  // A provider that keeps failing is left alone for a while: the step stays due and goes out when it answers again.
  if (providerPaused(companyId, now.getTime())) {
    if (firstHeldLog(`${companyId}:provider-paused`, now.getTime())) ctx.logger.warn("Messaging provider paused after repeated failures; due messages wait", { companyId });
    return "deferred";
  }
  const vars = await personalVars(ctx, companyId, campaign, contact);
  const composed = composeMessage(step, vars);
  const key = campaignMessageKey(enrollment.id, step.position);
  const tooLong = messageLengthProblem(channel, composed.text, Boolean(composed.template));
  if (tooLong) {
    await failStep(ctx, enrollment, steps, tooLong);
    return "issue";
  }
  if (channel === "whatsapp" && !composed.template) {
    // The first message to a person must be an approved template; a free-form one is refused once the 24 hour window is shut.
    ctx.logger.info("WhatsApp step has no template; it can only reach people who wrote to us in the last 24 hours", { campaignId: campaign.id });
  }
  const segments = channel === "sms" ? smsLength(composed.text).segments : null;
  const created = await claimMessage(ctx, { key, company_id: companyId, campaign_id: campaign.id, enrollment_id: enrollment.id, step_position: step.position, channel, to_address: phone, contact_id: contact.id, sender_key: senderKey, body: composed.text.slice(0, 1600), segments });
  if (!created) {
    const row = await getMessage(ctx, key);
    if (row) {
      const settled = await settleExisting(ctx, { ...input, row });
      if (settled) return settled;
      await updateMessage(ctx, key, { status: "sending", attempts: row.attempts + 1 });
    }
  }
  let outcome: SendOutcome;
  try {
    outcome = await setup.provider.send({ channel, to: phone, from: sender.from, body: composed.text, template: composed.template, reference: key });
  } catch (error) {
    outcome = { ok: false, kind: "unknown", code: null, error: message(error) };
  }
  // Failures that say nothing about this person (no answer, a refused account, a rate limit) count towards pausing the provider.
  const healthy = outcome.ok || outcome.kind === "rejected";
  if (recordProviderResult(companyId, healthy, now.getTime())) ctx.logger.warn("Messaging provider paused for ten minutes after repeated failures", { companyId, channel, code: outcome.ok ? null : outcome.code });
  return applyOutcome(ctx, { ...input, key, outcome, phone, senderKey, contact: { id: contact.id }, segments });
}

/** A step attempted before: finish what it already says, or return null to try again (a retry that was waiting). */
async function settleExisting(ctx: PluginContext, input: MessagingStepInput & { row: ChannelMessageRow }): Promise<MessagingStepResult | null> {
  const { row, enrollment, step, steps } = input;
  if (row.status === "sent" || row.status === "delivered") {
    await recordSent(ctx, { enrollment, step, steps, row });
    return "sent";
  }
  if (row.status === "pending") return null;
  // sending (a crash between the claim and the answer), unknown or failed: never sent again by itself.
  if (row.status === "sending") await updateMessage(ctx, row.key, { status: "unknown", error: "The plugin stopped before the provider answered; it may or may not have been sent." });
  await failStep(ctx, enrollment, steps, row.error ?? "The provider's answer was not recorded; it may or may not have been sent.");
  return "issue";
}

async function recordSent(ctx: PluginContext, input: { enrollment: EnrollmentDraft; step: CampaignStepDraft; steps: CampaignStepDraft[]; row: Pick<ChannelMessageRow, "key" | "channel" | "provider_id" | "to_address" | "segments"> }): Promise<void> {
  const { enrollment, step, row } = input;
  await insertStepEventOnce(ctx, {
    companyId: enrollment.companyId,
    campaignId: enrollment.campaignId,
    enrollmentId: enrollment.id,
    stepPosition: step.position,
    eventType: "sent",
    variant: step.variant,
    sourceKey: `sent:${row.key}`,
    meta: { channel: row.channel, to: maskPhone(row.to_address), providerId: row.provider_id, segments: row.segments, key: row.key },
  });
  // Only a running enrollment moves on; a stopped one stays stopped.
  if (enrollment.status === "running") await saveEnrollment(ctx, advanceEnrollment({ ...enrollment, sendingKey: null }, input.steps, new Date()));
}

async function applyOutcome(
  ctx: PluginContext,
  input: MessagingStepInput & { key: string; outcome: SendOutcome; phone: string; senderKey: string; contact: { id: string }; segments: number | null },
): Promise<MessagingStepResult> {
  const { key, outcome, enrollment, step, steps, campaign, phone, senderKey } = input;
  const channel = stepChannel(step) as MessagingChannel;
  if (outcome.ok) {
    await updateMessage(ctx, key, { status: "sent", provider_id: outcome.providerId, provider_status: outcome.status, segments: outcome.segments ?? input.segments, error: null, error_code: null });
    await recordSent(ctx, { enrollment, step, steps, row: { key, channel, provider_id: outcome.providerId, to_address: phone, segments: outcome.segments ?? input.segments } });
    return "sent";
  }
  const row = await getMessage(ctx, key);
  const attempts = row?.attempts ?? 1;
  const base = { error_code: outcome.code, error: outcome.error };
  if (outcome.optedOut) {
    await updateMessage(ctx, key, { status: "failed", ...base });
    await optOutChannel(ctx, { companyId: enrollment.companyId, channel, address: phone, senderKey, reason: "provider_opt_out", source: PLUGIN_ID, contactIds: [input.contact.id], campaignId: campaign.id, wording: "blocked at the provider after STOP" });
    return "stopped";
  }
  if (outcome.kind === "config") {
    // The account or sender is wrong for every message: nothing is lost, the step stays due and the Cockpit goes red.
    await updateMessage(ctx, key, { status: "pending", ...base });
    if (firstHeldLog(`${campaign.id}:${channel}:refused`)) ctx.logger.warn("Campaign message held: the provider refused the account or sender", { campaignId: campaign.id, channel, code: outcome.code });
    return "held";
  }
  if (outcome.kind === "retry" && attempts < MESSAGE_MAX_ATTEMPTS) {
    await updateMessage(ctx, key, { status: "pending", ...base });
    await pushEnrollmentDue(ctx, enrollment.id, new Date(Date.now() + RETRY_MINUTES * 60_000).toISOString());
    return "deferred";
  }
  if (outcome.kind === "unknown") {
    await updateMessage(ctx, key, { status: "unknown", ...base });
    await failStep(ctx, enrollment, steps, `${outcome.error} It may or may not have been sent: check the provider's log before doing anything.`);
    return "issue";
  }
  await updateMessage(ctx, key, { status: "failed", ...base });
  if (outcome.invalidRecipient) {
    await addChannelSuppression(ctx, { companyId: enrollment.companyId, channel, address: phone, senderKey, reason: "invalid_number", scope: "all", source: PLUGIN_ID, contactId: input.contact.id, campaignId: campaign.id });
  }
  const advice = outcome.needsTemplate
    ? " WhatsApp only lets a free-form message reach someone who wrote to us in the last 24 hours. Give this step an approved template (add-campaign-step with templateRef, from the Twilio Content Template Builder)."
    : outcome.invalidRecipient ? " The number was put on the do-not-message list so nothing else tries it; correct it on the contact in the CRM." : "";
  await failStep(ctx, enrollment, steps, `${outcome.error}${outcome.code ? ` (provider code ${outcome.code})` : ""}.${advice}`);
  return "issue";
}
