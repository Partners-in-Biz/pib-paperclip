/**
 * What a person does with a mail they opened on the Mailbox page: delete it, or start a reply, a reply to all or a
 * forward. A person only: no agent tool reaches these.
 *
 * Deleting moves the mail to the Bin in Gmail (Google keeps it there for 30 days, so it can be restored) and removes it
 * from the hub. Replying opens a normal draft, so the recipients, the text and the files can all be changed and nothing
 * goes out until someone clicks Send.
 */
import { randomUUID } from "node:crypto";
import type { MailAddress } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig } from "./config.js";
import { MAX_DRAFT_FILE_BYTES, MAX_DRAFT_FILES, MAX_DRAFT_FILES_TOTAL_BYTES } from "./draft-edit.js";
import { MailboxError } from "./domain.js";
import { GmailApiError, trashGmailMessage } from "./gmail/api.js";
import { downloadAttachment } from "./gmail/attachments.js";
import { errorMessage, type Env } from "./gmail/env.js";
import { readMessageBody } from "./gmail/read.js";
import { withGmail } from "./gmail/tokens.js";
import type { DraftFile, MessageRow } from "./gmail/types.js";

export const MAX_DELETE_AT_ONCE = 100;
const QUOTE_MAX_CHARS = 20_000;

export type ReplyMode = "reply" | "reply_all" | "forward";

export function replyMode(value: unknown): ReplyMode {
  if (value === "reply" || value === "reply_all" || value === "forward") return value;
  throw new MailboxError("Choose reply, reply all or forward");
}

/** `Re: ` or `Fwd: `, once. */
export function replySubject(subject: string, mode: ReplyMode): string {
  const clean = subject.trim() || "(no subject)";
  if (mode === "forward") return /^(fwd?|fw):/i.test(clean) ? clean : `Fwd: ${clean}`;
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

function withoutRepeats(rows: MailAddress[], skip: Set<string>): MailAddress[] {
  const seen = new Set(skip);
  const out: MailAddress[] = [];
  for (const row of rows) {
    const key = row.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Who a reply goes to. Reply-To wins over From (a website form relays the visitor that way). Reply all adds the other
 * people on the mail and never the mailbox itself. A reply to mail this mailbox sent goes to the original recipients.
 * A forward starts empty: the person chooses.
 */
export function replyRecipients(row: Pick<MessageRow, "direction" | "from_addr" | "reply_to_addr" | "to_addrs" | "cc_addrs">, ownAddress: string, mode: ReplyMode): { to: MailAddress[]; cc: MailAddress[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const own = ownAddress.toLowerCase();
  const others = row.to_addrs ?? [];
  const sender = row.reply_to_addr ?? row.from_addr;
  const to = withoutRepeats(row.direction === "outbound" ? others : sender ? [sender] : [], new Set([own]));
  if (mode === "reply") return { to, cc: [] };
  const taken = new Set([own, ...to.map((a) => a.email.toLowerCase())]);
  return { to, cc: withoutRepeats([...(row.direction === "outbound" ? [] : others), ...(row.cc_addrs ?? [])], taken) };
}

function person(address: MailAddress | null | undefined): string {
  if (!address) return "unknown sender";
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/** The start text of a reply or a forward: an empty first line to type on, then the original. */
export function quotedText(row: Pick<MessageRow, "from_addr" | "to_addrs" | "subject" | "received_at" | "created_at">, text: string, mode: ReplyMode): string {
  const when = row.received_at ?? row.created_at;
  const date = when ? new Date(String(when)).toUTCString() : "";
  if (mode === "forward") {
    return [
      "",
      "",
      "---------- Forwarded message ---------",
      `From: ${person(row.from_addr)}`,
      ...(date ? [`Date: ${date}`] : []),
      `Subject: ${row.subject || "(no subject)"}`,
      ...((row.to_addrs ?? []).length ? [`To: ${(row.to_addrs ?? []).map(person).join(", ")}`] : []),
      "",
      text,
    ].join("\n");
  }
  const quoted = text.split("\n").map((line) => `> ${line}`).join("\n");
  return ["", "", `On ${date || "an earlier date"}, ${person(row.from_addr)} wrote:`, quoted].join("\n");
}

export interface DeleteResult {
  deleted: number;
  /** Mail that stayed, and why. */
  failed: Array<{ id: string; subject: string; error: string }>;
}

/**
 * Moves mail to the Bin in Gmail, then takes it out of the hub. When Gmail says no the mail stays in both places, so what
 * the page shows never disagrees with Gmail. Mail that is already gone from Gmail is only taken out of the hub.
 */
export async function deleteMail(env: Env, companyId: string, ids: string[]): Promise<DeleteResult> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) throw new MailboxError("Choose the mail to delete");
  if (unique.length > MAX_DELETE_AT_ONCE) throw new MailboxError(`Delete at most ${MAX_DELETE_AT_ONCE} at once`);
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const result: DeleteResult = { deleted: 0, failed: [] };
  const gone: string[] = [];
  for (const id of unique) {
    const row = await env.store.getMessage(companyId, id);
    if (!row) continue; // already deleted, for example from another tab
    try {
      if (row.gmail_message_id) {
        const account = await env.store.getAccount(companyId, row.account_id);
        if (!account?.token_sealed) throw new MailboxError("Connect Gmail for this mailbox first");
        await withGmail(env, loaded, account, (token) => trashGmailMessage(env.fetch, token, row.gmail_message_id!)).catch((error: unknown) => {
          if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
        });
      }
      gone.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, subject: row.subject, error: errorMessage(error) });
    }
  }
  if (gone.length) result.deleted = await env.store.deleteMessages(companyId, gone);
  env.ctx.logger.info("Mail deleted by a person", { deleted: result.deleted, failed: result.failed.length });
  return result;
}

/** A forward carries the original's files as far as they fit on a draft. What does not fit is named, not dropped silently. */
async function forwardedFiles(env: Env, companyId: string, row: MessageRow): Promise<{ files: DraftFile[]; skipped: string[] }> {
  const files: DraftFile[] = [];
  const skipped: string[] = [];
  const attachments = row.attachments ?? [];
  if (!attachments.length) return { files, skipped };
  const account = await env.store.getAccount(companyId, row.account_id);
  if (!account?.token_sealed) return { files, skipped: attachments.map((a) => a.filename) };
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  let total = 0;
  for (const meta of attachments) {
    const fits = meta.bytes <= MAX_DRAFT_FILE_BYTES && total + meta.bytes <= MAX_DRAFT_FILES_TOTAL_BYTES && files.length < MAX_DRAFT_FILES;
    if (!fits) {
      skipped.push(meta.filename);
      continue;
    }
    try {
      const bytes = await downloadAttachment(env, loaded, account, row, meta);
      total += bytes.length;
      files.push({ id: randomUUID(), name: meta.filename, mime: meta.mime || "application/octet-stream", bytes: bytes.length, data: Buffer.from(bytes).toString("base64") });
    } catch (error) {
      env.ctx.logger.info("Forward: a file could not be fetched", { messageId: row.id, error: errorMessage(error) });
      skipped.push(meta.filename);
    }
  }
  return { files, skipped };
}

export interface StartReplyDeps {
  isPrivate: (row: MessageRow) => Promise<boolean>;
  insertDraft: (row: { id: string; companyId: string; accountId: string; subject: string; body: string; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; draft: Record<string, unknown> }) => Promise<unknown>;
}

/** Saves the draft for a reply, a reply to all or a forward and returns its id. Nothing is sent. */
export async function startReply(env: Env, companyId: string, userId: string, messageId: string, mode: ReplyMode, deps: StartReplyDeps): Promise<{ id: string; skippedFiles: string[] }> {
  const row = await env.store.getMessage(companyId, messageId);
  if (!row) throw new MailboxError("Message not found");
  const account = await env.store.getAccount(companyId, row.account_id);
  if (!account) throw new MailboxError("Mailbox not found");

  // A private message (a signing link) is never copied into a new mail; the person writes the text themselves.
  const isPrivate = await deps.isPrivate(row);
  let text = "";
  if (!isPrivate) {
    text = row.snippet ?? row.body ?? "";
    if (row.gmail_message_id && account.token_sealed) {
      try {
        const loaded = await loadMailboxConfig(env.ctx, companyId);
        text = (await readMessageBody(env, loaded, account, row.gmail_message_id, QUOTE_MAX_CHARS)).text;
      } catch (error) {
        env.ctx.logger.info("Reply: the original could not be read, using its snippet", { messageId: row.id, error: errorMessage(error) });
      }
    }
  }
  const { to, cc } = replyRecipients(row, account.address, mode);
  const forwarded = mode === "forward" && !isPrivate ? await forwardedFiles(env, companyId, row) : { files: [], skipped: [] };
  const id = randomUUID();
  await deps.insertDraft({
    id,
    companyId,
    accountId: row.account_id,
    subject: replySubject(row.subject, mode),
    body: isPrivate ? "" : quotedText(row, text, mode),
    to,
    cc,
    bcc: [],
    draft: {
      html: null,
      replyToMessageId: mode === "forward" ? null : row.id,
      threadId: mode === "forward" ? null : row.gmail_thread_id,
      by: { kind: "user", id: userId },
      replyTo: null,
      fromName: null,
      ...(forwarded.files.length ? { files: forwarded.files } : {}),
    },
  });
  return { id, skippedFiles: forwarded.skipped };
}
