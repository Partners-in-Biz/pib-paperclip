/**
 * Ads for a limited person (stage B2, PAR-12582): he works only on the ad scopes of his own companies (the CRM
 * companies he owns or is on "Managed by" for, read from the CRM copy). The guard hands a `linked` decision only
 * under `enforce`, and only for a key marked `scoped` in the access table; every such key has a rule here
 * (`tests/own-scope.pg.spec.ts` holds the two lists equal). A key with no rule is refused (fail closed).
 *
 * - `client`: the call names the scope (`client` or `scopeKey`). It must be one of his; none, `all` or `own` is refused.
 * - `client-or-first`: the same, but a page call that names none opens his first company (by name).
 * - `load`: the page load, one of his companies at a time; company-wide parts (connections, other scopes'
 *   accounts and audit, other clients' names) are left out.
 * - `proposal` / `alert` / `account`: the record named by id must sit in one of his scopes.
 *
 * A guessed id and another company's record get the same answer (`NOT_AMONG_YOUR_COMPANIES`).
 */
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, isOwnClient, parseClientParam } from "@partnersinbiz/pib-plugin-kit";
import { clientNames, getAccount, getAlert, getProposal, listScopes } from "./db.js";
import { OWN_SCOPE } from "./platforms.js";
import { scopeFromParams } from "./records.js";
import type { AdsRuntime } from "./runtime.js";

type Rule = "client" | "client-or-first" | "load" | "proposal" | "alert" | "account";

/** Every key a limited person may reach in Ads, by how its scope is found. */
export const OWN_SCOPE_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "ads.load": "load",
  "ads.performance": "client-or-first",
  "ads.proposals": "client-or-first",
  "ads.proposal": "proposal",
  "ads.approve": "proposal",
  "ads.cancel-proposal": "proposal",
  "ads.mark-done": "proposal",
  "ads.execute": "proposal",
  "ads.ack-alert": "alert",
  "ads.sync": "account",
  "tool:list-ad-accounts": "client",
  "tool:get-ads-summary": "client",
  "tool:list-ad-campaigns": "client",
  "tool:get-spend-ledger": "client",
  "tool:get-budget-status": "client",
  "tool:list-ad-alerts": "client",
  "tool:list-ad-proposals": "client",
  "tool:list-variants": "client",
  "tool:check-ad-creative": "client",
  "tool:propose-ad-change": "client",
  "tool:get-ad-proposal": "proposal",
  "tool:revise-ad-proposal": "proposal",
  "tool:record-ad-review": "proposal",
  "tool:record-client-request": "proposal",
  "tool:cancel-ad-proposal": "proposal",
  "tool:execute-ad-change": "proposal",
  "tool:acknowledge-ad-alert": "alert",
  "tool:sync-ad-account": "account",
  "tool:diagnose-google-campaign": "account",
  "tool:upload-ad-media": "account",
});

export type OwnScopeAnswer = { refused: string } | { params: Record<string, unknown>; after?: (result: unknown) => unknown };

/** Whether a scope key (`own`, `company:<id>`, `contact:<id>`) is one of his. */
async function isOwnScope(rt: AdsRuntime, own: ReadonlySet<string>, scopeKey: string | null | undefined): Promise<boolean> {
  if (!scopeKey || scopeKey === OWN_SCOPE) return false;
  return isOwnClient(rt.ctx, rt.ctx.db.namespace, rt.companyId, own, parseClientParam(scopeKey));
}

/** His scopes that have ads here, by client name. */
async function ownScopeKeys(rt: AdsRuntime, own: ReadonlySet<string>, names: Record<string, string>): Promise<string[]> {
  const keys: string[] = [];
  for (const scope of await listScopes(rt.ctx, rt.companyId)) if (await isOwnScope(rt, own, scope.scope_key)) keys.push(scope.scope_key);
  return keys.sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b) || a.localeCompare(b));
}

function str(params: Record<string, unknown>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The scope a call names, or null when it names none or names it in a form nobody can read. */
function namedScope(params: Record<string, unknown>): string | null {
  try {
    return scopeFromParams(params) ?? null;
  } catch {
    return null;
  }
}

/** The page's scope: the one named (it must be his) or his first. */
async function pageScope(rt: AdsRuntime, own: ReadonlySet<string>, params: Record<string, unknown>) {
  const names = await clientNames(rt.ctx, rt.companyId);
  const keys = await ownScopeKeys(rt, own, names);
  const named = params.client ?? params.scopeKey;
  if (named !== undefined && named !== null && named !== "" && named !== "all") {
    const scopeKey = namedScope(params);
    return scopeKey && keys.includes(scopeKey) ? { scopeKey, keys, names } : null;
  }
  return keys[0] ? { scopeKey: keys[0], keys, names } : null;
}

/** The overview of one of his scopes, without what belongs to the company or to other clients. */
function limitOverview(result: unknown, scopeKey: string, keys: string[], names: Record<string, string>): unknown {
  const o = result as Record<string, unknown> & { accounts?: Array<{ scopeKey?: string }>; audit?: Array<{ scope_key?: string | null }> };
  return {
    ...o,
    connections: [],
    accounts: (o.accounts ?? []).filter((a) => a.scopeKey === scopeKey),
    audit: (o.audit ?? []).filter((a) => a.scope_key === scopeKey),
    clients: Object.fromEntries(keys.filter((k) => names[k] !== undefined).map((k) => [k, names[k]!])),
    limitedTo: { scopeKey, scopeKeys: keys },
  };
}

/**
 * Checks one call of a limited person against his companies. `key` is the guard's key (`ads.<action>` or
 * `tool:<name>`). Returns the params to run with (a page call may get his first company as `client`), or the refusal.
 */
export async function limitToOwnScopes(rt: AdsRuntime, own: ReadonlySet<string>, key: string, params: Record<string, unknown>): Promise<OwnScopeAnswer> {
  const rule = Object.hasOwn(OWN_SCOPE_RULES, key) ? OWN_SCOPE_RULES[key] : undefined;
  const mine = async (scopeKey: string | null | undefined) => (await isOwnScope(rt, own, scopeKey)) ? { params } : { refused: NOT_AMONG_YOUR_COMPANIES };
  switch (rule) {
    case "client": {
      const named = params.client ?? params.scopeKey;
      if (named === undefined || named === null || named === "" || named === "all") return { refused: NAME_YOUR_COMPANY };
      // Both forms, when both are sent, must be his: no handler may read the one this check did not.
      if (params.client !== undefined && params.scopeKey !== undefined && !(await isOwnScope(rt, own, namedScope({ scopeKey: params.scopeKey })))) {
        return { refused: NOT_AMONG_YOUR_COMPANIES };
      }
      return mine(namedScope(params));
    }
    case "client-or-first":
    case "load": {
      const page = await pageScope(rt, own, params);
      if (!page) return { refused: NOT_AMONG_YOUR_COMPANIES };
      const { scopeKey: _s, ...rest } = params;
      const next = { ...rest, client: page.scopeKey };
      return rule === "load" ? { params: next, after: (r) => limitOverview(r, page.scopeKey, page.keys, page.names) } : { params: next };
    }
    case "proposal": {
      const id = str(params, "proposalId");
      return id ? mine((await getProposal(rt.ctx, rt.companyId, id))?.scope_key) : { refused: NOT_AMONG_YOUR_COMPANIES };
    }
    case "alert": {
      const id = str(params, "alertId");
      return id ? mine((await getAlert(rt.ctx, rt.companyId, id))?.scope_key) : { refused: NOT_AMONG_YOUR_COMPANIES };
    }
    case "account": {
      // Without an account a sync reads every account of the company: a limited person names his.
      const id = str(params, "accountId");
      return id ? mine((await getAccount(rt.ctx, rt.companyId, id))?.scope_key) : { refused: NAME_YOUR_COMPANY };
    }
    default:
      return { refused: NOT_AMONG_YOUR_COMPANIES };
  }
}
