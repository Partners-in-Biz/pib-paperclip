/**
 * The clients of a person limited to his own companies (access stage B2, PAR-15210). The guard hands a handler his
 * companies (the CRM companies he owns or is on "Managed by" for) only under `enforce`, for a `scoped` row. His
 * clients are those companies and the CRM contacts that belong to one of them (`crm_contacts.account_ids`, the kit's
 * `isOwnClient` rule read once per call). Own work (no client) is never his. A failed read throws: no records.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { scopeOfRow, type ScopedRow } from "./clients.js";

export interface OwnClients {
  readonly companies: ReadonlySet<string>;
  readonly contacts: ReadonlySet<string>;
}

/** His clients for a call limited to `companies`; null (no limit) when the call is not limited. */
export async function ownClientsFor(ctx: PluginContext, companyId: string, companies: ReadonlySet<string> | null): Promise<OwnClients | null> {
  if (!companies) return null;
  if (companies.size === 0) return { companies, contacts: new Set() };
  // The host JSON-encodes params: the list goes in as a JSON array.
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${ctx.db.namespace}.crm_contacts
      WHERE company_id = $1 AND deleted = false AND account_ids && ARRAY(SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify([...companies])],
  );
  return { companies, contacts: new Set(rows.map((row) => row.id)) };
}

/** Whether a client is one of his. Own work (null) and a missing client are not. */
export function ownsScope(own: OwnClients, scope: ClientScope | undefined): boolean {
  if (!scope) return false;
  return scope.kind === "company" ? own.companies.has(scope.id) : own.contacts.has(scope.id);
}

/** Whether a record (post, account, media, inbox item...) belongs to one of his clients. */
export function ownsRow(own: OwnClients, row: ScopedRow): boolean {
  return ownsScope(own, scopeOfRow(row));
}
