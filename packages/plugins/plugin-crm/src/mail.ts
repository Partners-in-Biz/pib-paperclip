/**
 * Mailbox work for the CRM: replies from contacts, Jev lead scores, and
 * sequences that send email.
 *
 * - `mail.received` (from the Mailbox) → match the sender to a contact, log
 *   the email, and when the contact is in a running sequence classify the
 *   reply with Jev and act (stop, push, suppress) or open an issue.
 * - A due step of an approved email sequence is sent through the kit outbox
 *   (`mail.send.requested`); `mail.send.result` advances the enrollment or
 *   opens an issue on a permanent failure. The `redeliver-mail` job re-emits
 *   unanswered requests.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  createWorkIssue,
  decide,
  enqueue,
  isModuleEnabled,
  MAIL_EVENTS,
  outboxStatus,
  readConfig,
  receiveOnce,
  redeliver,
  reopenApprovalForPerson,
  reviewerBrief,
  settleOutbox,
  shouldAct,
  type MailReceived,
  type MailSendRequested,
  type MailSendResult,
  type OutboxRow,
} from "@partnersinbiz/pib-plugin-kit";
import {
  approveSequenceEmail,
  asRecord,
  contactCompanyLinks,
  contactsByEmail,
  enrollmentById,
  enrollmentsWithFailedSend,
  getContact,
  insertActivityOnce,
  insertFacts,
  listActivities,
  listSteps,
  markDecisionActed,
  noteOutboxError,
  pushEnrollmentDue,
  runningEnrollmentsForContact,
  saveContact,
  saveEmailStatus,
  saveEnrollment,
  saveLeadScore,
  saveSequenceDelivery,
  sequenceByApprovalIssue,
  sequenceEmailApproved,
  stopEnrollmentsForContact,
  type SequenceRow,
} from "./db.js";
import {
  advanceEnrollment,
  applyFieldPatch,
  assertNextAction,
  columnKeysFor,
  isReplyKind,
  personalize,
  pushDate,
  REPLY_KIND_LABELS,
  replyPlan,
  sequenceMailKey,
  textToHtml,
  type ContactDraft,
  type EnrollmentDraft,
  type ReplyKind,
  type SequenceDelivery,
  type SequenceStepDraft,
} from "./domain.js";
import { jevConfigFor, LEAD_QUESTIONS, leadScoreState, REPLY_QUESTIONS, replyState, scoreValue } from "./jev.js";
import type { LeadScore } from "./lead-levels.js";
import { emitSuppressed } from "./handoffs.js";
import { PLUGIN_ID } from "./namespace.js";
import { LEGACY_ORIGINS, originFor } from "./origins.js";
import { companyPrefix, crmLink, refOf } from "./refs.js";
import { approvalAssignee, recordAssignee, teamAssignee, type Assignee } from "./routing.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

// ---------------------------------------------------------------------------
// Who gets CRM work for a contact
// ---------------------------------------------------------------------------

/**
 * Who gets CRM work about a contact: its own agent (when it can work) or owner,
 * else the Account Manager, then the Operator, then the company owner. With
 * `sequenceIssueAssignee: team` the contact's owner is skipped.
 */
export async function contactAssignee(
  ctx: PluginContext,
  companyId: string,
  contact: Pick<ContactDraft, "assigneeAgentId" | "ownerUserId">,
): Promise<Assignee> {
  return recordAssignee(ctx, companyId, contact);
}

/**
 * Opens an issue once per origin id (a retried event must not open a second
 * one). `legacyOriginId` is the id the same work had before 0.5.0.
 */
export async function openIssueOnce(
  ctx: PluginContext,
  input: { companyId: string; originId: string; legacyOriginId?: string | null; title: string; description: string; assignee: Assignee; wakeReason: string },
): Promise<string> {
  for (const originId of [input.originId, input.legacyOriginId].filter((id): id is string => Boolean(id))) {
    try {
      const existing = await ctx.issues.list({ companyId: input.companyId, originKind: ORIGIN, originId, limit: 1 });
      if (existing[0]) return existing[0].id;
    } catch {
      // Listing is a best-effort guard; create below.
    }
  }
  const issue = await createWorkIssue(ctx, {
    companyId: input.companyId,
    title: input.title,
    description: input.description,
    originKind: ORIGIN,
    originId: input.originId,
    ...input.assignee,
    wakeReason: input.wakeReason,
  });
  return issue.id;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

function asMailReceived(payload: unknown): MailReceived | null {
  const body = asRecord(payload);
  const from = asRecord(body.from);
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
 * The contact a message is from. A reply to one of our sequence emails names
 * the contact in its context (this also catches bounces, which come from a
 * mailer daemon); otherwise the sender's address decides, oldest contact first.
 */
export async function matchContact(ctx: PluginContext, companyId: string, mail: MailReceived): Promise<ContactDraft | null> {
  const context = mail.replyTo;
  if (context?.plugin === PLUGIN_ID) {
    if (context.clientKind === "contact" && context.clientRef) {
      const contact = await getContact(ctx, context.clientRef);
      if (contact && contact.companyId === companyId) return contact;
    }
    if (context.kind === "sequence_step" && context.id) {
      const enrollment = await enrollmentById(ctx, context.id);
      if (enrollment && enrollment.companyId === companyId) {
        const contact = await getContact(ctx, enrollment.contactId);
        if (contact) return contact;
      }
    }
  }
  const matches = await contactsByEmail(ctx, companyId, mail.from.email);
  return matches[0] ?? null;
}

export async function onMailReceived(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const mail = asMailReceived(event.payload);
  if (!mail || !event.companyId) return;
  try {
    await receiveOnce(ctx, event.companyId, MAIL_EVENTS.received, mail.key, () => handleReply(ctx, event.companyId, mail));
  } catch (error) {
    ctx.logger.error("CRM reply handling failed", { messageId: mail.messageId, error: message(error) });
  }
}

export interface ReplyOutcome extends Record<string, unknown> {
  matched: boolean;
  contactId?: string;
  enrollments?: number;
  kind?: ReplyKind | null;
  confidence?: number | null;
  acted?: boolean;
  issueId?: string | null;
}

export async function handleReply(ctx: PluginContext, companyId: string, mail: MailReceived): Promise<ReplyOutcome> {
  const contact = await matchContact(ctx, companyId, mail);
  if (!contact) return { matched: false };
  const subject = mail.subject.trim() || "(no subject)";
  await insertActivityOnce(ctx, {
    companyId,
    recordType: "contact",
    recordId: contact.id,
    kind: "email_received",
    body: `${subject}\n\n${mail.snippet}`.trim(),
    meta: { messageId: mail.messageId, threadId: mail.threadId || null, from: mail.from.email, receivedAt: mail.receivedAt ?? null },
    sourceKey: `mail:${mail.messageId}`,
  });

  const running = await runningEnrollmentsForContact(ctx, companyId, contact.id);
  if (running.length === 0) return { matched: true, contactId: contact.id, enrollments: 0 };

  const config = await jevConfigFor(ctx, companyId);
  const decision = config
    ? await decide(ctx, companyId, {
      config,
      purpose: "crm.reply",
      subject: { kind: "email", id: mail.messageId },
      state: replyState(mail),
      questions: REPLY_QUESTIONS,
    })
    : null;
  const answer = decision?.answers.reply_kind;
  const kind = answer && answer.type === "choice" && isReplyKind(answer.choice) ? answer.choice : null;
  const confidence = answer && answer.type === "choice" ? answer.confidence : null;
  const confident = Boolean(kind && shouldAct(answer, "update"));
  const plan = replyPlan(kind, confident);
  const now = new Date();

  if (confident && decision?.ids.reply_kind) await markDecisionActed(ctx, decision.ids.reply_kind).catch(() => undefined);

  if (plan.stopEnrollments) await stopEnrollmentsForContact(ctx, companyId, contact.id);
  if (plan.pushDays) {
    for (const enrollment of running) {
      await pushEnrollmentDue(ctx, enrollment.id, pushDate(enrollment.nextDueAt, now, plan.pushDays));
    }
  }
  if (plan.emailStatus) {
    await saveEmailStatus(ctx, contact.id, plan.emailStatus);
    // Campaigns and the Mailbox keep their own lists: tell them (contact.suppressed).
    for (const email of suppressedAddresses(mail, contact, plan.emailStatus)) {
      await emitSuppressed(ctx, companyId, { email, reason: plan.emailStatus === "bounced" ? "bounced" : "unsubscribed", clientKind: "contact", clientRef: contact.id }).catch((error) =>
        ctx.logger.info("CRM suppression emit failed", { contactId: contact.id, error: message(error) }));
    }
  }
  if (plan.addTag || plan.nextActionDays) await patchContact(ctx, contact, plan.addTag, plan.nextActionDays, now);

  let issueId: string | null = null;
  if (plan.issue) {
    const name = contact.name;
    const reason = !config
      ? "Smart sorting is not set up, so the CRM did not read the reply."
      : !decision
        ? "Smart sorting could not be reached, so the CRM did not read the reply."
        : kind && !confident
          ? `Smart sorting thinks it is ${REPLY_KIND_LABELS[kind]} but is only ${pct(confidence ?? 0)} sure.`
          : kind
            ? `Smart sorting read it as ${REPLY_KIND_LABELS[kind]}.`
            : "Smart sorting could not tell what kind of reply it is.";
    const followUp = plan.issue === "follow-up";
    const prefix = await companyPrefix(ctx, companyId);
    const lines = followUp
      ? [
        `${name} replied to a sequence email. Smart sorting read it as **${REPLY_KIND_LABELS[kind!]}** (${pct(confidence ?? 0)} sure), so the sequence is stopped.`,
        "",
        "Draft the answer in the Mailbox in the same thread (`mailbox-draft` skill); a person approves sending. Then log what happens next on the contact (`log-activity`, next action, a deal when they want a quote).",
      ]
      : [
        `${name} replied while in a running sequence. ${reason}`,
        "",
        "Decide what to do: stop the sequence (a lost deal or `set-email-status` when they opted out), set a next action, or let it carry on. Log what you decided on the contact (`log-activity`).",
      ];
    lines.push("", `**Subject:** ${subject}`, "", `> ${mail.snippet.replace(/\n+/g, " ").slice(0, 500)}`);
    lines.push("", `- Mailbox message: \`${mail.messageId}\`${mail.threadId ? `, thread \`${mail.threadId}\`` : ""}`);
    lines.push(`- Contact: \`${refOf("contact", contact.id)}\` · ${crmLink(prefix, "contact", contact.id)}`);
    lines.push("", "**Done when** the contact shows what happened since this reply: a logged activity, a next action, a deal move, or an opt-out. Closing checks it.");
    issueId = await openIssueOnce(ctx, {
      companyId,
      originId: originFor.reply(mail.messageId),
      legacyOriginId: LEGACY_ORIGINS.reply(mail.messageId),
      title: `${followUp ? "Reply from" : "Check reply from"} ${name}: ${subject}`.slice(0, 200),
      description: lines.join("\n"),
      // A lead's reply is sales work; a client's is the Account Manager's.
      assignee: await recordAssignee(ctx, companyId, contact, contact.lifecycle === "lead" ? "inbound-qualifier" : "account-manager"),
      wakeReason: "A CRM contact replied",
    });
  }

  await insertActivityOnce(ctx, {
    companyId,
    recordType: "contact",
    recordId: contact.id,
    kind: "reply_classified",
    body: kind
      ? `Reply read as ${REPLY_KIND_LABELS[kind]} (${pct(confidence ?? 0)} sure). ${plan.summary}`
      : `Reply not classified. ${plan.summary}`,
    meta: { messageId: mail.messageId, kind, confidence, acted: confident },
    sourceKey: `reply:${mail.messageId}`,
    issueId,
  });

  return { matched: true, contactId: contact.id, enrollments: running.length, kind, confidence, acted: confident, issueId };
}

/**
 * The addresses a reply suppresses. An unsubscribe: the address that wrote
 * plus the one sequences mail. A bounce comes from a mailer daemon: the
 * failed recipients it names, else the address sequences mail.
 */
export function suppressedAddresses(mail: Pick<MailReceived, "from" | "bounce">, contact: Pick<ContactDraft, "emails">, status: "bounced" | "unsubscribed" | "ok"): string[] {
  const primary = contact.emails.find((email) => email.includes("@")) ?? null;
  const out = new Set<string>();
  if (status === "bounced") {
    for (const email of mail.bounce?.recipients ?? []) if (email.includes("@")) out.add(email.trim().toLowerCase());
    if (out.size === 0 && primary) out.add(primary.trim().toLowerCase());
  } else if (status === "unsubscribed") {
    if (mail.from.email.includes("@")) out.add(mail.from.email.trim().toLowerCase());
    if (primary) out.add(primary.trim().toLowerCase());
  }
  return [...out];
}

/** Adds a tag and/or sets the next action, as an agent would (filled human-owned fields are kept). */
async function patchContact(ctx: PluginContext, contact: ContactDraft, tag: string | null, nextActionDays: number | null, now: Date) {
  const fresh = (await getContact(ctx, contact.id)) ?? contact;
  const patch: Record<string, unknown> = {};
  if (tag && !fresh.tags.map((item) => item.toLowerCase()).includes(tag)) patch.tags = [...fresh.tags, tag];
  if (nextActionDays) {
    patch.nextActionKind = "email";
    patch.nextActionDueAt = new Date(now.getTime() + nextActionDays * 86_400_000).toISOString();
  }
  if (Object.keys(patch).length === 0) return;
  const result = applyFieldPatch({
    columns: { tags: fresh.tags, nextActionKind: fresh.nextActionKind, nextActionDueAt: fresh.nextActionDueAt },
    custom: fresh.custom,
    humanOwned: fresh.humanOwned,
    columnKeys: columnKeysFor("contact"),
    patch,
    source: "agent",
  });
  const next: ContactDraft = {
    ...fresh,
    tags: Array.isArray(result.columns.tags) ? (result.columns.tags as string[]) : fresh.tags,
    nextActionKind: assertNextAction(result.columns.nextActionKind),
    nextActionDueAt: result.columns.nextActionDueAt == null ? null : String(result.columns.nextActionDueAt),
  };
  await saveContact(ctx, next);
  await insertFacts(ctx, fresh.companyId, "contact", fresh.id, result.facts);
}

// ---------------------------------------------------------------------------
// Lead scoring
// ---------------------------------------------------------------------------

/** One Jev call for fit, intent and urgency. Null without Jev or when the call fails. */
export async function scoreLead(ctx: PluginContext, companyId: string, contactId: string): Promise<LeadScore | null> {
  const config = await jevConfigFor(ctx, companyId);
  if (!config) return null;
  const contact = await getContact(ctx, contactId);
  if (!contact || contact.companyId !== companyId) return null;
  const [links, activities] = await Promise.all([
    contactCompanyLinks(ctx, contact.id),
    listActivities(ctx, "contact", contact.id, 3),
  ]);
  const custom = contact.custom;
  const customRole = [custom.role, custom.title, custom.jobTitle].find((value) => typeof value === "string" && value.trim());
  const state = leadScoreState({
    name: contact.name,
    role: (typeof customRole === "string" ? customRole : null) ?? links[0]?.roleLabel ?? null,
    company: links[0]?.name ?? null,
    lifecycle: contact.lifecycle,
    tags: contact.tags,
    activities: activities.map((item) => item.body),
  });
  const result = await decide(ctx, companyId, {
    config,
    purpose: "crm.lead-score",
    subject: { kind: "contact", id: contact.id },
    state,
    questions: { ...LEAD_QUESTIONS },
    acting: ["fit", "intent", "urgency"],
  });
  if (!result) return null;
  const fit = scoreValue(result.answers.fit);
  const intent = scoreValue(result.answers.intent);
  const urgency = scoreValue(result.answers.urgency);
  if (fit == null || intent == null || urgency == null) return null;
  const confidences = ["fit", "intent", "urgency"].map((key) => {
    const answer = result.answers[key];
    return answer && answer.type === "score" ? answer.confidence : 0;
  });
  const score = { fit, intent, urgency, confidence: Math.min(...confidences) };
  await saveLeadScore(ctx, contact.id, score);
  return { ...score, scoredAt: new Date().toISOString() };
}

const pendingScores = new Set<Promise<unknown>>();

/** Score in the background after a create or update; never fails the caller. */
export function scoreLeadLater(ctx: PluginContext, companyId: string, contactId: string): void {
  const run = scoreLead(ctx, companyId, contactId)
    .catch((error) => ctx.logger.info("CRM lead score skipped", { contactId, error: message(error) }))
    .finally(() => pendingScores.delete(run));
  pendingScores.add(run);
}

/** Tests: wait for background scores. */
export async function settleLeadScores(): Promise<void> {
  while (pendingScores.size > 0) await Promise.all([...pendingScores]);
}

// ---------------------------------------------------------------------------
// Email sequences
// ---------------------------------------------------------------------------

/**
 * Sets how a sequence delivers its steps. The first switch to email opens an
 * approval issue; email is only sent once a board user marks it done.
 */
export async function setDelivery(
  ctx: PluginContext,
  companyId: string,
  sequence: SequenceRow,
  delivery: SequenceDelivery,
): Promise<{ sequenceId: string; delivery: SequenceDelivery; emailApproved: boolean; approvalIssueId: string | null }> {
  let approvalIssueId = sequence.email_approval_issue_id ?? null;
  const approved = sequenceEmailApproved(sequence);
  if (delivery === "email" && !approved) {
    const existing = approvalIssueId ? await ctx.issues.get(approvalIssueId, companyId).catch(() => null) : null;
    // Done but not approved means an agent closed it (only a board user's done counts): ask again.
    if (!existing || existing.status === "cancelled" || existing.status === "done") {
      const steps = await listSteps(ctx, sequence.id);
      const preview = steps
        .map((step) => `${step.position}. **${step.title}** (after ${step.delayMinutes} min)\n${step.body || "(no body)"}`)
        .join("\n\n");
      const description = [
        `The CRM wants to send the steps of sequence "${sequence.name}" as marketing email from the Mailbox.`,
        "A person approves by marking this issue **done**, or refuses by marking it **cancelled** (the sequence then goes back to opening an issue per step). Until then no step is emailed; due steps wait and show in the Cockpit.",
        "Tokens such as {{first_name}} and {{company}} are filled in per contact. The Mailbox skips anyone who unsubscribed and adds an unsubscribe header.",
        "",
        preview || "(no steps yet)",
      ].join("\n");
      // Email to contacts is outward-facing: the Reviewer checks it first when the company has one, then a person decides.
      const { reviewer, approverUserId } = await approvalAssignee(ctx, companyId);
      const sender = reviewer ? await senderLabel(ctx, companyId) : "";
      const issue = await createWorkIssue(ctx, {
        companyId,
        title: `Approve email sending: ${sequence.name}`,
        description: reviewer ? `${description}\n${sequenceReviewBrief(sequence.name, sender, approverUserId)}` : description,
        originKind: ORIGIN,
        originId: originFor.sequenceEmail(sequence.id),
        ...(reviewer
          ? { assigneeAgentId: reviewer, wake: true, wakeReason: "Review a sequence before it switches to email" }
          : approverUserId
            ? { assigneeUserId: approverUserId, wake: false }
            : { wake: false }),
      });
      approvalIssueId = issue.id;
    }
  }
  await saveSequenceDelivery(ctx, { id: sequence.id, delivery, approvalIssueId });
  return { sequenceId: sequence.id, delivery, emailApproved: approved, approvalIssueId };
}

async function senderLabel(ctx: PluginContext, companyId: string): Promise<string> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  return typeof config.mailFrom === "string" && config.mailFrom.includes("@") ? config.mailFrom.trim() : "the Mailbox's default Gmail account";
}

/** What the Reviewer checks before a sequence starts sending email. */
export function sequenceReviewBrief(sequenceName: string, sender: string, approverUserId: string | null): string {
  return reviewerBrief({
    what: `sequence "${sequenceName}" before its steps are emailed to contacts`,
    checks: [
      "Personalisation: every {{first_name}}, {{last_name}}, {{name}}, {{company}} and {{email}} token is spelled right and reads well when filled in, with a fallback (e.g. {{first_name|there}}) where a contact may have no first name.",
      "Tone: sounds like us, friendly and direct, no pushy or spammy lines, right length for a cold or follow-up email.",
      "Claims: prices, results, client names and guarantees are accurate and we can back them up.",
      "Who we are: each email names Partners in Biz and the person writing.",
      "Unsubscribe: each email tells the reader how to stop the emails (for example \"Reply STOP and we won't email again\").",
      `Sender: the mail goes out from ${sender}. That address is right for this audience.`,
    ],
    handTo: approverUserId ? { userId: approverUserId, label: `the approver (user \`${approverUserId}\`)` } : { label: "a board member (unassign the agent so the board sees it)" },
  });
}

/**
 * The approval issue of a sequence's email sending changed.
 * - Done by a person: email sending is approved for good.
 * - Done or cancelled by an agent (the Reviewer, or the agent that asked):
 *   only a person decides, so it is reopened and handed to the approver.
 * - Cancelled by a person: refused. The sequence goes back to opening an
 *   issue per step, and the Account Manager gets a hand-off.
 * Returns true when the issue is a sequence approval.
 */
export async function onApprovalIssue(ctx: PluginContext, event: PluginEvent, issueStatus: string): Promise<boolean> {
  if (!event.entityId) return false;
  const sequence = await sequenceByApprovalIssue(ctx, event.entityId);
  if (!sequence || sequence.company_id !== event.companyId) return false;
  if (sequenceEmailApproved(sequence)) return true;
  if (issueStatus !== "done" && issueStatus !== "cancelled") return true;
  if (event.actorType !== "user") {
    const { approverUserId } = await approvalAssignee(ctx, event.companyId);
    const reopened = await reopenApprovalForPerson(ctx, { issueId: event.entityId, companyId: event.companyId, userId: approverUserId, what: `email sending for sequence "${sequence.name}"` });
    if (!reopened) ctx.logger.info("Sequence email approval closed by an agent could not be reopened", { sequenceId: sequence.id, actorType: event.actorType ?? null });
    return true;
  }
  if (issueStatus === "done") {
    await approveSequenceEmail(ctx, sequence.id, `user:${event.actorId ?? "unknown"}`);
    return true;
  }
  await refuseSequenceEmail(ctx, event.companyId, sequence, event.entityId);
  return true;
}

/** A person refused email sending: back to issue delivery, and a hand-off for the Account Manager. */
async function refuseSequenceEmail(ctx: PluginContext, companyId: string, sequence: SequenceRow, approvalIssueId: string): Promise<void> {
  await saveSequenceDelivery(ctx, { id: sequence.id, delivery: "issue", approvalIssueId: null });
  const prefix = await companyPrefix(ctx, companyId);
  await openIssueOnce(ctx, {
    companyId,
    originId: originFor.sequenceRefused(approvalIssueId),
    legacyOriginId: LEGACY_ORIGINS.sequenceRefused(approvalIssueId),
    title: `Hand-off: email sending refused for sequence "${sequence.name}"`.slice(0, 200),
    description: [
      `A person refused email sending for sequence "${sequence.name}" (\`${sequence.id}\`). Its due steps now open an issue for you again, so no contact is left waiting.`,
      "",
      `1. Read why on the approval issue: ${prefix ? `/${prefix}` : ""}/issues/${approvalIssueId}.`,
      "2. To email instead, create a corrected sequence with `create-sequence` (delivery email: tone, claims, who we are and the opt-out line) and enroll new contacts there; a person approves it once.",
      "3. Otherwise do this sequence's steps by hand as their issues arrive.",
      "",
      "Comment what you did, then mark this issue done.",
    ].join("\n"),
    assignee: await teamAssignee(ctx, companyId),
    wakeReason: "A sequence's email sending was refused",
  });
}

/**
 * An email sequence has due steps but no open approval (it was closed without
 * a decision, or deleted): ask again so the steps do not wait unseen.
 */
export async function ensureApprovalOpen(ctx: PluginContext, companyId: string, sequence: SequenceRow): Promise<"open" | "asked"> {
  const id = sequence.email_approval_issue_id ?? null;
  const issue = id ? await ctx.issues.get(id, companyId).catch(() => null) : null;
  if (issue && issue.status !== "done" && issue.status !== "cancelled") return "open";
  await setDelivery(ctx, companyId, sequence, "email");
  return "asked";
}

async function companyNameFor(ctx: PluginContext, contactId: string): Promise<string | null> {
  const links = await contactCompanyLinks(ctx, contactId).catch(() => []);
  return links[0]?.name ?? null;
}

/**
 * Sends one due step of an approved email sequence. Suppressed contacts stop;
 * a contact without an address gets an issue instead.
 */
export async function sendSequenceStep(
  ctx: PluginContext,
  input: { enrollment: EnrollmentDraft; step: SequenceStepDraft; contact: ContactDraft; issueFallback: (note: string) => Promise<void> },
): Promise<"sent" | "stopped" | "issue"> {
  const { enrollment, step, contact } = input;
  if (contact.emailStatus && contact.emailStatus !== "ok") {
    await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null });
    await insertActivityOnce(ctx, {
      companyId: enrollment.companyId,
      recordType: "contact",
      recordId: contact.id,
      kind: "note",
      body: `Sequence stopped: this contact's email is ${contact.emailStatus}.`,
      sourceKey: `suppressed:${enrollment.id}:${step.position}`,
    });
    return "stopped";
  }
  const to = contact.emails.find((email) => email.includes("@"));
  if (!to) {
    await input.issueFallback("This contact has no email address, so the step was not emailed. Reach them another way, then mark this issue done.");
    return "issue";
  }
  const config = await readConfig(ctx, enrollment.companyId).catch(() => ({} as Record<string, unknown>));
  const vars = { name: contact.name, email: to, company: await companyNameFor(ctx, contact.id) };
  const text = personalize(step.body, vars);
  const key = sequenceMailKey(enrollment.id, step.position);
  const payload: MailSendRequested = {
    key,
    from: typeof config.mailFrom === "string" && config.mailFrom.includes("@") ? config.mailFrom.trim() : null,
    to: [{ email: to, name: contact.name }],
    subject: personalize(step.title, vars),
    text,
    html: textToHtml(text),
    threadId: enrollment.mailThreadId ?? null,
    inReplyToMessageId: enrollment.mailLastMessageId ?? null,
    context: { plugin: PLUGIN_ID, kind: "sequence_step", id: enrollment.id, clientKind: "contact", clientRef: contact.id },
    labels: ["PiB/Sequences"],
    // Sequence email is marketing: the Mailbox skips suppressed addresses and adds List-Unsubscribe.
    marketing: true,
  };
  const { created } = await enqueue(ctx, enrollment.companyId, MAIL_EVENTS.sendRequested, payload as unknown as { key: string } & Record<string, unknown>);
  await saveEnrollment(ctx, { ...enrollment, sendingKey: key });
  if (!created) {
    // This step was requested before (e.g. an enrollment was reset). If the Mailbox already
    // answered, apply that answer now instead of waiting for a result that will not come again.
    const existing = await outboxStatus(ctx, key);
    if (existing && existing.status !== "pending") {
      const stored = (existing.result ?? null) as MailSendResult | null;
      await applySendResult(ctx, existing, stored ?? { key, status: "failed", permanent: true, error: existing.last_error ?? "Send failed", context: payload.context });
    }
  }
  return "sent";
}

function asSendResult(payload: unknown): MailSendResult | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key.startsWith("crm:seq:")) return null;
  const context = asRecord(body.context);
  if (context.plugin !== undefined && context.plugin !== PLUGIN_ID) return null;
  if (body.status !== "sent" && body.status !== "failed") return null;
  return body as unknown as MailSendResult;
}

function enrollmentIdFromKey(key: string): string | null {
  const match = /^crm:seq:(.+):(\d+)$/.exec(key);
  return match ? match[1]! : null;
}

export async function onSendResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const result = asSendResult(event.payload);
  if (!result) return;
  try {
    await handleSendResult(ctx, result);
  } catch (error) {
    ctx.logger.error("CRM send result failed", { key: result.key, error: message(error) });
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

/** Advance (sent) or hand the step to a person (failed), once the outbox row is settled. */
async function applySendResult(ctx: PluginContext, row: OutboxRow, result: MailSendResult): Promise<"advanced" | "failed" | "ignored"> {
  const enrollmentId = (typeof result.context?.id === "string" && result.context.id) || enrollmentIdFromKey(result.key);
  const enrollment = enrollmentId ? await enrollmentById(ctx, enrollmentId) : null;
  if (!enrollment || enrollment.companyId !== row.company_id || enrollment.sendingKey !== result.key) return "ignored";
  const payload = asRecord(row.payload);
  const subject = typeof payload.subject === "string" ? payload.subject : "Sequence email";

  if (result.status === "failed") {
    // A reply may have stopped the sequence meanwhile: then nobody needs to send it.
    if (enrollment.status !== "running") {
      await saveEnrollment(ctx, { ...enrollment, sendingKey: null });
      return "ignored";
    }
    await failStep(ctx, enrollment, result.error ?? "The Mailbox could not send it");
    return "failed";
  }

  const steps = await listSteps(ctx, enrollment.sequenceId);
  const sent: EnrollmentDraft = {
    ...enrollment,
    sendingKey: null,
    mailThreadId: result.threadId ?? enrollment.mailThreadId ?? null,
    mailLastMessageId: result.messageId ?? enrollment.mailLastMessageId ?? null,
  };
  // Only a running enrollment moves on; a stopped one stays stopped.
  await saveEnrollment(ctx, enrollment.status === "running" ? advanceEnrollment(sent, steps, new Date()) : sent);
  await insertActivityOnce(ctx, {
    companyId: enrollment.companyId,
    recordType: "contact",
    recordId: enrollment.contactId,
    kind: "email_sent",
    body: `Sequence email sent: ${subject}`,
    meta: { messageId: result.messageId ?? null, threadId: result.threadId ?? null, key: result.key },
    sourceKey: `sent:${result.key}`,
  });
  return "advanced";
}

/** A step email could not be sent: hand the step to a person. Marking the issue done moves the contact on. */
async function failStep(ctx: PluginContext, enrollment: EnrollmentDraft, error: string): Promise<void> {
  const [contact, steps] = await Promise.all([getContact(ctx, enrollment.contactId), listSteps(ctx, enrollment.sequenceId)]);
  const step = steps.find((item) => item.position === enrollment.stepPosition);
  const name = contact?.name ?? "contact";
  const issueId = await openIssueOnce(ctx, {
    companyId: enrollment.companyId,
    originId: originFor.sendFailed(enrollment.id, enrollment.stepPosition),
    legacyOriginId: LEGACY_ORIGINS.sendFailed(enrollment.sendingKey ?? enrollment.id),
    title: `Email not sent: ${step?.title ?? "Sequence step"}: ${name}`.slice(0, 200),
    description: [
      `The Mailbox could not send this sequence email to ${contact ? `\`${refOf("contact", contact.id)}\`` : "the contact"}: ${error}`,
      "",
      "Fix the address (`update-contact` emails) or reach them another way and log it (`log-activity`), then mark this issue done to move the contact to the next step. A bounced address: `set-email-status` bounced instead.",
      "**Done when** the address was fixed, the contact was reached and logged, or the address is marked bounced. Closing checks it.",
      "",
      step?.body ?? "",
    ].join("\n"),
    assignee: contact ? await contactAssignee(ctx, enrollment.companyId, contact) : await teamAssignee(ctx, enrollment.companyId),
    wakeReason: "A CRM sequence email failed",
  });
  await saveEnrollment(ctx, { ...enrollment, sendingKey: null, openIssueId: issueId });
}

/** Job: re-emit unanswered send requests, then hand exhausted ones to a person. */
export async function redeliverMail(ctx: PluginContext): Promise<{ emitted: number; failed: number; handedOver: number }> {
  const counts = await redeliver(ctx);
  let handedOver = 0;
  for (const enrollment of await enrollmentsWithFailedSend(ctx)) {
    try {
      if (!(await configSaved(ctx, enrollment.companyId))) continue;
      if (!(await isModuleEnabled(ctx, enrollment.companyId, PLUGIN_ID))) continue;
      await failStep(ctx, enrollment, enrollment.lastError ?? "No answer from the Mailbox");
      handedOver += 1;
    } catch (error) {
      ctx.logger.error("CRM failed-send handover failed", { enrollmentId: enrollment.id, error: message(error) });
    }
  }
  return { ...counts, handedOver };
}
