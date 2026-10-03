/**
 * What a person's decision on a client-care approval does (see outbound.ts for
 * how an approval is opened).
 *
 * - Done by a person: an email is queued in the Mailbox (and the feature that wrote
 *   it moves on when the Mailbox answers); an erasure is carried out.
 * - Cancelled by a person: nothing happens, and the feature is told it was refused.
 * - Closed by an agent (a Reviewer, or the agent that asked): only a person decides,
 *   so the issue is reopened for the approver.
 *
 * The Mailbox's answer arrives as `mail.send.result` with a `crm:msg:` key; a send the
 * Mailbox gave up on is found by the hourly care job (`settleStuckMessages`).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { outboxStatus, reopenApprovalForPerson, settleOutbox, type MailReceived, type MailSendResult } from "@partnersinbiz/pib-plugin-kit";
import { actionEmailProblem, actionHooks, onActionReply } from "./client-actions.js";
import {
  approvalBySendKey,
  approvalByIssue,
  approvalsByStatus,
  getApproval,
  updateApproval,
  type ApprovalKind,
  type ApprovalRecord,
} from "./care-store.js";
import { asRecord, noteOutboxError } from "./db.js";
import { openIssueOnce } from "./mail.js";
import { originFor } from "./origins.js";
import { MESSAGE_KEY_PREFIX, RecipientRefused, sendApproved, type MailApprovalHooks } from "./outbound.js";
import { PLUGIN_ID } from "./namespace.js";
import { executeApprovedErasure, redactErasureApproval } from "./privacy.js";
import { reportEmailProblem, reportHooks } from "./report.js";
import { teamAssignee } from "./routing.js";
import { feedbackHooks, onFeedbackReply } from "./support.js";

const HOOKS: Partial<Record<ApprovalKind, MailApprovalHooks>> = {
  client_action: actionHooks,
  client_reminder: actionHooks,
  client_report: reportHooks,
  feedback_request: feedbackHooks,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function comment(ctx: PluginContext, approval: ApprovalRecord, text: string): Promise<void> {
  if (approval.issueId) await ctx.issues.createComment(approval.issueId, text, approval.companyId).catch(() => undefined);
}

/**
 * An issue changed: returns true when it is one of these approvals (so the caller stops looking). A decision that is
 * not a person's is reopened for the approver and nothing happens.
 */
export async function onCareApprovalIssue(ctx: PluginContext, event: PluginEvent, issueStatus: string): Promise<boolean> {
  if (!event.entityId) return false;
  const approval = await approvalByIssue(ctx, event.entityId);
  if (!approval || approval.companyId !== event.companyId) return false;
  if (approval.status !== "open") return true;
  if (issueStatus !== "done" && issueStatus !== "cancelled") return true;
  if (event.actorType !== "user") {
    const reopened = await reopenApprovalForPerson(ctx, { issueId: event.entityId, companyId: event.companyId, what: String(approval.payload.title ?? "a client approval") });
    if (!reopened) ctx.logger.info("A client approval closed by an agent could not be reopened", { approvalId: approval.id, actorType: event.actorType ?? null });
    return true;
  }
  const by = `user:${event.actorId ?? "unknown"}`;
  if (issueStatus === "cancelled") {
    await updateApproval(ctx, approval.companyId, approval.id, { status: "refused", decidedBy: by });
    await HOOKS[approval.kind]?.onRefused(ctx, approval, by);
    return true;
  }
  if (approval.kind === "erasure") await carryOutErasure(ctx, approval, by);
  else await queueEmail(ctx, approval, by);
  return true;
}

async function queueEmail(ctx: PluginContext, approval: ApprovalRecord, by: string): Promise<void> {
  const hooks = HOOKS[approval.kind];
  // The approval was written for one state of the request or report. If it moved on while the approval waited (the client answered, the
  // request was finished, the report skipped), the email is wrong now: a person's "done" does not send it.
  const stale = (await actionEmailProblem(ctx, approval).catch(() => null)) ?? (await reportEmailProblem(ctx, approval).catch(() => null));
  if (stale) {
    await updateApproval(ctx, approval.companyId, approval.id, { status: "refused", decidedBy: "system:action-closed", error: stale });
    await comment(ctx, approval, `Not sent: ${stale} Nothing went to the client.`);
    return;
  }
  try {
    const outcome = await sendApproved(ctx, approval, by);
    if (outcome.status === "dry_run") await hooks?.onSent(ctx, { ...approval, status: "dry_run" }, { dryRun: true });
  } catch (error) {
    const text = error instanceof RecipientRefused ? error.message : `The email could not be queued (${message(error)}).`;
    await failApproval(ctx, approval, by, text);
  }
}

/** The email will not go: record why, tell whoever asked, and hand it to the Account Manager. */
async function failApproval(ctx: PluginContext, approval: ApprovalRecord, by: string | null, error: string): Promise<void> {
  await updateApproval(ctx, approval.companyId, approval.id, { status: "failed", decidedBy: by ?? undefined, error });
  await comment(ctx, approval, `This was approved but the email was not sent: ${error}`);
  await HOOKS[approval.kind]?.onFailed(ctx, approval, error).catch(() => undefined);
  await openIssueOnce(ctx, {
    companyId: approval.companyId,
    originId: originFor.msgFailed(approval.id),
    title: `Email to a client not sent: ${String(approval.payload.title ?? "approval")}`.slice(0, 200),
    description: [
      `An email a person approved could not be sent: ${error}`,
      "",
      "Fix the cause (a wrong address on the contact, a Mailbox that is not connected) and ask again with the tool that made it (`create-client-action`, `send-client-report` or `request-feedback`): the old approval stays as the record. Tell the person who approved it if it will take long.",
      "",
      approval.issueId ? `Approval issue: /issues/${approval.issueId}` : "",
    ].filter(Boolean).join("\n"),
    assignee: await teamAssignee(ctx, approval.companyId),
    wakeReason: "An approved client email could not be sent",
  }).catch(() => undefined);
}

async function carryOutErasure(ctx: PluginContext, approval: ApprovalRecord, by: string): Promise<void> {
  try {
    const result = await executeApprovedErasure(ctx, approval, by.replace(/^user:/, ""));
    await updateApproval(ctx, approval.companyId, approval.id, { status: "erased", decidedBy: by, result: { counts: result.counts, retained: result.retained, announcedTo: result.announcedTo } });
    const counted = Object.entries(result.counts).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind.replace(/_/g, " ")}`).join(", ");
    await comment(ctx, approval, [
      `Erased in the CRM: ${counted || "nothing was found"}.`,
      result.retained.length ? `Kept: ${result.retained.map((r) => `${r.what} (${r.why})`).join("; ")}.` : "",
      result.announcedTo.length ? `Asked to erase their own data: ${result.announcedTo.map((p) => p.replace(/^partnersinbiz\./, "")).join(", ")}. They answer here, and are asked again every hour until they have.` : "No other module is switched on for this company, so nobody else was asked.",
    ].filter(Boolean).join(" "));
    await redactErasureApproval(ctx, approval);
  } catch (error) {
    const text = message(error);
    await updateApproval(ctx, approval.companyId, approval.id, { status: "failed", decidedBy: by, error: text });
    await comment(ctx, approval, `The erasure could not be completed in the CRM: ${text}. Nothing was announced to the other modules. Erasing is safe to repeat: ask again with request-erasure.`);
    ctx.logger.error("CRM erasure failed", { approvalId: approval.id, error: text });
  }
}

// ---------------------------------------------------------------------------
// The Mailbox's answer
// ---------------------------------------------------------------------------

function asMsgResult(payload: unknown): MailSendResult | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key.startsWith(MESSAGE_KEY_PREFIX)) return null;
  const context = asRecord(body.context);
  if (context.plugin !== undefined && context.plugin !== PLUGIN_ID) return null;
  if (body.status !== "sent" && body.status !== "failed") return null;
  return body as unknown as MailSendResult;
}

export async function onCareSendResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const result = asMsgResult(event.payload);
  if (!result) return;
  try {
    await handleCareSendResult(ctx, result, event.companyId);
  } catch (error) {
    ctx.logger.error("CRM client message result failed", { key: result.key, error: message(error) });
  }
}

export async function handleCareSendResult(ctx: PluginContext, result: MailSendResult, companyId?: string): Promise<"sent" | "failed" | "retrying" | "ignored"> {
  // An answer is for the company that asked: one company's event never settles another's email.
  const asked = await approvalBySendKey(ctx, result.key);
  if (!asked || (companyId && asked.companyId !== companyId)) return "ignored";
  if (result.status === "failed" && !result.permanent) {
    await noteOutboxError(ctx, result.key, result.error ?? "Send failed; will retry");
    return "retrying";
  }
  const row = await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, result.status === "sent" ? "done" : "failed");
  if (!row) return "ignored";
  const approval = asked;
  if (result.status === "sent") {
    await updateApproval(ctx, approval.companyId, approval.id, { status: "sent", result: { messageId: result.messageId ?? null, threadId: result.threadId ?? null, sentAt: result.sentAt ?? new Date().toISOString() } });
    await HOOKS[approval.kind]?.onSent(ctx, { ...approval, status: "sent" }, { dryRun: false, messageId: result.messageId ?? null, threadId: result.threadId ?? null });
    return "sent";
  }
  await failApproval(ctx, approval, null, result.error ?? "The Mailbox could not send it");
  return "failed";
}

/** Hourly: an approved email whose answer never came back, or that the outbox gave up on, is settled now. */
export async function settleStuckMessages(ctx: PluginContext, companyId: string): Promise<number> {
  let settled = 0;
  for (const approval of await approvalsByStatus(ctx, companyId, "approved")) {
    if (!approval.sendKey) continue;
    const row = await outboxStatus(ctx, approval.sendKey);
    if (!row || row.status === "pending") continue;
    const stored = (row.result ?? null) as MailSendResult | null;
    if (row.status === "done") {
      await updateApproval(ctx, companyId, approval.id, { status: "sent", result: { messageId: stored?.messageId ?? null, threadId: stored?.threadId ?? null, sentAt: stored?.sentAt ?? null } });
      await HOOKS[approval.kind]?.onSent(ctx, { ...approval, status: "sent" }, { dryRun: false, messageId: stored?.messageId ?? null, threadId: stored?.threadId ?? null });
    } else {
      await failApproval(ctx, (await getApproval(ctx, companyId, approval.id)) ?? approval, null, row.last_error ?? stored?.error ?? "The Mailbox never confirmed it");
    }
    settled += 1;
  }
  return settled;
}

// ---------------------------------------------------------------------------
// A client wrote back to one of these emails
// ---------------------------------------------------------------------------

/** A reply to an email a client approval sent: a request's reminders stop, a feedback score is recorded. Returns true when it was one of ours. */
export async function onClientMailReply(ctx: PluginContext, companyId: string, mail: MailReceived): Promise<boolean> {
  const context = mail.replyTo;
  if (!context || context.plugin !== PLUGIN_ID || context.kind !== "client_message" || !context.id) return false;
  const approval = await getApproval(ctx, companyId, context.id);
  if (!approval) return false;
  if (approval.kind === "client_action" || approval.kind === "client_reminder") await onActionReply(ctx, companyId, approval.subjectId, mail.receivedAt ?? null);
  else if (approval.kind === "feedback_request") await onFeedbackReply(ctx, companyId, approval.subjectId, mail.snippet);
  return true;
}
