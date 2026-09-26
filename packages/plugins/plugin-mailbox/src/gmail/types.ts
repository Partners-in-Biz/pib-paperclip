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

export type AccountStatus = "manual" | "connected" | "needs_reconnect" | "disconnected";

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
  clientSource: "email" | "domain" | "reply" | "jev" | "correction" | null;
  decisionIds: Record<string, string>;
  model: string | null;
  /** Gmail label names applied for this triage. */
  labels: string[];
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
}

export interface DraftExtras {
  html?: string | null;
  replyToMessageId?: string | null;
  threadId?: string | null;
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
}

export type SendStatus = "sending" | "sent" | "failed" | "retrying";

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
