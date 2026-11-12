/**
 * The Higgsfield account balance, estimated.
 *
 * Higgsfield's API has no balance or usage endpoint (checked 2026-11-08: the OpenAPI spec has only generate, estimate,
 * request status, cancel and delete, and the status answer carries no cost). So an owner types the balance shown on
 * Higgsfield's billing page, and Studio subtracts what its own ledger spent since then. On 2026-11-08 the ledger
 * (85.88 credits = $5.37) matched Higgsfield's bill ($5.46), so the estimate is close. It cannot see spend made outside
 * this company's Studio with the same key; typing the balance again resets it.
 *
 * Kept in plugin state (company scope), not a table, so this needs no migration. A 402 from Higgsfield (the one
 * balance signal the API gives) is recorded too, and the page shows it until the balance is entered again.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { credits, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { USD_PER_CREDIT } from "./seedance-price.js";

const NAMESPACE = "studio";
const BALANCE_KEY = "provider-balance";
const OUT_OF_FUNDS_KEY = "provider-out-of-funds";
/** Below this many dollars the page warns. */
export const LOW_BALANCE_USD = 10;
/** A typed balance above this is a typo, not a top-up. */
const MAX_BALANCE_USD = 100_000;

interface StoredBalance {
  usd: number;
  setAt: string;
  setBy: string;
}

export interface BalanceView {
  /** Null until an owner enters the balance once. */
  enteredUsd: number | null;
  enteredAt: string | null;
  /** Credits Studio's ledger spent since the balance was entered (refunds included). */
  spentCreditsSince: number;
  spentUsdSince: number;
  estimatedUsd: number | null;
  estimatedCredits: number | null;
  usdPerCredit: number;
  low: boolean;
  /** When Higgsfield last refused a job for an empty balance, if after the balance was entered. */
  outOfFundsAt: string | null;
}

const key = (companyId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey });

const usd = (value: number) => Math.round(value * 100) / 100;

function stored(value: unknown): StoredBalance | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const amount = Number(v.usd);
  if (!Number.isFinite(amount) || typeof v.setAt !== "string") return null;
  return { usd: amount, setAt: v.setAt, setBy: String(v.setBy ?? "") };
}

/** Higgsfield credits in the company's ledger (xAI and Stability rows are other accounts) written at or after `since`, across all months and clients. */
export async function spentSince(ctx: PluginContext, companyId: string, since: string): Promise<number> {
  const rows = await ctx.db.query<{ spent: unknown }>(
    `SELECT COALESCE(SUM(l.credits), 0) AS spent FROM ${table(ctx, "credit_ledger")} l JOIN ${table(ctx, "generations")} g ON g.id = l.generation_id WHERE l.company_id = $1 AND l.created_at >= $2 AND g.provider = 'higgsfield'`,
    [companyId, since],
  );
  return credits(num(rows[0]?.spent));
}

export async function balanceView(ctx: PluginContext, companyId: string): Promise<BalanceView> {
  const [entered, outRaw] = await Promise.all([ctx.state.get(key(companyId, BALANCE_KEY)), ctx.state.get(key(companyId, OUT_OF_FUNDS_KEY))]);
  const balance = stored(entered);
  const outAt = typeof outRaw === "string" && (!balance || outRaw > balance.setAt) ? outRaw : null;
  if (!balance) {
    return { enteredUsd: null, enteredAt: null, spentCreditsSince: 0, spentUsdSince: 0, estimatedUsd: null, estimatedCredits: null, usdPerCredit: USD_PER_CREDIT, low: false, outOfFundsAt: outAt };
  }
  const spent = await spentSince(ctx, companyId, balance.setAt);
  const estimatedUsd = usd(balance.usd - spent * USD_PER_CREDIT);
  return {
    enteredUsd: balance.usd,
    enteredAt: balance.setAt,
    spentCreditsSince: spent,
    spentUsdSince: usd(spent * USD_PER_CREDIT),
    estimatedUsd,
    estimatedCredits: credits(Math.max(0, estimatedUsd) / USD_PER_CREDIT),
    usdPerCredit: USD_PER_CREDIT,
    low: estimatedUsd < LOW_BALANCE_USD || outAt !== null,
    outOfFundsAt: outAt,
  };
}

/** Records the balance shown on Higgsfield's billing page. Callers check that the person is an owner first. */
export async function setBalance(ctx: PluginContext, companyId: string, value: unknown, setBy: string, now = new Date()): Promise<void> {
  const amount = typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : Number(value);
  if (value === null || value === "" || !Number.isFinite(amount) || amount < 0 || amount > MAX_BALANCE_USD) {
    throw new StudioError("Type the balance in dollars as Higgsfield shows it, for example 87.50.", "bad_balance");
  }
  await ctx.state.set(key(companyId, BALANCE_KEY), { usd: usd(amount), setAt: now.toISOString(), setBy } satisfies StoredBalance);
}

/** Higgsfield answered 402. Best effort: a failed write must not hide the real error. */
export async function markOutOfFunds(ctx: PluginContext, companyId: string, now = new Date()): Promise<void> {
  try {
    await ctx.state.set(key(companyId, OUT_OF_FUNDS_KEY), now.toISOString());
  } catch (error) {
    ctx.logger.warn("studio.balance_mark_failed", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}
