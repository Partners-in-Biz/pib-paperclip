/**
 * Plugin tool access for a linked agent (browser-safe, no host calls).
 *
 * The host keeps ONE `tools:use` grant per agent (unique index on company,
 * principal and permission), and `grants.set` replaces the whole set. So a
 * plugin that links an agent must widen the existing tools grant, never add
 * a second one (the save would fail). Every PiB plugin uses this merge.
 */

export const PLUGIN_TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };

export interface GrantLike {
  permissionKey: string;
  scope: Record<string, unknown> | null;
}

export interface MergedGrants {
  grants: GrantLike[];
  /** The set changed and must be saved with `ctx.authorization.grants.set`. */
  changed: boolean;
  /** Set when the existing tools grant is limited in a way a plugin must not widen; tell a person. */
  conflict: string | null;
}

const PROVIDER_KEYS = new Set(["providerType", "providerTypes"]);
/** Keys that only widen a scope (`allow` entries are OR-ed with the selector). */
const WIDENING_KEYS = new Set(["allow"]);

function listOf(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** True when the scope already lets the agent use every plugin tool. */
export function coversPluginTools(scope: Record<string, unknown> | null | undefined): boolean {
  if (!scope || Object.keys(scope).length === 0) return true;
  const selectors = Object.keys(scope).filter((key) => !WIDENING_KEYS.has(key));
  if (selectors.length === 0) return true;
  if (selectors.some((key) => !PROVIDER_KEYS.has(key))) return false;
  const single = typeof scope.providerType === "string" ? scope.providerType : null;
  const many = listOf(scope.providerTypes);
  return (!single || single === "paperclip_plugin") && (many.length === 0 || many.includes("paperclip_plugin"));
}

/**
 * The agent's grants with plugin tool access merged in:
 * - no tools grant: add `{ providerType: "paperclip_plugin" }`;
 * - unscoped, or already covering plugin tools: unchanged;
 * - limited to other provider types: those plus `paperclip_plugin`;
 * - limited some other way (one app, one connection, named tools): unchanged,
 *   with `conflict` for a person, because widening it would grant more than
 *   someone chose.
 * Several tools rows (impossible on the host) collapse to the widest.
 */
export function mergePluginToolsGrant(existing: GrantLike[]): MergedGrants {
  const others = existing.filter((grant) => grant.permissionKey !== "tools:use").map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
  const tools = existing.filter((grant) => grant.permissionKey === "tools:use");
  if (tools.length === 0) return { grants: [...others, { permissionKey: "tools:use", scope: { ...PLUGIN_TOOLS_GRANT.scope } }], changed: true, conflict: null };
  const current = tools.find((grant) => !grant.scope || Object.keys(grant.scope).length === 0) ?? tools.find((grant) => coversPluginTools(grant.scope)) ?? tools[0]!;
  const collapsed = tools.length > 1;
  if (coversPluginTools(current.scope)) {
    return { grants: [...others, { permissionKey: "tools:use", scope: current.scope ?? null }], changed: collapsed, conflict: null };
  }
  const scope = current.scope ?? {};
  const selectors = Object.keys(scope).filter((key) => !WIDENING_KEYS.has(key));
  if (selectors.every((key) => PROVIDER_KEYS.has(key))) {
    const providers = [...new Set([...listOf(scope.providerType), ...listOf(scope.providerTypes), "paperclip_plugin"])];
    const widened: Record<string, unknown> = { providerTypes: providers };
    if (scope.allow !== undefined) widened.allow = scope.allow;
    return { grants: [...others, { permissionKey: "tools:use", scope: widened }], changed: true, conflict: null };
  }
  return {
    grants: [...others, { permissionKey: "tools:use", scope }],
    changed: collapsed,
    conflict: `The agent's tools grant is limited to ${JSON.stringify(scope)}. Add plugin tools to it (provider type paperclip_plugin) in the agent's permissions.`,
  };
}
