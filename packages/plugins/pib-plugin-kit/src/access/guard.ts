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
 * `enforce` answers a refusal (an action: the 200 refusal form; a tool: a tool
 * `error`; an API route: a 403 with the refusal form). `report` lets the call
 * through. Both report the refusal to Setup.
 *
 * API routes (4.4 "API routes", F26): the plugin registers each route with
 * `apiRoute(routeKey, handler)` and makes `handleApiRequest` its one
 * `onApiRequest`. The route caller is mapped to the form above (`routeCaller`).
 * Under `report` and `enforce` a route key with no `api:` table entry is refused
 * for every caller; under `off` it goes where it went before (the fallback, else
 * a 404). The guard also registers `access.me` (4.6, `./me.ts`).
 */
import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginPerformActionContext, PluginToolDeclaration, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { BYPASS, decideAccess, permissionKey, type Access, type Decision, type PermissionAction } from "../permissions.js";
import { normalizeToolResult } from "../tool-result.js";
import { CANNOT_VERIFY_ACCESS, cachedAccessFor, cachedActingPerson, noteAccessReceived } from "./cache.js";
import { ACCESS_ME_ACTION, allowedKeys, areaKeys, areasOf, type AccessMe } from "./me.js";
import { onAccessReceived } from "./receiver.js";
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
}

export type AccessAllowed = Extract<Decision, { allowed: true }>;
const ALL: AccessAllowed = Object.freeze({ allowed: true, scope: "all" }) as AccessAllowed;

/** Handed to the handler. `decision` is a limit only under `enforce`; otherwise scope `all`. */
export interface AccessCheck {
  mode: AccessMode;
  caller: AccessCaller;
  decision: AccessAllowed;
}

type Verdict = { ok: true; decision: AccessAllowed } | { ok: false; reason: string; userId: string | null };

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
const OWN_COMPANIES = "Your access is limited to your own companies, and this is not yet limited that way";

/**
 * Set on every handler the guard registers, so the registration check (4.5,
 * `./testing.ts`) can tell a guarded registration from a direct one.
 */
export const GUARDED_HANDLER: unique symbol = Symbol.for("partnersinbiz.access.guarded-handler");
const guarded = <T extends object>(handler: T): T => Object.defineProperty(handler, GUARDED_HANDLER, { value: true });

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
  return { type, userId: str(a?.userId), agentId: str(a?.agentId), runId: str(a?.runId) };
}

/**
 * An API route caller in the guard's form (F26: the route says `actorType`).
 * Core only sends a person or an agent here, so there is no `system` route
 * caller: anything else is a person nobody signed in as, and is refused. An
 * agent's person always comes from its run, never from the request.
 */
export function routeCaller(actor: Partial<PluginApiRequestInput["actor"]> | null | undefined): AccessCaller {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (actor?.actorType === "agent") return { type: "agent", userId: null, agentId: str(actor.agentId), runId: str(actor.runId) };
  if (actor?.actorType === "user") return { type: "user", userId: str(actor.userId) ?? str(actor.actorId), agentId: null, runId: str(actor.runId) };
  return { type: "user", userId: null, agentId: null, runId: null };
}

/** A refused API route: 403 with the refusal form, so a page `fetch` does not read it as data. */
export const routeRefusal = (reason: string): PluginApiResponse => ({ status: 403, body: permissionRefusal(reason) });

export const toolCaller = (run: ToolRunContext): AccessCaller => ({
  type: "agent",
  userId: null,
  agentId: run?.agentId || null,
  runId: run?.runId || null,
});

export function createAccessGuard(ctx: PluginContext, options: AccessGuardOptions): AccessGuard {
  const { pluginKey, table } = options;
  const registered = new Set<string>();
  const routes = new Map<string, GuardedApiRoute>();
  const areas = areasOf(pluginKey);
  onAccessReceived(ctx, (companyId) => noteAccessReceived(ctx, companyId));

  /** The caller's access, or why it has none (`unverified`: a read failed). */
  async function accessOf(companyId: string, caller: AccessCaller): Promise<{ access: Access } | { reason: string; userId: string | null; unverified: boolean }> {
    if (caller.type === "system") return { access: BYPASS };
    let userId = caller.userId;
    if (caller.type === "agent") {
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
    return "access" in a ? judgeAccess(a.access, entry) : { ok: false, reason: a.reason, userId: a.userId };
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
    const { mode } = await readAccessSwitch(ctx, companyId, pluginKey, { now: options.now });
    if (mode === "off") return { check: { mode, caller, decision: ALL } };
    const entry = Object.hasOwn(table, key) ? table[key] : undefined;
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
    const { mode } = await readAccessSwitch(ctx, companyId, pluginKey, { now: options.now });
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
          return "refused" in r ? permissionRefusal(r.refused) : handler(params, context, r.check);
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
          return handler(params, run, r.check);
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
      return handler ? handler(input, r.check) : { status: 404, body: { error: "Unknown route" } };
    },
    keys: () => [...registered],
  };
}
