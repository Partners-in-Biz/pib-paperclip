/**
 * Storage for e-sign (migration 012): documents, the links made for them (hashes only), the audit trail, which clients
 * may use e-sign, and the request log both public endpoints use for rate limits.
 *
 * One statement per call, every query scoped by company except the public lookups by page id (the page id is the key;
 * what they return carries its company so the caller scopes everything after). Simple statements only.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, table } from "./db.js";
import type { ClientKind } from "./refs.js";

export const DOC_KINDS = ["proposal", "quote", "contract"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_STATUSES = ["draft", "awaiting_approval", "sent", "viewed", "signed", "declined", "expired", "void"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/** Statuses a signer can still sign in. */
export const OPEN_STATUSES: readonly DocStatus[] = ["sent", "viewed"];
/** Statuses that are finished: nothing more happens to the document. */
export const FINAL_STATUSES: readonly DocStatus[] = ["signed", "declined", "expired", "void"];

export function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const int = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const kindOf = (value: unknown): ClientKind => (value === "contact" ? "contact" : "company");

function member<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

export interface SignDocument {
  id: string;
  companyId: string;
  clientKind: ClientKind;
  clientRef: string;
  dealId: string | null;
  quoteId: string | null;
  quoteNumber: string | null;
  kind: DocKind;
  title: string;
  templateKey: string | null;
  templateVersion: string | null;
  templateReviewed: boolean;
  /** The exact text that is signed (Markdown). Never changed once the document leaves draft. */
  content: string;
  contentSha256: string;
  consentText: string;
  consentSha256: string;
  valueMinor: number | null;
  currency: string | null;
  brand: Record<string, unknown>;
  pageId: string;
  status: DocStatus;
  recipientContactId: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  validDays: number;
  expiresAt: string | null;
  issueId: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  reminders: number;
  lastReminderAt: string | null;
  nextReminderAt: string | null;
  escalatedAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  signerIpHash: string | null;
  signerUserAgent: string | null;
  nameMatches: boolean | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiredAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  signedCopyMd: string | null;
  signedCopyHtml: string | null;
  signedCopySha256: string | null;
  auditHead: string | null;
  effectsDoneAt: string | null;
  canaryToken: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DocRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  deal_id: string | null;
  quote_id: string | null;
  quote_number: string | null;
  kind: string;
  title: string;
  template_key: string | null;
  template_version: string | null;
  template_reviewed: boolean | null;
  content: string;
  content_sha256: string;
  consent_text: string;
  consent_sha256: string;
  value_minor: unknown;
  currency: string | null;
  brand: unknown;
  page_id: string;
  status: string;
  recipient_contact_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  valid_days: unknown;
  expires_at: unknown;
  issue_id: string | null;
  sent_at: unknown;
  viewed_at: unknown;
  last_viewed_at: unknown;
  view_count: unknown;
  reminders: unknown;
  last_reminder_at: unknown;
  next_reminder_at: unknown;
  escalated_at: unknown;
  signed_at: unknown;
  signer_name: string | null;
  signer_ip_hash: string | null;
  signer_user_agent: string | null;
  name_matches: boolean | null;
  declined_at: unknown;
  decline_reason: string | null;
  expired_at: unknown;
  voided_at: unknown;
  void_reason: string | null;
  signed_copy_md: string | null;
  signed_copy_html: string | null;
  signed_copy_sha256: string | null;
  audit_head: string | null;
  effects_done_at: unknown;
  canary_token: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const DOC_COLUMNS = `id, company_id, client_kind, client_ref, deal_id, quote_id, quote_number, kind, title, template_key, template_version, template_reviewed,
  content, content_sha256, consent_text, consent_sha256, value_minor, currency, brand, page_id, status, recipient_contact_id, recipient_name, recipient_email,
  valid_days, expires_at, issue_id, sent_at, viewed_at, last_viewed_at, view_count, reminders, last_reminder_at, next_reminder_at, escalated_at, signed_at,
  signer_name, signer_ip_hash, signer_user_agent, name_matches, declined_at, decline_reason, expired_at, voided_at, void_reason, signed_copy_md,
  signed_copy_html, signed_copy_sha256, audit_head, effects_done_at, canary_token, created_by, created_at, updated_at`;

function mapDoc(row: DocRow): SignDocument {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: kindOf(row.client_kind),
    clientRef: row.client_ref,
    dealId: row.deal_id ?? null,
    quoteId: row.quote_id ?? null,
    quoteNumber: row.quote_number ?? null,
    kind: member(DOC_KINDS, row.kind, "proposal"),
    title: row.title,
    templateKey: row.template_key ?? null,
    templateVersion: row.template_version ?? null,
    templateReviewed: row.template_reviewed === true,
    content: row.content,
    contentSha256: row.content_sha256,
    consentText: row.consent_text,
    consentSha256: row.consent_sha256,
    valueMinor: row.value_minor == null ? null : int(row.value_minor),
    currency: row.currency ?? null,
    brand: asRecord(row.brand),
    pageId: row.page_id,
    status: member(DOC_STATUSES, row.status, "draft"),
    recipientContactId: row.recipient_contact_id ?? null,
    recipientName: row.recipient_name ?? null,
    recipientEmail: row.recipient_email ?? null,
    validDays: int(row.valid_days) || 14,
    expiresAt: iso(row.expires_at),
    issueId: row.issue_id ?? null,
    sentAt: iso(row.sent_at),
    viewedAt: iso(row.viewed_at),
    lastViewedAt: iso(row.last_viewed_at),
    viewCount: int(row.view_count),
    reminders: int(row.reminders),
    lastReminderAt: iso(row.last_reminder_at),
    nextReminderAt: iso(row.next_reminder_at),
    escalatedAt: iso(row.escalated_at),
    signedAt: iso(row.signed_at),
    signerName: row.signer_name ?? null,
    signerIpHash: row.signer_ip_hash ?? null,
    signerUserAgent: row.signer_user_agent ?? null,
    nameMatches: row.name_matches == null ? null : row.name_matches === true,
    declinedAt: iso(row.declined_at),
    declineReason: row.decline_reason ?? null,
    expiredAt: iso(row.expired_at),
    voidedAt: iso(row.voided_at),
    voidReason: row.void_reason ?? null,
    signedCopyMd: row.signed_copy_md ?? null,
    signedCopyHtml: row.signed_copy_html ?? null,
    signedCopySha256: row.signed_copy_sha256 ?? null,
    auditHead: row.audit_head ?? null,
    effectsDoneAt: iso(row.effects_done_at),
    canaryToken: row.canary_token ?? null,
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export type NewSignDocument = Pick<
  SignDocument,
  | "id" | "companyId" | "clientKind" | "clientRef" | "dealId" | "quoteId" | "quoteNumber" | "kind" | "title" | "templateKey" | "templateVersion" | "templateReviewed"
  | "content" | "contentSha256" | "consentText" | "consentSha256" | "valueMinor" | "currency" | "brand" | "pageId" | "recipientContactId" | "recipientName"
  | "recipientEmail" | "validDays" | "createdBy"
>;

export async function insertDoc(ctx: PluginContext, doc: NewSignDocument): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sign_documents")}
      (id, company_id, client_kind, client_ref, deal_id, quote_id, quote_number, kind, title, template_key, template_version, template_reviewed,
       content, content_sha256, consent_text, consent_sha256, value_minor, currency, brand, page_id, status, recipient_contact_id, recipient_name,
       recipient_email, valid_days, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, 'draft', $21, $22, $23, $24, $25)`,
    [
      doc.id, doc.companyId, doc.clientKind, doc.clientRef, doc.dealId, doc.quoteId, doc.quoteNumber, doc.kind, doc.title, doc.templateKey, doc.templateVersion,
      doc.templateReviewed, doc.content, doc.contentSha256, doc.consentText, doc.consentSha256, doc.valueMinor, doc.currency, JSON.stringify(doc.brand),
      doc.pageId, doc.recipientContactId, doc.recipientName, doc.recipientEmail, doc.validDays, doc.createdBy,
    ],
  );
}

export async function getDoc(ctx: PluginContext, companyId: string, id: string): Promise<SignDocument | null> {
  const rows = await ctx.db.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapDoc(rows[0]) : null;
}

/** The public lookup: the page id is the key. The caller must scope everything after it by the document's own company. */
export async function getDocByPage(ctx: PluginContext, pageId: string): Promise<SignDocument | null> {
  const rows = await ctx.db.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE page_id = $1 LIMIT 1`, [pageId]);
  return rows[0] ? mapDoc(rows[0]) : null;
}

export async function listDocs(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string } | null, limit = 100): Promise<SignDocument[]> {
  const cap = Math.max(1, Math.min(Math.trunc(limit), 500));
  const rows = client
    ? await ctx.db.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at DESC LIMIT ${cap}`, [companyId, client.kind, client.id])
    : await ctx.db.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT ${cap}`, [companyId]);
  return rows.map(mapDoc);
}

export async function docsByStatus(ctx: PluginContext, companyId: string, statuses: readonly DocStatus[], limit = 200): Promise<SignDocument[]> {
  const rows = await ctx.db.query<DocRow>(
    `SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND status = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) ORDER BY created_at LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 500))}`,
    [companyId, JSON.stringify([...statuses])],
  );
  return rows.map(mapDoc);
}

/** Documents signed whose after-signing work (hand-offs, issue document, copy email) is not finished. */
export async function docsNeedingEffects(ctx: PluginContext, companyId: string, limit = 50): Promise<SignDocument[]> {
  const rows = await ctx.db.query<DocRow>(
    `SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND status = 'signed' AND effects_done_at IS NULL ORDER BY signed_at LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 200))}`,
    [companyId],
  );
  return rows.map(mapDoc);
}

export async function docByIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<SignDocument | null> {
  const rows = await ctx.db.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND issue_id = $2 LIMIT 1`, [companyId, issueId]);
  return rows[0] ? mapDoc(rows[0]) : null;
}

/** Every company that has documents (the care job acts per company). */
export async function companiesWithDocs(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "sign_documents")}`);
  return rows.map((row) => row.company_id);
}

type Value = string | number | boolean | null | { json: unknown } | { now: true };

const COLUMN: Record<string, string> = {
  status: "status", dealId: "deal_id", issueId: "issue_id", expiresAt: "expires_at", sentAt: "sent_at", viewedAt: "viewed_at", lastViewedAt: "last_viewed_at",
  viewCount: "view_count", reminders: "reminders", lastReminderAt: "last_reminder_at", nextReminderAt: "next_reminder_at", escalatedAt: "escalated_at",
  signedAt: "signed_at", signerName: "signer_name", signerIpHash: "signer_ip_hash", signerUserAgent: "signer_user_agent", nameMatches: "name_matches",
  declinedAt: "declined_at", declineReason: "decline_reason", expiredAt: "expired_at", voidedAt: "voided_at", voidReason: "void_reason",
  signedCopyMd: "signed_copy_md", signedCopyHtml: "signed_copy_html", signedCopySha256: "signed_copy_sha256", auditHead: "audit_head",
  effectsDoneAt: "effects_done_at", canaryToken: "canary_token", recipientContactId: "recipient_contact_id", recipientName: "recipient_name",
  recipientEmail: "recipient_email", validDays: "valid_days", brand: "brand", valueMinor: "value_minor", currency: "currency",
};

/** The fields a document may change after it exists. `content`, its hash and the consent wording are deliberately not here: they are frozen. */
export type DocPatch = Partial<Record<keyof typeof COLUMN, Value>>;

function setClause(patch: DocPatch, params: unknown[]): string {
  const sets: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = COLUMN[field];
    if (!column) throw new Error(`sign document field ${field} cannot be changed`);
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && "now" in value) {
      sets.push(`${column} = now()`);
    } else if (value !== null && typeof value === "object") {
      params.push(JSON.stringify(value.json));
      sets.push(`${column} = $${params.length}::jsonb`);
    } else if (typeof value === "string" && /(_at)$/.test(column) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      params.push(value);
      sets.push(`${column} = $${params.length}::timestamptz`);
    } else {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  sets.push("updated_at = now()");
  return sets.join(", ");
}

/** Changes fields of a document. Never touches the frozen text. */
export async function patchDoc(ctx: PluginContext, companyId: string, id: string, patch: DocPatch): Promise<void> {
  const params: unknown[] = [companyId, id];
  const sets = setClause(patch, params);
  await ctx.db.execute(`UPDATE ${table(ctx, "sign_documents")} SET ${sets} WHERE company_id = $1 AND id = $2`, params);
}

/**
 * Moves a document to a new state only if it is in one of `from` right now: the single statement is the lock, so two
 * requests racing (a double click, a replay) cannot both win. Returns whether this call made the change.
 */
export async function moveDoc(ctx: PluginContext, companyId: string, id: string, from: readonly DocStatus[], patch: DocPatch): Promise<boolean> {
  const params: unknown[] = [companyId, id, JSON.stringify([...from])];
  const sets = setClause(patch, params);
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "sign_documents")} SET ${sets} WHERE company_id = $1 AND id = $2 AND status = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))`,
    params,
  );
  return (res?.rowCount ?? 0) > 0;
}

/** Removes documents of a client that never became a record worth keeping (not signed). Signed ones are kept unless `includeSigned`. */
export async function deleteDocsOfClient(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }, includeSigned: boolean): Promise<{ removed: number; keptSigned: number }> {
  const docs = await listDocs(ctx, companyId, client, 500);
  let removed = 0;
  let keptSigned = 0;
  for (const doc of docs) {
    if (doc.status === "signed" && !includeSigned) {
      keptSigned += 1;
      continue;
    }
    await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_events")} WHERE company_id = $1 AND doc_id = $2`, [companyId, doc.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_tokens")} WHERE company_id = $1 AND doc_id = $2`, [companyId, doc.id]);
    removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND id = $2`, [companyId, doc.id]))?.rowCount ?? 0;
  }
  return { removed, keptSigned };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The hash a link is stored under. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface SignToken {
  tokenHash: string;
  companyId: string;
  docId: string;
  approvalId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  usedAt: string | null;
}

interface TokenRow {
  token_hash: string;
  company_id: string;
  doc_id: string;
  approval_id: string | null;
  expires_at: unknown;
  revoked_at: unknown;
  used_at: unknown;
}

const TOKEN_COLUMNS = "token_hash, company_id, doc_id, approval_id, expires_at, revoked_at, used_at";

const mapToken = (row: TokenRow): SignToken => ({ tokenHash: row.token_hash, companyId: row.company_id, docId: row.doc_id, approvalId: row.approval_id ?? null, expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at), usedAt: iso(row.used_at) });

export async function insertToken(ctx: PluginContext, input: { hash: string; companyId: string; docId: string; approvalId: string | null; expiresAt: string }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sign_tokens")} (token_hash, company_id, doc_id, approval_id, expires_at) VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [input.hash, input.companyId, input.docId, input.approvalId, input.expiresAt],
  );
}

export async function tokenByHash(ctx: PluginContext, hash: string): Promise<SignToken | null> {
  const rows = await ctx.db.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM ${table(ctx, "sign_tokens")} WHERE token_hash = $1 LIMIT 1`, [hash]);
  return rows[0] ? mapToken(rows[0]) : null;
}

export async function tokensOfDoc(ctx: PluginContext, companyId: string, docId: string): Promise<SignToken[]> {
  const rows = await ctx.db.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM ${table(ctx, "sign_tokens")} WHERE company_id = $1 AND doc_id = $2 LIMIT 50`, [companyId, docId]);
  return rows.map(mapToken);
}

/** Switches off every live link of a document (signed, declined, withdrawn, expired). */
export async function revokeTokens(ctx: PluginContext, companyId: string, docId: string): Promise<number> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "sign_tokens")} SET revoked_at = now() WHERE company_id = $1 AND doc_id = $2 AND revoked_at IS NULL`, [companyId, docId]);
  return res?.rowCount ?? 0;
}

/** Switches off the links minted for one email that never went out. */
export async function revokeTokensOfApproval(ctx: PluginContext, companyId: string, approvalId: string): Promise<number> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "sign_tokens")} SET revoked_at = now() WHERE company_id = $1 AND approval_id = $2 AND revoked_at IS NULL`, [companyId, approvalId]);
  return res?.rowCount ?? 0;
}

/** Marks a link as used (a signature or a decline came on it). Once only: true when this call did it. */
export async function useToken(ctx: PluginContext, hash: string): Promise<boolean> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "sign_tokens")} SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL`, [hash]);
  return (res?.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

export interface SignEvent {
  id: string;
  companyId: string;
  docId: string;
  seq: number;
  kind: string;
  actor: string;
  ipHash: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
  at: string;
}

interface EventRow {
  id: string;
  company_id: string;
  doc_id: string;
  seq: unknown;
  kind: string;
  actor: string;
  ip_hash: string | null;
  user_agent: string | null;
  detail: unknown;
  prev_hash: string;
  hash: string;
  at: string;
}

const EVENT_COLUMNS = "id, company_id, doc_id, seq, kind, actor, ip_hash, user_agent, detail, prev_hash, hash, at";

const mapEvent = (row: EventRow): SignEvent => ({
  id: row.id,
  companyId: row.company_id,
  docId: row.doc_id,
  seq: int(row.seq),
  kind: row.kind,
  actor: row.actor,
  ipHash: row.ip_hash ?? null,
  userAgent: row.user_agent ?? null,
  detail: asRecord(row.detail),
  prevHash: row.prev_hash,
  hash: row.hash,
  at: row.at,
});

export async function lastEvent(ctx: PluginContext, companyId: string, docId: string): Promise<SignEvent | null> {
  const rows = await ctx.db.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM ${table(ctx, "sign_events")} WHERE company_id = $1 AND doc_id = $2 ORDER BY seq DESC LIMIT 1`, [companyId, docId]);
  return rows[0] ? mapEvent(rows[0]) : null;
}

export async function eventsOf(ctx: PluginContext, companyId: string, docId: string, limit = 500): Promise<SignEvent[]> {
  const rows = await ctx.db.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM ${table(ctx, "sign_events")} WHERE company_id = $1 AND doc_id = $2 ORDER BY seq LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 1000))}`, [companyId, docId]);
  return rows.map(mapEvent);
}

/** Appends one audit row. False when that sequence number was taken (another request wrote first): the caller re-reads and tries again. */
export async function insertEvent(ctx: PluginContext, event: Omit<SignEvent, "id">): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sign_events")} (id, company_id, doc_id, seq, kind, actor, ip_hash, user_agent, detail, prev_hash, hash, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     ON CONFLICT (doc_id, seq) DO NOTHING`,
    [randomUUID(), event.companyId, event.docId, event.seq, event.kind, event.actor, event.ipHash, event.userAgent, JSON.stringify(event.detail), event.prevHash, event.hash, event.at],
  );
  return (res?.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Which clients may use e-sign
// ---------------------------------------------------------------------------

export interface EsignClient {
  clientKind: ClientKind;
  clientRef: string;
  enabledBy: string;
  enabledAt: string | null;
  templatesReviewed: boolean;
  note: string | null;
}

interface EsignClientRow {
  client_kind: string;
  client_ref: string;
  enabled_by: string;
  enabled_at: unknown;
  templates_reviewed: boolean | null;
  note: string | null;
}

const mapEsignClient = (row: EsignClientRow): EsignClient => ({ clientKind: kindOf(row.client_kind), clientRef: row.client_ref, enabledBy: row.enabled_by, enabledAt: iso(row.enabled_at), templatesReviewed: row.templates_reviewed === true, note: row.note ?? null });

export async function getEsignClient(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }): Promise<EsignClient | null> {
  const rows = await ctx.db.query<EsignClientRow>(
    `SELECT client_kind, client_ref, enabled_by, enabled_at, templates_reviewed, note FROM ${table(ctx, "esign_clients")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 LIMIT 1`,
    [companyId, client.kind, client.id],
  );
  return rows[0] ? mapEsignClient(rows[0]) : null;
}

export async function listEsignClients(ctx: PluginContext, companyId: string): Promise<EsignClient[]> {
  const rows = await ctx.db.query<EsignClientRow>(`SELECT client_kind, client_ref, enabled_by, enabled_at, templates_reviewed, note FROM ${table(ctx, "esign_clients")} WHERE company_id = $1 ORDER BY enabled_at LIMIT 500`, [companyId]);
  return rows.map(mapEsignClient);
}

export async function putEsignClient(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }, input: { enabledBy: string; templatesReviewed: boolean; note: string | null }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "esign_clients")} (id, company_id, client_kind, client_ref, enabled_by, templates_reviewed, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, client_kind, client_ref) DO NOTHING`,
    [randomUUID(), companyId, client.kind, client.id, input.enabledBy, input.templatesReviewed, input.note],
  );
}

export async function deleteEsignClient(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }): Promise<boolean> {
  const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "esign_clients")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, client.kind, client.id]);
  return (res?.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The request log both public endpoints share (rate limits)
// ---------------------------------------------------------------------------

export async function recordPublicHit(ctx: PluginContext, scope: string, subject: string, ipHash: string | null, outcome: string): Promise<void> {
  await ctx.db.execute(`INSERT INTO ${table(ctx, "public_hits")} (id, scope, subject, ip_hash, outcome) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), scope, subject, ipHash, outcome]);
}

/** How many requests since `sinceIso` (capped at `cap`: past it the answer is "too many"). `subject` and `ipHash` narrow it; `outcome` counts only that outcome. */
export async function countPublicHits(ctx: PluginContext, scope: string, sinceIso: string, cap: number, filter: { subject?: string; ipHash?: string | null; outcome?: string } = {}): Promise<number> {
  const params: unknown[] = [scope, sinceIso];
  let where = "scope = $1 AND created_at >= $2::timestamptz";
  if (filter.subject) {
    params.push(filter.subject);
    where += ` AND subject = $${params.length}`;
  }
  if (filter.ipHash) {
    params.push(filter.ipHash);
    where += ` AND ip_hash = $${params.length}`;
  }
  if (filter.outcome) {
    params.push(filter.outcome);
    where += ` AND outcome = $${params.length}`;
  }
  // A count over at most `cap` rows: the busiest key reads one number back, not thousands of ids per request.
  const rows = await ctx.db.query<{ n: unknown }>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table(ctx, "public_hits")} WHERE ${where} LIMIT ${Math.max(1, Math.trunc(cap))}) AS capped`, params);
  return Number(rows[0]?.n ?? 0);
}

/** Hourly: request-log rows older than `beforeIso` go. The addresses in them are keyed hashes that a rate limit needs for minutes, not days. */
export async function purgePublicHits(ctx: PluginContext, beforeIso: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "public_hits")} WHERE created_at < $1::timestamptz`, [beforeIso]);
}
