/**
 * Plugin tool access for a linked agent (browser-safe, no host calls).
 *
 * The host keeps ONE `tools:use` grant per agent (unique index on company,
 * principal and permission), and `grants.set` replaces the whole set. So a
 * plugin that links an agent must widen the existing tools grant, never add
 * a second one (the save would fail). Every PiB plugin uses this merge.
 */

import { MEMORY_AGENT_TOOLS } from "./memory.js";

export const PLUGIN_TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };

/**
 * The narrowest grant that lets an agent follow its memory instructions: only
 * the company-memory tools, by exact name (no wildcards: the host treats names
 * as literals). The host enforces `toolNames` (and an `allow` list of
 * `tool:<name>`), so this opens no CRM, billing or payroll tool. Prefer it to
 * `PLUGIN_TOOLS_GRANT` for any agent that does not do module work itself.
 */
export const MEMORY_TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { toolNames: [...MEMORY_AGENT_TOOLS] } };

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
 * Whether a grant scope lets the agent call one plugin tool, as the host decides
 * it (`scopeAllowsTool` in the host's tool-access policy): an empty scope allows
 * everything; an `allow` entry `tool:<name>` allows that tool; otherwise every
 * selector in the scope must match. Only the selectors that can be judged from
 * here are understood (`providerType(s)`, `toolName(s)`); a scope with any other
 * selector (application, connection, risk level...) is reported as NOT allowing
 * the tool, so the answer errs toward "missing", never toward "covered".
 */
export function scopeAllowsTool(scope: Record<string, unknown> | null | undefined, toolName: string, providerType: string = "paperclip_plugin"): boolean {
  if (!scope || Object.keys(scope).length === 0) return true;
  if (listOf(scope.allow).includes(`tool:${toolName}`)) return true;
  for (const key of Object.keys(scope)) {
    if (WIDENING_KEYS.has(key)) continue;
    if (key === "providerType" || key === "providerTypes") continue;
    if (key === "toolName" || key === "toolNames") continue;
    return false;
  }
  const oneProvider = typeof scope.providerType === "string" ? scope.providerType : null;
  const manyProviders = listOf(scope.providerTypes);
  if (oneProvider && oneProvider !== providerType) return false;
  if (manyProviders.length > 0 && !manyProviders.includes(providerType)) return false;
  const oneTool = typeof scope.toolName === "string" ? scope.toolName : null;
  const manyTools = listOf(scope.toolNames);
  if (oneTool && oneTool !== toolName) return false;
  if (manyTools.length > 0 && !manyTools.includes(toolName)) return false;
  return true;
}

/** The tool names none of the agent's `tools:use` grants lets it call (all of `toolNames` when it has no tools grant). */
export function toolsMissing(grants: GrantLike[], toolNames: readonly string[]): string[] {
  const tools = grants.filter((grant) => grant.permissionKey === "tools:use");
  return toolNames.filter((name) => !tools.some((grant) => scopeAllowsTool(grant.scope ?? null, name)));
}

/**
 * The agent's grants with company-memory tool access merged in, and nothing
 * more: no tools grant gets `MEMORY_TOOLS_GRANT`; a grant that already allows
 * the memory tools is left alone; a grant limited to named tools gets the
 * missing memory names added to its list; any other limit (one app, one
 * connection, other provider types) is left alone with `conflict`, because
 * widening it is a person's call.
 */
export function mergeMemoryToolsGrant(existing: GrantLike[], toolNames: readonly string[] = MEMORY_AGENT_TOOLS): MergedGrants {
  const others = existing.filter((grant) => grant.permissionKey !== "tools:use").map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
  const tools = existing.filter((grant) => grant.permissionKey === "tools:use");
  if (tools.length === 0) return { grants: [...others, { permissionKey: "tools:use", scope: { toolNames: [...toolNames] } }], changed: true, conflict: null };
  const kept = tools.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
  const missing = toolsMissing(tools, toolNames);
  if (missing.length === 0) return { grants: [...others, ...kept], changed: false, conflict: null };
  const named = tools.find((grant) => {
    const scope = grant.scope ?? {};
    const selectors = Object.keys(scope).filter((key) => !WIDENING_KEYS.has(key));
    const providers = [...listOf(scope.providerType), ...listOf(scope.providerTypes)];
    return listOf(scope.toolNames).length > 0 && selectors.every((key) => key === "toolNames" || PROVIDER_KEYS.has(key)) && (providers.length === 0 || providers.includes("paperclip_plugin"));
  });
  if (named) {
    const scope = { ...(named.scope ?? {}), toolNames: [...new Set([...listOf(named.scope?.toolNames), ...missing])] };
    return { grants: [...others, { permissionKey: "tools:use", scope }], changed: true, conflict: null };
  }
  return { grants: [...others, ...kept], changed: false, conflict: `The agent's tools grant is limited to ${JSON.stringify(tools[0]!.scope)}, so the memory tools were not added. Add ${missing.join(", ")} to it in the agent's permissions.` };
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
