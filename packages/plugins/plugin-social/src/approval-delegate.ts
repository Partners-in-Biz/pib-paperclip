/**
 * The delegated approver of a scope (PAR-9561).
 *
 * A person may name one agent per scope whose yes counts as the owner's
 * sign-off, after the Reviewer passed the post. This module is the only place
 * that knows where that choice lives and when it may act. It grants nothing on
 * its own: the page action (person only) writes it, and the approve tool checks
 * it again on every call.
 *
 * Storage: one company-scoped state value (`social-approval` / `delegates`), a
 * map from scope key (`own`, `company:<id>`) to `{ agentId, setBy, setAt }`.
 * One value, not a key per scope, because plugin state has no list call.
 *
 * Fail closed everywhere:
 * - a failed read means no delegate (a person approves), logged once a minute;
 * - a write whose read fails refuses and writes nothing, and every write is
 *   read back and refused unless the stored entry is what was asked;
 * - the allowlist (`delegatableScopes`, host settings form only) is empty on a
 *   failed read, and a scope that leaves it loses its delegate at once.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readCompanyRoles, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { getPolicyStrict, scopeKeyOf, type ApprovalPolicy, type PolicyDelegate } from "./approval-policy.js";
import { readDelegatableScopes } from "./config.js";
import { SocialError } from "./domain.js";
import { agentStatusActive } from "./issues.js";

export interface DelegateEntry {
  agentId: string;
  /** The person who named the delegate. */
  setBy: string;
  /** ISO time it was set. */
  setAt: string;
}

export type DelegateMap = Record<string, DelegateEntry>;

/** Where a post or a request sits. `personal` is a person's own post: never delegatable. */
export type DelegateScope = ClientScope | "personal";

/** What `delegateBlockers` needs to know about the agent. `null`: not found. */
export interface DelegateAgent {
  id: string;
  companyId: string;
  status: string | null;
}

export interface DelegateFacts {
  companyId: string;
  scope: DelegateScope;
  /** The scope's policy; `null` when it could not be read. */
  policy: Pick<ApprovalPolicy, "requireOwner" | "requireClient"> | null;
  /** The agent; `null` when it does not exist or could not be read. */
  agent: DelegateAgent | null;
  /** The configured Reviewer (not only a running one); `undefined` when the roles could not be read. */
  configuredReviewerId: string | null | undefined;
  /** `delegatableScopes` from the host settings form. */
  allowlist: string[];
}

export const DELEGATE_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "social-approval", stateKey: "delegates" });

export function delegateScopeKey(scope: DelegateScope): string {
  return scope === "personal" ? "personal" : scopeKeyOf(scope);
}

/** Lower case for the id part, so a stored key and an allowlist key compare equal. */
function normalKey(key: string): string {
  return key.toLowerCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryOf(value: unknown): DelegateEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.agentId !== "string" || !v.agentId || typeof v.setBy !== "string" || typeof v.setAt !== "string") return null;
  return { agentId: v.agentId, setBy: v.setBy, setAt: v.setAt };
}

/** The stored map, shape-checked (malformed entries dropped). Throws when the state cannot be read. */
async function readMapStrict(ctx: PluginContext, companyId: string): Promise<DelegateMap> {
  const raw = await ctx.state.get(DELEGATE_STATE(companyId));
  const out: DelegateMap = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = entryOf(value);
      if (entry) out[normalKey(key)] = entry;
    }
  }
  return out;
}

let readErrorLoggedAt = 0;

function logReadError(ctx: PluginContext, companyId: string, error: unknown, now = Date.now()): void {
  if (now - readErrorLoggedAt < 60_000) return;
  readErrorLoggedAt = now;
  ctx.logger.warn("Social delegated approvers unreadable; a person approves", { companyId, error: errorText(error) });
}

/** Every delegate of the company. Never throws: an unreadable state is no delegates. */
export async function listDelegates(ctx: PluginContext, companyId: string): Promise<DelegateMap> {
  try {
    return await readMapStrict(ctx, companyId);
  } catch (error) {
    logReadError(ctx, companyId, error);
    return {};
  }
}

/** The scope's stored delegate, or null. Never throws: an unreadable state means no delegate. */
export async function getDelegate(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<DelegateEntry | null> {
  return (await listDelegates(ctx, companyId))[normalKey(delegateScopeKey(scope))] ?? null;
}

/** The scope's stored delegate, or null. Throws (a SocialError) when the state cannot be read: the policy lock refuses then. */
export async function getDelegateStrict(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<DelegateEntry | null> {
  return (await readForWrite(ctx, companyId))[normalKey(delegateScopeKey(scope))] ?? null;
}

/**
 * Q8: the autonomy ladder is off in a scope with a stored delegate (set, even if it may not act now), so the
 * delegate decides every post there. `unreadable`: the store could not be read; callers treat it as delegated.
 */
export async function ladderDelegation(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<"delegated" | "unreadable" | null> {
  try {
    return (await readMapStrict(ctx, companyId))[normalKey(delegateScopeKey(scope))] ? "delegated" : null;
  } catch (error) {
    logReadError(ctx, companyId, error);
    return "unreadable";
  }
}

/**
 * Q10, the no-edit rule: an agent that is the stored delegate of a post's scope, or of the scope the post is
 * moved to, cannot change a post it did not create there (text, media, accounts, time or scope). Otherwise it could
 * write the text it then approves. Persons and the post's own creator are not checked; a personal scope never has
 * a delegate. Fail closed: an unreadable store refuses the change.
 */
export async function assertDelegateNotEditing(
  ctx: PluginContext,
  viewer: { companyId: string; agentId: string | null; isAgent: boolean },
  post: { created_by_agent_id: string | null },
  scopes: DelegateScope[],
): Promise<void> {
  if (!viewer.isAgent || !viewer.agentId || post.created_by_agent_id === viewer.agentId) return;
  const keys = scopes.filter((s) => s !== "personal").map((s) => normalKey(delegateScopeKey(s)));
  if (keys.length === 0) return;
  let map: DelegateMap;
  try {
    map = await readMapStrict(ctx, viewer.companyId);
  } catch (error) {
    throw new SocialError(`The delegated approvers could not be read, so this post was not changed. Try again. (${errorText(error)})`);
  }
  const own = keys.find((key) => map[key]?.agentId === viewer.agentId);
  if (own) {
    throw new SocialError(
      `You are the delegated approver of ${own}, so you cannot change a post another agent or a person created there. Approve it with approve-post-as-delegate, or send it back with notes with return-post-as-delegate.`,
    );
  }
}

async function readForWrite(ctx: PluginContext, companyId: string): Promise<DelegateMap> {
  try {
    return await readMapStrict(ctx, companyId);
  } catch (error) {
    throw new SocialError(`The delegated approvers could not be read, so nothing was changed. Try again. (${errorText(error)})`);
  }
}

async function readBack(ctx: PluginContext, companyId: string): Promise<DelegateMap> {
  try {
    return await readMapStrict(ctx, companyId);
  } catch (error) {
    throw new SocialError(`The delegated approver was saved but could not be read back. Check the page before relying on it. (${errorText(error)})`);
  }
}

/**
 * Names `agentId` the scope's delegate. Checks nothing about the agent: the
 * caller runs `delegateBlockers` first. Returns the stored map.
 */
export async function setDelegate(ctx: PluginContext, companyId: string, scope: DelegateScope, agentId: string, byUserId: string, now: Date = new Date()): Promise<DelegateMap> {
  if (!agentId || !byUserId) throw new SocialError("A delegated approver needs an agent and the person who names it.");
  const key = normalKey(delegateScopeKey(scope));
  const current = await readForWrite(ctx, companyId);
  const entry: DelegateEntry = { agentId, setBy: byUserId, setAt: now.toISOString() };
  await ctx.state.set(DELEGATE_STATE(companyId), { ...current, [key]: entry });
  const stored = await readBack(ctx, companyId);
  const got = stored[key];
  if (!got || got.agentId !== entry.agentId || got.setBy !== entry.setBy || got.setAt !== entry.setAt) {
    throw new SocialError("The delegated approver did not save (another change may have crossed it). Reload and try again.");
  }
  ctx.logger.info("Social delegated approver set", { companyId, scope: key, agentId, by: byUserId });
  return stored;
}

/** Removes the scope's delegate. Returns the stored map. */
export async function clearDelegate(ctx: PluginContext, companyId: string, scope: DelegateScope, byUserId: string): Promise<DelegateMap> {
  const key = normalKey(delegateScopeKey(scope));
  const current = await readForWrite(ctx, companyId);
  const { [key]: removed, ...rest } = current;
  await ctx.state.set(DELEGATE_STATE(companyId), rest);
  const stored = await readBack(ctx, companyId);
  if (stored[key]) throw new SocialError("The delegated approver is still set (the change did not save). Reload and try again.");
  ctx.logger.info("Social delegated approver cleared", { companyId, scope: key, agentId: removed?.agentId ?? null, by: byUserId });
  return stored;
}

/**
 * Why this agent cannot be (or stop being) the scope's delegate. Empty: it may.
 * Pure. Every unknown input is a reason, so a failed read refuses.
 */
export function delegateBlockers(facts: DelegateFacts): string[] {
  const reasons: string[] = [];
  const { scope, policy, agent, configuredReviewerId } = facts;
  if (scope === "personal") reasons.push("A personal post cannot have a delegated approver.");
  else if (scope?.kind === "contact") reasons.push("A contact's scope cannot have a delegated approver. Own brands only.");
  if (scope !== "personal" && !facts.allowlist.map(normalKey).includes(normalKey(delegateScopeKey(scope)))) {
    reasons.push("This scope is not on the delegatable scopes list in the Social settings (an instance admin saves it).");
  }
  if (!policy) reasons.push("The approval policy could not be read.");
  else {
    if (policy.requireClient) reasons.push("This scope asks the client to approve; a delegate cannot stand in for the client.");
    if (!policy.requireOwner) reasons.push("This scope does not ask for a team member's approval, so there is nothing to delegate.");
  }
  if (!agent) reasons.push("That agent was not found.");
  else {
    if (agent.companyId !== facts.companyId) reasons.push("That agent belongs to another company.");
    if (!agentStatusActive(agent.status)) reasons.push(`That agent is ${agent.status ?? "not running"}.`);
  }
  if (configuredReviewerId === undefined) reasons.push("The company's roles could not be read, so it is not known who the Reviewer is.");
  else if (configuredReviewerId && agent && configuredReviewerId === agent.id) reasons.push("The Reviewer checks the post; it cannot also approve it.");
  return reasons;
}

/** Reads every input of `delegateBlockers` for this agent and scope. Each failed read becomes a reason. */
export async function delegateFacts(ctx: PluginContext, companyId: string, scope: DelegateScope, agentId: string): Promise<DelegateFacts> {
  const [policy, agent, roles, allowlist] = await Promise.all([
    scope === "personal" ? Promise.resolve(null) : getPolicyStrict(ctx, companyId, scope).catch(() => null),
    ctx.agents
      .get(agentId, companyId)
      .then((a): DelegateAgent | null => (a ? { id: a.id, companyId: a.companyId, status: a.status ?? null } : null))
      .catch(() => null),
    readCompanyRoles(ctx, companyId),
    readDelegatableScopes(ctx, companyId),
  ]);
  // The configured Reviewer, paused or not (findings 5): `reviewerAgentId` hides a paused one.
  return { companyId, scope, policy, agent, configuredReviewerId: roles.error ? undefined : roles.roles?.reviewerAgentId ?? null, allowlist };
}

/**
 * The delegate's agent id when one is set and may act now, else null (a
 * person approves). Routing and text use this; the approve tool checks again.
 */
export async function activeDelegate(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<string | null> {
  return (await activeDelegateEntry(ctx, companyId, scope))?.agentId ?? null;
}

/** As `activeDelegate`, with the stored entry (routing needs `setAt`). Never throws: any failure is no delegate. */
export async function activeDelegateEntry(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<DelegateEntry | null> {
  if (scope === "personal") return null;
  try {
    const entry = await getDelegate(ctx, companyId, scope);
    if (!entry) return null;
    const facts = await delegateFacts(ctx, companyId, scope, entry.agentId);
    return delegateBlockers(facts).length === 0 ? entry : null;
  } catch (error) {
    logReadError(ctx, companyId, error);
    return null;
  }
}

/**
 * The scope's delegate as the page and the tools show it (`policyOut`), with
 * whether it may act now and, if not, the first reason. Null: none set.
 */
export async function delegateView(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<PolicyDelegate | null> {
  if (scope === "personal") return null;
  const entry = await getDelegate(ctx, companyId, scope);
  if (!entry) return null;
  const [facts, name] = await Promise.all([
    delegateFacts(ctx, companyId, scope, entry.agentId),
    ctx.agents
      .get(entry.agentId, companyId)
      .then((a) => (a && typeof a.name === "string" && a.name ? a.name : null))
      .catch(() => null),
  ]);
  const reasons = delegateBlockers(facts);
  return { agentId: entry.agentId, name, active: reasons.length === 0, inactiveReason: reasons[0] ?? null };
}

/**
 * Agents a person may pick as the scope's delegate: running agents of this
 * company, minus the configured Reviewer, and only on an allowlisted scope.
 * Any failed read gives an empty list (nothing to pick).
 */
export async function delegateCandidates(ctx: PluginContext, companyId: string, scope: DelegateScope): Promise<Array<{ id: string; name: string }>> {
  if (scope === "personal" || scope?.kind === "contact") return [];
  try {
    const [allowlist, roles, agents] = await Promise.all([readDelegatableScopes(ctx, companyId), readCompanyRoles(ctx, companyId), ctx.agents.list({ companyId, limit: 200 })]);
    if (!allowlist.map(normalKey).includes(normalKey(delegateScopeKey(scope)))) return [];
    if (roles.error) return [];
    const reviewer = roles.roles?.reviewerAgentId ?? null;
    return agents
      .filter((a) => a.companyId === companyId && agentStatusActive(a.status) && a.id !== reviewer)
      .map((a) => ({ id: a.id, name: a.name || a.id }));
  } catch (error) {
    ctx.logger.info("Social delegate candidates skipped", { companyId, error: errorText(error) });
    return [];
  }
}
