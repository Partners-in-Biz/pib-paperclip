/**
 * Data access. Every statement is one fully-qualified statement in the
 * plugin namespace (host SQL guard); lists travel as JSON and are expanded in
 * SQL. `GmailStore` is what the Gmail logic needs (tests use an in-memory
 * one); `SqlStore` also carries the older delegation/draft/template queries.
 */
import type { MailAddress, MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import type {
  AccountRow,
  CrmClientRow,
  DraftExtras,
  InboxFilter,
  MessageRow,
  NewGmailMessage,
  OAuthSessionRow,
  SendContext,
  SendRecordInput,
  SendRow,
  SendStatus,
  TriageWrite,
} from "./gmail/types.js";

export interface DbClient {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export type AccountPatch = Partial<{
  provider: string;
  address: string;
  status: AccountRow["status"];
  token_sealed: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  key_version: number | null;
  history_id: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  sync_stats: Record<string, unknown>;
  connected_by_user_id: string | null;
  connected_at: string | null;
  alert_issue_id: string | null;
  is_default: boolean;
}>;

export interface SentFields {
  gmailMessageId: string;
  gmailThreadId: string;
  rfcMessageId: string | null;
  accountId: string;
  fromAddress: string;
}

export interface GmailStore {
  // accounts
  listSyncAccounts(): Promise<AccountRow[]>;
  listAccounts(companyId: string): Promise<AccountRow[]>;
  getAccount(companyId: string, id: string): Promise<AccountRow | null>;
  findAccountByAddress(companyId: string, address: string): Promise<AccountRow | null>;
  defaultAccount(companyId: string): Promise<AccountRow | null>;
  insertAccount(row: { id: string; companyId: string; provider: string; address: string; ownerUserId: string | null; isDefault: boolean }): Promise<void>;
  updateAccount(companyId: string, id: string, patch: AccountPatch): Promise<void>;
  /** Moves the account to needs_reconnect; true only for the call that changed it. */
  markNeedsReconnect(companyId: string, id: string, error: string): Promise<boolean>;
  setDefaultAccount(companyId: string, id: string): Promise<void>;
  tryLockSync(accountId: string, seconds: number): Promise<boolean>;
  unlockSync(accountId: string): Promise<void>;
  mergeLabelIds(accountId: string, map: Record<string, string>): Promise<void>;
  // messages
  existingGmailIds(accountId: string, ids: string[]): Promise<Set<string>>;
  insertGmailMessage(row: NewGmailMessage): Promise<boolean>;
  updateLabels(accountId: string, gmailMessageId: string, labels: string[]): Promise<void>;
  untriaged(accountId: string, limit: number): Promise<MessageRow[]>;
  setTriage(companyId: string, id: string, write: TriageWrite): Promise<void>;
  recentInbound(accountId: string, minutes: number, limit: number): Promise<MessageRow[]>;
  getMessage(companyId: string, id: string): Promise<MessageRow | null>;
  getMessageByGmailId(companyId: string, gmailMessageId: string): Promise<MessageRow | null>;
  getMessageByRfcId(companyId: string, rfcMessageId: string): Promise<MessageRow | null>;
  outboundByRfcIds(companyId: string, ids: string[]): Promise<MessageRow[]>;
  outboundInThread(companyId: string, threadId: string): Promise<MessageRow | null>;
  /** Newest message with a Message-ID in a Gmail thread (for follow-up headers). */
  latestInThread(companyId: string, threadId: string): Promise<MessageRow | null>;
  listInbox(companyId: string, filter: InboxFilter): Promise<MessageRow[]>;
  markDraftSent(companyId: string, id: string, fields: SentFields & { context: SendContext; sendKey: string }): Promise<void>;
  setDraftStatus(companyId: string, id: string, status: "draft" | "queued", error: string | null): Promise<void>;
  // send requests
  recentClaims(accountId: string): Promise<number>;
  claimSend(input: SendRecordInput, force: boolean): Promise<boolean>;
  recordSendFailure(input: SendRecordInput, error: string, permanent: boolean): Promise<void>;
  markRetrying(input: SendRecordInput, error: string): Promise<void>;
  markSendSent(key: string, fields: SentFields): Promise<void>;
  getSend(companyId: string, key: string): Promise<SendRow | null>;
  listSends(companyId: string, options: { status?: SendStatus | null; limit: number }): Promise<SendRow[]>;
  sendByThread(companyId: string, threadId: string): Promise<SendRow | null>;
  sendsByRfcIds(companyId: string, ids: string[]): Promise<SendRow[]>;
  /** Newest sent request to this address in the last 30 days (bounce matching). */
  sendToRecipient(companyId: string, email: string): Promise<SendRow | null>;
  setInboxResult(key: string, result: Record<string, unknown>): Promise<void>;
  // thread issues
  claimThreadIssue(companyId: string, accountId: string, threadId: string): Promise<boolean>;
  setThreadIssue(accountId: string, threadId: string, issueId: string): Promise<void>;
  // OAuth sessions
  insertOAuthSession(row: { state: string; companyId: string; createdByUserId: string | null; returnTo: string | null; ttlSeconds: number }): Promise<void>;
  getOAuthSession(state: string): Promise<OAuthSessionRow | null>;
  deleteOAuthSession(state: string): Promise<void>;
  // CRM projection
  crmContactsByEmail(companyId: string, email: string): Promise<CrmClientRow[]>;
  crmCompaniesByDomain(companyId: string, domain: string): Promise<CrmClientRow[]>;
  crmCompany(companyId: string, id: string): Promise<CrmClientRow | null>;
  crmClients(companyId: string, limit: number): Promise<CrmClientRow[]>;
}

const ACCOUNT_COLUMNS =
  "id, company_id, provider, address, status, token_sealed, token_expires_at, scopes, history_id, last_sync_at, last_error, sync_stats, connected_by_user_id, connected_at, alert_issue_id, is_default, label_ids, owner_user_id, created_at";

const MESSAGE_COLUMNS =
  "id, company_id, account_id, subject, body, direction, status, created_at, read_at, gmail_message_id, gmail_thread_id, rfc_message_id, in_reply_to, refs, from_addr, to_addrs, cc_addrs, bcc_addrs, snippet, labels, attachments, bulk, received_at, triage, triaged_at, category, urgency, needs_reply, phishing, client_kind, client_ref, reply_to, sent_context, send_key, draft, send_error, bounce";

const SEND_COLUMNS =
  "key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, permanent, attempts, gmail_message_id, gmail_thread_id, rfc_message_id, error, context, request, claimed_at, sent_at, created_at, updated_at";

/** Column → SQL cast for account patches. Only these columns can be patched. */
const ACCOUNT_PATCH_CASTS: Record<keyof AccountPatch, string> = {
  provider: "",
  address: "",
  status: "",
  token_sealed: "",
  token_expires_at: "::timestamptz",
  scopes: "",
  key_version: "::int",
  history_id: "",
  last_sync_at: "::timestamptz",
  last_error: "",
  sync_stats: "::jsonb",
  connected_by_user_id: "",
  connected_at: "::timestamptz",
  alert_issue_id: "",
  is_default: "::boolean",
};

const textArray = (n: number) => `ARRAY(SELECT jsonb_array_elements_text($${n}::jsonb))`;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normaliseAccount(row: AccountRow): AccountRow {
  return {
    ...row,
    token_expires_at: iso(row.token_expires_at),
    last_sync_at: iso(row.last_sync_at),
    connected_at: iso(row.connected_at),
    created_at: iso(row.created_at) ?? "",
    label_ids: row.label_ids ?? {},
    sync_stats: row.sync_stats ?? {},
  };
}

function normaliseMessage(row: MessageRow): MessageRow {
  return {
    ...row,
    created_at: iso(row.created_at) ?? "",
    read_at: iso(row.read_at),
    received_at: iso(row.received_at),
    triaged_at: iso(row.triaged_at),
    refs: row.refs ?? [],
    to_addrs: row.to_addrs ?? [],
    cc_addrs: row.cc_addrs ?? [],
    bcc_addrs: row.bcc_addrs ?? [],
    labels: row.labels ?? [],
    attachments: row.attachments ?? [],
  };
}

function normaliseSend(row: SendRow): SendRow {
  return {
    ...row,
    attempts: Number(row.attempts ?? 0),
    claimed_at: iso(row.claimed_at),
    sent_at: iso(row.sent_at),
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at) ?? "",
    to_addrs: row.to_addrs ?? [],
  };
}

interface CrmContactDb {
  id: string;
  name: string;
  emails: string[] | null;
  account_ids: string[] | null;
}
interface CrmCompanyDb {
  id: string;
  name: string;
  domain: string | null;
}

const contactRow = (row: CrmContactDb): CrmClientRow => ({ kind: "contact", id: row.id, name: row.name, domain: null, emails: row.emails ?? [], accountIds: row.account_ids ?? [] });
const companyRow = (row: CrmCompanyDb): CrmClientRow => ({ kind: "company", id: row.id, name: row.name, domain: row.domain, emails: [], accountIds: [] });

/** `https://www.acme.co.za/x` → `acme.co.za`, in SQL. */
const DOMAIN_SQL = "split_part(regexp_replace(lower(coalesce(domain, '')), '^(https?://)?(www[.])?', ''), '/', 1)";

export class SqlStore implements GmailStore {
  constructor(readonly db: DbClient) {}

  /** Checked per call so a bad namespace fails the query, not the plugin's setup. */
  t(name: string): string {
    const ns = this.db.namespace;
    if (!/^plugin_[a-z0-9_]+$/.test(ns) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
    return `${ns}.${name}`;
  }

  // ── accounts ────────────────────────────────────────────────────────────

  async listSyncAccounts(): Promise<AccountRow[]> {
    const rows = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ${this.t("accounts")} WHERE status = 'connected' AND token_sealed IS NOT NULL ORDER BY company_id, created_at`,
    );
    return rows.map(normaliseAccount);
  }

  async listAccounts(companyId: string): Promise<AccountRow[]> {
    const rows = await this.db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${this.t("accounts")} WHERE company_id = $1 ORDER BY address`, [companyId]);
    return rows.map(normaliseAccount);
  }

  async getAccount(companyId: string, id: string): Promise<AccountRow | null> {
    const rows = await this.db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${this.t("accounts")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
    return rows[0] ? normaliseAccount(rows[0]) : null;
  }

  async findAccountByAddress(companyId: string, address: string): Promise<AccountRow | null> {
    const rows = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ${this.t("accounts")} WHERE company_id = $1 AND lower(address) = lower($2)
        ORDER BY (status = 'connected') DESC, (token_sealed IS NOT NULL) DESC, created_at LIMIT 1`,
      [companyId, address],
    );
    return rows[0] ? normaliseAccount(rows[0]) : null;
  }

  async defaultAccount(companyId: string): Promise<AccountRow | null> {
    const rows = await this.db.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ${this.t("accounts")}
        WHERE company_id = $1 AND status IN ('connected', 'needs_reconnect') AND token_sealed IS NOT NULL
        ORDER BY is_default DESC, (status = 'connected') DESC, created_at LIMIT 1`,
      [companyId],
    );
    return rows[0] ? normaliseAccount(rows[0]) : null;
  }

  async insertAccount(row: { id: string; companyId: string; provider: string; address: string; ownerUserId: string | null; isDefault: boolean }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("accounts")} (id, company_id, provider, address, owner_user_id, is_default) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.companyId, row.provider, row.address, row.ownerUserId, row.isDefault],
    );
  }

  async updateAccount(companyId: string, id: string, patch: AccountPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id, companyId];
    for (const [key, value] of Object.entries(patch) as Array<[keyof AccountPatch, unknown]>) {
      if (!(key in ACCOUNT_PATCH_CASTS) || value === undefined) continue;
      const cast = ACCOUNT_PATCH_CASTS[key];
      params.push(cast === "::jsonb" ? json(value) : value);
      sets.push(`${key} = $${params.length}${cast}`);
    }
    if (sets.length === 0) return;
    await this.db.execute(`UPDATE ${this.t("accounts")} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND company_id = $2`, params);
  }

  async markNeedsReconnect(companyId: string, id: string, error: string): Promise<boolean> {
    const res = await this.db.execute(
      `UPDATE ${this.t("accounts")} SET status = 'needs_reconnect', last_error = $3, updated_at = now()
        WHERE id = $1 AND company_id = $2 AND status = 'connected'`,
      [id, companyId, error.slice(0, 500)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setDefaultAccount(companyId: string, id: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("accounts")} SET is_default = (id = $2), updated_at = now() WHERE company_id = $1`, [companyId, id]);
  }

  async tryLockSync(accountId: string, seconds: number): Promise<boolean> {
    const res = await this.db.execute(
      `UPDATE ${this.t("accounts")} SET sync_lock_until = now() + make_interval(secs => $2::int)
        WHERE id = $1 AND (sync_lock_until IS NULL OR sync_lock_until < now())`,
      [accountId, seconds],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unlockSync(accountId: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("accounts")} SET sync_lock_until = NULL WHERE id = $1`, [accountId]);
  }

  async mergeLabelIds(accountId: string, map: Record<string, string>): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("accounts")} SET label_ids = label_ids || $2::jsonb, updated_at = now() WHERE id = $1`, [accountId, json(map)]);
  }

  // ── messages ────────────────────────────────────────────────────────────

  async existingGmailIds(accountId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db.query<{ gmail_message_id: string }>(
      `SELECT gmail_message_id FROM ${this.t("messages")} WHERE account_id = $1 AND gmail_message_id = ANY(${textArray(2)})`,
      [accountId, json(ids)],
    );
    return new Set(rows.map((row) => row.gmail_message_id));
  }

  async insertGmailMessage(row: NewGmailMessage): Promise<boolean> {
    const res = await this.db.execute(
      `INSERT INTO ${this.t("messages")}
        (id, company_id, account_id, subject, body, direction, status, gmail_message_id, gmail_thread_id, rfc_message_id, in_reply_to, refs,
         from_addr, to_addrs, cc_addrs, bcc_addrs, snippet, labels, attachments, bulk, received_at, read_at, sent_context, send_key, triaged_at, bounce)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17::jsonb, $18::jsonb, $19,
         $20::timestamptz, CASE WHEN $21::boolean THEN now() ELSE NULL END, $22::jsonb, $23, CASE WHEN $24::boolean THEN now() ELSE NULL END, $25::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        row.id,
        row.companyId,
        row.accountId,
        row.subject.slice(0, 1000),
        row.direction,
        row.status,
        row.gmailMessageId,
        row.gmailThreadId,
        row.rfcMessageId,
        row.inReplyTo,
        json(row.refs),
        json(row.from),
        json(row.to),
        json(row.cc),
        json(row.bcc ?? []),
        row.snippet.slice(0, 1000),
        json(row.labels),
        json(row.attachments),
        row.bulk,
        row.receivedAt,
        row.read,
        json(row.sentContext ?? null),
        row.sendKey ?? null,
        row.triaged === true,
        json(row.bounce ?? null),
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateLabels(accountId: string, gmailMessageId: string, labels: string[]): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("messages")} SET labels = $3::jsonb,
         read_at = CASE WHEN $4::boolean THEN NULL ELSE COALESCE(read_at, now()) END, updated_at = now()
        WHERE account_id = $1 AND gmail_message_id = $2`,
      [accountId, gmailMessageId, json(labels), labels.includes("UNREAD")],
    );
  }

  async untriaged(accountId: string, limit: number): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE account_id = $1 AND direction = 'inbound' AND triaged_at IS NULL AND gmail_message_id IS NOT NULL
          AND created_at >= now() - interval '2 days'
        ORDER BY received_at DESC NULLS LAST LIMIT $2`,
      [accountId, limit],
    );
    return rows.map(normaliseMessage);
  }

  async setTriage(companyId: string, id: string, write: TriageWrite): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("messages")} SET triage = $3::jsonb, category = $4, urgency = $5, needs_reply = $6, phishing = $7,
         client_kind = $8, client_ref = $9, reply_to = $10::jsonb, triaged_at = now(), updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [
        id,
        companyId,
        json(write.triage),
        write.category,
        write.urgency,
        write.needsReply,
        write.phishing,
        write.clientKind,
        write.clientRef,
        json(write.replyTo),
      ],
    );
  }

  async recentInbound(accountId: string, minutes: number, limit: number): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE account_id = $1 AND direction = 'inbound' AND gmail_message_id IS NOT NULL AND triaged_at IS NOT NULL
          AND created_at >= now() - make_interval(mins => $2::int)
          AND received_at >= now() - interval '1 day'
        ORDER BY received_at DESC LIMIT $3`,
      [accountId, minutes, limit],
    );
    return rows.map(normaliseMessage);
  }

  async getMessage(companyId: string, id: string): Promise<MessageRow | null> {
    const rows = await this.db.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
    return rows[0] ? normaliseMessage(rows[0]) : null;
  }

  async getMessageByGmailId(companyId: string, gmailMessageId: string): Promise<MessageRow | null> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")} WHERE company_id = $1 AND gmail_message_id = $2 ORDER BY created_at LIMIT 1`,
      [companyId, gmailMessageId],
    );
    return rows[0] ? normaliseMessage(rows[0]) : null;
  }

  async getMessageByRfcId(companyId: string, rfcMessageId: string): Promise<MessageRow | null> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")} WHERE company_id = $1 AND rfc_message_id = $2 ORDER BY created_at LIMIT 1`,
      [companyId, rfcMessageId],
    );
    return rows[0] ? normaliseMessage(rows[0]) : null;
  }

  async outboundByRfcIds(companyId: string, ids: string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE company_id = $1 AND direction = 'outbound' AND rfc_message_id = ANY(${textArray(2)}) ORDER BY created_at DESC LIMIT 20`,
      [companyId, json(ids)],
    );
    return rows.map(normaliseMessage);
  }

  async outboundInThread(companyId: string, threadId: string): Promise<MessageRow | null> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE company_id = $1 AND direction = 'outbound' AND gmail_thread_id = $2 AND sent_context IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [companyId, threadId],
    );
    return rows[0] ? normaliseMessage(rows[0]) : null;
  }

  async latestInThread(companyId: string, threadId: string): Promise<MessageRow | null> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE company_id = $1 AND gmail_thread_id = $2 AND rfc_message_id IS NOT NULL
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`,
      [companyId, threadId],
    );
    return rows[0] ? normaliseMessage(rows[0]) : null;
  }

  async listInbox(companyId: string, filter: InboxFilter): Promise<MessageRow[]> {
    const where = ["company_id = $1", "direction = 'inbound'"];
    const params: unknown[] = [companyId];
    if (filter.accountId) {
      params.push(filter.accountId);
      where.push(`account_id = $${params.length}`);
    }
    if (filter.category) {
      params.push(filter.category);
      where.push(`category = $${params.length}`);
    }
    if (filter.needsReply) where.push("needs_reply >= 0.5");
    if (filter.clientRef) {
      params.push(filter.clientRef);
      where.push(`client_ref = $${params.length}`);
      if (filter.clientKind) {
        params.push(filter.clientKind);
        where.push(`client_kind = $${params.length}`);
      }
    }
    params.push(Math.max(1, Math.min(filter.limit, 500)));
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")} WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(normaliseMessage);
  }

  async markDraftSent(companyId: string, id: string, fields: SentFields & { context: SendContext; sendKey: string }): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("messages")} SET status = 'sent', gmail_message_id = $3, gmail_thread_id = $4, rfc_message_id = $5,
         from_addr = $6::jsonb, sent_context = $7::jsonb, send_key = $8, send_error = NULL, received_at = now(), triaged_at = now(), updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [id, companyId, fields.gmailMessageId, fields.gmailThreadId, fields.rfcMessageId, json({ email: fields.fromAddress }), json(fields.context), fields.sendKey],
    );
  }

  async setDraftStatus(companyId: string, id: string, status: "draft" | "queued", error: string | null): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("messages")} SET status = $3, send_error = $4, updated_at = now() WHERE id = $1 AND company_id = $2`,
      [id, companyId, status, error],
    );
  }

  // ── send requests ───────────────────────────────────────────────────────

  async recentClaims(accountId: string): Promise<number> {
    const rows = await this.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${this.t("send_requests")} WHERE account_id = $1 AND claimed_at > now() - interval '1 minute'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async claimSend(input: SendRecordInput, force: boolean): Promise<boolean> {
    const res = await this.db.execute(
      `INSERT INTO ${this.t("send_requests")} AS sr
        (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, attempts, context, request, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'sending', 1, $8::jsonb, $9::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = sr.attempts + 1, claimed_at = now(), updated_at = now(),
         account_id = EXCLUDED.account_id, from_address = EXCLUDED.from_address, error = NULL, permanent = false
       WHERE sr.status = 'retrying'
          OR (sr.status = 'sending' AND sr.claimed_at < now() - interval '10 minutes')
          OR ($10::boolean AND sr.status = 'failed')`,
      [
        input.key,
        input.companyId,
        input.sourcePlugin,
        input.accountId,
        input.fromAddress,
        json(input.to),
        input.subject.slice(0, 1000),
        json(input.context),
        json(input.request),
        force,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordSendFailure(input: SendRecordInput, error: string, permanent: boolean): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("send_requests")} AS sr
        (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, permanent, attempts, error, context, request)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'failed', $8, 1, $9, $10::jsonb, $11::jsonb)
       ON CONFLICT (key) DO UPDATE SET status = 'failed', permanent = EXCLUDED.permanent, error = EXCLUDED.error, updated_at = now()
       WHERE sr.status <> 'sent'`,
      [
        input.key,
        input.companyId,
        input.sourcePlugin,
        input.accountId,
        input.fromAddress,
        json(input.to),
        input.subject.slice(0, 1000),
        permanent,
        error.slice(0, 1000),
        json(input.context),
        json(input.request),
      ],
    );
  }

  async markRetrying(input: SendRecordInput, error: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("send_requests")} AS sr
        (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, attempts, error, context, request)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'retrying', 0, $8, $9::jsonb, $10::jsonb)
       ON CONFLICT (key) DO UPDATE SET status = 'retrying', error = EXCLUDED.error, updated_at = now()
       WHERE sr.status <> 'sent'`,
      [
        input.key,
        input.companyId,
        input.sourcePlugin,
        input.accountId,
        input.fromAddress,
        json(input.to),
        input.subject.slice(0, 1000),
        error.slice(0, 1000),
        json(input.context),
        json(input.request),
      ],
    );
  }

  async markSendSent(key: string, fields: SentFields): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("send_requests")} SET status = 'sent', permanent = false, error = NULL, gmail_message_id = $2, gmail_thread_id = $3,
         rfc_message_id = $4, account_id = $5, from_address = $6, sent_at = now(), updated_at = now()
        WHERE key = $1`,
      [key, fields.gmailMessageId, fields.gmailThreadId, fields.rfcMessageId, fields.accountId, fields.fromAddress],
    );
  }

  async getSend(companyId: string, key: string): Promise<SendRow | null> {
    const rows = await this.db.query<SendRow>(`SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")} WHERE company_id = $1 AND key = $2`, [companyId, key]);
    return rows[0] ? normaliseSend(rows[0]) : null;
  }

  async listSends(companyId: string, options: { status?: SendStatus | null; limit: number }): Promise<SendRow[]> {
    const params: unknown[] = [companyId];
    let where = "company_id = $1";
    if (options.status) {
      params.push(options.status);
      where += ` AND status = $${params.length}`;
    }
    params.push(Math.max(1, Math.min(options.limit, 500)));
    const rows = await this.db.query<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")} WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(normaliseSend);
  }

  async sendByThread(companyId: string, threadId: string): Promise<SendRow | null> {
    const rows = await this.db.query<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")} WHERE company_id = $1 AND gmail_thread_id = $2 AND status = 'sent'
        ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [companyId, threadId],
    );
    return rows[0] ? normaliseSend(rows[0]) : null;
  }

  async sendsByRfcIds(companyId: string, ids: string[]): Promise<SendRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")} WHERE company_id = $1 AND rfc_message_id = ANY(${textArray(2)})
        ORDER BY sent_at DESC NULLS LAST LIMIT 20`,
      [companyId, json(ids)],
    );
    return rows.map(normaliseSend);
  }

  async sendToRecipient(companyId: string, email: string): Promise<SendRow | null> {
    const rows = await this.db.query<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")}
        WHERE company_id = $1 AND status = 'sent' AND to_addrs @> $2::jsonb AND sent_at >= now() - interval '30 days'
        ORDER BY sent_at DESC LIMIT 1`,
      [companyId, json([{ email: email.toLowerCase() }])],
    );
    return rows[0] ? normaliseSend(rows[0]) : null;
  }

  async setInboxResult(key: string, result: Record<string, unknown>): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("inbox")} SET result = $2::jsonb WHERE key = $1`, [key, json(result)]);
  }

  // ── thread issues ───────────────────────────────────────────────────────

  async claimThreadIssue(companyId: string, accountId: string, threadId: string): Promise<boolean> {
    const res = await this.db.execute(
      `INSERT INTO ${this.t("thread_issues")} (account_id, gmail_thread_id, company_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [accountId, threadId, companyId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setThreadIssue(accountId: string, threadId: string, issueId: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("thread_issues")} SET issue_id = $3 WHERE account_id = $1 AND gmail_thread_id = $2`, [accountId, threadId, issueId]);
  }

  // ── OAuth sessions ──────────────────────────────────────────────────────

  async insertOAuthSession(row: { state: string; companyId: string; createdByUserId: string | null; returnTo: string | null; ttlSeconds: number }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("oauth_sessions")} (state, company_id, created_by_user_id, return_to, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))`,
      [row.state, row.companyId, row.createdByUserId, row.returnTo, row.ttlSeconds],
    );
  }

  async getOAuthSession(state: string): Promise<OAuthSessionRow | null> {
    const rows = await this.db.query<{ state: string; company_id: string; created_by_user_id: string | null; return_to: string | null; expired: boolean }>(
      `SELECT state, company_id, created_by_user_id, return_to, expires_at < now() AS expired FROM ${this.t("oauth_sessions")} WHERE state = $1`,
      [state],
    );
    const row = rows[0];
    return row ? { state: row.state, companyId: row.company_id, createdByUserId: row.created_by_user_id, returnTo: row.return_to, expired: Boolean(row.expired) } : null;
  }

  async deleteOAuthSession(state: string): Promise<void> {
    await this.db.execute(`DELETE FROM ${this.t("oauth_sessions")} WHERE state = $1 OR expires_at < now() - interval '1 day'`, [state]);
  }

  // ── CRM projection ──────────────────────────────────────────────────────

  async crmContactsByEmail(companyId: string, email: string): Promise<CrmClientRow[]> {
    const rows = await this.db.query<CrmContactDb>(
      `SELECT id, name, emails, account_ids FROM ${this.t("crm_contacts")}
        WHERE company_id = $1 AND deleted = false AND EXISTS (SELECT 1 FROM unnest(emails) AS e WHERE lower(e) = lower($2))
        ORDER BY lower(name) LIMIT 5`,
      [companyId, email],
    );
    return rows.map(contactRow);
  }

  async crmCompaniesByDomain(companyId: string, domain: string): Promise<CrmClientRow[]> {
    const rows = await this.db.query<CrmCompanyDb>(
      `SELECT id, name, domain FROM ${this.t("crm_companies")} WHERE company_id = $1 AND deleted = false AND ${DOMAIN_SQL} = lower($2)
        ORDER BY lower(name) LIMIT 5`,
      [companyId, domain],
    );
    return rows.map(companyRow);
  }

  async crmCompany(companyId: string, id: string): Promise<CrmClientRow | null> {
    const rows = await this.db.query<CrmCompanyDb>(
      `SELECT id, name, domain FROM ${this.t("crm_companies")} WHERE company_id = $1 AND id = $2 AND deleted = false`,
      [companyId, id],
    );
    return rows[0] ? companyRow(rows[0]) : null;
  }

  async crmClients(companyId: string, limit: number): Promise<CrmClientRow[]> {
    const companies = await this.db.query<CrmCompanyDb>(
      `SELECT id, name, domain FROM ${this.t("crm_companies")} WHERE company_id = $1 AND deleted = false ORDER BY lower(name) LIMIT $2`,
      [companyId, limit],
    );
    const contacts = await this.db.query<CrmContactDb>(
      `SELECT id, name, emails, account_ids FROM ${this.t("crm_contacts")} WHERE company_id = $1 AND deleted = false ORDER BY lower(name) LIMIT $2`,
      [companyId, limit],
    );
    return [...companies.map(companyRow), ...contacts.map(contactRow)];
  }

  // ── delegations, drafts, templates (existing tools) ─────────────────────

  async listDelegations(companyId: string) {
    return this.db.query<{ id: string; account_id: string; agent_id: string; can_read: boolean; can_draft: boolean; can_send: boolean }>(
      `SELECT id, account_id, agent_id, can_read, can_draft, can_send FROM ${this.t("delegations")} WHERE company_id = $1`,
      [companyId],
    );
  }

  async insertLegacyAccount(row: { id: string; companyId: string; provider: string; address: string; secretRef: string | null; ownerUserId: string | null }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("accounts")} (id, company_id, provider, address, secret_ref, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.companyId, row.provider, row.address, row.secretRef, row.ownerUserId],
    );
  }

  async insertDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("delegations")} (id, company_id, account_id, agent_id, can_read, can_draft, can_send) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.companyId, row.accountId, row.agentId, row.canRead, row.canDraft, row.canSend],
    );
  }

  async delegationFor(accountId: string, agentId: string): Promise<{ can_read: boolean; can_draft: boolean; can_send: boolean } | null> {
    const rows = await this.db.query<{ can_read: boolean; can_draft: boolean; can_send: boolean }>(
      `SELECT can_read, can_draft, can_send FROM ${this.t("delegations")} WHERE account_id = $1 AND agent_id = $2 LIMIT 1`,
      [accountId, agentId],
    );
    return rows[0] ?? null;
  }

  async readableAccounts(companyId: string, agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ account_id: string }>(
      `SELECT account_id FROM ${this.t("delegations")} WHERE company_id = $1 AND agent_id = $2 AND can_read = true`,
      [companyId, agentId],
    );
    return rows.map((row) => row.account_id);
  }

  async insertDraft(row: {
    id: string;
    companyId: string;
    accountId: string;
    subject: string;
    body: string;
    to: MailAddress[];
    cc: MailAddress[];
    bcc: MailAddress[];
    draft: DraftExtras;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("messages")} (id, company_id, account_id, subject, body, direction, status, to_addrs, cc_addrs, bcc_addrs, draft)
       VALUES ($1, $2, $3, $4, $5, 'outbound', 'draft', $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
      [row.id, row.companyId, row.accountId, row.subject, row.body, json(row.to), json(row.cc), json(row.bcc), json(row.draft)],
    );
  }

  async recentMessages(companyId: string, limit: number) {
    return this.db.query<Record<string, unknown>>(
      `SELECT id, account_id, subject, status, direction, read_at IS NOT NULL AS is_read, to_addrs, send_error, created_at
         FROM ${this.t("messages")} WHERE company_id = $1 AND ((direction = 'outbound' AND status <> 'sent') OR gmail_message_id IS NULL)
        ORDER BY created_at DESC LIMIT $2`,
      [companyId, limit],
    );
  }

  async unreadCount(companyId: string): Promise<number> {
    const rows = await this.db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM ${this.t("messages")} WHERE company_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
      [companyId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async markRead(companyId: string, id: string): Promise<{ rowCount: number }> {
    return this.db.execute(
      `UPDATE ${this.t("messages")} SET read_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND direction = 'inbound'`,
      [id, companyId],
    );
  }

  async threadRows(companyId: string, accountId: string | null, limit: number) {
    const params: unknown[] = accountId ? [companyId, accountId, limit] : [companyId, limit];
    return this.db.query<Record<string, unknown>>(
      `SELECT id, account_id, subject, status, direction, read_at IS NOT NULL AS is_read, created_at, gmail_thread_id, from_addr, snippet, received_at, category
         FROM ${this.t("messages")} WHERE company_id = $1${accountId ? " AND account_id = $2" : ""}
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${params.length}`,
      params,
    );
  }

  async listTemplates(companyId: string) {
    return this.db.query<Record<string, unknown>>(
      `SELECT id, name, subject, body FROM ${this.t("email_templates")} WHERE company_id = $1 ORDER BY name`,
      [companyId],
    );
  }

  async insertTemplate(row: { id: string; companyId: string; name: string; subject: string; body: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("email_templates")} (id, company_id, name, subject, body) VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.companyId, row.name, row.subject, row.body],
    );
  }

  async sendCounts(companyId: string) {
    return this.db.query<{ status: string; n: string | number }>(
      `SELECT status, count(*) AS n FROM ${this.t("send_requests")} WHERE company_id = $1 AND created_at >= now() - interval '30 days' GROUP BY status`,
      [companyId],
    );
  }

  async categoryCounts(companyId: string) {
    return this.db.query<{ category: string | null; n: string | number }>(
      `SELECT category, count(*) AS n FROM ${this.t("messages")}
        WHERE company_id = $1 AND direction = 'inbound' AND COALESCE(received_at, created_at) >= now() - interval '30 days'
        GROUP BY category`,
      [companyId],
    );
  }
}

export type { MailSendRequested };
