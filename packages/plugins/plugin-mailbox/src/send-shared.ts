/**
 * What the two ways of sending share (Gmail, `gmail/send.ts`, and the email provider, `esp/send.ts`): the answer a
 * send gives, the options a send takes, the attachment download and the domain warning. Moved here so neither
 * sender imports the other.
 */
import type { MailAttachmentRef, MailSendRequested, MailSendResult } from "@partnersinbiz/pib-plugin-kit";
import { sendingDomain } from "./dns.js";
import { senderDomainHealth } from "./domain-health.js";
import { errorMessage, type Env } from "./gmail/env.js";
import type { FetchLike } from "./gmail/api.js";
import type { MimeAttachment } from "./gmail/mime.js";
import type { AccountRow, SendRow, SkippedRecipient } from "./gmail/types.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "AttachmentError";
  }
}

/**
 * A send result; `suppressed` lists recipients left out because they are on the do-not-email list; `warnings`
 * says what is wrong with the sending domain's mail authentication (marketing sends only; it never blocks one
 * through Gmail). `provider` is set when the email provider took the message.
 */
export type SendResult = MailSendResult & { suppressed?: SkippedRecipient[]; warnings?: string[]; provider?: string };

export function resultFromRow(row: SendRow): SendResult {
  const skipped = row.skipped ?? [];
  const sent = row.status === "sent";
  return {
    key: row.key,
    status: sent ? "sent" : "failed",
    // A message the email provider took has the provider's id, prefixed so it is never mistaken for a Gmail id.
    messageId: row.provider_message_id ? `${row.provider}:${row.provider_message_id}` : row.gmail_message_id,
    threadId: row.gmail_thread_id,
    sentAt: row.sent_at,
    error: sent ? null : row.error,
    permanent: sent ? false : row.permanent,
    context: row.context,
    ...(skipped.length ? { suppressed: skipped } : {}),
    ...(sent && row.provider ? { provider: row.provider } : {}),
  };
}

export function failed(request: MailSendRequested, error: string, suppressed?: SkippedRecipient[]): SendResult {
  return { key: request.key, status: "failed", messageId: null, threadId: null, sentAt: null, error, permanent: true, context: request.context, ...(suppressed?.length ? { suppressed } : {}) };
}

export interface SendOptions {
  sourcePlugin: string;
  /** Manual retry or a draft: a failed request may be sent again. */
  force?: boolean;
  /** Draft sends update the draft row instead of adding one. */
  draftRowId?: string;
}

async function fetchAttachment(fetchImpl: FetchLike, ref: MailAttachmentRef): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let res: Response;
  try {
    res = await fetchImpl(ref.url, { method: "GET", signal: controller.signal });
  } catch (error) {
    throw new AttachmentError(`Attachment ${ref.filename} could not be downloaded: ${errorMessage(error)}`, false);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new AttachmentError(`Attachment ${ref.filename} could not be downloaded (HTTP ${res.status})${permanent ? "; the link may have expired" : ""}`, permanent);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function downloadAttachments(fetchImpl: FetchLike, refs: MailAttachmentRef[]): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  let total = 0;
  for (const ref of refs) {
    if (typeof ref.bytes === "number" && total + ref.bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("Attachments are larger than Gmail allows (25 MB)", true);
    }
    const content = await fetchAttachment(fetchImpl, ref);
    total += content.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachments are larger than Gmail allows (25 MB)", true);
    out.push({ filename: ref.filename, mime: ref.mime, content });
  }
  return out;
}

/** What is wrong with the sending domain's mail authentication, for a marketing send. Reads the last stored check; never blocks, never throws. */
export async function domainWarnings(env: Pick<Env, "store" | "now">, account: Pick<AccountRow, "company_id" | "address">, request: Pick<MailSendRequested, "marketing">): Promise<string[]> {
  if (request.marketing !== true) return [];
  try {
    const domain = sendingDomain(account.address);
    if (!domain) return [];
    const health = await senderDomainHealth(env.store, account.company_id, domain, env.now());
    return health.known && (health.status === "bad" || health.status === "warn") ? health.reasons.slice(0, 3) : [];
  } catch {
    return [];
  }
}
