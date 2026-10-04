/**
 * The ad account registry. An account belongs to exactly one scope: PiB's own ads, or one CRM client. A connection can see many accounts;
 * a person (or the agent, for a client it is working on) registers the ones that belong in the scope. Registering reads nothing private:
 * the account is listed by the platform itself, so an id the connection cannot see is refused.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { audit, budgetOverrides, clearBudgetOverrides, clientName, ensureScope, findAccount, getAccount, getScope, insertAccount, listAccounts, listConnections, updateAccount, updateScope, type AccountRow, type ScopeRow } from "./db.js";
import { AdsError, actorText, scopeLabelOf, validScopeKey } from "./domain.js";
import { requireConnection, tokenFor } from "./connections.js";
import { OWN_SCOPE, platformLabel, type ScopeKey } from "./platforms.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";
import type { ProviderAdAccount } from "./providers/types.js";

/** Who is acting: a person (`userId`), or an agent. Used for the audit trail and for what an actor may do. */
export interface Actor {
  userId?: string | null;
  agentId?: string | null;
}

/** The accounts a connection can see, and which of them are already registered (and where). */
export async function discoverAccounts(rt: AdsRuntime, connectionId: string): Promise<Array<ProviderAdAccount & { registeredAs: { id: string; scopeKey: ScopeKey } | null }>> {
  const conn = await requireConnection(rt.ctx, rt.companyId, connectionId);
  const token = await tokenFor(rt, conn);
  const env = await providerEnv(rt, conn.platform);
  const listed = await rt.provider(conn.platform).listAccounts(env, token);
  const out = [];
  for (const account of listed) {
    const existing = await findAccount(rt.ctx, rt.companyId, conn.platform, account.externalId);
    out.push({ ...account, registeredAs: existing ? { id: existing.id, scopeKey: existing.scope_key } : null });
  }
  return out;
}

export async function registerAccount(rt: AdsRuntime, actor: Actor, input: { connectionId: string; externalId: string; scopeKey: string; conversionActions?: string[] }): Promise<{ account: AccountRow; scope: ScopeRow; created: boolean; capCleared: boolean }> {
  if (!validScopeKey(input.scopeKey)) throw new AdsError('The scope must be "own" or a CRM client like "company:<id>" or "contact:<id>".');
  const conn = await requireConnection(rt.ctx, rt.companyId, input.connectionId);
  const visible = (await discoverAccounts(rt, input.connectionId)).find((a) => a.externalId === input.externalId);
  if (!visible) throw new AdsError("That ad account is not one this connection can see. Check the account id, or sign in with an account that has access.");
  const existing = await findAccount(rt.ctx, rt.companyId, conn.platform, input.externalId);
  const scopeKey = input.scopeKey;
  if (scopeKey !== OWN_SCOPE && !(await clientName(rt.ctx, rt.companyId, scopeKey))) {
    throw new AdsError(`The CRM has no client ${scopeKey}. Use list-ad-accounts or the CRM's list of clients for the id, not a name.`);
  }
  // Refused before anything is changed (the currency step below can clear a cap).
  if (existing && existing.scope_key !== scopeKey) {
    throw new AdsError(`That account is already registered under ${scopeLabelOf(existing.scope_key)}. An ad account belongs to one scope; remove it there first if it moved.`);
  }
  // A person took this account out of the numbers (caps and alerts stop counting its spend): only a person brings it back.
  if (existing && existing.status === "disabled" && visible.status !== "disabled" && !actor.userId) {
    throw new AdsError("A person removed this ad account, so its spend is not counted in the budget. Only a person can register it again (Ads page, Accounts).");
  }
  const currency = visible.currency.toUpperCase();
  const scope = await ensureScope(rt.ctx, rt.companyId, scopeKey, currency);
  const siblings = (await listAccounts(rt.ctx, rt.companyId, { scopeKey })).filter((a) => a.id !== existing?.id);
  if (siblings.length > 0 && scope.currency !== currency) {
    throw new AdsError(`${scopeLabelOf(scopeKey)} budgets in ${scope.currency}, and this account is in ${currency}. A scope has one currency so its budget cap adds up: register it under another scope, or ask the owner to change the scope's currency first.`);
  }
  let capCleared = false;
  if (siblings.length === 0 && scope.currency !== currency) {
    // A cap is an amount in the scope's currency: moving the scope to another currency would turn a ZAR cap into the same number of USD cents. A person
    // may do it, and the cap goes with the old currency (no cap means nothing that adds spend can run, so this fails safe); an agent may not.
    const capped = scope.monthly_cap_minor !== null || (await budgetOverrides(rt.ctx, rt.companyId, scopeKey)).length > 0;
    if (capped && !actor.userId) {
      throw new AdsError(`${scopeLabelOf(scopeKey)} has a monthly budget cap in ${scope.currency}, and this account is in ${currency}. Only a person can move a scope to another currency (its cap is cleared and has to be set again): ask the owner to register this account on the Ads page.`);
    }
    await updateScope(rt.ctx, rt.companyId, scopeKey, { currency, ...(capped ? { monthlyCapMinor: null, allowWrites: false, allowWritesBy: actorText(actor) } : {}) });
    capCleared = capped;
    if (capped) {
      await clearBudgetOverrides(rt.ctx, rt.companyId, scopeKey);
      await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "scope.currency_changed", scopeKey, detail: { from: scope.currency, to: currency, capCleared: true, previousCapMinor: scope.monthly_cap_minor } });
    }
  }
  let account: AccountRow;
  if (existing) {
    await updateAccount(rt.ctx, rt.companyId, existing.id, { status: visible.status === "disabled" ? "disabled" : "active", connectionId: conn.id, name: visible.name, ...(input.conversionActions ? { conversionActions: input.conversionActions } : {}) });
    account = (await getAccount(rt.ctx, rt.companyId, existing.id))!;
  } else {
    const id = await insertAccount(rt.ctx, { companyId: rt.companyId, platform: conn.platform, externalId: visible.externalId, name: visible.name, currency, timezone: visible.timezone, scopeKey, connectionId: conn.id, loginCustomerId: visible.loginCustomerId ?? null, createdBy: actorText(actor) });
    if (input.conversionActions?.length) await updateAccount(rt.ctx, rt.companyId, id, { conversionActions: input.conversionActions });
    account = (await getAccount(rt.ctx, rt.companyId, id))!;
  }
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: existing ? "account.updated" : "account.registered", scopeKey, subject: account.id, detail: { platform: conn.platform, externalId: account.external_id, name: account.name } });
  return { account, scope: (await getScope(rt.ctx, rt.companyId, scopeKey))!, created: !existing, capCleared };
}

/** Stops reading an account (its numbers stay). A person's call: it removes the account from caps and alerts. */
export async function removeAccount(ctx: PluginContext, companyId: string, actor: Actor, accountId: string): Promise<void> {
  const account = await getAccount(ctx, companyId, accountId);
  if (!account) throw new AdsError("That ad account was not found.");
  await updateAccount(ctx, companyId, accountId, { status: "disabled" });
  await audit(ctx, companyId, { actor: actorText(actor), action: "account.removed", scopeKey: account.scope_key, subject: accountId, detail: { externalId: account.external_id } });
}

/** Accounts with their scope's label, for the page and tools. Names come from the CRM projection. */
export async function describeAccounts(ctx: PluginContext, companyId: string, scopeKey?: ScopeKey) {
  const accounts = await listAccounts(ctx, companyId, scopeKey ? { scopeKey } : {});
  const connections = new Map((await listConnections(ctx, companyId)).map((c) => [c.id, c]));
  const labels = new Map<string, string>();
  for (const account of accounts) {
    if (!labels.has(account.scope_key)) labels.set(account.scope_key, scopeLabelOf(account.scope_key, await clientName(ctx, companyId, account.scope_key)));
  }
  return accounts.map((a) => ({
    id: a.id,
    platform: a.platform,
    platformLabel: platformLabel(a.platform),
    externalId: a.external_id,
    name: a.name,
    currency: a.currency,
    scopeKey: a.scope_key,
    scopeLabel: labels.get(a.scope_key) ?? a.scope_key,
    status: a.status,
    connectionId: a.connection_id,
    connectionStatus: a.connection_id ? connections.get(a.connection_id)?.status ?? null : null,
    lastSyncAt: a.last_sync_at,
    lastSyncOkAt: a.last_sync_ok_at,
    lastSyncError: a.last_sync_error,
  }));
}

