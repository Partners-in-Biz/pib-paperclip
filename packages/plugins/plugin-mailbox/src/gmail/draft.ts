/**
 * Gmail drafts for other plugins: `plugin.<sender>.mail.draft.requested` → Gmail `users.drafts.create` →
 * `mail.draft.result` (kit `MailDraftRequested` / `MailDraftResult`).
 *
 * The message lands in the Drafts folder of the account the request names (`from`), else the company's default Gmail
 * account. A person reads it, changes it and sends it from Gmail, or deletes it. NOTHING IS EVER SENT here: no send claim,
 * no `messages.send`, no email-provider path, and no suppression or marketing rule (those guard a send).
 *
 * - `receiveOnce` keyed `draft:<request key>` (the prefix keeps it apart from a send request that happens to use the same
 *   key): a repeat delivery re-emits the stored result and never creates a second draft. It uses the Mailbox's existing
 *   `inbox` table, so there is no migration.
 * - If an attempt created the draft but its answer was lost (timeout, crash before the result was stored), the next
 *   delivery looks the draft up by the Message-ID this request always carries before creating another one.
 * - Transient trouble (rate limit, Gmail down, a token that needs reconnecting) throws from `performDraft`; the handler
 *   stores and emits nothing, so the sender's outbox asks again later. Exactly the send handler's split.
 * - No Gmail account, a bad address, an account of the email provider (send-only: it has no Drafts folder), a client's
 *   mailbox asked to hold another party's mail, or a message Gmail refuses → `failed` with `permanent: true`.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, MAIL_EVENTS, receiveOnce, type MailDraftRequested, type MailDraftResult } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig } from "../config.js";
import { GmailUnavailable } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
import { pickSender } from "../pick-sender.js";
import { accountScopeProblem, cleanDisplayName, effectiveReplyTo, parseReplyTo } from "../sender.js";
import { createGmailDraft, findGmailDraft, GmailApiError, type GmailDraft } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { toMailAddress } from "./headers.js";
import { buildMime, messageIdFor } from "./mime.js";
import { MAILBOX_OFF, addressList, str } from "./send.js";
import { withGmail } from "./tokens.js";
import type { AccountRow, SendContext } from "./types.js";

const SUFFIX = `.${MAIL_EVENTS.draftRequested}`;

/** `plugin.partnersinbiz.seo.mail.draft.requested` → `partnersinbiz.seo`. */
export function draftSenderOf(eventType: string): string | null {
  if (!eventType.startsWith("plugin.") || !eventType.endsWith(SUFFIX)) return null;
  return eventType.slice("plugin.".length, -SUFFIX.length) || null;
}

/** Clean a draft request. Null without a key (nothing to answer); otherwise the request plus the first problem that makes it undraftable. */
export function normaliseDraftRequest(payload: unknown, sender: string): { request: MailDraftRequested; problem: string | null } | null {
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
  const replyTo = parseReplyTo(p.replyTo);
  if (replyTo.invalid) problems.push("Invalid replyTo address");
  const request: MailDraftRequested = {
    key,
    from: str(p.from, 320),
    ...(cleanDisplayName(p.fromName) ? { fromName: cleanDisplayName(p.fromName) } : {}),
    ...(replyTo.address ? { replyTo: replyTo.address } : {}),
    to,
    cc,
    bcc,
    subject: typeof p.subject === "string" ? p.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 900) : "",
    html: typeof p.html === "string" && p.html.trim() ? p.html : null,
    text: typeof p.text === "string" && p.text.trim() ? p.text : null,
    context,
  };
  if (to.length + cc.length + bcc.length === 0 && problems.length === 0) problems.push("The draft has no recipients");
  if (!request.subject) problems.push("The draft has no subject");
  if (request.from && !toMailAddress(request.from)) problems.push(`Invalid from address: ${request.from}`);
  return { request, problem: problems[0] ?? null };
}

function failedDraft(request: MailDraftRequested, error: string): MailDraftResult {
  return { key: request.key, status: "failed", gmailDraftId: null, gmailMessageId: null, threadId: null, account: null, draftUrl: null, error, permanent: true, context: request.context };
}

export function draftUrlFor(account: string, gmailMessageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#drafts?compose=${gmailMessageId}`;
}

function isPermanentGmail(error: unknown): boolean {
  return error instanceof GmailApiError && !error.retryable && !error.reconnect && (error.status === 400 || error.status === 413 || error.status === 404);
}

/** Create one draft. Throws on transient trouble; returns `failed` only when retrying will not help. Never sends. */
export async function performDraft(env: Env, companyId: string, request: MailDraftRequested, problem: string | null = null): Promise<MailDraftResult> {
  if (problem) return failedDraft(request, problem);
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const picked = await pickSender(env, loaded, companyId, { from: request.from, context: request.context });
  let account: AccountRow | null = picked.account;
  if (picked.kind === "failed") return failedDraft(request, picked.problem!);
  if (picked.kind === "esp") {
    // A send-only account of the email provider has no Drafts folder. Named on purpose: refuse. Not named (the company's
    // provider preference picked it): the draft belongs in the default Gmail account.
    if (request.from) return failedDraft(request, `${request.from} is a send-only email provider account and has no Gmail Drafts folder, so a draft cannot be created there`);
    account = await env.store.defaultAccount(companyId);
  }
  if (!account) return failedDraft(request, request.from ? `No connected Gmail account for ${request.from} in Mailbox` : "No Gmail account is connected in Mailbox");
  const scopeProblem = accountScopeProblem(account, request);
  if (scopeProblem) return failedDraft(request, scopeProblem);
  const mailbox = account;
  if (mailbox.status === "needs_reconnect") throw new GmailUnavailable(`Gmail for ${mailbox.address} must be reconnected before a draft can be created`);

  const rfcMessageId = messageIdFor(`draft:${request.key}`, mailbox.address);
  let draft: GmailDraft | null = null;
  try {
    // An earlier attempt may have created the draft and lost the answer: find it by its Message-ID before creating another.
    try {
      draft = await withGmail(env, loaded, mailbox, (token) => findGmailDraft(env.fetch, token, rfcMessageId));
    } catch (error) {
      if (!isPermanentGmail(error)) throw error;
    }
    if (!draft) {
      const mime = buildMime({
        from: { email: mailbox.address, name: request.fromName ?? mailbox.from_name ?? loaded.config.fromName },
        to: request.to,
        cc: request.cc ?? [],
        bcc: request.bcc ?? [],
        replyTo: effectiveReplyTo(request.replyTo, mailbox.address),
        subject: request.subject,
        text: request.text,
        html: request.html,
        messageId: rfcMessageId,
        date: new Date(env.now()),
      });
      draft = await withGmail(env, loaded, mailbox, (token) => createGmailDraft(env.fetch, token, mime));
    }
  } catch (error) {
    if (isPermanentGmail(error)) return failedDraft(request, errorMessage(error));
    throw error;
  }
  return {
    key: request.key,
    status: "drafted",
    gmailDraftId: draft.id,
    gmailMessageId: draft.messageId,
    threadId: draft.threadId,
    account: mailbox.address,
    draftUrl: draftUrlFor(mailbox.address, draft.messageId),
    error: null,
    permanent: false,
    context: request.context,
  };
}

/** Event handler for `plugin.<sender>.mail.draft.requested`. */
export async function handleDraftRequested(env: Env, event: PluginEvent): Promise<MailDraftResult | null> {
  const sender = draftSenderOf(event.eventType) ?? "unknown";
  const companyId = event.companyId;
  const normalised = normaliseDraftRequest(event.payload, sender);
  if (!companyId || !normalised) {
    env.ctx.logger.info("Ignored a mail draft request without a key or company", { eventType: event.eventType });
    return null;
  }
  const { request } = normalised;
  // Switched off in Setup: answer at once so the sender hands the mail to a person.
  const problem = (await isModuleEnabled(env.ctx, companyId, PLUGIN_ID)) ? normalised.problem : MAILBOX_OFF;
  try {
    const { result } = await receiveOnce(env.ctx, companyId, event.eventType, `draft:${request.key}`, () =>
      performDraft(env, companyId, request, problem).then((r) => r as unknown as Record<string, unknown>),
    );
    const out = result as unknown as MailDraftResult;
    await env.ctx.events.emit(MAIL_EVENTS.draftResult, companyId, out as unknown as Record<string, unknown>);
    return out;
  } catch (error) {
    // Nothing stored: the sender's outbox asks again later.
    env.ctx.logger.info("Mail draft deferred", { key: request.key, sender, error: errorMessage(error) });
    return null;
  }
}
