/**
 * Who social work is for.
 *
 * Own work (PiB's own socials) has no client: `client_ref IS NULL`. Client
 * work belongs to one CRM company or one CRM contact (a sole trader), read
 * from the local CRM projection. Scopes never mix: a post only targets
 * accounts and media of its own scope.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  clientScopeFromInput,
  formatClientParam,
  isClientKind,
  listCrmClients,
  resolveCrmClient,
  sameClient,
  scopeOfRow,
  type ClientKind,
  type ClientScope,
  type CrmClient,
} from "@partnersinbiz/pib-plugin-kit";
import { SocialError } from "./domain.js";

export type { ClientKind, ClientScope, CrmClient };
export { formatClientParam, sameClient, scopeOfRow };

/** Row columns that carry a scope. */
export interface ScopedRow {
  client_kind?: string | null;
  client_ref?: string | null;
  client_name?: string | null;
}

/** A scope with the client's display details (null client = own work). */
export interface ResolvedScope {
  scope: ClientScope;
  client: CrmClient | null;
}

export const OWN: ResolvedScope = { scope: null, client: null };

export async function listClients(ctx: PluginContext, companyId: string): Promise<CrmClient[]> {
  try {
    return await listCrmClients(ctx, ctx.db.namespace, companyId);
  } catch (error) {
    ctx.logger.info("CRM projection unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * The scope named by action/tool params: `client` ("company:<id>",
 * "contact:<id>", {kind,id}, null or "own") or `clientKind` + `clientRef`.
 * `undefined` means the params say nothing about the client. A value that is
 * present but malformed is an error, never silently own work.
 */
export function scopeInput(params: Record<string, unknown>): ClientScope | undefined {
  if (params.clientKind != null && params.clientKind !== "" && !isClientKind(params.clientKind)) {
    throw new SocialError('clientKind must be "company" or "contact"');
  }
  const scope = clientScopeFromInput(params);
  if (scope !== undefined) return scope;
  const present = ("client" in params && params.client !== undefined) || ("clientRef" in params && params.clientRef !== undefined);
  if (present) {
    throw new SocialError('client must be "company:<id>" or "contact:<id>" (or clientKind + clientRef from list-clients). Omit it for own work.');
  }
  return undefined;
}

/** Look the client up in the CRM projection. Unknown or deleted clients are refused. */
export async function resolveScope(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ResolvedScope> {
  if (!scope) return OWN;
  let client: CrmClient | null = null;
  try {
    client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope);
  } catch (error) {
    ctx.logger.info("CRM projection unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  if (!client) {
    throw new SocialError(
      `Unknown client ${formatClientParam(scope)}. It may have been deleted in the CRM, or the CRM has not synced it to Social yet. Use list-clients for valid ids.`,
    );
  }
  return { scope: { kind: client.kind, id: client.id }, client };
}

/** Resolve the scope in params; `fallback` applies when the params name none. */
export async function scopeFromParams(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  fallback: ClientScope = null,
): Promise<ResolvedScope> {
  const input = scopeInput(params);
  return resolveScope(ctx, companyId, input === undefined ? fallback : input);
}

/** Column values for a write. */
export function scopeColumns(target: ResolvedScope): { client_kind: ClientKind | null; client_ref: string | null; client_name: string | null } {
  if (!target.scope) return { client_kind: null, client_ref: null, client_name: null };
  return { client_kind: target.scope.kind, client_ref: target.scope.id, client_name: target.client?.name ?? null };
}

/** The resolved scope a row already holds (name from the row). */
export function rowScope(row: ScopedRow): ResolvedScope {
  const scope = scopeOfRow(row);
  if (!scope) return OWN;
  return { scope, client: { kind: scope.kind, id: scope.id, name: row.client_name ?? scope.id, domain: null, lifecycle: null, email: null } };
}

/** What an OAuth session stores about its scope (in its `extra` jsonb). */
export function sessionScopeExtra(target: ResolvedScope): Record<string, string> {
  if (!target.scope) return {};
  return { clientKind: target.scope.kind, clientRef: target.scope.id, clientName: target.client?.name ?? target.scope.id };
}

/** The scope an OAuth session was started in. Sessions from before contacts carry only `clientRef` (a company). */
export function sessionScope(extra: Record<string, unknown>): ResolvedScope {
  const ref = typeof extra.clientRef === "string" && extra.clientRef ? extra.clientRef : null;
  return rowScope({
    client_ref: ref,
    client_kind: typeof extra.clientKind === "string" ? extra.clientKind : null,
    client_name: typeof extra.clientName === "string" ? extra.clientName : null,
  });
}

export function inScope(row: ScopedRow, scope: ClientScope): boolean {
  return sameClient(scopeOfRow(row), scope);
}

/** Rows also have a `scope` column (org/personal), so tell them apart by the client columns. */
function isResolvedScope(value: ScopedRow | ResolvedScope): value is ResolvedScope {
  return "scope" in value && "client" in value && !("client_ref" in value);
}

/** "own work" or the client's name, for messages. */
export function scopeLabel(row: ScopedRow | ResolvedScope): string {
  if (isResolvedScope(row)) return row.scope ? row.client?.name ?? formatClientParam(row.scope) : "own work";
  return row.client_ref ? row.client_name ?? row.client_ref : "own work";
}

/** The scope as the UI and agents see it on each record. */
export function scopeOut(row: ScopedRow): { client: string | null; clientKind: ClientKind | null; clientRef: string | null; clientName: string | null } {
  const scope = scopeOfRow(row);
  return {
    client: scope ? formatClientParam(scope) : null,
    clientKind: scope?.kind ?? null,
    clientRef: scope?.id ?? null,
    clientName: scope ? row.client_name ?? null : null,
  };
}

/** Issue title prefix for client work: `[Acme] `. */
export function clientPrefix(row: ScopedRow): string {
  return row.client_ref ? `[${row.client_name ?? row.client_ref}] ` : "";
}
