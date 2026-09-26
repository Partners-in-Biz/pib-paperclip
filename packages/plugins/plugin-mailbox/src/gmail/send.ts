/**
 * Sending for every PiB plugin: `plugin.<sender>.mail.send.requested` →
 * Gmail `users.messages.send` → `mail.send.result`.
 *
 * - `receiveOnce` keyed by the request key; a repeat delivery re-emits the
 *   stored result. A claim on `send_requests` stops two deliveries sending
 *   the same message at once.
 * - Transient trouble (rate limit, Gmail down, account needs reconnecting)
 *   throws, so nothing is stored and the sender's outbox retries.
 * - No account, a bad address, an attachment that cannot be downloaded or a
 *   message Gmail refuses → `failed` with `permanent: true`.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, MAIL_EVENTS, receiveOnce, type MailAddress, type MailAttachmentRef, type MailSendRequested, type MailSendResult } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { GmailUnavailable, MailboxError, SendThrottled } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
import { getMessageMetadata, getThreadMetadata, GmailApiError, listMessages, modifyMessage, sendRaw, type FetchLike } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { headerMap, parseMessageIds, toMailAddress } from "./headers.js";
import { ensureLabelIds } from "./labels.js";
import { buildMime, htmlToText, messageIdFor, type MimeAttachment } from "./mime.js";
import { messageRowId } from "./sync.js";
import { withGmail } from "./tokens.js";
import type { AccountRow, SendContext, SendRecordInput, SendRow } from "./types.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SUFFIX = `.${MAIL_EVENTS.sendRequested}`;

export class AttachmentError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** `plugin.partnersinbiz.billing.mail.send.requested` → `partnersinbiz.billing`. */
export function senderOf(eventType: string): string | null {
  if (!eventType.startsWith("plugin.") || !eventType.endsWith(SUFFIX)) return null;
  return eventType.slice("plugin.".length, -SUFFIX.length) || null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function addressList(value: unknown, field: string, problems: string[]): MailAddress[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: MailAddress[] = [];
  for (const item of list) {
    const address = toMailAddress(item);
    if (!address) {
      problems.push(`Invalid ${field} address: ${typeof item === "string" ? item.slice(0, 120) : JSON.stringify(item)?.slice(0, 120)}`);
      continue;
    }
    if (!out.some((a) => a.email === address.email)) out.push(address);
  }
  return out;
}

export function isAllowedAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * Clean a request payload. Returns null without a key (nothing to answer);
 * otherwise the request plus the first problem that makes it unsendable.
 */
export function normaliseRequest(payload: unknown, sender: string): { request: MailSendRequested; problem: string | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const key = str(p.key, 300);
  if (!key) return null;
  const problems: string[] = [];
  const to = addressList(p.to, "to", problems);
  const cc = addressList(p.cc, "cc", problems);
  const bcc = addressList(p.bcc, "bcc", problems);
  const rawContext = (p.context && typeof p.context === "object" ? p.context : {}) as Record<string, unknown>;
  const context: SendContext = {
    plugin: str(rawContext.plugin, 120) ?? sender,
    kind: str(rawContext.kind, 120) ?? "mail",
    id: str(rawContext.id, 200) ?? key,
    clientKind: rawContext.clientKind === "contact" ? "contact" : rawContext.clientKind === "company" ? "company" : null,
    clientRef: str(rawContext.clientRef, 128),
  };
  const attachments: MailAttachmentRef[] = [];
  for (const item of Array.isArray(p.attachments) ? p.attachments : []) {
    const a = (item ?? {}) as Record<string, unknown>;
    const url = str(a.url, 4000);
    const filename = str(a.filename, 200) ?? "attachment";
    if (!url || !isAllowedAttachmentUrl(url)) {
      problems.push(`Attachment ${filename} has no https URL`);
      continue;
    }
    attachments.push({ url, filename, mime: str(a.mime, 200) ?? "application/octet-stream", bytes: typeof a.bytes === "number" ? a.bytes : undefined });
  }
  const request: MailSendRequested = {
    key,
    from: str(p.from, 320),
    to,
    cc,
    bcc,
    subject: typeof p.subject === "string" ? p.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 900) : "",
    html: typeof p.html === "string" && p.html.trim() ? p.html : null,
    text: typeof p.text === "string" && p.text.trim() ? p.text : null,
    attachments,
    threadId: str(p.threadId, 200),
    inReplyToMessageId: str(p.inReplyToMessageId, 1000),
    context,
    labels: (Array.isArray(p.labels) ? p.labels : []).map((l) => str(l, 200)).filter((l): l is string => Boolean(l)).slice(0, 10),
  };
  if (to.length + cc.length + bcc.length === 0 && problems.length === 0) problems.push("The message has no recipients");
  if (!request.html && !request.text) problems.push("The message has no body");
  if (request.from && !toMailAddress(request.from)) problems.push(`Invalid from address: ${request.from}`);
  return { request, problem: problems[0] ?? null };
}

export function resultFromRow(row: SendRow): MailSendResult {
  return {
    key: row.key,
    status: row.status === "sent" ? "sent" : "failed",
    messageId: row.gmail_message_id,
    threadId: row.gmail_thread_id,
    sentAt: row.sent_at,
    error: row.status === "sent" ? null : row.error,
    permanent: row.status === "sent" ? false : row.permanent,
    context: row.context,
  };
}

function failed(request: MailSendRequested, error: string): MailSendResult {
  return { key: request.key, status: "failed", messageId: null, threadId: null, sentAt: null, error, permanent: true, context: request.context };
}

async function pickAccount(env: Env, companyId: string, from: string | null | undefined): Promise<AccountRow | null> {
  if (from) {
    const email = toMailAddress(from)?.email;
    if (!email) return null;
    const account = await env.store.findAccountByAddress(companyId, email);
    return account && account.token_sealed && (account.status === "connected" || account.status === "needs_reconnect") ? account : null;
  }
  return env.store.defaultAccount(companyId);
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

interface Threading {
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
}

/** Follow-up in a thread without a message to answer: reply to the thread's newest message. */
async function threadFollowUp(env: Env, loaded: LoadedConfig, account: AccountRow, threadId: string): Promise<Threading> {
  const last = await env.store.latestInThread(account.company_id, threadId);
  if (last?.rfc_message_id) {
    return { threadId, inReplyTo: last.rfc_message_id, references: [...(last.refs ?? []), last.rfc_message_id].slice(-20) };
  }
  try {
    const messages = await withGmail(env, loaded, account, (token) => getThreadMetadata(env.fetch, token, threadId));
    const newest = messages[messages.length - 1];
    const headers = headerMap(newest?.payload?.headers);
    const rfc = parseMessageIds(headers.get("message-id"))[0] ?? null;
    return { threadId, inReplyTo: rfc, references: [...parseMessageIds(headers.get("references")), ...(rfc ? [rfc] : [])].slice(-20) };
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return { threadId: null, inReplyTo: null, references: [] };
    throw error;
  }
}

async function threadingFor(env: Env, loaded: LoadedConfig, account: AccountRow, request: MailSendRequested): Promise<Threading> {
  const ref = request.inReplyToMessageId?.trim();
  if (!ref) return request.threadId ? threadFollowUp(env, loaded, account, request.threadId) : { threadId: null, inReplyTo: null, references: [] };
  const companyId = account.company_id;
  if (/^<[^<>\s]+>$/.test(ref)) {
    const stored = await env.store.getMessageByRfcId(companyId, ref);
    return { threadId: request.threadId ?? stored?.gmail_thread_id ?? null, inReplyTo: ref, references: [...(stored?.refs ?? []), ref].slice(-20) };
  }
  const stored = (await env.store.getMessageByGmailId(companyId, ref)) ?? (await env.store.getMessage(companyId, ref));
  if (stored?.rfc_message_id) {
    return {
      threadId: request.threadId ?? stored.gmail_thread_id ?? null,
      inReplyTo: stored.rfc_message_id,
      references: [...(stored.refs ?? []), stored.rfc_message_id].slice(-20),
    };
  }
  const gmailId = stored?.gmail_message_id ?? ref;
  try {
    const original = await withGmail(env, loaded, account, (token) => getMessageMetadata(env.fetch, token, gmailId, ["Message-ID", "References"]));
    const headers = headerMap(original.payload?.headers);
    const rfc = parseMessageIds(headers.get("message-id"))[0] ?? null;
    return {
      threadId: request.threadId ?? original.threadId ?? null,
      inReplyTo: rfc,
      references: [...parseMessageIds(headers.get("references")), ...(rfc ? [rfc] : [])].slice(-20),
    };
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return { threadId: request.threadId ?? null, inReplyTo: null, references: [] };
    throw error;
  }
}

function isPermanentGmail(error: unknown): boolean {
  return error instanceof GmailApiError && !error.retryable && !error.reconnect && (error.status === 400 || error.status === 413 || error.status === 404);
}

export interface SendOptions {
  sourcePlugin: string;
  /** Manual retry or a draft: a failed request may be sent again. */
  force?: boolean;
  /** Draft sends update the draft row instead of adding one. */
  draftRowId?: string;
}

/** Send one request. Throws on transient trouble; returns `failed` only when retrying will not help. */
export async function performSend(env: Env, companyId: string, request: MailSendRequested, options: SendOptions, problem: string | null = null): Promise<MailSendResult> {
  const before = await env.store.getSend(companyId, request.key);
  if (before?.status === "sent") return resultFromRow(before);
  if (before?.status === "failed" && before.permanent && !options.force) return resultFromRow(before);

  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const account = await pickAccount(env, companyId, request.from);
  const record: SendRecordInput = {
    key: request.key,
    companyId,
    sourcePlugin: options.sourcePlugin,
    accountId: account?.id ?? null,
    fromAddress: account?.address ?? request.from ?? null,
    to: request.to,
    subject: request.subject,
    context: request.context,
    request,
  };
  const permanentProblem =
    problem ??
    (!account
      ? request.from
        ? `No connected Gmail account for ${request.from} in Mailbox`
        : "No Gmail account is connected in Mailbox"
      : null);
  if (permanentProblem) {
    await env.store.recordSendFailure(record, permanentProblem, true);
    return failed(request, permanentProblem);
  }
  const sender = account!;
  if (sender.status === "needs_reconnect") {
    const message = `Gmail for ${sender.address} must be reconnected before mail can be sent`;
    await env.store.markRetrying(record, message);
    throw new GmailUnavailable(message);
  }
  if ((await env.store.recentClaims(sender.id)) >= loaded.config.sendRatePerMinute) {
    throw new SendThrottled(`Send limit reached (${loaded.config.sendRatePerMinute} per minute for ${sender.address}); try again shortly`);
  }
  if (!(await env.store.claimSend(record, Boolean(options.force)))) {
    const row = await env.store.getSend(companyId, request.key);
    // Only a sent or a permanently failed result is ever answered; anything else waits for the retry.
    if (row && (row.status === "sent" || (row.status === "failed" && row.permanent && !options.force))) return resultFromRow(row);
    throw new MailboxError("This message is already being sent");
  }

  const rfcMessageId = messageIdFor(request.key, sender.address);
  let sent: { id: string; threadId: string; labelIds: string[] } | null = null;
  try {
    // A retry after an attempt that may have reached Gmail (timeout, crash): look for it before sending again.
    if (before && (before.status === "sending" || before.status === "retrying") && before.attempts > 0) {
      const found = await withGmail(env, loaded, sender, (token) => listMessages(env.fetch, token, `rfc822msgid:${rfcMessageId}`, { maxResults: 1 }));
      if (found.messages[0]) sent = { id: found.messages[0].id, threadId: found.messages[0].threadId, labelIds: [] };
    }
    if (!sent) sent = await sendNow(env, loaded, sender, request, rfcMessageId);
  } catch (error) {
    const message = errorMessage(error);
    if ((error instanceof AttachmentError && error.permanent) || isPermanentGmail(error)) {
      await env.store.recordSendFailure(record, message, true);
      return failed(request, message);
    }
    await env.store.markRetrying(record, message).catch(() => undefined);
    throw error;
  }
  // Gmail has the message now. A failure below leaves the claim in place (never "retrying"), so a
  // later delivery finds the sent message by its Message-ID instead of sending it again.
  return finishSent(env, loaded, sender, request, options, sent, rfcMessageId);
}

async function sendNow(env: Env, loaded: LoadedConfig, sender: AccountRow, request: MailSendRequested, rfcMessageId: string) {
  const attachments = await downloadAttachments(env.fetch, request.attachments ?? []);
  const thread = await threadingFor(env, loaded, sender, request);
  const mime = buildMime({
    from: { email: sender.address, name: loaded.config.fromName },
    to: request.to,
    cc: request.cc ?? [],
    bcc: request.bcc ?? [],
    subject: request.subject,
    text: request.text,
    html: request.html,
    attachments,
    messageId: rfcMessageId,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    date: new Date(env.now()),
  });
  return withGmail(env, loaded, sender, (token) => sendRaw(env.fetch, token, mime, thread.threadId));
}

async function finishSent(
  env: Env,
  loaded: LoadedConfig,
  account: AccountRow,
  request: MailSendRequested,
  options: SendOptions,
  sent: { id: string; threadId: string; labelIds: string[] },
  generatedRfcId: string,
): Promise<MailSendResult> {
  let rfcMessageId: string | null = generatedRfcId;
  let labelIds = sent.labelIds;
  try {
    const meta = await withGmail(env, loaded, account, (token) => getMessageMetadata(env.fetch, token, sent.id, ["Message-ID"]));
    rfcMessageId = parseMessageIds(headerMap(meta.payload?.headers).get("message-id"))[0] ?? generatedRfcId;
    labelIds = meta.labelIds.length > 0 ? meta.labelIds : labelIds;
  } catch (error) {
    env.ctx.logger.info("Sent message header lookup failed", { key: request.key, error: errorMessage(error) });
  }
  if (request.labels && request.labels.length > 0) {
    try {
      const added = await withGmail(env, loaded, account, async (token) => {
        const ids = await ensureLabelIds(env.fetch, env.store, account, token, request.labels!);
        const wanted = Object.values(ids);
        return wanted.length > 0 ? modifyMessage(env.fetch, token, sent.id, wanted) : labelIds;
      });
      if (added.length > 0) labelIds = added;
    } catch (error) {
      env.ctx.logger.info("Labels not added to sent mail", { key: request.key, error: errorMessage(error) });
    }
  }
  const fields = { gmailMessageId: sent.id, gmailThreadId: sent.threadId || sent.id, rfcMessageId, accountId: account.id, fromAddress: account.address };
  await env.store.markSendSent(request.key, fields);
  if (options.draftRowId) {
    try {
      await env.store.markDraftSent(account.company_id, options.draftRowId, { ...fields, context: request.context, sendKey: request.key });
    } catch (error) {
      env.ctx.logger.info("Draft row not updated after send", { key: request.key, error: errorMessage(error) });
    }
  } else {
    await env.store
      .insertGmailMessage({
        id: messageRowId(account.id, sent.id),
        companyId: account.company_id,
        accountId: account.id,
        direction: "outbound",
        status: "sent",
        subject: request.subject || "(no subject)",
        gmailMessageId: sent.id,
        gmailThreadId: fields.gmailThreadId,
        rfcMessageId,
        inReplyTo: null,
        refs: [],
        from: { email: account.address, name: loaded.config.fromName },
        to: request.to,
        cc: request.cc ?? [],
        bcc: request.bcc ?? [],
        snippet: (request.text ?? (request.html ? htmlToText(request.html) : "")).replace(/\s+/g, " ").slice(0, 200),
        labels: labelIds,
        attachments: [],
        bulk: false,
        receivedAt: new Date(env.now()).toISOString(),
        read: true,
        sentContext: request.context,
        sendKey: request.key,
        triaged: true,
      })
      .catch((error: unknown) => env.ctx.logger.info("Sent message row not stored", { key: request.key, error: errorMessage(error) }));
  }
  return {
    key: request.key,
    status: "sent",
    messageId: sent.id,
    threadId: fields.gmailThreadId,
    sentAt: new Date(env.now()).toISOString(),
    error: null,
    permanent: false,
    context: request.context,
  };
}

/** Event handler for `plugin.<sender>.mail.send.requested`. */
export const MAILBOX_OFF = "The Mailbox is switched off for this company. Turn it on in Setup, then retry the send from the Mailbox.";

export async function handleSendRequested(env: Env, event: PluginEvent): Promise<MailSendResult | null> {
  const sender = senderOf(event.eventType) ?? "unknown";
  const companyId = event.companyId;
  const normalised = normaliseRequest(event.payload, sender);
  if (!companyId || !normalised) {
    env.ctx.logger.info("Ignored a mail send request without a key or company", { eventType: event.eventType });
    return null;
  }
  const { request } = normalised;
  // Switched off in Setup: answer at once so the sender hands the mail to a person.
  const problem = (await isModuleEnabled(env.ctx, companyId, PLUGIN_ID)) ? normalised.problem : MAILBOX_OFF;
  try {
    const { result } = await receiveOnce(env.ctx, companyId, event.eventType, request.key, () =>
      performSend(env, companyId, request, { sourcePlugin: sender }, problem).then((r) => r as unknown as Record<string, unknown>),
    );
    const out = result as unknown as MailSendResult;
    await env.ctx.events.emit(MAIL_EVENTS.sendResult, companyId, out);
    return out;
  } catch (error) {
    // Nothing stored: the sender's outbox asks again later.
    env.ctx.logger.info("Mail send deferred", { key: request.key, sender, error: errorMessage(error) });
    return null;
  }
}

/** Board action: send a failed or waiting request again and tell the sender. */
export async function retrySend(env: Env, companyId: string, key: string): Promise<MailSendResult> {
  const row = await env.store.getSend(companyId, key);
  if (!row) throw new MailboxError("Send request not found");
  if (row.status === "sent") return resultFromRow(row);
  const normalised = normaliseRequest(row.request, row.source_plugin);
  if (!normalised) throw new MailboxError("The stored request cannot be read");
  const result = await performSend(env, companyId, normalised.request, { sourcePlugin: row.source_plugin, force: true }, normalised.problem);
  await env.store.setInboxResult(key, result as unknown as Record<string, unknown>);
  if (row.source_plugin !== PLUGIN_ID) await env.ctx.events.emit(MAIL_EVENTS.sendResult, companyId, result);
  return result;
}
