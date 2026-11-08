/**
 * One reply per message (PAR-8030). An agent that calls create-draft twice for
 * the same message leaves two drafts; once one is sent, the other stays in the
 * Drafts tab with a Send button and would send the answer a second time.
 *
 * - create-draft reuses an open reply draft saved in the last minute,
 * - send-draft refuses a draft when a reply to the same message was sent after
 *   that draft was saved (it is a leftover copy),
 * - after a send, the other open drafts answering that message are deleted.
 */
import type { MessageRow } from "./gmail/types.js";

/** A second create-draft for the same message within this time returns the first draft. */
export const REPLY_REUSE_WINDOW_MS = 60_000;

/** What the checks need from the store. */
export interface ReplyDraftStore {
  /** Outbound mail on one mailbox answering one message (drafts, queued and sent), newest first. */
  replyDrafts(companyId: string, accountId: string, replyToMessageId: string): Promise<MessageRow[]>;
  /** Removes a draft that has not been sent; false when there is none. */
  deleteDraft(companyId: string, id: string): Promise<boolean>;
}

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/** The open draft (not queued, not sent) saved within the reuse window, newest first; null when there is none. */
export function reusableReplyDraft(rows: MessageRow[], now = Date.now()): MessageRow | null {
  for (const row of rows) {
    if (row.direction !== "outbound" || row.status !== "draft") continue;
    const at = toMs(row.created_at);
    if (Number.isFinite(at) && now - at <= REPLY_REUSE_WINDOW_MS && at <= now + 1_000) return row;
  }
  return null;
}

/**
 * A reply to the same message that was sent after `draft` was saved: `draft` is a leftover copy.
 * A sent row without a send time counts as newer (refusing a copy is safer than sending it twice).
 */
export function newerSentReply(rows: MessageRow[], draft: MessageRow): MessageRow | null {
  const savedAt = toMs(draft.created_at);
  for (const row of rows) {
    if (row.id === draft.id || row.direction !== "outbound" || row.status !== "sent") continue;
    const sentAt = toMs(row.received_at);
    if (!Number.isFinite(sentAt) || !Number.isFinite(savedAt) || sentAt >= savedAt) return row;
  }
  return null;
}

/** After `sentId` went out: deletes the other open drafts answering the same message. Returns their ids. */
export async function removeSupersededDrafts(store: ReplyDraftStore, companyId: string, accountId: string, replyToMessageId: string, sentId: string): Promise<string[]> {
  const rows = await store.replyDrafts(companyId, accountId, replyToMessageId);
  const removed: string[] = [];
  for (const row of rows) {
    if (row.id === sentId || row.direction !== "outbound" || row.status !== "draft") continue;
    // deleteDraft only removes a row that is still a draft: one queued for sending meanwhile stays.
    if (await store.deleteDraft(companyId, row.id)) removed.push(row.id);
  }
  return removed;
}
