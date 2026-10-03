/**
 * Client actions (audit Q1b-4): what a client must do (sign off a preview, give
 * a grant, approve something, send information) and the waiting-on-client state.
 *
 * Before this, nothing contacted the client: the owner relayed every link. Now
 * an agent (or a person) records the action with the exact link the client must
 * open, the plugin writes the email, and the email goes through the approval step
 * (`outbound.ts`): the Reviewer checks it, a person marks the issue done, the
 * Mailbox sends it. After it went out the action waits on the client; the hourly
 * care job drafts a reminder after N days (also approved) and, after two reminders,
 * opens an issue for the Account Manager to reach the client another way. The
 * Cockpit's ask flow stays owner-only; this is for requests to clients.
 *
 * States: draft (email waiting for approval), waiting (the client was asked),
 * replied (the client wrote back, someone must read it), done, cancelled.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, type HealthCheck, type WaitingItem } from "@partnersinbiz/pib-plugin-kit";
import { clientInfo, clientProjectOf, logOnClient, pickRecipient, firstName } from "./care-clients.js";
import {
  ACTION_KINDS,
  approvalsOfSubject,
  getAction,
  insertAction,
  listActions,
  listActionsByStatus,
  saveAction,
  updateApproval,
  type ActionKind,
  type ApprovalKind,
  type ApprovalRecord,
  type ClientAction,
  type ClientKey,
} from "./care-store.js";
import { CrmError, type Viewer } from "./domain.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { DEFAULT_PUBLIC_ORIGIN } from "./sites.js";
import { originFor } from "./origins.js";
import { approvalLink, requestApproval, withdrawOpenApprovals, type MailApprovalHooks } from "./outbound.js";
import { brandName, companyPrefix, crmLink, refOf } from "./refs.js";
import { teamAssignee } from "./routing.js";
import { dayLabel } from "./setup-status.js";

const DAY_MS = 86_400_000;

/** Reminders drafted after the first request before the client is chased another way. */
export const MAX_REMINDERS = 2;
export const DEFAULT_REMIND_AFTER_DAYS = 3;

const KIND_LABEL: Record<ActionKind, string> = {
  sign_off: "sign-off",
  grant: "access",
  approval: "approval",
  info: "information",
};

const OPENING: Record<ActionKind, (title: string) => string> = {
  sign_off: (title) => `We need your sign-off on ${title} before we go any further.`,
  grant: (title) => `We need you to give us access so we can carry on with ${title}.`,
  approval: (title) => `We need your approval on ${title}.`,
  info: (title) => `We need a little information from you for ${title}.`,
};

/** Why a link cannot go to a client, or null. The client opens it in their browser: a Paperclip board page is no use to them. */
export function clientLinkProblem(url: string, boardOrigins: string[] = [DEFAULT_PUBLIC_ORIGIN]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The link is not a web address. Send the full https:// link the client must open.";
  }
  if (parsed.protocol !== "https:") return "The link must start with https:// so the client can trust it.";
  if (parsed.username || parsed.password) return "The link must not carry a login (a name and password in the address).";
  if (url.length > 500) return "The link is too long (500 characters at most).";
  const boardHosts = boardOrigins.map((origin) => {
    try {
      return new URL(origin).host.toLowerCase();
    } catch {
      return "";
    }
  });
  if (boardHosts.includes(parsed.host.toLowerCase())) return "That is a page on our Paperclip board, which the client cannot open. Send the client's own link: a preview link, a sign-in or consent page.";
  return null;
}

export interface ActionEmailInput {
  kind: ActionKind;
  title: string;
  instructions: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  dueAt: string | null;
  recipientName: string;
  message: string | null;
  /** 0 for the first request, 1 and 2 for reminders. */
  reminder: number;
  /** Who signs it: the company's own name. */
  brand?: string | null;
}

/** The email a client request becomes. Pure. */
export function actionEmail(input: ActionEmailInput): { subject: string; text: string } {
  const first = firstName(input.recipientName);
  const subject = input.reminder > 0 ? `Reminder: ${input.title}` : `${input.kind === "info" ? "Information needed" : "Action needed"}: ${input.title}`;
  const lines: string[] = [`Hi ${first || "there"},`, ""];
  if (input.reminder > 0) lines.push(`Just a friendly reminder about ${input.title}. We are waiting on you before we can carry on.`, "");
  else lines.push(input.message?.trim() || OPENING[input.kind](input.title), "");
  if (input.reminder > 0 && input.message?.trim()) lines.push(input.message.trim(), "");
  if (input.instructions?.trim()) lines.push(input.instructions.trim(), "");
  if (input.linkUrl) lines.push(`${input.linkLabel?.trim() || "You can do it here"}: ${input.linkUrl}`, "");
  if (input.dueAt) lines.push(`It would help to have this by ${dayLabel(input.dueAt)}.`, "");
  lines.push("Reply to this email if anything is unclear, or if you would like us to walk you through it.", "", "Kind regards,", input.brand ?? "The team");
  return { subject, text: lines.join("\n") };
}

const CHECKS = [
  "The link opens the right page and is one the client can use (a preview, a consent page), never an internal Paperclip page.",
  "The email says plainly what the client has to do, and by when if there is a date.",
  "Tone: friendly, short and clear, no jargon, nothing about other clients.",
  "The recipient is the right person at this client.",
];

function clamp(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

async function boardOrigins(ctx: PluginContext, companyId: string): Promise<string[]> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  return [DEFAULT_PUBLIC_ORIGIN, ...(typeof config.publicBaseUrl === "string" && config.publicBaseUrl.trim() ? [config.publicBaseUrl.trim()] : [])];
}

function dueDate(days: unknown): string | null {
  if (days == null || days === "") return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new CrmError("dueInDays must be a whole number from 1 to 90");
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

/** The agent tool and the page action: records the action and asks for approval of the email to the client. */
export async function createClientAction(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const kind = typeof params.kind === "string" ? params.kind : "";
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) throw new CrmError(`kind must be one of ${ACTION_KINDS.join(", ")}`);
  const title = clamp(params.title, 160);
  if (!title) throw new CrmError("title is required: what the client must do, in a few words");
  const linkUrl = clamp(params.link, 500);
  if (linkUrl) {
    const problem = clientLinkProblem(linkUrl, await boardOrigins(ctx, viewer.companyId));
    if (problem) throw new CrmError(problem);
  }
  const remind = params.remindAfterDays == null || params.remindAfterDays === "" ? DEFAULT_REMIND_AFTER_DAYS : Number(params.remindAfterDays);
  if (!Number.isInteger(remind) || remind < 1 || remind > 14) throw new CrmError("remindAfterDays must be a whole number from 1 to 14");
  // The same request asked twice (an agent retrying) is one request: never a second email to the client.
  const same = (await listActions(ctx, viewer.companyId, client, 200)).find((a) => a.title.toLowerCase() === title.toLowerCase() && (a.status === "draft" || a.status === "waiting" || a.status === "replied"));
  if (same) {
    const approval = (await approvalsOfSubject(ctx, viewer.companyId, "client_action", same.id))[0];
    return {
      actionId: same.id,
      client: refOf(client.kind, client.id),
      status: same.status,
      created: false,
      note: "This client already has an open request with that title, so nothing new was drafted. Use update-client-action to finish it first.",
      approvalIssueId: approval?.issueId ?? null,
    };
  }
  const { contact, email } = await pickRecipient(ctx, viewer.companyId, client, {
    contactId: typeof params.contactId === "string" ? params.contactId : null,
    toEmail: typeof params.toEmail === "string" ? params.toEmail : null,
  });
  const action: Parameters<typeof insertAction>[1] = {
    id: randomUUID(),
    companyId: viewer.companyId,
    client,
    kind: kind as ActionKind,
    title,
    instructions: clamp(params.instructions, 2000),
    linkUrl,
    linkLabel: clamp(params.linkLabel, 80),
    contactId: contact.id,
    toEmail: email,
    toName: contact.name,
    status: "draft",
    sourceRef: clamp(params.sourceRef, 200),
    dueAt: dueDate(params.dueInDays),
    remindAfterDays: remind,
    createdBy: viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null,
  };
  await insertAction(ctx, action);
  const message = clamp(params.message, 3000);
  const mail = actionEmail({ ...action, recipientName: contact.name, message, reminder: 0, brand: await brandName(ctx, viewer.companyId) });
  const opened = await requestApproval(ctx, {
    companyId: viewer.companyId,
    kind: "client_action",
    client,
    subjectId: action.id,
    seq: 1,
    title: `Approve email to ${name}: ${title}`,
    intro: [
      `${source === "agent" ? "An agent" : "A person"} wants to ask ${name} for their ${KIND_LABEL[action.kind]}: **${title}**.`,
      "Until a person approves, nothing is sent. After it is sent the request waits on the client, and a reminder is drafted for approval after " + remind + " days.",
    ],
    draft: { to: [{ email, name: contact.name }], subject: mail.subject, text: mail.text, contactId: contact.id },
    checks: CHECKS,
    outward: true,
    actorUserId: viewer.userId,
    wakeReason: "A client request needs checking before it is sent",
  });
  await logOnClient(ctx, viewer.companyId, client, "note", `Prepared a request to the client: ${title} (${KIND_LABEL[action.kind]}). Waiting for approval to send it.`, `care:action:${action.id}:drafted`, opened.issueId);
  const prefix = await companyPrefix(ctx, viewer.companyId);
  return {
    actionId: action.id,
    client: refOf(client.kind, client.id),
    created: true,
    status: "draft" as const,
    to: `${contact.name} <${email}>`,
    approvalIssueId: opened.issueId,
    approvalLink: await approvalLink(ctx, viewer.companyId, opened.issueId),
    clientPage: crmLink(prefix, client.kind, client.id),
    next: "A person approves the email by marking the approval issue done. Do not send it yourself. Once sent, the action waits on the client; when they answer, call update-client-action (status done, with what they said).",
  };
}

/** The emails an action sends: the request, then reminders. Each is its own approval. */
const ACTION_EMAIL_KINDS = ["client_action", "client_reminder"] as const;

/**
 * Closes every email of an action that still waits for a person, because it is no longer wanted: the client replied, the request is
 * done or it was cancelled. Without this a stale "we are still waiting on you" reminder could be approved and sent to a client who
 * already did the thing (`withdrawOpenApprovals` says how). Returns how many were withdrawn.
 */
export function withdrawActionEmails(ctx: PluginContext, companyId: string, actionId: string, decidedBy: string, why: string, kinds: readonly ApprovalKind[] = ACTION_EMAIL_KINDS): Promise<number> {
  return withdrawOpenApprovals(ctx, companyId, kinds, actionId, decidedBy, why);
}

/**
 * Why an approved email of an action must not go out after all, or null. The email was written for one state of the request (the
 * request while it is a draft, a reminder while it waits on the client); if the request moved on in the meantime, sending it
 * would be wrong. `withdrawActionEmails` closes these approvals when the request moves, so this is the safety net for a race.
 */
export async function actionEmailProblem(ctx: PluginContext, approval: ApprovalRecord): Promise<string | null> {
  if (approval.kind !== "client_action" && approval.kind !== "client_reminder") return null;
  const action = await getAction(ctx, approval.companyId, approval.subjectId);
  if (!action) return "The request this email belongs to no longer exists.";
  const reminder = approval.kind === "client_reminder";
  if (action.status === (reminder ? "waiting" : "draft")) return null;
  if (action.status === "replied") return "The client has already replied to this request, so a reminder would be wrong.";
  if (action.status === "done") return "The client already did what this email asks.";
  if (action.status === "cancelled") return "This request was cancelled.";
  return reminder ? "The client has not been asked yet, so there is nothing to remind them of." : `This request is already ${action.status}, so the first email must not be sent again.`;
}

export const ACTION_UPDATE_STATUSES = ["done", "cancelled"] as const;

/** An agent or person records the outcome: the client did it (done), or it is no longer needed (cancelled). */
export async function updateClientAction(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = typeof params.actionId === "string" ? params.actionId.trim() : "";
  if (!id) throw new CrmError("actionId is required (list-client-actions shows them)");
  const action = await getAction(ctx, viewer.companyId, id);
  if (!action) throw new CrmError("That client action was not found");
  await requireClient(ctx, viewer, action.client);
  const status = typeof params.status === "string" ? params.status : "";
  if (!(ACTION_UPDATE_STATUSES as readonly string[]).includes(status)) throw new CrmError("status must be done (the client did it) or cancelled (no longer needed)");
  if (action.status === "done" || action.status === "cancelled") throw new CrmError(`This action is already ${action.status}.`);
  if (status === "done" && action.status === "draft") throw new CrmError("The client has not been asked yet (the email still waits for approval). Cancel it, or wait until it is sent.");
  const now = new Date().toISOString();
  const answer = clamp(params.answer, 1000);
  const next: ClientAction = { ...action, status: status as "done" | "cancelled", answeredAt: status === "done" ? now : action.answeredAt, answer: answer ?? action.answer, nextReminderAt: null };
  await saveAction(ctx, next);
  // An email still waiting for approval is no longer needed: the request itself, and a reminder drafted to chase it.
  await withdrawActionEmails(ctx, viewer.companyId, action.id, `action-${status}`, status === "done" ? "The client already did what this email asks, so it is not needed." : "This request was cancelled, so the email is not needed.");
  await logOnClient(ctx, viewer.companyId, action.client, "note", status === "done" ? `The client did what we asked: ${action.title}.${answer ? ` ${answer}` : ""}` : `The request to the client was cancelled: ${action.title}.`, `care:action:${action.id}:${status}`);
  return { actionId: action.id, status, answeredAt: next.answeredAt };
}

function actionOut(action: ClientAction, now: number) {
  const waitingDays = action.requestedAt ? Math.max(0, Math.floor((now - Date.parse(action.requestedAt)) / DAY_MS)) : null;
  return {
    actionId: action.id,
    client: refOf(action.client.kind, action.client.id),
    kind: action.kind,
    title: action.title,
    status: action.status,
    to: action.toEmail,
    link: action.linkUrl,
    requestedAt: action.requestedAt,
    waitingDays,
    reminders: action.reminders,
    nextReminderAt: action.nextReminderAt,
    dueAt: action.dueAt,
    escalated: Boolean(action.escalatedAt),
    answer: action.answer,
  };
}

export async function listClientActionsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const filter = typeof params.status === "string" && params.status ? params.status : "open";
  // With no client named, only the clients this viewer may see: the same rule the CRM's other lists follow.
  const seen = client ? null : await visibleClients(ctx, viewer);
  const all = (await listActions(ctx, viewer.companyId, client, 200)).filter((action) => !seen || seen.has(action.client.kind, action.client.id));
  const rows = all.filter((action) => (filter === "all" ? true : filter === "open" ? ["draft", "waiting", "replied"].includes(action.status) : action.status === filter));
  const now = Date.now();
  return { count: rows.length, waitingOnClient: all.filter((a) => a.status === "waiting" || a.status === "replied").length, actions: rows.slice(0, 50).map((action) => actionOut(action, now)) };
}

/** The workspace card: every action of a client, newest first. */
export async function clientActionViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  const now = Date.now();
  return (await listActions(ctx, companyId, client, 30)).map((action) => actionOut(action, now));
}

// ---------------------------------------------------------------------------
// After the email: the hooks the approval flow calls
// ---------------------------------------------------------------------------

export const actionHooks: MailApprovalHooks = {
  async onSent(ctx, approval, info) {
    const action = await getAction(ctx, approval.companyId, approval.subjectId);
    if (!action || action.status === "done" || action.status === "cancelled") return;
    const now = new Date();
    const reminder = approval.kind === "client_reminder";
    const next: ClientAction = {
      ...action,
      status: action.status === "replied" ? "replied" : "waiting",
      requestedAt: action.requestedAt ?? now.toISOString(),
      reminders: reminder ? action.reminders + 1 : action.reminders,
      lastReminderAt: reminder ? now.toISOString() : action.lastReminderAt,
      nextReminderAt: new Date(now.getTime() + action.remindAfterDays * DAY_MS).toISOString(),
    };
    await saveAction(ctx, next);
    await logOnClient(ctx, approval.companyId, action.client, "email_sent", `${reminder ? "Reminder sent" : "Request sent"} to the client: ${action.title}.${info.dryRun ? " (canary dry run: not really sent)" : ""}`, `care:action:${action.id}:sent:${approval.id}`, approval.issueId);
  },
  async onRefused(ctx, approval, by) {
    const action = await getAction(ctx, approval.companyId, approval.subjectId);
    if (!action) return;
    if (approval.kind === "client_reminder") {
      // A refused reminder is "do not chase yet": wait the interval again. A request that is no longer waiting has no reminders to space out.
      if (action.status === "waiting") await saveAction(ctx, { ...action, nextReminderAt: new Date(Date.now() + action.remindAfterDays * DAY_MS).toISOString() });
      return;
    }
    await saveAction(ctx, { ...action, status: "cancelled", nextReminderAt: null, answer: action.answer ?? `Refused by ${by}` });
    await logOnClient(ctx, approval.companyId, action.client, "note", `The request to the client was refused before it was sent: ${action.title}.`, `care:action:${action.id}:refused`, approval.issueId);
  },
  async onFailed(ctx, approval, error) {
    const action = await getAction(ctx, approval.companyId, approval.subjectId);
    if (!action) return;
    if (approval.kind === "client_reminder") {
      // The next reminder waits the interval again (not drafted again in the next hour), and a failed one counts toward MAX_REMINDERS,
      // so a reminder that can never be sent ends in an issue for a person instead of a new draft every time.
      if (action.status === "waiting") await saveAction(ctx, { ...action, nextReminderAt: new Date(Date.now() + action.remindAfterDays * DAY_MS).toISOString() });
      return;
    }
    // The request never went out. Leaving it a draft would make "ask again" (create-client-action) answer "already open" for ever, so it
    // is cancelled: the issue the common handler opens tells the Account Manager to ask again, and the failed approval stays as the record.
    if (action.status !== "draft") return;
    await saveAction(ctx, { ...action, status: "cancelled", nextReminderAt: null, answer: action.answer ?? `The email could not be sent: ${error}`.slice(0, 1000) });
    await logOnClient(ctx, approval.companyId, action.client, "note", `The request to the client could not be sent (${error}): ${action.title}. It was cancelled so it can be asked again.`, `care:action:${action.id}:send-failed`, approval.issueId);
  },
};

// ---------------------------------------------------------------------------
// The client wrote back
// ---------------------------------------------------------------------------

/** A reply to one of these emails: the client answered, so reminders stop and someone must read it. */
export async function onActionReply(ctx: PluginContext, companyId: string, actionId: string, receivedAt: string | null): Promise<boolean> {
  const action = await getAction(ctx, companyId, actionId);
  if (!action || action.status !== "waiting") return false;
  await saveAction(ctx, { ...action, status: "replied", replyAt: receivedAt ?? new Date().toISOString(), nextReminderAt: null });
  // A reminder already drafted and waiting for a person must not go out now that the client has answered.
  await withdrawActionEmails(ctx, companyId, action.id, "client-replied", "The client has already replied, so a reminder is not needed.", ["client_reminder"]);
  await logOnClient(ctx, companyId, action.client, "note", `The client replied about: ${action.title}. Read it, then record the outcome with update-client-action.`, `care:action:${action.id}:replied`);
  return true;
}

// ---------------------------------------------------------------------------
// Reminders (the hourly care job)
// ---------------------------------------------------------------------------

export interface ReminderRun {
  drafted: number;
  escalated: number;
}

/**
 * For each action waiting on a client whose next reminder is due: draft the
 * reminder for approval (one open at a time), or after two reminders open an
 * issue for the Account Manager to reach the client another way.
 */
export async function runActionReminders(ctx: PluginContext, companyId: string, now = new Date()): Promise<ReminderRun> {
  const run: ReminderRun = { drafted: 0, escalated: 0 };
  for (const action of await listActionsByStatus(ctx, companyId, "waiting")) {
    if (!action.nextReminderAt || Date.parse(action.nextReminderAt) > now.getTime()) continue;
    const approvals = await approvalsOfSubject(ctx, companyId, "client_reminder", action.id);
    if (approvals.some((approval) => approval.status === "open" || approval.status === "approved")) continue;
    // A reminder a person refused or that could not be sent is an attempt too: after MAX_REMINDERS of either, a person reaches the client.
    const declined = approvals.filter((approval) => approval.status === "refused" || approval.status === "failed").length;
    if (action.reminders >= MAX_REMINDERS || declined >= MAX_REMINDERS) {
      if (!action.escalatedAt && (await escalateStale(ctx, companyId, action, now))) run.escalated += 1;
      continue;
    }
    const info = await clientInfo(ctx, companyId, action.client);
    if (!info) continue;
    let recipient: { email: string; name: string } | null = null;
    try {
      const picked = await pickRecipient(ctx, companyId, action.client, { contactId: action.contactId, toEmail: action.toEmail });
      recipient = { email: picked.email, name: picked.contact.name };
    } catch {
      recipient = null;
    }
    if (!recipient) {
      if (!action.escalatedAt && (await escalateStale(ctx, companyId, action, now))) run.escalated += 1;
      continue;
    }
    const number = action.reminders + 1;
    const mail = actionEmail({ kind: action.kind, title: action.title, instructions: action.instructions, linkUrl: action.linkUrl, linkLabel: action.linkLabel, dueAt: action.dueAt, recipientName: recipient.name, message: null, reminder: number, brand: await brandName(ctx, companyId) });
    const opened = await requestApproval(ctx, {
      companyId,
      kind: "client_reminder",
      client: action.client,
      subjectId: action.id,
      seq: approvals.length + 1,
      title: `Approve reminder to ${info.name}: ${action.title}`,
      intro: [
        `${info.name} has not answered the request "${action.title}" for ${Math.max(1, Math.floor((now.getTime() - Date.parse(action.requestedAt ?? now.toISOString())) / DAY_MS))} days (reminder ${number} of ${MAX_REMINDERS}).`,
        "Approving sends one short reminder. Refusing waits another few days without chasing.",
      ],
      draft: { to: [{ email: recipient.email, name: recipient.name }], subject: mail.subject, text: mail.text, contactId: action.contactId },
      checks: CHECKS,
      outward: true,
      wakeReason: "A reminder to a client needs checking",
    });
    if (opened.created) run.drafted += 1;
  }
  return run;
}

async function escalateStale(ctx: PluginContext, companyId: string, action: ClientAction, now: Date): Promise<boolean> {
  const info = await clientInfo(ctx, companyId, action.client);
  const prefix = await companyPrefix(ctx, companyId);
  const waiting = Math.max(1, Math.floor((now.getTime() - Date.parse(action.requestedAt ?? now.toISOString())) / DAY_MS));
  await openIssueOnce(ctx, {
    companyId,
    originId: originFor.clientActionStale(action.id),
    title: `${info?.name ?? "A client"} has not answered: ${action.title}`.slice(0, 200),
    description: [
      `${info?.name ?? "The client"} was asked for their ${KIND_LABEL[action.kind]} ${waiting} days ago (${action.title}) and has not answered after ${action.reminders} reminder${action.reminders === 1 ? "" : "s"}.`,
      "",
      "Reach them another way: a call, or a message to a different person at the client. Then record what happened with `update-client-action` (done with what they said, or cancelled when it is no longer needed), and `log-activity` the contact.",
      "",
      action.linkUrl ? `The link they were sent: ${action.linkUrl}` : "",
      info ? `Client: ${crmLink(prefix, action.client.kind, action.client.id)}` : "",
      "",
      "**Done when** the action is recorded as done or cancelled. Closing checks it.",
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n"),
    assignee: await teamAssignee(ctx, companyId),
    wakeReason: "A client has not answered a request",
    projectId: await clientProjectOf(ctx, companyId, action.client),
  });
  await saveAction(ctx, { ...action, escalatedAt: now.toISOString() });
  return true;
}

/** Done-check for the stale-client issue: the action was recorded as done or cancelled. */
export async function actionResolved(ctx: PluginContext, companyId: string, originId: string): Promise<{ done: true } | { done: false; missing: string[] }> {
  const id = originId.slice("crm:client-action-stale:".length);
  const action = await getAction(ctx, companyId, id);
  if (!action || action.status === "done" || action.status === "cancelled") return { done: true };
  return { done: false, missing: [`The request "${action.title}" (\`${action.id}\`) is still ${action.status === "replied" ? "waiting to be read" : "waiting on the client"}: reach the client, then record the outcome with \`update-client-action\` (done, or cancelled).`] };
}

// ---------------------------------------------------------------------------
// The Cockpit
// ---------------------------------------------------------------------------

/** Actions waiting on a client past their due date, or that the reminders did not move. Never red: the delay is the client's, not a fault. */
export async function clientActionsHealth(ctx: PluginContext, companyId: string, now = Date.now()): Promise<HealthCheck> {
  const waiting = [...(await listActionsByStatus(ctx, companyId, "waiting")), ...(await listActionsByStatus(ctx, companyId, "replied"))];
  const late = waiting.filter((action) => action.escalatedAt || (action.dueAt && Date.parse(action.dueAt) < now));
  if (late.length === 0) {
    return { key: "client-actions", title: "Waiting on clients", status: "ok", detail: waiting.length ? `${waiting.length} request${waiting.length === 1 ? "" : "s"} waiting on a client, none late.` : "Nothing is waiting on a client." };
  }
  return {
    key: "client-actions",
    title: "Waiting on clients",
    status: "warn",
    detail: `${late.length} client request${late.length === 1 ? " is" : "s are"} late or unanswered after the reminders: ${late.slice(0, 3).map((a) => a.title).join(", ")}${late.length > 3 ? "..." : ""}.`,
    href: "/crm",
    fix: "The Account Manager has an issue for each: reach the client another way, then record the outcome with update-client-action.",
    since: late.map((a) => a.requestedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
  };
}

/** Requests with replies nobody has read: a person is not needed, an agent is. Shown so they are not lost. */
export function repliedActionItems(actions: ClientAction[]): WaitingItem[] {
  return actions
    .filter((action) => action.status === "replied")
    .slice(0, 10)
    .map((action) => ({
      key: `client-action:${action.id}`,
      title: `Read the client's answer: ${action.title}`,
      why: "The client replied to a request. Reminders have stopped; someone must read the reply and record the outcome (update-client-action).",
      href: "/crm",
      kind: "judgement" as const,
      since: action.replyAt,
    }));
}

