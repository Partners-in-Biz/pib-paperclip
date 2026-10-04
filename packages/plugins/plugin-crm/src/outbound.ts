/**
 * Everything the client care features send or do that a person must decide first.
 *
 * An email to a client (a sign-off request, a reminder, the monthly report, a
 * feedback request) is never sent by the feature that wrote it. It becomes an
 * approval: a row in `care_approvals` and an issue for the Reviewer first (when
 * the company reviews outward work), then a person, showing the exact email.
 * Marking the issue done sends it through the Mailbox; cancelling refuses it. An
 * agent's close is reopened for a person (`care-approvals.ts`). The Mailbox
 * "draft" of these emails is that approval: what the person reads is what goes out.
 *
 * This module only creates the approval and sends an approved email. It imports
 * no feature, so every feature can use it; `care-approvals.ts` decides what an
 * answer does to each kind.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { approvalReviewerBrief, enqueue, MAIL_EVENTS, openApprovalIssue, readConfig, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { isCanaryEmail } from "./canary-flag.js";
import {
  approvalForSubject,
  approvalsOfSubject,
  getApproval,
  insertApproval,
  setApprovalIssue,
  updateApproval,
  type ApprovalKind,
  type ApprovalRecord,
  type ClientKey,
} from "./care-store.js";
import { contactsByEmail, table } from "./db.js";
import { textToHtml } from "./domain.js";
import { displayDraftText } from "./esign-render.js";
import { PLUGIN_ID } from "./namespace.js";
import { companyPrefix, issueLink } from "./refs.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;

/** `crm:approval:<id>`: an approval a person decides. Never done-checked (only a person closes it). */
export const APPROVAL_ORIGIN = "crm:approval:";

/** The outbox key of an approved email. */
export const MESSAGE_KEY_PREFIX = "crm:msg:";
export const messageKey = (approvalId: string) => `${MESSAGE_KEY_PREFIX}${approvalId}`;

export interface MailDraft {
  to: Array<{ email: string; name?: string | null }>;
  subject: string;
  text: string;
  html?: string | null;
  contactId?: string | null;
  threadId?: string | null;
}

export interface ApprovalRequest {
  companyId: string;
  kind: ApprovalKind;
  client: ClientKey | null;
  /** The record the approval is about (an action, a report, a feedback ask, an erasure request). */
  subjectId: string;
  /** Attempt number: a reminder is attempt 2, 3 ... of the same action. */
  seq?: number;
  title: string;
  /** Lines shown above the email: why it is being sent and what approving does. */
  intro: string[];
  draft?: MailDraft;
  /** Extra data kept with the approval (what an erasure will remove, for instance). */
  payload?: Record<string, unknown>;
  /** What the Reviewer checks before a person decides. */
  checks: string[];
  /** Outward work goes to the Reviewer first; an erasure goes to a person alone. */
  outward: boolean;
  actorUserId?: string | null;
  projectId?: string | null;
  wakeReason?: string;
}

export interface ApprovalOpened {
  approvalId: string;
  issueId: string | null;
  /** False when this subject and attempt already had an approval (nothing new was opened). */
  created: boolean;
  status: ApprovalRecord["status"];
  assignedTo: "reviewer" | "person" | "operator" | "nobody" | null;
}

const MAX_DESCRIPTION = 9_000;

/** What the approval issue says: the exact email and what approving does. Pure. */
export function approvalDescription(request: Pick<ApprovalRequest, "intro" | "draft">, doneNote: string): string {
  const lines = [...request.intro];
  const draft = request.draft;
  if (draft) {
    const to = draft.to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
    // A placeholder the system fills when the email is approved (a private signing link) is shown as a note: nobody reading this sees the link.
    const shown = displayDraftText(draft.text);
    const body = shown.length > 6_500 ? `${shown.slice(0, 6_500)}\n\n[...the full email is stored with the approval]` : shown;
    lines.push("", `**To:** ${to}`, `**Subject:** ${draft.subject}`, "", "---", body, "---");
  }
  lines.push("", doneNote);
  const text = lines.join("\n");
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}\n\n[shortened]` : text;
}

const MAIL_DONE_NOTE = "**Approve** by marking this issue **done**: the email is sent from the Mailbox. **Refuse** by marking it **cancelled**: nothing is sent. Only a person decides; an agent that closes it has it reopened.";

/**
 * Opens an approval for a person to decide. One per subject and attempt: asking
 * again returns the same approval. The approval row exists before its issue, so
 * a failed issue create is retried by the hourly care job (`repairApprovalIssues`).
 */
export async function requestApproval(ctx: PluginContext, request: ApprovalRequest): Promise<ApprovalOpened> {
  const seq = request.seq ?? 1;
  const id = randomUUID();
  const payload = { ...(request.payload ?? {}), title: request.title, ...(request.draft ? { draft: request.draft } : {}), intro: request.intro, checks: request.checks, outward: request.outward };
  const inserted = await insertApproval(ctx, { id, companyId: request.companyId, kind: request.kind, client: request.client, subjectId: request.subjectId, seq, payload });
  if (!inserted) {
    const existing = await approvalForSubject(ctx, request.companyId, request.kind, request.subjectId, seq);
    return { approvalId: existing?.id ?? id, issueId: existing?.issueId ?? null, created: false, status: existing?.status ?? "open", assignedTo: null };
  }
  const issue = await openApprovalIssueFor(ctx, { id, companyId: request.companyId, title: request.title, payload, outward: request.outward, actorUserId: request.actorUserId ?? null, projectId: request.projectId ?? null, wakeReason: request.wakeReason });
  return { approvalId: id, issueId: issue?.id ?? null, created: true, status: "open", assignedTo: issue?.assignedTo ?? null };
}

async function openApprovalIssueFor(
  ctx: PluginContext,
  input: { id: string; companyId: string; title: string; payload: Record<string, unknown>; outward: boolean; actorUserId: string | null; projectId: string | null; wakeReason?: string },
): Promise<{ id: string; assignedTo: ApprovalOpened["assignedTo"] } | null> {
  const draft = input.payload.draft as MailDraft | undefined;
  const intro = Array.isArray(input.payload.intro) ? (input.payload.intro as string[]) : [];
  const checks = Array.isArray(input.payload.checks) ? (input.payload.checks as string[]) : [];
  try {
    const opened = await openApprovalIssue(ctx, {
      companyId: input.companyId,
      title: input.title.slice(0, 200),
      description: approvalDescription({ intro, draft }, draft ? MAIL_DONE_NOTE : "**Approve** by marking this issue **done**. **Refuse** by marking it **cancelled**. Only a person decides; an agent that closes it has it reopened."),
      originKind: ORIGIN,
      originId: `${APPROVAL_ORIGIN}${input.id}`,
      outward: input.outward,
      actorUserId: input.actorUserId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      reviewerBrief: (route) => approvalReviewerBrief(route, draft ? "an email to a client before it is sent" : "an approval before it is carried out", checks),
      wakeReason: input.wakeReason ?? "An approval needs checking",
    });
    await setApprovalIssue(ctx, input.companyId, input.id, opened.id);
    return { id: opened.id, assignedTo: opened.assignedTo };
  } catch (error) {
    ctx.logger.info("CRM approval issue not opened; the care job retries", { approvalId: input.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Hourly: an approval whose issue was never opened gets it now. Returns how many were opened. */
export async function repairApprovalIssues(ctx: PluginContext, companyId: string, open: ApprovalRecord[]): Promise<number> {
  let repaired = 0;
  for (const approval of open) {
    if (approval.issueId) continue;
    const opened = await openApprovalIssueFor(ctx, {
      id: approval.id,
      companyId,
      title: String(approval.payload.title ?? "Approval"),
      payload: approval.payload,
      outward: approval.payload.outward !== false,
      actorUserId: null,
      projectId: null,
    });
    if (opened) repaired += 1;
  }
  return repaired;
}

/**
 * Closes the open approvals of a subject because the thing they ask a person to approve is no longer wanted (the client answered, the
 * request or report was finished or skipped). The approval is decided first, so the issue update that follows is not mistaken for an
 * agent closing an approval; the issue gets a comment saying why, then it is cancelled. An approval already approved (queued in the
 * Mailbox) cannot be called back from here. Returns how many were withdrawn.
 */
export async function withdrawOpenApprovals(ctx: PluginContext, companyId: string, kinds: readonly ApprovalKind[], subjectId: string, decidedBy: string, why: string): Promise<number> {
  let withdrawn = 0;
  for (const kind of kinds) {
    for (const approval of await approvalsOfSubject(ctx, companyId, kind, subjectId)) {
      if (approval.status !== "open") continue;
      await updateApproval(ctx, companyId, approval.id, { status: "refused", decidedBy: `system:${decidedBy}` });
      if (approval.issueId) {
        await ctx.issues.createComment(approval.issueId, `Withdrawn, nothing was sent: ${why}`, companyId).catch(() => undefined);
        await ctx.issues.update(approval.issueId, { status: "cancelled" }, companyId).catch(() => undefined);
      }
      withdrawn += 1;
    }
  }
  return withdrawn;
}

/** Deep link to the approval issue, for pages and other issues. */
export async function approvalLink(ctx: PluginContext, companyId: string, issueId: string | null): Promise<string | null> {
  if (!issueId) return null;
  return issueLink(await companyPrefix(ctx, companyId), issueId);
}

// ---------------------------------------------------------------------------
// Sending an approved email
// ---------------------------------------------------------------------------

export class RecipientRefused extends Error {}

/**
 * Whether an approved email may still go to its recipients. A bounced address
 * never gets mail; an address that opted out gets no feedback asks (an
 * unsubscribe is final for marketing, and a survey is not a service message).
 */
export async function checkRecipients(ctx: PluginContext, companyId: string, kind: ApprovalKind, draft: MailDraft): Promise<void> {
  if (draft.to.length === 0) throw new RecipientRefused("The email has no recipient.");
  for (const to of draft.to) {
    if (!to.email.includes("@")) throw new RecipientRefused(`"${to.email}" is not an email address.`);
    for (const contact of await contactsByEmail(ctx, companyId, to.email)) {
      if (contact.emailStatus === "bounced") throw new RecipientRefused(`${to.email} bounced before, so the Mailbox would not deliver it. Fix the address on the contact first.`);
      if (contact.emailStatus === "unsubscribed" && kind === "feedback_request") throw new RecipientRefused(`${to.email} opted out of email, so no feedback request goes to them.`);
    }
  }
}

export interface SendOutcome {
  status: "queued" | "dry_run";
  key: string | null;
}

/**
 * Queues an approved email in the Mailbox outbox (the Mailbox sends it and
 * answers with `mail.send.result`). An email to canary addresses only is a dry
 * run: nothing is queued, and the caller applies its effects as if it was sent.
 */
export async function sendApproved(ctx: PluginContext, approval: ApprovalRecord, decidedBy: string, options: { draft?: MailDraft } = {}): Promise<SendOutcome> {
  // A signing email's draft is completed at this moment (the private link is made now): the caller passes the finished draft. Its text goes
  // to the Mailbox outbox below, which is where the link lives until the Mailbox answers (`scrubSettledBody` then blanks it).
  const draft = options.draft ?? (approval.payload.draft as MailDraft | undefined);
  if (!draft) throw new Error("This approval has no email to send.");
  await checkRecipients(ctx, approval.companyId, approval.kind, draft);
  if (draft.to.every((to) => isCanaryEmail(to.email))) {
    await updateApproval(ctx, approval.companyId, approval.id, { status: "dry_run", decidedBy, error: null });
    return { status: "dry_run", key: null };
  }
  const config = await readConfig(ctx, approval.companyId).catch(() => ({} as Record<string, unknown>));
  const key = messageKey(approval.id);
  const payload: MailSendRequested = {
    key,
    from: typeof config.mailFrom === "string" && config.mailFrom.includes("@") ? config.mailFrom.trim() : null,
    to: draft.to.map((a) => ({ email: a.email, name: a.name ?? null })),
    subject: draft.subject,
    text: draft.text,
    html: draft.html ?? textToHtml(draft.text),
    threadId: draft.threadId ?? null,
    context: { plugin: PLUGIN_ID, kind: "client_message", id: approval.id, clientKind: approval.client?.kind ?? null, clientRef: approval.client?.id ?? null },
    labels: ["PiB/Clients"],
    // A message about the service we give a client, not marketing: the Mailbox does not add an unsubscribe header or skip opt-outs
    // (checkRecipients already refused a bounced address, and an opt-out for a survey).
    marketing: false,
  };
  await enqueue(ctx, approval.companyId, MAIL_EVENTS.sendRequested, payload as unknown as { key: string } & Record<string, unknown>);
  await updateApproval(ctx, approval.companyId, approval.id, { status: "approved", decidedBy, sendKey: key, error: null });
  return { status: "queued", key };
}

/**
 * Blanks the text and html of an outbox row once it is settled (the Mailbox answered, or the outbox gave up), so a finished message
 * does not sit in the CRM's own outbox for good. A signing email carries a live link (the page id and the token), so this is what keeps
 * the CRM from holding one after the send. A pending row is left alone: the redeliver job still has to send it. The Mailbox keeps its own
 * copy of what it sent (that is the Mailbox's to scrub), so this is one of two places the link lives, not a promise that none does.
 * Returns whether a settled row was blanked.
 */
export async function scrubSettledBody(ctx: PluginContext, key: string): Promise<boolean> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "outbox")} SET payload = payload - 'text' - 'html' WHERE key = $1 AND status <> 'pending'`, [key]);
  return (res?.rowCount ?? 0) > 0;
}

/** What a feature does when the person decided its email, or the Mailbox answered. `care-approvals.ts` calls these. */
export interface MailApprovalHooks {
  /** The email went out (or was a dry run for a canary): record it and move the record on. */
  onSent(ctx: PluginContext, approval: ApprovalRecord, info: { dryRun: boolean; messageId?: string | null; threadId?: string | null }): Promise<void>;
  /** A person cancelled the approval: nothing was sent. */
  onRefused(ctx: PluginContext, approval: ApprovalRecord, by: string): Promise<void>;
  /** The email could not be sent (a refused recipient, or the Mailbox gave up). */
  onFailed(ctx: PluginContext, approval: ApprovalRecord, error: string): Promise<void>;
}

export { getApproval };
