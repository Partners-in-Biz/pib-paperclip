/**
 * Drafts for other plugins: `plugin.<sender>.mail.draft.requested` → a draft in the Paperclip Mailbox's Drafts →
 * `mail.draft.result` (kit `MailDraftRequested` / `MailDraftResult`).
 *
 * PAR-12249: the draft is saved in the Mailbox (table `messages`, status `draft`), never in Gmail Drafts, so a person reads,
 * edits, sends or deletes it on the Mailbox page. NOTHING IS EVER SENT here. The draft is held for a person (an agent's
 * `send-draft` is refused), and a newer draft for the same plugin, kind and client replaces the older open one.
 *
 * - `receiveOnce` keyed `draft:<request key>`: a repeat delivery re-emits the stored result and never creates a second draft.
 * - No Gmail account, a bad address, an account of the email provider, or a client's mailbox asked to hold another party's
 *   mail → `failed` with `permanent: true`.
 */
import { randomUUID } from "node:crypto";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, MAIL_EVENTS, receiveOnce, type MailDraftRequested, type MailDraftResult } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig } from "../config.js";
import { HOLD_REASON_PLUGIN, replaceOlderDrafts } from "../draft-purpose.js";
import { PLUGIN_ID } from "../namespace.js";
import { pickSender } from "../pick-sender.js";
import { accountScopeProblem, cleanDisplayName, parseReplyTo } from "../sender.js";
import { errorMessage, type Env } from "./env.js";
import { toMailAddress } from "./headers.js";
import { MAILBOX_OFF, addressList, str } from "./send.js";
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

/** Create one draft in the Mailbox's Drafts (never in Gmail Drafts). Returns `failed` only when retrying will not help. Never sends. */
export async function performDraft(env: Env, companyId: string, request: MailDraftRequested, problem: string | null = null): Promise<MailDraftResult> {
  if (problem) return failedDraft(request, problem);
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const picked = await pickSender(env, loaded, companyId, { from: request.from, context: request.context });
  let account: AccountRow | null = picked.account;
  if (picked.kind === "failed") return failedDraft(request, picked.problem!);
  if (picked.kind === "esp") {
    // A send-only account of the email provider is not a mailbox a person works in. Named on purpose: refuse. Not named
    // (the company's provider preference picked it): the draft belongs in the default Gmail account.
    if (request.from) return failedDraft(request, `${request.from} is a send-only email provider account and cannot hold a draft`);
    account = await env.store.defaultAccount(companyId);
  }
  if (!account) return failedDraft(request, request.from ? `No connected Gmail account for ${request.from} in Mailbox` : "No Gmail account is connected in Mailbox");
  const scopeProblem = accountScopeProblem(account, request);
  if (scopeProblem) return failedDraft(request, scopeProblem);
  const mailbox = account;

  // One draft per client and purpose: a newer version replaces the older open one (PAR-12249).
  const { context } = request;
  // One client = its CRM ref; with none (a sprint not linked to a client) the first recipient's address, so two sprints for one client still share one open draft.
  const who = context.clientRef ?? request.to[0]?.email?.trim().toLowerCase() ?? context.id;
  const purposeKey = `${context.plugin}:${context.kind}:${who}`.slice(0, 300);
  const id = randomUUID();
  await env.store.insertDraft({
    id,
    companyId,
    accountId: mailbox.id,
    subject: request.subject,
    body: request.text ?? "",
    to: request.to,
    cc: request.cc ?? [],
    bcc: request.bcc ?? [],
    draft: {
      html: request.html ?? null,
      replyTo: request.replyTo ?? null,
      fromName: request.fromName ?? null,
      by: { kind: "agent", id: context.plugin },
      purpose: context.kind,
      purposeKey,
      requestKey: request.key,
      holdForPerson: { reason: HOLD_REASON_PLUGIN },
    },
  });
  const replaced = await replaceOlderDrafts(env.store, companyId, mailbox.id, purposeKey, id);
  if (replaced.length) env.ctx.logger.info("Mail draft replaced older open drafts", { key: request.key, purposeKey, replaced: replaced.length });
  return {
    key: request.key,
    status: "drafted",
    gmailDraftId: null,
    gmailMessageId: null,
    threadId: null,
    account: mailbox.address,
    draftUrl: null,
    mailboxDraftId: id,
    replacedDraftIds: replaced,
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
