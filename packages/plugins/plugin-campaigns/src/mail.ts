/**
 * Campaigns and the Mailbox.
 *
 * - An active email campaign sends each due step through the kit outbox
 *   (`mail.send.requested`, key `campaigns:step:<enrollmentId>:<position>`,
 *   context kind `campaign_step`). `mail.send.result` records a `sent` step
 *   event (per variant) and moves the contact on; a permanent failure opens
 *   an issue. The `redeliver-mail` job re-emits unanswered requests.
 * - `mail.received` from a contact we emailed records a `reply`, `bounce` or
 *   `unsubscribe` step event and, with Jev, acts on it: stop, suppress, push
 *   or open an issue for the campaign's agent (else the Account Manager).
 * - Campaign email is marketing (`marketing: true`): the Mailbox skips
 *   suppressed addresses and adds List-Unsubscribe. An unsubscribe reply is
 *   announced as `contact.suppressed` so the CRM and the Mailbox stop too.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  createWorkIssue,
  decide,
  enqueue,
  PIB_PLUGINS,
  isModuleEnabled,
  outboxStatus,
  getCrmCompany,
  getCrmContact,
  mailSenderFields,
  MAIL_EVENTS,
  receiveOnce,
  redeliver,
  settleOutbox,
  shouldAct,
  type MailReceived,
  type MailSendRequested,
  type MailSendResult,
  type OutboxRow,
  type SuppressionReason,
} from "@partnersinbiz/pib-plugin-kit";
import {
  abEvents,
  crmContactsByEmail,
  enrollmentById,
  enrollmentsForContacts,
  enrollmentsWithFailedSend,
  getCampaign,
  insertStepEventOnce,
  isSuppressed,
  latestSends,
  listSteps,
  markDecisionActed,
  noteOutboxError,
  pushEnrollmentDue,
  saveEnrollment,
  stopEnrollment,
  stopEnrollmentsForSender,
  type SentEvent,
} from "./db.js";
import {
  abSuggestion,
  advanceEnrollment,
  campaignAddress,
  campaignMailKey,
  campaignSenderKey,
  campaignSuppressionReason,
  campaignReplyPlan,
  clientPrefix,
  isReplyKind,
  personalize,
  pushDate,
  REPLY_KIND_LABELS,
  stepChannel,
  stepFor,
  textToHtml,
  type AbSuggestion,
  type CampaignDraft,
  type CampaignStepDraft,
  type EnrollmentDraft,
  type PersonalVars,
  type ReplyKind,
} from "./domain.js";
import { CHANNEL_LABELS } from "./channels.js";
import { jevConfigFor, REPLY_QUESTIONS, replyState } from "./jev.js";
import { appendHtmlFooter, emailFooter, unsubscribeLinks } from "./links.js";
import { firstHeldLog } from "./messaging.js";
import { PLUGIN_ID } from "./namespace.js";
import { replyOrigin, sendFailedOrigin } from "./origins.js";
import { assigneeFields, workOwner } from "./owner.js";
import { projectForCampaign } from "./projects.js";
import { resolveEmailSender, senderDisplayName, type EmailSender } from "./sender.js";
import { announceSuppression, suppressAddress, suppressionPayload } from "./suppress.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Campaign work goes to the campaign's agent while it runs, else the Account Manager (then the Operator, then the owner). */
export async function campaignAssignee(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "ownerAgentId"> | null): Promise<{ assigneeAgentId?: string; assigneeUserId?: string }> {
  return assigneeFields(await workOwner(ctx, companyId, campaign ?? { ownerAgentId: null }));
}

export async function openIssueOnce(
  ctx: PluginContext,
  input: { companyId: string; originId: string; title: string; description: string; assignee: { assigneeAgentId?: string; assigneeUserId?: string }; wakeReason: string; projectId?: string },
): Promise<string> {
  try {
    const existing = await ctx.issues.list({ companyId: input.companyId, originKind: ORIGIN, originId: input.originId, limit: 1 });
    if (existing[0]) return existing[0].id;
  } catch {
    // best effort
  }
  const issue = await createWorkIssue(ctx, {
    companyId: input.companyId,
    title: input.title.slice(0, 200),
    description: input.description,
    originKind: ORIGIN,
    originId: input.originId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...input.assignee,
    wakeReason: input.wakeReason,
  });
  return issue.id;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Merge values for a contact: name, first and last name, email, and their company (or the client company). */
export async function personalVars(
  ctx: PluginContext,
  companyId: string,
  campaign: Pick<CampaignDraft, "clientKind" | "clientName"> | null,
  contact: { name: string; emails?: string[] | null; account_ids?: string[] | null } | null,
): Promise<PersonalVars> {
  if (!contact) return { name: "" };
  const accountId = contact.account_ids?.[0];
  const company = accountId ? (await getCrmCompany(ctx, ctx.db.namespace, companyId, accountId).catch(() => null))?.name ?? null : null;
  return { name: contact.name, email: campaignAddress(contact.emails), company: company ?? (campaign?.clientKind === "company" ? campaign.clientName : null) };
}

/** A step with its subject and body filled in for one contact. */
export function personalStep(step: CampaignStepDraft, vars: PersonalVars): CampaignStepDraft {
  return { ...step, subject: personalize(step.subject, vars), body: personalize(step.body, vars) };
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
  /** The page a person unsubscribes on, or null when none can be built yet. */
  landing: string | null;
  /** The RFC 8058 address, or null while no front-door rule is saved. */
  oneClick: string | null;
}

/**
 * The email a contact receives for a step: subject and body with their name
 * filled in, and the footer that says who sent it and how to stop (plus the
 * unsubscribe link, when one can be built). The same text the approver previews.
 */
export async function composeEmail(
  ctx: PluginContext,
  input: { companyId: string; step: CampaignStepDraft; contact: { name: string; emails?: string[] | null; account_ids?: string[] | null } | null; email: string; senderKey: string; senderName: string; campaign: CampaignDraft },
): Promise<ComposedEmail> {
  const { step } = input;
  const links = await unsubscribeLinks(ctx, input.companyId, { email: input.email, senderKey: input.senderKey });
  const vars = { ...(await personalVars(ctx, input.companyId, input.campaign, input.contact)), unsubscribeUrl: links.landing };
  const bodyText = personalize(step.body, vars);
  const footer = emailFooter({ senderName: input.senderName, link: links.landing });
  const text = `${bodyText}${footer.text}`;
  const html = step.htmlBody
    ? appendHtmlFooter(personalize(step.htmlBody, vars), footer.html)
    : `${textToHtml(bodyText)}\n${footer.html}`;
  return { subject: personalize(step.subject, vars), text, html, landing: links.landing, oneClick: links.oneClick };
}

export interface HandSentEmail {
  subject: string;
  /** The text to send as written: the body for this contact and the footer that says who we are and how to opt out. */
  text: string;
  /** This person's unsubscribe link, or null when none can be built (the footer then says reply STOP only). */
  link: string | null;
}

/**
 * The email an agent sends by hand: a step issue (delivery `issue`) or a step whose
 * automatic send failed. It is the same text an automatic send carries, footer and
 * personal unsubscribe link included, so an email sent by hand also says who we are
 * and how to opt out (POPIA, CPA). Never throws: without an address to sign a link
 * for, or when the link cannot be built, the footer says reply STOP only.
 */
export async function handSentEmail(
  ctx: PluginContext,
  input: { companyId: string; campaign: CampaignDraft | null; step: CampaignStepDraft; contact: { name: string; emails?: string[] | null; account_ids?: string[] | null } | null },
): Promise<HandSentEmail> {
  const { companyId, campaign, step, contact } = input;
  const senderName = await senderDisplayName(ctx, companyId, campaign);
  const to = campaignAddress(contact?.emails);
  if (campaign && to) {
    try {
      const composed = await composeEmail(ctx, { companyId, step, contact, email: to, senderKey: campaignSenderKey(campaign), senderName, campaign });
      return { subject: composed.subject, text: composed.text, link: composed.landing };
    } catch (error) {
      ctx.logger.info("The unsubscribe link could not be built for a hand-sent email; the footer says reply STOP only", { error: message(error) });
    }
  }
  const vars = await personalVars(ctx, companyId, campaign, contact);
  return { subject: personalize(step.subject, vars), text: `${personalize(step.body, vars)}${emailFooter({ senderName, link: null }).text}`, link: null };
}

/**
 * Sends one due step of an active email campaign. A suppressed address stops
 * the enrollment; a contact without an address gets the usual step issue; a
 * campaign with no sender (a client without a connected mailbox) sends nothing
 * and says so (`held`): its email must never go out as PiB.
 */
export async function sendCampaignStep(
  ctx: PluginContext,
  input: { campaign: CampaignDraft; enrollment: EnrollmentDraft; step: CampaignStepDraft; issueFallback: (note: string) => Promise<void>; sender?: EmailSender },
): Promise<"sent" | "stopped" | "issue" | "held"> {
  const { campaign, enrollment, step } = input;
  const contact = await getCrmContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
  const to = campaignAddress(contact?.emails);
  if (!contact || !to) {
    await input.issueFallback("This contact has no email address in the CRM, so the step was not emailed. Reach them another way, then mark this issue done.");
    return "issue";
  }
  const sender = input.sender ?? (await resolveEmailSender(ctx, enrollment.companyId, campaign));
  if (!sender.ok) {
    if (firstHeldLog(`${campaign.id}:email:no-sender`)) ctx.logger.warn("Campaign email held: no sender", { campaignId: campaign.id, senderKey: sender.senderKey });
    return "held";
  }
  if (await isSuppressed(ctx, enrollment.companyId, to, sender.senderKey)) {
    await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null });
    return "stopped";
  }
  const composed = await composeEmail(ctx, { companyId: enrollment.companyId, step, contact, email: to, senderKey: sender.senderKey, senderName: sender.fromName, campaign });
  const key = campaignMailKey(enrollment.id, step.position);
  const payload: MailSendRequested = {
    key,
    ...mailSenderFields({ senderKey: sender.senderKey, fromAddress: sender.identity?.fromAddress ?? "", fromName: sender.fromName, replyTo: sender.replyTo }, { unsubscribeUrl: composed.oneClick }),
    to: [{ email: to, name: contact.name }],
    subject: composed.subject,
    text: composed.text,
    html: composed.html,
    threadId: enrollment.mailThreadId ?? null,
    inReplyToMessageId: enrollment.mailLastMessageId ?? null,
    context: {
      plugin: PLUGIN_ID,
      kind: "campaign_step",
      id: enrollment.id,
      clientKind: campaign.clientRef ? campaign.clientKind : null,
      clientRef: campaign.clientRef,
    },
    labels: ["PiB/Campaigns"],
    // Marketing: the Mailbox skips suppressed addresses and adds List-Unsubscribe.
    marketing: true,
  };
  const { created } = await enqueue(ctx, enrollment.companyId, MAIL_EVENTS.sendRequested, payload as unknown as { key: string } & Record<string, unknown>);
  await saveEnrollment(ctx, { ...enrollment, sendingKey: key });
  if (!created) {
    // Requested before and already answered: apply the stored answer instead of waiting forever.
    const existing = await outboxStatus(ctx, key);
    if (existing && existing.status !== "pending") {
      const stored = (existing.result ?? null) as MailSendResult | null;
      await applySendResult(ctx, existing, stored ?? { key, status: "failed", permanent: true, error: existing.last_error ?? "Send failed", context: payload.context });
    }
  }
  return "sent";
}

/** Addresses the Mailbox refused as suppressed (`suppressed` on its failed result). */
export function suppressedFromResult(result: MailSendResult): Array<{ email: string; reason: SuppressionReason; scope: "marketing" | "all" }> {
  const list = (result as MailSendResult & { suppressed?: unknown }).suppressed;
  if (!Array.isArray(list)) return [];
  const out: Array<{ email: string; reason: SuppressionReason; scope: "marketing" | "all" }> = [];
  for (const item of list) {
    const entry = record(item);
    if (typeof entry.email !== "string" || !entry.email.includes("@")) continue;
    const reason = (["unsubscribed", "bounced", "complained", "manual"] as const).find((r) => r === entry.reason) ?? "manual";
    out.push({ email: entry.email.toLowerCase(), reason, scope: entry.scope === "all" ? "all" : "marketing" });
  }
  return out;
}

function asSendResult(payload: unknown): MailSendResult | null {
  const body = record(payload);
  if (typeof body.key !== "string" || !body.key.startsWith("campaigns:step:")) return null;
  const context = record(body.context);
  if (context.plugin !== undefined && context.plugin !== PLUGIN_ID) return null;
  if (body.status !== "sent" && body.status !== "failed") return null;
  return body as unknown as MailSendResult;
}

export async function onSendResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const result = asSendResult(event.payload);
  if (!result) return;
  try {
    await handleSendResult(ctx, result);
  } catch (error) {
    ctx.logger.error("Campaign send result failed", { key: result.key, error: message(error) });
  }
}

export async function handleSendResult(ctx: PluginContext, result: MailSendResult): Promise<"advanced" | "failed" | "retrying" | "ignored"> {
  if (result.status === "failed" && !result.permanent) {
    await noteOutboxError(ctx, result.key, result.error ?? "Send failed; will retry");
    return "retrying";
  }
  const row = await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, result.status === "sent" ? "done" : "failed");
  if (!row) return "ignored";
  return applySendResult(ctx, row, result);
}

async function applySendResult(ctx: PluginContext, row: OutboxRow, result: MailSendResult): Promise<"advanced" | "failed" | "ignored"> {
  const match = /^campaigns:step:(.+):(\d+)$/.exec(result.key);
  const enrollmentId = (typeof result.context?.id === "string" && result.context.id) || match?.[1] || null;
  const enrollment = enrollmentId ? await enrollmentById(ctx, enrollmentId) : null;
  if (!enrollment || enrollment.companyId !== row.company_id || enrollment.sendingKey !== result.key) return "ignored";
  const steps = await listSteps(ctx, enrollment.campaignId);

  if (result.status === "failed") {
    // A reply may have stopped the enrollment meanwhile: then nobody needs to send it.
    if (enrollment.status !== "running") {
      await saveEnrollment(ctx, { ...enrollment, sendingKey: null });
      return "ignored";
    }
    // The Mailbox refused because the address is on its do-not-email list: stop, never hand it to a person to send.
    const blocked = suppressedFromResult(result);
    if (blocked.length > 0) {
      const sentFrom = await getCampaign(ctx, enrollment.campaignId);
      for (const entry of blocked) {
        // The Mailbox refused this campaign's send: on this campaign's sender's list, or on every one for a hard bounce.
        await suppressAddress(ctx, { companyId: enrollment.companyId, email: entry.email, reason: campaignSuppressionReason(entry.reason), scope: entry.scope, source: PIB_PLUGINS.mailbox, contactId: enrollment.contactId, senderKey: sentFrom ? campaignSenderKey(sentFrom) : "" });
      }
      await saveEnrollment(ctx, { ...enrollment, sendingKey: null, status: "stopped", nextDueAt: null });
      return "failed";
    }
    await failStep(ctx, enrollment, steps, result.error ?? "The Mailbox could not send it");
    return "failed";
  }

  const sentStep = stepFor(steps, enrollment.stepPosition, enrollment.variant);
  const payload = record(row.payload);
  const to = Array.isArray(payload.to) ? record(payload.to[0]).email : null;
  await insertStepEventOnce(ctx, {
    companyId: enrollment.companyId,
    campaignId: enrollment.campaignId,
    enrollmentId: enrollment.id,
    stepPosition: enrollment.stepPosition,
    eventType: "sent",
    variant: sentStep?.variant ?? "a",
    sourceKey: `sent:${result.key}`,
    meta: { to: typeof to === "string" ? to : null, messageId: result.messageId ?? null, threadId: result.threadId ?? null, key: result.key },
  });
  const sentEnrollment: EnrollmentDraft = {
    ...enrollment,
    sendingKey: null,
    mailThreadId: result.threadId ?? enrollment.mailThreadId ?? null,
    mailLastMessageId: result.messageId ?? enrollment.mailLastMessageId ?? null,
  };
  // Only a running enrollment moves on; a stopped one stays stopped.
  await saveEnrollment(ctx, enrollment.status === "running" ? advanceEnrollment(sentEnrollment, steps, new Date()) : sentEnrollment);
  return "advanced";
}

/**
 * The step could not be sent: a person sends it (email) or looks into it (SMS and
 * WhatsApp, which nobody can send by hand); marking the issue done moves the
 * contact on, cancelling it stops the campaign for them.
 */
export async function failStep(ctx: PluginContext, enrollment: EnrollmentDraft, steps: CampaignStepDraft[], error: string): Promise<void> {
  const [campaign, contact] = await Promise.all([
    getCampaign(ctx, enrollment.campaignId),
    getCrmContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId).catch(() => null),
  ]);
  const raw = stepFor(steps, enrollment.stepPosition, enrollment.variant);
  const step = raw ? personalStep(raw, await personalVars(ctx, enrollment.companyId, campaign, contact)) : null;
  const name = contact?.name ?? enrollment.contactId;
  const channel = raw ? stepChannel(raw) : "email";
  // The email a person will send by hand carries the footer and this contact's unsubscribe link, like an automatic one.
  const hand = raw && channel === "email" ? await handSentEmail(ctx, { companyId: enrollment.companyId, campaign, step: raw, contact }) : null;
  const to = channel === "email"
    ? (contact?.emails?.[0] ? `\n\nSend to: ${name} <${contact.emails[0]}>` : "")
    : `\n\nContact: ${name}`;
  const what = channel === "email" ? "Email" : CHANNEL_LABELS[channel];
  const issueId = await openIssueOnce(ctx, {
    companyId: enrollment.companyId,
    originId: sendFailedOrigin(enrollment.id, enrollment.stepPosition),
    title: `${clientPrefix(campaign?.clientRef ? campaign.clientName : null)}${what} not sent: ${step?.subject || (channel === "email" ? "Campaign step" : `${what} step ${enrollment.stepPosition}`)}: ${name}`,
    description: (channel === "email"
      ? [
        `The Mailbox could not send this campaign email to \`contact:${enrollment.contactId}\`: ${error}`,
        "",
        "Fix the cause if you can (reconnect Gmail on the Mailbox page, or correct the address on the contact in the CRM), then send it: draft it with `partnersinbiz.mailbox:create-draft` and send it with `send-draft`, or send it from Gmail. Send the text below as written, including the last lines that say who we are and how to unsubscribe: never cut them. Mark this issue **done** to move the contact to the next step, or **cancelled** to stop the campaign for them.",
        "",
        `**Subject:** ${hand?.subject ?? step?.subject ?? ""}`,
        "",
        hand?.text ?? step?.body ?? "",
      ]
      : [
        `The ${what} message of this campaign step could not be sent to \`contact:${enrollment.contactId}\`: ${error}`,
        "",
        `${what} is sent by the plugin, not by hand, and it never repeats a send whose result is unknown: if the provider's log (Twilio console, Monitor, Logs, Messaging) shows it was sent, nothing more is needed. Otherwise fix the cause (the number on the contact in the CRM, or the sender in the Campaigns settings). Mark this issue **done** to move the contact to the next step, or **cancelled** to stop the campaign for them.`,
        "",
        step?.body ?? "",
      ]
    ).join("\n") + to,
    assignee: await campaignAssignee(ctx, enrollment.companyId, campaign),
    wakeReason: "A campaign message failed",
    projectId: await projectForCampaign(ctx, enrollment.companyId, campaign),
  });
  await saveEnrollment(ctx, { ...enrollment, sendingKey: null, openIssueId: issueId });
}

/** Job: re-emit unanswered requests, then hand exhausted ones to a person. */
export async function redeliverMail(ctx: PluginContext): Promise<{ emitted: number; failed: number; handedOver: number }> {
  const counts = await redeliver(ctx);
  let handedOver = 0;
  for (const enrollment of await enrollmentsWithFailedSend(ctx)) {
    try {
      if (!(await configSaved(ctx, enrollment.companyId))) continue;
      if (!(await isModuleEnabled(ctx, enrollment.companyId, PLUGIN_ID))) continue;
      await failStep(ctx, enrollment, await listSteps(ctx, enrollment.campaignId), enrollment.lastError ?? "No answer from the Mailbox");
      handedOver += 1;
    } catch (error) {
      ctx.logger.error("Campaign failed-send handover failed", { enrollmentId: enrollment.id, error: message(error) });
    }
  }
  return { ...counts, handedOver };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

function asMailReceived(payload: unknown): MailReceived | null {
  const body = record(payload);
  const from = record(body.from);
  if (typeof body.messageId !== "string" || !body.messageId) return null;
  if (typeof from.email !== "string" || !from.email.includes("@")) return null;
  return {
    ...(body as unknown as MailReceived),
    key: typeof body.key === "string" && body.key ? body.key : `mail:${body.messageId}`,
    subject: typeof body.subject === "string" ? body.subject : "",
    snippet: typeof body.snippet === "string" ? body.snippet : "",
    threadId: typeof body.threadId === "string" ? body.threadId : "",
    from: { email: from.email, name: typeof from.name === "string" ? from.name : null },
    replyTo: body.replyTo && typeof body.replyTo === "object" ? (body.replyTo as MailReceived["replyTo"]) : null,
  };
}

/**
 * The enrollment a message replies to: the send context when the Mailbox
 * linked it, else the sender's CRM contact's most recently emailed
 * enrollment, else that contact's newest running one.
 */
export async function matchEnrollment(ctx: PluginContext, companyId: string, mail: MailReceived): Promise<{ enrollment: EnrollmentDraft; sent: SentEvent | null } | null> {
  const context = mail.replyTo;
  if (context?.plugin === PLUGIN_ID && context.kind === "campaign_step" && context.id) {
    const enrollment = await enrollmentById(ctx, context.id);
    if (enrollment && enrollment.companyId === companyId) {
      const [sent] = await latestSends(ctx, companyId, [enrollment.id]);
      return { enrollment, sent: sent ?? null };
    }
  }
  const contacts = await crmContactsByEmail(ctx, companyId, mail.from.email);
  if (contacts.length === 0) return null;
  const enrollments = await enrollmentsForContacts(ctx, companyId, contacts.map((contact) => contact.id));
  if (enrollments.length === 0) return null;
  const sends = await latestSends(ctx, companyId, enrollments.map((row) => row.id));
  if (sends[0]) {
    const enrollment = enrollments.find((row) => row.id === sends[0]!.enrollmentId)!;
    return { enrollment, sent: sends[0] };
  }
  const running = enrollments.find((row) => row.status === "running");
  return running ? { enrollment: running, sent: null } : null;
}

export async function onMailReceived(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const mail = asMailReceived(event.payload);
  if (!mail || !event.companyId) return;
  try {
    await receiveOnce(ctx, event.companyId, MAIL_EVENTS.received, mail.key, () => handleReply(ctx, event.companyId, mail));
  } catch (error) {
    ctx.logger.error("Campaign reply handling failed", { messageId: mail.messageId, error: message(error) });
  }
}

export interface CampaignReplyOutcome extends Record<string, unknown> {
  matched: boolean;
  enrollmentId?: string;
  campaignId?: string;
  kind?: ReplyKind | null;
  confidence?: number | null;
  acted?: boolean;
  event?: string | null;
  issueId?: string | null;
}

function pct(value: number | null): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

export async function handleReply(ctx: PluginContext, companyId: string, mail: MailReceived): Promise<CampaignReplyOutcome> {
  const matched = await matchEnrollment(ctx, companyId, mail);
  if (!matched) return { matched: false };
  const { enrollment, sent } = matched;
  const campaign = await getCampaign(ctx, enrollment.campaignId);
  if (!campaign || campaign.companyId !== companyId) return { matched: false };

  const config = await jevConfigFor(ctx, companyId);
  const decision = config
    ? await decide(ctx, companyId, {
      config,
      purpose: "campaigns.reply",
      subject: { kind: "email", id: mail.messageId },
      state: replyState(mail),
      questions: REPLY_QUESTIONS,
    })
    : null;
  const answer = decision?.answers.reply_kind;
  const kind = answer && answer.type === "choice" && isReplyKind(answer.choice) ? answer.choice : null;
  const confidence = answer && answer.type === "choice" ? answer.confidence : null;
  const confident = Boolean(kind && shouldAct(answer, "update"));
  const plan = campaignReplyPlan(kind, confident);
  if (confident && decision?.ids.reply_kind) await markDecisionActed(ctx, decision.ids.reply_kind).catch(() => undefined);

  const stepPosition = sent?.stepPosition ?? enrollment.stepPosition;
  const variant = sent?.variant ?? enrollment.variant;
  if (plan.event) {
    await insertStepEventOnce(ctx, {
      companyId,
      campaignId: campaign.id,
      enrollmentId: enrollment.id,
      stepPosition,
      eventType: plan.event,
      variant,
      sourceKey: `${plan.event}:${mail.messageId}`,
      meta: { messageId: mail.messageId, threadId: mail.threadId || null, kind, confidence },
    });
  }

  if (plan.suppress) {
    // A bounce comes from a mailer daemon: suppress the address we sent to, not the sender.
    const address = plan.suppress === "bounce"
      ? (typeof sent?.meta.to === "string" ? sent.meta.to : null) ?? campaignAddress((await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId).catch(() => null))?.emails)
      : mail.from.email;
    if (address) {
      const scope = plan.suppress === "bounce" ? "all" : "marketing";
      // Stops the contact's campaigns of this sender (every sender's for a bounce) and cancels open step issues (POPIA).
      const senderKey = campaignSenderKey(campaign);
      await suppressAddress(ctx, { companyId, email: address, reason: plan.suppress, scope, source: PLUGIN_ID, contactId: enrollment.contactId, campaignId: campaign.id, senderKey });
      // Unsubscribes are shared; the Mailbox decides for itself which bounces are hard.
      if (plan.suppress === "unsubscribe") {
        await announceSuppression(ctx, companyId, suppressionPayload({ email: address, reason: "unsubscribe", scope, clientKind: campaign.clientRef ? campaign.clientKind : null, clientRef: campaign.clientRef, senderKey }));
      }
    }
  }
  if (plan.stop === "contact") await stopEnrollmentsForSender(ctx, companyId, enrollment.contactId, plan.suppress === "bounce" ? "" : campaignSenderKey(campaign));
  if (plan.stop === "this" && enrollment.status === "running") await stopEnrollment(ctx, enrollment.id);
  if (plan.pushDays && enrollment.status === "running") {
    await pushEnrollmentDue(ctx, enrollment.id, pushDate(enrollment.nextDueAt, new Date(), plan.pushDays));
  }

  let issueId: string | null = null;
  if (plan.issue) {
    const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId).catch(() => null);
    const name = contact?.name ?? mail.from.name ?? mail.from.email;
    const subject = mail.subject.trim() || "(no subject)";
    const followUp = plan.issue === "follow-up";
    const reason = !config
      ? "Smart sorting is not set up, so the reply was not read."
      : !decision
        ? "Smart sorting could not be reached, so the reply was not read."
        : kind && !confident
          ? `Smart sorting thinks it is ${REPLY_KIND_LABELS[kind]} but is only ${pct(confidence)} sure.`
          : kind
            ? `Smart sorting read it as ${REPLY_KIND_LABELS[kind]}.`
            : "Smart sorting could not tell what kind of reply it is.";
    const draft = `\`partnersinbiz.mailbox:create-draft\` (replyToMessageId \`${mail.messageId}\`), then \`send-draft\` if your delegation allows sending`;
    const logged = `\`partnersinbiz.campaigns:log-reply\` (messageId \`${mail.messageId}\``;
    const lines = followUp
      ? [
        `${name} (\`contact:${enrollment.contactId}\`) replied to campaign "${campaign.name}" (step ${stepPosition}, variant ${variant.toUpperCase()}). Smart sorting read it as **${REPLY_KIND_LABELS[kind!]}** (${pct(confidence)} sure), so the campaign is stopped for this contact.`,
        "",
        `Answer them: read it with \`partnersinbiz.mailbox:get-message\` (messageId \`${mail.messageId}\`), draft the reply with ${draft}, and log it with ${logged}, outcome \`answered\`, mailDraftId). Log the next step on the contact in the CRM, then mark this issue done.`,
        "When you close it, Campaigns checks the reply was answered or a decision was logged; if it reopens, finish what it lists.",
      ]
      : [
        `${name} (\`contact:${enrollment.contactId}\`) replied to campaign "${campaign.name}". ${reason}`,
        "",
        `Read it with \`partnersinbiz.mailbox:get-message\` (messageId \`${mail.messageId}\`), then do one of these and mark this issue done:`,
        `- They ask to stop getting these emails: \`partnersinbiz.campaigns:suppress-address\` (email \`${mail.from.email}\`, reason \`unsubscribe\`${campaign.clientRef ? `, client \`${campaign.clientKind ?? "company"}:${campaign.clientRef}\`` : ""}). ${campaign.clientRef ? "Every campaign of this client stops for them" : "Every campaign of PiB's own stops for them"} and the CRM and Mailbox are told.`,
        `- Not interested now, or they want a person: \`partnersinbiz.campaigns:stop-enrollment\` (enrollmentId \`${enrollment.id}\`), and answer them with ${draft} when they asked something, then ${logged}, outcome \`answered\`).`,
        `- An automatic reply (out of office): leave it running and say so with ${logged}, outcome \`no-reply-needed\`).`,
        "When you close it, Campaigns checks the reply was answered or a decision was logged; if it reopens, finish what it lists.",
      ];
    lines.push("", `**Subject:** ${subject}`, "", `> ${mail.snippet.replace(/\n+/g, " ").slice(0, 500)}`);
    if (mail.from.email) lines.push("", `From: ${mail.from.email}`);
    issueId = await openIssueOnce(ctx, {
      companyId,
      originId: replyOrigin(enrollment.id, mail.messageId),
      title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}${followUp ? "Reply from" : "Check reply from"} ${name}: ${subject}`,
      description: lines.join("\n"),
      assignee: await campaignAssignee(ctx, companyId, campaign),
      wakeReason: "A campaign contact replied",
      projectId: await projectForCampaign(ctx, companyId, campaign),
    });
  }

  return { matched: true, enrollmentId: enrollment.id, campaignId: campaign.id, kind, confidence, acted: confident, event: plan.event, issueId };
}

// ---------------------------------------------------------------------------
// A/B suggestion
// ---------------------------------------------------------------------------

/** Per-variant reply rates from Mailbox sends, through the kit verdict. A person still declares. */
export async function abSuggestionFor(ctx: PluginContext, campaignId: string): Promise<AbSuggestion> {
  const rows = await abEvents(ctx, campaignId);
  const replied = new Set(rows.filter((row) => row.event_type === "reply").map((row) => `${row.enrollment_id}:${row.step_position}`));
  const sends: { a: boolean[]; b: boolean[] } = { a: [], b: [] };
  for (const row of rows) {
    if (row.event_type !== "sent") continue;
    const arm = row.variant === "b" ? "b" : "a";
    sends[arm].push(replied.has(`${row.enrollment_id}:${row.step_position}`));
  }
  return abSuggestion(sends);
}
