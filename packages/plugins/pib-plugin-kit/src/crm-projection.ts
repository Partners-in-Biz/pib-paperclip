/**
 * CRM projection for other PiB plugins.
 *
 * A plugin may not read another plugin's schema, so the CRM plugin emits
 * `company.*` and `contact.*` events and consumers keep a small local copy.
 * Delivery is at-most-once; CRM re-emits recent changes on a schedule and a
 * `resync` action re-emits everything, so consumers upsert idempotently and
 * ignore events older than what they already hold.
 *
 * Each consumer adds this migration (replace NS with its namespace):
 *
 *   CREATE TABLE NS.crm_companies (
 *     id text PRIMARY KEY, company_id text NOT NULL, name text NOT NULL,
 *     domain text, lifecycle text, updated_at timestamptz NOT NULL, deleted boolean NOT NULL DEFAULT false);
 *   CREATE INDEX crm_companies_company ON NS.crm_companies (company_id, name);
 *   CREATE TABLE NS.crm_contacts (
 *     id text PRIMARY KEY, company_id text NOT NULL, name text NOT NULL,
 *     emails text[] NOT NULL DEFAULT '{}', phones text[] NOT NULL DEFAULT '{}', lifecycle text,
 *     tags text[] NOT NULL DEFAULT '{}', account_ids text[] NOT NULL DEFAULT '{}',
 *     updated_at timestamptz NOT NULL, deleted boolean NOT NULL DEFAULT false);
 *   CREATE INDEX crm_contacts_company ON NS.crm_contacts (company_id, name);
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ClientKind, ClientRef } from "./client-ref.js";

export const CRM_PLUGIN_ID = "partnersinbiz.crm";

/**
 * The host passes query params as JSON, so a JS array is not a Postgres
 * text[]. Send lists as a JSON string and convert in SQL with this fragment.
 */
export function textArrayParam(index: number): string {
  return `ARRAY(SELECT jsonb_array_elements_text($${index}::jsonb))`;
}

function jsonList(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
}

export interface CrmCompanyEvent {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
  updatedAt: string;
}

export interface CrmContactEvent {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  lifecycle: string | null;
  tags: string[];
  accountIds: string[];
  updatedAt: string;
}

export interface CrmCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
}

export interface CrmContactRow {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  lifecycle: string | null;
  tags: string[];
  account_ids: string[];
}

export function registerCrmProjection(
  ctx: PluginContext,
  namespace: string,
  options: { companies?: boolean; contacts?: boolean } = { companies: true, contacts: true },
): void {
  const guard = (label: string, fn: (event: PluginEvent) => Promise<void>) => async (event: PluginEvent) => {
    try {
      await fn(event);
    } catch (error) {
      ctx.logger.info(`CRM projection ${label} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (options.companies !== false) {
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.company.upserted`, guard("company.upserted", async (event) => {
      const p = event.payload as CrmCompanyEvent;
      if (!p?.id || !event.companyId) return;
      await ctx.db.execute(
        `INSERT INTO ${namespace}.crm_companies (id, company_id, name, domain, lifecycle, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, domain = EXCLUDED.domain, lifecycle = EXCLUDED.lifecycle,
           updated_at = EXCLUDED.updated_at, deleted = false
         WHERE ${namespace}.crm_companies.updated_at <= EXCLUDED.updated_at`,
        [p.id, event.companyId, p.name, p.domain ?? null, p.lifecycle ?? null, p.updatedAt],
      );
    }));
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.company.deleted`, guard("company.deleted", async (event) => {
      const p = event.payload as { id?: string };
      if (!p?.id) return;
      await ctx.db.execute(`UPDATE ${namespace}.crm_companies SET deleted = true, updated_at = now() WHERE id = $1`, [p.id]);
    }));
  }
  if (options.contacts !== false) {
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.contact.upserted`, guard("contact.upserted", async (event) => {
      const p = event.payload as CrmContactEvent;
      if (!p?.id || !event.companyId) return;
      await ctx.db.execute(
        `INSERT INTO ${namespace}.crm_contacts (id, company_id, name, emails, phones, lifecycle, tags, account_ids, updated_at, deleted)
         VALUES ($1, $2, $3, ${textArrayParam(4)}, ${textArrayParam(5)}, $6, ${textArrayParam(7)}, ${textArrayParam(8)}, $9, false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, emails = EXCLUDED.emails, phones = EXCLUDED.phones,
           lifecycle = EXCLUDED.lifecycle, tags = EXCLUDED.tags, account_ids = EXCLUDED.account_ids,
           updated_at = EXCLUDED.updated_at, deleted = false
         WHERE ${namespace}.crm_contacts.updated_at <= EXCLUDED.updated_at`,
        [p.id, event.companyId, p.name, jsonList(p.emails), jsonList(p.phones), p.lifecycle ?? null, jsonList(p.tags), jsonList(p.accountIds), p.updatedAt],
      );
    }));
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.contact.deleted`, guard("contact.deleted", async (event) => {
      const p = event.payload as { id?: string };
      if (!p?.id) return;
      await ctx.db.execute(`UPDATE ${namespace}.crm_contacts SET deleted = true, updated_at = now() WHERE id = $1`, [p.id]);
    }));
  }
}

export async function listCrmCompanies(ctx: PluginContext, namespace: string, companyId: string): Promise<CrmCompanyRow[]> {
  return ctx.db.query<CrmCompanyRow>(
    `SELECT id, name, domain, lifecycle FROM ${namespace}.crm_companies WHERE company_id = $1 AND deleted = false ORDER BY lower(name)`,
    [companyId],
  );
}

export async function getCrmCompany(ctx: PluginContext, namespace: string, companyId: string, id: string): Promise<CrmCompanyRow | null> {
  const rows = await ctx.db.query<CrmCompanyRow>(
    `SELECT id, name, domain, lifecycle FROM ${namespace}.crm_companies WHERE company_id = $1 AND id = $2 AND deleted = false`,
    [companyId, id],
  );
  return rows[0] ?? null;
}

export async function listCrmContacts(
  ctx: PluginContext,
  namespace: string,
  companyId: string,
  filter: { tags?: string[]; ids?: string[] } = {},
): Promise<CrmContactRow[]> {
  const where = ["company_id = $1", "deleted = false"];
  const params: unknown[] = [companyId];
  if (filter.tags && filter.tags.length > 0) {
    params.push(jsonList(filter.tags));
    where.push(`tags && ${textArrayParam(params.length)}`);
  }
  if (filter.ids && filter.ids.length > 0) {
    params.push(jsonList(filter.ids));
    where.push(`id = ANY(${textArrayParam(params.length)})`);
  }
  return ctx.db.query<CrmContactRow>(
    `SELECT id, name, emails, phones, lifecycle, tags, account_ids FROM ${namespace}.crm_contacts WHERE ${where.join(" AND ")} ORDER BY lower(name)`,
    params,
  );
}

export async function getCrmContact(ctx: PluginContext, namespace: string, companyId: string, id: string): Promise<CrmContactRow | null> {
  const rows = await listCrmContacts(ctx, namespace, companyId, { ids: [id] });
  return rows[0] ?? null;
}

/** A client as the other plugins show it: a CRM company or a CRM contact. */
export interface CrmClient {
  kind: ClientKind;
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
  email: string | null;
}

/**
 * Looks the client up in the local projection. Returns null when the CRM
 * record is unknown or deleted, so callers can refuse work for it.
 */
export async function resolveCrmClient(ctx: PluginContext, namespace: string, companyId: string, ref: ClientRef): Promise<CrmClient | null> {
  if (ref.kind === "company") {
    const row = await getCrmCompany(ctx, namespace, companyId, ref.id);
    return row ? { kind: "company", id: row.id, name: row.name, domain: row.domain, lifecycle: row.lifecycle, email: null } : null;
  }
  const row = await getCrmContact(ctx, namespace, companyId, ref.id);
  return row ? { kind: "contact", id: row.id, name: row.name, domain: null, lifecycle: row.lifecycle, email: row.emails[0] ?? null } : null;
}

/** Every CRM company and contact, companies first, for "belongs to" pickers. */
export async function listCrmClients(ctx: PluginContext, namespace: string, companyId: string): Promise<CrmClient[]> {
  const [companies, contacts] = await Promise.all([
    listCrmCompanies(ctx, namespace, companyId),
    listCrmContacts(ctx, namespace, companyId),
  ]);
  return [
    ...companies.map((row) => ({ kind: "company" as const, id: row.id, name: row.name, domain: row.domain, lifecycle: row.lifecycle, email: null })),
    ...contacts.map((row) => ({ kind: "contact" as const, id: row.id, name: row.name, domain: null, lifecycle: row.lifecycle, email: row.emails[0] ?? null })),
  ];
}

/** Contacts linked to a CRM company (the people at a client). */
export async function listCrmContactsAtCompany(ctx: PluginContext, namespace: string, companyId: string, crmCompanyId: string): Promise<CrmContactRow[]> {
  return ctx.db.query<CrmContactRow>(
    `SELECT id, name, emails, phones, lifecycle, tags, account_ids FROM ${namespace}.crm_contacts WHERE company_id = $1 AND deleted = false AND $2 = ANY(account_ids) ORDER BY lower(name)`,
    [companyId, crmCompanyId],
  );
}

export function crmProjectionMigration(namespace: string): string {
  return `CREATE TABLE ${namespace}.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_companies_company ON ${namespace}.crm_companies (company_id, name);

CREATE TABLE ${namespace}.crm_contacts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  lifecycle text,
  tags text[] NOT NULL DEFAULT '{}',
  account_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_contacts_company ON ${namespace}.crm_contacts (company_id, name);
`;
}
