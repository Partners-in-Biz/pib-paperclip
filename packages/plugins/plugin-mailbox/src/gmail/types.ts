import type { MailAddress, MailCategory, MailSendRequested } from "@partnersinbiz/pib-plugin-kit";

export type SendContext = MailSendRequested["context"];

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mime: string;
  bytes: number;
}

/** What a delivery failure notice says about the bounced mail. */
export interface BounceInfo {
  recipients: string[];
  /** Message-IDs of the bounced message found in the notice's part headers. */
  rfcIds: string[];
}

/** `pending`: a send-only account whose domain is not verified at the provider yet. */
export type AccountStatus = "manual" | "connected" | "needs_reconnect" | "disconnected" | "pending";

export interface AccountRow {
  id: string;
  company_id: string;
  provider: string;
  address: string;
  status: AccountStatus;
  token_sealed: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  history_id: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  sync_stats: Record<string, unknown> | null;
  connected_by_user_id: string | null;
  connected_at: string | null;
  alert_issue_id: string | null;
  is_default: boolean;
  label_ids: Record<string, string> | null;
  owner_user_id: string | null;
  /** The client this mailbox belongs to (null: the company's own mailbox). It sends only that client's mail, and the leads it receives go to the CRM in the client's scope. */
  client_kind: string | null;
  client_ref: string | null;
  /** Display name for mail sent from this mailbox (a request's `fromName` wins). */
  from_name: string | null;
  /** Where replies go when a request names none: a send-only account has no inbox of its own. */
  reply_to: string | null;
  created_at: string;
}

export interface StoredTriage {
  category: MailCategory | null;
  urgency: number | null;
  needsReply: number | null;
  phishing: number | null;
  /** Confidence of the category answer (1 for deterministic, null for rules). */
  confidence: number | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
  /** Where the category came from. */
  source: "jev" | "rules" | "reply" | "correction";
  clientSource: "email" | "domain" | "reply" | "jev" | "correction" | "mapping" | null;
  decisionIds: Record<string, string>;
  model: string | null;
  /** Gmail label names applied for this triage. */
  labels: string[];
  /** The client mail mapping that filed this message (client mail forwarded or relayed to a company mailbox). */
  mapping?: { id: string; type: ClientMapType } | null;
}

export interface MessageRow {
  id: string;
  company_id: string;
  account_id: string;
  subject: string;
  body: string;
  direction: "inbound" | "outbound";
  status: string;
  created_at: string;
  read_at: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  refs: string[] | null;
  from_addr: MailAddress | null;
  to_addrs: MailAddress[] | null;
  cc_addrs: MailAddress[] | null;
  bcc_addrs: MailAddress[] | null;
  snippet: string | null;
  labels: string[] | null;
  attachments: AttachmentMeta[] | null;
  bulk: boolean | null;
  received_at: string | null;
  triage: StoredTriage | null;
  triaged_at: string | null;
  category: string | null;
  urgency: number | string | null;
  needs_reply: number | string | null;
  phishing: number | string | null;
  client_kind: string | null;
  client_ref: string | null;
  reply_to: SendContext | null;
  sent_context: SendContext | null;
  send_key: string | null;
  draft: DraftExtras | null;
  send_error: string | null;
  bounce: BounceInfo | null;
  /** The Reply-To header of inbound mail (the visitor, for a form relayed by a website). */
  reply_to_addr: MailAddress | null;
  /** `mapped`: a client mail mapping filed it; `needs_mapping`: it looks like a client's mail but no mapping says so. */
  map_state: MapState | null;
  map_id: string | null;
}

export type MapState = "mapped" | "needs_mapping";

export interface DraftExtras {
  html?: string | null;
  replyToMessageId?: string | null;
  threadId?: string | null;
  /** Reply-To and display name the draft is sent with. */
  replyTo?: MailAddress | null;
  fromName?: string | null;
  /** Who saved the draft: an agent (tool or action) or a person on the Mailbox page. */
  by?: { kind: "agent" | "user"; id: string } | null;
}

export interface NewGmailMessage {
  id: string;
  companyId: string;
  accountId: string;
  direction: "inbound" | "outbound";
  status: "synced" | "sent";
  subject: string;
  gmailMessageId: string;
  gmailThreadId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  refs: string[];
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc?: MailAddress[];
  snippet: string;
  labels: string[];
  attachments: AttachmentMeta[];
  bulk: boolean;
  receivedAt: string;
  read: boolean;
  sentContext?: SendContext | null;
  sendKey?: string | null;
  /** Outbound rows written at send time are already "triaged". */
  triaged?: boolean;
  bounce?: BounceInfo | null;
  replyToAddr?: MailAddress | null;
}

export type SendStatus = "sending" | "sent" | "failed" | "retrying";

export type SuppressionScope = "marketing" | "all";
export type SuppressionReasonKey = "unsubscribed" | "bounced" | "complained" | "manual";

/** An address the Mailbox will not email: marketing only, or (after a hard bounce) at all. */
export interface SuppressionRow {
  company_id: string;
  email: string;
  scope: SuppressionScope;
  reason: SuppressionReasonKey;
  /** The plugin that saw it (`partnersinbiz.mailbox`, `.crm`, `.campaigns`). */
  source: string;
  detail: string | null;
  /** Whose list the opt-out is on (`own`, `company:<id>`, `contact:<id>`). Empty: written before senders existed, blocks every sender. */
  sender_key: string;
  /** Set on an erased person's marker row: a one-way hash of the address (the row keeps no address). */
  email_hash: string | null;
  erased_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuppressionInput {
  companyId: string;
  email: string;
  scope: SuppressionScope;
  reason: SuppressionReasonKey;
  source: string;
  detail?: string | null;
  /** Whose list (default: empty, every sender). */
  senderKey?: string | null;
}

/** A recipient a send left out because it is on the list. */
export interface SkippedRecipient {
  email: string;
  scope: SuppressionScope;
  reason: SuppressionReasonKey;
}

export type DelegationSource = "manual" | "default" | "ask";

export interface DelegationRow {
  id: string;
  company_id: string;
  account_id: string;
  agent_id: string;
  can_read: boolean;
  can_draft: boolean;
  can_send: boolean;
  source: DelegationSource;
  granted_by: string | null;
}

export type ClientMapType = "sender_domain" | "sender_address" | "recipient_domain" | "recipient_address";

/** Mail from or to this domain or address is a client's, not the company's own. */
export interface ClientMapRow {
  id: string;
  company_id: string;
  match_type: ClientMapType;
  /** Lower case; a domain without a leading `@`. */
  pattern: string;
  client_kind: "company" | "contact";
  client_ref: string;
  client_name: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export type DomainStatus = "healthy" | "warn" | "bad" | "unknown";

export interface DomainCheckRow {
  company_id: string;
  domain: string;
  status: DomainStatus;
  result: Record<string, unknown>;
  source: "account" | "manual";
  client_kind: string | null;
  client_ref: string | null;
  checked_at: string;
  first_checked_at: string;
  status_since: string;
  dmarc_none_since: string | null;
}

export interface SendRow {
  key: string;
  company_id: string;
  source_plugin: string;
  account_id: string | null;
  from_address: string | null;
  to_addrs: MailAddress[] | null;
  subject: string;
  status: SendStatus;
  permanent: boolean;
  attempts: number;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rfc_message_id: string | null;
  error: string | null;
  context: SendContext;
  request: MailSendRequested;
  claimed_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  /** Recipients left out because they are on the do-not-email list. */
  skipped?: SkippedRecipient[] | null;
  /** The email provider that took the message (empty for Gmail), its id for it, and what happened to it afterwards. */
  provider?: string | null;
  provider_message_id?: string | null;
  delivery_status?: string | null;
  delivery?: Record<string, unknown> | null;
}

export interface SendRecordInput {
  key: string;
  companyId: string;
  sourcePlugin: string;
  accountId: string | null;
  fromAddress: string | null;
  to: MailAddress[];
  subject: string;
  context: SendContext;
  request: MailSendRequested;
}

export interface TriageWrite {
  triage: StoredTriage;
  category: string | null;
  urgency: number | null;
  needsReply: number | null;
  phishing: number | null;
  clientKind: string | null;
  clientRef: string | null;
  replyTo: SendContext | null;
  /** Left out (undefined): the stored mapping state is kept. */
  mapState?: MapState | null;
  mapId?: string | null;
}

export interface CrmClientRow {
  kind: "company" | "contact";
  id: string;
  name: string;
  domain: string | null;
  emails: string[];
  accountIds: string[];
}

export interface OAuthSessionRow {
  state: string;
  companyId: string;
  createdByUserId: string | null;
  returnTo: string | null;
  expired: boolean;
}

export interface InboxFilter {
  accountId?: string | null;
  category?: string | null;
  needsReply?: boolean;
  clientKind?: string | null;
  clientRef?: string | null;
  limit: number;
}
