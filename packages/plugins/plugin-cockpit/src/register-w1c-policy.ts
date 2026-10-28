/**
 * The owner's standing-approval policy (Cockpit → Policy). It is written only by
 * the `ownerDefaults.save` action, and only when the host-resolved actor is a board
 * `user` who is the company's owner (the actor comes from the authenticated request,
 * never from the params). No tool calls it, so no agent can switch it on.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { assignableUser } from "./constants.js";
import { getRoles } from "./db.js";
import { CockpitError, type Env } from "./env.js";
import { getAsk } from "./asks.js";
import { DEFAULT_MIN_HOURS, POLICY_CLASSES, type OwnerDefaultsPolicy } from "./owner-defaults-model.js";
import { DISABLED_POLICY, readOwnerDefaults, writeOwnerDefaults } from "./owner-defaults-store.js";
import { listRepairs, recordRepair, type RepairRow } from "./repairs.js";

export const PROPOSED_POLICY_NAME = "Peet standing approval 2026-10-19";
/** The issue trees the proposal covers, by identifier (stored as issue ids). */
export const PROPOSED_ROOT_IDENTIFIERS = ["PAR-3983"] as const;

/** What the policy never covers, in the owner's words (the code enforces each one in `evaluate` and the sweep). */
export const HARD_EXCLUSIONS = [
  "Credentials, keys, logins and tokens",
  "Money: payments, invoices, refunds, banking",
  "Legal and contracts",
  "Anything sent to a client",
  "Any ask with an effect attached",
  "Money, legal and grant questions",
] as const;

export const POLICY_LEDGER_KIND = "owner_defaults";

export interface PolicyRootView {
  identifier: string;
  issueId: string | null;
}
export interface PolicyLedgerRow {
  id: string;
  action: string;
  detail: string;
  actor: string;
  at: string;
}
export interface PolicyAppliedRow {
  askId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  question: string | null;
  answer: string | null;
  at: string;
}
export interface PolicyView {
  enabled: boolean;
  /** True only for the company owner: the UI shows the switch to them alone. */
  canChange: boolean;
  proposal: { name: string; roots: PolicyRootView[]; classes: string[]; exclusions: string[]; floorHours: number };
  active: OwnerDefaultsPolicy;
  ledger: PolicyLedgerRow[];
  applied: PolicyAppliedRow[];
}

function userOf(context: PluginPerformActionContext): string | null {
  const actor = context.actor;
  if (!actor || actor.type !== "user") return null;
  return typeof actor.userId === "string" && actor.userId ? assignableUser(actor.userId) : null;
}

/** The owner's user id when the actor is that user; throws for an agent, another board user, a missing or unverified actor. */
async function requireOwner(env: Env, context: PluginPerformActionContext): Promise<{ companyId: string; userId: string }> {
  if (!context.companyId) throw new CockpitError("Company is required");
  const userId = userOf(context);
  if (!userId) throw new CockpitError("Only the owner, signed in as a board user, can change the standing policy");
  const roles = await getRoles(env.ctx, context.companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  if (!owner || owner !== userId) throw new CockpitError("Only the owner can change the standing policy");
  return { companyId: context.companyId, userId };
}

async function resolveRoots(env: Env, companyId: string): Promise<PolicyRootView[]> {
  const rows = await env.ctx.db.query<{ id: unknown; identifier: unknown }>(
    `SELECT id, identifier FROM public.issues WHERE company_id = $1 AND identifier IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(PROPOSED_ROOT_IDENTIFIERS)],
  );
  const byIdentifier = new Map(rows.map((r) => [String(r.identifier), String(r.id)]));
  return PROPOSED_ROOT_IDENTIFIERS.map((identifier) => ({ identifier, issueId: byIdentifier.get(identifier) ?? null }));
}

function ledgerRow(r: RepairRow): PolicyLedgerRow {
  return { id: r.id, action: r.action, detail: r.detail, actor: r.actor, at: r.createdAt };
}

async function appliedAnswers(env: Env, companyId: string): Promise<PolicyAppliedRow[]> {
  const repairs = (await listRepairs(env.ctx, companyId, { kind: "ask_deadline", limit: 100 })).filter((r) => r.targetKind === "ask" && r.action === "apply_default").slice(0, 20);
  const out: PolicyAppliedRow[] = [];
  for (const r of repairs) {
    const ask = await getAsk(env, companyId, r.targetId);
    out.push({
      askId: r.targetId,
      issueId: ask?.issueId ?? null,
      issueIdentifier: ask?.issueIdentifier ?? null,
      issueTitle: ask?.issueTitle ?? null,
      question: ask?.question ?? null,
      answer: ask?.answer ?? r.detail,
      at: r.createdAt,
    });
  }
  return out;
}

export async function loadPolicyView(env: Env, context: PluginPerformActionContext): Promise<PolicyView> {
  if (!context.companyId) throw new CockpitError("Company is required");
  const companyId = context.companyId;
  const userId = userOf(context);
  if (!userId) throw new CockpitError("Sign in as a board user to see the standing policy");
  const roles = await getRoles(env.ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  const active = await readOwnerDefaults(env.ctx, companyId);
  return {
    enabled: active.enabled,
    canChange: owner !== null && owner === userId,
    proposal: { name: PROPOSED_POLICY_NAME, roots: await resolveRoots(env, companyId), classes: [...POLICY_CLASSES], exclusions: [...HARD_EXCLUSIONS], floorHours: DEFAULT_MIN_HOURS },
    active,
    ledger: (await listRepairs(env.ctx, companyId, { kind: POLICY_LEDGER_KIND, limit: 20 })).map(ledgerRow),
    applied: await appliedAnswers(env, companyId),
  };
}

/** One tap: `{ enabled: true }` turns the proposed policy on, `{ enabled: false }` turns it off. Every change writes a ledger row. */
export async function saveOwnerDefaults(env: Env, context: PluginPerformActionContext, params: Record<string, unknown>): Promise<{ changed: boolean; enabled: boolean }> {
  const { companyId, userId } = await requireOwner(env, context);
  if (typeof params.enabled !== "boolean") throw new CockpitError("enabled must be true or false");
  const previous = await readOwnerDefaults(env.ctx, companyId);
  let next: OwnerDefaultsPolicy = DISABLED_POLICY;
  if (params.enabled) {
    const issueIds = (await resolveRoots(env, companyId)).flatMap((r) => (r.issueId ? [r.issueId] : []));
    if (issueIds.length === 0) throw new CockpitError("None of the policy's issue trees was found, so it cannot be switched on");
    next = { enabled: true, name: PROPOSED_POLICY_NAME, rootIssueIds: issueIds, classes: [...POLICY_CLASSES], minHours: DEFAULT_MIN_HOURS };
  }
  if (previous.enabled === params.enabled && (!params.enabled || JSON.stringify(previous) === JSON.stringify(next))) {
    return { changed: false, enabled: previous.enabled };
  }
  const saved = await writeOwnerDefaults(env.ctx, companyId, next);
  try {
    await recordRepair(env.ctx, companyId, {
      kind: POLICY_LEDGER_KIND,
      targetKind: "policy",
      targetId: "ownerDefaults",
      action: saved.enabled ? "enable" : "disable",
      outcome: "applied",
      detail: saved.enabled ? `${saved.name}: on for ${saved.rootIssueIds.length} issue tree(s), ${saved.classes.length} classes, floor ${saved.minHours}h` : `${previous.name || PROPOSED_POLICY_NAME}: off`,
      actor: `owner:${userId}`,
    });
  } catch (error) {
    // A change with no ledger row must not stand.
    await writeOwnerDefaults(env.ctx, companyId, previous);
    throw error;
  }
  return { changed: true, enabled: saved.enabled };
}

export function registerW1cPolicy(env: Env): void {
  env.ctx.actions.register("ownerDefaults.load", async (_params, context) => loadPolicyView(env, context));
  env.ctx.actions.register("ownerDefaults.save", async (params, context) => saveOwnerDefaults(env, context, params));
}
