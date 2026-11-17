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
 * `error`). `report` lets the call through. Both report the refusal to Setup.
 */
import type { PluginContext, PluginPerformActionContext, PluginToolDeclaration, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { decideAccess, permissionKey, type Access, type Decision, type PermissionAction } from "../permissions.js";
import { normalizeToolResult } from "../tool-result.js";
import { cachedAccessFor, cachedActingPerson, noteAccessReceived } from "./cache.js";
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

export interface AccessGuard {
  readonly pluginKey: string;
  action(key: string, handler: GuardedAction): void;
  tool(name: string, declaration: ToolDeclaration, handler: GuardedTool): void;
  /** Keys registered through this guard (action keys and `tool:<name>`), for the registration check. */
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
const OWN_COMPANIES = "Your access is limited to your own companies, and this is not yet limited that way";

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

export const toolCaller = (run: ToolRunContext): AccessCaller => ({
  type: "agent",
  userId: null,
  agentId: run?.agentId || null,
  runId: run?.runId || null,
});

export function createAccessGuard(ctx: PluginContext, options: AccessGuardOptions): AccessGuard {
  const { pluginKey, table } = options;
  const registered = new Set<string>();
  onAccessReceived(ctx, (companyId) => noteAccessReceived(ctx, companyId));

  async function verdictFor(companyId: string, entry: AccessTableEntry | undefined, caller: AccessCaller): Promise<Verdict> {
    if (caller.type === "system") return { ok: true, decision: ALL };
    let userId = caller.userId;
    if (caller.type === "agent") {
      if (!caller.agentId || !caller.runId) return { ok: false, reason: NO_RUN, userId: null };
      const run = await cachedActingPerson(ctx, { companyId, agentId: caller.agentId, runId: caller.runId });
      if (!run.ok) return { ok: false, reason: RUN_REASONS[run.reason], userId: null };
      userId = run.userId;
    }
    if (!userId) return { ok: false, reason: "Sign in to continue", userId: null };
    return judgeAccess(await cachedAccessFor(ctx, companyId, userId), entry);
  }

  /** The decision for one call: `refused` means answer the refusal with that reason. */
  async function check(companyId: string | null, key: string, caller: AccessCaller): Promise<{ check: AccessCheck } | { refused: string }> {
    if (!companyId) {
      // Only an instance admin reaches an action with no company (the bridge checks it); there is no switch to read.
      const admin = caller.type === "system" || (caller.type === "user" && caller.userId !== null);
      return admin ? { check: { mode: "off", caller, decision: ALL } } : { refused: "This call names no company" };
    }
    const { mode } = await readAccessSwitch(ctx, companyId, pluginKey, { now: options.now });
    if (mode === "off") return { check: { mode, caller, decision: ALL } };
    const entry = Object.hasOwn(table, key) ? table[key] : undefined;
    let verdict: Verdict;
    try {
      verdict = await verdictFor(companyId, entry, caller);
    } catch {
      verdict = { ok: false, reason: "Cannot verify your access", userId: caller.userId };
    }
    if (verdict.ok) return { check: { mode, caller, decision: mode === "enforce" ? verdict.decision : ALL } };
    const viaAgentId = caller.type === "agent" ? caller.agentId : null;
    await reportAccessRefusal(ctx, mode, { companyId, pluginKey, userId: verdict.userId, key, permission: permissionOf(entry), viaAgentId }, { now: options.now });
    return mode === "enforce" ? { refused: verdict.reason } : { check: { mode, caller, decision: ALL } };
  }

  return {
    pluginKey,
    action(key, handler) {
      registered.add(key);
      ctx.actions.register(key, async (params, context): Promise<unknown | ActionRefusal> => {
        const companyId = context?.companyId ?? context?.actor?.companyId ?? null;
        const r = await check(companyId, key, actionCaller(context));
        return "refused" in r ? permissionRefusal(r.refused) : handler(params, context, r.check);
      });
    },
    tool(name, declaration, handler) {
      const key = `tool:${name}`;
      registered.add(key);
      ctx.tools.register(name, declaration, async (params, run) => {
        const r = await check(run?.companyId || null, key, toolCaller(run));
        if ("refused" in r) {
          return normalizeToolResult({ error: `Access refused: the person this run works for may not do this (${r.refused}). An owner can change it in Setup under People.` });
        }
        return handler(params, run, r.check);
      });
    },
    keys: () => [...registered],
  };
}
