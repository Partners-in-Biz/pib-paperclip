/**
 * Record scoping for a limited person (stages B and B2, PAR-12581 / PAR-12582). The guard hands a handler
 * a `linked` decision only under `enforce`; its `companyIds` are the CRM companies the person manages
 * (owner or "Managed by", from the plugin's resolver). A record is his when its client is one of them:
 *
 * - `company:<id>`: the id is in the list;
 * - `contact:<id>`: the contact belongs to one of them in the plugin's CRM copy (`crm_contacts.account_ids`);
 *   a contact that is not in the copy is not his (fail closed);
 * - no client (the company's own work): never his.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientScope } from "../client-ref.js";
import type { AccessCheck } from "./guard.js";

/** One answer for a guessed id and another company's record, so a refusal never tells which it was. */
export const NOT_AMONG_YOUR_COMPANIES = "That was not found among your companies";
/** A limited person always names one of his clients; there is no "every client" or "own work" for him. */
export const NAME_YOUR_COMPANY = "Your access is limited to your own companies: name one of them as the client";

/**
 * The companies a call is limited to, or null for no limit (scope `all`; every call under `off` and `report`).
 * A missing check (an internal call that never went through the guard, such as a job) is not limited.
 */
export function ownCompaniesOf(check: AccessCheck | null | undefined): ReadonlySet<string> | null {
  const decision = check?.decision;
  if (!decision || decision.scope !== "linked") return null;
  return new Set(decision.companyIds);
}

/**
 * Whether `client` is one of `companies`. `namespace` is the plugin's schema, which holds the CRM copy
 * (`registerCrmProjection` with contacts).
 */
export async function isOwnClient(
  ctx: PluginContext,
  namespace: string,
  companyId: string,
  companies: ReadonlySet<string>,
  client: ClientScope,
): Promise<boolean> {
  if (!client || companies.size === 0) return false;
  if (client.kind === "company") return companies.has(client.id);
  const rows = await ctx.db.query<{ account_ids: string[] | null }>(
    `SELECT account_ids FROM ${namespace}.crm_contacts WHERE company_id = $1 AND id = $2 AND deleted = false LIMIT 1`,
    [companyId, client.id],
  );
  return (rows[0]?.account_ids ?? []).some((id) => companies.has(id));
}
