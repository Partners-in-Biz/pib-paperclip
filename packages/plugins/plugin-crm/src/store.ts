/**
 * Tables added in 0.4.0 (migration 006): client profiles, leads from client
 * channels, held leads and hand-off events. One statement per call, writes
 * only to the CRM namespace, scalar params only (lists go as JSON text).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, asStringList, table } from "./db.js";
import type { ClientKind } from "./refs.js";
import { normalizeServices } from "./services.js";

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Client profiles
// ---------------------------------------------------------------------------

/** How to talk for a client: the original seven fields (what `missing` counts). */
export const CORE_PROFILE_FIELDS = ["brandVoice", "audience", "services", "website", "bookingLink", "bannedWords", "toneNotes"] as const;
/** The brand kit: logo (an R2 key), colours, fonts and examples of the right tone. */
export const BRAND_FIELDS = ["logoKey", "primaryColor", "secondaryColor", "accentColor", "fonts", "toneExamples"] as const;
/** What a proposal for the client starts from: references to the scope template and the standard terms. */
export const PROPOSAL_FIELDS = ["scopeTemplateRef", "termsRef"] as const;
/** The profile fields, as tools and the UI name them. */
export const PROFILE_FIELDS = [...CORE_PROFILE_FIELDS, ...BRAND_FIELDS, ...PROPOSAL_FIELDS] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface ClientProfile {
  brandVoice: string | null;
  audience: string | null;
  /** Keys of the services vocabulary (`services.ts`). */
  services: string[];
  /** What was written as a service but maps to none, kept as text. */
  servicesOther: string[];
  website: string | null;
  bookingLink: string | null;
  bannedWords: string[];
  toneNotes: string | null;
  logoKey: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  fonts: string[];
  toneExamples: string[];
  scopeTemplateRef: string | null;
  termsRef: string | null;
}

export interface ClientProfileRecord extends ClientProfile {
  id: string;
  companyId: string;
  clientKind: ClientKind;
  clientRef: string;
  /** Fields a person set: agents fill them only while empty. */
  humanOwned: ProfileField[];
  updatedBy: string | null;
  updatedAt: string | null;
  /** Null for a row written before the services vocabulary: its services were mapped when it was read. */
  servicesNormalizedAt: string | null;
}

interface ProfileRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  brand_voice: string | null;
  audience: string | null;
  services: unknown;
  website: string | null;
  booking_link: string | null;
  banned_words: unknown;
  tone_notes: string | null;
  human_owned: unknown;
  updated_by: string | null;
  updated_at: unknown;
  logo_key?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  accent_color?: string | null;
  fonts?: unknown;
  tone_examples?: unknown;
  scope_template_ref?: string | null;
  terms_ref?: string | null;
  services_other?: unknown;
  services_normalized_at?: unknown;
}

export const EMPTY_PROFILE: ClientProfile = {
  brandVoice: null,
  audience: null,
  services: [],
  servicesOther: [],
  website: null,
  bookingLink: null,
  bannedWords: [],
  toneNotes: null,
  logoKey: null,
  primaryColor: null,
  secondaryColor: null,
  accentColor: null,
  fonts: [],
  toneExamples: [],
  scopeTemplateRef: null,
  termsRef: null,
};

function mapProfile(row: ProfileRow): ClientProfileRecord {
  // A row from before the vocabulary holds free text: map it on read (the services job saves the mapped form).
  const normalizedAt = iso(row.services_normalized_at);
  const stored = asStringList(row.services);
  const storedOther = asStringList(row.services_other);
  const mapped = normalizedAt ? { services: stored, other: storedOther } : (() => {
    const result = normalizeServices(stored);
    return { services: result.services as string[], other: [...result.other, ...storedOther.filter((item) => !result.other.includes(item))] };
  })();
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "contact" ? "contact" : "company",
    clientRef: row.client_ref,
    brandVoice: row.brand_voice ?? null,
    audience: row.audience ?? null,
    services: mapped.services,
    servicesOther: mapped.other,
    website: row.website ?? null,
    bookingLink: row.booking_link ?? null,
    bannedWords: asStringList(row.banned_words),
    toneNotes: row.tone_notes ?? null,
    logoKey: row.logo_key ?? null,
    primaryColor: row.primary_color ?? null,
    secondaryColor: row.secondary_color ?? null,
    accentColor: row.accent_color ?? null,
    fonts: asStringList(row.fonts),
    toneExamples: asStringList(row.tone_examples),
    scopeTemplateRef: row.scope_template_ref ?? null,
    termsRef: row.terms_ref ?? null,
    humanOwned: asStringList(row.human_owned).filter((field): field is ProfileField => (PROFILE_FIELDS as readonly string[]).includes(field)),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
    servicesNormalizedAt: normalizedAt,
  };
}

const PROFILE_COLUMNS = `id, company_id, client_kind, client_ref, brand_voice, audience, services, website, booking_link,
  banned_words, tone_notes, human_owned, updated_by, updated_at, logo_key, primary_color, secondary_color, accent_color, fonts,
  tone_examples, scope_template_ref, terms_ref, services_other, services_normalized_at`;

export async function getClientProfile(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<ClientProfileRecord | null> {
  const rows = await ctx.db.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS}
       FROM ${table(ctx, "client_profiles")}
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
      LIMIT 1`,
    [companyId, kind, ref],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

/** Every profile of a company (the services job reads them all). */
export async function listClientProfiles(ctx: PluginContext, companyId: string): Promise<ClientProfileRecord[]> {
  const rows = await ctx.db.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS}
       FROM ${table(ctx, "client_profiles")}
      WHERE company_id = $1
      ORDER BY created_at
      LIMIT 2000`,
    [companyId],
  );
  return rows.map(mapProfile);
}

/** Insert or replace the whole profile row (callers merge the patch first). Always saves the services in vocabulary form. */
export async function saveClientProfile(
  ctx: PluginContext,
  input: { companyId: string; clientKind: ClientKind; clientRef: string; profile: ClientProfile; humanOwned: ProfileField[]; updatedBy: string | null },
): Promise<void> {
  const p = input.profile;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_profiles")}
      (id, company_id, client_kind, client_ref, brand_voice, audience, services, website, booking_link, banned_words, tone_notes, human_owned, updated_by, updated_at,
       logo_key, primary_color, secondary_color, accent_color, fonts, tone_examples, scope_template_ref, terms_ref, services_other, services_normalized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12::jsonb, $13, now(),
             $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22::jsonb, now())
     ON CONFLICT (company_id, client_kind, client_ref) DO UPDATE SET
       brand_voice = EXCLUDED.brand_voice, audience = EXCLUDED.audience, services = EXCLUDED.services,
       website = EXCLUDED.website, booking_link = EXCLUDED.booking_link, banned_words = EXCLUDED.banned_words,
       tone_notes = EXCLUDED.tone_notes, human_owned = EXCLUDED.human_owned, updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at, logo_key = EXCLUDED.logo_key, primary_color = EXCLUDED.primary_color,
       secondary_color = EXCLUDED.secondary_color, accent_color = EXCLUDED.accent_color, fonts = EXCLUDED.fonts,
       tone_examples = EXCLUDED.tone_examples, scope_template_ref = EXCLUDED.scope_template_ref, terms_ref = EXCLUDED.terms_ref,
       services_other = EXCLUDED.services_other, services_normalized_at = EXCLUDED.services_normalized_at`,
    [
      randomUUID(),
      input.companyId,
      input.clientKind,
      input.clientRef,
      p.brandVoice,
      p.audience,
      JSON.stringify(p.services),
      p.website,
      p.bookingLink,
      JSON.stringify(p.bannedWords),
      p.toneNotes,
      JSON.stringify(input.humanOwned),
      input.updatedBy,
      p.logoKey,
      p.primaryColor,
      p.secondaryColor,
      p.accentColor,
      JSON.stringify(p.fonts),
      JSON.stringify(p.toneExamples),
      p.scopeTemplateRef,
      p.termsRef,
      JSON.stringify(p.servicesOther),
    ],
  );
}

export async function deleteClientProfile(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<void> {
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "client_profiles")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`,
    [companyId, kind, ref],
  );
}

// ---------------------------------------------------------------------------
// Leads from a client's own channels
// ---------------------------------------------------------------------------

export interface ClientLead {
  key: string;
  clientKind: ClientKind;
  clientRef: string;
  source: string;
  platform: string | null;
  name: string | null;
  handle: string | null;
  email: string | null;
  message: string;
  url: string | null;
  itemId: string | null;
  confidence: number | null;
  capturedAt: string | null;
  /** Public form leads carry a phone, where they came from (`meta`: form, page, UTM tags, consent) and the issue opened for them. */
  phone?: string | null;
  meta?: Record<string, unknown>;
  issueId?: string | null;
}

interface ClientLeadRow {
  key: string;
  client_kind: string;
  client_ref: string;
  source: string;
  platform: string | null;
  name: string | null;
  handle: string | null;
  email: string | null;
  message: string | null;
  url: string | null;
  item_id: string | null;
  confidence: unknown;
  captured_at: unknown;
  phone?: string | null;
  meta?: unknown;
  issue_id?: string | null;
}

function mapClientLead(row: ClientLeadRow): ClientLead {
  return {
    key: row.key,
    clientKind: row.client_kind === "contact" ? "contact" : "company",
    clientRef: row.client_ref,
    source: row.source,
    platform: row.platform ?? null,
    name: row.name ?? null,
    handle: row.handle ?? null,
    email: row.email ?? null,
    message: row.message ?? "",
    url: row.url ?? null,
    itemId: row.item_id ?? null,
    confidence: num(row.confidence),
    capturedAt: iso(row.captured_at),
    phone: row.phone ?? null,
    meta: asRecord(row.meta),
    issueId: row.issue_id ?? null,
  };
}

const CLIENT_LEAD_COLUMNS = "key, client_kind, client_ref, source, platform, name, handle, email, message, url, item_id, confidence, captured_at, phone, meta, issue_id";

/** Stores a client's lead once per key. True when this call stored it. */
export async function insertClientLead(ctx: PluginContext, companyId: string, lead: ClientLead): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_leads")}
      (id, key, company_id, client_kind, client_ref, source, platform, name, handle, email, message, url, item_id, confidence, captured_at, phone, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
     ON CONFLICT (company_id, key) DO NOTHING`,
    [
      randomUUID(),
      lead.key,
      companyId,
      lead.clientKind,
      lead.clientRef,
      lead.source,
      lead.platform,
      lead.name,
      lead.handle,
      lead.email,
      lead.message,
      lead.url,
      lead.itemId,
      lead.confidence,
      lead.capturedAt ?? new Date().toISOString(),
      lead.phone ?? null,
      JSON.stringify(lead.meta ?? {}),
    ],
  );
  return (res?.rowCount ?? 0) > 0;
}

/** Remembers the issue opened for a client's lead (the held-leads job opens one for leads that came in before the settings were saved). */
export async function setClientLeadIssue(ctx: PluginContext, companyId: string, key: string, issueId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "client_leads")} SET issue_id = $3 WHERE company_id = $1 AND key = $2`, [companyId, key, issueId]);
}

export async function getClientLead(ctx: PluginContext, companyId: string, key: string): Promise<ClientLead | null> {
  const rows = await ctx.db.query<ClientLeadRow>(`SELECT ${CLIENT_LEAD_COLUMNS} FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND key = $2 LIMIT 1`, [companyId, key]);
  return rows[0] ? mapClientLead(rows[0]) : null;
}

/** Public form leads of clients that have no issue yet (the settings were not saved when they came in). */
export async function clientLeadsWithoutIssue(ctx: PluginContext, companyId: string, limit = 20): Promise<ClientLead[]> {
  const rows = await ctx.db.query<ClientLeadRow>(
    `SELECT ${CLIENT_LEAD_COLUMNS} FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND source = 'form' AND issue_id IS NULL ORDER BY captured_at LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}`,
    [companyId],
  );
  return rows.map(mapClientLead);
}

/** Companies that hold a form lead of a client without an issue. */
export async function companiesWithClientLeadsWithoutIssue(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "client_leads")} WHERE source = 'form' AND issue_id IS NULL`);
  return [...new Set(rows.map((row) => row.company_id))];
}

export async function listClientLeads(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string, limit = 20): Promise<ClientLead[]> {
  const rows = await ctx.db.query<ClientLeadRow>(
    `SELECT ${CLIENT_LEAD_COLUMNS}
       FROM ${table(ctx, "client_leads")}
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
      ORDER BY captured_at DESC
      LIMIT $4`,
    [companyId, kind, ref, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(mapClientLead);
}

/** One client lead by its key (a lead whose client was deleted: nobody to hand it to). */
export async function deleteClientLeadByKey(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND key = $2`, [companyId, key]);
}

/** Removes a client's onboarding step rows (deleting a client, or the canary cleanup). */
export async function deleteServiceSteps(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "service_onboarding")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, kind, ref]);
}

export async function deleteClientLeads(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<void> {
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`,
    [companyId, kind, ref],
  );
}

// ---------------------------------------------------------------------------
// Held leads (the CRM was off or unsaved when they came in)
// ---------------------------------------------------------------------------

export interface HeldLead {
  key: string;
  companyId: string;
  event: string;
  payload: Record<string, unknown>;
  reason: string;
  attempts: number;
  heldAt: string | null;
}

interface HeldRow {
  key: string;
  company_id: string;
  event: string;
  payload: unknown;
  reason: string;
  attempts: unknown;
  held_at: unknown;
}

/** Holds a lead once per key (the first payload wins). */
export async function holdLead(ctx: PluginContext, input: { companyId: string; key: string; event: string; payload: Record<string, unknown>; reason: string }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "held_leads")} (id, key, company_id, event, payload, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (company_id, key) DO NOTHING`,
    [randomUUID(), input.key, input.companyId, input.event, JSON.stringify(input.payload), input.reason],
  );
}

export async function pendingHeldLeads(ctx: PluginContext, companyId: string, limit = 50): Promise<HeldLead[]> {
  const rows = await ctx.db.query<HeldRow>(
    `SELECT key, company_id, event, payload, reason, attempts, held_at
       FROM ${table(ctx, "held_leads")}
      WHERE company_id = $1 AND processed_at IS NULL
      ORDER BY held_at
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({
    key: row.key,
    companyId: row.company_id,
    event: row.event,
    payload: asRecord(row.payload),
    reason: row.reason,
    attempts: num(row.attempts) ?? 0,
    heldAt: iso(row.held_at),
  }));
}

/** Companies with leads still held. */
export async function heldLeadCompanies(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${table(ctx, "held_leads")} WHERE processed_at IS NULL`,
  );
  return rows.map((row) => row.company_id);
}

export async function heldLeadStats(ctx: PluginContext, companyId: string): Promise<{ count: number; oldest: string | null }> {
  const rows = await ctx.db.query<{ count: unknown; oldest: unknown }>(
    `SELECT count(*)::text AS count, min(held_at)::text AS oldest
       FROM ${table(ctx, "held_leads")}
      WHERE company_id = $1 AND processed_at IS NULL`,
    [companyId],
  );
  return { count: num(rows[0]?.count) ?? 0, oldest: iso(rows[0]?.oldest) };
}

export async function markHeldLeadDone(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "held_leads")} SET processed_at = now(), last_error = NULL WHERE company_id = $1 AND key = $2`,
    [companyId, key],
  );
}

export async function markHeldLeadFailed(ctx: PluginContext, companyId: string, key: string, attempts: number, error: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "held_leads")} SET attempts = $3, last_error = $4 WHERE company_id = $1 AND key = $2`,
    [companyId, key, attempts, error.slice(0, 500)],
  );
}

// ---------------------------------------------------------------------------
// Hand-off events (re-sent for a day: delivery is at most once)
// ---------------------------------------------------------------------------

/** Records a hand-off once per key. True when this call recorded it (so emit it now). */
export async function recordHandoff(ctx: PluginContext, companyId: string, event: string, payload: { key: string } & Record<string, unknown>): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "handoffs")} (id, key, company_id, event, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (company_id, key) DO NOTHING`,
    [randomUUID(), payload.key, companyId, event, JSON.stringify(payload)],
  );
  return (res?.rowCount ?? 0) > 0;
}

export async function recentHandoffs(ctx: PluginContext, companyId: string, hours = 24): Promise<Array<{ key: string; event: string; payload: Record<string, unknown> }>> {
  const rows = await ctx.db.query<{ key: string; event: string; payload: unknown }>(
    `SELECT key, event, payload
       FROM ${table(ctx, "handoffs")}
      WHERE company_id = $1 AND created_at >= now() - make_interval(hours => $2::int)
      ORDER BY created_at
      LIMIT 500`,
    [companyId, hours],
  );
  return rows.map((row) => ({ key: row.key, event: row.event, payload: asRecord(row.payload) }));
}

/** Companies that recorded a hand-off in the last `hours`. */
export async function handoffCompanies(ctx: PluginContext, hours = 24): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${table(ctx, "handoffs")} WHERE created_at >= now() - make_interval(hours => $1::int)`,
    [hours],
  );
  return rows.map((row) => row.company_id);
}

// ---------------------------------------------------------------------------
// Client projects (migration 007), read here so work for a client can open in its own project
// ---------------------------------------------------------------------------

/** The Paperclip projects linked to a client, oldest link first. Client work opens in the first of them (never in our own project). */
export async function clientProjectIds(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<string[]> {
  const rows = await ctx.db.query<{ project_id: string }>(
    `SELECT project_id FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at LIMIT 20`,
    [companyId, kind, ref],
  );
  return rows.map((row) => row.project_id);
}
