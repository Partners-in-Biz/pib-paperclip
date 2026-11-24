/**
 * CRM company and contact cards on a planning canvas (PAR-14416; plan PAR-14389 C.1 and C.2, stage A3).
 *
 * Two kinds for the kit's `registerCanvasCards`: `card-company` and `card-contact`. Each answers from the same
 * readers and the same per-record rule as the CRM page, so a card shows exactly what the page shows the person:
 * - `resolve`: the records of `visibleCrmRecords` (`listAccounts`/`listContacts` + `canSeeRecord` with grants), the
 *   list `crm.client-workspace` reads. Another company's, unknown, deleted and not-allowed ids are left out, so the
 *   kit answers them `{ hidden: true }`.
 * - `search`: `findRecords`, the page's own `crm.find-records`, for the same text and kind. An empty text is no
 *   search (the page refuses it too).
 * - `related`: company to its contacts, contact to its companies, through the visible links (`listLinks`). An `of`
 *   the person cannot see in the CRM answers no group.
 * Every card is ids and text only; `href` is the record's CRM workspace (`/<prefix>/crm?client=company:<id>`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CanvasCardCall, CanvasCardInput, CanvasCardKind } from "@partnersinbiz/pib-plugin-kit";
import type { Viewer } from "./domain.js";
import { findRecords, visibleCrmRecords } from "./lookup.js";
import { CARD_COMPANY, CARD_CONTACT } from "./card-types.js";
import { PLUGIN_ID } from "./namespace.js";
import { companyPrefix, crmLink } from "./refs.js";

/** The person a card call is answered for, with their CRM role (the worker's `viewerFor`). */
export type CardViewerOf = (call: CanvasCardCall) => Promise<Viewer>;

interface CompanyCardFields { id: string; name: string; domain: string | null; lifecycle: string; tags: string[] }
interface ContactCardFields { id: string; name: string; email: string | null; phone: string | null; lifecycle: string; companies: string[] }

const list = (values: string[]) => values.filter(Boolean).join(", ");

export function companyCard(prefix: string | null, row: CompanyCardFields): CanvasCardInput {
  const tags = list(row.tags);
  return {
    id: row.id,
    title: row.name,
    subtitle: row.domain,
    status: row.lifecycle,
    meta: tags ? [{ label: "Tags", value: tags }] : [],
    href: crmLink(prefix, "company", row.id),
  };
}

export function contactCard(prefix: string | null, row: ContactCardFields): CanvasCardInput {
  const meta: Array<{ label: string; value: string }> = [];
  const companies = list(row.companies);
  if (companies) meta.push({ label: "Company", value: companies });
  if (row.phone) meta.push({ label: "Phone", value: row.phone });
  return { id: row.id, title: row.name, subtitle: row.email, status: row.lifecycle, meta, href: crmLink(prefix, "contact", row.id) };
}

type Records = Awaited<ReturnType<typeof visibleCrmRecords>>;

/** The card fields of every visible record, as `findRecords` reads them (first email and phone, linked company names). */
function cardRows(records: Records) {
  const accountName = new Map(records.accounts.map((row) => [row.id, row.name]));
  const companyRow = (row: Records["accounts"][number]): CompanyCardFields => ({ id: row.id, name: row.name, domain: row.domain, lifecycle: row.lifecycle, tags: row.tags });
  const contactRow = (row: Records["contacts"][number]): ContactCardFields => ({
    id: row.id, name: row.name, email: row.emails[0] ?? null, phone: row.phones[0] ?? null, lifecycle: row.lifecycle,
    companies: records.links.filter((link) => link.contactId === row.id).map((link) => accountName.get(link.accountId)).filter((name): name is string => Boolean(name)),
  });
  return { companyRow, contactRow };
}

export function crmCardKinds(ctx: PluginContext, viewerOf: CardViewerOf): CanvasCardKind[] {
  /** What the person may see, loaded once per call, and the link prefix. */
  async function load(call: CanvasCardCall) {
    const viewer = await viewerOf(call);
    const [records, prefix] = await Promise.all([visibleCrmRecords(ctx, viewer), companyPrefix(ctx, viewer.companyId)]);
    return { viewer, records, prefix, ...cardRows(records) };
  }

  async function search(kind: "company" | "contact", q: string, limit: number, call: CanvasCardCall): Promise<CanvasCardInput[]> {
    if (!q.trim()) return [];
    const viewer = await viewerOf(call);
    const found = await findRecords(ctx, viewer, { query: q, kind, limit });
    const prefix = await companyPrefix(ctx, viewer.companyId);
    return found.results.map((row) => (row.kind === "company"
      ? companyCard(prefix, { id: row.id, name: row.name, domain: row.domain ?? null, lifecycle: row.lifecycle, tags: row.tags })
      : contactCard(prefix, { id: row.id, name: row.name, email: row.email ?? null, phone: row.phone ?? null, lifecycle: row.lifecycle, companies: row.companies ?? [] })));
  }

  /** The `of` record when it is a CRM record of `type` the person can see; else null. */
  const crmOf = (of: { plugin: string; type: string; id: string }, type: string) => (of.plugin === PLUGIN_ID && of.type === type ? of.id : null);

  const company: CanvasCardKind = {
    type: CARD_COMPANY,
    async resolve(ids, call) {
      const { records, prefix, companyRow } = await load(call);
      const wanted = new Set(ids);
      return records.accounts.filter((row) => wanted.has(row.id)).map((row) => companyCard(prefix, companyRow(row)));
    },
    search: ({ q, limit }, call) => search("company", q, limit, call),
    // A contact's companies.
    async related({ of }, call) {
      const contactId = crmOf(of, CARD_CONTACT);
      if (!contactId) return [];
      const { records, prefix, companyRow } = await load(call);
      if (!records.contacts.some((row) => row.id === contactId)) return [];
      const ids = new Set(records.links.filter((link) => link.contactId === contactId).map((link) => link.accountId));
      const cards = records.accounts.filter((row) => ids.has(row.id)).map((row) => companyCard(prefix, companyRow(row)));
      return [{ relation: "company", label: "Companies", cards }];
    },
  };

  const contact: CanvasCardKind = {
    type: CARD_CONTACT,
    async resolve(ids, call) {
      const { records, prefix, contactRow } = await load(call);
      const wanted = new Set(ids);
      return records.contacts.filter((row) => wanted.has(row.id)).map((row) => contactCard(prefix, contactRow(row)));
    },
    search: ({ q, limit }, call) => search("contact", q, limit, call),
    // A company's contacts.
    async related({ of }, call) {
      const accountId = crmOf(of, CARD_COMPANY);
      if (!accountId) return [];
      const { records, prefix, contactRow } = await load(call);
      if (!records.accounts.some((row) => row.id === accountId)) return [];
      const ids = new Set(records.links.filter((link) => link.accountId === accountId).map((link) => link.contactId));
      const cards = records.contacts.filter((row) => ids.has(row.id)).map((row) => contactCard(prefix, contactRow(row)));
      return [{ relation: "contact", label: "Contacts", cards }];
    },
  };

  return [company, contact];
}
