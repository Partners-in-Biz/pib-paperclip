/**
 * Every client the Cockpit knows: the CRM's companies and contacts (kit CRM
 * projection, migration 003) plus clients company memory already has facts
 * for. Company memory resolves the client of a task or a **Learned:** line
 * from these names and domains, so a brand-new client's first facts are
 * filed under it instead of company-wide.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseClientParam, type ClientKind } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "./namespace.js";

export interface KnownClient {
  /** `company:<id>` or `contact:<id>`. */
  clientRef: string;
  /** A name (or domain) that names the client in text. */
  clientName: string;
  /** crm-company / crm-contact: from the CRM; memory: only known from saved facts; domain: an alias. */
  source: "crm-company" | "crm-contact" | "memory" | "domain";
}

const T = {
  companies: `${NAMESPACE}.crm_companies`,
  contacts: `${NAMESPACE}.crm_contacts`,
};

/** `https://www.Northwind.co.za/menu` → `northwind.co.za`; null when it is not a domain. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text) && text.length >= 4 ? text : null;
}

/**
 * Contact names match text only when they look like a full name (two words,
 * 5+ characters): a one-word name such as "Sam" would also match agents and
 * everyday words, and file facts under the wrong client.
 */
export function matchableContactName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 5 && /\S\s+\S/.test(trimmed);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.startsWith("{")) {
    // Postgres text[] read back as a string: {a,b}
    return value.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).filter(Boolean);
  }
  return [];
}

export interface CrmClientRow {
  kind: ClientKind;
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string | null;
  /** Contacts: the CRM companies they belong to. */
  accountIds: string[];
}

/** The CRM's live (not deleted) companies and contacts for the company. Empty when the projection has nothing yet. */
export async function crmClients(ctx: PluginContext, companyId: string, limit = 2000): Promise<CrmClientRow[]> {
  const [companies, contacts] = await Promise.all([
    ctx.db.query<Record<string, unknown>>(`SELECT id, name, domain, lifecycle FROM ${T.companies} WHERE company_id = $1 AND deleted = false ORDER BY name LIMIT $2`, [companyId, limit]),
    // Contacts name a client in text only by a full name (see matchableContactName), so only those are read.
    ctx.db.query<Record<string, unknown>>(`SELECT id, name, lifecycle, account_ids FROM ${T.contacts} WHERE company_id = $1 AND deleted = false AND name LIKE $2 ORDER BY name LIMIT $3`, [companyId, "% %", limit]),
  ]);
  return [
    ...companies.map((row) => ({ kind: "company" as const, id: String(row.id), name: String(row.name ?? ""), domain: text(row.domain), lifecycle: text(row.lifecycle), accountIds: [] })),
    ...contacts.map((row) => ({ kind: "contact" as const, id: String(row.id), name: String(row.name ?? ""), domain: null, lifecycle: text(row.lifecycle), accountIds: list(row.account_ids) })),
  ].filter((row) => row.name.trim());
}

/** One CRM client by ref, or null (unknown or deleted). */
export async function crmClient(ctx: PluginContext, companyId: string, ref: string | null | undefined): Promise<CrmClientRow | null> {
  const parsed = ref ? parseClientParam(ref) : null;
  if (!parsed) return null;
  const rows = parsed.kind === "company"
    ? await ctx.db.query<Record<string, unknown>>(`SELECT id, name, domain, lifecycle FROM ${T.companies} WHERE company_id = $1 AND id = $2 AND deleted = false`, [companyId, parsed.id])
    : await ctx.db.query<Record<string, unknown>>(`SELECT id, name, lifecycle, account_ids FROM ${T.contacts} WHERE company_id = $1 AND id = $2 AND deleted = false`, [companyId, parsed.id]);
  const row = rows[0];
  if (!row) return null;
  return { kind: parsed.kind, id: String(row.id), name: String(row.name ?? ""), domain: text(row.domain), lifecycle: text(row.lifecycle), accountIds: list(row.account_ids) };
}

/**
 * The names (and domains) that identify each client in text, companies
 * first so a company wins over one of its people. A contact who belongs to
 * known CRM companies names each of them (sorted by id, so the order never
 * depends on how the CRM listed the links). Memory-only clients (facts saved
 * before the CRM copy existed) come last.
 */
export function knownClientsFrom(crm: CrmClientRow[], memory: Array<{ clientRef: string; clientName: string }>): KnownClient[] {
  const out: KnownClient[] = [];
  const seen = new Set<string>();
  const add = (entry: KnownClient) => {
    const key = `${entry.clientRef}|${entry.clientName.toLowerCase()}`;
    if (seen.has(key) || !entry.clientName.trim()) return;
    seen.add(key);
    out.push(entry);
  };
  const companies = new Set(crm.filter((c) => c.kind === "company").map((c) => c.id));
  for (const row of crm.filter((c) => c.kind === "company")) {
    add({ clientRef: `company:${row.id}`, clientName: row.name.trim(), source: "crm-company" });
  }
  for (const row of crm.filter((c) => c.kind === "company")) {
    const domain = normalizeDomain(row.domain);
    if (domain) add({ clientRef: `company:${row.id}`, clientName: domain, source: "domain" });
  }
  for (const row of crm.filter((c) => c.kind === "contact")) {
    if (!matchableContactName(row.name)) continue;
    // A person who works for several known companies names every one of them: work for them draws on each company's facts.
    const employers = [...new Set(row.accountIds.filter((id) => companies.has(id)))].sort();
    if (employers.length === 0) add({ clientRef: `contact:${row.id}`, clientName: row.name.trim(), source: "crm-contact" });
    for (const employer of employers) add({ clientRef: `company:${employer}`, clientName: row.name.trim(), source: "crm-contact" });
  }
  for (const known of memory) {
    if (!parseClientParam(known.clientRef)) continue;
    add({ clientRef: known.clientRef, clientName: known.clientName, source: "memory" });
  }
  return out;
}

/** Display name per client ref: the CRM name, else the name memory saved. */
export function clientNames(known: KnownClient[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of known) {
    if (entry.source === "domain") continue;
    if (entry.source === "crm-contact" && entry.clientRef.startsWith("company:")) continue;
    if (!names.has(entry.clientRef)) names.set(entry.clientRef, entry.clientName);
  }
  return names;
}
