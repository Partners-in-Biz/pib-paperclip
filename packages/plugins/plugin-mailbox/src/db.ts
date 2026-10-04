/**
 * Data access. Every statement is one fully-qualified statement in the
 * plugin namespace (host SQL guard); lists travel as JSON and are expanded in
 * SQL. `GmailStore` is what the Gmail logic needs (tests use an in-memory
 * one); `SqlStore` also carries the older delegation/draft/template queries.
 */
import { randomUUID } from "node:crypto";
import type { MailAddress, MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import type { EspAuditRow, EspDayField, EspDayRow, EspDomainRow, EspEventInput, RecipientHealthRow, ReputationBaseline } from "./esp/types.js";
import { ESP_DAY_FIELDS } from "./esp/types.js";
import { erasureHash, markerEmail } from "./hash.js";
import { isPrivateMail, PRIVATE_MAIL_KIND, scrubbedRequest } from "./private-mail.js";
import type {
  AccountRow,
  ClientMapRow,
  ClientMapType,
  CrmClientRow,
  DelegationSource,
  DomainCheckRow,
  DraftExtras,
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
  SuppressionScope,
  TriageWrite,
} from "./gmail/types.js";

/** The context kind of private mail, as the SQL literal the statements below compare with (a constant, never caller text). */
const PRIVATE_KIND_SQL = PRIVATE_MAIL_KIND;

/** A row of `recentMessages`: drafts and other unsent mail. */
export interface RecentMessageRow {
  id: string;
  account_id: string;
  subject: string;
  body: string | null;
  status: string;
  direction: string;
  is_read: boolean;
  to_addrs: MailAddress[] | null;
  cc_addrs: MailAddress[] | null;
  bcc_addrs: MailAddress[] | null;
  draft: DraftExtras | null;
  send_error: string | null;
  created_at: unknown;
}

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

/** What can change on a provider domain after it exists. */
export type EspDomainPatch = Partial<{
  status: EspDomainRow["status"];
  records: EspDomainRow["records"];
  return_path_host: string | null;
  dkim_selector: string | null;
  spf_include: string | null;
  client_kind: string | null;
  client_ref: string | null;
  account_id: string | null;
  verified_at: string | null;
  checked_at: string | null;
  verify_asked_at: string | null;
  warmup_exempt: boolean;
  daily_cap_override: number | null;
  reputation: Record<string, unknown> | null;
  open_tracking: boolean | null;
  click_tracking: boolean | null;
  reputation_cleared_at: string | null;
  reputation_cleared_by: string | null;
  reputation_cleared_day: string | null;
  reputation_cleared_baseline: ReputationBaseline | null;
}>;

const ESP_DOMAIN_PATCH_CASTS: Record<keyof EspDomainPatch, string> = {
  status: "",
  records: "::jsonb",
  return_path_host: "",
  dkim_selector: "",
  spf_include: "",
  client_kind: "",
  client_ref: "",
  account_id: "",
  verified_at: "::timestamptz",
  checked_at: "::timestamptz",
  verify_asked_at: "::timestamptz",
  warmup_exempt: "::boolean",
  daily_cap_override: "::int",
  reputation: "::jsonb",
  open_tracking: "::boolean",
  click_tracking: "::boolean",
  reputation_cleared_at: "::timestamptz",
  reputation_cleared_by: "",
  reputation_cleared_day: "",
  reputation_cleared_baseline: "::jsonb",
};

const ESP_DOMAIN_COLUMNS =
  "company_id, domain, provider, provider_domain_id, region, status, records, return_path_host, dkim_selector, spf_include, client_kind, client_ref, account_id, created_by, verified_at, checked_at, verify_asked_at, first_sent_at, last_sent_at, warmup_exempt, daily_cap_override, reputation, open_tracking, click_tracking, reputation_cleared_at, reputation_cleared_by, reputation_cleared_day, reputation_cleared_baseline, created_at, updated_at";

const ESP_AUDIT_COLUMNS = "id, company_id, domain, action, actor, detail, created_at";

const ESP_DAY_COLUMNS = "company_id, domain, day, sent, delivered, hard_bounces, soft_bounces, complaints, opened, clicked, failed";

const HEALTH_COLUMNS = "company_id, email, soft_bounces, first_soft_at, last_soft_at, backoff_until";

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
  /** Binds a mailbox to a client (or back to the company's own with nulls). A client's mailbox is never the default sender. */
  setAccountClient(companyId: string, id: string, patch: { clientKind: string | null; clientRef: string | null; fromName?: string | null }): Promise<void>;
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
  /** By Gmail message id; `accountId` narrows it to one mailbox when several are connected. */
  getMessageByGmailId(companyId: string, gmailMessageId: string, accountId?: string | null): Promise<MessageRow | null>;
  getMessageByRfcId(companyId: string, rfcMessageId: string): Promise<MessageRow | null>;
  outboundByRfcIds(companyId: string, ids: string[]): Promise<MessageRow[]>;
  outboundInThread(companyId: string, threadId: string): Promise<MessageRow | null>;
  /** Newest message with a Message-ID in a Gmail thread (for follow-up headers). */
  latestInThread(companyId: string, threadId: string): Promise<MessageRow | null>;
  /** A Gmail thread's messages plus the drafts that answer it, newest first (the reply issue's done-check). */
  replyThread(companyId: string, threadId: string): Promise<MessageRow[]>;
  listInbox(companyId: string, filter: InboxFilter): Promise<MessageRow[]>;
  markDraftSent(companyId: string, id: string, fields: SentFields & { context: SendContext; sendKey: string }): Promise<void>;
  setDraftStatus(companyId: string, id: string, status: "draft" | "queued", error: string | null): Promise<void>;
  // send requests
  recentClaims(accountId: string): Promise<number>;
  claimSend(input: SendRecordInput, force: boolean): Promise<boolean>;
  recordSendFailure(input: SendRecordInput, error: string, permanent: boolean, skipped?: SkippedRecipient[]): Promise<void>;
  markRetrying(input: SendRecordInput, error: string): Promise<void>;
  markSendSent(key: string, fields: SentFields & { skipped?: SkippedRecipient[] }): Promise<void>;
  getSend(companyId: string, key: string): Promise<SendRow | null>;
  listSends(companyId: string, options: { status?: SendStatus | null; limit: number }): Promise<SendRow[]>;
  sendByThread(companyId: string, threadId: string): Promise<SendRow | null>;
  sendsByRfcIds(companyId: string, ids: string[]): Promise<SendRow[]>;
  /** Newest sent request to this address in the last 30 days (bounce matching). */
  sendToRecipient(companyId: string, email: string): Promise<SendRow | null>;
  setInboxResult(key: string, result: Record<string, unknown>): Promise<void>;
  // mail whose text must not be kept or shown (kind client_message, see private-mail.ts)
  /** True when this send, by its key, its Gmail id or its Message-ID, is private mail. */
  isPrivateSend(companyId: string, ids: { key?: string | null; gmailMessageId?: string | null; rfcMessageId?: string | null }): Promise<boolean>;
  /** Drops the text, html and attachment links of private sends that have settled (sent or failed for good), and of any asked for before `staleBeforeIso`. Returns how many. */
  scrubPrivateBodies(companyId: string, staleBeforeIso: string): Promise<number>;
  /** Empties the stored snippet of every sent copy of a private send (a copy the sync stored before the send was known). Returns how many. */
  scrubPrivateSnippets(companyId: string): Promise<number>;
  // what a person did to a provider domain
  insertEspAudit(row: { id: string; companyId: string; domain: string; action: EspAuditRow["action"]; actor: string; detail: Record<string, unknown> }): Promise<void>;
  listEspAudit(companyId: string, domain: string, limit: number): Promise<EspAuditRow[]>;
  // thread issues
  claimThreadIssue(companyId: string, accountId: string, threadId: string): Promise<boolean>;
  setThreadIssue(accountId: string, threadId: string, issueId: string): Promise<void>;
  // OAuth sessions
  insertOAuthSession(row: { state: string; companyId: string; createdByUserId: string | null; returnTo: string | null; ttlSeconds: number }): Promise<void>;
  getOAuthSession(state: string): Promise<OAuthSessionRow | null>;
  deleteOAuthSession(state: string): Promise<void>;
  // delegations
  delegationFor(accountId: string, agentId: string): Promise<{ can_read: boolean; can_draft: boolean; can_send: boolean } | null>;
  /** A person removed this agent's access: the defaults never give it back. */
  hasDelegationRemoval(accountId: string, agentId: string): Promise<boolean>;
  /** Creates a default delegation unless one exists or was removed. True when it created one. */
  insertDefaultDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; grantedBy: string }): Promise<boolean>;
  /** An explicit grant: adds rights, never lowers them, and clears an earlier removal. */
  grantDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; source: DelegationSource; grantedBy: string | null }): Promise<void>;
  /** A mailbox given to a client: the delegations the defaults made go (explicit grants by a person or an answered ask stay). Returns how many. */
  deleteDefaultDelegations(companyId: string, accountId: string): Promise<number>;
  /** Removes the delegation and remembers the removal. True when a delegation was deleted. */
  removeDelegation(companyId: string, accountId: string, agentId: string, removedBy: string | null): Promise<boolean>;
  // do-not-email list
  /** The rows for these addresses (lower case), every sender's; an erased person's marker comes back with the address that was asked for. */
  suppressionsFor(companyId: string, emails: string[]): Promise<SuppressionRow[]>;
  /** Adds the address once per sender; a later `all` widens a `marketing` row. Returns whether it is new and the scope now stored. */
  upsertSuppression(input: SuppressionInput): Promise<{ created: boolean; widened: boolean; scope: SuppressionScope }>;
  listSuppressions(companyId: string, limit: number): Promise<SuppressionRow[]>;
  /** Rows this plugin found since `sinceIso`, across companies (re-announced hourly). */
  ownSuppressionsSince(source: string, sinceIso: string, limit: number): Promise<SuppressionRow[]>;
  // CRM projection
  crmContactsByEmail(companyId: string, email: string): Promise<CrmClientRow[]>;
  crmCompaniesByDomain(companyId: string, domain: string): Promise<CrmClientRow[]>;
  crmCompany(companyId: string, id: string): Promise<CrmClientRow | null>;
  crmClients(companyId: string, limit: number): Promise<CrmClientRow[]>;
  crmContact(companyId: string, id: string): Promise<CrmClientRow | null>;
  // client mail mappings
  listClientMaps(companyId: string): Promise<ClientMapRow[]>;
  insertClientMap(row: { companyId: string; matchType: ClientMapType; pattern: string; clientKind: "company" | "contact"; clientRef: string; clientName: string | null; note: string | null; createdBy: string | null }): Promise<ClientMapRow>;
  deleteClientMap(companyId: string, id: string): Promise<boolean>;
  /** Mail flagged as looking like a client's with no mapping, by sender domain (newest first). */
  unmappedSummary(companyId: string, days: number): Promise<Array<{ domain: string; n: number | string; last_at: string | null; sample_id: string | null }>>;
  flaggedMessages(companyId: string, days: number, limit: number): Promise<MessageRow[]>;
  // sender domain checks
  getDomainCheck(companyId: string, domain: string): Promise<DomainCheckRow | null>;
  listDomainChecks(companyId: string): Promise<DomainCheckRow[]>;
  upsertDomainCheck(row: DomainCheckRow): Promise<void>;
  // email provider (send-only accounts, their domains, daily counts and webhook events)
  /** A send-only account for a provider domain: pending until the domain is verified. */
  insertEspAccount(row: { id: string; companyId: string; provider: string; address: string; status: "pending" | "connected"; fromName: string | null; replyTo: string | null; clientKind: string | null; clientRef: string | null; createdBy: string | null }): Promise<void>;
  setAccountStatus(companyId: string, id: string, status: AccountRow["status"]): Promise<void>;
  setAccountReplyTo(companyId: string, id: string, replyTo: string | null): Promise<void>;
  getEspDomain(companyId: string, domain: string): Promise<EspDomainRow | null>;
  listEspDomains(companyId: string): Promise<EspDomainRow[]>;
  /** Creates the row, or refreshes what the provider says about it; never touches the send history or a person's settings. */
  upsertEspDomain(row: EspDomainRow): Promise<void>;
  patchEspDomain(companyId: string, domain: string, patch: EspDomainPatch): Promise<void>;
  /** Takes `count` recipients of the day's cap in one step. `cap` null counts without limiting. False when the cap would be passed. */
  reserveEspSends(companyId: string, domain: string, day: string, count: number, cap: number | null): Promise<boolean>;
  releaseEspSends(companyId: string, domain: string, day: string, count: number): Promise<void>;
  /** A message went out: the domain's last send, and its first (day one of the warm-up) when it had none or went cold. */
  noteEspSend(companyId: string, domain: string, atIso: string, restartWarmup: boolean): Promise<void>;
  espDayRows(companyId: string, domain: string, sinceDay: string): Promise<EspDayRow[]>;
  bumpEspDay(companyId: string, domain: string, day: string, field: EspDayField, count: number): Promise<void>;
  /** Records a webhook delivery once. False when it (or the same message and kind) was seen before. */
  recordEspEvent(input: EspEventInput): Promise<boolean>;
  /** Takes a delivery back out when applying it failed, so the provider's retry applies it. */
  forgetEspEvent(companyId: string, eventId: string): Promise<void>;
  /** Retention: this company's delivery events received before `beforeIso` and daily counts before `beforeDay` (a UTC day). */
  purgeEspHistory(companyId: string, beforeIso: string, beforeDay: string): Promise<{ events: number; days: number }>;
  recipientHealth(companyId: string, emails: string[]): Promise<RecipientHealthRow[]>;
  /** Counts a soft bounce (soft bounces older than the window are forgotten) and returns the address's row. */
  recordSoftBounce(companyId: string, email: string, atIso: string, windowDays: number): Promise<RecipientHealthRow>;
  setBackoff(companyId: string, email: string, untilIso: string | null): Promise<void>;
  clearRecipientHealth(companyId: string, email: string): Promise<void>;
  sendByProviderMessage(companyId: string, provider: string, providerMessageId: string): Promise<SendRow | null>;
  markSendSentProvider(key: string, fields: { provider: string; providerMessageId: string; accountId: string; fromAddress: string; skipped?: SkippedRecipient[] }): Promise<void>;
  setSendDelivery(companyId: string, key: string, status: string, detail: Record<string, unknown>): Promise<void>;
  /** Merges notes into a send's `delivery` detail WITHOUT touching its `delivery_status` (which only the provider's events move). A key set to null is cleared. */
  patchSendDelivery(companyId: string, key: string, detail: Record<string, unknown>): Promise<void>;
  /** A draft the email provider took: sent, with no Gmail ids. */
  markDraftSentProvider(companyId: string, id: string, fields: { context: SendContext; sendKey: string; fromAddress: string }): Promise<void>;
  /** The provider events and soft-bounce rows about these addresses (erasure). */
  eraseEspRecipients(companyId: string, emails: string[]): Promise<number>;
  // erasure
  crmContactEmails(companyId: string, contactId: string): Promise<string[]>;
  messagesInvolving(companyId: string, emails: string[]): Promise<Array<{ id: string; account_id: string; gmail_thread_id: string | null; status: string; direction: string }>>;
  threadIssueIds(companyId: string, threadIds: string[]): Promise<string[]>;
  deleteDecisionsFor(companyId: string, messageIds: string[]): Promise<number>;
  deleteMessages(companyId: string, ids: string[]): Promise<number>;
  /** Keys of send requests to, cc'd or bcc'd to these addresses. */
  sendKeysTo(companyId: string, emails: string[]): Promise<string[]>;
  /** Keeps the record (key, status, context) so a repeated request is still refused; removes recipients, subject, body and error text. */
  redactSends(companyId: string, keys: string[]): Promise<number>;
  scrubInboxResults(companyId: string, keys: string[]): Promise<number>;
  deleteLeadOutbox(companyId: string, emails: string[]): Promise<number>;
  blankCrmProjection(companyId: string, contactId: string | null, emails: string[]): Promise<number>;
  /** Replaces the address's do-not-email rows (every sender) with one marker that holds only its hash. */
  eraseSuppression(input: { companyId: string; email: string; hash: string; scope: SuppressionScope }): Promise<{ replaced: number }>;
  /** Erased people by hash, with when: mail received before that is never imported again. */
  erasedMarkers(companyId: string): Promise<Map<string, string>>;
}

const ACCOUNT_COLUMNS =
  "id, company_id, provider, address, status, token_sealed, token_expires_at, scopes, history_id, last_sync_at, last_error, sync_stats, connected_by_user_id, connected_at, alert_issue_id, is_default, label_ids, owner_user_id, client_kind, client_ref, from_name, reply_to, created_at";

const MESSAGE_COLUMNS =
  "id, company_id, account_id, subject, body, direction, status, created_at, read_at, gmail_message_id, gmail_thread_id, rfc_message_id, in_reply_to, refs, from_addr, to_addrs, cc_addrs, bcc_addrs, snippet, labels, attachments, bulk, received_at, triage, triaged_at, category, urgency, needs_reply, phishing, client_kind, client_ref, reply_to, sent_context, send_key, draft, send_error, bounce, reply_to_addr, map_state, map_id";

const SEND_COLUMNS =
  "key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, permanent, attempts, gmail_message_id, gmail_thread_id, rfc_message_id, error, context, request, claimed_at, sent_at, created_at, updated_at, skipped, provider, provider_message_id, delivery_status, delivery";

const SUPPRESSION_COLUMNS = "company_id, email, scope, reason, source, detail, sender_key, email_hash, erased_at, created_at, updated_at";

const DOMAIN_COLUMNS = "company_id, domain, status, result, source, client_kind, client_ref, checked_at, first_checked_at, status_since, dmarc_none_since";

const MAP_COLUMNS = "id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by, created_at";

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
    client_kind: row.client_kind ?? null,
    client_ref: row.client_ref ?? null,
    from_name: row.from_name ?? null,
    reply_to: row.reply_to ?? null,
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
    reply_to_addr: row.reply_to_addr ?? null,
    map_state: row.map_state ?? null,
    map_id: row.map_id ?? null,
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
    skipped: row.skipped ?? [],
    provider: row.provider ?? null,
    provider_message_id: row.provider_message_id ?? null,
    delivery_status: row.delivery_status ?? null,
    delivery: row.delivery ?? {},
  };
}

function normaliseSuppression(row: SuppressionRow): SuppressionRow {
  return { ...row, sender_key: row.sender_key ?? "", email_hash: row.email_hash ?? null, erased_at: iso(row.erased_at), created_at: iso(row.created_at) ?? "", updated_at: iso(row.updated_at) ?? "" };
}

function normaliseDomainCheck(row: DomainCheckRow): DomainCheckRow {
  return {
    ...row,
    result: row.result ?? {},
    checked_at: iso(row.checked_at) ?? "",
    first_checked_at: iso(row.first_checked_at) ?? "",
    status_since: iso(row.status_since) ?? "",
    dmarc_none_since: iso(row.dmarc_none_since),
  };
}

function normaliseEspDomain(row: EspDomainRow): EspDomainRow {
  return {
    ...row,
    records: Array.isArray(row.records) ? row.records : [],
    verified_at: iso(row.verified_at),
    checked_at: iso(row.checked_at),
    verify_asked_at: iso(row.verify_asked_at),
    first_sent_at: iso(row.first_sent_at),
    last_sent_at: iso(row.last_sent_at),
    warmup_exempt: Boolean(row.warmup_exempt),
    daily_cap_override: row.daily_cap_override == null ? null : Number(row.daily_cap_override),
    reputation: row.reputation ?? null,
    open_tracking: row.open_tracking ?? null,
    click_tracking: row.click_tracking ?? null,
    reputation_cleared_at: iso(row.reputation_cleared_at),
    reputation_cleared_by: row.reputation_cleared_by ?? null,
    reputation_cleared_day: row.reputation_cleared_day ?? null,
    reputation_cleared_baseline: row.reputation_cleared_baseline ?? null,
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at) ?? "",
  };
}

function normaliseAudit(row: EspAuditRow): EspAuditRow {
  return { ...row, detail: row.detail ?? {}, created_at: iso(row.created_at) ?? "" };
}

function normaliseHealth(row: RecipientHealthRow): RecipientHealthRow {
  return { ...row, soft_bounces: Number(row.soft_bounces), first_soft_at: iso(row.first_soft_at) ?? "", last_soft_at: iso(row.last_soft_at) ?? "", backoff_until: iso(row.backoff_until) };
}

function normaliseMap(row: ClientMapRow): ClientMapRow {
  return { ...row, created_at: iso(row.created_at) ?? "" };
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
        WHERE company_id = $1 AND status IN ('connected', 'needs_reconnect') AND token_sealed IS NOT NULL AND client_ref IS NULL
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

  async setAccountClient(companyId: string, id: string, patch: { clientKind: string | null; clientRef: string | null; fromName?: string | null }): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("accounts")} SET client_kind = $3, client_ref = $4, from_name = $5, is_default = CASE WHEN $4::text IS NULL THEN is_default ELSE false END, updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [id, companyId, patch.clientRef ? patch.clientKind : null, patch.clientRef, patch.fromName ?? null],
    );
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
         from_addr, to_addrs, cc_addrs, bcc_addrs, snippet, labels, attachments, bulk, received_at, read_at, sent_context, send_key, triaged_at, bounce, reply_to_addr)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17::jsonb, $18::jsonb, $19,
         $20::timestamptz, CASE WHEN $21::boolean THEN now() ELSE NULL END, $22::jsonb, $23, CASE WHEN $24::boolean THEN now() ELSE NULL END, $25::jsonb, $26::jsonb)
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
        json(row.replyToAddr ?? null),
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
         client_kind = $8, client_ref = $9, reply_to = $10::jsonb, map_state = COALESCE($11::text, map_state), map_id = COALESCE($12::text, map_id),
         triaged_at = now(), updated_at = now()
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
        write.mapState ?? null,
        write.mapId ?? null,
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

  async getMessageByGmailId(companyId: string, gmailMessageId: string, accountId: string | null = null): Promise<MessageRow | null> {
    const rows = accountId
      ? await this.db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")} WHERE company_id = $1 AND gmail_message_id = $2 AND account_id = $3 LIMIT 1`,
        [companyId, gmailMessageId, accountId],
      )
      : await this.db.query<MessageRow>(
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

  async replyThread(companyId: string, threadId: string): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE company_id = $1 AND (gmail_thread_id = $2 OR draft ->> 'threadId' = $2)
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT 200`,
      [companyId, threadId],
    );
    return rows.map(normaliseMessage);
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

  async recordSendFailure(input: SendRecordInput, error: string, permanent: boolean, skipped: SkippedRecipient[] = []): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("send_requests")} AS sr
        (key, company_id, source_plugin, account_id, from_address, to_addrs, subject, status, permanent, attempts, error, context, request, skipped)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'failed', $8, 1, $9, $10::jsonb, $11::jsonb, $12::jsonb)
       ON CONFLICT (key) DO UPDATE SET status = 'failed', permanent = EXCLUDED.permanent, error = EXCLUDED.error, skipped = EXCLUDED.skipped, updated_at = now(),
         request = CASE WHEN EXCLUDED.permanent AND sr.context ->> 'kind' = '${PRIVATE_KIND_SQL}' THEN sr.request - 'text' - 'html' - 'attachments' ELSE sr.request END
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
        // Failed for good: the text of a client message is not kept (a failure that will go away keeps it for the retry).
        json(permanent && isPrivateMail(input.context) ? scrubbedRequest(input.request) : input.request),
        json(skipped),
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

  async markSendSent(key: string, fields: SentFields & { skipped?: SkippedRecipient[] }): Promise<void> {
    await this.db.execute(
      // A client message's text is not kept once it has gone: the link in it is a credential (private-mail.ts).
      `UPDATE ${this.t("send_requests")} SET status = 'sent', permanent = false, error = NULL, gmail_message_id = $2, gmail_thread_id = $3,
         rfc_message_id = $4, account_id = $5, from_address = $6, skipped = $7::jsonb, sent_at = now(), updated_at = now(),
         request = CASE WHEN context ->> 'kind' = '${PRIVATE_KIND_SQL}' THEN request - 'text' - 'html' - 'attachments' ELSE request END
        WHERE key = $1`,
      [key, fields.gmailMessageId, fields.gmailThreadId, fields.rfcMessageId, fields.accountId, fields.fromAddress, json(fields.skipped ?? [])],
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

  async isPrivateSend(companyId: string, ids: { key?: string | null; gmailMessageId?: string | null; rfcMessageId?: string | null }): Promise<boolean> {
    if (!ids.key && !ids.gmailMessageId && !ids.rfcMessageId) return false;
    const rows = await this.db.query<{ n: number }>(
      `SELECT 1 AS n FROM ${this.t("send_requests")}
        WHERE company_id = $1 AND context ->> 'kind' = '${PRIVATE_KIND_SQL}' AND (key = $2 OR gmail_message_id = $3 OR rfc_message_id = $4) LIMIT 1`,
      [companyId, ids.key ?? null, ids.gmailMessageId ?? null, ids.rfcMessageId ?? null],
    );
    return rows.length > 0;
  }

  async scrubPrivateBodies(companyId: string, staleBeforeIso: string): Promise<number> {
    const res = await this.db.execute(
      `UPDATE ${this.t("send_requests")} SET request = request - 'text' - 'html' - 'attachments'
        WHERE company_id = $1 AND context ->> 'kind' = '${PRIVATE_KIND_SQL}'
          AND (request ->> 'text' IS NOT NULL OR request ->> 'html' IS NOT NULL OR request -> 'attachments' IS NOT NULL)
          AND (status = 'sent' OR (status = 'failed' AND permanent) OR created_at < $2::timestamptz)`,
      [companyId, staleBeforeIso],
    );
    return res.rowCount ?? 0;
  }

  async scrubPrivateSnippets(companyId: string): Promise<number> {
    const res = await this.db.execute(
      `UPDATE ${this.t("messages")} m SET snippet = ''
        WHERE m.company_id = $1 AND m.direction = 'outbound' AND m.snippet <> ''
          AND (m.sent_context ->> 'kind' = '${PRIVATE_KIND_SQL}'
            OR EXISTS (SELECT 1 FROM ${this.t("send_requests")} s
                        WHERE s.company_id = m.company_id AND s.context ->> 'kind' = '${PRIVATE_KIND_SQL}'
                          AND (s.key = m.send_key OR s.gmail_message_id = m.gmail_message_id OR s.rfc_message_id = m.rfc_message_id)))`,
      [companyId],
    );
    return res.rowCount ?? 0;
  }

  async insertEspAudit(row: { id: string; companyId: string; domain: string; action: EspAuditRow["action"]; actor: string; detail: Record<string, unknown> }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("esp_domain_audit")} (id, company_id, domain, action, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [row.id, row.companyId, row.domain.toLowerCase(), row.action, row.actor, json(row.detail)],
    );
  }

  async listEspAudit(companyId: string, domain: string, limit: number): Promise<EspAuditRow[]> {
    const rows = await this.db.query<EspAuditRow>(
      `SELECT ${ESP_AUDIT_COLUMNS} FROM ${this.t("esp_domain_audit")} WHERE company_id = $1 AND domain = $2 ORDER BY created_at DESC, id LIMIT $3`,
      [companyId, domain.toLowerCase(), Math.max(1, Math.min(limit, 200))],
    );
    return rows.map(normaliseAudit);
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

  // ── do-not-email list ───────────────────────────────────────────────────

  async suppressionsFor(companyId: string, emails: string[]): Promise<SuppressionRow[]> {
    const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return [];
    // An erased person's marker has a hash, not an address: look for both, and hand the marker back under the address asked for.
    const byHash = new Map(wanted.map((email) => [erasureHash(email), email]));
    const rows = await this.db.query<SuppressionRow>(
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.t("suppressions")}
        WHERE company_id = $1 AND (email = ANY(${textArray(2)}) OR email_hash = ANY(${textArray(3)}))`,
      [companyId, json(wanted), json([...byHash.keys()])],
    );
    return rows.map(normaliseSuppression).map((row) => (row.email_hash && byHash.has(row.email_hash) ? { ...row, email: byHash.get(row.email_hash)! } : row));
  }

  async upsertSuppression(input: SuppressionInput): Promise<{ created: boolean; widened: boolean; scope: SuppressionScope }> {
    const email = input.email.trim().toLowerCase();
    const senderKey = input.senderKey ?? "";
    const res = await this.db.execute(
      `INSERT INTO ${this.t("suppressions")} (company_id, email, scope, reason, source, detail, sender_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, email, sender_key) DO NOTHING`,
      [input.companyId, email, input.scope, input.reason, input.source, input.detail?.slice(0, 500) ?? null, senderKey],
    );
    if ((res.rowCount ?? 0) > 0) return { created: true, widened: false, scope: input.scope };
    if (input.scope !== "all") return { created: false, widened: false, scope: "marketing" };
    const widened = await this.db.execute(
      `UPDATE ${this.t("suppressions")} SET scope = 'all', reason = $4, source = $5, detail = $6, updated_at = now()
        WHERE company_id = $1 AND email = $2 AND sender_key = $3 AND scope = 'marketing'`,
      [input.companyId, email, senderKey, input.reason, input.source, input.detail?.slice(0, 500) ?? null],
    );
    return { created: false, widened: (widened.rowCount ?? 0) > 0, scope: "all" };
  }

  async listSuppressions(companyId: string, limit: number): Promise<SuppressionRow[]> {
    const rows = await this.db.query<SuppressionRow>(
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.t("suppressions")} WHERE company_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [companyId, Math.max(1, Math.min(limit, 1000))],
    );
    return rows.map(normaliseSuppression);
  }

  async ownSuppressionsSince(source: string, sinceIso: string, limit: number): Promise<SuppressionRow[]> {
    const rows = await this.db.query<SuppressionRow>(
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.t("suppressions")} WHERE source = $1 AND email_hash IS NULL AND updated_at >= $2::timestamptz ORDER BY updated_at LIMIT $3`,
      [source, sinceIso, Math.max(1, Math.min(limit, 1000))],
    );
    return rows.map(normaliseSuppression);
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

  async crmContact(companyId: string, id: string): Promise<CrmClientRow | null> {
    const rows = await this.db.query<CrmContactDb>(
      `SELECT id, name, emails, account_ids FROM ${this.t("crm_contacts")} WHERE company_id = $1 AND id = $2 AND deleted = false`,
      [companyId, id],
    );
    return rows[0] ? contactRow(rows[0]) : null;
  }

  // ── client mail mappings ────────────────────────────────────────────────

  async listClientMaps(companyId: string): Promise<ClientMapRow[]> {
    const rows = await this.db.query<ClientMapRow>(`SELECT ${MAP_COLUMNS} FROM ${this.t("client_mail_maps")} WHERE company_id = $1 ORDER BY created_at`, [companyId]);
    return rows.map(normaliseMap);
  }

  async insertClientMap(row: { companyId: string; matchType: ClientMapType; pattern: string; clientKind: "company" | "contact"; clientRef: string; clientName: string | null; note: string | null; createdBy: string | null }): Promise<ClientMapRow> {
    const id = `map_${randomUUID()}`;
    await this.db.execute(
      `INSERT INTO ${this.t("client_mail_maps")} (id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, row.companyId, row.matchType, row.pattern, row.clientKind, row.clientRef, row.clientName, row.note, row.createdBy],
    );
    const rows = await this.db.query<ClientMapRow>(`SELECT ${MAP_COLUMNS} FROM ${this.t("client_mail_maps")} WHERE company_id = $1 AND id = $2`, [row.companyId, id]);
    return normaliseMap(rows[0] ?? { id, company_id: row.companyId, match_type: row.matchType, pattern: row.pattern, client_kind: row.clientKind, client_ref: row.clientRef, client_name: row.clientName, note: row.note, created_by: row.createdBy, created_at: "" });
  }

  async deleteClientMap(companyId: string, id: string): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t("client_mail_maps")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async unmappedSummary(companyId: string, days: number) {
    return this.db.query<{ domain: string; n: number | string; last_at: string | null; sample_id: string | null }>(
      `SELECT lower(split_part(from_addr ->> 'email', '@', 2)) AS domain, count(*)::int AS n, max(COALESCE(received_at, created_at))::text AS last_at,
              (array_agg(id ORDER BY COALESCE(received_at, created_at) DESC))[1] AS sample_id
         FROM ${this.t("messages")}
        WHERE company_id = $1 AND map_state = 'needs_mapping' AND COALESCE(received_at, created_at) >= now() - make_interval(days => $2::int)
        GROUP BY 1 ORDER BY n DESC, last_at DESC LIMIT 25`,
      [companyId, days],
    );
  }

  async flaggedMessages(companyId: string, days: number, limit: number): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${this.t("messages")}
        WHERE company_id = $1 AND direction = 'inbound' AND map_state = 'needs_mapping' AND COALESCE(received_at, created_at) >= now() - make_interval(days => $2::int)
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT $3`,
      [companyId, days, Math.max(1, Math.min(limit, 500))],
    );
    return rows.map(normaliseMessage);
  }

  // ── sender domain checks ────────────────────────────────────────────────

  async getDomainCheck(companyId: string, domain: string): Promise<DomainCheckRow | null> {
    const rows = await this.db.query<DomainCheckRow>(`SELECT ${DOMAIN_COLUMNS} FROM ${this.t("domain_checks")} WHERE company_id = $1 AND domain = $2`, [companyId, domain.toLowerCase()]);
    return rows[0] ? normaliseDomainCheck(rows[0]) : null;
  }

  async listDomainChecks(companyId: string): Promise<DomainCheckRow[]> {
    const rows = await this.db.query<DomainCheckRow>(`SELECT ${DOMAIN_COLUMNS} FROM ${this.t("domain_checks")} WHERE company_id = $1 ORDER BY domain`, [companyId]);
    return rows.map(normaliseDomainCheck);
  }

  async upsertDomainCheck(row: DomainCheckRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("domain_checks")} (company_id, domain, status, result, source, client_kind, client_ref, checked_at, first_checked_at, status_since, dmarc_none_since)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz)
       ON CONFLICT (company_id, domain) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, source = EXCLUDED.source, client_kind = EXCLUDED.client_kind,
         client_ref = EXCLUDED.client_ref, checked_at = EXCLUDED.checked_at, status_since = EXCLUDED.status_since, dmarc_none_since = EXCLUDED.dmarc_none_since`,
      [row.company_id, row.domain.toLowerCase(), row.status, json(row.result), row.source, row.client_kind, row.client_ref, row.checked_at, row.first_checked_at, row.status_since, row.dmarc_none_since],
    );
  }

  // ── erasure ─────────────────────────────────────────────────────────────

  async crmContactEmails(companyId: string, contactId: string): Promise<string[]> {
    const rows = await this.db.query<{ emails: string[] | null }>(`SELECT emails FROM ${this.t("crm_contacts")} WHERE company_id = $1 AND id = $2`, [companyId, contactId]);
    return (rows[0]?.emails ?? []).map((email) => email.toLowerCase());
  }

  async messagesInvolving(companyId: string, emails: string[]) {
    if (emails.length === 0) return [];
    return this.db.query<{ id: string; account_id: string; gmail_thread_id: string | null; status: string; direction: string }>(
      `SELECT id, account_id, gmail_thread_id, status, direction FROM ${this.t("messages")}
        WHERE company_id = $1 AND (
          lower(from_addr ->> 'email') = ANY(${textArray(2)})
          OR lower(reply_to_addr ->> 'email') = ANY(${textArray(2)})
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(to_addrs || cc_addrs || bcc_addrs) AS a WHERE lower(a ->> 'email') = ANY(${textArray(2)})))
        LIMIT 5000`,
      [companyId, json(emails.map((email) => email.toLowerCase()))],
    );
  }

  async threadIssueIds(companyId: string, threadIds: string[]): Promise<string[]> {
    if (threadIds.length === 0) return [];
    const rows = await this.db.query<{ issue_id: string }>(
      `SELECT DISTINCT issue_id FROM ${this.t("thread_issues")} WHERE company_id = $1 AND issue_id IS NOT NULL AND gmail_thread_id = ANY(${textArray(2)})`,
      [companyId, json(threadIds)],
    );
    return rows.map((row) => row.issue_id);
  }

  async deleteDecisionsFor(companyId: string, messageIds: string[]): Promise<number> {
    let removed = 0;
    for (let at = 0; at < messageIds.length; at += 500) {
      const res = await this.db.execute(
        `DELETE FROM ${this.t("decisions")} WHERE company_id = $1 AND subject_kind = 'message' AND subject_id = ANY(${textArray(2)})`,
        [companyId, json(messageIds.slice(at, at + 500))],
      );
      removed += res.rowCount ?? 0;
    }
    return removed;
  }

  async deleteMessages(companyId: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (let at = 0; at < ids.length; at += 500) {
      const res = await this.db.execute(`DELETE FROM ${this.t("messages")} WHERE company_id = $1 AND id = ANY(${textArray(2)})`, [companyId, json(ids.slice(at, at + 500))]);
      removed += res.rowCount ?? 0;
    }
    return removed;
  }

  async sendKeysTo(companyId: string, emails: string[]): Promise<string[]> {
    if (emails.length === 0) return [];
    const rows = await this.db.query<{ key: string }>(
      `SELECT key FROM ${this.t("send_requests")}
        WHERE company_id = $1 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(to_addrs || COALESCE(request -> 'cc', '[]'::jsonb) || COALESCE(request -> 'bcc', '[]'::jsonb)) AS a
           WHERE lower(a ->> 'email') = ANY(${textArray(2)}))
        LIMIT 5000`,
      [companyId, json(emails.map((email) => email.toLowerCase()))],
    );
    return rows.map((row) => row.key);
  }

  async redactSends(companyId: string, keys: string[]): Promise<number> {
    let changed = 0;
    for (let at = 0; at < keys.length; at += 500) {
      const res = await this.db.execute(
        `UPDATE ${this.t("send_requests")} SET to_addrs = '[]'::jsonb, subject = '[erased on request]', skipped = '[]'::jsonb, delivery = '{}'::jsonb,
           error = CASE WHEN error IS NULL THEN NULL ELSE '[erased on request]' END, request = jsonb_build_object('key', key, 'erased', true), updated_at = now()
          WHERE company_id = $1 AND key = ANY(${textArray(2)})`,
        [companyId, json(keys.slice(at, at + 500))],
      );
      changed += res.rowCount ?? 0;
    }
    return changed;
  }

  async scrubInboxResults(companyId: string, keys: string[]): Promise<number> {
    let changed = 0;
    for (let at = 0; at < keys.length; at += 500) {
      const res = await this.db.execute(
        `UPDATE ${this.t("inbox")} SET result = (result - 'error') - 'suppressed' WHERE company_id = $1 AND result IS NOT NULL AND key = ANY(${textArray(2)})`,
        [companyId, json(keys.slice(at, at + 500))],
      );
      changed += res.rowCount ?? 0;
    }
    return changed;
  }

  async deleteLeadOutbox(companyId: string, emails: string[]): Promise<number> {
    if (emails.length === 0) return 0;
    const res = await this.db.execute(
      `DELETE FROM ${this.t("outbox")} WHERE company_id = $1 AND event = 'lead.captured' AND lower(payload ->> 'email') = ANY(${textArray(2)})`,
      [companyId, json(emails.map((email) => email.toLowerCase()))],
    );
    return res.rowCount ?? 0;
  }

  async blankCrmProjection(companyId: string, contactId: string | null, emails: string[]): Promise<number> {
    const res = await this.db.execute(
      `UPDATE ${this.t("crm_contacts")} SET name = '', emails = '{}', phones = '{}', tags = '{}', account_ids = '{}', deleted = true
        WHERE company_id = $1 AND (id = $2::text OR EXISTS (SELECT 1 FROM unnest(emails) AS e WHERE lower(e) = ANY(${textArray(3)})))`,
      [companyId, contactId, json(emails.map((email) => email.toLowerCase()))],
    );
    return res.rowCount ?? 0;
  }

  async eraseSuppression(input: { companyId: string; email: string; hash: string; scope: SuppressionScope }): Promise<{ replaced: number }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.db.query<{ scope: SuppressionScope }>(`SELECT scope FROM ${this.t("suppressions")} WHERE company_id = $1 AND email = $2`, [input.companyId, email]);
    const scope: SuppressionScope = input.scope === "all" || existing.some((row) => row.scope === "all") ? "all" : "marketing";
    const removed = await this.db.execute(`DELETE FROM ${this.t("suppressions")} WHERE company_id = $1 AND email = $2`, [input.companyId, email]);
    await this.db.execute(
      `INSERT INTO ${this.t("suppressions")} AS s (company_id, email, scope, reason, source, detail, sender_key, email_hash, erased_at)
       VALUES ($1, $2, $3, 'manual', $4, 'Erased on request: only a hash of the address is kept', '', $5, now())
       ON CONFLICT (company_id, email, sender_key) DO UPDATE SET scope = CASE WHEN s.scope = 'all' OR EXCLUDED.scope = 'all' THEN 'all' ELSE 'marketing' END, erased_at = now(), updated_at = now()`,
      [input.companyId, markerEmail(input.hash), scope, "partnersinbiz.mailbox", input.hash],
    );
    return { replaced: removed.rowCount ?? 0 };
  }

  async erasedMarkers(companyId: string): Promise<Map<string, string>> {
    const rows = await this.db.query<{ email_hash: string; erased_at: unknown }>(
      `SELECT email_hash, erased_at FROM ${this.t("suppressions")} WHERE company_id = $1 AND email_hash IS NOT NULL AND erased_at IS NOT NULL`,
      [companyId],
    );
    return new Map(rows.map((row) => [row.email_hash, iso(row.erased_at) ?? ""]));
  }

  // ── email provider ──────────────────────────────────────────────────────

  async insertEspAccount(row: { id: string; companyId: string; provider: string; address: string; status: "pending" | "connected"; fromName: string | null; replyTo: string | null; clientKind: string | null; clientRef: string | null; createdBy: string | null }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("accounts")} (id, company_id, provider, address, status, owner_user_id, client_kind, client_ref, from_name, reply_to, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $5::text = 'connected' THEN now() ELSE NULL END)`,
      [row.id, row.companyId, row.provider, row.address, row.status, row.createdBy, row.clientRef ? row.clientKind : null, row.clientRef, row.fromName, row.replyTo],
    );
  }

  async setAccountStatus(companyId: string, id: string, status: AccountRow["status"]): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("accounts")} SET status = $3, connected_at = CASE WHEN $3::text = 'connected' AND connected_at IS NULL THEN now() ELSE connected_at END, updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [id, companyId, status],
    );
  }

  async setAccountReplyTo(companyId: string, id: string, replyTo: string | null): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("accounts")} SET reply_to = $3, updated_at = now() WHERE id = $1 AND company_id = $2`, [id, companyId, replyTo]);
  }

  async getEspDomain(companyId: string, domain: string): Promise<EspDomainRow | null> {
    const rows = await this.db.query<EspDomainRow>(`SELECT ${ESP_DOMAIN_COLUMNS} FROM ${this.t("esp_domains")} WHERE company_id = $1 AND domain = $2`, [companyId, domain.toLowerCase()]);
    return rows[0] ? normaliseEspDomain(rows[0]) : null;
  }

  async listEspDomains(companyId: string): Promise<EspDomainRow[]> {
    const rows = await this.db.query<EspDomainRow>(`SELECT ${ESP_DOMAIN_COLUMNS} FROM ${this.t("esp_domains")} WHERE company_id = $1 ORDER BY domain`, [companyId]);
    return rows.map(normaliseEspDomain);
  }

  async upsertEspDomain(row: EspDomainRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("esp_domains")} (company_id, domain, provider, provider_domain_id, region, status, records, return_path_host, dkim_selector, spf_include, client_kind, client_ref, account_id, created_by, verified_at, checked_at, open_tracking, click_tracking)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16::timestamptz, $17::boolean, $18::boolean)
       ON CONFLICT (company_id, domain) DO UPDATE SET provider_domain_id = EXCLUDED.provider_domain_id, region = EXCLUDED.region, status = EXCLUDED.status, records = EXCLUDED.records,
         return_path_host = EXCLUDED.return_path_host, dkim_selector = EXCLUDED.dkim_selector, spf_include = EXCLUDED.spf_include,
         open_tracking = EXCLUDED.open_tracking, click_tracking = EXCLUDED.click_tracking,
         verified_at = COALESCE(EXCLUDED.verified_at, ${this.t("esp_domains")}.verified_at), checked_at = EXCLUDED.checked_at, updated_at = now()`,
      [
        row.company_id,
        row.domain.toLowerCase(),
        row.provider,
        row.provider_domain_id,
        row.region,
        row.status,
        json(row.records),
        row.return_path_host,
        row.dkim_selector,
        row.spf_include,
        row.client_ref ? row.client_kind : null,
        row.client_ref,
        row.account_id,
        row.created_by,
        row.verified_at,
        row.checked_at,
        row.open_tracking ?? null,
        row.click_tracking ?? null,
      ],
    );
  }

  async patchEspDomain(companyId: string, domain: string, patch: EspDomainPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [companyId, domain.toLowerCase()];
    for (const [key, value] of Object.entries(patch) as Array<[keyof EspDomainPatch, unknown]>) {
      if (!(key in ESP_DOMAIN_PATCH_CASTS) || value === undefined) continue;
      const cast = ESP_DOMAIN_PATCH_CASTS[key];
      params.push(cast === "::jsonb" ? json(value) : value);
      sets.push(`${key} = $${params.length}${cast}`);
    }
    if (sets.length === 0) return;
    await this.db.execute(`UPDATE ${this.t("esp_domains")} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND domain = $2`, params);
  }

  async reserveEspSends(companyId: string, domain: string, day: string, count: number, cap: number | null): Promise<boolean> {
    // One statement, so two sends at once cannot both pass the cap: the first insert, or the update, only happens while the day stays within it.
    const res = await this.db.execute(
      `INSERT INTO ${this.t("esp_domain_days")} AS d (company_id, domain, day, sent)
       SELECT $1::text, $2::text, $3::text, $4::int WHERE $5::int IS NULL OR $4::int <= $5::int
       ON CONFLICT (company_id, domain, day) DO UPDATE SET sent = d.sent + $4::int WHERE $5::int IS NULL OR d.sent + $4::int <= $5::int`,
      [companyId, domain.toLowerCase(), day, count, cap],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseEspSends(companyId: string, domain: string, day: string, count: number): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("esp_domain_days")} SET sent = GREATEST(sent - $4::int, 0) WHERE company_id = $1 AND domain = $2 AND day = $3`, [companyId, domain.toLowerCase(), day, count]);
  }

  async noteEspSend(companyId: string, domain: string, atIso: string, restartWarmup: boolean): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("esp_domains")} SET first_sent_at = CASE WHEN first_sent_at IS NULL OR $3::boolean THEN $4::timestamptz ELSE first_sent_at END, last_sent_at = $4::timestamptz, updated_at = now()
        WHERE company_id = $1 AND domain = $2`,
      [companyId, domain.toLowerCase(), restartWarmup, atIso],
    );
  }

  async espDayRows(companyId: string, domain: string, sinceDay: string): Promise<EspDayRow[]> {
    const rows = await this.db.query<EspDayRow>(
      `SELECT ${ESP_DAY_COLUMNS} FROM ${this.t("esp_domain_days")} WHERE company_id = $1 AND domain = $2 AND day >= $3 ORDER BY day`,
      [companyId, domain.toLowerCase(), sinceDay],
    );
    return rows.map((row) => ({ ...row, sent: Number(row.sent), delivered: Number(row.delivered), hard_bounces: Number(row.hard_bounces), soft_bounces: Number(row.soft_bounces), complaints: Number(row.complaints), opened: Number(row.opened), clicked: Number(row.clicked), failed: Number(row.failed) }));
  }

  async bumpEspDay(companyId: string, domain: string, day: string, field: EspDayField, count: number): Promise<void> {
    // The column comes from a fixed list, never from the caller's text.
    if (!ESP_DAY_FIELDS.includes(field)) throw new Error("Unknown day counter");
    await this.db.execute(
      `INSERT INTO ${this.t("esp_domain_days")} AS d (company_id, domain, day, ${field}) VALUES ($1, $2, $3, $4::int)
       ON CONFLICT (company_id, domain, day) DO UPDATE SET ${field} = d.${field} + $4::int`,
      [companyId, domain.toLowerCase(), day, count],
    );
  }

  async recordEspEvent(input: EspEventInput): Promise<boolean> {
    const res = await this.db.execute(
      `INSERT INTO ${this.t("esp_events")} (company_id, event_id, dedupe_key, provider, event_type, email_id, recipient, domain, send_key, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT DO NOTHING`,
      [input.companyId, input.eventId.slice(0, 200), input.dedupeKey.slice(0, 400), input.provider, input.type.slice(0, 80), input.emailId, input.recipient.toLowerCase(), input.domain, input.sendKey, json(input.detail)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async forgetEspEvent(companyId: string, eventId: string): Promise<void> {
    await this.db.execute(`DELETE FROM ${this.t("esp_events")} WHERE company_id = $1 AND event_id = $2`, [companyId, eventId.slice(0, 200)]);
  }

  async purgeEspHistory(companyId: string, beforeIso: string, beforeDay: string): Promise<{ events: number; days: number }> {
    const events = await this.db.execute(`DELETE FROM ${this.t("esp_events")} WHERE company_id = $1 AND received_at < $2::timestamptz`, [companyId, beforeIso]);
    const days = await this.db.execute(`DELETE FROM ${this.t("esp_domain_days")} WHERE company_id = $1 AND day < $2`, [companyId, beforeDay]);
    return { events: events.rowCount ?? 0, days: days.rowCount ?? 0 };
  }

  async recipientHealth(companyId: string, emails: string[]): Promise<RecipientHealthRow[]> {
    const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return [];
    const rows = await this.db.query<RecipientHealthRow>(
      `SELECT ${HEALTH_COLUMNS} FROM ${this.t("esp_recipient_health")} WHERE company_id = $1 AND email = ANY(${textArray(2)})`,
      [companyId, json(wanted)],
    );
    return rows.map(normaliseHealth);
  }

  async recordSoftBounce(companyId: string, email: string, atIso: string, windowDays: number): Promise<RecipientHealthRow> {
    const address = email.trim().toLowerCase();
    await this.db.execute(
      `INSERT INTO ${this.t("esp_recipient_health")} AS h (company_id, email, soft_bounces, first_soft_at, last_soft_at) VALUES ($1, $2, 1, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (company_id, email) DO UPDATE SET
         soft_bounces = CASE WHEN h.last_soft_at < $3::timestamptz - make_interval(days => $4::int) THEN 1 ELSE h.soft_bounces + 1 END,
         first_soft_at = CASE WHEN h.last_soft_at < $3::timestamptz - make_interval(days => $4::int) THEN $3::timestamptz ELSE h.first_soft_at END,
         last_soft_at = $3::timestamptz`,
      [companyId, address, atIso, windowDays],
    );
    const rows = await this.recipientHealth(companyId, [address]);
    return rows[0] ?? { company_id: companyId, email: address, soft_bounces: 1, first_soft_at: atIso, last_soft_at: atIso, backoff_until: null };
  }

  async setBackoff(companyId: string, email: string, untilIso: string | null): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("esp_recipient_health")} SET backoff_until = $3::timestamptz WHERE company_id = $1 AND email = $2`, [companyId, email.trim().toLowerCase(), untilIso]);
  }

  async clearRecipientHealth(companyId: string, email: string): Promise<void> {
    await this.db.execute(`DELETE FROM ${this.t("esp_recipient_health")} WHERE company_id = $1 AND email = $2`, [companyId, email.trim().toLowerCase()]);
  }

  async sendByProviderMessage(companyId: string, provider: string, providerMessageId: string): Promise<SendRow | null> {
    const rows = await this.db.query<SendRow>(
      `SELECT ${SEND_COLUMNS} FROM ${this.t("send_requests")} WHERE company_id = $1 AND provider = $2 AND provider_message_id = $3 LIMIT 1`,
      [companyId, provider, providerMessageId],
    );
    return rows[0] ? normaliseSend(rows[0]) : null;
  }

  async markSendSentProvider(key: string, fields: { provider: string; providerMessageId: string; accountId: string; fromAddress: string; skipped?: SkippedRecipient[] }): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("send_requests")} SET status = 'sent', permanent = false, error = NULL, provider = $2, provider_message_id = $3, account_id = $4, from_address = $5,
         skipped = $6::jsonb, sent_at = now(), updated_at = now(),
         request = CASE WHEN context ->> 'kind' = '${PRIVATE_KIND_SQL}' THEN request - 'text' - 'html' - 'attachments' ELSE request END
        WHERE key = $1`,
      [key, fields.provider, fields.providerMessageId, fields.accountId, fields.fromAddress, json(fields.skipped ?? [])],
    );
  }

  async setSendDelivery(companyId: string, key: string, status: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("send_requests")} SET delivery_status = $3, delivery = delivery || $4::jsonb, updated_at = now() WHERE company_id = $1 AND key = $2`,
      [companyId, key, status, json(detail)],
    );
  }

  async patchSendDelivery(companyId: string, key: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.execute(`UPDATE ${this.t("send_requests")} SET delivery = delivery || $3::jsonb, updated_at = now() WHERE company_id = $1 AND key = $2`, [companyId, key, json(detail)]);
  }

  async markDraftSentProvider(companyId: string, id: string, fields: { context: SendContext; sendKey: string; fromAddress: string }): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.t("messages")} SET status = 'sent', from_addr = $3::jsonb, sent_context = $4::jsonb, send_key = $5, send_error = NULL, received_at = now(), triaged_at = now(), updated_at = now()
        WHERE id = $1 AND company_id = $2`,
      [id, companyId, json({ email: fields.fromAddress }), json(fields.context), fields.sendKey],
    );
  }

  async eraseEspRecipients(companyId: string, emails: string[]): Promise<number> {
    const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return 0;
    const events = await this.db.execute(`DELETE FROM ${this.t("esp_events")} WHERE company_id = $1 AND recipient = ANY(${textArray(2)})`, [companyId, json(wanted)]);
    const health = await this.db.execute(`DELETE FROM ${this.t("esp_recipient_health")} WHERE company_id = $1 AND email = ANY(${textArray(2)})`, [companyId, json(wanted)]);
    return (events.rowCount ?? 0) + (health.rowCount ?? 0);
  }

  // ── delegations, drafts, templates (existing tools) ─────────────────────

  async listDelegations(companyId: string) {
    return this.db.query<{ id: string; account_id: string; agent_id: string; can_read: boolean; can_draft: boolean; can_send: boolean; source: DelegationSource; granted_by: string | null }>(
      `SELECT id, account_id, agent_id, can_read, can_draft, can_send, source, granted_by FROM ${this.t("delegations")} WHERE company_id = $1`,
      [companyId],
    );
  }

  async insertLegacyAccount(row: { id: string; companyId: string; provider: string; address: string; secretRef: string | null; ownerUserId: string | null }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("accounts")} (id, company_id, provider, address, secret_ref, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.companyId, row.provider, row.address, row.secretRef, row.ownerUserId],
    );
  }

  /** Adds a delegation a person made on the page; an existing one for the same mailbox and agent only gains rights, never loses them. */
  async insertDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; grantedBy?: string | null }): Promise<void> {
    await this.grantDelegation({ ...row, source: "manual", grantedBy: row.grantedBy ?? null });
  }

  async grantDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; source: DelegationSource; grantedBy: string | null }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.t("delegations")} AS d (id, company_id, account_id, agent_id, can_read, can_draft, can_send, source, granted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id, agent_id) DO UPDATE SET can_read = d.can_read OR EXCLUDED.can_read, can_draft = d.can_draft OR EXCLUDED.can_draft, can_send = d.can_send OR EXCLUDED.can_send,
         source = EXCLUDED.source, granted_by = EXCLUDED.granted_by`,
      [row.id, row.companyId, row.accountId, row.agentId, row.canRead, row.canDraft, row.canSend, row.source, row.grantedBy],
    );
    // A person's explicit grant ends an earlier removal.
    await this.db.execute(`DELETE FROM ${this.t("delegation_removals")} WHERE account_id = $1 AND agent_id = $2`, [row.accountId, row.agentId]);
  }

  async insertDefaultDelegation(row: { id: string; companyId: string; accountId: string; agentId: string; canRead: boolean; canDraft: boolean; canSend: boolean; grantedBy: string }): Promise<boolean> {
    const res = await this.db.execute(
      `INSERT INTO ${this.t("delegations")} (id, company_id, account_id, agent_id, can_read, can_draft, can_send, source, granted_by)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::boolean, $6::boolean, $7::boolean, 'default', $8::text
        WHERE NOT EXISTS (SELECT 1 FROM ${this.t("delegation_removals")} WHERE account_id = $3 AND agent_id = $4)
       ON CONFLICT (account_id, agent_id) DO NOTHING`,
      [row.id, row.companyId, row.accountId, row.agentId, row.canRead, row.canDraft, row.canSend, row.grantedBy],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async hasDelegationRemoval(accountId: string, agentId: string): Promise<boolean> {
    const rows = await this.db.query<{ present: number }>(`SELECT 1 AS present FROM ${this.t("delegation_removals")} WHERE account_id = $1 AND agent_id = $2 LIMIT 1`, [accountId, agentId]);
    return rows.length > 0;
  }

  async deleteDefaultDelegations(companyId: string, accountId: string): Promise<number> {
    const res = await this.db.execute(`DELETE FROM ${this.t("delegations")} WHERE company_id = $1 AND account_id = $2 AND source = 'default'`, [companyId, accountId]);
    return res.rowCount ?? 0;
  }

  async removeDelegation(companyId: string, accountId: string, agentId: string, removedBy: string | null): Promise<boolean> {
    const res = await this.db.execute(`DELETE FROM ${this.t("delegations")} WHERE company_id = $1 AND account_id = $2 AND agent_id = $3`, [companyId, accountId, agentId]);
    await this.db.execute(
      `INSERT INTO ${this.t("delegation_removals")} (account_id, agent_id, company_id, removed_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, agent_id) DO UPDATE SET removed_at = now(), removed_by = EXCLUDED.removed_by, company_id = EXCLUDED.company_id`,
      [accountId, agentId, companyId, removedBy],
    );
    return (res.rowCount ?? 0) > 0;
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

  /** Drafts and other unsent mail for the page, with what the draft preview shows (body capped at 20,000 characters). */
  async recentMessages(companyId: string, limit: number) {
    return this.db.query<RecentMessageRow>(
      `SELECT id, account_id, subject, left(body, 20000) AS body, status, direction, read_at IS NOT NULL AS is_read, to_addrs, cc_addrs, bcc_addrs, draft, send_error, created_at
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

  /**
   * Chart series for the page (read only): inbound mail per UTC day and
   * category, and send requests per UTC day and status, for the last `days` days.
   */
  async dailyCounts(companyId: string, days = 14) {
    return this.db.query<{ kind: string; day: string; key: string | null; n: string | number }>(
      `SELECT 'received' AS kind, to_char(COALESCE(received_at, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, category AS key, count(*)::int AS n
         FROM ${this.t("messages")}
        WHERE company_id = $1 AND direction = 'inbound'
          AND COALESCE(received_at, created_at) >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $2::int - 1)
        GROUP BY 2, 3
       UNION ALL
       SELECT 'send', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), status, count(*)::int
         FROM ${this.t("send_requests")}
        WHERE company_id = $1
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => $2::int - 1)
        GROUP BY 2, 3`,
      [companyId, days],
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
