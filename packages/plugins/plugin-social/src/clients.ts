/** Clients are CRM companies, read from the local CRM projection. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCrmCompany, listCrmCompanies, type CrmCompanyRow } from "@partnersinbiz/pib-plugin-kit";
import { SocialError } from "./domain.js";

export async function listClients(ctx: PluginContext, companyId: string): Promise<CrmCompanyRow[]> {
  try {
    return await listCrmCompanies(ctx, ctx.db.namespace, companyId);
  } catch (error) {
    ctx.logger.info("CRM projection unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Resolve a client reference. `undefined` leaves the value unchanged, `null`
 * or "" clears it, an id must exist in the CRM projection.
 */
export async function resolveClient(
  ctx: PluginContext,
  companyId: string,
  clientRef: unknown,
): Promise<{ clientRef: string | null; clientName: string | null } | undefined> {
  if (clientRef === undefined) return undefined;
  if (clientRef === null || clientRef === "") return { clientRef: null, clientName: null };
  if (typeof clientRef !== "string") throw new SocialError("clientRef must be a CRM company id");
  const row = await getCrmCompany(ctx, ctx.db.namespace, companyId, clientRef.trim());
  if (!row) throw new SocialError("Unknown client. Use list-clients (CRM companies) and pass its id as clientRef.");
  return { clientRef: row.id, clientName: row.name };
}
