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
 *   or open an issue for the campaign owner.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  createWorkIssue,
  decide,
  enqueue,
  outboxStatus,
  getCrmCompany,
  getCrmContact,
  MAIL_EVENTS,
  receiveOnce,
  redeliver,
  settleOutbox,
  shouldAct,
  type MailReceived,
  type MailSendRequested,
  type MailSendResult,
  type OutboxRow,
} from "@partnersinbiz/pib-plugin-kit";
import {
  abEvents,
  addSuppression,
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
  stopEnrollmentsForContact,
  type SentEvent,
} from "./db.js";
import {
  abSuggestion,
  advanceEnrollment,
  campaignMailKey,
  campaignReplyPlan,
  clientPrefix,
  isReplyKind,
  personalize,
  pushDate,
  REPLY_KIND_LABELS,
  stepFor,
  textToHtml,
  type AbSuggestion,
  type CampaignDraft,
  type CampaignStepDraft,
  type EnrollmentDraft,
  type ReplyKind,
} from "./domain.js";
import { jevConfigFor, REPLY_QUESTIONS, replyState } from "./jev.js";
import { PLUGIN_ID } from "./namespace.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;
const LOCAL_BOARD_USER_ID = "local-board";

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

/** The campaign's creator: its agent (woken) or its user; nobody for older campaigns. */
export function campaignAssignee(campaign: Pick<CampaignDraft, "ownerAgentId" | "ownerUserId">): { assigneeAgentId?: string; assigneeUserId?: string } {
  if (campaign.ownerAgentId) return { assigneeAgentId: campaign.ownerAgentId };
  if (campaign.ownerUserId && campaign.ownerUserId !== LOCAL_BOARD_USER_ID) return { assigneeUserId: campaign.ownerUserId };
  return {};
}

async function openIssueOnce(
  ctx: PluginContext,
  input: { companyId: string; originId: string; title: string; description: string; assignee: { assigneeAgentId?: string; assigneeUserId?: string }; wakeReason: string },
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
    ...input.assignee,
    wakeReason: input.wakeReason,
  });
  return issue.id;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends one due step of an active email campaign. A suppressed address stops
 * the enrollment; a contact without an address gets the usual step issue.
 */
export async function sendCampaignStep(
  ctx: PluginContext,
  input: { campaign: CampaignDraft; enrollment: EnrollmentDraft; step: CampaignStepDraft; issueFallback: (note: string) => Promise<void> },
): Promise<"sent" | "stopped" | "issue"> {
  const { campaign, enrollment, step } = input;
  const contact = await getCrmContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
  const to = contact?.emails?.find((email) => email.includes("@")) ?? null;
  if (!contact || !to) {
    await input.issueFallback("This contact has no email address in the CRM, so the step was not emailed. Reach them another way, then mark this issue done.");
    return "issue";
  }
  if (await isSuppressed(ctx, enrollment.companyId, to)) {
    await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null });
    return "stopped";
  }
  const accountId = contact.account_ids?.[0];
  const company = accountId ? (await getCrmCompany(ctx, ctx.db.namespace, enrollment.companyId, accountId).catch(() => null))?.name ?? null : null;
  const vars = { name: contact.name, email: to, company: company ?? (campaign.clientKind === "company" ? campaign.clientName : null) };
  const text = personalize(step.body, vars);
  const key = campaignMailKey(enrollment.id, step.position);
  const payload: MailSendRequested = {
    key,
    from: null,
    to: [{ email: to, name: contact.name }],
    subject: personalize(step.subject, vars),
    text,
    html: step.htmlBody ? personalize(step.htmlBody, vars) : textToHtml(text),
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

/** The step could not be emailed: a person sends it; marking the issue done moves the contact on. */
async function failStep(ctx: PluginContext, enrollment: EnrollmentDraft, steps: CampaignStepDraft[], error: string): Promise<void> {
  const [campaign, contact] = await Promise.all([
    getCampaign(ctx, enrollment.campaignId),
    getCrmContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId).catch(() => null),
  ]);
  const step = stepFor(steps, enrollment.stepPosition, enrollment.variant);
  const name = contact?.name ?? enrollment.contactId;
  const to = contact?.emails?.[0] ? `\n\nSend to: ${name} <${contact.emails[0]}>` : "";
  const issueId = await openIssueOnce(ctx, {
    companyId: enrollment.companyId,
    originId: `send-failed:${enrollment.sendingKey ?? enrollment.id}`,
    title: `${clientPrefix(campaign?.clientRef ? campaign.clientName : null)}Email not sent: ${step?.subject ?? "Campaign step"}: ${name}`,
    description: [
      `The Mailbox could not send this campaign email: ${error}`,
      "",
      "Send it yourself (or fix the address), then mark this issue done to move the contact to the next step.",
      "",
      step?.body ?? "",
    ].join("\n") + to,
    assignee: campaign ? campaignAssignee(campaign) : {},
    wakeReason: "A campaign email failed",
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
      ? (typeof sent?.meta.to === "string" ? sent.meta.to : null) ?? (await getCrmContact(ctx, ctx.db.namespace, companyId, enrollment.contactId).catch(() => null))?.emails?.[0] ?? null
      : mail.from.email;
    if (address) await addSuppression(ctx, { companyId, email: address, reason: plan.suppress, contactId: enrollment.contactId, campaignId: campaign.id });
  }
  if (plan.stop === "contact") await stopEnrollmentsForContact(ctx, companyId, enrollment.contactId);
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
      ? "Jev is not set up, so the reply was not read."
      : !decision
        ? "Jev could not be reached, so the reply was not read."
        : kind && !confident
          ? `Jev thinks it is ${REPLY_KIND_LABELS[kind]} but is only ${pct(confidence)} sure.`
          : kind
            ? `Jev read it as ${REPLY_KIND_LABELS[kind]}.`
            : "Jev could not tell what kind of reply it is.";
    const lines = followUp
      ? [
        `${name} replied to campaign "${campaign.name}" (step ${stepPosition}, variant ${variant.toUpperCase()}). Jev read it as **${REPLY_KIND_LABELS[kind!]}** (${pct(confidence)} sure), so the campaign is stopped for this contact.`,
        "",
        "Reply from Gmail and log the next step in the CRM.",
      ]
      : [
        `${name} replied to campaign "${campaign.name}". ${reason}`,
        "",
        "Decide what to do: stop the campaign for this contact, or let it carry on.",
      ];
    lines.push("", `**Subject:** ${subject}`, "", `> ${mail.snippet.replace(/\n+/g, " ").slice(0, 500)}`);
    if (mail.from.email) lines.push("", `From: ${mail.from.email}`);
    issueId = await openIssueOnce(ctx, {
      companyId,
      originId: `reply:${mail.messageId}`,
      title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}${followUp ? "Reply from" : "Check reply from"} ${name}: ${subject}`,
      description: lines.join("\n"),
      assignee: campaignAssignee(campaign),
      wakeReason: "A campaign contact replied",
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
