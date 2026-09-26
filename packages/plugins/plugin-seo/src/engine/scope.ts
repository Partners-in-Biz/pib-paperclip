/**
 * Who a sprint is for. Pure and browser-safe: the page and the worker share it.
 *
 * A sprint with no client is Partners in Biz's own site. A client sprint
 * belongs to one CRM company or one CRM contact (a sole trader).
 */
import {
  formatClientParam,
  sameClient,
  withClientParam,
  type ClientKind,
  type ClientScope,
} from "@partnersinbiz/pib-plugin-kit/client-ref";

export interface SprintClientFields {
  clientKind: ClientKind | null;
  clientRef: string | null;
}

export function sprintScope(sprint: SprintClientFields): ClientScope {
  return sprint.clientRef ? { kind: sprint.clientKind ?? "company", id: sprint.clientRef } : null;
}

/** `company:<id>` / `contact:<id>`, or null for own work: what tools and URLs take as `client`. */
export function scopeParamValue(scope: ClientScope): string | null {
  return scope ? formatClientParam(scope) : null;
}

/**
 * When a page scoped to `requested` opens a sprint that belongs elsewhere,
 * the scope to reopen it in. Null when the sprint is already in scope.
 */
export function scopeRedirect(requested: ClientScope, actual: ClientScope): { client: string | null } | null {
  return sameClient(requested, actual) ? null : { client: scopeParamValue(actual) };
}

/** The SEO page path for a sprint (and tab) in its own scope. */
export function sprintPagePath(base: string, sprintId: string | null, scope: ClientScope, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (sprintId) params.set("sprint", sprintId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return withClientParam(`${base}${query ? `?${query}` : ""}`, scope);
}
