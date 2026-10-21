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
 * - The do-not-email list (`suppression.ts`): marketing sends leave out every
 *   suppressed address and carry List-Unsubscribe; any send leaves out hard
 *   bounces. No recipient left → `failed`, `permanent: true`, with the
 *   `suppressed` addresses so the sender stops for good.
 * - Which sender takes a request (`pick-sender.ts`): the account its `from` names, else the company's default
 *   Gmail account. A request whose sender is a send-only account of the email provider (0.6.0) goes to
 *   `esp/send.ts` instead, which answers with the same `mail.send.result`; nothing changes for a request that names
 *   no provider account.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, MAIL_EVENTS, OWN_SENDER, receiveOnce, type MailAddress, type MailAttachmentRef, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { GmailUnavailable, MailboxError, SendThrottled } from "../domain.js";
import { performEspSend } from "../esp/send.js";
import { PLUGIN_ID } from "../namespace.js";
import { pickSender } from "../pick-sender.js";
import { bodyIsGone, isPrivateMail, PRIVATE_RETRY_NOTE } from "../private-mail.js";
import { AttachmentError, domainWarnings, downloadAttachments, failed, MAX_ATTACHMENT_BYTES, resultFromRow, type SendOptions, type SendResult } from "../send-shared.js";
import { accountScopeProblem, accountSenderKey, cleanDisplayName, effectiveReplyTo, parseReplyTo, parseUnsubscribeUrl, senderScopeWarnings } from "../sender.js";
import { ownOneClickUrl } from "../unsubscribe.js";
import { getMessageMetadata, getThreadMetadata, GmailApiError, listMessages, modifyMessage, sendRaw } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { headerMap, parseMessageIds, toMailAddress } from "./headers.js";
import { ensureLabelIds } from "./labels.js";
import { buildMime, htmlToText, messageIdFor } from "./mime.js";
import { messageRowId } from "./sync.js";
import { withGmail } from "./tokens.js";
import { checkSuppression, listUnsubscribeHeader } from "../suppression.js";
import type { AccountRow, SendContext, SendRecordInput, SendRow, SkippedRecipient } from "./types.js";

// Kept importable from here: the attachment download, the answer a send gives and the options it takes live in `send-shared.ts`.
export { AttachmentError, downloadAttachments, domainWarnings, MAX_ATTACHMENT_BYTES, resultFromRow };
export type { SendOptions, SendResult };

const SUFFIX = `.${MAIL_EVENTS.sendRequested}`;

/** `plugin.partnersinbiz.billing.mail.send.requested` → `partnersinbiz.billing`. */
export function senderOf(eventType: string): string | null {
  if (!eventType.startsWith("plugin.") || !eventType.endsWith(SUFFIX)) return null;
  return eventType.slice("plugin.".length, -SUFFIX.length) || null;
}

export function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function addressList(value: unknown, field: string, problems: string[]): MailAddress[] {
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
  const replyTo = parseReplyTo(p.replyTo);
  if (replyTo.invalid) problems.push("Invalid replyTo address");
  const unsubscribe = parseUnsubscribeUrl(p.unsubscribeUrl);
  if (unsubscribe.invalid) problems.push("unsubscribeUrl must be an https address with no spaces");
  const request: MailSendRequested = {
    key,
    from: str(p.from, 320),
    ...(cleanDisplayName(p.fromName) ? { fromName: cleanDisplayName(p.fromName) } : {}),
    ...(replyTo.address ? { replyTo: replyTo.address } : {}),
    ...(unsubscribe.url ? { unsubscribeUrl: unsubscribe.url } : {}),
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
    marketing: p.marketing === true,
  };
  if (to.length + cc.length + bcc.length === 0 && problems.length === 0) problems.push("The message has no recipients");
  if (!request.html && !request.text) problems.push("The message has no body");
  if (request.from && !toMailAddress(request.from)) problems.push(`Invalid from address: ${request.from}`);
  return { request, problem: problems[0] ?? null };
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

/** Send one request. Throws on transient trouble; returns `failed` only when retrying will not help. */
export async function performSend(env: Env, companyId: string, request: MailSendRequested, options: SendOptions, problem: string | null = null): Promise<SendResult> {
  const before = await env.store.getSend(companyId, request.key);
  if (before?.status === "sent") return resultFromRow(before);
  if (before?.status === "failed" && before.permanent && !options.force) return resultFromRow(before);

  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const picked = await pickSender(env, loaded, companyId, request);
  // Marketing the provider cannot take is refused for good, never moved to Gmail.
  if (picked.kind === "failed") {
    const message = picked.problem!;
    await env.store.recordSendFailure({ key: request.key, companyId, sourcePlugin: options.sourcePlugin, accountId: null, fromAddress: request.from ?? null, to: request.to, subject: request.subject, context: request.context, request }, message, true, []);
    return failed(request, message);
  }
  // A send-only account of the email provider is sent by its own path (the same answer, the same rules around it).
  if (picked.kind === "esp") return performEspSend(env, loaded, { account: picked.account!, domain: picked.domain, fromAddress: picked.fromAddress }, request, options, before, problem);
  const account = picked.account;
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
  // A client's mailbox only sends that client's mail; its opt-outs are that client's list (the company's own mailbox: `own`).
  const scopeProblem = account && !problem ? accountScopeProblem(account, request) : null;
  const senderKey = account ? accountSenderKey(account) : OWN_SENDER;
  // Never email a suppressed address: marketing skips every one of the sender's, any send skips hard bounces.
  const check = problem || scopeProblem ? null : await checkSuppression(env.store, companyId, request, senderKey);
  const blocked = check?.blocked ? check.skipped : undefined;
  const permanentProblem =
    problem ??
    scopeProblem ??
    (check?.blocked ? check.error : null) ??
    (!account
      ? request.from
        ? `No connected Gmail account for ${request.from} in Mailbox`
        : "No Gmail account is connected in Mailbox"
      : null);
  if (permanentProblem) {
    await env.store.recordSendFailure(record, permanentProblem, true, blocked ?? []);
    return failed(request, permanentProblem, blocked);
  }
  const outgoing = check?.request ?? request;
  const skipped = check?.skipped ?? [];
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
    if (!sent) sent = await sendNow(env, loaded, sender, outgoing, rfcMessageId, senderKey);
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
  return finishSent(env, loaded, sender, outgoing, options, sent, rfcMessageId, skipped, [...(await domainWarnings(env, sender, outgoing)), ...senderScopeWarnings(sender, outgoing)]);
}

async function sendNow(env: Env, loaded: LoadedConfig, sender: AccountRow, request: MailSendRequested, rfcMessageId: string, senderKey: string = OWN_SENDER) {
  const attachments = await downloadAttachments(env.fetch, request.attachments ?? []);
  const thread = await threadingFor(env, loaded, sender, request);
  // Marketing mail: an https one-click address (the caller's, else the Mailbox's own once its proxy rule is proved) next to the mailto form.
  const unsubscribe = request.marketing
    ? listUnsubscribeHeader(sender.address, request.unsubscribeUrl ?? (await ownOneClickUrl(env, loaded, request, sender.company_id, senderKey)))
    : null;
  const mime = buildMime({
    // The request's name wins, then the mailbox's own (a client's), then the company setting.
    from: { email: sender.address, name: request.fromName ?? sender.from_name ?? loaded.config.fromName },
    to: request.to,
    cc: request.cc ?? [],
    bcc: request.bcc ?? [],
    replyTo: effectiveReplyTo(request.replyTo, sender.address),
    subject: request.subject,
    text: request.text,
    html: request.html,
    attachments,
    messageId: rfcMessageId,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    date: new Date(env.now()),
    listUnsubscribe: unsubscribe?.value ?? null,
    listUnsubscribePost: unsubscribe?.post ?? null,
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
  skipped: SkippedRecipient[] = [],
  warnings: string[] = [],
): Promise<SendResult> {
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
  await env.store.markSendSent(request.key, { ...fields, skipped });
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
        // A client message's text is not kept (it may carry a private link): the stored copy has a subject and recipients, no preview.
        snippet: isPrivateMail(request.context) ? "" : (request.text ?? (request.html ? htmlToText(request.html) : "")).replace(/\s+/g, " ").slice(0, 200),
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
    // The Reply-To the message carries (none when it is the mailbox itself): where a reply arrives.
    replyTo: effectiveReplyTo(request.replyTo, account.address)?.email ?? null,
    ...(skipped.length ? { suppressed: skipped } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Event handler for `plugin.<sender>.mail.send.requested`. */
export const MAILBOX_OFF = "The Mailbox is switched off for this company. Turn it on in Setup, then retry the send from the Mailbox.";

export async function handleSendRequested(env: Env, event: PluginEvent): Promise<SendResult | null> {
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
    const out = result as unknown as SendResult;
    await env.ctx.events.emit(MAIL_EVENTS.sendResult, companyId, out as unknown as Record<string, unknown>);
    return out;
  } catch (error) {
    // Nothing stored: the sender's outbox asks again later.
    env.ctx.logger.info("Mail send deferred", { key: request.key, sender, error: errorMessage(error) });
    return null;
  }
}

/** Board action: send a failed or waiting request again and tell the sender. */
export async function retrySend(env: Env, companyId: string, key: string): Promise<SendResult> {
  const row = await env.store.getSend(companyId, key);
  if (!row) throw new MailboxError("Send request not found");
  if (row.status === "sent") return resultFromRow(row);
  // A client message's text is gone once its send ended: there is nothing to send again (the plugin that made it makes a new one).
  if (bodyIsGone(row)) throw new MailboxError(PRIVATE_RETRY_NOTE);
  const normalised = normaliseRequest(row.request, row.source_plugin);
  if (!normalised) throw new MailboxError("The stored request cannot be read");
  const result = await performSend(env, companyId, normalised.request, { sourcePlugin: row.source_plugin, force: true }, normalised.problem);
  await env.store.setInboxResult(key, result as unknown as Record<string, unknown>);
  if (row.source_plugin !== PLUGIN_ID) await env.ctx.events.emit(MAIL_EVENTS.sendResult, companyId, result);
  return result;
}
