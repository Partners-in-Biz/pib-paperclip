/**
 * Done-check for the "Reply needed" issues the Mailbox opens, one per Gmail
 * thread (origin `mailbox:reply:<accountId>:<threadId>`). The kit runs it when
 * an agent marks one done (`registerDoneChecks`); a person's close is never
 * checked.
 *
 * Done when the newest mail in the thread that still needs a reply has an
 * answer after it: a reply draft (`create-draft` with `replyToMessageId`,
 * also once queued or sent) or a sent message in the thread (sent from the
 * Mailbox or straight from Gmail). Also done when nothing in the thread needs
 * a reply any more: `correct-triage` set needsReply false or another category.
 *
 * The reconnect issue is a person's job (a Google sign-in) and has no check.
 */
import { RISK_THRESHOLDS, type DoneCheckIssue, type DoneCheckResult, type DoneCheckRule, type MailCategory } from "@partnersinbiz/pib-plugin-kit";
import type { GmailStore } from "./db.js";
import { REPLY_ISSUE_CATEGORIES } from "./gmail/triage.js";
import type { MessageRow } from "./gmail/types.js";

export const REPLY_ORIGIN_PREFIX = "mailbox:reply:";

/** `mailbox:reply:<accountId>:<threadId>`. */
export function replyOrigin(accountId: string, threadId: string): string {
  return `${REPLY_ORIGIN_PREFIX}${accountId}:${threadId}`;
}

export function parseReplyOrigin(originId: string | null | undefined): { accountId: string; threadId: string } | null {
  if (typeof originId !== "string" || !originId.startsWith(REPLY_ORIGIN_PREFIX)) return null;
  const rest = originId.slice(REPLY_ORIGIN_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { accountId: rest.slice(0, cut), threadId: rest.slice(cut + 1) };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** When a message arrived or was sent; a draft counts from when it was saved. */
function timeOf(row: MessageRow): number {
  return Date.parse(row.received_at ?? row.created_at) || 0;
}

/** Inbound mail that still asks for a written reply: the same test that opened the issue. */
export function needsReply(row: MessageRow): boolean {
  if (row.direction !== "inbound") return false;
  const category = row.category ?? row.triage?.category ?? null;
  if (!category || !REPLY_ISSUE_CATEGORIES.has(category as MailCategory)) return false;
  return num(row.needs_reply) >= RISK_THRESHOLDS.update && num(row.phishing) < 0.9 && !row.bulk;
}

/** Our answer in the thread: a draft, queued or sent reply. */
function isAnswer(row: MessageRow): boolean {
  return row.direction === "outbound" && (row.status === "draft" || row.status === "queued" || row.status === "sent");
}

/**
 * The newest message of this mailbox's thread that still needs a reply and has
 * no answer after it, or null when the thread is answered or needs none.
 */
export function unansweredMessage(rows: MessageRow[], accountId: string): MessageRow | null {
  const waiting = rows.filter((row) => row.account_id === accountId && needsReply(row)).sort((a, b) => timeOf(b) - timeOf(a))[0];
  if (!waiting) return null;
  const since = timeOf(waiting);
  return rows.some((row) => isAnswer(row) && timeOf(row) >= since) ? null : waiting;
}

export async function checkReplyThread(store: Pick<GmailStore, "replyThread">, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const ref = parseReplyOrigin(issue.originId);
  if (!ref) return { done: true };
  const waiting = unansweredMessage(await store.replyThread(issue.companyId, ref.threadId), ref.accountId);
  if (!waiting) return { done: true };
  const from = waiting.from_addr ? (waiting.from_addr.name ? `${waiting.from_addr.name} <${waiting.from_addr.email}>` : waiting.from_addr.email) : "the sender";
  return {
    done: false,
    missing: [
      `"${waiting.subject}" from ${from} still has no reply: draft one with \`create-draft\` (accountId \`${waiting.account_id}\`, replyToMessageId \`${waiting.id}\`), or \`correct-triage\` it with needsReply false when no reply is needed.`,
    ],
  };
}

/** The Mailbox's one kind of agent work: answering a thread. */
export function mailboxDoneChecks(store: Pick<GmailStore, "replyThread">): DoneCheckRule[] {
  return [{ originPrefix: REPLY_ORIGIN_PREFIX, label: "Reply needed", check: (issue) => checkReplyThread(store, issue) }];
}
