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
import type { CrmSiteEvent } from "./client-sites.js";

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

/** A company's billing details as the CRM holds them. Opt-in through `companyBilling`. */
export type CrmCompanyBilling = {
  email: string | null;
  phone: string | null;
  address: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
};

export interface CrmCompanyEvent {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
  updatedAt: string;
  billing?: CrmCompanyBilling | null;
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
  billing?: CrmCompanyBilling | null;
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
  options: {
    companies?: boolean;
    contacts?: boolean;
    /** Also keep `billing` on crm_companies; the consumer adds a `billing jsonb` column itself. */
    companyBilling?: boolean;
  } = { companies: true, contacts: true },
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
      if (options.companyBilling === true) {
        await ctx.db.execute(
          `INSERT INTO ${namespace}.crm_companies (id, company_id, name, domain, lifecycle, updated_at, deleted, billing)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7::jsonb)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, domain = EXCLUDED.domain, lifecycle = EXCLUDED.lifecycle,
             updated_at = EXCLUDED.updated_at, deleted = false, billing = EXCLUDED.billing
           WHERE ${namespace}.crm_companies.updated_at <= EXCLUDED.updated_at`,
          [p.id, event.companyId, p.name, p.domain ?? null, p.lifecycle ?? null, p.updatedAt, JSON.stringify(p.billing ?? null)],
        );
        return;
      }
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

export async function getCrmCompany(
  ctx: PluginContext,
  namespace: string,
  companyId: string,
  id: string,
  options: { billing?: boolean } = {},
): Promise<CrmCompanyRow | null> {
  const columns = options.billing === true ? "id, name, domain, lifecycle, billing" : "id, name, domain, lifecycle";
  const rows = await ctx.db.query<CrmCompanyRow>(
    `SELECT ${columns} FROM ${namespace}.crm_companies WHERE company_id = $1 AND id = $2 AND deleted = false`,
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

// ---------------------------------------------------------------------------
// Client websites (CRM `site.upserted` / `site.deleted`)
// ---------------------------------------------------------------------------

/**
 * A consumer that needs client websites adds `crmSiteProjectionMigration(NS)`
 * as a new migration and calls `registerCrmSiteProjection`. The projection
 * never holds the Connector key: Connector calls go through the CRM's tools.
 */
export interface CrmSiteRow {
  id: string;
  client_kind: ClientKind;
  client_ref: string;
  label: string | null;
  url: string;
  platform: string;
  seo_plugin: string | null;
  hosting: string | null;
  access: string[];
  project_id: string | null;
  connector_status: string;
  connector_version: string | null;
  connector_seen_at: unknown;
}

export function registerCrmSiteProjection(ctx: PluginContext, namespace: string): void {
  const guard = (label: string, fn: (event: PluginEvent) => Promise<void>) => async (event: PluginEvent) => {
    try {
      await fn(event);
    } catch (error) {
      ctx.logger.info(`CRM site projection ${label} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.site.upserted`, guard("site.upserted", async (event) => {
    const p = event.payload as CrmSiteEvent;
    if (!p?.id || !p.url || !event.companyId) return;
    await ctx.db.execute(
      `INSERT INTO ${namespace}.crm_sites
         (id, company_id, client_kind, client_ref, label, url, platform, seo_plugin, hosting, access, project_id,
          connector_status, connector_version, connector_seen_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${textArrayParam(10)}, $11, $12, $13, $14, $15, false)
       ON CONFLICT (id) DO UPDATE SET client_kind = EXCLUDED.client_kind, client_ref = EXCLUDED.client_ref, label = EXCLUDED.label,
         url = EXCLUDED.url, platform = EXCLUDED.platform, seo_plugin = EXCLUDED.seo_plugin, hosting = EXCLUDED.hosting,
         access = EXCLUDED.access, project_id = EXCLUDED.project_id, connector_status = EXCLUDED.connector_status,
         connector_version = EXCLUDED.connector_version, connector_seen_at = EXCLUDED.connector_seen_at,
         updated_at = EXCLUDED.updated_at, deleted = false
       WHERE ${namespace}.crm_sites.updated_at <= EXCLUDED.updated_at`,
      [
        p.id,
        event.companyId,
        p.clientKind === "contact" ? "contact" : "company",
        p.clientRef,
        p.label ?? null,
        p.url,
        p.platform,
        p.seoPlugin ?? null,
        p.hosting ?? null,
        jsonList(p.access),
        p.projectId ?? null,
        p.connectorStatus ?? "none",
        p.connectorVersion ?? null,
        p.connectorSeenAt ?? null,
        p.updatedAt,
      ],
    );
  }));
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.site.deleted`, guard("site.deleted", async (event) => {
    const p = event.payload as { id?: string };
    if (!p?.id) return;
    await ctx.db.execute(`UPDATE ${namespace}.crm_sites SET deleted = true, updated_at = now() WHERE id = $1`, [p.id]);
  }));
}

const SITE_COLUMNS = "id, client_kind, client_ref, label, url, platform, seo_plugin, hosting, access, project_id, connector_status, connector_version, connector_seen_at";

/** A client's websites, oldest first. */
export async function listCrmSites(ctx: PluginContext, namespace: string, companyId: string, ref: ClientRef): Promise<CrmSiteRow[]> {
  return ctx.db.query<CrmSiteRow>(
    `SELECT ${SITE_COLUMNS} FROM ${namespace}.crm_sites
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND deleted = false
      ORDER BY url`,
    [companyId, ref.kind, ref.id],
  );
}

export async function getCrmSite(ctx: PluginContext, namespace: string, companyId: string, id: string): Promise<CrmSiteRow | null> {
  const rows = await ctx.db.query<CrmSiteRow>(
    `SELECT ${SITE_COLUMNS} FROM ${namespace}.crm_sites WHERE company_id = $1 AND id = $2 AND deleted = false`,
    [companyId, id],
  );
  return rows[0] ?? null;
}

export function crmSiteProjectionMigration(namespace: string): string {
  return `CREATE TABLE ${namespace}.crm_sites (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  label text,
  url text NOT NULL,
  platform text NOT NULL,
  seo_plugin text,
  hosting text,
  access text[] NOT NULL DEFAULT '{}',
  project_id text,
  connector_status text NOT NULL DEFAULT 'none',
  connector_version text,
  connector_seen_at timestamptz,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_sites_client ON ${namespace}.crm_sites (company_id, client_kind, client_ref);
`;
}
