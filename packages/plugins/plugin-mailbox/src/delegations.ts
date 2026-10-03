/**
 * Mailbox delegations that close the loop (RC5, "the owner-grant loop never
 * closes").
 *
 * The live case: the Operator's "read and draft on the mailbox" was asked five
 * times in five days and answered each time. Nothing turned the answer into a
 * delegation, the Operator re-checked, re-blocked and spent tokens, and four
 * inbound-reply issues waited behind it. Two fixes, both here:
 *
 * 1. **A default.** When the company has an Operator and a Gmail mailbox of its
 *    own, the Operator gets read and draft (never send) on it without anyone
 *    being asked (`ensureDefaultDelegations`). It runs when Gmail is connected,
 *    when the Cockpit announces the roles, and from the sync job (a few cheap
 *    queries, at most every ten minutes). It is idempotent, never widens a
 *    delegation that exists (the live one was applied by hand), and never
 *    creates one a person removed (`delegation_removals`): only an explicit
 *    grant by a person does. A client's mailbox is never given away this way.
 * 2. **An ask that does something.** The kit's ask effect `mailbox.delegate`
 *    turns an answered "may I read and draft on this mailbox?" into the
 *    delegation, reads it back, and reports the result so the Cockpit can wake
 *    the blocked issue. The params are chosen by the agent that asked, so they
 *    are whitelisted and re-checked: the mailbox must be this company's, the
 *    agent an active agent of this company, the scope read or read+draft. The
 *    effect never grants sending.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkEffectParams, readCompanyRoles, type AskEffectHandler, type AskEffectInput, type RolesPayload } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type AutoDelegateMode } from "./config.js";
import type { GmailStore } from "./db.js";
import { MailboxError, type Delegation } from "./domain.js";
import { errorMessage, type Env } from "./gmail/env.js";
import type { AccountRow, DelegationSource } from "./gmail/types.js";

export const DELEGATE_EFFECT_KEY = "mailbox.delegate";

export type DelegationScope = "read" | "read+draft";
export const DELEGATION_SCOPES: Record<DelegationScope, Delegation> = {
  read: { canRead: true, canDraft: false, canSend: false },
  "read+draft": { canRead: true, canDraft: true, canSend: false },
};

/** What each role gets by default. Nobody gets sending. */
export const DEFAULT_DELEGATIONS: Array<{ role: "operator" | "account-manager" | "bookkeeper"; scope: DelegationScope; only?: AutoDelegateMode }> = [
  { role: "operator", scope: "read+draft" },
  { role: "account-manager", scope: "read+draft", only: "operator+roles" },
  { role: "bookkeeper", scope: "read", only: "operator+roles" },
];

const GONE = new Set(["terminated", "archived", "deleted"]);
/** The default pass runs at most this often per company in one worker (the sync job calls it every two minutes). */
export const ENSURE_INTERVAL_MS = 10 * 60_000;

export interface DefaultTarget {
  role: string;
  agentId: string;
  scope: DelegationScope;
}

/** The agents that should have a default delegation, from the Cockpit's roles copy. */
export function defaultTargets(roles: Pick<RolesPayload, "operatorAgentId" | "operatorStatus" | "team"> | null, mode: AutoDelegateMode): DefaultTarget[] {
  if (mode === "off" || !roles) return [];
  const out: DefaultTarget[] = [];
  for (const entry of DEFAULT_DELEGATIONS) {
    if (entry.only && entry.only !== mode) continue;
    const member = entry.role === "operator" ? { agentId: roles.operatorAgentId, status: roles.operatorStatus } : roles.team?.[entry.role];
    if (member?.agentId && !GONE.has(String(member.status ?? ""))) out.push({ role: entry.role, agentId: member.agentId, scope: entry.scope });
  }
  return out;
}

export interface EnsureResult {
  created: Array<{ accountId: string; address: string; agentId: string; role: string; scope: DelegationScope }>;
  /** Delegations a person removed: left alone. */
  removed: number;
  /** Delegations that already exist (any rights): left alone. */
  existing: number;
  skipped: "off" | "no-roles" | "no-mailbox" | null;
}

const lastRun = new Map<string, number>();

/** Own Gmail mailboxes a default may cover: connected once (a sealed token), not disconnected, not a client's. */
export function defaultMailboxes(accounts: AccountRow[]): AccountRow[] {
  return accounts.filter((account) => Boolean(account.token_sealed) && account.status !== "disconnected" && account.status !== "manual" && !account.client_ref);
}

/**
 * Gives the Operator (and, when the company chose `operator+roles`, the Account
 * Manager and Bookkeeper) their default delegation on the company's own Gmail
 * mailboxes. Safe to call as often as you like. `roles` may be passed from a
 * roles broadcast; otherwise the stored copy is read. Never throws.
 */
export async function ensureDefaultDelegations(env: Pick<Env, "ctx" | "store" | "now">, companyId: string, options: { roles?: Pick<RolesPayload, "operatorAgentId" | "operatorStatus" | "team"> | null; force?: boolean } = {}): Promise<EnsureResult> {
  const result: EnsureResult = { created: [], removed: 0, existing: 0, skipped: null };
  try {
    const now = env.now();
    if (!options.force && !options.roles && now - (lastRun.get(companyId) ?? 0) < ENSURE_INTERVAL_MS) return { ...result, skipped: null };
    lastRun.set(companyId, now);
    const loaded = await loadMailboxConfig(env.ctx, companyId);
    const mode = loaded.config.autoDelegate;
    if (mode === "off") return { ...result, skipped: "off" };
    const roles = options.roles !== undefined ? options.roles : (await readCompanyRoles(env.ctx, companyId)).roles;
    const targets = defaultTargets(roles, mode);
    if (targets.length === 0) return { ...result, skipped: "no-roles" };
    const mailboxes = defaultMailboxes(await env.store.listAccounts(companyId));
    if (mailboxes.length === 0) return { ...result, skipped: "no-mailbox" };
    for (const account of mailboxes) {
      for (const target of targets) {
        if (await env.store.delegationFor(account.id, target.agentId)) {
          result.existing += 1;
          continue;
        }
        if (await env.store.hasDelegationRemoval(account.id, target.agentId)) {
          result.removed += 1;
          continue;
        }
        const grant = DELEGATION_SCOPES[target.scope];
        const created = await env.store.insertDefaultDelegation({
          id: randomUUID(),
          companyId,
          accountId: account.id,
          agentId: target.agentId,
          canRead: grant.canRead,
          canDraft: grant.canDraft,
          canSend: grant.canSend,
          grantedBy: `default:${target.role}`,
        });
        if (created) result.created.push({ accountId: account.id, address: account.address, agentId: target.agentId, role: target.role, scope: target.scope });
      }
    }
    if (result.created.length > 0) env.ctx.logger.info("Default mailbox delegations created", { companyId, created: result.created.map((c) => `${c.role}:${c.address}:${c.scope}`) });
  } catch (error) {
    env.ctx.logger.info("Default mailbox delegations skipped", { companyId, error: errorMessage(error) });
  }
  return result;
}

/** Forgets the interval memo (tests). */
export function resetEnsureMemo(): void {
  lastRun.clear();
}

/** Gives an agent read (and, for read+draft, draft) on a mailbox. Never lowers existing rights and never grants sending. Clears an earlier removal: a person's grant is explicit. */
export async function grantDelegation(store: Pick<GmailStore, "grantDelegation">, input: { companyId: string; accountId: string; agentId: string; scope: DelegationScope; source: DelegationSource; grantedBy: string | null }): Promise<void> {
  const rights = DELEGATION_SCOPES[input.scope];
  await store.grantDelegation({ id: randomUUID(), companyId: input.companyId, accountId: input.accountId, agentId: input.agentId, canRead: rights.canRead, canDraft: rights.canDraft, canSend: false, source: input.source, grantedBy: input.grantedBy });
}

/** A person removes an agent's access. The default never gives it back; only a new grant does. */
export async function removeDelegation(store: Pick<GmailStore, "removeDelegation">, companyId: string, accountId: string, agentId: string, removedBy: string | null): Promise<{ removed: boolean }> {
  return { removed: await store.removeDelegation(companyId, accountId, agentId, removedBy) };
}

// ---------------------------------------------------------------------------
// The ask effect
// ---------------------------------------------------------------------------

const RULES = {
  accountId: { required: true, type: "string", maxLength: 200 },
  agentId: { required: true, type: "string", pattern: /^[A-Za-z0-9_-]{1,64}$/, maxLength: 64 },
  scope: { type: "string", oneOf: ["read", "read+draft"] },
} as const;

interface Resolved {
  account: AccountRow;
  agentId: string;
  agentName: string;
  scope: DelegationScope;
}

async function resolveEffect(env: Pick<Env, "store">, input: AskEffectInput): Promise<Resolved | string> {
  const checked = checkEffectParams(input.ask.effect.params, { ...RULES, scope: { ...RULES.scope, oneOf: [...RULES.scope.oneOf] } });
  if (!checked.ok) return checked.problems.join("; ");
  const { accountId, agentId } = checked.params as { accountId: string; agentId: string };
  const scope = (checked.params.scope as DelegationScope | undefined) ?? "read+draft";
  const account = accountId.includes("@") ? await env.store.findAccountByAddress(input.companyId, accountId) : await env.store.getAccount(input.companyId, accountId);
  if (!account) return `"${accountId.slice(0, 80)}" is not a mailbox of this company`;
  if (account.status === "disconnected") return `${account.address} is disconnected`;
  let agent: { name?: unknown; status?: unknown } | null = null;
  try {
    agent = (await input.ctx.agents.get(agentId, input.companyId)) as unknown as { name?: unknown; status?: unknown } | null;
  } catch {
    agent = null;
  }
  if (!agent || GONE.has(String(agent.status ?? ""))) return `agent ${agentId} is not an active agent of this company`;
  return { account, agentId, agentName: typeof agent.name === "string" && agent.name ? agent.name : agentId, scope };
}

/**
 * The `mailbox.delegate` ask effect. `store` is read lazily so the handler can
 * be registered in `setup` before the store exists.
 */
export function mailboxDelegateEffect(getEnv: () => Pick<Env, "store">): AskEffectHandler {
  return {
    async validate(input) {
      const resolved = await resolveEffect(getEnv(), input);
      return typeof resolved === "string" ? resolved : null;
    },
    async apply(input) {
      const env = getEnv();
      const resolved = await resolveEffect(env, input);
      if (typeof resolved === "string") throw new MailboxError(resolved);
      const have = await env.store.delegationFor(resolved.account.id, resolved.agentId);
      const want = DELEGATION_SCOPES[resolved.scope];
      const covered = have && have.can_read && (!want.canDraft || have.can_draft);
      await grantDelegation(env.store, { companyId: input.companyId, accountId: resolved.account.id, agentId: resolved.agentId, scope: resolved.scope, source: "ask", grantedBy: input.ask.answeredByUserId });
      const what = resolved.scope === "read" ? "read" : "read and draft";
      return { detail: covered ? `${resolved.agentName} already could ${what} on ${resolved.account.address}; nothing to change. Sending stays with a person.` : `${resolved.agentName} can now ${what} on ${resolved.account.address}. Sending stays with a person.` };
    },
    async verify(input) {
      const env = getEnv();
      const resolved = await resolveEffect(env, input);
      if (typeof resolved === "string") return { ok: false, detail: resolved };
      const row = await env.store.delegationFor(resolved.account.id, resolved.agentId);
      const want = DELEGATION_SCOPES[resolved.scope];
      const ok = Boolean(row?.can_read && (!want.canDraft || row.can_draft));
      return ok ? { ok: true } : { ok: false, detail: `${resolved.agentName} still has no ${resolved.scope === "read" ? "read" : "read and draft"} delegation on ${resolved.account.address}` };
    },
  };
}

// ---------------------------------------------------------------------------
// What an agent hands to ask-owner
// ---------------------------------------------------------------------------

/** The company's issue prefix (`PIB`), for deep links; null when it cannot be read. */
export async function companyPrefix(ctx: Pick<PluginContext, "companies">, companyId: string): Promise<string | null> {
  try {
    const company = (await ctx.companies.get(companyId)) as { issuePrefix?: string | null } | null;
    return company?.issuePrefix ? String(company.issuePrefix) : null;
  } catch {
    return null;
  }
}

/**
 * The ask card to pass to `partnersinbiz.cockpit:ask-owner` for a missing
 * delegation: one question, a deep link, the exact steps, and the effect that
 * applies the answer. A "yes" creates the delegation and checks it, so the agent
 * is woken with it in place and never asks again.
 */
export function delegationAsk(input: { accountId: string; address: string; agentId: string; agentName?: string | null; prefix?: string | null; scope?: DelegationScope }) {
  const scope = input.scope ?? "read+draft";
  const base = input.prefix ? `/${input.prefix}` : "";
  const who = input.agentName?.trim() || "this agent";
  const what = scope === "read" ? "read" : "read and draft";
  return {
    kind: "grant" as const,
    question: `May ${who} ${what} mail on ${input.address}? It cannot send: sending stays with a person.`,
    options: [`Yes: ${what}, never send`, "No"],
    links: [{ label: "Mailboxes", href: `${base}/mailbox?tab=mailboxes` }],
    steps: [
      `Answer yes and the Mailbox gives ${who} ${what} access on ${input.address}, then checks it worked. Nothing else to do.`,
      "To do it by hand instead: open Mailboxes, click Give an agent access, pick the mailbox and the agent, leave sending off, click Give access.",
    ],
    effect: { key: DELEGATE_EFFECT_KEY, params: { accountId: input.accountId, agentId: input.agentId, scope } },
  };
}
