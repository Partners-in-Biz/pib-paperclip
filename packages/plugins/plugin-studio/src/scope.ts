/**
 * Whose work is this? Own work has no client; client work belongs to one CRM company or contact. A project the CRM
 * links to a client belongs to that client, so an issue in it can only produce or read that client's assets. An agent
 * handed one client's task can't reach another client's files, and work on a client's issue can't land in own work.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  clientProjectIds,
  clientScopeFromInput,
  formatClientParam,
  listCrmClients,
  MEMBER_RESTRICTED,
  MEMBER_RESTRICTION_UNAVAILABLE,
  resolveCrmClient,
  sameClient,
  type ActingRestriction,
  type ClientScope,
  type CrmClient,
} from "@partnersinbiz/pib-plugin-kit";
import { StudioError } from "./errors.js";

export interface ResolvedScope {
  scope: ClientScope;
  client: CrmClient | null;
}

export const OWN: ResolvedScope = { scope: null, client: null };

/** `undefined`: the params don't say. A value that's there but malformed is an error, never quietly own work. */
export function scopeInput(params: Record<string, unknown>): ClientScope | undefined {
  const scope = clientScopeFromInput(params);
  if (scope !== undefined) return scope;
  const present = ("client" in params && params.client !== undefined) || ("clientRef" in params && params.clientRef !== undefined);
  if (present) throw new StudioError('client must be "company:<id>" or "contact:<id>". Omit it for own work or to use the issue\'s client.', "bad_client");
  return undefined;
}

export async function resolveScope(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ResolvedScope> {
  if (!scope) return OWN;
  const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope).catch(() => null);
  if (!client) throw new StudioError(`Unknown client ${formatClientParam(scope)}: it was deleted in the CRM, or hasn't synced to Studio yet.`, "unknown_client");
  return { scope: { kind: client.kind, id: client.id }, client };
}

/** The client a project is linked to, if any. */
export async function clientOfProject(ctx: PluginContext, companyId: string, projectId: string | null | undefined): Promise<CrmClient | null> {
  if (!projectId) return null;
  const clients = await listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => [] as CrmClient[]);
  for (const client of clients) {
    const linked = await clientProjectIds(ctx, companyId, { kind: client.kind, id: client.id }).catch(() => [] as string[]);
    if (linked.includes(projectId)) return client;
  }
  return null;
}

/** The projects linked to a client, for prefilling a task. Empty when there are none or the CRM can't say. */
export async function projectsOfClient(ctx: PluginContext, companyId: string, client: { kind: "company" | "contact"; id: string }): Promise<string[]> {
  return clientProjectIds(ctx, companyId, client).catch(() => [] as string[]);
}

export interface WorkContext {
  issueId: string | null;
  projectId: string | null;
}

export async function loadIssue(ctx: PluginContext, companyId: string, ref: string): Promise<{ id: string; projectId: string | null }> {
  const issue = await ctx.issues.get(ref, companyId).catch(() => null);
  if (!issue?.id) throw new StudioError(`Issue ${ref} was not found in this company.`, "unknown_issue");
  return { id: String(issue.id), projectId: issue.projectId ? String(issue.projectId) : null };
}

/**
 * The scope for work on a project: what was asked for, or the project's client when nothing was. Asking for anything
 * other than the project's own client is refused.
 */
export async function scopeForWork(ctx: PluginContext, companyId: string, requested: ClientScope | undefined, projectId: string | null): Promise<ResolvedScope> {
  const owner = await clientOfProject(ctx, companyId, projectId);
  if (requested === undefined) return owner ? { scope: { kind: owner.kind, id: owner.id }, client: owner } : OWN;
  if (owner && !sameClient(requested, { kind: owner.kind, id: owner.id })) {
    throw new StudioError(`This work is in ${owner.name}'s project, so it can only use ${owner.name}'s Studio files (client ${formatClientParam({ kind: owner.kind, id: owner.id })}).`, "wrong_client");
  }
  return resolveScope(ctx, companyId, requested);
}

/**
 * The person path's client rule (PAR-14274, plan PAR-14257 G.2): a restricted member gets nothing filed under a
 * client, his own client's included, until Studio can read which clients he may see. Own work stays open to him.
 * When core's answer is missing, client work is refused as core refuses: nothing is signed or reserved.
 */
export function assertOpenToPerson(target: ClientScope, restriction: ActingRestriction): void {
  if (!target || restriction === "unrestricted") return;
  refusePerson(restriction);
}

function refusePerson(restriction: Exclude<ActingRestriction, "unrestricted">): never {
  if (restriction === "restricted") throw new StudioError("Your access in this company doesn't include client work in Studio. Ask a company owner.", MEMBER_RESTRICTED);
  throw new StudioError("Studio couldn't check your access just now, so client work stays closed. Try again in a moment.", MEMBER_RESTRICTION_UNAVAILABLE);
}

/**
 * The client filter a person's list runs with (PAR-14298). A restricted member's list holds own work only, and a filter
 * on one client is refused like that client's row. With core's answer missing the filter stands, and the list is
 * refused only if a client row is in it (`assertListOpen`).
 */
export function personFilter(filter: ClientScope | undefined, restriction: ActingRestriction): ClientScope | undefined {
  if (filter) assertOpenToPerson(filter, restriction);
  return restriction === "restricted" ? null : filter;
}

/** Refuses a person's list that holds a client row when he may not see client work, or when core's answer is missing. */
export function assertListOpen(hasClientRow: boolean, restriction: ActingRestriction): void {
  if (hasClientRow && restriction !== "unrestricted") refusePerson(restriction);
}

/** Refuses when a run working for one client reaches for a file of another scope. */
export async function assertReachable(ctx: PluginContext, companyId: string, target: ClientScope, projectId: string | null): Promise<void> {
  const owner = await clientOfProject(ctx, companyId, projectId);
  if (owner && !sameClient(target, { kind: owner.kind, id: owner.id })) {
    throw new StudioError(`This work is in ${owner.name}'s project, and that file isn't ${owner.name}'s.`, "wrong_client");
  }
}
