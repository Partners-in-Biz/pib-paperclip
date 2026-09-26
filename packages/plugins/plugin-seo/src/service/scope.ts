/**
 * Client scope for tools and actions: parse what the caller sent and resolve
 * a client against the SEO plugin's CRM projection.
 */
import {
  clientScopeFromInput,
  formatClientParam,
  isClientKind,
  resolveCrmClient,
  type ClientRef,
  type ClientScope,
  type CrmClient,
} from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../namespace.js";
import { SeoError, type Env, type Params } from "./common.js";

const present = (value: unknown) => value !== undefined;

/**
 * The scope a tool or action asked for: `undefined` when it said nothing,
 * `null` for Partners in Biz's own sites (`client: null | "" | "own"`), or a
 * CRM company / contact (`client: "company:<id>"`, `{kind, id}`, or the flat
 * `clientKind` + `clientRef` pair). Anything malformed is an error, never a
 * silent widening to "every sprint".
 */
export function scopeParam(params: Params): ClientScope | undefined {
  const kind = params.clientKind;
  if (kind != null && kind !== "" && !isClientKind(kind)) throw new SeoError("clientKind must be company or contact");
  if (present(params.client)) {
    const scope = clientScopeFromInput({ client: params.client });
    if (scope === undefined) throw new SeoError('client must be "company:<CRM company id>", "contact:<CRM contact id>" or "own"');
    return scope;
  }
  if (present(params.clientRef)) {
    const scope = clientScopeFromInput({ clientRef: params.clientRef, clientKind: kind });
    if (scope === undefined) throw new SeoError("clientRef must be a CRM company or contact id");
    return scope;
  }
  if (kind != null && kind !== "") throw new SeoError("clientKind needs clientRef (or pass client)");
  return undefined;
}

/** The CRM client for a client scope, or an error the caller can act on. */
export async function requireClient(env: Env, companyId: string, ref: ClientRef): Promise<CrmClient> {
  const client = await resolveCrmClient(env.ctx, NAMESPACE, companyId, ref);
  if (!client) {
    throw new SeoError(
      `CRM ${ref.kind} ${ref.id} is not in the SEO plugin's client list (deleted, or the CRM has not synced it yet). Check the id with the CRM tools, or ask a person to run CRM resync.`,
    );
  }
  return client;
}

/** A client for the page header; null when the CRM record is unknown. */
export async function findClient(env: Env, companyId: string, ref: ClientRef): Promise<CrmClient | null> {
  try {
    return await resolveCrmClient(env.ctx, NAMESPACE, companyId, ref);
  } catch (error) {
    env.ctx.logger.info("SEO client lookup failed", { client: formatClientParam(ref), error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
