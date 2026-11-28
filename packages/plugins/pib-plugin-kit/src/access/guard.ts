/**
 * The access guard (PAR-12578 plan, 4.4). Wraps the registration of a plugin's
 * actions and tools; it does not change what a handler does.
 *
 * Under the switch `off`, or with no row, every call goes to the handler with no
 * lookup beyond the one switch read. Under `report` and `enforce` the caller is
 * decided by these rules:
 *
 * | caller                                            | decision                          |
 * |---------------------------------------------------|-----------------------------------|
 * | no company on the call                            | signed-in person or system pass (the bridge only lets an instance admin call without one); else refused |
 * | system (the host itself)                          | pass                              |
 * | person: owner, admin, local board                 | pass                              |
 * | person: limited                                   | grant + table entry + scope rule  |
 * | agent, run found, its person owner or admin       | pass                              |
 * | agent, run found, its person limited              | as if he had called himself       |
 * | agent, run found, no person on it                 | refused                           |
 * | agent, run not found / ended / read fails         | refused                           |
 * | agent with no `runId`                             | refused                           |
 *
 * The acting person from the host (PAR-12608 4.10, H3). A core that sends
 * `onBehalfOfUserId` on the caller has already decided who the call works for
 * (a run's person, a long-lived key's person, a connection's person), so the
 * guard uses that person and never looks a run id up:
 *
 * | caller, host sent the fields                      | decision                          |
 * |---------------------------------------------------|-----------------------------------|
 * | agent, `onBehalfOfUserId` set (with or without run) | as if that person had called    |
 * | agent, `onBehalfOfUserId` null                    | refused (no run / no person)      |
 * | person                                            | as above (his own id)             |
 * | `onBehalfOfRestricted` and no company row          | refused, even with the switch absent |
 *
 * Without the fields (a core older than H3) everything stays as in the first table.
 *
 * `enforce` answers a refusal (an action: the 200 refusal form; a tool: a tool
 * `error`; an API route: a 403 with the refusal form). `report` lets the call
 * through. Both report the refusal to Setup.
 *
 * API routes (4.4 "API routes", F26): the plugin registers each route with
 * `apiRoute(routeKey, handler)` and makes `handleApiRequest` its one
 * `onApiRequest`. The route caller is mapped to the form above (`routeCaller`).
 * Under `report` and `enforce` a route key with no `api:` table entry is refused
 * for every caller; under `off` it goes where it went before (the fallback, else
 * a 404). The guard also registers `access.me` (4.6, `./me.ts`) and, in every
 * plugin but Setup, the receiver of Setup's `access.updated` (4.2, `./receiver.ts`).
 */
import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginPerformActionContext, PluginToolDeclaration, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { BYPASS, decideAccess, permissionKey, type Access, type Decision, type PermissionAction } from "../permissions.js";
import { normalizeToolResult } from "../tool-result.js";
import { hostActingPerson, type HostActingPerson } from "./acting-person.js";
import { CANNOT_VERIFY_ACCESS, cachedAccessFor, cachedActingPerson, noteAccessReceived } from "./cache.js";
import { ACCESS_ME_ACTION, allowedKeys, areaKeys, areasOf, type AccessMe } from "./me.js";
import { SETUP_PLUGIN } from "../setup.js";
import { onAccessReceived, registerAccessReceiver } from "./receiver.js";
import { permissionRefusal, type ActionRefusal } from "./refusal.js";
import { reportAccessRefusal } from "./report.js";
import { readAccessSwitch, type AccessMode } from "./switch.js";

export const ADMIN_ONLY = "ADMIN_ONLY";
/** Open to every active member; the reason is written in the table. */
export interface AnyMemberEntry {
  anyMember: string;
}
export const ANY_MEMBER = (reason: string): AnyMemberEntry => ({ anyMember: reason });
/** `scoped: true` only once the handler filters its records by the decision's companies (stages B, B2). */
export interface PermissionEntry {
  resource: string;
  action: PermissionAction;
  scoped?: true;
}
export type AccessTableEntry = PermissionEntry | typeof ADMIN_ONLY | AnyMemberEntry;
/** Keyed by action key, `api:<routeKey>` or `tool:<name>`. */
export type AccessTable = Readonly<Record<string, AccessTableEntry>>;

export interface AccessCaller {
  type: "user" | "agent" | "system";
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  /** The acting person the host sent (H3); absent from a core older than H3. */
  onBehalfOf?: HostActingPerson;
}

export type AccessAllowed = Extract<Decision, { allowed: true }>;
const ALL: AccessAllowed = Object.freeze({ allowed: true, scope: "all" }) as AccessAllowed;

/** Handed to the handler. `decision` is a limit only under `enforce`; otherwise scope `all`. */
export interface AccessCheck {
  mode: AccessMode;
  caller: AccessCaller;
  decision: AccessAllowed;
}

type Verdict = { ok: true; decision: AccessAllowed; userId?: string | null } | { ok: false; reason: string; userId: string | null };

export type GuardedAction = (params: Record<string, unknown>, context: PluginPerformActionContext, check: AccessCheck) => Promise<unknown>;
export type GuardedTool = (params: unknown, run: ToolRunContext, check: AccessCheck) => Promise<ToolResult>;
type ToolDeclaration = Pick<PluginToolDeclaration, "displayName" | "description" | "parametersSchema">;
export type GuardedApiRoute = (input: PluginApiRequestInput, check: AccessCheck) => Promise<PluginApiResponse>;

export interface AccessGuard {
  readonly pluginKey: string;
  action(key: string, handler: GuardedAction): void;
  tool(name: string, declaration: ToolDeclaration, handler: GuardedTool): void;
  /** Registers the handler of one API route; its table key is `api:<routeKey>`. */
  apiRoute(routeKey: string, handler: GuardedApiRoute): void;
  /**
   * The plugin's `onApiRequest`. `fallback` gets a key with no registered handler
   * (today's behaviour, Billing's grant route); without one such a key answers 404.
   */
  handleApiRequest(input: PluginApiRequestInput, fallback?: GuardedApiRoute): Promise<PluginApiResponse>;
  /**
   * Keys registered through this guard (action keys, `api:<routeKey>`, `tool:<name>`),
   * for the registration check. The guard's own `access.me` is not one of them.
   */
  keys(): string[];
}

export interface AccessGuardOptions {
  pluginKey: string;
  table: AccessTable;
  /** Clock for the switch and the report, for tests. */
  now?: () => number;
  /**
   * The CRM companies this person manages (stage B, PAR-12581). When set, a `linked`
   * decision under `enforce` carries this list instead of the grant's `linkedCompanyIds`:
   * the CRM is the source of a person's own companies. A read that throws refuses the
   * call. The CRM answers from its own tables, the other plugins from their CRM copy
   * (`listManagedCrmCompanyIds`).
   */
  linkedCompanies?: (companyId: string, userId: string) => Promise<string[]>;
}

const RUN_REASONS = {
  "not-found": "The run of this call was not found",
  ended: "The run of this call has ended",
  "no-person": "The run of this call names no person",
  "read-failed": "Cannot verify the run of this call",
} as const;
const NO_RUN = "This agent call has no run, so the person it works for is unknown";
const NOT_OPEN = "This is not open to limited members";
const UNKNOWN_ROUTE = "This route is not in the plugin's access table";
const NO_ROW = "Your access is restricted, and this app has no access settings for this company yet";
const OWN_COMPANIES = "Your access is limited to your own companies, and this is not yet limited that way";

/**
 * Set on every handler the guard registers, so the registration check (4.5,
 * `./testing.ts`) can tell a guarded registration from a direct one.
 */
export const GUARDED_HANDLER: unique symbol = Symbol.for("partnersinbiz.access.guarded-handler");
const guarded = <T extends object>(handler: T): T => Object.defineProperty(handler, GUARDED_HANDLER, { value: true });

/**
 * Test seam for the access test helper (4.5 items 4 to 6, `./testing.ts`), by
 * plugin key. Only that helper sets one, and only while it runs; with none set
 * the guard behaves exactly as without this seam.
 */
export interface GuardProbe {
  /** Answers instead of the plugin's handler when the guard lets a call through. */
  reached(key: string, check: AccessCheck): unknown;
  /** Keys the guard treats as missing from the table. */
  hidden: ReadonlySet<string>;
}
const PROBES = Symbol.for("partnersinbiz.access.guard-probes");
export function guardProbes(): Map<string, GuardProbe> {
  const g = globalThis as { [PROBES]?: Map<string, GuardProbe> };
  return (g[PROBES] ??= new Map());
}

export function permissionOf(entry: AccessTableEntry | undefined): string | null {
  if (entry === undefined) return null;
  if (entry === ADMIN_ONLY) return ADMIN_ONLY;
  return "anyMember" in entry ? "ANY_MEMBER" : permissionKey(entry.resource, entry.action);
}

/** What a verified person may do with one table entry, with the scope rule. */
export function judgeAccess(access: Access, entry: AccessTableEntry | undefined): Verdict {
  if (access.bypass) return { ok: true, decision: ALL };
  if (access.reason) return { ok: false, reason: access.reason, userId: access.userId };
  if (entry === undefined || entry === ADMIN_ONLY) return { ok: false, reason: entry ? "Only an owner or admin can do this" : NOT_OPEN, userId: access.userId };
  if ("anyMember" in entry) return { ok: true, decision: ALL };
  const d = decideAccess(access, entry.resource, entry.action);
  if (!d.allowed) return { ok: false, reason: d.reason, userId: access.userId };
  if (d.scope === "linked" && entry.scoped !== true) return { ok: false, reason: OWN_COMPANIES, userId: access.userId };
  return { ok: true, decision: d };
}

/**
 * An action caller in the guard's form (F3). Like the sdk's worker host, an
 * unknown or missing actor type is the host itself (`system`): the host always
 * sends the actor it authenticated, and a caller cannot set it.
 */
export function actionCaller(context: PluginPerformActionContext | undefined): AccessCaller {
  const a = context?.actor;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const type = a?.type === "agent" || a?.type === "user" ? a.type : "system";
  return withHostPerson({ type, userId: str(a?.userId), agentId: str(a?.agentId), runId: str(a?.runId) }, a);
}

/** Adds the host's acting person when the host sent one (never to `system`: the host itself has none). */
function withHostPerson(caller: AccessCaller, raw: Parameters<typeof hostActingPerson>[0]): AccessCaller {
  const host = caller.type === "system" ? null : hostActingPerson(raw);
  return host ? { ...caller, onBehalfOf: host } : caller;
}

/**
 * An API route caller in the guard's form (F26: the route says `actorType`).
 * Core only sends a person or an agent here, so there is no `system` route
 * caller: anything else is a person nobody signed in as, and is refused. An
 * agent's person always comes from its run, never from the request.
 */
export function routeCaller(actor: Partial<PluginApiRequestInput["actor"]> | null | undefined): AccessCaller {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (actor?.actorType === "agent") return withHostPerson({ type: "agent", userId: null, agentId: str(actor.agentId), runId: str(actor.runId) }, actor);
  if (actor?.actorType === "user") return withHostPerson({ type: "user", userId: str(actor.userId) ?? str(actor.actorId), agentId: null, runId: str(actor.runId) }, actor);
  return { type: "user", userId: null, agentId: null, runId: null };
}

/** A refused API route: 403 with the refusal form, so a page `fetch` does not read it as data. */
export const routeRefusal = (reason: string): PluginApiResponse => ({ status: 403, body: permissionRefusal(reason) });

export const toolCaller = (run: ToolRunContext): AccessCaller =>
  withHostPerson({ type: "agent", userId: null, agentId: run?.agentId || null, runId: run?.runId || null }, run);

export function createAccessGuard(ctx: PluginContext, options: AccessGuardOptions): AccessGuard {
  const { pluginKey, table } = options;
  const registered = new Set<string>();
  const routes = new Map<string, GuardedApiRoute>();
  const areas = areasOf(pluginKey);
  const probe = () => guardProbes().get(pluginKey);
  onAccessReceived(ctx, (companyId) => noteAccessReceived(ctx, companyId));
  // Every guarded plugin keeps its copy of Setup's row (4.2; PAR-15008: no plugin called
  // this itself, so nothing ever confirmed). Setup is the source: it reads `access_settings`
  // and counts itself confirmed, so it runs no receiver.
  if (pluginKey !== SETUP_PLUGIN) registerAccessReceiver(ctx, pluginKey);

  /** The caller's access, or why it has none (`unverified`: a read failed). */
  async function accessOf(companyId: string, caller: AccessCaller): Promise<{ access: Access } | { reason: string; userId: string | null; unverified: boolean }> {
    if (caller.type === "system") return { access: BYPASS };
    let userId = caller.userId;
    const host = caller.onBehalfOf;
    if (host?.userId) {
      // H3: core computed the person (and checked a run a long-lived key names, H5); no run lookup.
      userId = host.userId;
    } else if (host && caller.type === "agent") {
      return { reason: caller.runId ? RUN_REASONS["no-person"] : NO_RUN, userId: null, unverified: false };
    } else if (caller.type === "agent") {
      if (!caller.agentId || !caller.runId) return { reason: NO_RUN, userId: null, unverified: false };
      const run = await cachedActingPerson(ctx, { companyId, agentId: caller.agentId, runId: caller.runId });
      if (!run.ok) return { reason: RUN_REASONS[run.reason], userId: null, unverified: run.reason === "read-failed" };
      userId = run.userId;
    }
    if (!userId) return { reason: "Sign in to continue", userId: null, unverified: false };
    return { access: await cachedAccessFor(ctx, companyId, userId) };
  }

  async function verdictFor(companyId: string, entry: AccessTableEntry | undefined, caller: AccessCaller): Promise<Verdict> {
    const a = await accessOf(companyId, caller);
    if (!("access" in a)) return { ok: false, reason: a.reason, userId: a.userId };
    const verdict = judgeAccess(a.access, entry);
    return verdict.ok ? { ...verdict, userId: a.access.userId } : verdict;
  }

  /** Under `enforce`, a `linked` decision gets the person's companies from the plugin's resolver (stage B). */
  async function withLinkedCompanies(companyId: string, verdict: Extract<Verdict, { ok: true }>): Promise<Verdict> {
    const resolve = options.linkedCompanies;
    if (!resolve || verdict.decision.scope !== "linked") return verdict;
    if (!verdict.userId) return { ok: false, reason: CANNOT_VERIFY_ACCESS, userId: null };
    try {
      const ids = [...new Set(await resolve(companyId, verdict.userId))].filter((id) => typeof id === "string" && id !== "");
      return { ...verdict, decision: Object.freeze({ allowed: true, scope: "linked", companyIds: ids }) as AccessAllowed };
    } catch {
      return { ok: false, reason: CANNOT_VERIFY_ACCESS, userId: verdict.userId };
    }
  }

  /**
   * The decision for one call: `refused` means answer the refusal with that reason.
   * `strictKey` (API routes): a key with no table entry is refused under `report` too.
   */
  async function check(companyId: string | null, key: string, caller: AccessCaller, strictKey = false): Promise<{ check: AccessCheck } | { refused: string }> {
    if (!companyId) {
      // Only an instance admin reaches an action with no company (the bridge checks it); there is no switch to read.
      const admin = caller.type === "system" || (caller.type === "user" && caller.userId !== null);
      return admin ? { check: { mode: "off", caller, decision: ALL } } : { refused: "This call names no company" };
    }
    const { mode, source } = await readAccessSwitch(ctx, companyId, pluginKey, { now: options.now });
    if (mode === "off") {
      if (!(source === "absent" && caller.onBehalfOf?.restricted)) return { check: { mode, caller, decision: ALL } };
      // H3: core enforces this person's restriction, and this plugin has no row to decide by.
      const userId = caller.onBehalfOf.userId;
      await reportAccessRefusal(ctx, "enforce", { companyId, pluginKey, userId, key, permission: null, viaAgentId: caller.type === "agent" ? caller.agentId : null }, { now: options.now });
      return { refused: NO_ROW };
    }
    const entry = Object.hasOwn(table, key) && !probe()?.hidden.has(key) ? table[key] : undefined;
    const viaAgentId = caller.type === "agent" ? caller.agentId : null;
    if (strictKey && entry === undefined) {
      await reportAccessRefusal(ctx, mode, { companyId, pluginKey, userId: caller.userId, key, permission: null, viaAgentId }, { now: options.now });
      return { refused: UNKNOWN_ROUTE };
    }
    let verdict: Verdict;
    try {
      verdict = await verdictFor(companyId, entry, caller);
    } catch {
      verdict = { ok: false, reason: CANNOT_VERIFY_ACCESS, userId: caller.userId };
    }
    // Only `enforce` hands a limit to the handler, so only then is the list read.
    if (verdict.ok && mode === "enforce") verdict = await withLinkedCompanies(companyId, verdict);
    if (verdict.ok) return { check: { mode, caller, decision: mode === "enforce" ? verdict.decision : ALL } };
    await reportAccessRefusal(ctx, mode, { companyId, pluginKey, userId: verdict.userId, key, permission: permissionOf(entry), viaAgentId }, { now: options.now });
    return mode === "enforce" ? { refused: verdict.reason } : { check: { mode, caller, decision: ALL } };
  }

  /** `access.me` for one caller. A read that failed keeps the page open: the guard still refuses behind it. */
  async function accessMe(companyId: string | null, caller: AccessCaller): Promise<AccessMe | ActionRefusal> {
    const every = () => areaKeys(areas);
    if (!companyId) {
      const admin = caller.type === "system" || (caller.type === "user" && caller.userId !== null);
      return admin ? { mode: "off", open: true, permissions: every() } : permissionRefusal("This call names no company");
    }
    const { mode, source } = await readAccessSwitch(ctx, companyId, pluginKey, { now: options.now });
    if (mode === "off" && source === "absent" && caller.onBehalfOf?.restricted) return { mode, open: false, permissions: [] };
    if (mode !== "enforce") return { mode, open: true, permissions: every() };
    let a: Awaited<ReturnType<typeof accessOf>>;
    try {
      a = await accessOf(companyId, caller);
    } catch {
      a = { reason: CANNOT_VERIFY_ACCESS, userId: null, unverified: true };
    }
    if (!("access" in a)) return { mode, open: a.unverified, permissions: [] };
    if (a.access.reason === CANNOT_VERIFY_ACCESS) return { mode, open: true, permissions: [] };
    const permissions = allowedKeys(a.access, areas);
    return { mode, open: permissions.length > 0, permissions };
  }

  ctx.actions.register(
    ACCESS_ME_ACTION,
    guarded(async (_params, context) => accessMe(context?.companyId ?? context?.actor?.companyId ?? null, actionCaller(context))),
  );

  return {
    pluginKey,
    action(key, handler) {
      registered.add(key);
      ctx.actions.register(
        key,
        guarded(async (params: Record<string, unknown>, context: PluginPerformActionContext): Promise<unknown | ActionRefusal> => {
          const companyId = context?.companyId ?? context?.actor?.companyId ?? null;
          const r = await check(companyId, key, actionCaller(context));
          if ("refused" in r) return permissionRefusal(r.refused);
          const p = probe();
          return p ? p.reached(key, r.check) : handler(params, context, r.check);
        }),
      );
    },
    tool(name, declaration, handler) {
      const key = `tool:${name}`;
      registered.add(key);
      ctx.tools.register(
        name,
        declaration,
        guarded(async (params: unknown, run: ToolRunContext) => {
          const r = await check(run?.companyId || null, key, toolCaller(run));
          if ("refused" in r) {
            return normalizeToolResult({ error: `Access refused: the person this run works for may not do this (${r.refused}). An owner can change it in Setup under People.` });
          }
          const p = probe();
          return p ? (p.reached(key, r.check) as ToolResult) : handler(params, run, r.check);
        }),
      );
    },
    apiRoute(routeKey, handler) {
      registered.add(`api:${routeKey}`);
      routes.set(routeKey, handler);
    },
    async handleApiRequest(input, fallback) {
      const companyId = typeof input?.companyId === "string" && input.companyId.trim() ? input.companyId : null;
      // Core answers 400 before a route without a company reaches the plugin; this is the fail-closed backstop.
      if (!companyId) return routeRefusal("This call names no company");
      const r = await check(companyId, `api:${input.routeKey}`, routeCaller(input.actor), true);
      if ("refused" in r) return routeRefusal(r.refused);
      const handler = routes.get(input.routeKey) ?? fallback;
      const p = probe();
      if (p && handler) return p.reached(`api:${input.routeKey}`, r.check) as PluginApiResponse;
      return handler ? handler(input, r.check) : { status: 404, body: { error: "Unknown route" } };
    },
    keys: () => [...registered],
  };
}
