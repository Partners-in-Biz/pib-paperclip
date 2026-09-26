/**
 * In-memory GmailStore and a fake host context (inbox/decisions SQL for the
 * kit, events, issues, config) for the Gmail logic tests.
 */
import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AccountPatch, GmailStore, SentFields } from "../../src/db.js";
import { createEnv, type Env } from "../../src/gmail/env.js";
import type {
  AccountRow,
  CrmClientRow,
  InboxFilter,
  MessageRow,
  NewGmailMessage,
  OAuthSessionRow,
  SendContext,
  SendRecordInput,
  SendRow,
  SendStatus,
  TriageWrite,
} from "../../src/gmail/types.js";
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
  /** Claim times per account, for the rate limit. */
  claims: Array<{ accountId: string; at: number }> = [];

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
      .filter((a) => a.company_id === companyId && a.token_sealed && (a.status === "connected" || a.status === "needs_reconnect"))
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
  async getMessageByGmailId(companyId: string, gmailMessageId: string) {
    const row = [...this.messages.values()].find((m) => m.company_id === companyId && m.gmail_message_id === gmailMessageId);
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
  async recordSendFailure(input: SendRecordInput, error: string, permanent: boolean) {
    const existing = this.sends.get(input.key);
    if (existing?.status === "sent") return;
    const row = existing ?? this.newSend(input, "failed");
    Object.assign(row, { status: "failed", permanent, error, attempts: existing ? row.attempts : 1 });
    this.sends.set(input.key, row);
  }
  async markRetrying(input: SendRecordInput, error: string) {
    const existing = this.sends.get(input.key);
    if (existing?.status === "sent") return;
    const row = existing ?? this.newSend(input, "retrying");
    Object.assign(row, { status: "retrying", error });
    this.sends.set(input.key, row);
  }
  async markSendSent(key: string, fields: SentFields) {
    const row = this.sends.get(key);
    if (!row) return;
    Object.assign(row, {
      status: "sent",
      permanent: false,
      error: null,
      gmail_message_id: fields.gmailMessageId,
      gmail_thread_id: fields.gmailThreadId,
      rfc_message_id: fields.rfcMessageId,
      account_id: fields.accountId,
      from_address: fields.fromAddress,
      sent_at: nowIso(),
    });
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
}

export const CO = "co-1";
export const ENCRYPTION_KEY = "test-encryption-key-1234567890";

export interface FakeHost {
  ctx: PluginContext;
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
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes(".inbox WHERE key = $1")) {
          const result = inbox.get(String(params[0]));
          return result ? [{ result }] : [];
        }
        return [];
      },
      execute: async (sql: string, params: unknown[] = []) => {
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
    state: { get: async () => "/_plugins/11111111-2222-3333-4444-555555555555/ui/", set: async () => undefined },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, emitted, issues, wakeups, inbox, decisions, config: fullConfig };
}

export function testEnv(host: FakeHost, store: MemoryStore, fetchImpl: FetchLike, jevFetch?: typeof fetch): Env {
  return createEnv(host.ctx, store, { fetch: fetchImpl, jevFetch });
}
