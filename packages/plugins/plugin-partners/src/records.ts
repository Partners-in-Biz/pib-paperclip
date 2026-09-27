/**
 * Names for shared records on the Partners page (pure, no React, so tests can
 * use it). A grant stores only the record's type and id. The CRM and Billing
 * own the records, so the page asks them with the person's own access (their
 * page actions `crm.load` and `billing.invoice-detail`) and shows
 * "Northwind (company)" with a link, never the id.
 */
import { withClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { recordKind } from "./series.js";

export type SharedKind = "company" | "contact" | "deal" | "invoice";

/** Record names by id, per kind. */
export interface RecordDirectory {
  companies: Map<string, string>;
  contacts: Map<string, string>;
  deals: Map<string, string>;
  invoices: Map<string, string>;
}

export function emptyDirectory(): RecordDirectory {
  return { companies: new Map(), contacts: new Map(), deals: new Map(), invoices: new Map() };
}

/** The plain word for a record kind, as the page shows it: "Northwind (company)". */
export const KIND_WORD: Record<SharedKind, string> = { company: "company", contact: "contact", deal: "deal", invoice: "invoice" };

export function sharedKind(type: string): SharedKind | null {
  const kind = recordKind(type);
  return kind === "company" || kind === "contact" || kind === "deal" || kind === "invoice" ? kind : null;
}

/** The action result itself, or the `{ data }` it came wrapped in. */
function unwrap(body: unknown, key: string): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (key in record) return record;
  const inner = record.data;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
}

function names(list: unknown, label: "name" | "title"): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>).id;
    const value = (row as Record<string, unknown>)[label];
    if (typeof id === "string" && typeof value === "string" && value.trim()) out.set(id, value.trim());
  }
  return out;
}

/** Company, contact and deal names from the CRM's `crm.load` result (plain or wrapped in `{ data }`). */
export function crmDirectory(body: unknown): Pick<RecordDirectory, "companies" | "contacts" | "deals"> {
  const root = unwrap(body, "accounts");
  return {
    companies: names(root?.accounts, "name"),
    contacts: names(root?.contacts, "name"),
    deals: names(root?.deals, "title"),
  };
}

/** An invoice's name from Billing's `billing.invoice-detail`: "NOR-001 · Northwind" (a draft has no number yet). */
export function invoiceName(body: unknown): string | null {
  const root = unwrap(body, "invoice");
  const invoice = root?.invoice;
  if (!invoice || typeof invoice !== "object") return null;
  const { number, customerName } = invoice as { number?: unknown; customerName?: unknown };
  const parts = [typeof number === "string" && number.trim() ? number.trim() : "Draft", typeof customerName === "string" && customerName.trim() ? customerName.trim() : ""].filter(Boolean);
  return parts.join(" · ");
}

/** Where the record lives: the client's CRM workspace, the CRM deals, or Billing's invoices. */
export function recordHref(kind: SharedKind, id: string): string {
  if (kind === "company" || kind === "contact") return withClientParam("/crm", { kind, id });
  if (kind === "deal") return "/crm?tab=deals";
  return "/billing?tab=invoices";
}

export interface RecordLabel {
  /** "Northwind (company)", or "A company (name not available)". */
  text: string;
  name: string | null;
  kind: SharedKind | null;
  kindWord: string;
  href: string | null;
  /** The module that holds it, for the link: "CRM" or "Billing". */
  where: "CRM" | "Billing";
  found: boolean;
}

export function recordLabel(grant: { record_type: string; record_id: string }, directory: RecordDirectory | null): RecordLabel {
  const kind = sharedKind(grant.record_type);
  const kindWord = kind ? KIND_WORD[kind] : "record";
  const map = !directory || !kind
    ? undefined
    : kind === "company" ? directory.companies : kind === "contact" ? directory.contacts : kind === "deal" ? directory.deals : directory.invoices;
  const name = map?.get(grant.record_id) ?? null;
  return {
    text: name ? `${name} (${kindWord})` : `A ${kindWord} (name not available)`,
    name,
    kind,
    kindWord,
    href: kind ? recordHref(kind, grant.record_id) : null,
    where: kind === "invoice" ? "Billing" : "CRM",
    found: Boolean(name),
  };
}

/** Which lookups a set of grants needs: the CRM once, Billing once per invoice (capped). */
export function lookupsFor(grants: Array<{ record_type: string; record_id: string }>, maxInvoices = 20): { crm: boolean; invoiceIds: string[] } {
  const kinds = grants.map((grant) => ({ kind: sharedKind(grant.record_type), id: grant.record_id }));
  const invoiceIds = [...new Set(kinds.filter((row) => row.kind === "invoice").map((row) => row.id))].slice(0, maxInvoices);
  return { crm: kinds.some((row) => row.kind === "company" || row.kind === "contact" || row.kind === "deal"), invoiceIds };
}
