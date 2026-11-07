/**
 * Give to agent (PAR-8137): a person hands a mail or a thread to an agent through the host's New Task popup.
 *
 * `prepare` builds the popup's prefill: the subject as title, the client's project (or none, said out loud, when no
 * client matched) and a description with the person's words on top and the mail text fenced as data under them.
 * `record` runs after the person created the task: it re-checks that the task sits in the mail's client's project
 * (and otherwise cancels it and takes the mail text out), records the link, and warns when the agent can't use it.
 * The hand-off grants nothing: replies still go through the Mailbox's draft and send path and its Tier rules.
 */
import { buildHandoffDescription, handoffTitle, HANDOFF_DEFAULT_CAP, isLocalAgent, isRunnableAgent } from "@partnersinbiz/pib-plugin-kit/handoff";
import { MailboxError } from "./domain.js";
import type { MessageRow } from "./gmail/types.js";

export type HandoffScope = "message" | "thread";
type Client = { kind: string; id: string };

export interface HandoffDeps {
  findMessage(id: string): Promise<MessageRow | null>;
  threadMessages(threadId: string): Promise<MessageRow[]>;
  isPrivate(row: MessageRow): Promise<boolean>;
  bodyOf(row: MessageRow, maxChars: number): Promise<string>;
  projectFor(client: Client): Promise<string | null>;
  clientProjects(client: Client): Promise<string[]>;
  getIssue(id: string): Promise<{ id: string; identifier?: string | null; projectId?: string | null; assigneeAgentId?: string | null; description?: string | null } | null>;
  cancelIssue(id: string, description: string): Promise<void>;
  getAgent(id: string): Promise<{ name: string; status: string; adapterType: string } | null>;
  mayRead(accountId: string, agentId: string): Promise<boolean>;
  saveLink(row: MessageRow, scope: HandoffScope, issueId: string): Promise<void>;
}

export const HANDOFF_CAP = HANDOFF_DEFAULT_CAP;
const THREAD_MAX = 20;
export const NO_CLIENT_NOTE = "No client match: this mail isn't filed under a client, so no project was picked. Pick one only if you know whose work it is.";
export const SEND_FOOTER = "This hand-off gives no right to send mail. Any reply goes through the Mailbox's normal path: a draft, then a person or the mailbox's Tier rules send it.";
const PRIVATE_NOTE = "(This message's text is private client mail and is not handed over.)";

function clientOf(row: MessageRow): Client | null {
  return row.client_kind && row.client_ref ? { kind: row.client_kind, id: row.client_ref } : null;
}
const sameClient = (a: Client | null, b: Client | null) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.id ?? null) === (b?.id ?? null);
const when = (row: MessageRow) => row.received_at ?? row.created_at ?? "";
const fromOf = (row: MessageRow) => (row.from_addr ? `${row.from_addr.name ? `${row.from_addr.name} <${row.from_addr.email}>` : row.from_addr.email}` : "");

/** The message and, for a thread, every message in it (oldest first). A thread that mixes clients is refused. */
async function rowsFor(deps: HandoffDeps, messageId: string, scope: HandoffScope) {
  const row = await deps.findMessage(messageId);
  if (!row) throw new MailboxError("Message not found");
  if (scope === "message" || !row.gmail_thread_id) return { row, rows: [row] };
  const rows = (await deps.threadMessages(row.gmail_thread_id)).filter((r) => r.status !== "draft" && r.id);
  if (!rows.some((r) => r.id === row.id)) rows.push(row);
  rows.sort((a, b) => when(a).localeCompare(when(b)));
  if (rows.some((r) => clientOf(r) && !sameClient(clientOf(r), clientOf(row)))) {
    throw new MailboxError("This thread has mail filed under different clients, so it can't go to one task. Give one message instead.");
  }
  return { row, rows: rows.slice(-THREAD_MAX) };
}

async function textFor(deps: HandoffDeps, rows: MessageRow[], scope: HandoffScope): Promise<string> {
  const parts: string[] = [];
  let length = 0;
  for (const r of rows) {
    if (length > HANDOFF_CAP) break;
    const body = (await deps.isPrivate(r)) ? PRIVATE_NOTE : await deps.bodyOf(r, HANDOFF_CAP + 1);
    const part = scope === "thread" ? `----- ${fromOf(r) || "(unknown sender)"} · ${when(r)} · message ${r.id}\n${body}` : body;
    parts.push(part);
    length += part.length + 2;
  }
  return parts.join("\n\n");
}

export async function prepareHandoff(deps: HandoffDeps, params: { messageId: string; scope: HandoffScope; link?: string | null; clientName?: string | null }) {
  const { row, rows } = await rowsFor(deps, params.messageId, params.scope);
  const client = clientOf(row);
  const projectId = client ? await deps.projectFor(client) : null;
  const clientName = (row as { triage?: { clientName?: string | null } | null }).triage?.clientName ?? params.clientName ?? null;
  const clientLine = !client ? NO_CLIENT_NOTE : projectId ? null : `${clientName ?? "This client"} has no project linked, so no project was picked. Link one in the CRM, or pick theirs here.`;
  const link = safeLink(params.link);
  const attachments = rows.flatMap((r) => (r.attachments ?? []).map((a) => `${a.filename} (${Math.max(1, Math.round(a.bytes / 1024))} KB, message ${r.id}, attachment ${a.attachmentId})`));
  const description = buildHandoffDescription({
    source: {
      kind: params.scope === "thread" ? `Mail thread (${rows.length} message${rows.length === 1 ? "" : "s"})` : "Mail",
      link,
      meta: [
        ["From", fromOf(row)],
        ["Date", when(row)],
        ["Subject", row.subject ?? ""],
        ["Client", client ? clientName ?? `${client.kind}:${client.id}` : "none matched"],
        ["Thread id", row.gmail_thread_id ?? ""],
        ["Message id", row.id],
      ],
    },
    receivedText: await textFor(deps, rows, params.scope),
    capChars: HANDOFF_CAP,
    readMore: `the mail link above, or the Mailbox get-message tool (messageId ${row.id})`,
    extra: [
      ...(clientLine ? [`**${clientLine}**`] : []),
      ...(attachments.length
        ? ["Files on this mail (not copied into the task). Fetch one with the Mailbox get-attachment tool, which needs read access on this mailbox:", ...attachments.map((a) => `- ${a.replace(/[\r\n`]/g, " ")}`)]
        : []),
    ],
    footer: [SEND_FOOTER],
  });
  return { title: handoffTitle("Mail: ", row.subject), description, projectId: projectId ?? undefined, clientMatched: Boolean(client), note: clientLine };
}

export async function recordHandoff(deps: HandoffDeps, params: { messageId: string; scope: HandoffScope; issueId: string }) {
  const row = await deps.findMessage(params.messageId);
  if (!row) throw new MailboxError("Message not found");
  const issue = await deps.getIssue(params.issueId);
  if (!issue) throw new MailboxError("That task isn't in this company.");
  if (!(issue.description ?? "").includes(row.id)) throw new MailboxError("That task isn't a hand-off of this mail, so it was not linked.");
  const client = clientOf(row);
  if (client) {
    const theirs = await deps.clientProjects(client);
    if (!issue.projectId || !theirs.includes(issue.projectId)) {
      const name = issue.identifier ?? issue.id;
      await deps.cancelIssue(issue.id, `Cancelled by the Mailbox: this task was not in the mail's client's project, so the mail text was taken out. Give the mail to an agent again and keep the client's project.`);
      throw new MailboxError(`${name} is not in this client's project, so the Mailbox cancelled it and took the mail text out. A client's mail only goes on that client's work. Try again with their project.`);
    }
  }
  await deps.saveLink(row, params.scope, issue.id);
  let warning: string | null = null;
  if (issue.assigneeAgentId) {
    const agent = await deps.getAgent(issue.assigneeAgentId);
    if (!agent) warning = "The assigned agent could not be read.";
    else if (!isRunnableAgent(agent.status)) warning = `${agent.name} is ${agent.status.replace(/_/g, " ")}, so it won't pick this up.`;
    else if (!isLocalAgent(agent.adapterType)) warning = `${agent.name} runs off this server (${agent.adapterType}), so it can't use the Mailbox tools.`;
    else if (!(await deps.mayRead(row.account_id, issue.assigneeAgentId))) warning = `${agent.name} may not read this mailbox, so it can only use what is in the task. Give it read access on the Mailboxes tab if it needs more.`;
  }
  return { linked: true, issueId: issue.id, message: `${issue.identifier ?? "The task"} created and linked to this mail.`, warning };
}

/** Only a plain http(s) or site-relative link goes into the task. */
function safeLink(value: string | null | undefined): string | null {
  const link = (value ?? "").trim();
  if (!link || /[\s<>`]/.test(link)) return null;
  return /^https?:\/\//i.test(link) || link.startsWith("/") ? link : null;
}
