/**
 * Tables added in 0.4.0 (migration 006): client profiles, leads from client
 * channels, held leads and hand-off events. One statement per call, writes
 * only to the CRM namespace, scalar params only (lists go as JSON text).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, asStringList, table } from "./db.js";
import type { ClientKind } from "./refs.js";

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

/** The profile fields, as tools and the UI name them. */
export const PROFILE_FIELDS = ["brandVoice", "audience", "services", "website", "bookingLink", "bannedWords", "toneNotes"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface ClientProfile {
  brandVoice: string | null;
  audience: string | null;
  services: string[];
  website: string | null;
  bookingLink: string | null;
  bannedWords: string[];
  toneNotes: string | null;
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
}

export const EMPTY_PROFILE: ClientProfile = {
  brandVoice: null,
  audience: null,
  services: [],
  website: null,
  bookingLink: null,
  bannedWords: [],
  toneNotes: null,
};

function mapProfile(row: ProfileRow): ClientProfileRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "contact" ? "contact" : "company",
    clientRef: row.client_ref,
    brandVoice: row.brand_voice ?? null,
    audience: row.audience ?? null,
    services: asStringList(row.services),
    website: row.website ?? null,
    bookingLink: row.booking_link ?? null,
    bannedWords: asStringList(row.banned_words),
    toneNotes: row.tone_notes ?? null,
    humanOwned: asStringList(row.human_owned).filter((field): field is ProfileField => (PROFILE_FIELDS as readonly string[]).includes(field)),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  };
}

export async function getClientProfile(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<ClientProfileRecord | null> {
  const rows = await ctx.db.query<ProfileRow>(
    `SELECT id, company_id, client_kind, client_ref, brand_voice, audience, services, website, booking_link,
            banned_words, tone_notes, human_owned, updated_by, updated_at
       FROM ${table(ctx, "client_profiles")}
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
      LIMIT 1`,
    [companyId, kind, ref],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

/** Insert or replace the whole profile row (callers merge the patch first). */
export async function saveClientProfile(
  ctx: PluginContext,
  input: { companyId: string; clientKind: ClientKind; clientRef: string; profile: ClientProfile; humanOwned: ProfileField[]; updatedBy: string | null },
): Promise<void> {
  const p = input.profile;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_profiles")}
      (id, company_id, client_kind, client_ref, brand_voice, audience, services, website, booking_link, banned_words, tone_notes, human_owned, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12::jsonb, $13, now())
     ON CONFLICT (company_id, client_kind, client_ref) DO UPDATE SET
       brand_voice = EXCLUDED.brand_voice, audience = EXCLUDED.audience, services = EXCLUDED.services,
       website = EXCLUDED.website, booking_link = EXCLUDED.booking_link, banned_words = EXCLUDED.banned_words,
       tone_notes = EXCLUDED.tone_notes, human_owned = EXCLUDED.human_owned, updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
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
  };
}

/** Stores a client's lead once per key. True when this call stored it. */
export async function insertClientLead(ctx: PluginContext, companyId: string, lead: ClientLead): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_leads")}
      (id, key, company_id, client_kind, client_ref, source, platform, name, handle, email, message, url, item_id, confidence, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
    ],
  );
  return (res?.rowCount ?? 0) > 0;
}

export async function listClientLeads(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string, limit = 20): Promise<ClientLead[]> {
  const rows = await ctx.db.query<ClientLeadRow>(
    `SELECT key, client_kind, client_ref, source, platform, name, handle, email, message, url, item_id, confidence, captured_at
       FROM ${table(ctx, "client_leads")}
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
      ORDER BY captured_at DESC
      LIMIT $4`,
    [companyId, kind, ref, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(mapClientLead);
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
