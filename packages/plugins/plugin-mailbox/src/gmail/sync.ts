/**
 * `sync-mailbox` job: Gmail history since the stored cursor (a 7-day resync
 * when the cursor is missing or expired), metadata only, upsert, triage,
 * labels, optional reply issues, and `mail.received` events. Every run
 * re-emits the last 30 minutes of messages because events are at-most-once;
 * consumers dedupe by key.
 */
import { configSaved, createWorkIssue, decisionConfig, isModuleEnabled, MAIL_EVENTS, RISK_THRESHOLDS, type MailReceived } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "../config.js";
import { GmailUnavailable } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
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
import { REPLY_ISSUE_CATEGORIES, triageMessage, type TriageRunContext } from "./triage.js";
import type { AccountRow, AttachmentMeta, BounceInfo, CrmClientRow, MessageRow, NewGmailMessage } from "./types.js";

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

export interface SyncStats {
  mode: "history" | "full";
  listed: number;
  stored: number;
  labelUpdates: number;
  triaged: number;
  labelled: number;
  issues: number;
  emitted: number;
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
  let stored = 0;
  for (const row of parsed) {
    if (row && (await env.store.insertGmailMessage(row))) stored += 1;
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
  const issues = await openReplyIssues(env, loaded, account, triaged);

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

async function openReplyIssues(env: Env, loaded: LoadedConfig, account: AccountRow, rows: MessageRow[]): Promise<number> {
  const assignee = loaded.config.triageAssignee;
  if (!assignee) return 0;
  let opened = 0;
  for (const row of rows) {
    const triage = row.triage;
    if (!triage?.category || !REPLY_ISSUE_CATEGORIES.has(triage.category)) continue;
    if ((triage.needsReply ?? 0) < RISK_THRESHOLDS.update || (triage.phishing ?? 0) >= 0.9 || row.bulk) continue;
    const threadId = row.gmail_thread_id ?? row.gmail_message_id!;
    if (!(await env.store.claimThreadIssue(account.company_id, account.id, threadId))) continue;
    try {
      const created = await createWorkIssue(env.ctx, {
        companyId: loaded.companyId,
        title: `Reply needed: ${row.subject}`.slice(0, 200),
        description: replyIssueDescription(row, account.address),
        ...(assignee.agentId ? { assigneeAgentId: assignee.agentId } : { assigneeUserId: assignee.userId }),
        originKind: `plugin:${PLUGIN_ID}`,
        originId: `thread:${account.id}:${threadId}`,
        priority: (triage.urgency ?? 0) >= 2.5 ? "high" : "medium",
        wakeReason: "Mail needs a reply",
      });
      await env.store.setThreadIssue(account.id, threadId, created.id);
      opened += 1;
    } catch (error) {
      env.ctx.logger.info("Reply issue not created", { messageId: row.id, error: errorMessage(error) });
    }
  }
  return opened;
}

export function replyIssueDescription(row: MessageRow, accountAddress: string): string {
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
    `Read it with \`partnersinbiz.mailbox:get-message\` (messageId \`${row.id}\`). Draft the answer with \`create-draft\` (accountId \`${row.account_id}\`, replyToMessageId \`${row.id}\`) and send it with \`send-draft\` when your delegation allows sending.`,
  ].join("\n");
}

/** Job body: every connected account of every company whose settings were saved. */
export async function runSyncJob(env: Env): Promise<{ accounts: number; synced: number; failed: number }> {
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
    const run = await triageRunFor(env, loaded);
    for (const account of list) {
      const ok = await syncOne(env, loaded, account, run);
      if (ok) synced += 1;
      else failed += 1;
    }
  }
  return { accounts: accounts.length, synced, failed };
}

export async function triageRunFor(env: Env, loaded: LoadedConfig, limits: { maxNew?: number; triageLimit?: number } = {}): Promise<SyncRun> {
  let jev = null;
  try {
    jev = await decisionConfig(loaded.secrets, loaded.raw);
  } catch (error) {
    env.ctx.logger.info("Jev settings unavailable; using rules", { companyId: loaded.companyId, error: errorMessage(error) });
  }
  let clients: Promise<CrmClientRow[]> | null = null;
  return {
    jev,
    labelPrefix: loaded.config.labelPrefix,
    clients: () => (clients ??= env.store.crmClients(loaded.companyId, 1000)),
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
