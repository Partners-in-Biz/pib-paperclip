/**
 * Credits and monthly caps.
 *
 * A generation reserves its estimate before it runs and is settled when it finishes. Refunds and price differences
 * are separate rows, so a month's use is simply the sum of its rows and every row is idempotent.
 *
 * Caps are data, not code: a company owner sets them on the Studio page, and each check reads them fresh, so a change
 * applies to the next generation with no deploy. The cap for a piece of work is the client's own cap if it has one,
 * then the company's, then the company's default. A client's cap is measured against that client's use. The company
 * and default caps are measured against everything the company used this month, clients included. No cap anywhere
 * means generation is off: there is deliberately no built-in amount. A cap of 0 turns generation off too.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { credits, iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";

export const DEFAULT_SCOPE = "default";
export const COMPANY_SCOPE = "company";

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function clientScopeKey(scope: ClientRefLike): string {
  return formatClientParam(scope);
}

type ClientRefLike = NonNullable<ClientScope>;

export function isCapScope(value: string): boolean {
  return value === DEFAULT_SCOPE || value === COMPANY_SCOPE || /^(company|contact):[A-Za-z0-9_-]+$/.test(value);
}

export interface CapRow {
  scopeKey: string;
  monthlyCredits: number;
  updatedBy: string;
  updatedAt: string | null;
}

export async function listCaps(ctx: PluginContext, companyId: string): Promise<CapRow[]> {
  const rows = await ctx.db.query<{ scope_key: string; monthly_credits: unknown; updated_by: string; updated_at: unknown }>(
    `SELECT scope_key, monthly_credits, updated_by, updated_at FROM ${table(ctx, "credit_limits")} WHERE company_id = $1 ORDER BY scope_key`,
    [companyId],
  );
  return rows.map((r) => ({ scopeKey: r.scope_key, monthlyCredits: num(r.monthly_credits), updatedBy: r.updated_by, updatedAt: iso(r.updated_at) }));
}

export interface EffectiveCap {
  /** Null when no cap is set anywhere: generation is off. */
  monthlyCredits: number | null;
  source: "client" | "company" | "default" | "none";
  /** What the cap is measured against. */
  measuredOn: "client" | "company";
}

export function effectiveCap(caps: Array<Pick<CapRow, "scopeKey" | "monthlyCredits">>, scope: ClientScope): EffectiveCap {
  const of = (key: string) => caps.find((c) => c.scopeKey === key)?.monthlyCredits;
  const client = scope ? of(clientScopeKey(scope)) : undefined;
  if (client !== undefined) return { monthlyCredits: client, source: "client", measuredOn: "client" };
  const company = of(COMPANY_SCOPE);
  if (company !== undefined) return { monthlyCredits: company, source: "company", measuredOn: "company" };
  const fallback = of(DEFAULT_SCOPE);
  if (fallback !== undefined) return { monthlyCredits: fallback, source: "default", measuredOn: "company" };
  return { monthlyCredits: null, source: "none", measuredOn: "company" };
}

/** Credits used in a period: the company's, or (with `scope`) one client's. */
export async function usage(ctx: PluginContext, companyId: string, period: string, scope?: NonNullable<ClientScope>): Promise<number> {
  const params: unknown[] = [companyId, period];
  let where = "";
  if (scope) {
    params.push(scope.kind, scope.id);
    where = " AND client_kind = $3 AND client_ref = $4";
  }
  const rows = await ctx.db.query<{ used: unknown }>(
    `SELECT COALESCE(SUM(credits), 0) AS used FROM ${table(ctx, "credit_ledger")} WHERE company_id = $1 AND period = $2${where}`,
    params,
  );
  return credits(num(rows[0]?.used));
}

export interface CapCheck {
  cap: EffectiveCap;
  used: number;
  /** Null when no cap is set. */
  remaining: number | null;
}

export async function capCheck(ctx: PluginContext, companyId: string, scope: ClientScope, period = currentPeriod()): Promise<CapCheck> {
  const cap = effectiveCap(await listCaps(ctx, companyId), scope);
  const used = await usage(ctx, companyId, period, cap.measuredOn === "client" && scope ? scope : undefined);
  return { cap, used, remaining: cap.monthlyCredits === null ? null : credits(Math.max(0, cap.monthlyCredits - used)) };
}

/** Refuses when `needed` credits don't fit under the cap. */
export function assertFits(check: CapCheck, needed: number): void {
  const { cap, used } = check;
  if (cap.monthlyCredits === null) {
    throw new StudioError("No monthly credit cap is set, so generation is off. A company owner sets one on the Studio page.", "cap_not_set");
  }
  if (cap.monthlyCredits === 0) {
    throw new StudioError("Generation is off: the monthly credit cap is 0. A company owner can change it on the Studio page.", "cap_reached");
  }
  if (credits(used + needed) > cap.monthlyCredits) {
    const whose = cap.source === "client" ? "this client's" : "this company's";
    throw new StudioError(
      `This needs ${needed} credits, and ${whose} monthly cap of ${cap.monthlyCredits} has ${credits(Math.max(0, cap.monthlyCredits - used))} left. Nothing was started. A company owner can raise the cap on the Studio page.`,
      "cap_reached",
    );
  }
}

/** Serialises each company's check-then-reserve inside this worker, so two runs can't both take the last credits. */
const locks = new Map<string, Promise<unknown>>();

export async function withCompanyLock<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(companyId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  locks.set(companyId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(companyId) === tail) locks.delete(companyId);
  }
}

export interface LedgerTarget {
  generationId: string;
  companyId: string;
  clientKind: string | null;
  clientRef: string | null;
  period: string;
}

async function entry(ctx: PluginContext, target: LedgerTarget, kind: "reserve" | "refund" | "adjust", amount: number): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_ledger")} (generation_id, kind, company_id, client_kind, client_ref, period, credits) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (generation_id, kind) DO NOTHING`,
    [target.generationId, kind, target.companyId, target.clientKind, target.clientRef, target.period, amount],
  );
}

export const reserve = (ctx: PluginContext, target: LedgerTarget, amount: number) => entry(ctx, target, "reserve", amount);
export const refund = (ctx: PluginContext, target: LedgerTarget, amount: number) => entry(ctx, target, "refund", -amount);
/** The provider's real price differs from the estimate. */
export const adjust = (ctx: PluginContext, target: LedgerTarget, difference: number) => entry(ctx, target, "adjust", difference);

/**
 * Set or clear one cap. Null clears it, and the next level then applies. Callers check that the person is an owner
 * first. The log row is written first, so a change can't happen without one.
 */
export async function setCap(ctx: PluginContext, companyId: string, scopeKey: string, monthlyCredits: number | null, changedBy: string): Promise<void> {
  if (!isCapScope(scopeKey)) throw new StudioError("That is not a cap Studio knows about.", "bad_scope");
  if (monthlyCredits !== null && (!Number.isFinite(monthlyCredits) || monthlyCredits < 0)) throw new StudioError("A cap is a number of credits, 0 or more.", "bad_cap");
  const value = monthlyCredits === null ? null : credits(monthlyCredits);
  const current = (await listCaps(ctx, companyId)).find((c) => c.scopeKey === scopeKey)?.monthlyCredits ?? null;
  if (current === value) return;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_limit_changes")} (id, company_id, scope_key, old_credits, new_credits, changed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), companyId, scopeKey, current, value, changedBy],
  );
  if (value === null) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "credit_limits")} WHERE company_id = $1 AND scope_key = $2`, [companyId, scopeKey]);
    return;
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_limits")} (company_id, scope_key, monthly_credits, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, scope_key) DO UPDATE SET monthly_credits = EXCLUDED.monthly_credits, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [companyId, scopeKey, value, changedBy],
  );
}

export interface CapChange {
  scopeKey: string;
  oldCredits: number | null;
  newCredits: number | null;
  changedBy: string;
  createdAt: string | null;
}

export async function capHistory(ctx: PluginContext, companyId: string, limit = 50): Promise<CapChange[]> {
  const rows = await ctx.db.query<{ scope_key: string; old_credits: unknown; new_credits: unknown; changed_by: string; created_at: unknown }>(
    `SELECT scope_key, old_credits, new_credits, changed_by, created_at FROM ${table(ctx, "credit_limit_changes")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((r) => ({
    scopeKey: r.scope_key,
    oldCredits: r.old_credits == null ? null : num(r.old_credits),
    newCredits: r.new_credits == null ? null : num(r.new_credits),
    changedBy: r.changed_by,
    createdAt: iso(r.created_at),
  }));
}
