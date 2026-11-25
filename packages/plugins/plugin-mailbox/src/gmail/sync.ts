/**
 * `sync-mailbox` job: Gmail history since the stored cursor (a 7-day resync
 * when the cursor is missing or expired), metadata only, upsert, triage,
 * labels, the do-not-email list (opt-outs and hard bounces), reply issues,
 * and `mail.received` events. Every run re-emits the last 30 minutes of
 * messages because events are at-most-once; consumers dedupe by key.
 *
 * Mail triaged as a lead from a sender who is not a CRM contact goes to the
 * CRM as `lead.captured` through the kit outbox: it is re-sent with backoff
 * until the CRM answers `lead.captured.result` (stored, held or ignored), so
 * a lead is never lost. The CRM opens the follow-up, so the Mailbox opens no
 * reply issue for it.
 */
import {
  configSaved,
  createWorkIssue,
  decisionConfig,
  enqueue,
  HANDOFF_EVENTS,
  isModuleEnabled,
  MAIL_EVENTS,
  PIB_PLUGINS,
  redeliver,
  resolveClientProjectId,
  routeWork,
  wakeIssueWhenIdle,
  type ClientScope,
  type MailReceived,
} from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { GmailUnavailable } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
import { isPrivateMail } from "../private-mail.js";
import {
  batchModify,
  getMessageMetadata,
  getMessageParts,
  getProfile,
  GmailApiError,
  listHistory,
  listMessages,
  REPORT_MASK,
  type GmailMessage,
  type GmailPart,
} from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { decodeEncodedWords, headerMap, isBounceMail, isBulkMail, parseAddressList, parseMessageIds } from "./headers.js";
import { ensureLabelIds } from "./labels.js";
import { withGmail } from "./tokens.js";
import { opensReplyTask, triageMessage, type TriageRunContext } from "./triage.js";
import type { AccountRow, AttachmentMeta, BounceInfo, ClientMapRow, CrmClientRow, MessageRow, NewGmailMessage } from "./types.js";
import { suppressFromInbound } from "../suppression.js";
import { replyOrigin, unansweredMessage } from "../done-checks.js";
import { isFreeMailDomain } from "../free-mail.js";
import { ensureDefaultDelegations } from "../delegations.js";
import { erasureHash } from "../hash.js";
import { isLeadCandidate, leadCapturedFrom } from "./leads.js";

export { gmailWebLink, isLeadCandidate, leadCapturedFrom, type MailLeadCaptured } from "./leads.js";

export { SYNC_JOB_KEY } from "../constants.js";
export const RESYNC_QUERY = "newer_than:7d -in:chats -in:drafts -in:spam -in:trash";
export const RESYNC_LIMIT = 300;
export const HISTORY_NEW_LIMIT = 200;
export const TRIAGE_LIMIT = 100;
export const REEMIT_MINUTES = 30;
const SKIP_LABELS = new Set(["DRAFT", "TRASH", "SPAM", "CHAT"]);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Walk a part tree for real attachments (a file name and an attachment id). */
export function collectAttachments(part: GmailPart | null | undefined, out: AttachmentMeta[] = []): AttachmentMeta[] {
  if (!part || out.length >= 20) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachmentId: part.body.attachmentId,
      filename: decodeEncodedWords(part.filename).slice(0, 200),
      mime: (part.mimeType ?? "application/octet-stream").toLowerCase(),
      bytes: Number(part.body.size ?? 0),
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
  return out;
}

/**
 * What a delivery failure notice says: X-Failed-Recipients, and the bounced
 * message's Message-ID from the notice's part headers (never its body).
 */
export function bounceInfoFrom(headers: Map<string, string>, tree: GmailPart | null): BounceInfo {
  const rfcIds = new Set<string>();
  const walk = (part: GmailPart | null | undefined) => {
    for (const child of part?.parts ?? []) {
      for (const id of parseMessageIds(headerMap(child.headers).get("message-id"))) rfcIds.add(id);
      walk(child);
    }
  };
  walk(tree);
  const recipients = parseAddressList(headers.get("x-failed-recipients")).map((a) => a.email);
  return { recipients: [...new Set(recipients)].slice(0, 20), rfcIds: [...rfcIds].slice(0, 20) };
}

/** Only a mixed multipart or a single non-text part can carry attachments worth listing. */
export function mayHaveAttachments(message: GmailMessage): boolean {
  const type = (headerMap(message.payload?.headers).get("content-type") ?? message.payload?.mimeType ?? "").toLowerCase();
  return /^multipart\/mixed/.test(type) || /^(application|image|audio|video)\//.test(type);
}

export function messageRowId(accountId: string, gmailMessageId: string): string {
  return `gm_${accountId}_${gmailMessageId}`;
}

/**
 * The sent copy of a client message (it may carry a private link) is stored without its preview: when the sync finds a message we sent that
 * the send path has not stored yet, it is looked up by its Message-ID. Everything else is stored as it is.
 */
export async function withheldIfPrivate(env: Pick<Env, "store">, row: NewGmailMessage): Promise<NewGmailMessage> {
  if (row.direction !== "outbound" || !row.snippet || !row.rfcMessageId) return row;
  const sends = await env.store.sendsByRfcIds(row.companyId, [row.rfcMessageId]);
  const send = sends.find((entry) => isPrivateMail(entry.context));
  return send ? { ...row, snippet: "", sentContext: row.sentContext ?? send.context, sendKey: row.sendKey ?? send.key } : row;
}

/** Gmail metadata → the row we store, or null for drafts, trash, spam and chats. */
export function parseGmailMessage(
  message: GmailMessage,
  account: AccountRow,
  attachments: AttachmentMeta[],
  now: number,
  bounce: BounceInfo | null = null,
): NewGmailMessage | null {
  if (!message.id || message.labelIds.some((label) => SKIP_LABELS.has(label))) return null;
  const headers = headerMap(message.payload?.headers);
  const from = parseAddressList(headers.get("from"))[0] ?? null;
  const outbound = message.labelIds.includes("SENT");
  const internal = Number(message.internalDate);
  const dated = Date.parse(headers.get("date") ?? "");
  const receivedAt = new Date(Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dated) ? dated : now).toISOString();
  return {
    id: messageRowId(account.id, message.id),
    companyId: account.company_id,
    accountId: account.id,
    direction: outbound ? "outbound" : "inbound",
    status: outbound ? "sent" : "synced",
    subject: decodeEncodedWords(headers.get("subject") ?? "").trim() || "(no subject)",
    gmailMessageId: message.id,
    gmailThreadId: message.threadId || message.id,
    rfcMessageId: parseMessageIds(headers.get("message-id"))[0] ?? null,
    inReplyTo: parseMessageIds(headers.get("in-reply-to"))[0] ?? null,
    refs: parseMessageIds(headers.get("references")).slice(-50),
    from,
    to: parseAddressList(headers.get("to")).slice(0, 100),
    cc: parseAddressList(headers.get("cc")).slice(0, 100),
    snippet: message.snippet ?? "",
    labels: message.labelIds,
    attachments,
    bulk: isBulkMail(headers, from),
    receivedAt,
    read: !message.labelIds.includes("UNREAD"),
    triaged: outbound,
    bounce: outbound ? null : bounce,
    // A website form relayed by its host puts the visitor in Reply-To.
    replyToAddr: outbound ? null : parseAddressList(headers.get("reply-to"))[0] ?? null,
  };
}

/** `mail.received` plus `bounce` for delivery failure notices (extra field; consumers may ignore it). */
export type MailReceivedEvent = MailReceived & { bounce?: BounceInfo | null };

export function mailReceivedFrom(row: MessageRow, accountAddress: string): MailReceivedEvent {
  const triage = row.triage;
  const event: MailReceivedEvent = {
    key: `mail:${row.gmail_message_id}`,
    accountAddress,
    messageId: row.gmail_message_id ?? row.id,
    threadId: row.gmail_thread_id ?? row.gmail_message_id ?? row.id,
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    from: row.from_addr ?? { email: "", name: null },
    to: row.to_addrs ?? [],
    subject: row.subject,
    snippet: row.snippet ?? "",
    receivedAt: row.received_at ?? row.created_at,
    attachments: row.attachments ?? [],
    triage: {
      category: triage?.category ?? null,
      urgency: triage?.urgency ?? null,
      needsReply: triage?.needsReply ?? null,
      phishing: triage?.phishing ?? null,
      confidence: triage?.confidence ?? null,
      clientKind: triage?.clientKind ?? null,
      clientRef: triage?.clientRef ?? null,
    },
    replyTo: row.reply_to ?? null,
  };
  if (row.bounce) event.bounce = row.bounce;
  return event;
}

/**
 * True when a message to or from an erased person was received before they were erased (the marker keeps their hash and the moment).
 * The Reply-To counts as well: for a relayed website form it is the visitor (the From is the website).
 */
export function isErasedMail(row: Pick<NewGmailMessage, "from" | "to" | "cc" | "receivedAt" | "replyToAddr">, erased: Map<string, string>, ownAddress: string): boolean {
  if (erased.size === 0) return false;
  const received = Date.parse(row.receivedAt);
  for (const address of [row.from?.email, row.replyToAddr?.email, ...row.to.map((a) => a.email), ...row.cc.map((a) => a.email)]) {
    if (!address || address.toLowerCase() === ownAddress.toLowerCase()) continue;
    const at = Date.parse(erased.get(erasureHash(address)) ?? "");
    if (Number.isFinite(at) && (!Number.isFinite(received) || received < at)) return true;
  }
  return false;
}

export interface SyncStats {
  mode: "history" | "full";
  listed: number;
  stored: number;
  labelUpdates: number;
  triaged: number;
  labelled: number;
  issues: number;
  emitted: number;
  /** New leads handed to the CRM this run (queued in the outbox until it answers). */
  leads: number;
  /** Addresses added to the do-not-email list this run (opt-outs and hard bounces). */
  suppressed: number;
  historyId: string | null;
  at: string;
}

export interface SyncRun extends TriageRunContext {
  /** New messages per run (history) and, doubled, the resync size; smaller for a manual "Sync now". */
  maxNew?: number;
  triageLimit?: number;
}

export async function syncAccount(env: Env, loaded: LoadedConfig, account: AccountRow, run: SyncRun): Promise<SyncStats | { skipped: string }> {
  if (!(await env.store.tryLockSync(account.id, 300))) return { skipped: "A sync for this account is already running" };
  try {
    return await syncLocked(env, loaded, account, run);
  } finally {
    await env.store.unlockSync(account.id).catch(() => undefined);
  }
}

async function syncLocked(env: Env, loaded: LoadedConfig, account: AccountRow, run: SyncRun): Promise<SyncStats> {
  const call = <T>(fn: (token: string) => Promise<T>) => withGmail(env, loaded, account, fn);
  const maxNew = run.maxNew ?? HISTORY_NEW_LIMIT;
  const resyncLimit = run.maxNew ? Math.min(RESYNC_LIMIT, run.maxNew * 2) : RESYNC_LIMIT;
  let mode: SyncStats["mode"] = account.history_id ? "history" : "full";
  const added = new Map<string, string>();
  const labelChanges = new Map<string, string[]>();
  let cursor = account.history_id;

  if (mode === "history") {
    try {
      let pageToken: string | null = null;
      for (let pages = 1; ; pages += 1) {
        const page = await call((token) => listHistory(env.fetch, token, account.history_id!, pageToken));
        for (const item of page.added) added.set(item.id, item.threadId);
        for (const change of page.labelChanges) labelChanges.set(change.id, change.labelIds);
        if (!page.nextPageToken) {
          cursor = page.historyId;
          break;
        }
        if (added.size >= maxNew || pages >= 20) {
          cursor = page.lastRecordId ?? cursor;
          break;
        }
        pageToken = page.nextPageToken;
      }
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
      mode = "full";
      added.clear();
      labelChanges.clear();
    }
  }

  if (mode === "full") {
    const profile = await call((token) => getProfile(env.fetch, token));
    cursor = profile.historyId || cursor;
    let pageToken: string | null = null;
    while (added.size < resyncLimit) {
      const page = await call((token) => listMessages(env.fetch, token, RESYNC_QUERY, { pageToken, maxResults: 100 }));
      for (const item of page.messages) if (added.size < resyncLimit) added.set(item.id, item.threadId);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  }

  const ids = [...added.keys()];
  const existing = await env.store.existingGmailIds(account.id, [...new Set([...ids, ...labelChanges.keys()])]);
  let labelUpdates = 0;
  for (const [id, labels] of labelChanges) {
    if (!existing.has(id)) continue;
    await env.store.updateLabels(account.id, id, labels);
    labelUpdates += 1;
  }

  const fresh = ids.filter((id) => !existing.has(id));
  const parsed = await mapLimit(fresh, 5, async (id) => {
    try {
      const message = await call((token) => getMessageMetadata(env.fetch, token, id));
      const headers = headerMap(message.payload?.headers);
      if (!message.labelIds.includes("SENT") && isBounceMail(headers, parseAddressList(headers.get("from"))[0] ?? null)) {
        const tree = await call((token) => getMessageParts(env.fetch, token, id, REPORT_MASK));
        return parseGmailMessage(message, account, collectAttachments(tree), env.now(), bounceInfoFrom(headers, tree));
      }
      const attachments = mayHaveAttachments(message) ? collectAttachments(await call((token) => getMessageParts(env.fetch, token, id))) : [];
      return parseGmailMessage(message, account, attachments, env.now());
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) return null; // deleted since
      throw error;
    }
  });
  // Mail of a person who was erased and was received before the erasure is never imported again (their later mail is new).
  const erased = await env.store.erasedMarkers(account.company_id).catch(() => new Map<string, string>());
  let stored = 0;
  for (const row of parsed) {
    if (row && isErasedMail(row, erased, account.address)) continue;
    if (row && (await env.store.insertGmailMessage(await withheldIfPrivate(env, row)))) stored += 1;
  }

  // Triage what is stored but not triaged yet (this run's messages, or a backlog a failed run left).
  const pending = await env.store.untriaged(account.id, run.triageLimit ?? TRIAGE_LIMIT);
  const triaged: MessageRow[] = [];
  await mapLimit(pending, 4, async (row) => {
    try {
      await triageMessage(env, run, row);
      triaged.push(row);
    } catch (error) {
      env.ctx.logger.info("Mail triage failed", { messageId: row.id, error: errorMessage(error) });
    }
  });

  const labelled = await applyTriageLabels(env, loaded, account, triaged);

  // Opt-outs and hard bounces join the do-not-email list before anything else acts on them.
  let suppressed = 0;
  if (triaged.length > 0) {
    const own = new Set((await env.store.listAccounts(account.company_id)).map((row) => row.address.toLowerCase()));
    for (const row of triaged) {
      try {
        suppressed += (await suppressFromInbound(env, account, row, own)).length;
      } catch (error) {
        env.ctx.logger.info("Suppression from inbound mail failed", { messageId: row.id, error: errorMessage(error) });
      }
    }
  }

  // New leads go to the CRM through the outbox (it opens the follow-up, so no reply issue here).
  const handedToCrm = new Set<string>();
  let leads = 0;
  for (const row of triaged) {
    const handed = await handOffLead(env, account, row);
    if (handed.handed) handedToCrm.add(row.id);
    if (handed.created) leads += 1;
  }
  const issues = await openReplyIssues(env, loaded, account, triaged.filter((row) => !handedToCrm.has(row.id)));

  // Emit what was triaged now, plus the last 30 minutes again (consumers dedupe by key).
  const toEmit = new Map<string, MessageRow>();
  for (const row of triaged) toEmit.set(row.id, row);
  for (const row of await env.store.recentInbound(account.id, REEMIT_MINUTES, 200)) if (!toEmit.has(row.id)) toEmit.set(row.id, row);
  let emitted = 0;
  for (const row of toEmit.values()) {
    if (!row.gmail_message_id) continue;
    try {
      await env.ctx.events.emit(MAIL_EVENTS.received, account.company_id, mailReceivedFrom(row, account.address));
      emitted += 1;
    } catch (error) {
      env.ctx.logger.info("mail.received emit failed", { messageId: row.id, error: errorMessage(error) });
    }
  }

  const stats: SyncStats = {
    mode,
    listed: ids.length,
    stored,
    labelUpdates,
    triaged: triaged.length,
    labelled,
    issues,
    emitted,
    leads,
    suppressed,
    historyId: cursor ?? null,
    at: new Date(env.now()).toISOString(),
  };
  await env.store.updateAccount(account.company_id, account.id, {
    history_id: cursor ?? null,
    last_sync_at: stats.at,
    last_error: null,
    sync_stats: stats as unknown as Record<string, unknown>,
  });
  account.history_id = cursor ?? null;
  return stats;
}

/**
 * A lead from a sender who is not a CRM contact yet goes to the CRM through
 * the outbox (re-sent until the CRM answers `lead.captured.result`). Skipped
 * while the CRM module is switched off: the reply issue covers it then.
 * `handed` is true when the CRM owns the follow-up. Never throws.
 */
export async function handOffLead(env: Env, account: AccountRow, row: MessageRow): Promise<{ handed: boolean; created: boolean }> {
  if (!isLeadCandidate(row)) return { handed: false, created: false };
  try {
    if (!(await isModuleEnabled(env.ctx, account.company_id, PIB_PLUGINS.crm))) return { handed: false, created: false };
    // A client mail mapping files the lead under the client; the person is the visitor, not the website.
    const mapped = row.triage?.mapping && row.client_kind && row.client_ref ? { match_type: row.triage.mapping.type, client_kind: row.client_kind as "company" | "contact", client_ref: row.client_ref } : null;
    // A mailbox that belongs to a client receives that client's mail: its leads are the client's, and the sender is the person (like mail addressed to the client).
    const owned = account.client_ref ? { match_type: "recipient_address" as const, client_kind: (account.client_kind === "contact" ? "contact" : "company") as "company" | "contact", client_ref: account.client_ref } : null;
    const mapping = mapped ?? owned;
    // A lead for the company that is already a CRM contact is the Account Manager's reply to write. A client's lead is the CRM's to file in the client's scope,
    // whoever the visitor is: the company must not answer a visitor of its client's website as itself.
    if (!mapping) {
      const contacts = await env.store.crmContactsByEmail(account.company_id, row.from_addr!.email);
      if (contacts.length > 0) return { handed: false, created: false };
    }
    const lead = leadCapturedFrom(row, account.address, mapping);
    const { created } = await enqueue(env.ctx, account.company_id, HANDOFF_EVENTS.leadCaptured, lead as unknown as { key: string } & Record<string, unknown>);
    return { handed: true, created };
  } catch (error) {
    env.ctx.logger.info("lead.captured hand-off failed", { messageId: row.id, error: errorMessage(error) });
    return { handed: false, created: false };
  }
}

/** Job: re-send leads the CRM has not answered yet (backoff; gives up after about 3 days). */
export async function redeliverLeads(env: Env): Promise<{ emitted: number; failed: number }> {
  try {
    return await redeliver(env.ctx);
  } catch (error) {
    env.ctx.logger.info("Lead redelivery failed", { error: errorMessage(error) });
    return { emitted: 0, failed: 0 };
  }
}

async function applyTriageLabels(env: Env, loaded: LoadedConfig, account: AccountRow, rows: MessageRow[]): Promise<number> {
  const byLabel = new Map<string, string[]>();
  for (const row of rows) {
    for (const name of row.triage?.labels ?? []) {
      const list = byLabel.get(name) ?? [];
      list.push(row.gmail_message_id!);
      byLabel.set(name, list);
    }
  }
  if (byLabel.size === 0) return 0;
  let labelled = 0;
  try {
    await withGmail(env, loaded, account, async (token) => {
      const ids = await ensureLabelIds(env.fetch, env.store, account, token, [...byLabel.keys()]);
      for (const [name, messages] of byLabel) {
        const labelId = ids[name];
        if (!labelId) continue;
        await batchModify(env.fetch, token, messages, [labelId]);
        labelled += messages.length;
      }
    });
  } catch (error) {
    if (error instanceof GmailUnavailable) throw error;
    env.ctx.logger.info("Gmail triage labels not applied", { accountId: account.id, error: errorMessage(error) });
  }
  return labelled;
}

/**
 * Who answers mail: the configured triage assignee, else the Account
 * Manager, else the Operator, else the owner (kit `routeWork`).
 */
export async function replyAssignee(env: Env, loaded: LoadedConfig): Promise<{ assigneeAgentId?: string; assigneeUserId?: string }> {
  const configured = loaded.config.triageAssignee;
  if (configured?.agentId) return { assigneeAgentId: configured.agentId };
  if (configured?.userId) return { assigneeUserId: configured.userId };
  const route = await routeWork(env.ctx, loaded.companyId, ["account-manager"]);
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId };
  if (route.assigneeUserId) return { assigneeUserId: route.assigneeUserId };
  return {};
}

/** A follow-up older than this (a backlog after a reconnect) does not reopen anything. */
const FOLLOW_UP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function wantsReply(row: MessageRow): boolean {
  const triage = row.triage;
  return opensReplyTask({ category: triage?.category, needsReply: triage?.needsReply ?? 0, phishing: triage?.phishing ?? 0, bulk: Boolean(row.bulk), clientSource: triage?.clientSource, countOnly: triage?.countOnly });
}

const receivedMs = (row: MessageRow) => Date.parse(row.received_at ?? row.created_at) || 0;

/**
 * The client a reply issue may be filed under. A wrong project means the wrong
 * repository, so only a reliable match counts: a person's correction, a client
 * mail mapping, or the CRM's match on an outside sender. Jev's guess does not
 * count, and neither does the CRM's match on our own staff: they write about
 * many clients, but their address sits on one CRM record.
 */
export function replyIssueClient(row: MessageRow, ownAddresses: string[]): ClientScope {
  if (!row.client_ref || (row.client_kind !== "company" && row.client_kind !== "contact")) return null;
  const scope = { kind: row.client_kind, id: row.client_ref } as const;
  const source = row.triage?.clientSource;
  if (source === "correction" || source === "mapping") return scope;
  if (source !== "email" && source !== "domain" && source !== "reply") return null;
  const sender = row.from_addr?.email?.toLowerCase();
  if (!sender) return null;
  const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
  const own = ownAddresses.map((address) => address.toLowerCase());
  if (own.includes(sender)) return null;
  // A shared free-mail domain says nothing: gmail.com senders are not our staff because one mailbox is on gmail.com.
  const ownDomains = own.map(domainOf).filter((domain) => !isFreeMailDomain(domain));
  return ownDomains.includes(domainOf(sender)) ? null : scope;
}

async function createReplyIssue(env: Env, loaded: LoadedConfig, account: AccountRow, row: MessageRow, threadId: string, assignee: { assigneeAgentId?: string; assigneeUserId?: string }): Promise<void> {
  const accounts = await env.store.listAccounts(account.company_id);
  const scope = replyIssueClient(row, accounts.map((item) => item.address));
  // The kit trusts the CRM's link here: the Mailbox does not hold projects.read.
  const { projectId } = await resolveClientProjectId(env.ctx, loaded.companyId, scope, { kind: "website", verify: false });
  const input = {
    companyId: loaded.companyId,
    title: `Reply needed: ${row.subject}`.slice(0, 200),
    ...assignee,
    originKind: `plugin:${PLUGIN_ID}` as const,
    originId: replyOrigin(account.id, threadId),
    priority: (row.triage?.urgency ?? 0) >= 2.5 ? ("high" as const) : ("medium" as const),
    wakeReason: "Mail needs a reply",
  };
  const withoutProject = () => createWorkIssue(env.ctx, { ...input, description: replyIssueDescription(row, account.address, false) });
  let created: { id: string };
  if (projectId) {
    try {
      created = await createWorkIssue(env.ctx, { ...input, description: replyIssueDescription(row, account.address, true), projectId });
    } catch (error) {
      // A stale link (an archived project) must not cost the reply.
      env.ctx.logger.info("Reply issue not created in the client's project; opening it without one", { messageId: row.id, projectId, error: errorMessage(error) });
      created = await withoutProject();
    }
  } else {
    created = await withoutProject();
  }
  await env.store.setThreadIssue(account.id, threadId, created.id);
}

/**
 * New mail on a thread that already has its issue. Closed: reopened, so the
 * mail is not lost. Blocked or waiting: the mail may be what unblocks it, so
 * the assignee is woken. Being worked on: a comment is enough. Returns "create"
 * when the thread has no issue to act on (its create failed, or it is gone).
 */
async function handleFollowUp(env: Env, loaded: LoadedConfig, account: AccountRow, row: MessageRow, threadId: string, assignee: () => Promise<{ assigneeAgentId?: string; assigneeUserId?: string }>): Promise<"create" | "done"> {
  if (Date.now() - receivedMs(row) > FOLLOW_UP_MAX_AGE_MS) return "done";
  // Answered already, say straight from Gmail: closing would pass the done-check, so there is nothing to do.
  if (!unansweredMessage(await env.store.replyThread(account.company_id, threadId), account.id)) return "done";
  const issueId = await env.store.threadIssueId(account.id, threadId);
  const issue = issueId ? await env.ctx.issues.get(issueId, loaded.companyId) : null;
  if (!issue) return "create";
  const closed = issue.status === "done" || issue.status === "cancelled";
  if (closed) {
    const unassigned = !issue.assigneeAgentId && !issue.assigneeUserId;
    await env.ctx.issues.update(issue.id, { status: "todo", ...(unassigned ? await assignee() : {}) }, loaded.companyId);
  }
  await env.ctx.issues.createComment(issue.id, followUpComment(row, closed), loaded.companyId);
  if (closed || (issue.status !== "in_progress" && issue.status !== "todo")) await wakeIssueWhenIdle(env.ctx, issue.id, loaded.companyId, "New mail on this thread needs a reply");
  return "done";
}

export function followUpComment(row: MessageRow, reopened: boolean): string {
  const from = row.from_addr ? `${row.from_addr.name ? `${row.from_addr.name} ` : ""}<${row.from_addr.email}>` : "unknown sender";
  return [
    `**New mail on this thread needs a reply**${reopened ? " (reopened)" : ""}.`,
    "",
    `- From: ${from}`,
    `- Subject: ${row.subject}`,
    `- Received: ${row.received_at ?? row.created_at}`,
    "",
    `> ${(row.snippet ?? "").slice(0, 400)}`,
    "",
    `Read it with \`partnersinbiz.mailbox:get-message\` (messageId \`${row.id}\`), then answer with \`create-draft\` (accountId \`${row.account_id}\`, replyToMessageId \`${row.id}\`), or \`correct-triage\` it if no reply is needed.`,
  ].join("\n");
}

async function openReplyIssues(env: Env, loaded: LoadedConfig, account: AccountRow, rows: MessageRow[]): Promise<number> {
  if (!loaded.config.replyIssues) return 0;
  let assignee: { assigneeAgentId?: string; assigneeUserId?: string } | null = null;
  const getAssignee = async () => (assignee ??= await replyAssignee(env, loaded));
  let opened = 0;
  // Newest first: several mails on one thread in a run act once, on the newest.
  const seen = new Set<string>();
  for (const row of rows.filter(wantsReply).sort((a, b) => receivedMs(b) - receivedMs(a))) {
    const threadId = row.gmail_thread_id ?? row.gmail_message_id!;
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    try {
      const claimed = await env.store.claimThreadIssue(account.company_id, account.id, threadId);
      if (!claimed && (await handleFollowUp(env, loaded, account, row, threadId, getAssignee)) === "done") continue;
      await createReplyIssue(env, loaded, account, row, threadId, await getAssignee());
      opened += 1;
    } catch (error) {
      env.ctx.logger.info("Reply issue not created or updated", { messageId: row.id, error: errorMessage(error) });
    }
  }
  return opened;
}

export function replyIssueDescription(row: MessageRow, accountAddress: string, inClientProject = false): string {
  const t = row.triage;
  const from = row.from_addr ? `${row.from_addr.name ? `${row.from_addr.name} ` : ""}<${row.from_addr.email}>` : "unknown sender";
  return [
    `New mail in **${accountAddress}** needs a reply.`,
    "",
    `- From: ${from}`,
    `- Subject: ${row.subject}`,
    `- Category: ${t?.category ?? "unknown"}${t?.clientName ? ` · client ${t.clientName}` : ""}`,
    `- Received: ${row.received_at ?? row.created_at}`,
    "",
    `> ${(row.snippet ?? "").slice(0, 400)}`,
    "",
    `1. Read it with \`partnersinbiz.mailbox:get-message\` (messageId \`${row.id}\`)${(row.attachments ?? []).length ? `; open an attachment with \`get-attachment\`` : ""}.`,
    `2. Draft the answer with \`create-draft\` (accountId \`${row.account_id}\`, replyToMessageId \`${row.id}\`) and send it with \`send-draft\` when your delegation allows sending. Log it on the client in the CRM${row.client_ref ? ` (\`${row.client_kind ?? "company"}:${row.client_ref}\`)` : ""}.`,
    inClientProject
      ? "3. If it asks for work beyond a reply (a fix, a build, a publish), open a child issue with that work. This issue is in the client's own project; use another of the client's projects only if the work belongs there (`partnersinbiz.crm:list-client-projects`)."
      : "3. If it asks for work beyond a reply (a fix, a build, a publish), open a child issue with that work in the project it belongs to: `partnersinbiz.crm:list-client-projects` lists a client's projects. The client shown above is a hint, so check it against what the mail is about. Platform work goes in PiB Platform. Unsure which project: say so on the child issue and do not guess, because the project decides the repository.",
    "4. Mark this issue done with what you drafted or sent. Never answer phishing or legal threats: ask the owner instead (`partnersinbiz.cockpit:ask-owner`).",
    "",
    "**Done when** the thread has your reply draft or a sent reply, or `correct-triage` says no reply is needed (needsReply false). Closing checks it.",
    "",
    `No access to this mailbox? \`list-mailboxes\` shows your delegation. Ask the owner once (\`partnersinbiz.cockpit:ask-owner\`) to give you access in Mailbox → Mailboxes → Give an agent access.`,
  ].join("\n");
}

/** Job body: every connected account of every company whose settings were saved. */
export async function runSyncJob(env: Env): Promise<{ accounts: number; synced: number; failed: number; leadsResent: number; leadsFailed: number }> {
  const accounts = await env.store.listSyncAccounts();
  const byCompany = new Map<string, AccountRow[]>();
  for (const account of accounts) {
    const list = byCompany.get(account.company_id) ?? [];
    list.push(account);
    byCompany.set(account.company_id, list);
  }
  let synced = 0;
  let failed = 0;
  for (const [companyId, list] of byCompany) {
    if (!(await configSaved(env.ctx, companyId))) continue;
    // Only the Mailbox's own switch stops the sync; other modules being off does not.
    if (!(await isModuleEnabled(env.ctx, companyId, PLUGIN_ID))) continue;
    const loaded = await loadMailboxConfig(env.ctx, companyId);
    // The Operator's default read and draft access on the company's own mailboxes (cheap, at most every ten minutes).
    await ensureDefaultDelegations(env, companyId);
    const run = await triageRunFor(env, loaded);
    for (const account of list) {
      const ok = await syncOne(env, loaded, account, run);
      if (ok) synced += 1;
      else failed += 1;
    }
  }
  // Leads the CRM has not answered yet go out again (with backoff).
  const leads = await redeliverLeads(env);
  return { accounts: accounts.length, synced, failed, leadsResent: leads.emitted, leadsFailed: leads.failed };
}

export async function triageRunFor(env: Env, loaded: LoadedConfig, limits: { maxNew?: number; triageLimit?: number } = {}): Promise<SyncRun> {
  let jev = null;
  try {
    jev = await decisionConfig(loaded.secrets, loaded.raw);
  } catch (error) {
    env.ctx.logger.info("Jev settings unavailable; using rules", { companyId: loaded.companyId, error: errorMessage(error) });
  }
  let clients: Promise<CrmClientRow[]> | null = null;
  let maps: Promise<ClientMapRow[]> | null = null;
  let own: Promise<Set<string>> | null = null;
  return {
    jev,
    labelPrefix: loaded.config.labelPrefix,
    clients: () => (clients ??= env.store.crmClients(loaded.companyId, 1000)),
    // Loaded once per run: a handful of rows each.
    maps: () => (maps ??= env.store.listClientMaps(loaded.companyId).catch(() => [])),
    ownAddresses: () => (own ??= env.store.listAccounts(loaded.companyId).then((rows) => new Set(rows.map((row) => row.address.toLowerCase())))),
    ...limits,
  };
}

/** Sync one account and record a failure on it. Returns true on success. */
export async function syncOne(env: Env, loaded: LoadedConfig, account: AccountRow, run: SyncRun): Promise<boolean> {
  try {
    await syncAccount(env, loaded, account, run);
    return true;
  } catch (error) {
    env.ctx.logger.info("Gmail sync failed", { accountId: account.id, error: errorMessage(error) });
    if (!(error instanceof GmailUnavailable)) {
      await env.store.updateAccount(account.company_id, account.id, { last_error: errorMessage(error).slice(0, 500) }).catch(() => undefined);
    }
    return false;
  }
}
