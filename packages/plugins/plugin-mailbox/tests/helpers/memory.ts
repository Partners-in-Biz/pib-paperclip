/**
 * In-memory GmailStore and a fake host context (inbox/decisions SQL for the
 * kit, events, issues, config) for the Gmail logic tests.
 */
import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AccountPatch, EspDomainPatch, GmailStore, SentFields } from "../../src/db.js";
import type { EspAuditRow, EspDayField, EspDayRow, EspDomainRow, EspEventInput, RecipientHealthRow } from "../../src/esp/types.js";
import { isPrivateMail, scrubbedRequest } from "../../src/private-mail.js";
import { createEnv, type Env } from "../../src/gmail/env.js";
import type {
  AccountRow,
  ClientMapRow,
  ClientMapType,
  CrmClientRow,
  DelegationSource,
  DomainCheckRow,
  InboxFilter,
  MessageRow,
  NewGmailMessage,
  OAuthSessionRow,
  SendContext,
  SendRecordInput,
  SendRow,
  SendStatus,
  SkippedRecipient,
  SuppressionInput,
  SuppressionRow,
  TriageWrite,
} from "../../src/gmail/types.js";
import { createFakeDb, type Store } from "./fake-db.js";
import { erasureHash, markerEmail } from "../../src/hash.js";
import { NAMESPACE } from "../../src/namespace.js";
import type { FetchLike } from "../../src/gmail/api.js";

const nowIso = () => new Date().toISOString();

export class MemoryStore implements GmailStore {
  accounts = new Map<string, AccountRow>();
  messages = new Map<string, MessageRow>();
  sends = new Map<string, SendRow>();
  threadIssues = new Map<string, string | null>();
  sessions = new Map<string, OAuthSessionRow & { expiresAt: number }>();
  locks = new Set<string>();
  crm: CrmClientRow[] = [];
  inboxResults = new Map<string, Record<string, unknown>>();
  /** Delegations by `account:agent`. */
  delegations = new Map<string, { can_read: boolean; can_draft: boolean; can_send: boolean; source?: DelegationSource; granted_by?: string | null }>();
  /** Removed delegations (`account:agent`): the defaults never create them again. */
  removals = new Set<string>();
  async delegationFor(accountId: string, agentId: string) {
    const row = this.delegations.get(`${accountId}:${agentId}`);
    return row ? { can_read: row.can_read, can_draft: row.can_draft, can_send: row.can_send } : null;
  }
  delegate(accountId: string, agentId: string, grant: Partial<{ can_read: boolean; can_draft: boolean; can_send: boolean }> = {}): void {
    this.delegations.set(`${accountId}:${agentId}`, { can_read: true, can_draft: true, can_send: false, source: "manual", ...grant });
  }
  async hasDelegationRemoval(accountId: string, agentId: string) {
    return this.removals.has(`${accountId}:${agentId}`);
  }
  async insertDefaultDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; grantedBy: string }) {
    const key = `${row.accountId}:${row.agentId}`;
    if (this.delegations.has(key) || this.removals.has(key)) return false;
    this.delegations.set(key, { can_read: row.canRead, can_draft: row.canDraft, can_send: row.canSend, source: "default", granted_by: row.grantedBy });
    return true;
  }
  async grantDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; source: DelegationSource; grantedBy: string | null }) {
    const key = `${row.accountId}:${row.agentId}`;
    const have = this.delegations.get(key);
    this.delegations.set(key, {
      can_read: (have?.can_read ?? false) || row.canRead,
      can_draft: (have?.can_draft ?? false) || row.canDraft,
      can_send: (have?.can_send ?? false) || row.canSend,
      source: row.source,
      granted_by: row.grantedBy,
    });
    this.removals.delete(key);
  }
  async deleteDefaultDelegations(_companyId: string, accountId: string) {
    void _companyId;
    let n = 0;
    for (const [key, row] of [...this.delegations]) {
      if (key.startsWith(`${accountId}:`) && row.source === "default") {
        this.delegations.delete(key);
        n += 1;
      }
    }
    return n;
  }
  async removeDelegation(_companyId: string, accountId: string, agentId: string, _removedBy: string | null = null) {
    void _removedBy;
    const key = `${accountId}:${agentId}`;
    const had = this.delegations.delete(key);
    this.removals.add(key);
    return had;
  }
  /** Do-not-email list by `company:email`. */
  suppressions = new Map<string, SuppressionRow>();
  /** Claim times per account, for the rate limit. */
  claims: Array<{ accountId: string; at: number }> = [];

  async suppressionsFor(companyId: string, emails: string[]) {
    const wanted = new Set(emails.map((e) => e.trim().toLowerCase()));
    const byHash = new Map([...wanted].map((email) => [erasureHash(email), email]));
    return [...this.suppressions.values()]
      .filter((row) => row.company_id === companyId && (wanted.has(row.email) || (row.email_hash !== null && byHash.has(row.email_hash))))
      .map((row) => ({ ...row, ...(row.email_hash && byHash.has(row.email_hash) ? { email: byHash.get(row.email_hash)! } : {}) }));
  }
  async upsertSuppression(input: SuppressionInput) {
    const email = input.email.trim().toLowerCase();
    const senderKey = input.senderKey ?? "";
    const key = `${input.companyId}:${email}:${senderKey}`;
    const existing = this.suppressions.get(key);
    const now = nowIso();
    if (!existing) {
      this.suppressions.set(key, { company_id: input.companyId, email, scope: input.scope, reason: input.reason, source: input.source, detail: input.detail ?? null, sender_key: senderKey, email_hash: null, erased_at: null, created_at: now, updated_at: now });
      return { created: true, widened: false, scope: input.scope };
    }
    if (input.scope === "all" && existing.scope === "marketing") {
      Object.assign(existing, { scope: "all", reason: input.reason, source: input.source, detail: input.detail ?? null, updated_at: now });
      return { created: false, widened: true, scope: "all" as const };
    }
    return { created: false, widened: false, scope: existing.scope };
  }
  async listSuppressions(companyId: string, limit: number) {
    return [...this.suppressions.values()].filter((row) => row.company_id === companyId).slice(0, limit);
  }
  async ownSuppressionsSince(source: string, sinceIso: string, limit: number) {
    return [...this.suppressions.values()].filter((row) => row.source === source && !row.email_hash && row.updated_at >= sinceIso).slice(0, limit);
  }
  addSuppression(companyId: string, email: string, scope: "marketing" | "all", reason: SuppressionRow["reason"] = scope === "all" ? "bounced" : "unsubscribed", source = "partnersinbiz.crm", senderKey = ""): void {
    this.suppressions.set(`${companyId}:${email}:${senderKey}`, { company_id: companyId, email, scope, reason, source, detail: null, sender_key: senderKey, email_hash: null, erased_at: null, created_at: nowIso(), updated_at: nowIso() });
  }

  addAccount(partial: Partial<AccountRow> & { id: string; company_id: string; address: string }): AccountRow {
    const row: AccountRow = {
      provider: "gmail",
      status: "connected",
      token_sealed: null,
      token_expires_at: null,
      scopes: null,
      history_id: null,
      last_sync_at: null,
      last_error: null,
      sync_stats: {},
      connected_by_user_id: "user-1",
      connected_at: nowIso(),
      alert_issue_id: null,
      is_default: false,
      label_ids: {},
      owner_user_id: "user-1",
      client_kind: null,
      client_ref: null,
      from_name: null,
      reply_to: null,
      created_at: nowIso(),
      ...partial,
    };
    this.accounts.set(row.id, row);
    return row;
  }

  async listSyncAccounts() {
    return [...this.accounts.values()].filter((a) => a.status === "connected" && a.token_sealed).map((a) => ({ ...a }));
  }
  async listAccounts(companyId: string) {
    return [...this.accounts.values()].filter((a) => a.company_id === companyId).map((a) => ({ ...a }));
  }
  async getAccount(companyId: string, id: string) {
    const row = this.accounts.get(id);
    return row && row.company_id === companyId ? { ...row } : null;
  }
  async findAccountByAddress(companyId: string, address: string) {
    const row = [...this.accounts.values()].find((a) => a.company_id === companyId && a.address.toLowerCase() === address.toLowerCase());
    return row ? { ...row } : null;
  }
  async defaultAccount(companyId: string) {
    const list = [...this.accounts.values()]
      .filter((a) => a.company_id === companyId && a.token_sealed && !a.client_ref && (a.status === "connected" || a.status === "needs_reconnect"))
      .sort((a, b) => Number(b.is_default) - Number(a.is_default) || Number(b.status === "connected") - Number(a.status === "connected"));
    return list[0] ? { ...list[0] } : null;
  }
  async insertAccount(row: { id: string; companyId: string; provider: string; address: string; ownerUserId: string | null; isDefault: boolean }) {
    this.addAccount({ id: row.id, company_id: row.companyId, address: row.address, provider: row.provider, owner_user_id: row.ownerUserId, is_default: row.isDefault, status: "manual" });
  }
  async updateAccount(companyId: string, id: string, patch: AccountPatch) {
    const row = this.accounts.get(id);
    if (!row || row.company_id !== companyId) return;
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
  }
  async markNeedsReconnect(companyId: string, id: string, error: string) {
    const row = this.accounts.get(id);
    if (!row || row.company_id !== companyId || row.status !== "connected") return false;
    row.status = "needs_reconnect";
    row.last_error = error;
    return true;
  }
  async setDefaultAccount(companyId: string, id: string) {
    for (const row of this.accounts.values()) if (row.company_id === companyId) row.is_default = row.id === id;
  }
  async setAccountClient(companyId: string, id: string, patch: { clientKind: string | null; clientRef: string | null; fromName?: string | null }) {
    const row = this.accounts.get(id);
    if (!row || row.company_id !== companyId) return;
    Object.assign(row, { client_kind: patch.clientRef ? patch.clientKind : null, client_ref: patch.clientRef, from_name: patch.fromName ?? null });
    if (patch.clientRef) row.is_default = false;
  }
  async tryLockSync(accountId: string) {
    if (this.locks.has(accountId)) return false;
    this.locks.add(accountId);
    return true;
  }
  async unlockSync(accountId: string) {
    this.locks.delete(accountId);
  }
  async mergeLabelIds(accountId: string, map: Record<string, string>) {
    const row = this.accounts.get(accountId);
    if (row) row.label_ids = { ...(row.label_ids ?? {}), ...map };
  }

  async existingGmailIds(accountId: string, ids: string[]) {
    const set = new Set<string>();
    for (const row of this.messages.values()) if (row.account_id === accountId && row.gmail_message_id && ids.includes(row.gmail_message_id)) set.add(row.gmail_message_id);
    return set;
  }
  async insertGmailMessage(row: NewGmailMessage) {
    if (this.messages.has(row.id)) return false;
    for (const m of this.messages.values()) if (m.account_id === row.accountId && m.gmail_message_id === row.gmailMessageId) return false;
    this.messages.set(row.id, {
      id: row.id,
      company_id: row.companyId,
      account_id: row.accountId,
      subject: row.subject,
      body: "",
      direction: row.direction,
      status: row.status,
      created_at: nowIso(),
      read_at: row.read ? nowIso() : null,
      gmail_message_id: row.gmailMessageId,
      gmail_thread_id: row.gmailThreadId,
      rfc_message_id: row.rfcMessageId,
      in_reply_to: row.inReplyTo,
      refs: row.refs,
      from_addr: row.from,
      to_addrs: row.to,
      cc_addrs: row.cc,
      bcc_addrs: row.bcc ?? [],
      snippet: row.snippet,
      labels: row.labels,
      attachments: row.attachments,
      bulk: row.bulk,
      received_at: row.receivedAt,
      triage: null,
      triaged_at: row.triaged ? nowIso() : null,
      category: null,
      urgency: null,
      needs_reply: null,
      phishing: null,
      client_kind: null,
      client_ref: null,
      reply_to: null,
      sent_context: row.sentContext ?? null,
      send_key: row.sendKey ?? null,
      draft: null,
      send_error: null,
      bounce: row.bounce ?? null,
      reply_to_addr: row.replyToAddr ?? null,
      map_state: null,
      map_id: null,
    });
    return true;
  }
  async updateLabels(accountId: string, gmailMessageId: string, labels: string[]) {
    for (const row of this.messages.values()) {
      if (row.account_id === accountId && row.gmail_message_id === gmailMessageId) {
        row.labels = labels;
        row.read_at = labels.includes("UNREAD") ? null : row.read_at ?? nowIso();
      }
    }
  }
  async untriaged(accountId: string, limit: number) {
    return [...this.messages.values()].filter((m) => m.account_id === accountId && m.direction === "inbound" && !m.triaged_at && m.gmail_message_id).slice(0, limit).map((m) => ({ ...m }));
  }
  async setTriage(companyId: string, id: string, write: TriageWrite) {
    const row = this.messages.get(id);
    if (!row || row.company_id !== companyId) return;
    Object.assign(row, {
      triage: write.triage,
      category: write.category,
      urgency: write.urgency,
      needs_reply: write.needsReply,
      phishing: write.phishing,
      client_kind: write.clientKind,
      client_ref: write.clientRef,
      reply_to: write.replyTo,
      map_state: write.mapState ?? row.map_state,
      map_id: write.mapId ?? row.map_id,
      triaged_at: nowIso(),
    });
  }
  /** Rows created within `minutes` (tests control created_at directly). */
  async recentInbound(accountId: string, minutes: number, limit: number) {
    const since = Date.now() - minutes * 60_000;
    return [...this.messages.values()]
      .filter((m) => m.account_id === accountId && m.direction === "inbound" && m.triaged_at && Date.parse(m.created_at) >= since && Date.parse(m.received_at ?? m.created_at) >= Date.now() - 86_400_000)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }
  async getMessage(companyId: string, id: string) {
    const row = this.messages.get(id);
    return row && row.company_id === companyId ? { ...row } : null;
  }
  async getMessageByGmailId(companyId: string, gmailMessageId: string, accountId: string | null = null) {
    const row = [...this.messages.values()].find((m) => m.company_id === companyId && m.gmail_message_id === gmailMessageId && (!accountId || m.account_id === accountId));
    return row ? { ...row } : null;
  }
  async getMessageByRfcId(companyId: string, rfcMessageId: string) {
    const row = [...this.messages.values()].find((m) => m.company_id === companyId && m.rfc_message_id === rfcMessageId);
    return row ? { ...row } : null;
  }
  async outboundByRfcIds(companyId: string, ids: string[]) {
    return [...this.messages.values()].filter((m) => m.company_id === companyId && m.direction === "outbound" && m.rfc_message_id && ids.includes(m.rfc_message_id));
  }
  async outboundInThread(companyId: string, threadId: string) {
    return [...this.messages.values()].find((m) => m.company_id === companyId && m.direction === "outbound" && m.gmail_thread_id === threadId && m.sent_context) ?? null;
  }
  async latestInThread(companyId: string, threadId: string) {
    const list = [...this.messages.values()]
      .filter((m) => m.company_id === companyId && m.gmail_thread_id === threadId && m.rfc_message_id)
      .sort((a, b) => Date.parse(b.received_at ?? b.created_at) - Date.parse(a.received_at ?? a.created_at));
    return list[0] ? { ...list[0] } : null;
  }
  async replyThread(companyId: string, threadId: string) {
    return [...this.messages.values()]
      .filter((m) => m.company_id === companyId && (m.gmail_thread_id === threadId || m.draft?.threadId === threadId))
      .sort((a, b) => Date.parse(b.received_at ?? b.created_at) - Date.parse(a.received_at ?? a.created_at))
      .map((m) => ({ ...m }));
  }
  async listInbox(companyId: string, filter: InboxFilter) {
    return [...this.messages.values()]
      .filter((m) => m.company_id === companyId && m.direction === "inbound")
      .filter((m) => !filter.accountId || m.account_id === filter.accountId)
      .filter((m) => !filter.category || m.category === filter.category)
      .filter((m) => !filter.needsReply || Number(m.needs_reply ?? 0) >= 0.5)
      .slice(0, filter.limit);
  }
  async markDraftSent(companyId: string, id: string, fields: SentFields & { context: SendContext; sendKey: string }) {
    const row = this.messages.get(id);
    if (!row || row.company_id !== companyId) return;
    Object.assign(row, { status: "sent", gmail_message_id: fields.gmailMessageId, gmail_thread_id: fields.gmailThreadId, rfc_message_id: fields.rfcMessageId, sent_context: fields.context, send_key: fields.sendKey, send_error: null });
  }
  async setDraftStatus(companyId: string, id: string, status: "draft" | "queued", error: string | null) {
    const row = this.messages.get(id);
    if (row && row.company_id === companyId) Object.assign(row, { status, send_error: error });
  }

  async recentClaims(accountId: string) {
    const since = Date.now() - 60_000;
    return this.claims.filter((c) => c.accountId === accountId && c.at > since).length;
  }
  private newSend(input: SendRecordInput, status: SendStatus): SendRow {
    return {
      key: input.key,
      company_id: input.companyId,
      source_plugin: input.sourcePlugin,
      account_id: input.accountId,
      from_address: input.fromAddress,
      to_addrs: input.to,
      subject: input.subject,
      status,
      permanent: false,
      attempts: 0,
      gmail_message_id: null,
      gmail_thread_id: null,
      rfc_message_id: null,
      error: null,
      context: input.context,
      request: JSON.parse(JSON.stringify(input.request)),
      claimed_at: null,
      sent_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      provider: null,
      provider_message_id: null,
      delivery_status: null,
      delivery: {},
    };
  }
  async claimSend(input: SendRecordInput, force: boolean) {
    const existing = this.sends.get(input.key);
    const stale = existing?.status === "sending" && existing.claimed_at != null && Date.parse(existing.claimed_at) < Date.now() - 600_000;
    if (existing && !(existing.status === "retrying" || stale || (force && existing.status === "failed"))) return false;
    const row = existing ?? this.newSend(input, "sending");
    Object.assign(row, { status: "sending", attempts: row.attempts + 1, claimed_at: nowIso(), account_id: input.accountId, from_address: input.fromAddress, error: null, permanent: false });
    this.sends.set(input.key, row);
    this.claims.push({ accountId: input.accountId ?? "", at: Date.now() });
    return true;
  }
  async recordSendFailure(input: SendRecordInput, error: string, permanent: boolean, skipped: SkippedRecipient[] = []) {
    const existing = this.sends.get(input.key);
    if (existing?.status === "sent") return;
    const row = existing ?? this.newSend(input, "failed");
    Object.assign(row, { status: "failed", permanent, error, skipped, attempts: existing ? row.attempts : 1 });
    // A client message's text is not kept once it has failed for good.
    if (permanent && isPrivateMail(row.context)) row.request = scrubbedRequest(row.request);
    this.sends.set(input.key, row);
  }
  async markRetrying(input: SendRecordInput, error: string) {
    const existing = this.sends.get(input.key);
    if (existing?.status === "sent") return;
    const row = existing ?? this.newSend(input, "retrying");
    Object.assign(row, { status: "retrying", error });
    this.sends.set(input.key, row);
  }
  async markSendSent(key: string, fields: SentFields & { skipped?: SkippedRecipient[] }) {
    const row = this.sends.get(key);
    if (!row) return;
    Object.assign(row, {
      status: "sent",
      permanent: false,
      error: null,
      skipped: fields.skipped ?? [],
      gmail_message_id: fields.gmailMessageId,
      gmail_thread_id: fields.gmailThreadId,
      rfc_message_id: fields.rfcMessageId,
      account_id: fields.accountId,
      from_address: fields.fromAddress,
      sent_at: nowIso(),
    });
    if (isPrivateMail(row.context)) row.request = scrubbedRequest(row.request);
  }
  async getSend(companyId: string, key: string) {
    const row = this.sends.get(key);
    return row && row.company_id === companyId ? { ...row } : null;
  }
  async listSends(companyId: string, options: { status?: SendStatus | null; limit: number }) {
    return [...this.sends.values()].filter((s) => s.company_id === companyId && (!options.status || s.status === options.status)).slice(0, options.limit);
  }
  async sendByThread(companyId: string, threadId: string) {
    return [...this.sends.values()].find((s) => s.company_id === companyId && s.gmail_thread_id === threadId && s.status === "sent") ?? null;
  }
  async sendsByRfcIds(companyId: string, ids: string[]) {
    return [...this.sends.values()].filter((s) => s.company_id === companyId && s.rfc_message_id && ids.includes(s.rfc_message_id));
  }
  async sendToRecipient(companyId: string, email: string) {
    return [...this.sends.values()].find((s) => s.company_id === companyId && s.status === "sent" && (s.to_addrs ?? []).some((a) => a.email === email.toLowerCase())) ?? null;
  }
  async setInboxResult(key: string, result: Record<string, unknown>) {
    this.inboxResults.set(key, result);
  }
  async isPrivateSend(companyId: string, ids: { key?: string | null; gmailMessageId?: string | null; rfcMessageId?: string | null }) {
    return [...this.sends.values()].some((s) => s.company_id === companyId && isPrivateMail(s.context) && ((ids.key && s.key === ids.key) || (ids.gmailMessageId && s.gmail_message_id === ids.gmailMessageId) || (ids.rfcMessageId && s.rfc_message_id === ids.rfcMessageId)));
  }
  async scrubPrivateBodies(companyId: string, staleBeforeIso: string) {
    let n = 0;
    for (const s of this.sends.values()) {
      if (s.company_id !== companyId || !isPrivateMail(s.context)) continue;
      const hasBody = Boolean(s.request.text || s.request.html || s.request.attachments);
      const settled = s.status === "sent" || (s.status === "failed" && s.permanent);
      if (hasBody && (settled || s.created_at < staleBeforeIso)) {
        s.request = scrubbedRequest(s.request);
        n += 1;
      }
    }
    return n;
  }
  async scrubPrivateSnippets(companyId: string) {
    let n = 0;
    for (const m of this.messages.values()) {
      if (m.company_id !== companyId || m.direction !== "outbound" || !m.snippet) continue;
      const privateSend = isPrivateMail(m.sent_context) || [...this.sends.values()].some((s) => s.company_id === companyId && isPrivateMail(s.context) && (s.key === m.send_key || (s.gmail_message_id && s.gmail_message_id === m.gmail_message_id) || (s.rfc_message_id && s.rfc_message_id === m.rfc_message_id)));
      if (privateSend) {
        m.snippet = "";
        n += 1;
      }
    }
    return n;
  }
  espAudit: EspAuditRow[] = [];
  async insertEspAudit(row: { id: string; companyId: string; domain: string; action: EspAuditRow["action"]; actor: string; detail: Record<string, unknown> }) {
    this.espAudit.push({ id: row.id, company_id: row.companyId, domain: row.domain.toLowerCase(), action: row.action, actor: row.actor, detail: structuredClone(row.detail), created_at: nowIso() });
  }
  async listEspAudit(companyId: string, domain: string, limit: number) {
    return this.espAudit.filter((row) => row.company_id === companyId && row.domain === domain.toLowerCase()).slice(-limit).reverse().map((row) => structuredClone(row));
  }

  async claimThreadIssue(_companyId: string, accountId: string, threadId: string) {
    const key = `${accountId}:${threadId}`;
    if (this.threadIssues.has(key)) return false;
    this.threadIssues.set(key, null);
    return true;
  }
  async setThreadIssue(accountId: string, threadId: string, issueId: string) {
    this.threadIssues.set(`${accountId}:${threadId}`, issueId);
  }

  async insertOAuthSession(row: { state: string; companyId: string; createdByUserId: string | null; returnTo: string | null; ttlSeconds: number }) {
    this.sessions.set(row.state, { state: row.state, companyId: row.companyId, createdByUserId: row.createdByUserId, returnTo: row.returnTo, expired: false, expiresAt: Date.now() + row.ttlSeconds * 1000 });
  }
  async getOAuthSession(state: string) {
    const row = this.sessions.get(state);
    return row ? { ...row, expired: row.expiresAt < Date.now() } : null;
  }
  async deleteOAuthSession(state: string) {
    this.sessions.delete(state);
  }

  async crmContactsByEmail(companyId: string, email: string) {
    void companyId;
    return this.crm.filter((c) => c.kind === "contact" && c.emails.some((e) => e.toLowerCase() === email.toLowerCase()));
  }
  async crmCompaniesByDomain(companyId: string, domain: string) {
    void companyId;
    // Same normalisation as the SQL: strip scheme, www. and path.
    const clean = (d: string | null) => (d ?? "").toLowerCase().replace(/^(https?:\/\/)?(www[.])?/, "").split("/")[0];
    return this.crm.filter((c) => c.kind === "company" && clean(c.domain) === domain.toLowerCase());
  }
  async crmCompany(companyId: string, id: string) {
    void companyId;
    return this.crm.find((c) => c.kind === "company" && c.id === id) ?? null;
  }
  async crmClients() {
    return [...this.crm];
  }
  async crmContact(companyId: string, id: string) {
    void companyId;
    return this.crm.find((c) => c.kind === "contact" && c.id === id) ?? null;
  }

  // client mail mappings
  maps: ClientMapRow[] = [];
  private mapSeq = 0;
  async listClientMaps(companyId: string) {
    return this.maps.filter((map) => map.company_id === companyId).map((map) => ({ ...map }));
  }
  async insertClientMap(row: { companyId: string; matchType: ClientMapType; pattern: string; clientKind: "company" | "contact"; clientRef: string; clientName: string | null; note: string | null; createdBy: string | null }) {
    this.mapSeq += 1;
    const map: ClientMapRow = { id: `map_${this.mapSeq}`, company_id: row.companyId, match_type: row.matchType, pattern: row.pattern, client_kind: row.clientKind, client_ref: row.clientRef, client_name: row.clientName, note: row.note, created_by: row.createdBy, created_at: nowIso() };
    this.maps.push(map);
    return { ...map };
  }
  async deleteClientMap(companyId: string, id: string) {
    const before = this.maps.length;
    this.maps = this.maps.filter((map) => !(map.company_id === companyId && map.id === id));
    return this.maps.length < before;
  }
  async unmappedSummary(companyId: string, _days = 30) {
    void _days;
    const groups = new Map<string, { n: number; last_at: string | null; sample_id: string | null }>();
    for (const m of this.messages.values()) {
      if (m.company_id !== companyId || m.map_state !== "needs_mapping") continue;
      const domain = (m.from_addr?.email ?? "").split("@")[1] ?? "";
      const g = groups.get(domain) ?? { n: 0, last_at: null, sample_id: null };
      g.n += 1;
      const at = m.received_at ?? m.created_at;
      if (!g.last_at || at > g.last_at) Object.assign(g, { last_at: at, sample_id: m.id });
      groups.set(domain, g);
    }
    return [...groups.entries()].map(([domain, g]) => ({ domain, ...g })).sort((a, b) => b.n - a.n);
  }
  async flaggedMessages(companyId: string, _days: number, limit: number) {
    return [...this.messages.values()].filter((m) => m.company_id === companyId && m.direction === "inbound" && m.map_state === "needs_mapping").slice(0, limit).map((m) => ({ ...m }));
  }

  // sender domain checks
  domainChecks = new Map<string, DomainCheckRow>();
  async getDomainCheck(companyId: string, domain: string) {
    const row = this.domainChecks.get(`${companyId}:${domain.toLowerCase()}`);
    return row ? { ...row } : null;
  }
  async listDomainChecks(companyId: string) {
    return [...this.domainChecks.values()].filter((row) => row.company_id === companyId).sort((a, b) => a.domain.localeCompare(b.domain)).map((row) => ({ ...row }));
  }
  async upsertDomainCheck(row: DomainCheckRow) {
    this.domainChecks.set(`${row.company_id}:${row.domain.toLowerCase()}`, { ...row, domain: row.domain.toLowerCase() });
  }

  // email provider
  espDomains = new Map<string, EspDomainRow>();
  /** `company:domain:day` → one UTC day of counts. */
  espDays = new Map<string, EspDayRow>();
  espEvents: Array<EspEventInput & { received_at: string }> = [];
  health = new Map<string, RecipientHealthRow>();

  async insertEspAccount(row: { id: string; companyId: string; provider: string; address: string; status: "pending" | "connected"; fromName: string | null; replyTo: string | null; clientKind: string | null; clientRef: string | null; createdBy: string | null }) {
    this.addAccount({ id: row.id, company_id: row.companyId, address: row.address, provider: row.provider, status: row.status, from_name: row.fromName, reply_to: row.replyTo, client_kind: row.clientRef ? row.clientKind : null, client_ref: row.clientRef, owner_user_id: row.createdBy, connected_at: row.status === "connected" ? nowIso() : null });
  }
  async setAccountStatus(companyId: string, id: string, status: AccountRow["status"]) {
    const row = this.accounts.get(id);
    if (row && row.company_id === companyId) {
      row.status = status;
      if (status === "connected" && !row.connected_at) row.connected_at = nowIso();
    }
  }
  async setAccountReplyTo(companyId: string, id: string, replyTo: string | null) {
    const row = this.accounts.get(id);
    if (row && row.company_id === companyId) row.reply_to = replyTo;
  }
  async getEspDomain(companyId: string, domain: string) {
    const row = this.espDomains.get(`${companyId}:${domain.toLowerCase()}`);
    return row ? structuredClone(row) : null;
  }
  async listEspDomains(companyId: string) {
    return [...this.espDomains.values()].filter((row) => row.company_id === companyId).sort((a, b) => a.domain.localeCompare(b.domain)).map((row) => structuredClone(row));
  }
  async upsertEspDomain(row: EspDomainRow) {
    const key = `${row.company_id}:${row.domain.toLowerCase()}`;
    const have = this.espDomains.get(key);
    const now = nowIso();
    if (!have) {
      this.espDomains.set(key, { ...structuredClone(row), domain: row.domain.toLowerCase(), client_kind: row.client_ref ? row.client_kind : null, first_sent_at: null, last_sent_at: null, warmup_exempt: false, daily_cap_override: null, reputation: null, verify_asked_at: null, created_at: now, updated_at: now });
      return;
    }
    Object.assign(have, { provider_domain_id: row.provider_domain_id, region: row.region, status: row.status, records: structuredClone(row.records), return_path_host: row.return_path_host, dkim_selector: row.dkim_selector, spf_include: row.spf_include, open_tracking: row.open_tracking ?? null, click_tracking: row.click_tracking ?? null, verified_at: row.verified_at ?? have.verified_at, checked_at: row.checked_at, updated_at: now });
  }
  async patchEspDomain(companyId: string, domain: string, patch: EspDomainPatch) {
    const row = this.espDomains.get(`${companyId}:${domain.toLowerCase()}`);
    if (!row) return;
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
    row.updated_at = nowIso();
  }
  private dayRow(companyId: string, domain: string, day: string): EspDayRow {
    const key = `${companyId}:${domain.toLowerCase()}:${day}`;
    let row = this.espDays.get(key);
    if (!row) {
      row = { company_id: companyId, domain: domain.toLowerCase(), day, sent: 0, delivered: 0, hard_bounces: 0, soft_bounces: 0, complaints: 0, opened: 0, clicked: 0, failed: 0 };
      this.espDays.set(key, row);
    }
    return row;
  }
  async reserveEspSends(companyId: string, domain: string, day: string, count: number, cap: number | null) {
    const row = this.dayRow(companyId, domain, day);
    if (cap !== null && row.sent + count > cap) return false;
    row.sent += count;
    return true;
  }
  async releaseEspSends(companyId: string, domain: string, day: string, count: number) {
    const row = this.espDays.get(`${companyId}:${domain.toLowerCase()}:${day}`);
    if (row) row.sent = Math.max(0, row.sent - count);
  }
  async noteEspSend(companyId: string, domain: string, atIso: string, restartWarmup: boolean) {
    const row = this.espDomains.get(`${companyId}:${domain.toLowerCase()}`);
    if (!row) return;
    if (!row.first_sent_at || restartWarmup) row.first_sent_at = atIso;
    row.last_sent_at = atIso;
  }
  async espDayRows(companyId: string, domain: string, sinceDay: string) {
    return [...this.espDays.values()].filter((row) => row.company_id === companyId && row.domain === domain.toLowerCase() && row.day >= sinceDay).sort((a, b) => a.day.localeCompare(b.day)).map((row) => ({ ...row }));
  }
  async bumpEspDay(companyId: string, domain: string, day: string, field: EspDayField, count: number) {
    this.dayRow(companyId, domain, day)[field] += count;
  }
  async recordEspEvent(input: EspEventInput) {
    if (this.espEvents.some((event) => event.companyId === input.companyId && (event.eventId === input.eventId || event.dedupeKey === input.dedupeKey))) return false;
    this.espEvents.push({ ...input, recipient: input.recipient.toLowerCase(), received_at: nowIso() });
    return true;
  }
  async forgetEspEvent(companyId: string, eventId: string) {
    this.espEvents = this.espEvents.filter((event) => !(event.companyId === companyId && event.eventId === eventId));
  }
  async purgeEspHistory(companyId: string, beforeIso: string, beforeDay: string) {
    const events = this.espEvents.length;
    this.espEvents = this.espEvents.filter((event) => event.companyId !== companyId || event.received_at >= beforeIso);
    let days = 0;
    for (const [key, row] of [...this.espDays]) {
      if (row.company_id === companyId && row.day < beforeDay) {
        this.espDays.delete(key);
        days += 1;
      }
    }
    return { events: events - this.espEvents.length, days };
  }
  async recipientHealth(companyId: string, emails: string[]) {
    const wanted = new Set(emails.map((email) => email.trim().toLowerCase()));
    return [...this.health.values()].filter((row) => row.company_id === companyId && wanted.has(row.email)).map((row) => ({ ...row }));
  }
  async recordSoftBounce(companyId: string, email: string, atIso: string, windowDays: number) {
    const address = email.trim().toLowerCase();
    const key = `${companyId}:${address}`;
    const have = this.health.get(key);
    const cold = have && Date.parse(have.last_soft_at) < Date.parse(atIso) - windowDays * 86_400_000;
    const row: RecipientHealthRow = !have || cold
      ? { company_id: companyId, email: address, soft_bounces: 1, first_soft_at: atIso, last_soft_at: atIso, backoff_until: have && !cold ? have.backoff_until : null }
      : { ...have, soft_bounces: have.soft_bounces + 1, last_soft_at: atIso };
    this.health.set(key, row);
    return { ...row };
  }
  async setBackoff(companyId: string, email: string, untilIso: string | null) {
    const row = this.health.get(`${companyId}:${email.trim().toLowerCase()}`);
    if (row) row.backoff_until = untilIso;
  }
  async clearRecipientHealth(companyId: string, email: string) {
    this.health.delete(`${companyId}:${email.trim().toLowerCase()}`);
  }
  async sendByProviderMessage(companyId: string, provider: string, providerMessageId: string) {
    const row = [...this.sends.values()].find((s) => s.company_id === companyId && s.provider === provider && s.provider_message_id === providerMessageId);
    return row ? { ...row } : null;
  }
  async markSendSentProvider(key: string, fields: { provider: string; providerMessageId: string; accountId: string; fromAddress: string; skipped?: SkippedRecipient[] }) {
    const row = this.sends.get(key);
    if (!row) return;
    Object.assign(row, { status: "sent", permanent: false, error: null, provider: fields.provider, provider_message_id: fields.providerMessageId, account_id: fields.accountId, from_address: fields.fromAddress, skipped: fields.skipped ?? [], sent_at: nowIso() });
    if (isPrivateMail(row.context)) row.request = scrubbedRequest(row.request);
  }
  async setSendDelivery(companyId: string, key: string, status: string, detail: Record<string, unknown>) {
    const row = this.sends.get(key);
    if (row && row.company_id === companyId) Object.assign(row, { delivery_status: status, delivery: { ...(row.delivery ?? {}), ...detail } });
  }
  async patchSendDelivery(companyId: string, key: string, detail: Record<string, unknown>) {
    const row = this.sends.get(key);
    if (row && row.company_id === companyId) row.delivery = { ...(row.delivery ?? {}), ...detail };
  }
  async markDraftSentProvider(companyId: string, id: string, fields: { context: SendContext; sendKey: string; fromAddress: string }) {
    const row = this.messages.get(id);
    if (!row || row.company_id !== companyId) return;
    Object.assign(row, { status: "sent", from_addr: { email: fields.fromAddress }, sent_context: fields.context, send_key: fields.sendKey, send_error: null });
  }
  async eraseEspRecipients(companyId: string, emails: string[]) {
    const wanted = new Set(emails.map((email) => email.trim().toLowerCase()));
    const before = this.espEvents.length;
    this.espEvents = this.espEvents.filter((event) => !(event.companyId === companyId && wanted.has(event.recipient)));
    let removed = before - this.espEvents.length;
    for (const [key, row] of [...this.health]) {
      if (row.company_id === companyId && wanted.has(row.email)) {
        this.health.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // erasure
  async crmContactEmails(companyId: string, contactId: string) {
    void companyId;
    return (this.crm.find((c) => c.kind === "contact" && c.id === contactId)?.emails ?? []).map((e) => e.toLowerCase());
  }
  private involves(m: MessageRow, emails: string[]): boolean {
    const set = new Set(emails.map((e) => e.toLowerCase()));
    return Boolean(m.from_addr && set.has(m.from_addr.email.toLowerCase())) || Boolean(m.reply_to_addr && set.has(m.reply_to_addr.email.toLowerCase())) || [...(m.to_addrs ?? []), ...(m.cc_addrs ?? []), ...(m.bcc_addrs ?? [])].some((a) => set.has(a.email.toLowerCase()));
  }
  async messagesInvolving(companyId: string, emails: string[]) {
    return [...this.messages.values()]
      .filter((m) => m.company_id === companyId && this.involves(m, emails))
      .map((m) => ({ id: m.id, account_id: m.account_id, gmail_thread_id: m.gmail_thread_id, status: m.status, direction: m.direction }));
  }
  async threadIssueIds(_companyId: string, threadIds: string[]) {
    const ids: string[] = [];
    for (const [key, issue] of this.threadIssues) {
      const thread = key.slice(key.indexOf(":") + 1);
      if (issue && threadIds.includes(thread)) ids.push(issue);
    }
    return ids;
  }
  decisionsLog: Array<{ company_id: string; subject_id: string }> = [];
  async deleteDecisionsFor(companyId: string, messageIds: string[]) {
    const before = this.decisionsLog.length;
    this.decisionsLog = this.decisionsLog.filter((d) => !(d.company_id === companyId && messageIds.includes(d.subject_id)));
    return before - this.decisionsLog.length;
  }
  async deleteMessages(companyId: string, ids: string[]) {
    let n = 0;
    for (const id of ids) if (this.messages.get(id)?.company_id === companyId && this.messages.delete(id)) n += 1;
    return n;
  }
  async sendKeysTo(companyId: string, emails: string[]) {
    const set = new Set(emails.map((e) => e.toLowerCase()));
    return [...this.sends.values()]
      .filter((s) => s.company_id === companyId && [...(s.to_addrs ?? []), ...((s.request as { cc?: Array<{ email: string }> }).cc ?? []), ...((s.request as { bcc?: Array<{ email: string }> }).bcc ?? [])].some((a) => set.has(a.email.toLowerCase())))
      .map((s) => s.key);
  }
  async redactSends(companyId: string, keys: string[]) {
    let n = 0;
    for (const key of keys) {
      const row = this.sends.get(key);
      if (!row || row.company_id !== companyId) continue;
      Object.assign(row, { to_addrs: [], subject: "[erased on request]", skipped: [], delivery: {}, error: row.error ? "[erased on request]" : null, request: { key: row.key, erased: true } });
      n += 1;
    }
    return n;
  }
  async scrubInboxResults(_companyId: string, keys: string[]) {
    void _companyId;
    let n = 0;
    for (const key of keys) {
      const result = this.inboxResults.get(key);
      if (!result) continue;
      const { error: _error, suppressed: _suppressed, ...rest } = result as Record<string, unknown>;
      void _error;
      void _suppressed;
      this.inboxResults.set(key, rest);
      n += 1;
    }
    return n;
  }
  leadOutbox: Array<{ company_id: string; key: string; payload: Record<string, unknown> }> = [];
  async deleteLeadOutbox(companyId: string, emails: string[]) {
    const set = new Set(emails.map((e) => e.toLowerCase()));
    const before = this.leadOutbox.length;
    this.leadOutbox = this.leadOutbox.filter((row) => !(row.company_id === companyId && typeof row.payload.email === "string" && set.has(row.payload.email.toLowerCase())));
    return before - this.leadOutbox.length;
  }
  async blankCrmProjection(companyId: string, contactId: string | null, emails: string[]) {
    void companyId;
    const set = new Set(emails.map((e) => e.toLowerCase()));
    let n = 0;
    for (const c of this.crm) {
      if (c.kind !== "contact") continue;
      if ((contactId && c.id === contactId) || c.emails.some((e) => set.has(e.toLowerCase()))) {
        Object.assign(c, { name: "", emails: [], accountIds: [] });
        n += 1;
      }
    }
    return n;
  }
  async eraseSuppression(input: { companyId: string; email: string; hash: string; scope: "marketing" | "all" }) {
    const email = input.email.trim().toLowerCase();
    let replaced = 0;
    let scope = input.scope;
    for (const [key, row] of [...this.suppressions]) {
      if (row.company_id === input.companyId && row.email === email) {
        if (row.scope === "all") scope = "all";
        this.suppressions.delete(key);
        replaced += 1;
      }
    }
    const marker = markerEmail(input.hash);
    const key = `${input.companyId}:${marker}:`;
    const existing = this.suppressions.get(key);
    const now = nowIso();
    if (existing) Object.assign(existing, { scope: existing.scope === "all" || scope === "all" ? "all" : "marketing", erased_at: now, updated_at: now });
    else this.suppressions.set(key, { company_id: input.companyId, email: marker, scope, reason: "manual", source: "partnersinbiz.mailbox", detail: "Erased on request: only a hash of the address is kept", sender_key: "", email_hash: input.hash, erased_at: now, created_at: now, updated_at: now });
    return { replaced };
  }
  async erasedMarkers(companyId: string) {
    const map = new Map<string, string>();
    for (const row of this.suppressions.values()) if (row.company_id === companyId && row.email_hash && row.erased_at) map.set(row.email_hash, row.erased_at);
    return map;
  }
}

export const CO = "co-1";
export const ENCRYPTION_KEY = "test-encryption-key-1234567890";

export interface FakeHost {
  ctx: PluginContext;
  /** Tables the kit writes through ctx.db (the lead outbox), run by the guarded generic fake db. */
  tables: Store;
  emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }>;
  issues: Map<string, Record<string, unknown>>;
  wakeups: string[];
  inbox: Map<string, Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
}

export function fakeHost(config: Record<string, unknown> = {}): FakeHost {
  const emitted: FakeHost["emitted"] = [];
  const issues = new Map<string, Record<string, unknown>>();
  const wakeups: string[] = [];
  const inbox = new Map<string, Record<string, unknown>>();
  const decisions: Array<Record<string, unknown>> = [];
  const fullConfig: Record<string, unknown> = {
    publicBaseUrl: "https://paperclip.example.com",
    encryptionKey: ENCRYPTION_KEY,
    google: { clientId: "client-id", clientSecret: "client-secret" },
    labelPrefix: "PiB",
    sendRatePerMinute: 20,
    ...config,
  };
  let issueSeq = 0;
  const state = new Map<string, unknown>();
  const tables: Store = { outbox: [] };
  const generic = createFakeDb(tables, {
    namespace: NAMESPACE,
    defaults: { outbox: { status: "pending", attempts: 0, last_error: null, result: null, settled_at: null } },
  });
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes(".inbox WHERE key = $1")) {
          const result = inbox.get(String(params[0]));
          return result ? [{ result }] : [];
        }
        if (sql.includes(`${NAMESPACE}.outbox`)) {
          if (/AS stuck/.test(sql)) return [{ stuck: "0", failed: String(tables.outbox!.filter((row) => row.status === "failed").length), oldest: null }];
          return generic.query(sql, params);
        }
        return [];
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (sql.includes(`${NAMESPACE}.outbox`)) return generic.execute(sql, params);
        if (sql.includes(`INSERT INTO ${NAMESPACE}.inbox`)) {
          inbox.set(String(params[0]), JSON.parse(String(params[3])));
          return { rowCount: 1 };
        }
        if (sql.includes(`INSERT INTO ${NAMESPACE}.decisions`)) {
          decisions.push({ id: params[0], purpose: params[2], subject_id: params[4], question_key: params[5], value_text: params[7], value_num: params[8], confidence: params[9], acted: params[12], corrected_to: null });
          return { rowCount: 1 };
        }
        if (sql.includes(`UPDATE ${NAMESPACE}.decisions SET corrected_to`)) {
          const row = decisions.find((d) => d.id === params[0]);
          if (!row) return { rowCount: 0 };
          row.corrected_to = params[2];
          row.corrected_by = params[3];
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    config: { get: async () => fullConfig },
    secrets: { resolve: async () => undefined },
    events: {
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload: JSON.parse(JSON.stringify(payload)) }),
      on: () => () => undefined,
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        issueSeq += 1;
        const issue = { id: `issue-${issueSeq}`, status: "todo", ...input };
        issues.set(issue.id, issue);
        return issue;
      },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>) => {
        const issue = issues.get(id);
        if (issue) Object.assign(issue, patch);
        return issue;
      },
      requestWakeup: async (id: string) => void wakeups.push(id),
    },
    // Real company state for the Mailbox's own keys (the unsubscribe proxy proof); every other key still answers with the UI base.
    state: {
      get: async (key: { namespace?: string }) => {
        const stored = state.get(JSON.stringify(key));
        if (stored !== undefined) return stored;
        return key.namespace === "mailbox-unsubscribe" ? null : "/_plugins/11111111-2222-3333-4444-555555555555/ui/";
      },
      set: async (key: { namespace?: string }, value: unknown) => void state.set(JSON.stringify(key), JSON.parse(JSON.stringify(value))),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, tables, emitted, issues, wakeups, inbox, decisions, config: fullConfig };
}

export function testEnv(host: FakeHost, store: MemoryStore, fetchImpl: FetchLike, jevFetch?: typeof fetch): Env {
  return createEnv(host.ctx, store, { fetch: fetchImpl, jevFetch });
}
