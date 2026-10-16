/**
 * Publishes CRM companies and contacts to the other PiB plugins.
 *
 * Other plugins may not read this schema, so they keep a projection fed by
 * `plugin.partnersinbiz.crm.{company,contact}.{upserted,deleted}` events
 * (deletes are hand-offs, re-sent hourly for a day: see handoffs.ts).
 * Event delivery is at-most-once, so changes are emitted right after a
 * mutation, again by a 15-minute job for the last 30 minutes, nightly in
 * full, and on demand through the `crm.resync` action. Consumers upsert
 * idempotently and keep the newest `updatedAt`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CrmCompanyEvent, CrmContactEvent } from "@partnersinbiz/pib-plugin-kit";
import { asStringList, table } from "./db.js";
import { sendHandoff } from "./handoffs.js";

interface CompanyEventRow {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
  billing_email: string | null;
  phone: string | null;
  address: string | null;
  vat_number: string | null;
  registration_number: string | null;
  updated_at: unknown;
}

interface ContactEventRow {
  id: string;
  name: string;
  emails: unknown;
  phones: unknown;
  lifecycle: string | null;
  tags: unknown;
  account_ids: unknown;
  updated_at: unknown;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function companyEvent(row: CompanyEventRow): CrmCompanyEvent {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain ?? null,
    lifecycle: row.lifecycle ?? null,
    updatedAt: iso(row.updated_at),
    billing: {
      email: row.billing_email ?? null,
      phone: row.phone ?? null,
      address: row.address ?? null,
      vatNumber: row.vat_number ?? null,
      registrationNumber: row.registration_number ?? null,
    },
  };
}

export function contactEvent(row: ContactEventRow): CrmContactEvent {
  return {
    id: row.id,
    name: row.name,
    emails: asStringList(row.emails),
    phones: asStringList(row.phones),
    lifecycle: row.lifecycle ?? null,
    tags: asStringList(row.tags),
    accountIds: asStringList(row.account_ids),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Emit companies and contacts changed in the last `sinceSeconds` seconds, or
 * everything when `sinceSeconds` is null. Returns counts.
 */
export async function emitChanges(
  ctx: PluginContext,
  companyId: string,
  sinceSeconds: number | null,
): Promise<{ companies: number; contacts: number }> {
  const since = sinceSeconds == null ? null : Math.max(1, Math.floor(sinceSeconds));
  const companies = await ctx.db.query<CompanyEventRow>(
    `SELECT id, name, domain, lifecycle, billing_email, phone, address, vat_number, registration_number, updated_at
       FROM ${table(ctx, "companies")}
      WHERE company_id = $1 AND ($2::int IS NULL OR updated_at > now() - make_interval(secs => $2::int))
      ORDER BY updated_at`,
    [companyId, since],
  );
  const contacts = await ctx.db.query<ContactEventRow>(
    `SELECT c.id, c.name, c.emails, c.phones, c.lifecycle, c.tags, c.updated_at,
            COALESCE(jsonb_agg(l.account_id) FILTER (WHERE l.account_id IS NOT NULL), '[]'::jsonb) AS account_ids
       FROM ${table(ctx, "contacts")} c
       LEFT JOIN ${table(ctx, "contact_companies")} l ON l.contact_id = c.id
      WHERE c.company_id = $1 AND ($2::int IS NULL OR c.updated_at > now() - make_interval(secs => $2::int))
      GROUP BY c.id
      ORDER BY c.updated_at`,
    [companyId, since],
  );
  for (const row of companies) await ctx.events.emit("company.upserted", companyId, companyEvent(row));
  for (const row of contacts) await ctx.events.emit("contact.upserted", companyId, contactEvent(row));
  return { companies: companies.length, contacts: contacts.length };
}

/** A merged-away contact. Recorded as a hand-off so it is re-sent for a day (delivery is at most once). */
export async function emitContactDeleted(ctx: PluginContext, companyId: string, contactId: string): Promise<void> {
  await sendHandoff(ctx, companyId, "contact.deleted", { key: `contact:${contactId}:deleted`, id: contactId });
}

/** Every Paperclip company that has CRM rows. Jobs use this instead of companies.list. */
export async function crmCompanyIds(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT company_id FROM ${table(ctx, "companies")}
     UNION
     SELECT company_id FROM ${table(ctx, "contacts")}`,
  );
  return rows.map((row) => row.company_id);
}

/** Touch a contact so the next emit carries its new company links. */
export async function touchContact(ctx: PluginContext, contactId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "contacts")} SET updated_at = now() WHERE id = $1`, [contactId]);
}

/** Tools and actions that change companies, contacts, or their links. */
export const CRM_MUTATIONS = new Set([
  "create-company",
  "update-company",
  "create-contact",
  "update-contact",
  "link-contact",
  "merge-contacts",
  "import-contacts",
  "bulk-tag-contacts",
  "crm.create-company",
  "crm.update-company",
  "crm.create-contact",
  "crm.update-contact",
  "crm.link-contact",
  "crm.set-human-owned",
  "crm.delete-company",
  // The canary client is a real record while it exists: share it, and its removal, with the other modules.
  "create-canary-client",
  "crm.create-canary-client",
  "cleanup-canary",
  "crm.cleanup-canary",
  // A won deal makes its client a customer: share the new lifecycle now.
  "move-deal",
  "crm.move-deal",
  "update-deal",
  "crm.update-deal",
]);
