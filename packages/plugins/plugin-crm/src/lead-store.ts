/**
 * Tables of the public lead form (migration 009): lead sources, the request
 * log used for rate limits, accepted captures, and consent records. One
 * statement per call, our own namespace only, scalar params (lists and objects
 * go as JSON text).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, table } from "./db.js";
import { SOURCE_STATUSES, type SourceStatus } from "./lead-form.js";
import type { ClientKind } from "./refs.js";

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------

export { SOURCE_STATUSES, type SourceStatus };

export interface LeadSource {
  id: string;
  companyId: string;
  /** Null for our own source: its leads are ours. */
  clientKind: ClientKind | null;
  clientRef: string | null;
  label: string;
  siteId: string | null;
  siteUrl: string | null;
  publicKey: string;
  previousKey: string | null;
  previousKeyUntil: string | null;
  /** Only server-to-server callers have one. Never returned by a tool after it was shown. */
  signingSecret: string | null;
  status: SourceStatus;
  /** A source of the canary client: it accepts the reserved test addresses, and nothing it receives is real. */
  canary: boolean;
  consentText: string | null;
  privacyUrl: string | null;
  successMessage: string | null;
  turnstileSiteKey: string | null;
  rateLimitPerHour: number;
  acceptedCount: number;
  rejectedCount: number;
  lastSubmissionAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface SourceRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  label: string;
  site_id: string | null;
  site_url: string | null;
  public_key: string;
  previous_key: string | null;
  previous_key_until: unknown;
  signing_secret: string | null;
  status: string;
  canary: boolean | null;
  consent_text: string | null;
  privacy_url: string | null;
  success_message: string | null;
  turnstile_site_key: string | null;
  rate_limit_per_hour: unknown;
  accepted_count: unknown;
  rejected_count: unknown;
  last_submission_at: unknown;
  created_by: string | null;
  created_at: unknown;
}

const SOURCE_COLUMNS = `id, company_id, client_kind, client_ref, label, site_id, site_url, public_key, previous_key, previous_key_until, signing_secret,
  status, canary, consent_text, privacy_url, success_message, turnstile_site_key, rate_limit_per_hour, accepted_count, rejected_count,
  last_submission_at, created_by, created_at`;

function mapSource(row: SourceRow): LeadSource {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "company" || row.client_kind === "contact" ? row.client_kind : null,
    clientRef: row.client_ref ?? null,
    label: row.label,
    siteId: row.site_id ?? null,
    siteUrl: row.site_url ?? null,
    publicKey: row.public_key,
    previousKey: row.previous_key ?? null,
    previousKeyUntil: iso(row.previous_key_until),
    signingSecret: row.signing_secret ?? null,
    status: (SOURCE_STATUSES as readonly string[]).includes(row.status) ? (row.status as SourceStatus) : "active",
    canary: row.canary === true,
    consentText: row.consent_text ?? null,
    privacyUrl: row.privacy_url ?? null,
    successMessage: row.success_message ?? null,
    turnstileSiteKey: row.turnstile_site_key ?? null,
    rateLimitPerHour: int(row.rate_limit_per_hour) || 120,
    acceptedCount: int(row.accepted_count),
    rejectedCount: int(row.rejected_count),
    lastSubmissionAt: iso(row.last_submission_at),
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function insertLeadSource(ctx: PluginContext, source: LeadSource): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "lead_sources")}
      (id, company_id, client_kind, client_ref, label, site_id, site_url, public_key, signing_secret, status, canary,
       consent_text, privacy_url, success_message, turnstile_site_key, rate_limit_per_hour, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      source.id,
      source.companyId,
      source.clientKind,
      source.clientRef,
      source.label,
      source.siteId,
      source.siteUrl,
      source.publicKey,
      source.signingSecret,
      source.status,
      source.canary,
      source.consentText,
      source.privacyUrl,
      source.successMessage,
      source.turnstileSiteKey,
      source.rateLimitPerHour,
      source.createdBy,
    ],
  );
}

/** Rewrites the settings a person or agent may change (never the counters or the keys: those have their own calls). */
export async function saveLeadSourceSettings(ctx: PluginContext, source: LeadSource): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "lead_sources")}
        SET label = $3, site_id = $4, site_url = $5, status = $6, consent_text = $7, privacy_url = $8, success_message = $9,
            turnstile_site_key = $10, rate_limit_per_hour = $11, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [source.companyId, source.id, source.label, source.siteId, source.siteUrl, source.status, source.consentText, source.privacyUrl, source.successMessage, source.turnstileSiteKey, source.rateLimitPerHour],
  );
}

/** A new public key: the old one keeps working until `until`. A new signing secret replaces the old one at once (a server can re-sign). */
export async function saveRotatedKeys(
  ctx: PluginContext,
  input: { companyId: string; id: string; publicKey: string; previousKey: string; previousKeyUntil: string; signingSecret?: string | null },
): Promise<void> {
  const secret = input.signingSecret !== undefined;
  await ctx.db.execute(
    `UPDATE ${table(ctx, "lead_sources")}
        SET public_key = $3, previous_key = $4, previous_key_until = $5::timestamptz${secret ? ", signing_secret = $6" : ""}, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.id, input.publicKey, input.previousKey, input.previousKeyUntil, ...(secret ? [input.signingSecret ?? null] : [])],
  );
}

/** Replaces a form's signing secret (a person made a new one): the old one stops working at once. The public key is untouched. */
export async function saveSigningSecret(ctx: PluginContext, companyId: string, id: string, signingSecret: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "lead_sources")} SET signing_secret = $3, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, id, signingSecret]);
}

export async function getLeadSource(ctx: PluginContext, companyId: string, id: string): Promise<LeadSource | null> {
  const rows = await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapSource(rows[0]) : null;
}

/**
 * The source a key belongs to: its current key, else a key it was rotated
 * away from (still valid during the grace period). Null for an unknown key.
 */
export async function findLeadSourceByKey(ctx: PluginContext, key: string, now: Date = new Date()): Promise<LeadSource | null> {
  const current = await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE public_key = $1 LIMIT 1`, [key]);
  if (current[0]) return mapSource(current[0]);
  const previous = await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE previous_key = $1 LIMIT 1`, [key]);
  const row = previous[0] ? mapSource(previous[0]) : null;
  if (!row?.previousKeyUntil || Date.parse(row.previousKeyUntil) <= now.getTime()) return null;
  return row;
}

export async function listLeadSources(ctx: PluginContext, companyId: string, scope?: { kind: ClientKind; id: string } | "own"): Promise<LeadSource[]> {
  const rows =
    scope && scope !== "own"
      ? await ctx.db.query<SourceRow>(
        `SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at LIMIT 200`,
        [companyId, scope.kind, scope.id],
      )
      : scope === "own"
        ? await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE company_id = $1 AND client_kind IS NULL ORDER BY created_at LIMIT 200`, [companyId])
        : await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM ${table(ctx, "lead_sources")} WHERE company_id = $1 ORDER BY created_at LIMIT 500`, [companyId]);
  return rows.map(mapSource);
}

/** Counts a submission on its source (accepted, or rejected for a reason a person should see). */
export async function bumpSource(ctx: PluginContext, sourceId: string, accepted: boolean): Promise<void> {
  await ctx.db.execute(
    accepted
      ? `UPDATE ${table(ctx, "lead_sources")} SET accepted_count = accepted_count + 1, last_submission_at = now() WHERE id = $1`
      : `UPDATE ${table(ctx, "lead_sources")} SET rejected_count = rejected_count + 1 WHERE id = $1`,
    [sourceId],
  );
}

/** Removes a canary client's sources and everything they logged. Only the canary cleanup calls this. */
export async function deleteLeadSourcesOf(ctx: PluginContext, companyId: string, kind: ClientKind, clientRef: string): Promise<number> {
  const sources = await listLeadSources(ctx, companyId, { kind, id: clientRef });
  for (const source of sources) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_hits")} WHERE source_id = $1`, [source.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND source_id = $2`, [companyId, source.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_sources")} WHERE company_id = $1 AND id = $2`, [companyId, source.id]);
  }
  return sources.length;
}

/**
 * Everything the lead forms hold for a client that is being deleted: its forms (so the public key stops taking leads), what they
 * logged, and the consent records on the client's own list (the leads they belong to go with the client). Idempotent.
 */
export async function deleteLeadDataOfClient(ctx: PluginContext, companyId: string, kind: ClientKind, clientRef: string): Promise<{ sources: number }> {
  const sources = await deleteLeadSourcesOf(ctx, companyId, kind, clientRef);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, kind, clientRef]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND sender_key = $2`, [companyId, `${kind}:${clientRef}`]);
  return { sources };
}

// ---------------------------------------------------------------------------
// Request log (rate limits)
// ---------------------------------------------------------------------------

export async function recordHit(ctx: PluginContext, sourceId: string, ipHash: string | null, outcome: string): Promise<void> {
  await ctx.db.execute(`INSERT INTO ${table(ctx, "lead_hits")} (id, source_id, ip_hash, outcome) VALUES ($1, $2, $3, $4)`, [randomUUID(), sourceId, ipHash, outcome]);
}

/** How many requests this source answered since `sinceIso` (capped at `cap`: past it the answer is "too many"). */
export async function countHits(ctx: PluginContext, sourceId: string, sinceIso: string, cap: number, ipHash?: string | null): Promise<number> {
  const rows = ipHash
    ? await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "lead_hits")} WHERE source_id = $1 AND ip_hash = $2 AND created_at >= $3::timestamptz LIMIT ${Math.max(1, Math.trunc(cap))}`, [sourceId, ipHash, sinceIso])
    : await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "lead_hits")} WHERE source_id = $1 AND created_at >= $2::timestamptz LIMIT ${Math.max(1, Math.trunc(cap))}`, [sourceId, sinceIso]);
  return rows.length;
}

/**
 * Request-log rows older than `beforeIso` (the hourly job). Pseudonymous addresses are not kept longer than a rate limit needs:
 * the visitor hash on the capture rows goes too (the capture itself stays: it is the lead's record). The hash in a consent record stays: it
 * is the evidence of the consent.
 */
export async function purgeHits(ctx: PluginContext, beforeIso: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_hits")} WHERE created_at < $1::timestamptz`, [beforeIso]);
  await ctx.db.execute(`UPDATE ${table(ctx, "lead_captures")} SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < $1::timestamptz`, [beforeIso]);
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

export interface LeadCaptureRow {
  id: string;
  companyId: string;
  sourceId: string;
  key: string;
  outcome: string;
  contactId: string | null;
  clientKind: ClientKind | null;
  clientRef: string | null;
  attribution: Record<string, unknown>;
  consent: boolean;
  createdAt: string | null;
}

interface CaptureRow {
  id: string;
  company_id: string;
  source_id: string;
  key: string;
  outcome: string;
  contact_id: string | null;
  client_kind: string | null;
  client_ref: string | null;
  attribution: unknown;
  consent: boolean | null;
  created_at: unknown;
}

function mapCapture(row: CaptureRow): LeadCaptureRow {
  return {
    id: row.id,
    companyId: row.company_id,
    sourceId: row.source_id,
    key: row.key,
    outcome: row.outcome,
    contactId: row.contact_id ?? null,
    clientKind: row.client_kind === "company" || row.client_kind === "contact" ? row.client_kind : null,
    clientRef: row.client_ref ?? null,
    attribution: asRecord(row.attribution),
    consent: row.consent === true,
    createdAt: iso(row.created_at),
  };
}

export async function captureByKey(ctx: PluginContext, companyId: string, key: string): Promise<LeadCaptureRow | null> {
  const rows = await ctx.db.query<CaptureRow>(
    `SELECT id, company_id, source_id, key, outcome, contact_id, client_kind, client_ref, attribution, consent, created_at
       FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND key = $2 LIMIT 1`,
    [companyId, key],
  );
  return rows[0] ? mapCapture(rows[0]) : null;
}

/** Records an accepted submission once per key. True when this call recorded it. */
export async function insertCapture(
  ctx: PluginContext,
  input: { companyId: string; sourceId: string; key: string; outcome: string; contactId: string | null; client: { kind: ClientKind; id: string } | null; attribution: Record<string, unknown>; consent: boolean; ipHash: string | null },
): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "lead_captures")}
      (id, company_id, source_id, key, outcome, contact_id, client_kind, client_ref, attribution, consent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
     ON CONFLICT (company_id, key) DO NOTHING`,
    [randomUUID(), input.companyId, input.sourceId, input.key, input.outcome, input.contactId, input.client?.kind ?? null, input.client?.id ?? null, JSON.stringify(input.attribution), input.consent, input.ipHash],
  );
  return (res?.rowCount ?? 0) > 0;
}

/** The capture row of a lead that is being removed with its client. */
export async function deleteCapture(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND key = $2`, [companyId, key]);
}

/** Marks a held capture as stored once the CRM added the lead. */
export async function settleCapture(ctx: PluginContext, companyId: string, key: string, contactId: string | null): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "lead_captures")} SET outcome = 'stored', contact_id = $3 WHERE company_id = $1 AND key = $2`, [companyId, key, contactId]);
}

/** Captures of one source, newest first, for the source's recent-leads view (attribution only: no personal data). */
export async function recentCaptures(ctx: PluginContext, companyId: string, sourceId: string, limit = 20): Promise<LeadCaptureRow[]> {
  const rows = await ctx.db.query<CaptureRow>(
    `SELECT id, company_id, source_id, key, outcome, contact_id, client_kind, client_ref, attribution, consent, created_at
       FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND source_id = $2 ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}`,
    [companyId, sourceId],
  );
  return rows.map(mapCapture);
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface ConsentRow {
  id: string;
  companyId: string;
  senderKey: string;
  subjectKey: string;
  email: string | null;
  contactId: string | null;
  purpose: string;
  basis: string;
  granted: boolean;
  source: string;
  wording: string | null;
  formId: string | null;
  url: string | null;
  policyVersion: string | null;
  ipHash: string | null;
  recordedAt: string;
  expiresAt: string | null;
  recordedBy: string | null;
}

interface ConsentDbRow {
  id: string;
  company_id: string;
  sender_key: string;
  subject_key: string;
  email: string | null;
  contact_id: string | null;
  purpose: string;
  basis: string;
  granted: boolean;
  source: string;
  wording: string | null;
  form_id: string | null;
  url: string | null;
  policy_version: string | null;
  ip_hash: string | null;
  recorded_at: unknown;
  expires_at: unknown;
  recorded_by: string | null;
}

const CONSENT_COLUMNS = `id, company_id, sender_key, subject_key, email, contact_id, purpose, basis, granted, source, wording, form_id, url,
  policy_version, ip_hash, recorded_at, expires_at, recorded_by`;

function mapConsent(row: ConsentDbRow): ConsentRow {
  return {
    id: row.id,
    companyId: row.company_id,
    senderKey: row.sender_key,
    subjectKey: row.subject_key,
    email: row.email ?? null,
    contactId: row.contact_id ?? null,
    purpose: row.purpose,
    basis: row.basis,
    granted: row.granted === true,
    source: row.source,
    wording: row.wording ?? null,
    formId: row.form_id ?? null,
    url: row.url ?? null,
    policyVersion: row.policy_version ?? null,
    ipHash: row.ip_hash ?? null,
    recordedAt: iso(row.recorded_at) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expires_at),
    recordedBy: row.recorded_by ?? null,
  };
}

export async function getConsent(ctx: PluginContext, companyId: string, senderKey: string, subjectKey: string, purpose: string): Promise<ConsentRow | null> {
  const rows = await ctx.db.query<ConsentDbRow>(
    `SELECT ${CONSENT_COLUMNS} FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND sender_key = $2 AND subject_key = $3 AND purpose = $4 LIMIT 1`,
    [companyId, senderKey, subjectKey, purpose],
  );
  return rows[0] ? mapConsent(rows[0]) : null;
}

/** Every consent record of a subject (all senders and purposes), newest first. */
export async function consentsOfSubject(ctx: PluginContext, companyId: string, subjectKey: string): Promise<ConsentRow[]> {
  const rows = await ctx.db.query<ConsentDbRow>(
    `SELECT ${CONSENT_COLUMNS} FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND subject_key = $2 ORDER BY recorded_at DESC LIMIT 50`,
    [companyId, subjectKey],
  );
  return rows.map(mapConsent);
}

/** Inserts or replaces the record for (company, sender, subject, purpose). The caller has already checked the new one is not older. */
export async function putConsent(ctx: PluginContext, row: Omit<ConsentRow, "id"> & { id?: string }): Promise<void> {
  const existing = await getConsent(ctx, row.companyId, row.senderKey, row.subjectKey, row.purpose);
  if (existing) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "consent_records")}
          SET email = $2, contact_id = $3, basis = $4, granted = $5, source = $6, wording = $7, form_id = $8, url = $9, policy_version = $10,
              ip_hash = $11, recorded_at = $12::timestamptz, expires_at = $13::timestamptz, recorded_by = $14, updated_at = now()
        WHERE id = $1`,
      [existing.id, row.email, row.contactId, row.basis, row.granted, row.source, row.wording, row.formId, row.url, row.policyVersion, row.ipHash, row.recordedAt, row.expiresAt, row.recordedBy],
    );
    return;
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "consent_records")}
      (id, company_id, sender_key, subject_key, email, contact_id, purpose, basis, granted, source, wording, form_id, url, policy_version, ip_hash, recorded_at, expires_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz, $18)`,
    [row.id ?? randomUUID(), row.companyId, row.senderKey, row.subjectKey, row.email, row.contactId, row.purpose, row.basis, row.granted, row.source, row.wording, row.formId, row.url, row.policyVersion, row.ipHash, row.recordedAt, row.expiresAt, row.recordedBy],
  );
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * Removes what the lead forms hold about one person: their consent records, the leads of clients that came in through
 * a form, and the capture rows of those leads and of the contact ids given (a capture holds where the lead came from
 * and a keyed hash of the address). For the erasure receiver (kit `registerEraseReceiver`). Contacts, activities and
 * held leads are the CRM's own erasure. Returns the rows removed.
 */
export async function eraseFormData(ctx: PluginContext, companyId: string, email: string, contactIds: readonly string[] = []): Promise<{ consentRecords: number; clientLeads: number; captures: number }> {
  const address = email.trim().toLowerCase();
  if (!address) return { consentRecords: 0, clientLeads: 0, captures: 0 };
  const keys = (await ctx.db.query<{ key: string }>(`SELECT key FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND source = 'form' AND email = $2 LIMIT 1000`, [companyId, address])).map((row) => row.key);
  let captures = 0;
  if (keys.length) {
    const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND key = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, JSON.stringify(keys)]);
    captures += res?.rowCount ?? 0;
  }
  if (contactIds.length) {
    const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND contact_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, JSON.stringify([...contactIds])]);
    captures += res?.rowCount ?? 0;
  }
  const consent = await ctx.db.execute(`DELETE FROM ${table(ctx, "consent_records")} WHERE company_id = $1 AND email = $2`, [companyId, address]);
  const leads = await ctx.db.execute(`DELETE FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND source = 'form' AND email = $2`, [companyId, address]);
  return { consentRecords: consent?.rowCount ?? 0, clientLeads: leads?.rowCount ?? 0, captures };
}
